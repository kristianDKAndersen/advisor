const { test, expect } = require('bun:test');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const SCRIPT = join(__dirname, '..', 'bin', 'advisor-check-doctrine');

function makeFixtureRoot(spawns) {
  const root = mkdtempSync(join(tmpdir(), 'doctrine-fixture-'));
  for (const [name, content] of Object.entries(spawns)) {
    const dir = join(root, 'spawns', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'CLAUDE.md'), content);
  }
  return root;
}

function run(root, extraArgs = []) {
  try {
    const out = execFileSync('bun', [SCRIPT, '--root', root, '--json', ...extraArgs], {
      encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: err.stdout ? err.stdout.toString() : '' };
  }
}

const GOOD = `# Good Worker

You are a focused **good worker**, summoned by an Advisor to do good things.

## Result

After finishing, send a \`result\` message via channel.js to your outbox with the
deliverable path.

## After sending result — self-terminate

Immediately run \`bash "$ADV/bin/close-tab"\` as your final action. Do not tail
the inbox or wait for follow-up.
`;

const BAD_A_SELF_TERMINATE = `# Bad A Worker

You are a focused **bad-a worker**, summoned by an Advisor.

## After a \`result\` — stay alive for iteration

Do **not** exit after sending \`result\`. Loop on your inbox for further
guidance.

## Result

Send a \`result\` message via channel.js to your outbox.
`;

const BAD_B_RECURSIVE_SPAWN = `# Bad B Worker

You are a focused **bad-b worker**, summoned by an Advisor.

## Result

Send a \`result\` message via channel.js to your outbox.

## Delegate via Task

Use the Task tool to spawn a general-purpose agent:

Task(
  subagent_type="general-purpose",
  prompt="do work"
)
`;

const BAD_C_NO_RESULT_CONTRACT = `# Bad C Worker

You are a focused **bad-c worker**, summoned by an Advisor to do a thing.

## Finishing up

Immediately run \`bash "$ADV/bin/close-tab"\` as your final action. Do not
tail the inbox or wait for follow-up.
`;

const BAD_D_UNRESOLVED_AGENT = `# Bad D Worker

You are a focused **bad-d worker**, summoned by an Advisor.

## Result

Send a \`result\` message via channel.js to your outbox.

## Delegate

If you need help, run \`bin/summon --agent ghost-worker\` to get assistance.

## After sending result — self-terminate

Immediately run \`bash "$ADV/bin/close-tab"\` as your final action.
`;

test('help exits 0 before any filesystem access', () => {
  const out = execFileSync('bun', [SCRIPT, '--root', '/definitely/does/not/exist', '-h'], {
    encoding: 'utf8',
  });
  expect(out).toMatch(/Usage: advisor-check-doctrine/);
});

test('true negative: fully compliant fixture exits 0 with zero violations', () => {
  const root = makeFixtureRoot({ good: GOOD });
  try {
    const { code, out } = run(root);
    expect(code).toBe(0);
    expect(JSON.parse(out).violations).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('true positive: self-terminate-after-result contradiction', () => {
  const root = makeFixtureRoot({ 'bad-a': BAD_A_SELF_TERMINATE });
  try {
    const { code, out } = run(root);
    expect(code).toBe(1);
    const violations = JSON.parse(out).violations;
    expect(violations.length).toBe(1);
    expect(violations[0].invariant).toBe('self-terminate-after-result');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('true positive: no-recursive-spawning without a recursion guard', () => {
  const root = makeFixtureRoot({ 'bad-b': BAD_B_RECURSIVE_SPAWN });
  try {
    const { code, out } = run(root);
    expect(code).toBe(1);
    const violations = JSON.parse(out).violations;
    expect(violations.length).toBe(1);
    expect(violations[0].invariant).toBe('no-recursive-spawning');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('warning-only: missing result contract exits 0 with a warning printed', () => {
  const root = makeFixtureRoot({ 'bad-c': BAD_C_NO_RESULT_CONTRACT });
  try {
    const { code, out } = run(root);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.violations.length).toBe(1);
    expect(parsed.violations[0].invariant).toBe('result-contract');
    expect(parsed.violations[0].severity).toBe('warning');
    expect(parsed.errors).toBe(0);
    expect(parsed.warnings).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('warning-only under --strict: missing result contract exits 1', () => {
  const root = makeFixtureRoot({ 'bad-c': BAD_C_NO_RESULT_CONTRACT });
  try {
    const { code, out } = run(root, ['--strict']);
    expect(code).toBe(1);
    const parsed = JSON.parse(out);
    expect(parsed.violations.length).toBe(1);
    expect(parsed.violations[0].severity).toBe('warning');
    expect(parsed.strict).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('true positive: --agent reference with no matching spawns directory', () => {
  const root = makeFixtureRoot({ 'bad-d': BAD_D_UNRESOLVED_AGENT });
  try {
    const { code, out } = run(root);
    expect(code).toBe(1);
    const violations = JSON.parse(out).violations;
    expect(violations.length).toBe(1);
    expect(violations[0].invariant).toBe('agent-name-resolution');
    expect(violations[0].detail).toMatch(/ghost-worker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mixed errors and warnings: errors alone drive exit 1, --strict counts warnings too', () => {
  const root = makeFixtureRoot({ 'bad-a': BAD_A_SELF_TERMINATE, 'bad-c': BAD_C_NO_RESULT_CONTRACT });
  try {
    const plain = run(root);
    expect(plain.code).toBe(1);
    const plainParsed = JSON.parse(plain.out);
    expect(plainParsed.errors).toBe(1);
    expect(plainParsed.warnings).toBe(1);

    const strict = run(root, ['--strict']);
    expect(strict.code).toBe(1);
    const strictParsed = JSON.parse(strict.out);
    expect(strictParsed.errors).toBe(1);
    expect(strictParsed.warnings).toBe(1);
    expect(strictParsed.strict).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a real spawns/<name> reference resolves cleanly (no false positive)', () => {
  const referencing = `# Referencer

You are a focused **referencer worker**, summoned by an Advisor.

## Result

Send a \`result\` message via channel.js to your outbox.

Delegate deep work via \`bin/summon --agent helper\`.

## After sending result — self-terminate

Immediately run \`bash "$ADV/bin/close-tab"\` as your final action.
`;
  const root = makeFixtureRoot({ referencer: referencing, helper: GOOD });
  try {
    const { code, out } = run(root);
    expect(code).toBe(0);
    expect(JSON.parse(out).violations).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
