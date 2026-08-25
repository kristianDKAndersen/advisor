import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const claudeMd = path.resolve(__dirname, '../spawns/deep-researcher/CLAUDE.md');
const content = fs.readFileSync(claudeMd, 'utf8');

test('spawns/deep-researcher/CLAUDE.md contains no reference to bias-auditor', () => {
  const matches = content.match(/bias-auditor/g);
  expect(matches).toBeNull();
});

test('spawns/deep-researcher/CLAUDE.md contains no reference to report-architect', () => {
  const matches = content.match(/report-architect/g);
  expect(matches).toBeNull();
});

test('spawns/deep-researcher/CLAUDE.md uses --from deep-researcher (not --from researcher)', () => {
  const wrongFrom = content.match(/--from researcher(?!-)/g);
  expect(wrongFrom).toBeNull();
});

test('spawns/deep-researcher/CLAUDE.md contains no agent_type="fact-checker"', () => {
  const matches = content.match(/agent_type\s*=\s*["']fact-checker["']/g);
  expect(matches).toBeNull();
});

test('spawns/deep-researcher/CLAUDE.md contains no agent_type="planner"', () => {
  const matches = content.match(/agent_type\s*=\s*["']planner["']/g);
  expect(matches).toBeNull();
});

// The "allowed-tools includes Task" assertion below (removed 2026-08-25) pinned a
// superseded contract. Root doctrine in claude.md states: "Workers cannot summon
// further workers... If you need multi-agent coordination, YOU coordinate - do not
// push it onto a worker." The sibling spawns/creative/CLAUDE.md shows the compliant
// pattern: allowed-tools with no Task, and dual-mode prose that makes sequential
// execution in the worker's own context the only path for a summoned worker.
// Commit 947582d removed Task from this spawn's allowed-tools to fix that doctrine
// violation; the assertions below lock the corrected contract so it cannot be
// silently "fixed" back to the violation.
test('spawns/deep-researcher/CLAUDE.md allowed-tools does NOT include Task', () => {
  const m = content.match(/^allowed-tools:\s*(.+)$/m);
  expect(m).toBeTruthy();
  if (m) {
    const tools = m[1].split(',').map((t) => t.trim());
    expect(tools).not.toContain('Task');
  }
});

test('spawns/deep-researcher/CLAUDE.md contains no executable Task( invocation', () => {
  // Matches an actual tool call like `Task(` but not prose that merely names the
  // tool ("Task tool", "via Task calls").
  const executableTaskCall = /\bTask\(/;
  expect(executableTaskCall.test(content)).toBe(false);
});

test('spawns/deep-researcher/CLAUDE.md dual-mode prose naming the Task tool is not mistaken for an executable call', () => {
  // Sanity-checks the assertion above: the file legitimately mentions "Task tool"
  // and "Task calls" in prose describing what a top-level orchestrator (not this
  // worker) could do. If these disappear, the no-executable-Task test above may be
  // passing vacuously rather than because the file is actually compliant.
  expect(content).toMatch(/no Task tool required/);
  expect(content).toMatch(/via Task calls/);
});

test('spawns/deep-researcher/CLAUDE.md declares sequential-in-own-context as the only mode for summoned workers', () => {
  expect(content).toMatch(/Sequential mode \(default for summoned workers\)/);
  expect(content).toMatch(/workers cannot summon further workers/);
});
