#!/usr/bin/env node
// summon.js — provision an ephemeral worker session and compose its bootstrap prompt.
//
// Does NOT open the Terminal tab itself (that's bin/summon in bash — avoids
// osascript quoting hell from node). Instead prints JSON with all paths so the
// caller can do the `osascript do script` step.
//
// Usage:
//   node lib/summon.js --agent <name> --task "<brief>" --goal "<done condition>" [--sid <id>]
//   node lib/summon.js --agent coder  --task "<brief>" --goal "<done>" --ensemble <N>
//
// Effects:
//   1. Mints a session id (or uses --sid).
//   2. Copies spawns/<name>/ → ~/.advisor/runs/<sid>/workspace/
//      (agent=coder: git worktree add -b ws/<sid> instead; copyDir overlay on top)
//   3. Creates ~/.advisor/runs/<sid>/channel/{inbox,outbox}.jsonl
//   4. Appends the initial `task` message to inbox.
//   5. Writes meta.json + bootstrap-prompt.txt
//   6. Prints JSON: {sid, agent, workspace, channelDir, inbox, outbox, promptFile, goal, task}
//      (--ensemble N: prints {batch:true, ensemble:N, sessions:[...]} instead)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const channel = require('./channel');
const session = require('./session');
const agents = require('./agents');
const { preflight } = require('./preflight');
const { DISCOVERY_SCAFFOLDING } = require('./scaffolding');

// Shell-quote a string for safe interpolation into a single-quoted bash literal.
// Each embedded single quote becomes '\'' (close-quote, escaped quote, re-open).
function shesc(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tui') {
      out.tui = true;
    } else if (a === '--isTestSession') {
      out.isTestSession = true;
    } else if (a === '--sub-team') {
      out.subTeam = true;
    } else if (a === '--sub-team-model') {
      out.subTeamModel = argv[i + 1];
      i++;
    } else if (a === '--protected-tests') {
      out.protectedTests = argv[i + 1];
      i++;
    } else if (a === '--timeout') {
      out.timeoutSec = argv[i + 1];
      i++;
    } else if (a === '--tool-budget') {
      out.toolBudget = argv[i + 1];
      i++;
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

// Pre-register the workspace in ~/.claude.json so the launch script doesn't
// stop on a "Do you trust this directory?" prompt when claude starts in the
// fresh workspace. Only sets the single trust flag; all other permission
// prompts behave normally. Fail-open: on ANY error we warn and continue —
// worst case the user sees the prompt once.
function trustWorkspaceInClaudeConfig(absPath, sid, configPath) {
  configPath = configPath || path.join(os.homedir(), '.claude.json');
  try {
    let config;
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } else {
      config = {};
    }
    config.projects = config.projects || {};
    config.projects[absPath] = {
      ...(config.projects[absPath] || {}),
      hasTrustDialogAccepted: true
    };
    // Atomic tmp+rename in the same directory. sid in tmp name avoids races
    // between concurrent summons (two workers being provisioned in parallel).
    const tmpPath = configPath + '.tmp-' + sid;
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
    fs.renameSync(tmpPath, configPath);
  } catch (e) {
    process.stderr.write(
      `[summon] could not pre-trust workspace: ${e.message} — user may see the trust prompt\n`
    );
  }
}

// Resolve an intelligence score (0-100) to a { model, reasoning } band from
// adapter/intelligence-map.json. Throws RangeError if score is out of [0,100]
// or no band covers it.
function resolveIntelligence(score) {
  const n = Number(score);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new RangeError(`--intelligence must be a number in [0,100]; got ${score}`);
  }
  const mapPath = path.join(session.ADVISOR_ROOT, 'adapter', 'intelligence-map.json');
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const band = map.bands.find(b => n >= b.low && n <= b.high);
  if (!band) throw new RangeError(`No band found for intelligence score ${n}`);
  return band;
}

// Recursive directory copy used by provisionCoderWorktree to overlay agent
// files (CLAUDE.md, .claude/) onto a git worktree as untracked files.
function localCopyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) localCopyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

const { expandSkillContent } = require('./skill-expand');

