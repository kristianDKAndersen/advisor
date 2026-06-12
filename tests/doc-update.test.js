import { test, expect, describe } from 'bun:test';

import { inferAffectedDirs, generateAgentsMdUpdate } from '../lib/doc-update.js';

const REPO_ROOT = '/repo';

// Representative synthesis-queue record (shape per doc-agent-design.md, Q2).
const synthRecord = {
  sid: '1781300677-a8c0ba',
  seq: 3,
  ts: '2026-06-12T14:30:00Z',
  established:
    'The synthesize flow appends a doc-queue entry after writeSynthesisNote; the queue entry carries sid, seq, established, and modified_files.',
  material: 'lib/channel.js synthesize flow',
  modified_files: ['lib/channel.js', 'lib/hooks/worker-trace.js'],
};

// Minimal frontmatter parser: leading --- fence, key: value lines, closing ---.
// Returns null when the document does not open with a frontmatter block.
function parseFrontmatter(content) {
  const m = String(content).match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].replace(/^["']/, '').replace(/["']$/, '');
  }
  return { fields, body: String(content).slice(m[0].length) };
}

function sorted(value) {
  return [...value].sort();
}

const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// ---------------------------------------------------------------------------
// inferAffectedDirs — happy paths
// ---------------------------------------------------------------------------

describe('inferAffectedDirs — happy paths', () => {
  test('returns an array', () => {
    expect(Array.isArray(inferAffectedDirs(['lib/a.js'], REPO_ROOT))).toBe(true);
  });

  test('single nested file maps to its full dir chain up to repo root (inclusive)', () => {
    const dirs = inferAffectedDirs(['lib/hooks/worker-trace.js'], REPO_ROOT);
    expect(sorted(dirs)).toEqual(['/repo', '/repo/lib', '/repo/lib/hooks']);
  });

  test('deeply nested file yields every ancestor directory', () => {
    const dirs = inferAffectedDirs(['a/b/c/d/e.js'], REPO_ROOT);
    expect(sorted(dirs)).toEqual([
      '/repo',
      '/repo/a',
      '/repo/a/b',
      '/repo/a/b/c',
      '/repo/a/b/c/d',
    ]);
  });

  test('two files in the same directory produce the chain exactly once', () => {
    const dirs = inferAffectedDirs(['lib/a.js', 'lib/b.js'], REPO_ROOT);
    expect(sorted(dirs)).toEqual(['/repo', '/repo/lib']);
  });

  test('multiple files dedupe shared parent directories', () => {
    const dirs = inferAffectedDirs(
      ['lib/a.js', 'lib/hooks/b.js', 'bin/c.sh'],
      REPO_ROOT,
    );
    expect(sorted(dirs)).toEqual([
      '/repo',
      '/repo/bin',
      '/repo/lib',
      '/repo/lib/hooks',
    ]);
  });

  test('result contains no duplicate entries', () => {
    const dirs = inferAffectedDirs(
      ['lib/a.js', 'lib/hooks/b.js', 'lib/hooks/c.js'],
      REPO_ROOT,
    );
    expect(new Set(dirs).size).toBe(dirs.length);
  });
});

// ---------------------------------------------------------------------------
// inferAffectedDirs — edge cases
// ---------------------------------------------------------------------------

describe('inferAffectedDirs — edge cases', () => {
  test('empty input returns an empty array', () => {
    const dirs = inferAffectedDirs([], REPO_ROOT);
    expect(Array.isArray(dirs)).toBe(true);
    expect(dirs.length).toBe(0);
  });

  test('file at repo root maps to the root directory only', () => {
    const dirs = inferAffectedDirs(['README.md'], REPO_ROOT);
    expect(sorted(dirs)).toEqual(['/repo']);
  });

  test('mixed root-level and nested files', () => {
    const dirs = inferAffectedDirs(['README.md', 'lib/a.js'], REPO_ROOT);
    expect(sorted(dirs)).toEqual(['/repo', '/repo/lib']);
  });

  test('duplicate input paths are deduplicated', () => {
    const dirs = inferAffectedDirs(['lib/a.js', 'lib/a.js'], REPO_ROOT);
    expect(sorted(dirs)).toEqual(['/repo', '/repo/lib']);
  });

  test('"./"-prefixed repo-relative paths normalize to the same chain', () => {
    const dirs = inferAffectedDirs(['./lib/a.js'], REPO_ROOT);
    expect(sorted(dirs)).toEqual(['/repo', '/repo/lib']);
  });

  test('trailing slash on repoRoot does not produce double slashes', () => {
    const dirs = inferAffectedDirs(['lib/a.js'], '/repo/');
    expect(sorted(dirs)).toEqual(['/repo', '/repo/lib']);
    for (const d of dirs) {
      expect(d).not.toContain('//');
    }
  });
});

