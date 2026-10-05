import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'context-pressure.js');

function assistantLine(usage, id) {
  return JSON.stringify({ message: { role: 'assistant', id, usage } });
}

function usageFor(totalInput) {
  return { input_tokens: totalInput, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

function writeTranscript(dir, name, lines) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function runHook(sid, transcriptPath, env = {}) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify({ session_id: sid, transcript_path: transcriptPath, hook_event_name: 'PostToolUse' }),
    encoding: 'utf8',
    env: { ...process.env, ADVISOR_WORKER_HOOKS: '0', ...env },
  });
}

describe('context-pressure hook', () => {
  let tmpDir;
  let stateDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-pressure-'));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-pressure-state-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test('below threshold: silent', () => {
    const t = writeTranscript(tmpDir, 't.jsonl', [assistantLine(usageFor(50000), 'm1')]);
    const r = runHook('sid-1', t, { ADVISOR_STATE_DIR: stateDir });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  test('crossing 200K injects once', () => {
    const t = writeTranscript(tmpDir, 't.jsonl', [assistantLine(usageFor(205000), 'm1')]);
    const r = runHook('sid-2', t, { ADVISOR_STATE_DIR: stateDir });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('205K');
    expect(out.hookSpecificOutput.additionalContext).toContain("Context pressure response");
  });

  test('same band does not repeat', () => {
    const t1 = writeTranscript(tmpDir, 't1.jsonl', [assistantLine(usageFor(205000), 'm1')]);
    const first = runHook('sid-3', t1, { ADVISOR_STATE_DIR: stateDir });
    expect(JSON.parse(first.stdout).hookSpecificOutput).toBeDefined();

    const t2 = writeTranscript(tmpDir, 't2.jsonl', [assistantLine(usageFor(210000), 'm1')]);
    const second = runHook('sid-3', t2, { ADVISOR_STATE_DIR: stateDir });
    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toBe('');
  });

  test('next band (250K) injects again', () => {
    const t1 = writeTranscript(tmpDir, 't1.jsonl', [assistantLine(usageFor(205000), 'm1')]);
    runHook('sid-4', t1, { ADVISOR_STATE_DIR: stateDir });

    const t2 = writeTranscript(tmpDir, 't2.jsonl', [assistantLine(usageFor(251000), 'm1')]);
    const second = runHook('sid-4', t2, { ADVISOR_STATE_DIR: stateDir });
    expect(second.status).toBe(0);
    const out = JSON.parse(second.stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain('251K');
  });

  test('ADVISOR_WORKER_HOOKS=1 silent', () => {
    const t = writeTranscript(tmpDir, 't.jsonl', [assistantLine(usageFor(300000), 'm1')]);
    const r = runHook('sid-5', t, { ADVISOR_STATE_DIR: stateDir, ADVISOR_WORKER_HOOKS: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  test('missing transcript silent with exit 0', () => {
    const r = runHook('sid-6', path.join(tmpDir, 'does-not-exist.jsonl'), { ADVISOR_STATE_DIR: stateDir });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  test('malformed transcript silent with exit 0', () => {
    const t = path.join(tmpDir, 'bad.jsonl');
    fs.writeFileSync(t, 'not json\n{also not json\n');
    const r = runHook('sid-7', t, { ADVISOR_STATE_DIR: stateDir });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  test('missing session_id/transcript_path in stdin silent with exit 0', () => {
    const r = spawnSync('node', [HOOK], {
      input: JSON.stringify({ hook_event_name: 'PostToolUse' }),
      encoding: 'utf8',
      env: { ...process.env, ADVISOR_WORKER_HOOKS: '0', ADVISOR_STATE_DIR: stateDir },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  test('uses last assistant usage, not the sum of all messages', () => {
    // two earlier messages individually below threshold but summing well over it;
    // the last message alone is also below threshold -> must stay silent.
    const t = writeTranscript(tmpDir, 't.jsonl', [
      assistantLine(usageFor(120000), 'm1'),
      assistantLine(usageFor(130000), 'm2'),
      assistantLine(usageFor(90000), 'm3'),
    ]);
    const r = runHook('sid-8', t, { ADVISOR_STATE_DIR: stateDir });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  test('uses last assistant usage when it alone crosses the threshold', () => {
    const t = writeTranscript(tmpDir, 't.jsonl', [
      assistantLine(usageFor(10000), 'm1'),
      assistantLine(usageFor(220000), 'm2'),
    ]);
    const r = runHook('sid-9', t, { ADVISOR_STATE_DIR: stateDir });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain('220K');
  });

  test('hook never exits non-zero even on garbage stdin', () => {
    const r = spawnSync('node', [HOOK], {
      input: 'not json at all',
      encoding: 'utf8',
      env: { ...process.env, ADVISOR_WORKER_HOOKS: '0', ADVISOR_STATE_DIR: stateDir },
    });
    expect(r.status).toBe(0);
  });
});
