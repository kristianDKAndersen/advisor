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
//   2. Copies agents/<name>/ → .advisor-runs/<sid>/workspace/
//      (agent=coder: git worktree add -b ws/<sid> instead; copyDir overlay on top)
//   3. Creates .advisor-runs/<sid>/channel/{inbox,outbox}.jsonl
//   4. Appends the initial `task` message to inbox.
//   5. Writes meta.json + bootstrap-prompt.txt
//   6. Prints JSON: {sid, agent, workspace, channelDir, inbox, outbox, promptFile, goal, task}
//      (--ensemble N: prints {batch:true, ensemble:N, sessions:[...]} instead)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const channel = require('./channel');
const session = require('./session');

// Shell-quote a string for safe interpolation into a single-quoted bash literal.
// Each embedded single quote becomes '\'' (close-quote, escaped quote, re-open).
function shesc(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      out[a.slice(2)] = argv[i + 1];
      i++;
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

// For agent=coder: provision workspace as a git worktree of `repo` on a new
// isolated branch (ws/<sid>), then overlay the agent's CLAUDE.md + .claude/
// as untracked files so Claude Code finds its project context.
// Falls back to session.provisionWorkspace (copyDir) if git worktree fails.
function provisionCoderWorktree(sid, agentName, repo) {
  const agentSrc = path.join(session.ADVISOR_ROOT, 'agents', agentName);
  if (!fs.existsSync(agentSrc) || !fs.existsSync(path.join(agentSrc, 'CLAUDE.md'))) {
    throw new Error(
      `Agent not found: agents/${agentName}/ (must contain CLAUDE.md). ` +
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

function composeBootstrapPrompt({
  sid,
  agentName,
  workspace,
  channelDir,
  outputDir,
  advisorRoot,
  repo,
  outputReason,
  goal
}) {
  const TIER_BUDGETS = { fact: 15, comparison: 25, deep_research: 40, fixated: 20 };
  const sessionState = session.readSessionState(sid);
  const tier = (sessionState && sessionState.tier) || '';
  const TOOL_BUDGET = TIER_BUDGETS[tier] !== undefined ? TIER_BUDGETS[tier] : 25;

  return `You are the **${agentName}** worker for advisor session \`${sid}\`.

Your project-level CLAUDE.md (in this working directory) defines your role and rules.
Read it now if you haven't.

## Channel — how you talk to the Advisor

Two append-only JSONL files. Their absolute paths are in these environment
variables your shell already has exported (don't retype the paths):

- \`$INBOX\`       — Advisor → you (${channelDir}/inbox.jsonl)
- \`$OUTBOX\`      — you → Advisor (${channelDir}/outbox.jsonl)
- \`$ADV\`         — advisor repo root, for invoking \`channel.js\`
- \`$OUTPUT_DIR\`  — durable deliverables dir for new artifacts (see below)
- \`$REPO\`        — the user's repo root (${repo})${
    outputReason === 'self-invocation' ? ' — self-invocation: = ADVISOR_ROOT' : ''
  }

The \`/worker-protocol\` skill (run at session start) has channel command syntax and message types.

## Deliverables — where to write files

Your cwd is an **ephemeral workspace** (${workspace}). Nothing written there survives.

You have **two** destinations, chosen by what the task asks for:

### Default: new artifact → \`$OUTPUT_DIR\`

When the task produces a standalone new artifact (plan.md, review.md, welcome.html,
research report, scaffolded component not yet in the real tree), write to:

    \$OUTPUT_DIR   = ${outputDir}

Durable across iteration. Include the full absolute path in your \`result\`.

### Exception: edit-in-place → a path inside \`$REPO\`

    \$REPO         = ${repo}

When the task **explicitly references an existing file path** that resolves
inside \`\$REPO\` (e.g. "change \$REPO/src/components/xyz-lander.vue" or "fix the
bug at /Users/x/code/proj/src/foo.ts"), edit that file in place:

- \`Read\` it first. Understand surrounding code before changing.
- Use \`Edit\` / \`Write\` at the real absolute path.
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

## Goal (set by the Advisor, derived from the user's intent)
${goal}

## Tool Budget

You have a strict budget of ${TOOL_BUDGET} tool calls. Plan carefully. Maximum of one iteration per failure — rethink strategy if blocked. No incremental solutions; deliver complete implementations in single file writes.

## Protocol

Run \`/worker-protocol\` at session start — it loads inbox-polling rules, tracing, and self-terminate behavior.

1. Read inbox seq 1 (your first \`task\`).
2. Send a \`progress\` message confirming you understood (one line).
3. Do the work. Write deliverables per the "where to write files" rules above —
   \`\$OUTPUT_DIR\` by default, explicit path inside \`\$REPO\` only when the task
   named the file.
4. When a deliverable is ready, send a \`result\` message that includes the full
   absolute path of every file you wrote.

## Result envelope

When you send your final result, populate \`body.meta.tokens\` = \`{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, total_used}\` as best-effort from session telemetry.

Begin by reading the inbox.
`;
}

// Provision a single session. Returns the session metadata object (same shape
// as the JSON printed to stdout for a non-ensemble invocation).
function provisionOne(args, overrideSid) {
  const { agent, task, goal, model, intelligence, allowedTools } = args;

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
    ...(intelligence !== undefined && { intelligence: Number(intelligence) }),
    ...(resolvedReasoning && { reasoning: resolvedReasoning })
  });

  // Seed the inbox with the first task message.
  channel.append(inbox, { type: 'task', body: task, from: 'advisor' });

  const prompt = composeBootstrapPrompt({
    sid,
    agentName: agent,
    workspace,
    channelDir: chanDir,
    outputDir,
    advisorRoot: session.ADVISOR_ROOT,
    repo,
    outputReason,
    goal
  });
  const promptFile = path.join(session.sessionDir(sid), 'bootstrap-prompt.txt');
  fs.writeFileSync(promptFile, prompt);

  // Symlink advisor-local and agent-private skills into the workspace so that
  // Claude Code's project-skills resolution (workspace/.claude/skills/) finds them.
  try {
    const skillsTargetDir = path.join(workspace, '.claude', 'skills');
    fs.mkdirSync(skillsTargetDir, { recursive: true });

    // Tier 1: advisor-local skills (<ROOT>/skills/<name>/)
    const localSkillsDir = path.join(session.ADVISOR_ROOT, 'skills');
    if (fs.existsSync(localSkillsDir)) {
      for (const entry of fs.readdirSync(localSkillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const src = path.join(localSkillsDir, entry.name);
        const dest = path.join(skillsTargetDir, entry.name);
        try {
          fs.symlinkSync(src, dest, 'dir');
        } catch (e) {
          process.stderr.write(`[summon] warn: could not symlink skill ${entry.name}: ${e.message}\n`);
        }
      }
    }

    // Tier 2: agent-private skills (agents/<AGENT>/.claude/skills/<name>/) — override local on collision
    const agentSkillsDir = path.join(session.ADVISOR_ROOT, 'agents', agent, '.claude', 'skills');
    if (fs.existsSync(agentSkillsDir)) {
      for (const entry of fs.readdirSync(agentSkillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const src = path.join(agentSkillsDir, entry.name);
        const dest = path.join(skillsTargetDir, entry.name);
        try {
          if (fs.existsSync(dest)) fs.unlinkSync(dest);
          fs.symlinkSync(src, dest, 'dir');
        } catch (e) {
          process.stderr.write(`[summon] warn: could not symlink agent skill ${entry.name}: ${e.message}\n`);
        }
      }
    }
  } catch (e) {
    process.stderr.write(`[summon] warn: could not set up skills symlinks: ${e.message}\n`);
  }

  // Inject hooks into workspace .claude/settings.json so tool-guard and compactor
  // fire in every worker session without requiring agent templates to include them.
  {
    const settingsDir = path.join(workspace, '.claude');
    const settingsPath = path.join(settingsDir, 'settings.json');
    fs.mkdirSync(settingsDir, { recursive: true });
    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (_) {}
    settings.hooks = {
      ...(settings.hooks || {}),
      PreToolUse: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: 'node $ADV/lib/tool-guard.js' }],
        },
      ],
      PreCompact: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: 'node $ADV/lib/compactor.js' }],
        },
      ],
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }

  // Write a per-session launch.sh so bin/summon can invoke it via osascript
  // without nested-quote hell. The shell reads the prompt file itself.
  // Paths are shell-escaped to survive single quotes, spaces, etc. in
  // ADVISOR_ROOT (e.g. installs under /Users/O'Brien/...).
  const modelFlag = effectiveModel ? `--model ${shesc(effectiveModel)} ` : '';
  const modelExport = effectiveModel ? `export MODEL=${shesc(effectiveModel)}\n` : '';
  const allowedToolsFlag = allowedTools ? `--allowedTools ${shesc(allowedTools)} ` : '';
  const launchScript = path.join(session.sessionDir(sid), 'launch.sh');
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
# $REPO = the user's repo root (git root of invocation cwd, or cwd if not a
# git repo). For self-invocation it's ADVISOR_ROOT. Workers can read files
# from $REPO by absolute path, and edit files in place when the task
# explicitly references a path inside $REPO.
export REPO=${shesc(repo)}
tty > ${shesc(path.join(session.sessionDir(sid), 'tty.txt'))} 2>/dev/null || true
${modelExport}exec claude ${modelFlag}${allowedToolsFlag}"$(cat ${shesc(promptFile)})"
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
    task
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

module.exports = { composeBootstrapPrompt, trustWorkspaceInClaudeConfig, resolveIntelligence, provisionOne };
