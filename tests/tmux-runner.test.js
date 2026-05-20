import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureStopHook, parseTranscript } from '../lib/tmux-runner.js';

const STOP_HOOK_COMMAND =
  'if [ -n "$CLAUDE_I_SENTINEL" ]; then cat > "$CLAUDE_I_SENTINEL.json"; touch "$CLAUDE_I_SENTINEL"; fi';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-runner-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── ensureStopHook ────────────────────────────────────────────────────────────

test('ensureStopHook: creates settings.json when absent', () => {
  const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
  ensureStopHook(settingsPath);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const stopEntries = settings.hooks?.Stop ?? [];
  const cmds = stopEntries.flatMap((e) => (e.hooks ?? []).map((h) => h.command));
  expect(cmds).toContain(STOP_HOOK_COMMAND);
});

test('ensureStopHook: merges into existing settings without clobbering other hooks', () => {
  const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      theme: 'dark',
      hooks: {
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'echo pre' }] }],
      },
    })
  );

  ensureStopHook(settingsPath);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  expect(settings.theme).toBe('dark');
  expect(settings.hooks.PreToolUse).toBeDefined();
  const stopCmds = (settings.hooks.Stop ?? [])
    .flatMap((e) => (e.hooks ?? []).map((h) => h.command));
  expect(stopCmds).toContain(STOP_HOOK_COMMAND);
});

test('ensureStopHook: is idempotent — does not duplicate the hook', () => {
  const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
  ensureStopHook(settingsPath);
  ensureStopHook(settingsPath);
  ensureStopHook(settingsPath);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const stopCmds = (settings.hooks?.Stop ?? [])
    .flatMap((e) => (e.hooks ?? []).map((h) => h.command))
    .filter((c) => c === STOP_HOOK_COMMAND);
  expect(stopCmds.length).toBe(1);
});

test('ensureStopHook: skips if Stop hook command already present in array', () => {
  const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const existing = {
    hooks: {
      Stop: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: STOP_HOOK_COMMAND }],
        },
      ],
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2));

  ensureStopHook(settingsPath);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  expect(settings.hooks.Stop.length).toBe(1);
});

// ── parseTranscript ───────────────────────────────────────────────────────────

test('parseTranscript: extracts last assistant text from JSONL', () => {
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    }),
    JSON.stringify({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'First reply' }],
      },
    }),
    JSON.stringify({
      message: { role: 'user', content: [{ type: 'text', text: 'More' }] },
    }),
    JSON.stringify({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Final answer' }],
      },
    }),
  ];
  fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');

  const result = parseTranscript(transcriptPath);
  expect(result).toBe('Final answer');
});

test('parseTranscript: concatenates multiple text blocks in last assistant message', () => {
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  const line = JSON.stringify({
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Part A' },
        { type: 'tool_use', id: 'x', name: 'Bash', input: {} },
        { type: 'text', text: ' Part B' },
      ],
    },
  });
  fs.writeFileSync(transcriptPath, line + '\n');

  const result = parseTranscript(transcriptPath);
  expect(result).toBe('Part A Part B');
});

test('parseTranscript: skips malformed JSONL lines gracefully', () => {
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  const content = [
    'NOT VALID JSON {{{',
    JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: 'Good' }] },
    }),
    'also bad',
  ].join('\n');
  fs.writeFileSync(transcriptPath, content);

  const result = parseTranscript(transcriptPath);
  expect(result).toBe('Good');
});

test('parseTranscript: returns empty string when no assistant messages', () => {
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  const line = JSON.stringify({
    message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
  });
  fs.writeFileSync(transcriptPath, line + '\n');

  const result = parseTranscript(transcriptPath);
  expect(result).toBe('');
});

test('parseTranscript: throws when transcript file is missing', () => {
  const transcriptPath = path.join(tmpDir, 'nonexistent.jsonl');
  expect(() => parseTranscript(transcriptPath)).toThrow();
});
