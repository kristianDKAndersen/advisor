// Phase 7 tests: P7a (embed + similarity edges), P7b (incremental hash skip), P7c (rebuild --embed)
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

// Deterministic mock pipeline factory:
// Returns fixed 4-dim vectors based on body content keyword.
// alpha ↔ beta vectors are close (cosine ≈ 0.99); gamma and delta are orthogonal to everything.
function mockFactory() {
  return async (_text) => {
    if (_text.includes('alpha-content')) return { data: new Float32Array([1, 0, 0, 0]) };
    if (_text.includes('beta-content'))  return { data: new Float32Array([0.99, 0.14, 0, 0]) };
    if (_text.includes('gamma-content')) return { data: new Float32Array([0, 1, 0, 0]) };
    if (_text.includes('delta-content')) return { data: new Float32Array([0, 0, 1, 0]) };
    return { data: new Float32Array([0.5, 0.5, 0, 0]) };
  };
}

// ============================================================================
// P7a — Local semantic embedding + similarity-edge insertion
// ============================================================================

describe('P7a — semantic embedding + similarity edges', () => {
  let vaultDir;
  let v;

  beforeAll(async () => {
    vaultDir = makeTmpVault('p7a');
    process.env.ADVISOR_VAULT = vaultDir;
    v = await import('../lib/vault.js');

    // 4 fixture notes: alpha+beta have similar vectors (cosine≈0.99 > 0.5 threshold)
    // gamma+delta are orthogonal to everything (cosine=0 < 0.5)
    const notes = [
      { p: 'synthesis/alpha.md', body: 'alpha-content here' },
      { p: 'synthesis/beta.md',  body: 'beta-content here' },
      { p: 'synthesis/gamma.md', body: 'gamma-content here' },
      { p: 'synthesis/delta.md', body: 'delta-content here' },
    ];
    for (const n of notes) {
      fs.writeFileSync(path.join(vaultDir, n.p), `---\ntype: synthesis\nsid: 1779000000-aa0000\nseq: 1\n---\n\n${n.body}`);
    }
    v.rebuildIndex();
  });

  afterAll(() => {
    try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('[P7a] embedNotes returns expected embedded count', async () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const result = await v.embedNotes({ threshold: 0.5, _pipelineFactory: mockFactory });
    expect(result.embedded).toBe(4);
  });

  test('[P7a] exactly 1 semantic edge inserted between the close pair (threshold 0.5)', async () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const dbFile = path.join(vaultDir, '.cache/vault.db');
    const db = new Database(dbFile);
    const edges = db.prepare(`SELECT * FROM links WHERE kind='semantic'`).all();
    db.close();
    expect(edges.length).toBe(1);
    // alpha < beta lexicographically → source=synthesis/alpha.md, target=beta
    expect(edges[0].source).toBe('synthesis/alpha.md');
    expect(edges[0].target).toBe('beta');
    expect(edges[0].confidence).toBe('INFERRED');
  });

  test('[P7a] embeddings table has 4 rows', async () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const dbFile = path.join(vaultDir, '.cache/vault.db');
    const db = new Database(dbFile);
    const rows = db.prepare(`SELECT * FROM embeddings`).all();
    db.close();
    expect(rows.length).toBe(4);
    // Each row has a non-empty content_hash
    for (const r of rows) expect(r.content_hash.length).toBe(64); // SHA-256 hex
  });

  test('[P7a] semantic_links_added is 1', async () => {
    process.env.ADVISOR_VAULT = vaultDir;
    // embedNotes is idempotent: second call skips all embeddings (hash match)
    // but pairwise still runs; the 1 edge already exists (semantic) so skipped_existing goes up
    const result2 = await v.embedNotes({ threshold: 0.5, _pipelineFactory: mockFactory });
    expect(result2.semantic_links_skipped_existing).toBeGreaterThanOrEqual(1);
    expect(result2.semantic_links_added).toBe(0);
  });
});

// ============================================================================
// P7b — Incremental embed via content_hash
// ============================================================================

