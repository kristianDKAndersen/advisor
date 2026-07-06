import { test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { injectWorkerHooks } from '../lib/summon.js';

const STOP_TELEMETRY = path.resolve(import.meta.dir, '../.claude/hooks/stop-telemetry.js');

// Root cause: injectWorkerHooks' Stop array never included stop-telemetry.js,
// so worker sessions' settings.json (built by provisionOne) never ran the
// telemetry hook that appends to token-usage.jsonl. Only the advisor's own
// top-level .claude/settings.json wired it up.
test('injectWorkerHooks registers stop-telemetry.js on the Stop event', () => {
  const hooks = injectWorkerHooks({});
  expect(hooks.Stop).toBeDefined();
  const commands = hooks.Stop.flatMap((entry) => entry.hooks.map((h) => h.command));
  expect(commands.some((c) => c.includes('stop-telemetry.js'))).toBe(true);
});

test('injectWorkerHooks preserves the existing worker-result-check.js Stop hook', () => {
  const hooks = injectWorkerHooks({});
  const commands = hooks.Stop.flatMap((entry) => entry.hooks.map((h) => h.command));
  expect(commands.some((c) => c.includes('worker-result-check.js'))).toBe(true);
});

let tmpDir;
let stateDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-stop-telemetry-'));
  stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTranscript(sessionUuid, tokenCounts) {
  return tokenCounts
    .map((u) =>
      JSON.stringify({
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: u },
      })
    )
    .join('\n') + '\n';
}