// For agent=coder: provision workspace as a git worktree of `repo` on a new
// isolated branch (ws/<sid>), then overlay the agent's CLAUDE.md + .claude/
// as untracked files so Claude Code finds its project context.
// Falls back to session.provisionWorkspace (copyDir) if git worktree fails.
function provisionCoderWorktree(sid, agentName, repo) {
  const agentSrc = path.join(session.ADVISOR_ROOT, 'spawns', agentName);
  if (!fs.existsSync(agentSrc) || !fs.existsSync(path.join(agentSrc, 'CLAUDE.md'))) {
    throw new Error(
      `Agent not found: spawns/${agentName}/ (must contain CLAUDE.md). ` +
        `Available: ${session.listAgents().join(', ') || '(none)'}`
    );
  }
  // Branch name format: ws/<sid>-<short>
  // sid = "<timestamp>-<hex>" — the hyphen-separated components are the
  // <sid> (timestamp) and <short> (hex rand) parts, so the branch is simply
  // "ws/" + the full session id.
  const branch = `ws/${sid}`;
  const dest = path.join(session.sessionDir(sid), 'workspace');
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', branch, dest], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    process.stderr.write(
      `[summon] git worktree failed (${String(e.message).split('\n')[0]}); falling back to copyDir\n`
    );
    return session.provisionWorkspace(sid, agentName);
  }
  // Overlay agent files on top of the worktree as untracked files.
  localCopyDir(agentSrc, dest);
  return dest;
}

// R2 prefix stability: this prompt is a per-AGENT-TYPE CONSTANT. It must not
// interpolate anything that varies per worker or per task (sid, paths, goal,
// tier budget, discovery hint, episodes) — those live in the inbox task
// message (composeTaskBody) so two same-type workers share a byte-identical
// prompt block and the API prompt-cache prefix extends through content[4].
// The concrete channel/output/repo paths reach the worker via the $INBOX /
// $OUTBOX / $OUTPUT_DIR / $ADV / $REPO env vars exported by launch.sh.
function composeBootstrapPrompt({
  agentName,
  subTeam,
  subTeamModel
}) {
  const _prompt = `You are the **${agentName}** worker for an advisor session.

Your project-level CLAUDE.md (in this working directory) defines your role and rules.
Read it now if you haven't.

## Channel — how you talk to the Advisor

Two append-only JSONL files. Their absolute paths are in these environment
variables your shell already has exported (don't retype the paths):

- \`$INBOX\`       — Advisor → you (inbox.jsonl)
- \`$OUTBOX\`      — you → Advisor (outbox.jsonl)
- \`$ADV\`         — advisor repo root, for invoking \`channel.js\`. **READ-ONLY tooling — NEVER an edit target.** Do not write under \`$ADV\` even if a task names a path there.
- \`$OUTPUT_DIR\`  — durable deliverables dir for new artifacts (see below)
- \`$REPO\`        — your **isolated working copy** of the target repo (for the coder agent this is a dedicated git worktree on its own branch; edits here never touch anyone's main checkout). ALL in-place edits go under \`$REPO\` and nowhere else.

The \`/worker-protocol\` skill (run at session start) has channel command syntax and message types.

## Deliverables — where to write files

Your cwd is an **ephemeral workspace**. Nothing written there survives.

You have **two** destinations, chosen by what the task asks for:

### Default: new artifact → \`$OUTPUT_DIR\`

When the task produces a standalone new artifact (plan.md, review.md, welcome.html,
research report, scaffolded component not yet in the real tree), write to the
directory exported as \`\$OUTPUT_DIR\`.

Durable across iteration. Include the full absolute path in your \`result\`.

### Exception: edit-in-place → a path inside \`$REPO\`

When the task **explicitly references an existing file path** that resolves
inside \`\$REPO\` (e.g. "change \$REPO/src/components/xyz-lander.vue" or "fix the
bug at src/foo.ts"), edit that file in place — **inside \`\$REPO\` only**:

- \`Read\` it first. Understand surrounding code before changing.
- Resolve the path **relative to \`\$REPO\`** (your isolated worktree), which is
  also your cwd. If the task gives a bare/repo-relative path, prefix \`\$REPO/\`.
- Use \`Edit\` / \`Write\` at that \`\$REPO\`-rooted path.
- **NEVER edit a path under \`\$ADV\`.** \`\$ADV\` is the live advisor install (read-only
  tooling). Even when working on the advisor's own code, the file you edit lives
  under \`\$REPO\` (your worktree), not \`\$ADV\`. If a task names \`\$ADV/lib/foo.js\`,
  edit \`\$REPO/lib/foo.js\` instead — they are the same file in your isolated copy.
- Report the edited path in your \`result\` so the user can review the diff.

**Do NOT edit-in-place on a hunch.** If the task is vague ("plan this refactor",
"build a welcome page"), default to \`\$OUTPUT_DIR\`. The user's real codebase is
not a scratch dir — only touch it when the task named the file explicitly.

### Writing structured files (JSON / YAML / TOML / code)

For files the user's editor or LSP may observe mid-write, write atomically:
create \`<file>.tmp\` **in the same directory as the target**, then \`mv\` into
place. Same-directory rename is atomic on any POSIX filesystem. Example:

    Write(\`\$OUTPUT_DIR/config.json.tmp\`, ...)
    Bash(\`mv "\$OUTPUT_DIR/config.json.tmp" "\$OUTPUT_DIR/config.json"\`)

For HTML / Markdown / plain text, partial-file-visible is harmless — skip the
tmp+rename and write in place.

## Protocol

Run \`/worker-protocol\` at session start — it loads inbox-polling rules, tracing, and self-terminate behavior.

1. Read inbox seq 1 (your first \`task\` message — it contains your task brief, your **goal** (done condition set by the Advisor), and your tool budget).
2. Send a \`progress\` message confirming you understood (one line).
3. Do the work. Write deliverables per the "where to write files" rules above —
   \`\$OUTPUT_DIR\` by default, explicit path inside \`\$REPO\` only when the task
   named the file.
4. When a deliverable is ready, send a \`result\` message that includes the full
   absolute path of every file you wrote.

## Result envelope

When you send your final result, populate \`body.meta.tokens\` = \`{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, total_used}\` as best-effort from session telemetry.

Begin by reading the inbox.
${subTeam ? `
## Sub-Team Mode

You have been launched with \`--sub-team\`. After reading your inbox task, invoke the \`/sub-teams\` skill to decompose and execute the task using a sub-team of workers.

IMPORTANT: When spawning delegator and teammate Task agents in Step 4 of /sub-teams, pass \`model: "${subTeamModel || 'sonnet'}"\` on every Task tool call. Use the same model value for both the delegator and every teammate.

**Result envelope** — when you send your final result via channel.js, include:
- \`body.sub_team_run_id\` (top-level string): the \`run_id\` from the sub-teams run
- \`body.meta.sub_team\`: \`{"run_id": "<run_id>", "teammate_count": N, "tasks_done": N, "tasks_failed": N}\`

**Verdict mapping:**
- 0 failures → \`"complete"\`
- >0 failures with summaries → \`"partial"\`
- phase == \`"failed"\` → \`"blocked"\`
` : ''}`;

  return _prompt;
}

// Build the per-task inbox seed message body. Everything worker- or
// task-varying that used to live in the bootstrap prompt goes here instead:
// the goal, the tier-derived tool budget, the discovery scaffolding, and the
// past-episodes section. The bootstrap prompt stays a per-agent-type constant.
function composeTaskBody({ sid, task, goal, discoveryHint }) {
  const TIER_BUDGETS = { fact: 15, comparison: 25, deep_research: 40, fixated: 20 };
  const sessionState = session.readSessionState(sid);
  const tier = (sessionState && sessionState.tier) || '';
  const TOOL_BUDGET = TIER_BUDGETS[tier] !== undefined ? TIER_BUDGETS[tier] : 25;

  let body = `${task}

