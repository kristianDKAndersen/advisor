import { test, expect } from 'bun:test';
import path from 'path';
import { spawnSync } from 'child_process';

const REPO = path.resolve(import.meta.dir, '..');
const BIN = path.join(REPO, 'bin', 'advisor-mods-smoke');
const smoke = require(path.join(REPO, 'lib', 'mods-smoke.js'));

// --- parseArgs ---------------------------------------------------------

test('parseArgs: defaults to all three checks, haiku model', () => {
  const a = smoke.parseArgs([]);
  expect(a.only).toEqual(['write-gate', 'canary', 'fleet-waker']);
  expect(a.model).toBe('haiku');
  expect(a.keep).toBe(false);
  expect(a.json).toBe(false);
  expect(a.timeoutScale).toBe(1);
});

test('parseArgs: --only repeatable, de-duped, order preserved', () => {
  const a = smoke.parseArgs(['--only', 'canary', '--only', 'write-gate', '--only', 'canary']);
  expect(a.only).toEqual(['canary', 'write-gate']);
});

test('parseArgs: rejects unknown --only value', () => {
  expect(() => smoke.parseArgs(['--only', 'bogus'])).toThrow(smoke.UsageError);
});

test('parseArgs: --model, --keep, --json, --timeout-scale', () => {
  const a = smoke.parseArgs(['--model', 'sonnet', '--keep', '--json', '--timeout-scale', '2.5']);
  expect(a.model).toBe('sonnet');
  expect(a.keep).toBe(true);
  expect(a.json).toBe(true);
  expect(a.timeoutScale).toBe(2.5);
});

test('parseArgs: rejects non-numeric --timeout-scale', () => {
  expect(() => smoke.parseArgs(['--timeout-scale', 'abc'])).toThrow(smoke.UsageError);
});

test('parseArgs: rejects unknown flag', () => {
  expect(() => smoke.parseArgs(['--bogus'])).toThrow(smoke.UsageError);
});

test('parseArgs: --help short-circuits without requiring other flags', () => {
  const a = smoke.parseArgs(['--help']);
  expect(a.help).toBe(true);
});

// --- parseStreamJson / extractSessionId ---------------------------------

test('parseStreamJson: parses newline-delimited JSON, skips garbage lines', () => {
  const raw = '{"a":1}\nnot json\n{"b":2}\n\n';
  const events = smoke.parseStreamJson(raw);
  expect(events).toEqual([{ a: 1 }, { b: 2 }]);
});

test('extractSessionId: finds system/init event session_id', () => {
  const events = [
    { type: 'system', subtype: 'init', session_id: 'abc-123' },
    { type: 'assistant', session_id: 'should-not-use' },
  ];
  expect(smoke.extractSessionId(events)).toBe('abc-123');
});

test('extractSessionId: falls back to any session_id if no init event', () => {
  const events = [{ type: 'assistant', session_id: 'fallback-id' }];
  expect(smoke.extractSessionId(events)).toBe('fallback-id');
});

test('extractSessionId: returns null when absent', () => {
  expect(smoke.extractSessionId([{ type: 'assistant' }])).toBe(null);
});

// --- streamContainsText / countOccurrences -------------------------------

test('streamContainsText: substring match', () => {
  expect(smoke.streamContainsText('abc over the 51200-byte limit xyz', 'over the 51200-byte limit')).toBe(true);
  expect(smoke.streamContainsText('abc', 'over the 51200-byte limit')).toBe(false);
});

test('countOccurrences: counts non-overlapping matches', () => {
  expect(smoke.countOccurrences('a-b-a-b-a', 'a')).toBe(3);
  expect(smoke.countOccurrences('no match here', 'xyz')).toBe(0);
  expect(smoke.countOccurrences('', 'xyz')).toBe(0);
});

// --- ENV_SCRUB_VARS -------------------------------------------------------

test('ENV_SCRUB_VARS: contains all real CLAUDE_CODE_* child-session vars named in the spec', () => {
  const expected = [
    'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SSE_PORT',
    'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID',
    'TMUX', 'TMUX_PANE', 'INBOX', 'OUTBOX', 'ADVISOR_SID', 'ADVISOR_AGENT',
    'OUTPUT_DIR', 'REPO', 'ADV',
  ];
  for (const v of expected) expect(smoke.ENV_SCRUB_VARS).toContain(v);
  expect(smoke.ENV_SCRUB_VARS).not.toContain('HOME');
  expect(smoke.ENV_SCRUB_VARS).not.toContain('PATH');
  expect(smoke.ENV_SCRUB_VARS).not.toContain('CLAUDE_CODE_DISABLE_TELEMETRY');
  expect(smoke.ENV_SCRUB_VARS).not.toContain('CLAUDE_CODE_SUBAGENT_MODEL');
});