// Simulates exactly how Claude Code invokes a Stop hook inside a worker
// session's worktree: stdin carries {session_id, transcript_path}, cwd is the
// worker's $REPO worktree, and ADVISOR_STATE_DIR is set (as it is for the
// advisor-cost CLI) so the row lands somewhere assertable instead of the
// real ~/.advisor/state.
test('stop-telemetry.js invoked in a worker context appends a usage row keyed by the claude session uuid', () => {
  const sessionUuid = 'ab12cd34-worker-session-uuid';
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  fs.writeFileSync(
    transcriptPath,
    makeTranscript(sessionUuid, [
      { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
    ])
  );

  const workerWorktree = path.join(tmpDir, 'worker-worktree');
  fs.mkdirSync(workerWorktree, { recursive: true });

  const result = spawnSync('node', [STOP_TELEMETRY], {
    input: JSON.stringify({ session_id: sessionUuid, transcript_path: transcriptPath }),
    encoding: 'utf8',
    cwd: workerWorktree,
    env: {
      ...process.env,
      ADVISOR_STATE_DIR: stateDir,
      ADVISOR_WORKER_HOOKS: '1',
    },
  });

  expect(result.status).toBe(0);

  const tokenLogPath = path.join(stateDir, 'token-usage.jsonl');
  expect(fs.existsSync(tokenLogPath)).toBe(true);
  const rows = fs.readFileSync(tokenLogPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const row = rows.find((r) => r.sid === sessionUuid);
  expect(row).toBeDefined();
  expect(row.total_used).toBe(165);
  expect(row.breakdown.input_tokens).toBe(100);
  expect(row.breakdown.output_tokens).toBe(50);
});

// --- lib/telemetry-backfill.js -------------------------------------------
// Root cause: worker sessions execute their whole task as ONE agent turn and
// self-terminate (close-tab) before that turn ends, so the Stop event never
// fires inside a worker session — the hook above is wired correctly but never
// runs. telemetry-backfill.js locates the worker's real Claude Code
// transcript from session-map.jsonl + the run's workspace path and invokes
// stop-telemetry.js directly as a substitute for the Stop event.

import {
  encodeProjectDir,
  resolveClaudeUuid,
  transcriptPathFor,
  accrueForSid,
  alreadyRecordedUuids,
} from '../lib/telemetry-backfill.js';

test('encodeProjectDir replaces / and . with - exactly like Claude Code project dir naming', () => {
  expect(encodeProjectDir('/Users/awesome/.advisor/runs/1783344767-d1fb78/workspace'))
    .toBe('-Users-awesome--advisor-runs-1783344767-d1fb78-workspace');
});

test('resolveClaudeUuid returns the LAST matching session-map.jsonl line for a run_sid', () => {
  const mapPath = path.join(stateDir, 'session-map.jsonl');
  fs.writeFileSync(
    mapPath,
    [
      { run_sid: 'sid-a', claude_uuid: 'uuid-old', agent: 'coder' },
      { run_sid: 'sid-a', claude_uuid: 'uuid-new', agent: 'coder' },
      { run_sid: 'sid-b', claude_uuid: 'uuid-b', agent: 'coder' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n'
  );
  expect(resolveClaudeUuid('sid-a', stateDir)).toBe('uuid-new');
  expect(resolveClaudeUuid('sid-missing', stateDir)).toBe(null);
});

test('accrueForSid is non-fatal when session-map.jsonl has no entry for the sid', () => {
  const result = accrueForSid('unmapped-sid', '/some/workspace', stateDir);
  expect(result.ok).toBe(false);
  expect(result.reason).toBe('no session-map entry');
});

test('accrueForSid is non-fatal when the transcript file does not exist on disk', () => {
  const mapPath = path.join(stateDir, 'session-map.jsonl');
  fs.writeFileSync(mapPath, JSON.stringify({ run_sid: 'sid-x', claude_uuid: 'uuid-x', agent: 'coder' }) + '\n');
  const projectsDir = path.join(tmpDir, 'claude-projects');
  const workspace = path.join(tmpDir, 'runs', 'sid-x', 'workspace');
  const prevProjectsDir = process.env.ADVISOR_CLAUDE_PROJECTS_DIR;
  process.env.ADVISOR_CLAUDE_PROJECTS_DIR = projectsDir;
  try {
    const result = accrueForSid('sid-x', workspace, stateDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('transcript not found');
  } finally {
    if (prevProjectsDir === undefined) delete process.env.ADVISOR_CLAUDE_PROJECTS_DIR;
    else process.env.ADVISOR_CLAUDE_PROJECTS_DIR = prevProjectsDir;
  }
});

test('accrueForSid appends a usage row by invoking stop-telemetry.js when the transcript exists', () => {
  const claudeUuid = 'uuid-accrue-success';
  const runSid = 'sid-accrue-success';
  const mapPath = path.join(stateDir, 'session-map.jsonl');
  fs.writeFileSync(mapPath, JSON.stringify({ run_sid: runSid, claude_uuid: claudeUuid, agent: 'coder' }) + '\n');

  const workspace = path.join(tmpDir, 'runs', runSid, 'workspace');
  const projectsDir = path.join(tmpDir, 'claude-projects');
  const projectDir = path.join(projectsDir, encodeProjectDir(workspace));
  fs.mkdirSync(projectDir, { recursive: true });
  const transcriptPath = path.join(projectDir, `${claudeUuid}.jsonl`);
  fs.writeFileSync(transcriptPath, makeTranscript(claudeUuid, [
    { input_tokens: 200, output_tokens: 75, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ]));

  const prevProjectsDir = process.env.ADVISOR_CLAUDE_PROJECTS_DIR;
  process.env.ADVISOR_CLAUDE_PROJECTS_DIR = projectsDir;
  try {
    expect(transcriptPathFor(workspace, claudeUuid)).toBe(transcriptPath);
    const result = accrueForSid(runSid, workspace, stateDir);
    expect(result.ok).toBe(true);
  } finally {
    if (prevProjectsDir === undefined) delete process.env.ADVISOR_CLAUDE_PROJECTS_DIR;
    else process.env.ADVISOR_CLAUDE_PROJECTS_DIR = prevProjectsDir;
  }

  const rows = fs.readFileSync(path.join(stateDir, 'token-usage.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const row = rows.find((r) => r.sid === claudeUuid);
  expect(row).toBeDefined();
  expect(row.total_used).toBe(275);
});

test('alreadyRecordedUuids reads the sid column of token-usage.jsonl', () => {
  fs.writeFileSync(
    path.join(stateDir, 'token-usage.jsonl'),
    JSON.stringify({ sid: 'already-here', total_used: 1 }) + '\n'
  );
  const set = alreadyRecordedUuids(stateDir);
  expect(set.has('already-here')).toBe(true);
  expect(set.has('not-here')).toBe(false);
});

// --- lib/channel.js synthesize: telemetry accrual before tab close --------

const CHANNEL_JS = path.resolve(import.meta.dir, '../lib/channel.js');

function runSynthesize(env, extraArgs = []) {
  return spawnSync('bun', [
    CHANNEL_JS, 'synthesize',
    '--sid', env.sid, '--seq', '1',
    '--established', 'x', '--gap', 'y', '--material', 'yes', '--next', 'z',
    ...extraArgs,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ADVISOR_STATE_DIR: stateDir,
      ADVISOR_RUNS_ROOT: env.runsRoot,
      ADVISOR_CLAUDE_PROJECTS_DIR: env.projectsDir,
      ADVISOR_SKIP_TAB_CLOSE: '1',
    },
  });
}

test('synthesize accrues a token-usage row for the worker sid before the tab would close', () => {
  const sid = 'synth-sid-accrual';
  const claudeUuid = 'uuid-synth-accrual';
  const runsRoot = path.join(tmpDir, 'runs');
  const workspace = path.join(runsRoot, sid, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(runsRoot, sid, 'meta.json'), JSON.stringify({ sid, workspace, agent: 'coder' }));

  fs.writeFileSync(path.join(stateDir, 'session-map.jsonl'), JSON.stringify({ run_sid: sid, claude_uuid: claudeUuid, agent: 'coder' }) + '\n');

  const projectsDir = path.join(tmpDir, 'claude-projects-synth');
  const projectDir = path.join(projectsDir, encodeProjectDir(workspace));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${claudeUuid}.jsonl`), makeTranscript(claudeUuid, [
    { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ]));

  const result = runSynthesize({ sid, runsRoot, projectsDir });
  expect(result.status).toBe(0);

  const rows = fs.readFileSync(path.join(stateDir, 'token-usage.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const row = rows.find((r) => r.sid === claudeUuid);
  expect(row).toBeDefined();
  expect(row.total_used).toBe(30);
});

test('synthesize does not fail when there is no session-map entry for the sid (non-fatal)', () => {
  const sid = 'synth-sid-no-map';
  const runsRoot = path.join(tmpDir, 'runs');
  fs.mkdirSync(path.join(runsRoot, sid), { recursive: true });
  fs.writeFileSync(path.join(runsRoot, sid, 'meta.json'), JSON.stringify({ sid, agent: 'coder' }));

  const result = runSynthesize({ sid, runsRoot, projectsDir: path.join(tmpDir, 'unused-projects') });
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('telemetry backfill skipped');
});

// --- bin/advisor-cost-backfill --------------------------------------------

const BACKFILL_BIN = path.resolve(import.meta.dir, '../bin/advisor-cost-backfill');

test('advisor-cost-backfill backfills unrecorded uuids and skips already-recorded ones', () => {
  const runsRoot = path.join(tmpDir, 'backfill-runs');
  const projectsDir = path.join(tmpDir, 'backfill-projects');

  // sid-new: mapped, transcript exists, NOT yet in token-usage.jsonl -> backfilled
  const newUuid = 'uuid-backfill-new';
  const newWorkspace = path.join(runsRoot, 'sid-new', 'workspace');
  fs.mkdirSync(path.join(runsRoot, 'sid-new'), { recursive: true });
  fs.writeFileSync(path.join(runsRoot, 'sid-new', 'meta.json'), JSON.stringify({ workspace: newWorkspace }));
  const newProjectDir = path.join(projectsDir, encodeProjectDir(newWorkspace));
  fs.mkdirSync(newProjectDir, { recursive: true });
  fs.writeFileSync(path.join(newProjectDir, `${newUuid}.jsonl`), makeTranscript(newUuid, [
    { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ]));

  // sid-old: mapped, but claude_uuid already present in token-usage.jsonl -> skipped
  const oldUuid = 'uuid-backfill-already-recorded';

  fs.writeFileSync(
    path.join(stateDir, 'session-map.jsonl'),
    [
      { run_sid: 'sid-new', claude_uuid: newUuid, agent: 'coder' },
      { run_sid: 'sid-old', claude_uuid: oldUuid, agent: 'coder' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n'
  );
  fs.writeFileSync(path.join(stateDir, 'token-usage.jsonl'), JSON.stringify({ sid: oldUuid, total_used: 999 }) + '\n');

  const dry = spawnSync('node', [BACKFILL_BIN, '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_STATE_DIR: stateDir, ADVISOR_RUNS_ROOT: runsRoot, ADVISOR_CLAUDE_PROJECTS_DIR: projectsDir },
  });
  expect(dry.status).toBe(0);
  expect(dry.stdout).toContain('would backfill: run_sid=sid-new');
  expect(dry.stdout).toContain('backfilled=1');
  expect(dry.stdout).toContain('skipped_already_recorded=1');

  const real = spawnSync('node', [BACKFILL_BIN], {
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_STATE_DIR: stateDir, ADVISOR_RUNS_ROOT: runsRoot, ADVISOR_CLAUDE_PROJECTS_DIR: projectsDir },
  });
  expect(real.status).toBe(0);
  expect(real.stdout).toContain('backfilled=1');

  const rows = fs.readFileSync(path.join(stateDir, 'token-usage.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const newRow = rows.find((r) => r.sid === newUuid);
  expect(newRow).toBeDefined();
  expect(newRow.total_used).toBe(10);
  const oldRows = rows.filter((r) => r.sid === oldUuid);
  expect(oldRows.length).toBe(1);
  expect(oldRows[0].total_used).toBe(999);
});
