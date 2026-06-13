import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { injectWorkerHooks } from '../lib/summon.js';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const HOOK = path.join(REPO_ROOT, 'lib', 'hooks', 'agents-md-context.js');

function runHook(stdin, env = {}) {
  return spawnSync('node', [HOOK], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function makeInput(tool_name, file_path) {
  return JSON.stringify({ tool_name, tool_input: { file_path } });
}

describe('agents-md-context hook — CLI', () => {
  let tmpDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-ctx-'));
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // (a) nearest AGENTS.md wins when several exist up the chain
  test('(a) nearest AGENTS.md wins over ancestor when both exist', () => {
    const aDir = path.join(tmpDir, 'a');
    const bDir = path.join(tmpDir, 'a', 'b');
    const cDir = path.join(tmpDir, 'a', 'b', 'c');
    fs.mkdirSync(cDir, { recursive: true });
    fs.writeFileSync(path.join(aDir, 'AGENTS.md'), '# root agents\n');
    fs.writeFileSync(path.join(bDir, 'AGENTS.md'), '# b agents — closest\n');
    const fooPath = path.join(cDir, 'foo.js');
    fs.writeFileSync(fooPath, 'const x = 1;\n');

    const r = runHook(makeInput('Edit', fooPath), { REPO: tmpDir });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain('b agents — closest');
    expect(out.hookSpecificOutput.additionalContext).not.toContain('root agents');
  });

  // (b) no AGENTS.md anywhere = empty stdout + exit 0
  test('(b) no AGENTS.md anywhere produces empty stdout and exits 0', () => {
    const emptyDir = path.join(tmpDir, 'empty', 'sub');
    fs.mkdirSync(emptyDir, { recursive: true });
    const fooPath = path.join(emptyDir, 'file.ts');
    fs.writeFileSync(fooPath, 'export {};\n');

    const r = runHook(makeInput('Write', fooPath), { REPO: path.join(tmpDir, 'empty') });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  // (c) non-Edit tool = ignored (empty stdout, exit 0)
  test('(c) non-Edit tool (Bash) produces empty stdout and exits 0', () => {
    const r = runHook(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
      { REPO: tmpDir }
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  // (d) additionalContext contains the file's text
  test('(d) additionalContext contains the exact contents of the nearest AGENTS.md', () => {
    const dDir = path.join(tmpDir, 'd');
    fs.mkdirSync(dDir, { recursive: true });
    const agentsMdContent = '# D module\nsome rule here\n';
    fs.writeFileSync(path.join(dDir, 'AGENTS.md'), agentsMdContent);
    const filePath = path.join(dDir, 'mod.js');
    fs.writeFileSync(filePath, 'module.exports = {};\n');

    const r = runHook(makeInput('Edit', filePath), { REPO: tmpDir });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain(agentsMdContent);
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  });

  // NotebookEdit is also a covered tool
  test('NotebookEdit triggers AGENTS.md injection', () => {
    const eDir = path.join(tmpDir, 'e');
    fs.mkdirSync(eDir, { recursive: true });
    fs.writeFileSync(path.join(eDir, 'AGENTS.md'), '# notebook zone\n');
    const nbPath = path.join(eDir, 'analysis.ipynb');
    fs.writeFileSync(nbPath, '{}');

    const r = runHook(makeInput('NotebookEdit', nbPath), { REPO: tmpDir });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain('notebook zone');
  });

  test('Read tool is ignored (not an edit tool)', () => {
    const r = runHook(
      JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/foo.js' } }),
      { REPO: tmpDir }
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  test('hook never exits non-zero even on malformed input', () => {
    const r = runHook('not json at all', { REPO: tmpDir });
    expect(r.status).toBe(0);
  });
});

// (e) injectWorkerHooks includes the Edit|Write entry for agents-md-context
describe('injectWorkerHooks — agents-md-context wiring', () => {
  test('(e) injectWorkerHooks includes an Edit|Write PreToolUse entry for agents-md-context.js', () => {
    const hooks = injectWorkerHooks({});
    const editWriteEntry = (hooks.PreToolUse || []).find(entry =>
      entry.matcher === 'Edit|Write' &&
      Array.isArray(entry.hooks) &&
      entry.hooks.some(h => typeof h.command === 'string' && h.command.includes('agents-md-context.js'))
    );
    expect(editWriteEntry).toBeDefined();
  });

  test('(e) agents-md-context entry uses node command and type:command', () => {
    const hooks = injectWorkerHooks({});
    const entry = (hooks.PreToolUse || []).find(e =>
      e.matcher === 'Edit|Write' &&
      e.hooks.some(h => h.command && h.command.includes('agents-md-context.js'))
    );
    expect(entry).toBeDefined();
    const cmd = entry.hooks.find(h => h.command && h.command.includes('agents-md-context.js'));
    expect(cmd.type).toBe('command');
    expect(cmd.command).toContain('node');
    expect(cmd.command).toContain('$ADV');
  });
});