// --- fakeSummonScript -------------------------------------------------------

test('fakeSummonScript: embeds runsRoot and writes meta.json + outbox.jsonl', () => {
  const script = smoke.fakeSummonScript('/tmp/some-runs-root');
  expect(script).toContain('/tmp/some-runs-root');
  expect(script).toContain('meta.json');
  expect(script).toContain('outbox.jsonl');
  expect(script).toContain('#!/usr/bin/env bash');
  expect(script).toContain('echo ok');
});

// --- buildResultLine -------------------------------------------------------

test('buildResultLine: produces a JSONL record with stringified body', () => {
  const line = smoke.buildResultLine({ seq: 2, sid: 'abc', ts: 1000, summary: 'done', verdict: 'complete' });
  const parsed = JSON.parse(line);
  expect(parsed.seq).toBe(2);
  expect(parsed.sid).toBe('abc');
  expect(parsed.ts).toBe(1000);
  expect(parsed.type).toBe('result');
  expect(JSON.parse(parsed.body)).toEqual({ summary: 'done', verdict: 'complete' });
});

// --- timeoutReason -------------------------------------------------------

test('timeoutReason: signal set (spawnSync killed on timeout) maps to "timed out after Ns"', () => {
  expect(smoke.timeoutReason({ signal: 'SIGTERM' }, 420000)).toBe('timed out after 420s');
});

test('timeoutReason: ETIMEDOUT error maps to "timed out after Ns"', () => {
  expect(smoke.timeoutReason({ error: { code: 'ETIMEDOUT' } }, 60000)).toBe('timed out after 60s');
});

test('timeoutReason: normal completion (no signal, no error) returns null', () => {
  expect(smoke.timeoutReason({ status: 0 }, 60000)).toBe(null);
});

// --- needsEnterRetry -------------------------------------------------------

test('needsEnterRetry: true when pane still shows the literal sent text (not submitted)', () => {
  expect(smoke.needsEnterRetry('> Run exactly this bash command once: foo', 'Run exactly this bash command once: foo')).toBe(true);
});

test('needsEnterRetry: false when pane no longer contains the sent text (submitted)', () => {
  expect(smoke.needsEnterRetry('fleet: 1 in flight', 'Run exactly this bash command once: foo')).toBe(false);
});

// --- computeExitCode -------------------------------------------------------

test('computeExitCode: 0 when all results pass', () => {
  expect(smoke.computeExitCode([{ ok: true }, { ok: true }])).toBe(0);
});

test('computeExitCode: 1 when any result fails', () => {
  expect(smoke.computeExitCode([{ ok: true }, { ok: false }])).toBe(1);
});

// --- buildPaneCommand -------------------------------------------------------

test('buildPaneCommand: every scrub var appears as -u NAME, no shell string', () => {
  const argv = smoke.buildPaneCommand(['FOO', 'BAR'], {}, ['claude-arg'], '/tmp/pane-env.txt');
  expect(argv[0]).toBe('env');
  for (const v of ['FOO', 'BAR']) {
    const idx = argv.indexOf(v);
    expect(idx).toBeGreaterThan(0);
    expect(argv[idx - 1]).toBe('-u');
  }
});

test('buildPaneCommand: extraEnv becomes NAME=value, no other env assignments', () => {
  const argv = smoke.buildPaneCommand(['FOO'], { ADVISOR_RUNS_ROOT: '/tmp/r' }, ['--model', 'haiku'], '/tmp/pane-env.txt');
  expect(argv).toContain('ADVISOR_RUNS_ROOT=/tmp/r');
  const assignments = argv.filter((a) => /^[A-Z_]+=/.test(a));
  expect(assignments).toEqual(['ADVISOR_RUNS_ROOT=/tmp/r']);
});

test('buildPaneCommand: env -u precedes the sh recorder, claude follows sh', () => {
  const argv = smoke.buildPaneCommand(['FOO'], { K: 'v' }, ['--allowedTools', 'Bash'], '/tmp/pane-env.txt');
  const shIdx = argv.indexOf('sh');
  const fooIdx = argv.indexOf('FOO');
  const claudeIdx = argv.indexOf('claude');
  expect(argv[0]).toBe('env');
  expect(fooIdx).toBeGreaterThan(0);
  expect(argv[fooIdx - 1]).toBe('-u');
  expect(shIdx).toBeGreaterThan(fooIdx);
  expect(claudeIdx).toBeGreaterThan(shIdx);
  expect(argv).toEqual([
    'env', '-u', 'FOO', 'K=v',
    'sh', '-c', 'env | cut -d= -f1 | sort > "/tmp/pane-env.txt"; exec "$@"', 'sh',
    'claude', '--allowedTools', 'Bash',
  ]);
});

