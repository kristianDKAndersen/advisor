import { test, expect, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

const LIB_SUMMON = path.resolve(import.meta.dir, '../lib/summon.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'summon-hook-merge-'));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Test 1: existing PreToolUse hooks survive injection ───────────────────────
// RED: current injectWorkerHooks overwrites PreToolUse — template hook is lost.
test('hook injection: existing PreToolUse hooks in settings.json survive injection', async () => {
  const { injectWorkerHooks } = await import(LIB_SUMMON);

  const existingHooks = {
    PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'my-guard.sh' }] }],
  };

  const merged = injectWorkerHooks(existingHooks);

  // Before fix: PreToolUse only has the advisor hook (length === 1, my-guard.sh gone)
  // After fix: PreToolUse has both template hook AND advisor hook (length >= 2)
  expect(merged.PreToolUse.length).toBeGreaterThanOrEqual(2);
  const commands = merged.PreToolUse.map(e => e.hooks[0].command);
  expect(commands.some(c => c.includes('my-guard.sh'))).toBe(true);
  expect(commands.some(c => c.includes('tool-guard.js'))).toBe(true);
});

// ── Test 2: absent PreToolUse produces only advisor hooks ─────────────────────
test('hook injection: absent PreToolUse in template produces only advisor hooks', async () => {
  const { injectWorkerHooks } = await import(LIB_SUMMON);

  const merged = injectWorkerHooks(undefined);

  expect(merged.PreToolUse.length).toBeGreaterThanOrEqual(1);
  const commands = merged.PreToolUse.map(e => e.hooks[0].command);
  expect(commands.some(c => c.includes('tool-guard.js'))).toBe(true);
});
