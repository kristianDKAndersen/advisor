#!/usr/bin/env node
// summon.js — provision an ephemeral worker session and compose its bootstrap prompt.
//
// Does NOT open the Terminal tab itself (that's bin/summon in bash — avoids
// osascript quoting hell from node). Instead prints JSON with all paths so the
// caller can do the `osascript do script` step.
//
// Usage:
//   node lib/summon.js --agent <name> --task "<brief>" --goal "<done condition>" [--sid <id>]
//
// Effects:
//   1. Mints a session id (or uses --sid).
//   2. Copies agents/<name>/ → .advisor-runs/<sid>/workspace/
//   3. Creates .advisor-runs/<sid>/channel/{inbox,outbox}.jsonl
//   4. Appends the initial `task` message to inbox.
//   5. Writes meta.json + bootstrap-prompt.txt
//   6. Prints JSON: {sid, agent, workspace, channelDir, inbox, outbox, promptFile, goal, task}

const fs = require('fs');
const os = require('os');
const path = require('path');
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
  const chanCmd = `bun "$ADV/lib/channel.js"`;
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

Track the highest \`seq\` you've read from the inbox so you don't re-read old messages.

### Read new inbox messages (blocks up to 5 min for new ones)
    ${chanCmd} tail --file "$INBOX" --after <last_seq> --timeout 300 --json

### Read inbox without blocking
    ${chanCmd} recv --file "$INBOX" --after <last_seq> --json

### Send a message to the Advisor (use --quiet to suppress echo)
    ${chanCmd} send --file "$OUTBOX" --type <type> --body "<text>" --from ${agentName} --quiet

### Message types

You SEND:
- \`progress\` — intermediate observation (many of these are fine, keep each concise)
- \`result\`   — a completed deliverable
- \`question\` — only if truly blocked; the pattern is *execute, don't negotiate*

You RECEIVE:
- \`task\`      — work to do (your first inbox message, seq 1, is one)
- \`guidance\`  — course correction; adjust and continue
- \`terminate\` — Advisor says done; exit cleanly and immediately

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

## Protocol

Run \`/worker-protocol\` at session start — it loads inbox-polling rules, tracing, and self-terminate behavior.

1. Read inbox seq 1 (your first \`task\`).
2. Send a \`progress\` message confirming you understood (one line).
3. Do the work. Write deliverables per the "where to write files" rules above —
   \`\$OUTPUT_DIR\` by default, explicit path inside \`\$REPO\` only when the task
   named the file.
4. When a deliverable is ready, send a \`result\` message that includes the full
   absolute path of every file you wrote.
5. After sending \`result\`, self-terminate immediately per the \`/worker-protocol\` skill.
6. On \`terminate\`, self-terminate immediately per the \`/worker-protocol\` skill.

Begin by reading the inbox.
`;
}

function main() {
  const args = parseArgs(process.argv);
  const { agent, task, goal, model } = args;
  if (!agent || !task || !goal) {
    console.error('Usage: summon.js --agent <name> --task "<brief>" --goal "<done>" [--sid <id>]');
    console.error('Available agents: ' + (session.listAgents().join(', ') || '(none)'));
    process.exit(1);
  }

  const sid = args.sid || session.mintSessionId();
  session.ensureChannel(sid);
  const workspace = session.provisionWorkspace(sid, agent);
  // Pre-trust the fresh workspace so claude doesn't prompt on first launch.
  trustWorkspaceInClaudeConfig(workspace, sid);
  const chanDir = session.channelDir(sid);
  const inbox = session.inboxPath(sid);
  const outbox = session.outboxPath(sid);

  // Capture invocation cwd ONCE and bake it in. Resolving git-root later
  // would drift if the caller cd's between invocation and session start.
  const invokedCwd = args.cwd || process.cwd();
  const { dir: outputDir, reason: outputReason, repo } = session.computeOutputDir(
    sid,
    invokedCwd
  );
  fs.mkdirSync(outputDir, { recursive: true });

  // Per-output-reason handling:
  //  - git-root: append .advisor-output/ to the repo's .gitignore
  //  - cwd-fallback: warn loudly — user invoked from a non-git dir, output
  //    landed there rather than somewhere "repo-shaped", which may surprise
  //    them (think /tmp, ~/Downloads, a freshly-mkdir'd scratch).
  //  - self-invocation: one-line notice explaining the route.
  if (outputReason === 'git-root') {
    try {
      const added = session.ensureGitignore(repo);
      if (added) {
        process.stderr.write(
          `[summon] appended .advisor-output/ to ${repo}/.gitignore\n`
        );
      }
    } catch (e) {
      // Non-fatal — session still works, just warn the user.
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
    created_at: new Date().toISOString()
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

  // Write a per-session launch.sh so bin/summon can invoke it via osascript
  // without nested-quote hell. The shell reads the prompt file itself.
  // Paths are shell-escaped to survive single quotes, spaces, etc. in
  // ADVISOR_ROOT (e.g. installs under /Users/O'Brien/...).
  const modelFlag = model ? `--model ${shesc(model)} ` : '';
  const modelExport = model ? `export MODEL=${shesc(model)}\n` : '';
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
${modelExport}exec claude ${modelFlag}"$(cat ${shesc(promptFile)})"
`
  );
  fs.chmodSync(launchScript, 0o755);

  process.stdout.write(
    JSON.stringify(
      {
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
      },
      null,
      2
    ) + '\n'
  );
}

if (require.main === module) main();

module.exports = { composeBootstrapPrompt, trustWorkspaceInClaudeConfig };
