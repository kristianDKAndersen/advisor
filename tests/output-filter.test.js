import { test, expect, describe } from 'bun:test';
import { filter, scoreLine } from '../lib/output-filter.js';

// Helper: build a string of `n` lines each of `lineContent`
function repeatLines(lineContent, n) {
  return Array(n).fill(lineContent).join('\n');
}

// Helper: build a string large enough to exceed minBytes
function bigNoise(n = 300) {
  return Array.from({ length: n }, (_, i) => `  building module ${i}...`).join('\n');
}

// ── Passthrough floor ────────────────────────────────────────────────────────

describe('filter — passthrough below minBytes', () => {
  test('short input returned unchanged', () => {
    const raw = 'hello world\nfoo bar';
    const { summary, stats } = filter(raw, { minBytes: 2048 });
    expect(summary).toBe(raw);
    expect(stats.keptLines).toBe(stats.rawLines);
    expect(stats.droppedLines).toBe(0);
  });

  test('custom minBytes=0 always filters', () => {
    const raw = 'line1\nline2\nline3';
    const { summary, stats } = filter(raw, { minBytes: 0 });
    // With minBytes=0, rawBytes >= 0 always, so filtering runs.
    // Input is tiny so first12+last12 keeps everything.
    expect(stats.rawLines).toBe(3);
  });
});

// ── Line scoring ─────────────────────────────────────────────────────────────

describe('scoreLine', () => {
  test('error keyword = 1.0', () => expect(scoreLine('TypeError: x is undefined')).toBe(1));
  test('FAILED keyword = 1.0', () => expect(scoreLine('  ✗ my test FAILED')).toBe(1));
  test('panic keyword = 1.0', () => expect(scoreLine('panic: runtime error')).toBe(1));
  test('warning = 0.7', () => expect(scoreLine('warning: unused variable')).toBe(0.7));
  test('WARN = 0.7', () => expect(scoreLine('[WARN] something happened')).toBe(0.7));
  test('tests summary = 0.6', () => expect(scoreLine('3 tests passed, 0 skipped')).toBe(0.6));
  test('file:line ref = 0.5', () => expect(scoreLine('compiled src/foo.js:42')).toBe(0.5));
  test('stack at line = 0.8', () => expect(scoreLine('  at src/foo.js:42')).toBe(0.8));
  test('blank line = 0.1', () => expect(scoreLine('')).toBe(0.1));
  test('spinner noise = 0.1', () => expect(scoreLine('.......')).toBe(0.1));
});

// ── Error line survival ───────────────────────────────────────────────────────

describe('filter — error line survives verbatim', () => {
  test('single error line in big noise output is preserved', () => {
    const errorLine = 'Error: Cannot find module ./missing';
    const lines = [
      ...Array(50).fill('  bundling chunk 1...'),
      errorLine,
      ...Array(50).fill('  bundling chunk 2...'),
    ];
    const raw = lines.join('\n');
    const { summary } = filter(raw, { minBytes: 0 });
    expect(summary).toContain(errorLine);
  });

  test('assertion failure line is preserved when surrounded by noise', () => {
    const assertion = 'AssertionError: expected 42 to equal 43';
    const noise = repeatLines('  compiling...', 200);
    const raw = noise + '\n' + assertion + '\n' + noise;
    const { summary } = filter(raw, { minBytes: 0 });
    expect(summary).toContain(assertion);
  });
});

// ── Folding ──────────────────────────────────────────────────────────────────

describe('filter — fold consecutive near-identical low-signal lines', () => {
  test('repeated noise lines produce (xN) marker', () => {
    const line = '  bundling module...';
    const raw = [
      ...Array(20).fill(line),
      'Error: build failed',
    ].join('\n');
    const { summary } = filter(raw, { minBytes: 0 });
    expect(summary).toMatch(/\(x\d+\)/);
    expect(summary).toContain('Error: build failed');
  });

  test('digit-differing lines are folded as near-identical', () => {
    // "building chunk 1..." and "building chunk 2..." normalize to same key
    const lines = Array.from({ length: 10 }, (_, i) => `building chunk ${i}...`);
    const raw = ['starting...', ...lines, 'Error: failed'].join('\n');
    const { summary } = filter(raw, { minBytes: 0 });
    // The 10 similar lines should be folded
    expect(summary).toMatch(/\(x\d+\)/);
  });
});

// ── Elision markers ───────────────────────────────────────────────────────────

describe('filter — elision markers', () => {
  test('dropped sections produce "... [N lines elided] ..." marker', () => {
    // Use alpha-varying lines so digit-normalization does not fold them all into one item.
    // 20 distinct head items, 1 folded noise block, 1 error, 20 distinct tail items = 42 items.
    // first-12 keeps items 0-11; last-12 keeps items 30-41; error keeps item ~21.
    // Items 12-20 and 22-29 have no high-signal score and fall outside first/last 12 → elision.
    const words = ['alpha','beta','gamma','delta','epsilon','zeta','eta','theta','iota','kappa',
                   'lambda','mu','nu','xi','omicron','pi','rho','sigma','tau','upsilon'];
    const head = words.map(w => `building:${w}`);         // 20 distinct low-signal items
    const middle = Array(50).fill('  noise...');           // folds to 1 item
    const tail = words.map(w => `linking:${w}`);           // 20 distinct low-signal items
    const raw = [...head, ...middle, 'Error: something broke', ...tail].join('\n');
    const { summary } = filter(raw, { minBytes: 0, lineBudget: 80 });
    expect(summary).toMatch(/\.\.\. \[\d+ lines elided\] \.\.\./);
    expect(summary).toContain('Error: something broke');
  });
});

