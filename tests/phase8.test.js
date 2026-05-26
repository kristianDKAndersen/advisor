// Phase 8 tests: P8a (threshold 0.97 default), P8b (top-K pruning + union rule), P8c (dry-run histogram)
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeTmpVault(suffix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vault-${suffix}-`));
  for (const sub of ['synthesis', 'sessions', 'lessons', 'projects', '.cache']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

// Mock pipeline:
//   alpha=[1,0,0,0]
//   p8a-low=[0.86,0.51,0,0]  cosine(alpha,p8a-low)≈0.860  (>0.75, <0.97)
//   p8b-center=[1,0,0,0]
//   p8b-nb=[0.99,0.141,0,0]  cosine(center,nb)≈0.990  (>0.97)
//   p8b-nc=[0.985,0,0.172,0] cosine(center,nc)≈0.985  (>0.97); cosine(nb,nc)≈0.975 (>0.97)
function mockFactory() {
  return async (_text) => {
    if (_text.includes('alpha-content'))        return { data: new Float32Array([1, 0, 0, 0]) };
    if (_text.includes('p8a-low-content'))      return { data: new Float32Array([0.86, 0.51, 0, 0]) };
    if (_text.includes('p8b-center-content'))   return { data: new Float32Array([1, 0, 0, 0]) };
    if (_text.includes('p8b-nb-content'))       return { data: new Float32Array([0.99, 0.141, 0, 0]) };
    if (_text.includes('p8b-nc-content'))       return { data: new Float32Array([0.985, 0, 0.172, 0]) };
    return { data: new Float32Array([0.5, 0.5, 0, 0]) };
  };
}

// ============================================================================
// P8a — Default threshold changed from 0.75 → 0.97
// ============================================================================

describe('P8a — default threshold 0.97', () => {
  let vaultDir;
  let v;

  beforeAll(async () => {
    vaultDir = makeTmpVault('p8a');
    process.env.ADVISOR_VAULT = vaultDir;
    v = await import('../lib/vault.js');
    for (const [p, body] of [
      ['synthesis/p8a-alpha.md', 'alpha-content for P8a'],
      ['synthesis/p8a-low.md',   'p8a-low-content here'],
    ]) {
      fs.writeFileSync(path.join(vaultDir, p), `---\ntype: synthesis\nsid: 1779000010-p8a000\nseq: 1\n---\n\n${body}`);
    }
    v.rebuildIndex();
  });

  afterAll(() => {
    try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('[P8a] default threshold is 0.97 — cosine≈0.86 pair does NOT produce edge', async () => {
    process.env.ADVISOR_VAULT = vaultDir;
    // Call with no explicit threshold — must use 0.97 default
    const result = await v.embedNotes({ _pipelineFactory: mockFactory });
    expect(result.semantic_links_added).toBe(0);
  });

  test('[P8a] explicit threshold=0.75 — cosine≈0.86 pair DOES produce edge', async () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const dbFile = path.join(vaultDir, '.cache/vault.db');
    const db = new Database(dbFile);
    db.exec(`DELETE FROM links WHERE kind='semantic'`);
    db.close();
    const result = await v.embedNotes({ threshold: 0.75, _pipelineFactory: mockFactory });
    expect(result.semantic_links_added).toBe(1);
  });
});

// ============================================================================
// P8b — Top-K neighbor pruning + union rule
// ============================================================================

describe('P8b — top-K pruning + union rule', () => {
  let vaultDir;
  let v;

  beforeAll(async () => {
    vaultDir = makeTmpVault('p8b');
    process.env.ADVISOR_VAULT = vaultDir;
    v = await import('../lib/vault.js');
    // center↔nb≈0.990, center↔nc≈0.985, nb↔nc≈0.975; all three pairs exceed 0.97
    for (const [p, body] of [
      ['synthesis/p8b-center.md', 'p8b-center-content here'],
      ['synthesis/p8b-nb.md',     'p8b-nb-content here'],
      ['synthesis/p8b-nc.md',     'p8b-nc-content here'],
    ]) {
      fs.writeFileSync(path.join(vaultDir, p), `---\ntype: synthesis\nsid: 1779000020-p8b000\nseq: 1\n---\n\n${body}`);
    }
    v.rebuildIndex();
  });

  afterAll(() => {
    try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch (_) {}
  });

  function clearSemantic(vaultDir) {
    const db = new Database(path.join(vaultDir, '.cache/vault.db'));
    db.exec(`DELETE FROM links WHERE kind='semantic'`);
    db.close();
  }

  test('[P8b] topK=0 (unlimited) — all 3 pairs above threshold produce edges', async () => {
    process.env.ADVISOR_VAULT = vaultDir;
    clearSemantic(vaultDir);
    const result = await v.embedNotes({ threshold: 0.97, topK: 0, _pipelineFactory: mockFactory });
    expect(result.semantic_links_added).toBe(3);
  });

  test('[P8b] topK=1 — union rule keeps 2 edges (center-nb + center-nc; nb-nc dropped)', async () => {
    process.env.ADVISOR_VAULT = vaultDir;
    clearSemantic(vaultDir);
    // center nominates nb (highest cosine 0.990).
    // nc nominates center (nc's best neighbor). Union → center-nc edge exists.
    // nb nominates center; nc nominates center. Neither nominates nb↔nc. No nb-nc edge.
    const result = await v.embedNotes({ threshold: 0.97, topK: 1, _pipelineFactory: mockFactory });
    expect(result.semantic_links_added).toBe(2);
  });

  test('[P8b] topK=2 — all 3 edges (each note has ≤2 neighbors above threshold)', async () => {
    process.env.ADVISOR_VAULT = vaultDir;
    clearSemantic(vaultDir);
    const result = await v.embedNotes({ threshold: 0.97, topK: 2, _pipelineFactory: mockFactory });
    expect(result.semantic_links_added).toBe(3);
  });

  test('[P8b] default topK=5 — with 3 notes, same as unlimited (all 3 edges)', async () => {
    process.env.ADVISOR_VAULT = vaultDir;
    clearSemantic(vaultDir);
    // No explicit topK — should use default (5). With 3 notes each has ≤2 eligible neighbors.
    const result = await v.embedNotes({ threshold: 0.97, _pipelineFactory: mockFactory });
    expect(result.semantic_links_added).toBe(3);
  });
});

// ============================================================================
// P8c — Dry-run: histogram + no DB write
// ============================================================================

describe('P8c — dry-run cosine distribution', () => {
  let vaultDir;
  let v;

  beforeAll(async () => {
    vaultDir = makeTmpVault('p8c');
    process.env.ADVISOR_VAULT = vaultDir;
    v = await import('../lib/vault.js');
    for (const [p, body] of [
      ['synthesis/p8c-alpha.md', 'alpha-content for P8c'],
      ['synthesis/p8c-low.md',   'p8a-low-content for P8c'],
    ]) {
      fs.writeFileSync(path.join(vaultDir, p), `---\ntype: synthesis\nsid: 1779000030-p8c000\nseq: 1\n---\n\n${body}`);
    }
    v.rebuildIndex();
    // Pre-embed so dry-run can compute cosines from stored vectors
    await v.embedNotes({ _pipelineFactory: mockFactory });
  });

  afterAll(() => {
    try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('[P8c] dry-run result has dry_run=true and histogram with expected buckets', async () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const result = await v.embedNotes({ threshold: 0.75, dryRun: true, _pipelineFactory: mockFactory });
    expect(result.dry_run).toBe(true);
    expect(result.histogram).toBeDefined();
    // alpha↔p8c-low cosine≈0.86 → falls in '0.8-0.9' bucket
    expect(result.histogram['0.8-0.9']).toBeGreaterThan(0);
    // All six bucket keys must be present
    for (const k of ['0.5-0.6', '0.6-0.7', '0.7-0.8', '0.8-0.9', '0.9-0.95', '0.95-1.0']) {
      expect(typeof result.histogram[k]).toBe('number');
    }
  });

  test('[P8c] dry-run returns edges_would_insert ≥ 1 at threshold=0.75', async () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const result = await v.embedNotes({ threshold: 0.75, dryRun: true, _pipelineFactory: mockFactory });
    expect(typeof result.edges_would_insert).toBe('number');
    expect(result.edges_would_insert).toBeGreaterThanOrEqual(1);
  });

  test('[P8c] dry-run does NOT insert semantic links into DB', async () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const dbFile = path.join(vaultDir, '.cache/vault.db');
    const db1 = new Database(dbFile);
    db1.exec(`DELETE FROM links WHERE kind='semantic'`);
    db1.close();

    await v.embedNotes({ threshold: 0.75, dryRun: true, _pipelineFactory: mockFactory });

    const db2 = new Database(dbFile);
    const edges = db2.prepare(`SELECT * FROM links WHERE kind='semantic'`).all();
    db2.close();
    expect(edges.length).toBe(0);
  });
});
