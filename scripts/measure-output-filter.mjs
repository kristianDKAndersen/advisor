#!/usr/bin/env bun
/**
 * scripts/measure-output-filter.mjs
 *
 * Measures lib/output-filter.js against lib/compactor.js defaultSummarize on
 * REAL bun test failure output. Prints a markdown report to stdout.
 *
 * Usage: bun scripts/measure-output-filter.mjs [--write-report]
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..');

const require = createRequire(import.meta.url);
const { filter } = require('../lib/output-filter.js');

// ── 1. Create a deliberately failing test ─────────────────────────────────────
//
// We generate enough test output to make the signal-preservation contrast
// visible: many passing tests produce "noise" lines; the one failing test
// produces a clear assertion line that must survive filter().

const tempTest = join(repoRoot, '__measure_failing_temp__.test.js');
writeFileSync(tempTest, `import { test, expect, describe } from 'bun:test';

describe('data-pipeline smoke suite', () => {
  // Passing tests — produce noise lines that test output-filter folding
  ${Array.from({ length: 20 }, (_, i) =>
    `test('processes batch ${i}', () => { expect(${i * 3}).toBe(${i * 3}); });`
  ).join('\n  ')}

  // THE critical failure — assertion line must survive filter() verbatim
  test('validates final output count', () => {
    const actual = 42;
    expect(actual).toBe(100); // intentional: 42 !== 100
  });

  ${Array.from({ length: 10 }, (_, i) =>
    `test('cleanup step ${i}', () => { expect(true).toBe(true); });`
  ).join('\n  ')}
});
`);

// ── 2. Capture real bun test output ──────────────────────────────────────────

let rawOutput = '';
try {
  rawOutput = execSync(`bun test ${tempTest}`, {
    encoding: 'utf8',
    cwd: repoRoot,
    stdio: 'pipe',
  });
} catch (err) {
  rawOutput = (err.stdout || '') + (err.stderr || '');
}

// Cleanup temp file
if (existsSync(tempTest)) unlinkSync(tempTest);

if (!rawOutput.trim()) {
  console.error('ERROR: bun test produced no output — cannot measure');
  process.exit(1);
}

// ── 3. Apply filter() ─────────────────────────────────────────────────────────

const filtered = filter(rawOutput, { lineBudget: 80, minBytes: 0 });

// ── 4. Apply compactor defaultSummarize (200-char-per-message truncation) ────
//
// Mirrors the unexported defaultSummarize in lib/compactor.js:
//   m.content.slice(0, 200)
// Applied to a single synthetic message wrapping the entire raw output.

const compactorOutput = rawOutput.slice(0, 200);

// ── 5. Token estimates (chars/4, stated estimator) ────────────────────────────

const tokEst = s => Math.ceil(s.length / 4);
const rawTokens      = tokEst(rawOutput);
const filteredTokens = tokEst(filtered.summary);
const compactorTokens = tokEst(compactorOutput);

// ── 6. Signal-preservation check ─────────────────────────────────────────────
//
// Find the assertion/error lines in the raw output, then check whether each
// output format preserves them verbatim.

const assertionLines = rawOutput
  .split('\n')
  .filter(l => /expect\(received\)\.toBe\(expected\)|Expected:|Received:|error:/i.test(l) && l.trim().length > 0);

const filteredPreservesAll = assertionLines.length > 0 &&
  assertionLines.every(l => filtered.summary.includes(l.trim()));

const compactorPreservesAll = assertionLines.length > 0 &&
  assertionLines.every(l => compactorOutput.includes(l.trim()));

const signalVerdict = filteredPreservesAll ? 'PASS' : 'FAIL';
const compactorVerdict = compactorPreservesAll ? 'PASS (preserves)' : 'FAIL (lost/degraded)';

// ── 7. Build report ───────────────────────────────────────────────────────────

const assertionSample = assertionLines.slice(0, 3).map(l => `> \`${l.trim()}\``).join('\n');

const report = `# output-filter measurement report

**Date:** ${new Date().toISOString().slice(0, 10)}
**Method:** real \`bun test\` run on a deliberately-failing temp test; token estimate = chars/4.

## Input

Captured \`bun test\` stdout+stderr on a 31-test suite with 1 intentional assertion failure
(\`expect(42).toBe(100)\`). This is real runner output, not synthetic.

## Token counts

| Representation | Chars | Tokens (chars/4) | Lines kept |
|----------------|------:|------------------:|------------|
| Raw output     | ${rawOutput.length} | ${rawTokens} | ${filtered.stats.rawLines} raw |
| \`filter()\` output | ${filtered.summary.length} | ${filteredTokens} | ${filtered.stats.keptLines} / ${filtered.stats.rawLines} |
| compactor \`defaultSummarize\` (200-char slice) | ${compactorOutput.length} | ${compactorTokens} | first 200 chars only |

## Assertion lines detected in raw output

${assertionSample || '_(none detected — re-examine raw output)_'}

## Signal-preservation verdict

| Filter | Assertion line survives verbatim? | Verdict |
|--------|------------------------------------|---------|
| \`filter()\` (lineBudget=80) | ${filteredPreservesAll ? 'YES' : 'NO'} | **${signalVerdict}** |
| compactor \`defaultSummarize\` | ${compactorPreservesAll ? 'YES — within first 200 chars' : 'NO — truncated before error appears'} | **${compactorVerdict}** |

${signalVerdict === 'PASS'
  ? '**Signal-preservation: PASS** — the failing assertion/error line survives verbatim in `filter()` output.'
  : '**Signal-preservation: FAIL** — `filter()` dropped the assertion line (unexpected).'
}

${compactorPreservesAll
  ? '> Note: compactor happened to preserve the assertion because the error appeared within the first 200 chars of this short test run. In longer real-world output (multi-file test suites, build logs), the error would be buried past the 200-char cutoff.'
  : '> The compactor\'s 200-char truncation discards the assertion line entirely, confirming the motivation for output-filter.'
}

## filter() stats

- rawBytes: ${filtered.stats.rawBytes}
- rawLines: ${filtered.stats.rawLines}
- keptLines: ${filtered.stats.keptLines}
- droppedLines: ${filtered.stats.droppedLines}

## Raw output (for reference)

\`\`\`
${rawOutput.trimEnd()}
\`\`\`

## filter() output

\`\`\`
${filtered.summary.trimEnd()}
\`\`\`

## compactor output (first 200 chars)

\`\`\`
${compactorOutput}
\`\`\`
`;

const writeReport = process.argv.includes('--write-report');
if (writeReport) {
  const outPath = join(repoRoot, 'deliverables', 'measurement.md');
  writeFileSync(outPath, report);
  console.log(`Report written to ${outPath}`);
} else {
  process.stdout.write(report);
}