// ── Fail-open: garbage / malformed input ──────────────────────────────────────

describe('filter — handles garbage input without throwing', () => {
  test('empty string returns safely', () => {
    expect(() => filter('')).not.toThrow();
    const { summary, stats } = filter('', { minBytes: 0 });
    expect(typeof summary).toBe('string');
    expect(stats.rawLines).toBeGreaterThanOrEqual(1);
  });

  test('null-byte-laden binary string does not throw', () => {
    const binary = '\x00\x01\x02\xff'.repeat(100);
    expect(() => filter(binary)).not.toThrow();
  });

  test('huge ANSI escape sequence noise does not throw', () => {
    const ansi = '\x1b[31m\x1b[0m'.repeat(500);
    expect(() => filter(ansi, { minBytes: 0 })).not.toThrow();
  });

  test('deeply repeated identical lines fold without crash', () => {
    const raw = 'x\n'.repeat(10000);
    const { summary, stats } = filter(raw, { minBytes: 0, lineBudget: 80 });
    expect(summary.split('\n').length).toBeLessThanOrEqual(90); // budget + some markers
    expect(stats.rawLines).toBe(10001); // 10000 'x' lines + trailing empty
  });
});

// ── lineBudget cap ────────────────────────────────────────────────────────────

describe('filter — respects lineBudget', () => {
  test('output line count stays near or under budget', () => {
    // 500 lines of mixed content: errors, warnings, noise
    const lines = Array.from({ length: 500 }, (_, i) => {
      if (i % 50 === 0) return `Error: something at step ${i}`;
      if (i % 30 === 0) return `warning: degraded at step ${i}`;
      return `  processing step ${i}...`;
    });
    const { summary } = filter(lines.join('\n'), { minBytes: 0, lineBudget: 50 });
    const outLines = summary.split('\n').filter(l => !l.startsWith('... [')).length;
    // Allow slight overage for mandatory items (errors always kept)
    expect(outLines).toBeLessThanOrEqual(60);
  });
});

// ── stats shape ───────────────────────────────────────────────────────────────

describe('filter — stats', () => {
  test('rawBytes is byte length not char length', () => {
    const raw = bigNoise(100);
    const { stats } = filter(raw, { minBytes: 0 });
    expect(stats.rawBytes).toBe(Buffer.byteLength(raw, 'utf8'));
  });

  test('keptLines + droppedLines = rawLines for filtered output', () => {
    const raw = bigNoise(200);
    const { stats } = filter(raw, { minBytes: 0 });
    expect(stats.keptLines + stats.droppedLines).toBe(stats.rawLines);
  });
});

// ── Assertion-detail survival (A1 regression) ────────────────────────────────

describe('filter — bun-test assertion-detail lines survive verbatim', () => {
  // Simulates a realistic bun test failure block surrounded by noise
  const failureBlock = [
    ' × validates final output count',
    'error: expect(received).toBe(expected)',
    '',
    'Expected: 9999',
    'Received: 12',
    '',
    '      at Object.<anonymous> (tests/pipeline.test.js:42:18)',
    '      at Module._compile (node:internal/modules/cjs/loader:1364:14)',
  ].join('\n');

  const noiseLines = Array.from({ length: 100 }, (_, i) => `  processing batch ${i}...`).join('\n');
  const raw = noiseLines + '\n' + failureBlock + '\n' + noiseLines;

  test('error: line survives', () => {
    const { summary } = filter(raw, { minBytes: 0 });
    expect(summary).toContain('error: expect(received).toBe(expected)');
  });

  test('Expected: line survives', () => {
    const { summary } = filter(raw, { minBytes: 0 });
    expect(summary).toContain('Expected: 9999');
  });

  test('Received: line survives', () => {
    const { summary } = filter(raw, { minBytes: 0 });
    expect(summary).toContain('Received: 12');
  });

  test('fail marker survives', () => {
    const { summary } = filter(raw, { minBytes: 0 });
    expect(summary).toContain('validates final output count');
  });

  test('stack at line survives', () => {
    const { summary } = filter(raw, { minBytes: 0 });
    expect(summary).toContain('at Object.<anonymous>');
  });
});

// ── Determinism ────────────────────────────────────────────────────────────────

describe('filter — determinism', () => {
  test('identical input produces identical output', () => {
    const raw = bigNoise(300) + '\nError: something failed\n' + bigNoise(100);
    const r1 = filter(raw, { minBytes: 0 });
    const r2 = filter(raw, { minBytes: 0 });
    expect(r1.summary).toBe(r2.summary);
    expect(r1.stats.keptLines).toBe(r2.stats.keptLines);
    expect(r1.stats.droppedLines).toBe(r2.stats.droppedLines);
  });

  test('filter(x) result equals filter(x) result for large real-ish output', () => {
    const lines = Array.from({ length: 500 }, (_, i) => {
      if (i % 40 === 0) return `Error: request #${i} failed at step ${i % 7}`;
      if (i % 25 === 0) return `warning: slow response on attempt ${i}`;
      return `  processing request #${i}...`;
    });
    const raw = lines.join('\n');
    expect(filter(raw).summary).toBe(filter(raw).summary);
  });
});