## Goal (set by the Advisor, derived from the user's intent)
${goal}

## Tool Budget

You have a strict budget of ${TOOL_BUDGET} tool calls. Plan carefully. Maximum of one iteration per failure — rethink strategy if blocked. No incremental solutions; deliver complete implementations in single file writes.`;

  if (discoveryHint) {
    body += '\n\n' + DISCOVERY_SCAFFOLDING;
  }

  try {
    const { createHash } = require('crypto');
    const { queryEpisodes, queryEpisodesFuzzy } = require('./episodes');
    const task_hash = createHash('sha256').update((goal || '').slice(0, 200)).digest('hex');
    let eps = queryEpisodes(task_hash, 3);
    // If exact-hash finds fewer than 2 results, supplement with fuzzy matches.
    if (eps.length < 2 && goal) {
      try {
        const fuzzy = queryEpisodesFuzzy(goal, 3);
        const seenSids = new Set(eps.map(e => e.sid));
        for (const fe of fuzzy) {
          if (!seenSids.has(fe.sid)) {
            eps = eps.concat(fe);
            seenSids.add(fe.sid);
          }
        }
      } catch (_) {}
    }
    if (eps.length > 0) {
      body += '\n\n## Past episodes\n' + eps.map(e =>
        '- **' + e.established + '**' +
        (e.gap && e.gap !== 'none' ? ' Gap: ' + e.gap : '') +
        (e.key_quotes ? ' Quote: "' + e.key_quotes + '"' : '')
      ).join('\n');
    }
  } catch (_) {}
  return body;
}

// Pure helper: builds the env additions for settings.env given an optional
// protectedTests array. Returns {} when the list is absent/empty (gate stays
// inert); returns { ADVISOR_PROTECTED_TESTS: <JSON string> } otherwise.
function buildProtectedTestsEnv(protectedTests) {
  if (!protectedTests || protectedTests.length === 0) return {};
  return { ADVISOR_PROTECTED_TESTS: JSON.stringify(protectedTests) };
}

// Pure helper: builds the disabledMcpjsonServers list from a parsed .mcp.json.
// Returns { disabledMcpjsonServers: [names] } when servers are present,
// or {} when the input is absent, empty, or malformed.
function buildMcpDenylist(parsedMcpJson) {
  try {
    if (!parsedMcpJson || typeof parsedMcpJson !== 'object' || Array.isArray(parsedMcpJson)) return {};
    const servers = parsedMcpJson.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {};
    const names = Object.keys(servers).filter(k => k.length > 0);
    if (names.length === 0) return {};
    return { disabledMcpjsonServers: names };
  } catch (_) {
    return {};
  }
}

// Returns the merged hooks object for a worker workspace settings.json.
// Exported for testing. Preserves existing hook entries from the template and
// adds the advisor's mandatory hooks on top.
function injectWorkerHooks(existingHooks) {
  const existing = existingHooks || {};
  return {
    ...existing,
    PreToolUse: [
      ...(existing.PreToolUse || []),
      { matcher: '', hooks: [{ type: 'command', command: 'node $ADV/lib/tool-guard.js' }] },
      { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node $ADV/lib/hooks/agents-md-context.js' }] },
    ],
    PreCompact: [
      ...(existing.PreCompact || []),
      { matcher: '', hooks: [{ type: 'command', command: 'node $ADV/lib/compactor.js' }] },
    ],
    PostToolUse: [
      ...(existing.PostToolUse || []),
      { matcher: '', hooks: [{ type: 'command', command: 'node $ADV/lib/hooks/worker-trace.js' }] },
      { matcher: '', hooks: [{ type: 'command', command: 'bash $ADV/lib/hooks/worker-inbox-poll.sh' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'bash $ADV/lib/hooks/worker-auto-close.sh' }] },
    ],
    // SessionStart: map claude session UUID → advisor run SID for external tooling.
    SessionStart: [
      ...(existing.SessionStart || []),
      { matcher: '', hooks: [{ type: 'command', command: 'bash $ADV/lib/hooks/worker-session-map.sh' }] },
    ],
    // Stop: emit synthetic no_verdict result if the worker exited without one.
    Stop: [
      ...(existing.Stop || []),
      { matcher: '', hooks: [{ type: 'command', command: 'node $ADV/lib/hooks/worker-result-check.js' }] },
    ],
  };
}

// Pure helper: scale the default coder timeout by task complexity.
// Returns 1500 (default), 1800 (medium), or 2400 (large).
// Only called when agent === 'coder' AND no explicit --timeout was passed.
function scaledCoderTimeout(taskText) {
  const text = taskText || '';
  const len = text.length;
  const editCount = (text.match(/<edit/gi) || []).length;
  const stepCount = (text.match(/^\d+\./mg) || []).length;
  const complexity = Math.max(editCount, stepCount);
  if (len > 1500 || complexity >= 8) return 2400;
  if (len > 500 || complexity >= 3) return 1800;
  return 1500;
}

// Provision a single session. Returns the session metadata object (same shape
// as the JSON printed to stdout for a non-ensemble invocation).
const VALID_SUB_TEAM_MODELS = new Set(['sonnet', 'haiku', 'opus']);

function provisionOne(args, overrideSid) {
  const { agent, task, goal, model, intelligence, allowedTools, tui, timeoutSec, subTeam, subTeamModel, protectedTests, toolBudget } = args;

  let effectiveTimeoutSec = timeoutSec !== undefined ? Number(timeoutSec) : undefined;
  // Dynamic timeout: scale for coder when no explicit --timeout was passed.
  if (effectiveTimeoutSec === undefined && agent === 'coder') {
    effectiveTimeoutSec = scaledCoderTimeout(task);
  }
  if (effectiveTimeoutSec !== undefined) {
    const MIN = 60, MAX = 3600;
    const clamped = Math.min(MAX, Math.max(MIN, effectiveTimeoutSec));
    if (clamped !== effectiveTimeoutSec) {
      process.stderr.write(
        `[summon] --timeout ${effectiveTimeoutSec}s out of range [${MIN}–${MAX}]; clamped to ${clamped}s\n`
      );
      effectiveTimeoutSec = clamped;
    }
  }

  if (subTeamModel !== undefined && !VALID_SUB_TEAM_MODELS.has(subTeamModel)) {
    process.stderr.write(
      `[summon] --sub-team-model must be one of: sonnet, haiku, opus. Got: ${subTeamModel}\n`
    );
    process.exit(1);
  }

  let effectiveModel = model;
  let resolvedReasoning = null;
  if (intelligence !== undefined && !model) {
    const band = resolveIntelligence(intelligence);
    effectiveModel = band.model;
    resolvedReasoning = band.reasoning;
  }

  const sid = overrideSid || args.sid || session.mintSessionId();
  session.ensureChannel(sid);

  // Compute repo BEFORE provisioning workspace — needed by provisionCoderWorktree.
  const invokedCwd = args.cwd || process.cwd();
  const { dir: outputDir, reason: outputReason, repo } = session.computeOutputDir(
    sid,
    invokedCwd
  );
  fs.mkdirSync(outputDir, { recursive: true });

  // Provision workspace: git worktree for coder agent, copyDir for all others.
  const workspace =
    agent === 'coder'
      ? provisionCoderWorktree(sid, agent, repo)
      : session.provisionWorkspace(sid, agent);

  // node_modules symlink: give coder workers access to repo deps without running
  // 'bun install'. Fail-open — if the repo has no node_modules, skip silently.
  if (agent === 'coder') {
    const repoNM = path.join(repo, 'node_modules');
    const worktreeNM = path.join(workspace, 'node_modules');
    if (fs.existsSync(repoNM) && !fs.existsSync(worktreeNM)) {
      try { fs.symlinkSync(repoNM, worktreeNM); } catch (_) {}
    }
  }

  // SAFETY: the coder works in an isolated git worktree (provisionCoderWorktree),
  // so its $REPO must point at that worktree — NEVER the original repo. Otherwise,
  // in self-invocation (repo === ADVISOR_ROOT) the coder would edit the live main
  // tree in place via $REPO/... absolute paths, defeating worktree isolation and
  // risking catastrophic edits to the running advisor. For non-coder agents $REPO
  // stays the original repo (they get a copyDir template, not a repo checkout).
  const workerRepo = agent === 'coder' ? workspace : repo;

  // Pre-trust the fresh workspace so claude doesn't prompt on first launch.
  trustWorkspaceInClaudeConfig(workspace, sid);

  const chanDir = session.channelDir(sid);
  const inbox = session.inboxPath(sid);
  const outbox = session.outboxPath(sid);

  // Per-output-reason handling.
  if (outputReason === 'git-root') {
    try {
      const added = session.ensureGitignore(repo);
      if (added) {
        process.stderr.write(
          `[summon] appended .advisor-output/ to ${repo}/.gitignore\n`
        );
      }
    } catch (e) {
      process.stderr.write(`[summon] could not update .gitignore: ${e.message}\n`);
    }
  } else if (outputReason === 'cwd-fallback') {
    process.stderr.write(
      `[summon] ${invokedCwd} is NOT inside a git repo — using cwd as fallback.\n` +
        `           output → ${outputDir}\n` +
        `           (no .gitignore management; consider cd'ing into a git repo before /advisor)\n`
    );
  } else if (outputReason === 'self-invocation') {
    process.stderr.write(
      `[summon] self-invocation detected (cwd=${invokedCwd} inside advisor repo); ` +
        `output → ${outputDir}\n`
    );
  }

  const isTestSession = process.env.NODE_ENV === 'test' || args.isTestSession === true;

  session.writeMeta(sid, {
    sid,
    agent,
    task,
    goal,
    workspace,
    outputDir,
    repo,
    invokedCwd,
    outputReason,
    plan_ref: args.planRef || '',
    created_at: new Date().toISOString(),
    ...(isTestSession && { isTestSession: true }),
    ...(intelligence !== undefined && { intelligence: Number(intelligence) }),
    ...(resolvedReasoning && { reasoning: resolvedReasoning }),
    ...(effectiveTimeoutSec !== undefined && { timeoutSec: effectiveTimeoutSec })
  });

  let isVague = false;
  // Opt-in: preflight spawns `claude --print` (~3-7s, ~$0.05 via subscription).
  // The Advisor itself already classifies tasks, so this is off by default.
  if (process.env.ADVISOR_PREFLIGHT === '1') {
    try {
      const prefResult = spawnSync('node', ['-e',
        "require('./lib/preflight').preflight({prompt:process.env._PF_PROMPT,timeoutMs:5000})" +
        ".then(function(r){process.stdout.write(JSON.stringify(r));process.exit(0);})" +
        ".catch(function(){process.stdout.write('{\"is_vague\":false}');process.exit(0);});"
      ], {
        cwd: session.ADVISOR_ROOT,
        encoding: 'utf8',
        timeout: 8000,
        env: { ...process.env, _PF_PROMPT: task || '' }
      });
      if (prefResult.status === 0 && prefResult.stdout) {
        isVague = JSON.parse(prefResult.stdout).is_vague === true;
      }
    } catch (_) {
      // fail-open
    }
  }

  // Seed the inbox with the first task message. The body carries everything
  // task-varying (goal, tool budget, discovery scaffolding, past episodes) so
  // the bootstrap prompt below stays a per-agent-type constant.
  channel.append(inbox, {
    type: 'task',
    body: composeTaskBody({ sid, task, goal, discoveryHint: isVague }),
    from: 'advisor'
  });

  const prompt = composeBootstrapPrompt({
    agentName: agent,
    subTeam: subTeam === true || subTeam === 'true',
    subTeamModel: subTeamModel || 'sonnet'
  });
  const promptFile = path.join(session.sessionDir(sid), 'bootstrap-prompt.txt');
  fs.writeFileSync(promptFile, prompt);

  // Symlink advisor-local and agent-private skills into the workspace so that
  // Claude Code's project-skills resolution (workspace/.claude/skills/) finds them.
  // Skills whose SKILL.md frontmatter declares a tier that doesn't match the
  // session tier are excluded. Skills with $(...) in SKILL.md are copy+expanded
  // instead of symlinked so the worker sees evaluated content.
  const sessionState = session.readSessionState(sid);
  const sessionTier = sessionState && sessionState.tier;
  try {
    const skillsTargetDir = path.join(workspace, '.claude', 'skills');
    fs.mkdirSync(skillsTargetDir, { recursive: true });

    // Helper: check tier restriction for a skill source dir.
    // Returns true when the skill may be injected (no restriction or matching tier).
    function skillAllowed(src) {
      const mdPath = path.join(src, 'SKILL.md');
      if (!fs.existsSync(mdPath)) return true;
      const fm = agents.parseFrontmatter(mdPath);
      if (!fm.tier) return true;
      return !sessionTier || fm.tier === sessionTier;
    }

    // Helper: symlink or copy+expand a skill src → dest.
    function linkSkill(src, dest) {
      const mdPath = path.join(src, 'SKILL.md');
      const content = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
      if (/\$\([^)]+\)/.test(content)) {
        localCopyDir(src, dest);
        fs.writeFileSync(path.join(dest, 'SKILL.md'), expandSkillContent(content));
      } else {
        fs.symlinkSync(src, dest, 'dir');
      }
    }

    // Tier 1: advisor-local skills (<ROOT>/skills/<name>/)
    const localSkillsDir = path.join(session.ADVISOR_ROOT, 'skills');
    if (fs.existsSync(localSkillsDir)) {
      for (const entry of fs.readdirSync(localSkillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const src = path.join(localSkillsDir, entry.name);
        const dest = path.join(skillsTargetDir, entry.name);
        if (!skillAllowed(src)) continue;
        try {
          linkSkill(src, dest);
        } catch (e) {
          process.stderr.write(`[summon] warn: could not symlink skill ${entry.name}: ${e.message}\n`);
        }
      }
    }

    // Tier 2: agent-private skills (spawns/<AGENT>/.claude/skills/<name>/) — override local on collision.
    // provisionWorkspace already copied these dirs into the workspace as plain dirs;
    // we replace them with symlinks (or expanded copies), and remove tier-restricted ones.
    const agentSkillsDir = path.join(session.ADVISOR_ROOT, 'spawns', agent, '.claude', 'skills');
    if (fs.existsSync(agentSkillsDir)) {
      for (const entry of fs.readdirSync(agentSkillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const src = path.join(agentSkillsDir, entry.name);
        const dest = path.join(skillsTargetDir, entry.name);
        // Remove whatever provisionWorkspace copied (or a prior Tier 1 symlink) — handles
        // both files/symlinks and directories, unlike unlinkSync which fails on dirs.
        if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
        if (!skillAllowed(src)) continue;
        try {
          linkSkill(src, dest);
        } catch (e) {
          process.stderr.write(`[summon] warn: could not symlink agent skill ${entry.name}: ${e.message}\n`);
        }
      }
    }
  } catch (e) {
    process.stderr.write(`[summon] warn: could not set up skills symlinks: ${e.message}\n`);
  }

  // Inject hooks into workspace .claude/settings.json so tool-guard, compactor,
  // and worker PostToolUse hooks fire in every worker session without requiring
  // agent templates to include them.
  // ADVISOR_WORKER_HOOKS=1 for all agents so trace/inbox-poll hooks are universal.
  {
    const settingsDir = path.join(workspace, '.claude');
    const settingsPath = path.join(settingsDir, 'settings.json');
    fs.mkdirSync(settingsDir, { recursive: true });
    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (_) {}
    settings.hooks = injectWorkerHooks(settings.hooks);
    settings.env = settings.env || {};
    settings.env.ADVISOR_WORKER_HOOKS = '1';
    if (toolBudget !== undefined) {
      settings.env.ADVISOR_TOOL_BUDGET = String(toolBudget);
    }
    const protectedPaths = Array.isArray(protectedTests)
      ? protectedTests.filter(Boolean)
      : (protectedTests ? String(protectedTests).split(',').map(s => s.trim()).filter(Boolean) : []);
    Object.assign(settings.env, buildProtectedTestsEnv(protectedPaths));
    // Suppress the interactive MCP picker by listing all .mcp.json servers in
    // disabledMcpjsonServers. --strict-mcp-config (launch.sh) blocks loading but
    // does not silence the picker; only a named decision per server does.
    const mcpJsonPath = path.join(workspace, '.mcp.json');
    let parsedMcpJson = null;
    if (fs.existsSync(mcpJsonPath)) {
      try { parsedMcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8')); } catch (_) {}
    }
    Object.assign(settings, buildMcpDenylist(parsedMcpJson));
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }

  // Write a per-session launch.sh so bin/summon can invoke it via osascript
  // without nested-quote hell. The shell reads the prompt file itself.
  // Paths are shell-escaped to survive single quotes, spaces, etc. in
  // ADVISOR_ROOT (e.g. installs under /Users/O'Brien/...).
  const modelFlag = effectiveModel ? `--model ${shesc(effectiveModel)} ` : '';
  const modelExport = effectiveModel ? `export MODEL=${shesc(effectiveModel)}\n` : '';
  // Per-worker advisor-tool policy. The native advisor model is configured via
  // the `advisorModel` SETTING, not a CLI flag — `claude` has no `--advisor`
  // option (it is rejected as an unknown option, and under `set -e` that kills
  // the worker at launch). So we steer the advisor through the environment:
  //   - Fable workers: HARD-DISABLE the advisor. Fable 5 (the main model) can
  //     only pair with a fable advisor — the API rejects opus/sonnet advisors
  //     for a fable request ("cannot be used as an advisor") — and a fable
  //     advisor on every fable worker is expensive overkill. The env var is the
  //     only per-worker disable that overrides the global advisorModel pin.
  //   - Every other worker: inherit the global advisorModel (currently `opus`),
  //     the working, sensible default. No per-worker export needed.
  const disableAdvisor = !!effectiveModel && effectiveModel.includes('fable');
  const advisorEnvExport = disableAdvisor
    ? 'export CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1\n'
    : '';
  // Pattern 5.3: explicit --allowedTools wins; otherwise fall back to the
  // 'allowed-tools' frontmatter field (a comma-separated string — use directly).
  let effectiveAllowedTools = allowedTools;
  if (!effectiveAllowedTools) {
    const claudeMdPath = path.join(session.ADVISOR_ROOT, 'spawns', agent, 'CLAUDE.md');
    const fm = agents.parseFrontmatter(claudeMdPath);
    if (typeof fm['allowed-tools'] === 'string' && fm['allowed-tools'].trim()) {
      // Normalize the comma string to the no-space form (Read,Edit,Write) that
      // the launch path has always used (the old default_tools.join(',') path).
      // The frontmatter is written human-readable with ", " separators; emitting
      // those spaces verbatim risks claude treating " Edit" as an unknown tool.
      effectiveAllowedTools = fm['allowed-tools']
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .join(',');
    }
  }
  const allowedToolsFlag = effectiveAllowedTools ? `--allowedTools ${shesc(effectiveAllowedTools)} ` : '';
  // R3 (static safe denylist): --allowedTools is permission-only and does NOT
  // shrink the request; only --disallowedTools removes a tool's schema from the
  // prompt (verified: ~20KB for Workflow alone). WORKER_DISALLOWED_TOOLS lists
  // built-in tools that NO worker of any agent type ever invokes — advisor/
  // harness/planning tools (the worker talks to the advisor via channel.js, not
  // these). It is intentionally STATIC and conservative: the same list for every
  // agent (so it never fragments cross-worker prefix cache sharing), and it
  // deliberately omits anything an agent might need (Agent, Edit, Write, Read,
  // Bash, Skill, WebFetch, WebSearch, plus DesignSync/NotebookEdit/advisor which
  // a frontend/coder/non-fable worker could plausibly use). Worst case if the CLI
  // renames/drops a tool is missed savings, never a broken worker. A per-agent
  // complement (trimming Edit/Write/Agent for read-only agents) is a deferred
  // follow-up requiring per-agent tool-mapping + TDD across all agent types.
  const WORKER_DISALLOWED_TOOLS = [
    'Workflow', 'Monitor', 'ScheduleWakeup',
    'CronCreate', 'CronDelete', 'CronList',
    'RemoteTrigger', 'PushNotification',
    'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree',
    'ShareOnboardingGuide', 'AskUserQuestion',
    'TaskCreate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'TaskUpdate',
  ];
  const disallowedToolsFlag = `--disallowedTools ${shesc(WORKER_DISALLOWED_TOOLS.join(','))} `;
  const launchScript = path.join(session.sessionDir(sid), 'launch.sh');
  // Both modes omit --print; headless uses tmux+Stop-hook (tmux-runner.js) for result capture.
  // Both modes keep the -- terminator (load-bearing: prevents --allowedTools
  // from consuming the prompt arg; see commit 76aac8c).
  // Run claude as a child (no exec) so the wrapper can seal the outbox after
  // it exits. If claude exits non-zero, capture exit code without aborting
  // the script (|| _exit_code=$? is not subject to set -e). The ensure-result
  // call is a no-op when the worker already wrote its own result envelope.
  const claudeCore = `claude --permission-mode auto ${modelFlag}${allowedToolsFlag}${disallowedToolsFlag}--strict-mcp-config -- "$(cat ${shesc(promptFile)})"`;

  const claudeLaunchBody = [
    'classifyError() {',
    '  local _ce_stderr="$1"',
    "  if echo \"$_ce_stderr\" | grep -qE '401|403|authentication|invalid api key|context_length|context window|subscription'; then",
    "    echo 'fatal'",
    "  elif echo \"$_ce_stderr\" | grep -qE '429|500|502|503|504|529|overloaded|rate_limit|ECONNRESET|ETIMEDOUT|service unavailable|at capacity'; then",
    "    echo 'transient'",
    '  else',
    "    echo 'unknown'",
    '  fi',
    '}',
    '_exit_code=0',
    '_attempt=0',
    '_max_attempts=3',
    'while [ $_attempt -lt $_max_attempts ]; do',
    '  _attempt=$(( _attempt + 1 ))',
    '  _ce_tmp=$(mktemp)',
    `  ${claudeCore} 2>"$_ce_tmp" || _exit_code=$?`,
    '  if [ $_exit_code -eq 0 ]; then break; fi',
    '  _ce_class=$(classifyError "$(cat "$_ce_tmp")")',
    '  if [ "$_ce_class" = "transient" ] && [ $_attempt -lt $_max_attempts ]; then',
    '    _exit_code=0',
    '    sleep 10',
    '    continue',
    '  fi',
    '  break',
    'done',
    'rm -f "$_ce_tmp" 2>/dev/null || true',
    `bun "$ADV/lib/channel.js" ensure-result --file "$OUTBOX" --exit-code "$_exit_code" --from wrapper --quiet || true`,
  ].join('\n');
  fs.writeFileSync(
    launchScript,
    `#!/usr/bin/env bash
set -e
cd ${shesc(workspace)}
# Channel paths exported so the worker's bash calls can reference
# $INBOX / $OUTBOX / $OUTPUT_DIR / $ADV instead of retyping absolute paths
# on every tool call (saves tokens per turn).
export INBOX=${shesc(inbox)}
export OUTBOX=${shesc(outbox)}
export OUTPUT_DIR=${shesc(outputDir)}
export ADV=${shesc(session.ADVISOR_ROOT)}
export ADVISOR_SID=${shesc(sid)}
export ADVISOR_AGENT=${shesc(agent)}
# $REPO = the worker's working copy of the target repo. For the coder agent this
# is the ISOLATED git worktree (workerRepo === workspace), so in-place edits land
# on the worktree branch (ws/<sid>) and never touch the original/main checkout —
# critical in self-invocation where the original repo is the live advisor install.
# For non-coder agents it is the original repo root (git root of invocation cwd,
# or ADVISOR_ROOT for self-invocation). Workers edit in place only under $REPO.
export REPO=${shesc(workerRepo)}
tty > ${shesc(path.join(session.sessionDir(sid), 'tty.txt'))} 2>/dev/null || true
${modelExport}${advisorEnvExport}${claudeLaunchBody}
`
  );
  fs.chmodSync(launchScript, 0o755);

  return {
    sid,
    agent,
    workspace,
    outputDir,
    repo,
    outputReason,
    channelDir: chanDir,
    inbox,
    outbox,
    promptFile,
    launchScript,
    goal,
    task,
    ...(effectiveTimeoutSec !== undefined && { timeoutSec: effectiveTimeoutSec })
  };
}

function main() {
  const args = parseArgs(process.argv);
  const { agent, task, goal } = args;
  const ensemble = args.ensemble ? parseInt(args.ensemble, 10) : 0;

  if (!agent || !task || !goal) {
    console.error(
      'Usage: summon.js --agent <name> --task "<brief>" --goal "<done>" [--sid <id>] [--ensemble <N>]'
    );
    console.error('Available agents: ' + (session.listAgents().join(', ') || '(none)'));
    process.exit(1);
  }

  if (ensemble > 0) {
    // Spawn N independent sessions on the same brief; each gets a fresh sid.
    const sessions = [];
    for (let i = 0; i < ensemble; i++) {
      sessions.push(provisionOne(args, session.mintSessionId()));
    }
    process.stdout.write(
      JSON.stringify({ batch: true, ensemble, sessions }, null, 2) + '\n'
    );
    return;
  }

  const meta = provisionOne(args);
  process.stdout.write(JSON.stringify(meta, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = { composeBootstrapPrompt, composeTaskBody, trustWorkspaceInClaudeConfig, resolveIntelligence, provisionOne, buildProtectedTestsEnv, buildMcpDenylist, parseArgs, injectWorkerHooks, scaledCoderTimeout };