// --- trustSelectionState -------------------------------------------------------

const PANE_1_NO_SELECTED = `
 Accessing workspace:

 /private/var/folders/_6/vmd0pwrx1855p302r0jrmqvm0000gn/T/mods-smoke-fleet-waker-uEP1uV/work

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`;

const PANE_YES_SELECTED = PANE_1_NO_SELECTED
  .replace(' ❯ No, exit', '   No, exit')
  .replace('   Yes, I trust this folder', ' ❯ Yes, I trust this folder');

test('trustSelectionState: "No, exit" highlighted (exact captured pane-1.txt lines)', () => {
  expect(smoke.trustSelectionState(PANE_1_NO_SELECTED)).toBe('no');
});

test('trustSelectionState: "Yes, I trust this folder" highlighted', () => {
  expect(smoke.trustSelectionState(PANE_YES_SELECTED)).toBe('yes');
});

test('trustSelectionState: absent when dialog text is not shown', () => {
  expect(smoke.trustSelectionState('fleet: 1 in flight\n')).toBe('absent');
});

// --- isInputReady -------------------------------------------------------

test('isInputReady: false while the trust dialog is showing', () => {
  expect(smoke.isInputReady(PANE_1_NO_SELECTED)).toBe(false);
});

test('isInputReady: false when no empty prompt row is between two rules', () => {
  const notReady = [
    '────────────────────────────────────────',
    ' Starting up...',
    '────────────────────────────────────────',
  ].join('\n');
  expect(smoke.isInputReady(notReady)).toBe(false);
});

test('isInputReady: true for an empty "❯ " prompt row between two rule lines', () => {
  const ready = [
    '────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────',
    ' ⏸ manual mode on · ← for agents',
  ].join('\n');
  expect(smoke.isInputReady(ready)).toBe(true);
});

// --- detectScrubLeak -------------------------------------------------------

test('detectScrubLeak: returns empty array when none of the scrub vars are present', () => {
  expect(smoke.detectScrubLeak(['HOME', 'PATH'], ['TMUX', 'CLAUDECODE'])).toEqual([]);
});

test('detectScrubLeak: returns leaked names that are present', () => {
  expect(smoke.detectScrubLeak(['HOME', 'TMUX', 'CLAUDECODE'], ['TMUX', 'CLAUDECODE', 'CLAUDE_PID'])).toEqual(['TMUX', 'CLAUDECODE']);
});

// --- lastNonBlankLines / formatPaneEvidence -------------------------------------------------------

test('lastNonBlankLines: drops blank lines, keeps last N', () => {
  expect(smoke.lastNonBlankLines('a\n\nb\nc\n\n\nd\n', 2)).toEqual(['c', 'd']);
});

test('formatPaneEvidence: blank-only capture reports pane-empty marker + pane_dead status', () => {
  const ev = smoke.formatPaneEvidence('\n\n  \n', '1 0');
  expect(ev[0]).toBe('(pane empty - session may have exited)');
  expect(ev[1]).toContain('1 0');
});

test('formatPaneEvidence: non-blank capture returns last 20 non-blank lines', () => {
  const lines = Array.from({ length: 25 }, (_, i) => `line${i}`).join('\n');
  const ev = smoke.formatPaneEvidence(lines, '0 0');
  expect(ev.length).toBe(20);
  expect(ev[0]).toBe('line5');
  expect(ev[19]).toBe('line24');
});

// --- bin: --help and usage error (no live sessions) -------------------------------------------------------

test('bin --help: exits 0, prints usage, no side effects', () => {
  const r = spawnSync('bun', [BIN, '--help'], { encoding: 'utf8', timeout: 15000 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('advisor-mods-smoke');
  expect(r.stdout).toContain('Usage:');
});

test('bin: unknown flag exits 2 (usage error) before any side effect', () => {
  const r = spawnSync('bun', [BIN, '--bogus'], { encoding: 'utf8', timeout: 15000 });
  expect(r.status).toBe(2);
});

test('bin: --only with bad value exits 2', () => {
  const r = spawnSync('bun', [BIN, '--only', 'nonsense'], { encoding: 'utf8', timeout: 15000 });
  expect(r.status).toBe(2);
});
