import { test, expect, describe } from 'bun:test';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const hookPath = new URL('../lib/hooks/worker-trace.js', import.meta.url).pathname;

function runHook(event, outputDir) {
  const result = execSync(`node ${hookPath}`, {
    input: JSON.stringify(event),
    env: { ...process.env, OUTPUT_DIR: outputDir, ADVISOR_WORKER_HOOKS: '1' },
    encoding: 'utf8',
  });
  return result;
}

describe('worker-trace — stdout/stderr fields (CC 2.1.177+)', () => {
  test('reads stdout field and produces non-empty result_summary', () => {
    const dir = join(tmpdir(), `wt-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const event = {
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
      tool_response: { stdout: 'hello world\nsome output\n', stderr: '' },
    };
    runHook(event, dir);
    const traceFile = join(dir, 'trace.jsonl');
    expect(existsSync(traceFile)).toBe(true);
    const line = JSON.parse(readFileSync(traceFile, 'utf8').trim().split('\n').pop());
    expect(line.result_summary.length).toBeGreaterThan(0);
    expect(line.result_summary).toContain('hello world');
    rmSync(dir, { recursive: true, force: true });
  });

  test('appends stderr to stdout in result_summary', () => {
    const dir = join(tmpdir(), `wt-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const event = {
      tool_name: 'Bash',
      tool_input: { command: 'cmd' },
      tool_response: { stdout: 'out', stderr: 'err-detail' },
    };
    runHook(event, dir);
    const line = JSON.parse(readFileSync(join(dir, 'trace.jsonl'), 'utf8').trim());
    expect(line.result_summary).toContain('out');
    expect(line.result_summary).toContain('err-detail');
    rmSync(dir, { recursive: true, force: true });
  });

  test('falls back to legacy .output field when stdout absent', () => {
    const dir = join(tmpdir(), `wt-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const event = {
      tool_name: 'Read',
      tool_input: { file_path: '/some/file.js' },
      tool_response: { output: 'legacy output content' },
    };
    runHook(event, dir);
    const line = JSON.parse(readFileSync(join(dir, 'trace.jsonl'), 'utf8').trim());
    expect(line.result_summary).toContain('legacy output content');
    rmSync(dir, { recursive: true, force: true });
  });

  test('handles error field when no stdout or output', () => {
    const dir = join(tmpdir(), `wt-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const event = {
      tool_name: 'Bash',
      tool_input: { command: 'bad' },
      tool_response: { error: 'command not found' },
    };
    runHook(event, dir);
    const line = JSON.parse(readFileSync(join(dir, 'trace.jsonl'), 'utf8').trim());
    expect(line.result_summary).toContain('error:');
    expect(line.result_summary).toContain('command not found');
    rmSync(dir, { recursive: true, force: true });
  });
});