// ---------------------------------------------------------------------------
// generateAgentsMdUpdate — happy paths (frontmatter contract)
// ---------------------------------------------------------------------------

describe('generateAgentsMdUpdate — frontmatter contract', () => {
  test('returns a string', () => {
    expect(typeof generateAgentsMdUpdate('lib/hooks', synthRecord, '')).toBe('string');
  });

  test('output opens with a YAML frontmatter block', () => {
    const out = generateAgentsMdUpdate('lib/hooks', synthRecord, '');
    expect(out.startsWith('---\n')).toBe(true);
    expect(parseFrontmatter(out)).not.toBeNull();
  });

  test('frontmatter has all three required fields, each non-empty', () => {
    const { fields } = parseFrontmatter(
      generateAgentsMdUpdate('lib/hooks', synthRecord, ''),
    );
    for (const key of ['scope', 'last_updated_by', 'last_updated_ts']) {
      expect(fields[key]).toBeDefined();
      expect(fields[key].length).toBeGreaterThan(0);
    }
  });

  test('last_updated_by is formatted "sid:<sid> seq:<seq>"', () => {
    const { fields } = parseFrontmatter(
      generateAgentsMdUpdate('lib/hooks', synthRecord, ''),
    );
    expect(fields.last_updated_by).toBe('sid:1781300677-a8c0ba seq:3');
  });

  test('last_updated_by tracks the record passed in (not hardcoded)', () => {
    const rec = { ...synthRecord, sid: 'abc-123', seq: 12 };
    const { fields } = parseFrontmatter(generateAgentsMdUpdate('lib', rec, ''));
    expect(fields.last_updated_by).toBe('sid:abc-123 seq:12');
  });

  test('last_updated_ts is ISO 8601 UTC and parses to a valid date', () => {
    const { fields } = parseFrontmatter(
      generateAgentsMdUpdate('lib/hooks', synthRecord, ''),
    );
    expect(fields.last_updated_ts).toMatch(ISO_8601_UTC);
    expect(Number.isNaN(Date.parse(fields.last_updated_ts))).toBe(false);
  });

  test('scope references the directory being documented', () => {
    const { fields } = parseFrontmatter(
      generateAgentsMdUpdate('lib/hooks', synthRecord, ''),
    );
    expect(fields.scope).toContain('lib/hooks');
  });
});

// ---------------------------------------------------------------------------
// generateAgentsMdUpdate — body grounding
// ---------------------------------------------------------------------------

