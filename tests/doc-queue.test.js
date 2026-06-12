// tests/doc-queue.test.js
// TDD: write tests BEFORE lib/doc-queue.js exists — all tests must fail red first.
//
// When run with --doc-queue-worker, acts as a subprocess that calls enqueue or
// markProcessed on behalf of the concurrency test (mirrors session-concurrent.test.js
// pattern).

import { test, expect, describe, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const THIS_FILE = fileURLToPath(import.meta.url);
const DOC_QUEUE_LIB = path.join(REPO, 'lib', 'doc-queue.js');

// ── Worker subprocess mode ────────────────────────────────────────────────
if (process.argv.includes('--doc-queue-worker')) {
  const get = (flag) => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : null;
  };
  process.env.ADVISOR_DOC_QUEUE = get('--queue');
  const q = require(DOC_QUEUE_LIB);
  const action = get('--action');
  if (action === 'enqueue') {
    q.enqueue({ sid: get('--sid'), seq: parseInt(get('--seq'), 10), ts: Date.now() });
  } else if (action === 'mark') {
    q.markProcessed([{ sid: get('--sid'), seq: parseInt(get('--seq'), 10) }]);
  }
  process.exit(0);
}

// ── Helpers ───────────────────────────────────────────────────────────────

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-queue-test-'));
afterAll(() => { fs.rmSync(tmpBase, { recursive: true, force: true }); });

let _counter = 0;

// Returns a fresh { enqueue, dequeueUnprocessed, markProcessed } bound to a
// unique temp queue file. Sets ADVISOR_DOC_QUEUE before loading the module.
function makeQ() {
  const qp = path.join(tmpBase, `q${++_counter}.jsonl`);
  process.env.ADVISOR_DOC_QUEUE = qp;
  // Clear CJS cache so the module re-reads ADVISOR_DOC_QUEUE on next require.
  delete require.cache[DOC_QUEUE_LIB];
  return { ...require(DOC_QUEUE_LIB), qp };
}

// ── enqueue — append behavior ─────────────────────────────────────────────

