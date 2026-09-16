import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';

// Overridable so a worker session whose .claude/settings.json is a worker-overlay
// (not the committed file) can point this at the true committed file for the
// duration of a red/green run. In a normal checkout this defaults to the real path.
const ADVISOR_ROOT = path.resolve(import.meta.dir, '../..');
const SETTINGS_PATH = process.env.ADVISOR_SETTINGS_PATH
  ? path.resolve(ADVISOR_ROOT, process.env.ADVISOR_SETTINGS_PATH)
  : path.join(ADVISOR_ROOT, '.claude', 'settings.json');

function loadSettings() {
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
}

// A coder-worker's own .claude/settings.json is a worker overlay, not the committed
// file, and has no UserPromptSubmit entry — skip rather than false-fail in that case.
const isOverlay = !process.env.ADVISOR_SETTINGS_PATH && !loadSettings().hooks.UserPromptSubmit;

test.skipIf(isOverlay)('settings.json UserPromptSubmit command is quoted and guarded against non-zero exit/stderr', () => {
  const settings = loadSettings();
  const command = settings.hooks.UserPromptSubmit[0].hooks[0].command;

  // Path must be quoted so a space in $CLAUDE_PROJECT_DIR cannot split the argument.
  expect(command).toContain('"$CLAUDE_PROJECT_DIR');

  // Command must be guarded so it can never exit non-zero or leak stderr onto the
  // user's prompt turn, mirroring the house '|| true' precedent used by PreCompact.
  expect(command).toMatch(/\|\|\s*true\s*$/);
});

test.skipIf(isOverlay)('settings.json still declares all six hook events', () => {
  const settings = loadSettings();
  const events = Object.keys(settings.hooks);
  for (const name of ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact', 'UserPromptSubmit']) {
    expect(events).toContain(name);
  }
});