describe('P7b — incremental hash skip', () => {
  let vaultDir;
  let v;
  let firstResult;

  beforeAll(async () => {
    vaultDir = makeTmpVault('p7b');
    process.env.ADVISOR_VAULT = vaultDir;
    v = await import('../lib/vault.js');

    const notes = [
      { p: 'synthesis/nb-a.md', body: 'alpha-content first run' },
      { p: 'synthesis/nb-b.md', body: 'gamma-content first run' },
    ];
    for (const n of notes) {
      fs.writeFileSync(path.join(vaultDir, n.p), `---\ntype: synthesis\nsid: 1779000001-bb0000\nseq: 1\n---\n\n${n.body}`);
    }
    v.rebuildIndex();
    // First run — embeds all notes
    firstResult = await v.embedNotes({ threshold: 0.5, _pipelineFactory: mockFactory });
  });

  afterAll(() => {
    try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('[P7b] first run embeds all notes', () => {
    expect(firstResult.embedded).toBe(2);
    expect(firstResult.skipped_hash).toBe(0);
  });

  test('[P7b] second run skips all (hash unchanged)', async () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const result = await v.embedNotes({ threshold: 0.5, _pipelineFactory: mockFactory });
    expect(result.embedded).toBe(0);
    expect(result.skipped_hash).toBe(2);
  });

  test('[P7b] --force re-embeds even when hash matches', async () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const result = await v.embedNotes({ threshold: 0.5, force: true, _pipelineFactory: mockFactory });
    expect(result.embedded).toBe(2);
    expect(result.skipped_hash).toBe(0);
  });

  test('[P7b] existing wikilink between A and B does not get duplicate semantic row', async () => {
    // Create a fresh vault where wiki-a wikilinks to wiki-b
    const wikiVault = makeTmpVault('p7b-wiki');
    process.env.ADVISOR_VAULT = wikiVault;

    fs.writeFileSync(path.join(wikiVault, 'synthesis/wiki-a.md'),
      `---\ntype: synthesis\nsid: 1779000002-cc0000\nseq: 1\n---\n\nalpha-content [[wiki-b]]`);
    fs.writeFileSync(path.join(wikiVault, 'synthesis/wiki-b.md'),
      `---\ntype: synthesis\nsid: 1779000003-dd0000\nseq: 1\n---\n\nbeta-content standalone`);
    v.rebuildIndex();

    const result = await v.embedNotes({ threshold: 0.5, _pipelineFactory: mockFactory });

    const dbFile = path.join(wikiVault, '.cache/vault.db');
    const db = new Database(dbFile);
    const semanticEdges = db.prepare(`SELECT * FROM links WHERE kind='semantic'`).all();
    db.close();

    // wiki-a → wiki-b already exists as wikilink, so no semantic dup
    expect(semanticEdges.length).toBe(0);
    expect(result.semantic_links_skipped_existing).toBeGreaterThanOrEqual(1);

    try { fs.rmSync(wikiVault, { recursive: true, force: true }); } catch (_) {}
  });
});

// ============================================================================
// P7c — rebuild --embed integration (rebuildIndex + embedNotes)
// ============================================================================

describe('P7c — rebuild + embedNotes rehydrates semantic edges', () => {
  let vaultDir;
  let v;

  beforeAll(async () => {
    vaultDir = makeTmpVault('p7c');
    process.env.ADVISOR_VAULT = vaultDir;
    v = await import('../lib/vault.js');

    const notes = [
      { p: 'synthesis/p7c-alpha.md', body: 'alpha-content p7c' },
      { p: 'synthesis/p7c-beta.md',  body: 'beta-content p7c' },
    ];
    for (const n of notes) {
      fs.writeFileSync(path.join(vaultDir, n.p), `---\ntype: synthesis\nsid: 1779000004-ee0000\nseq: 1\n---\n\n${n.body}`);
    }
  });

  afterAll(() => {
    try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('[P7c] first rebuild + embedNotes produces semantic edge', async () => {
    process.env.ADVISOR_VAULT = vaultDir;
    v.rebuildIndex();
    const result = await v.embedNotes({ threshold: 0.5, _pipelineFactory: mockFactory });
    expect(result.embedded).toBe(2);
    expect(result.semantic_links_added).toBeGreaterThanOrEqual(1);

    const dbFile = path.join(vaultDir, '.cache/vault.db');
    const db = new Database(dbFile);
    const edges = db.prepare(`SELECT * FROM links WHERE kind='semantic'`).all();
    db.close();
    expect(edges.length).toBeGreaterThanOrEqual(1);
  });

  test('[P7c] second rebuild wipes links; embedNotes rehydrates semantic edges from embeddings table', async () => {
    process.env.ADVISOR_VAULT = vaultDir;
    // Simulate rebuild --embed: rebuildIndex wipes links, then embedNotes re-inserts semantic edges
    v.rebuildIndex();

    const dbFile = path.join(vaultDir, '.cache/vault.db');
    const db1 = new Database(dbFile);
    const edgesAfterRebuild = db1.prepare(`SELECT * FROM links WHERE kind='semantic'`).all();
    db1.close();
    expect(edgesAfterRebuild.length).toBe(0); // Confirmed: rebuild wipes semantic edges

    // embedNotes with onlyChanged: skips re-embedding (hash match) but re-inserts semantic edges
    const result = await v.embedNotes({ threshold: 0.5, onlyChanged: true, _pipelineFactory: mockFactory });
    expect(result.skipped_hash).toBeGreaterThan(0);

    const db2 = new Database(dbFile);
    const edgesAfterEmbed = db2.prepare(`SELECT * FROM links WHERE kind='semantic'`).all();
    db2.close();
    expect(edgesAfterEmbed.length).toBeGreaterThanOrEqual(1);
  });
});