describe('enqueue — append behavior', () => {
  test('creates the queue file on first call', () => {
    const { enqueue, qp } = makeQ();
    expect(fs.existsSync(qp)).toBe(false);
    enqueue({ sid: 'a', seq: 1 });
    expect(fs.existsSync(qp)).toBe(true);
  });

  test('appended entry can be read back as valid JSON', () => {
    const { enqueue, qp } = makeQ();
    enqueue({ sid: 'a', seq: 1, ts: 1000 });
    const line = fs.readFileSync(qp, 'utf8').trim();
    const entry = JSON.parse(line);
    expect(entry.sid).toBe('a');
    expect(entry.seq).toBe(1);
  });

  test('each call appends a separate line', () => {
    const { enqueue, qp } = makeQ();
    enqueue({ sid: 'a', seq: 1 });
    enqueue({ sid: 'b', seq: 2 });
    enqueue({ sid: 'c', seq: 3 });
    const lines = fs.readFileSync(qp, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(3);
  });

  test('multiple enqueues preserve order and content', () => {
    const { enqueue, qp } = makeQ();
    const entries = [
      { sid: 'x', seq: 1, ts: 1 },
      { sid: 'y', seq: 2, ts: 2 },
      { sid: 'z', seq: 3, ts: 3 },
    ];
    for (const e of entries) enqueue(e);
    const lines = fs.readFileSync(qp, 'utf8').trim().split('\n').filter(Boolean);
    expect(JSON.parse(lines[0]).sid).toBe('x');
    expect(JSON.parse(lines[1]).sid).toBe('y');
    expect(JSON.parse(lines[2]).sid).toBe('z');
  });
});

// ── dequeueUnprocessed — filtering ────────────────────────────────────────

describe('dequeueUnprocessed — filtering', () => {
  test('returns empty array when queue file does not exist', () => {
    const { dequeueUnprocessed, qp } = makeQ();
    expect(fs.existsSync(qp)).toBe(false);
    expect(dequeueUnprocessed()).toEqual([]);
  });

  test('returns all entries when none are processed', () => {
    const { enqueue, dequeueUnprocessed } = makeQ();
    enqueue({ sid: 'a', seq: 1 });
    enqueue({ sid: 'b', seq: 2 });
    const result = dequeueUnprocessed();
    expect(result.length).toBe(2);
  });

  test('filters out entries with processed:true', () => {
    const { enqueue, dequeueUnprocessed, markProcessed } = makeQ();
    enqueue({ sid: 'a', seq: 1 });
    enqueue({ sid: 'b', seq: 2 });
    enqueue({ sid: 'c', seq: 3 });
    markProcessed([{ sid: 'a', seq: 1 }]);
    const result = dequeueUnprocessed();
    expect(result.length).toBe(2);
    expect(result.some(e => e.sid === 'a')).toBe(false);
    expect(result.some(e => e.sid === 'b')).toBe(true);
    expect(result.some(e => e.sid === 'c')).toBe(true);
  });

  test('returns objects with expected fields (sid, seq)', () => {
    const { enqueue, dequeueUnprocessed } = makeQ();
    enqueue({ sid: 'alpha', seq: 7, ts: 999, modified_files: ['a.js'] });
    const [entry] = dequeueUnprocessed();
    expect(entry.sid).toBe('alpha');
    expect(entry.seq).toBe(7);
    expect(entry.modified_files).toEqual(['a.js']);
  });

  test('returns empty array after all entries are processed', () => {
    const { enqueue, dequeueUnprocessed, markProcessed } = makeQ();
    enqueue({ sid: 'a', seq: 1 });
    enqueue({ sid: 'b', seq: 2 });
    markProcessed([{ sid: 'a', seq: 1 }, { sid: 'b', seq: 2 }]);
    expect(dequeueUnprocessed()).toEqual([]);
  });
});

// ── markProcessed — persistence ───────────────────────────────────────────

describe('markProcessed — persistence', () => {
  test('sets processed:true on the matching entry', () => {
    const { enqueue, markProcessed, qp } = makeQ();
    enqueue({ sid: 'a', seq: 1 });
    markProcessed([{ sid: 'a', seq: 1 }]);
    const line = fs.readFileSync(qp, 'utf8').trim().split('\n').filter(Boolean)[0];
    expect(JSON.parse(line).processed).toBe(true);
  });

  test('does not affect entries with different sid:seq', () => {
    const { enqueue, markProcessed, qp } = makeQ();
    enqueue({ sid: 'a', seq: 1 });
    enqueue({ sid: 'b', seq: 2 });
    markProcessed([{ sid: 'a', seq: 1 }]);
    const lines = fs.readFileSync(qp, 'utf8').trim().split('\n').filter(Boolean);
    expect(JSON.parse(lines[1]).processed).toBeFalsy();
  });

  test('can mark multiple entries in one call', () => {
    const { enqueue, markProcessed, dequeueUnprocessed } = makeQ();
    enqueue({ sid: 'a', seq: 1 });
    enqueue({ sid: 'b', seq: 2 });
    enqueue({ sid: 'c', seq: 3 });
    markProcessed([{ sid: 'a', seq: 1 }, { sid: 'c', seq: 3 }]);
    const unprocessed = dequeueUnprocessed();
    expect(unprocessed.length).toBe(1);
    expect(unprocessed[0].sid).toBe('b');
  });

  test('is idempotent: marking already-processed entry does not corrupt file', () => {
    const { enqueue, markProcessed, dequeueUnprocessed } = makeQ();
    enqueue({ sid: 'a', seq: 1 });
    markProcessed([{ sid: 'a', seq: 1 }]);
    markProcessed([{ sid: 'a', seq: 1 }]); // second call
    expect(dequeueUnprocessed()).toEqual([]);
  });

  test('no-ops gracefully when keys array is empty', () => {
    const { enqueue, markProcessed, dequeueUnprocessed } = makeQ();
    enqueue({ sid: 'a', seq: 1 });
    markProcessed([]);
    expect(dequeueUnprocessed().length).toBe(1);
  });

  test('no-ops gracefully when called with null', () => {
    const { enqueue, markProcessed, dequeueUnprocessed } = makeQ();
    enqueue({ sid: 'a', seq: 1 });
    markProcessed(null);
    expect(dequeueUnprocessed().length).toBe(1);
  });
});

// ── ADVISOR_DOC_QUEUE override ────────────────────────────────────────────

describe('ADVISOR_DOC_QUEUE env override', () => {
  test('writes to the path specified by ADVISOR_DOC_QUEUE', () => {
    const { enqueue, qp } = makeQ();
    enqueue({ sid: 'env', seq: 1 });
    expect(fs.existsSync(qp)).toBe(true);
    const line = fs.readFileSync(qp, 'utf8').trim();
    expect(JSON.parse(line).sid).toBe('env');
  });

  test('does not write to default ~/.advisor/doc-queue.jsonl when override is set', () => {
    const { enqueue, qp } = makeQ();
    enqueue({ sid: 'override', seq: 1 });
    const defaultPath = path.join(os.homedir(), '.advisor', 'doc-queue.jsonl');
    if (fs.existsSync(defaultPath)) {
      const content = fs.readFileSync(defaultPath, 'utf8');
      // The default file should not contain our unique test sid
      expect(content).not.toContain('override-unique-test-sid-' + qp);
    }
  });
});

// ── Concurrency: enqueue during markProcessed is not lost ─────────────────

describe('concurrency', () => {
  test('enqueue that arrives concurrently with markProcessed is not lost', async () => {
    const qp = path.join(tmpBase, `concurrency-${Date.now()}.jsonl`);
    process.env.ADVISOR_DOC_QUEUE = qp;
    delete require.cache[DOC_QUEUE_LIB];
    const { enqueue } = require(DOC_QUEUE_LIB);

    // Pre-populate: two entries to mark processed
    enqueue({ sid: 'pre', seq: 1, ts: 0 });
    enqueue({ sid: 'pre', seq: 2, ts: 0 });

    // Spawn both operations concurrently: markProcessed(pre:1) and enqueue(concurrent:99)
    const markWorker = Bun.spawn(
      ['bun', THIS_FILE, '--doc-queue-worker',
        '--action', 'mark', '--queue', qp, '--sid', 'pre', '--seq', '1'],
      { stderr: 'pipe' }
    );
    const enqWorker = Bun.spawn(
      ['bun', THIS_FILE, '--doc-queue-worker',
        '--action', 'enqueue', '--queue', qp, '--sid', 'concurrent', '--seq', '99'],
      { stderr: 'pipe' }
    );

    const [markCode, enqCode] = await Promise.all([markWorker.exited, enqWorker.exited]);
    expect(markCode).toBe(0);
    expect(enqCode).toBe(0);

    // Verify: the concurrent enqueue must not be lost
    const content = fs.readFileSync(qp, 'utf8');
    const entries = content.split('\n').filter(Boolean).map(l => JSON.parse(l));

    expect(entries.some(e => e.sid === 'concurrent' && e.seq === 99)).toBe(true);

    // Verify: markProcessed effect is present (pre:1 is processed)
    const processedEntry = entries.find(e => e.sid === 'pre' && e.seq === 1);
    expect(processedEntry).toBeDefined();
    expect(processedEntry.processed).toBe(true);

    // Verify: pre:2 untouched (not in the mark call)
    const untouched = entries.find(e => e.sid === 'pre' && e.seq === 2);
    expect(untouched).toBeDefined();
    expect(untouched.processed).toBeFalsy();
  }, 20000);

  test('N concurrent enqueues all land in the queue (no append is lost)', async () => {
    const qp = path.join(tmpBase, `concurrency-n-${Date.now()}.jsonl`);
    const N = 5;
    const workers = Array.from({ length: N }, (_, i) =>
      Bun.spawn(
        ['bun', THIS_FILE, '--doc-queue-worker',
          '--action', 'enqueue', '--queue', qp, '--sid', `w${i}`, '--seq', String(i)],
        { stderr: 'pipe' }
      )
    );
    const exits = await Promise.all(workers.map(w => w.exited));
    for (const code of exits) expect(code).toBe(0);

    const content = fs.readFileSync(qp, 'utf8');
    const entries = content.split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(entries.length).toBe(N);
    for (let i = 0; i < N; i++) {
      expect(entries.some(e => e.sid === `w${i}`)).toBe(true);
    }
  }, 20000);
});

// ── Module exports ─────────────────────────────────────────────────────────

describe('module exports', () => {
  test('exports enqueue, dequeueUnprocessed, markProcessed as functions', async () => {
    const mod = await import('../lib/doc-queue.js');
    expect(typeof mod.enqueue).toBe('function');
    expect(typeof mod.dequeueUnprocessed).toBe('function');
    expect(typeof mod.markProcessed).toBe('function');
  });
});