describe('generateAgentsMdUpdate — body grounded in synthRecord.established', () => {
  test('body contains the established text', () => {
    const out = generateAgentsMdUpdate('lib/hooks', synthRecord, '');
    const { body } = parseFrontmatter(out);
    expect(body).toContain(synthRecord.established);
  });

  test('body is non-empty prose, not just the frontmatter', () => {
    const { body } = parseFrontmatter(
      generateAgentsMdUpdate('lib/hooks', synthRecord, ''),
    );
    expect(body.trim().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// generateAgentsMdUpdate — liveness rule (regression: replace, never append)
// ---------------------------------------------------------------------------

describe('generateAgentsMdUpdate — liveness rule (replaces stale content)', () => {
  const STALE_MARKER = 'LEGACY-NOTE-7f3a9: channel.js has no synthesize side effects';
  const staleExisting = [
    '---',
    'scope: "lib/hooks — outdated description"',
    'last_updated_by: "sid:old-sid-0000 seq:1"',
    'last_updated_ts: "2025-01-01T00:00:00Z"',
    '---',
    '',
    STALE_MARKER,
    '',
  ].join('\n');

  test('stale body text is removed, not retained (dox liveness rule)', () => {
    const out = generateAgentsMdUpdate('lib/hooks', synthRecord, staleExisting);
    expect(out).not.toContain(STALE_MARKER);
  });

  test('stale provenance is replaced with the new sid/seq', () => {
    const out = generateAgentsMdUpdate('lib/hooks', synthRecord, staleExisting);
    expect(out).not.toContain('old-sid-0000');
    const { fields } = parseFrontmatter(out);
    expect(fields.last_updated_by).toBe('sid:1781300677-a8c0ba seq:3');
  });

  test('output has exactly one frontmatter block (no appended document)', () => {
    const out = generateAgentsMdUpdate('lib/hooks', synthRecord, staleExisting);
    const fenceLines = out.split('\n').filter((line) => line === '---');
    expect(fenceLines.length).toBe(2);
  });

  test('re-running on its own output keeps a single frontmatter block and updates provenance', () => {
    const first = generateAgentsMdUpdate('lib/hooks', synthRecord, staleExisting);
    const nextRecord = { ...synthRecord, sid: 'next-sid-1111', seq: 4 };
    const second = generateAgentsMdUpdate('lib/hooks', nextRecord, first);
    const fenceLines = second.split('\n').filter((line) => line === '---');
    expect(fenceLines.length).toBe(2);
    const { fields } = parseFrontmatter(second);
    expect(fields.last_updated_by).toBe('sid:next-sid-1111 seq:4');
  });
});

// ---------------------------------------------------------------------------
// generateAgentsMdUpdate — edge cases
// ---------------------------------------------------------------------------

describe('generateAgentsMdUpdate — missing/empty existing content', () => {
  for (const [label, existing] of [
    ['empty string', ''],
    ['undefined', undefined],
    ['null', null],
  ]) {
    test(`${label} existingContent yields a fresh, valid document`, () => {
      const out = generateAgentsMdUpdate('lib/hooks', synthRecord, existing);
      const parsed = parseFrontmatter(out);
      expect(parsed).not.toBeNull();
      expect(parsed.fields.last_updated_by).toBe('sid:1781300677-a8c0ba seq:3');
      expect(parsed.body).toContain(synthRecord.established);
    });
  }
});

describe('generateAgentsMdUpdate — 4000-token length cap', () => {
  // Cap heuristic: 4 chars per token, so 4000 tokens = 16000 chars.
  const CAP_CHARS = 16000;

  test('normal input stays under the cap', () => {
    const out = generateAgentsMdUpdate('lib/hooks', synthRecord, '');
    expect(out.length).toBeLessThanOrEqual(CAP_CHARS);
  });

  test('oversized established input is capped at 4000 tokens (~16000 chars)', () => {
    const huge = {
      ...synthRecord,
      established: 'established-fact '.repeat(5000), // ~85k chars
    };
    const out = generateAgentsMdUpdate('lib/hooks', huge, '');
    expect(out.length).toBeLessThanOrEqual(CAP_CHARS);
  });

  test('capped output still opens with valid frontmatter', () => {
    const huge = {
      ...synthRecord,
      established: 'established-fact '.repeat(5000),
    };
    const parsed = parseFrontmatter(generateAgentsMdUpdate('lib/hooks', huge, ''));
    expect(parsed).not.toBeNull();
    expect(parsed.fields.last_updated_by).toBe('sid:1781300677-a8c0ba seq:3');
  });
});

// ---------------------------------------------------------------------------
// Integration — full pipeline from queue record to generated docs
// ---------------------------------------------------------------------------

describe('integration — queue record through both functions', () => {
  test('inferAffectedDirs output feeds generateAgentsMdUpdate for every affected dir', () => {
    const dirs = inferAffectedDirs(synthRecord.modified_files, REPO_ROOT);
    expect(sorted(dirs)).toEqual(['/repo', '/repo/lib', '/repo/lib/hooks']);
    for (const dir of dirs) {
      const out = generateAgentsMdUpdate(dir, synthRecord, '');
      const parsed = parseFrontmatter(out);
      expect(parsed).not.toBeNull();
      expect(parsed.fields.last_updated_by).toBe('sid:1781300677-a8c0ba seq:3');
      expect(parsed.fields.last_updated_ts).toMatch(ISO_8601_UTC);
      expect(parsed.body).toContain(synthRecord.established);
    }
  });

  test('module exports both functions as named exports (dynamic relative import)', async () => {
    const mod = await import('../lib/doc-update.js');
    expect(typeof mod.inferAffectedDirs).toBe('function');
    expect(typeof mod.generateAgentsMdUpdate).toBe('function');
  });
});
