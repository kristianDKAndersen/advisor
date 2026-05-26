// Phase 6 tests: P6a (denoise links), P6b (auto-recompute communities), P6c (richer communities)
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

// ============================================================================
// P6a — Denoise link targets
// ============================================================================

describe('P6a — denoise link targets', () => {
  let vaultDir;
  let v;

  beforeAll(async () => {
    vaultDir = makeTmpVault('p6a');
    process.env.ADVISOR_VAULT = vaultDir;
    v = await import('../lib/vault.js');

    // One note with mixed valid/invalid wikilink targets:
    //   [[wikilinks]]        — plain word, rejected
    //   [[1779349463-e75706]] — matches SID_RE, accepted
    //   [[X]]                — plain word, rejected
    //   [[https://example.com]] — URL, accepted
    fs.writeFileSync(path.join(vaultDir, 'synthesis/test-denoise.md'), `---
type: synthesis
sid: 1779000010-abc010
seq: 1
---

Body text with spurious links:
[[wikilinks]] [[1779349463-e75706]] [[X]] [[https://example.com]]
`);

    v.rebuildIndex();
  });

  afterAll(() => {
    try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('[P6a] link table has exactly 2 rows after denoising (SID + URL accepted, plain words rejected)', () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const dbFile = path.join(vaultDir, '.cache/vault.db');
    const db = new Database(dbFile);
    const rows = db.prepare(`SELECT * FROM links`).all();
    db.close();
    expect(rows.length).toBe(2);
  });

  test('[P6a] accepted targets are the SID and the URL', () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const dbFile = path.join(vaultDir, '.cache/vault.db');
    const db = new Database(dbFile);
    const targets = db.prepare(`SELECT target FROM links ORDER BY target`).all().map(r => r.target);
    db.close();
    expect(targets).toContain('1779349463-e75706');
    expect(targets).toContain('https://example.com');
    expect(targets).not.toContain('wikilinks');
    expect(targets).not.toContain('X');
  });

  test('[P6a] listHubs does not return plain-word targets', () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const hubs = v.listHubs(20);
    const targets = hubs.map(h => h.target);
    expect(targets).not.toContain('wikilinks');
    expect(targets).not.toContain('X');
    expect(targets).not.toContain('sid');
  });

  test('[P6a] SID-seq derivative accepted (e.g. 1779349463-e75706-4)', () => {
    const tmp = makeTmpVault('p6a-sidseq');
    const saved = process.env.ADVISOR_VAULT;
    process.env.ADVISOR_VAULT = tmp;

    fs.writeFileSync(path.join(tmp, 'synthesis/test-sidseq.md'), `---
type: synthesis
sid: 1779000011-abc011
seq: 1
---

[[1779349463-e75706-4]] [[not-a-sid]]
`);
    v.rebuildIndex();

    const db = new Database(path.join(tmp, '.cache/vault.db'));
    const rows = db.prepare(`SELECT target FROM links`).all();
    db.close();
    const targets = rows.map(r => r.target);
    expect(targets).toContain('1779349463-e75706-4');
    expect(targets).not.toContain('not-a-sid');

    process.env.ADVISOR_VAULT = saved;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  });

  test('[P6a] basename-matching note accepted (note file exists in vault)', () => {
    const tmp = makeTmpVault('p6a-basename');
    const saved = process.env.ADVISOR_VAULT;
    process.env.ADVISOR_VAULT = tmp;

    // note-a.md links to [[note-b]] — note-b.md exists in vault so it should be accepted
    fs.writeFileSync(path.join(tmp, 'synthesis/note-a.md'), `---\ntype: synthesis\nsid: 1779000012-abc012\nseq: 1\n---\n\n[[note-b]] [[bogus-nonexistent]]\n`);
    fs.writeFileSync(path.join(tmp, 'synthesis/note-b.md'), `---\ntype: synthesis\nsid: 1779000013-abc013\nseq: 1\n---\n\nContent.\n`);
    v.rebuildIndex();

    const db = new Database(path.join(tmp, '.cache/vault.db'));
    const rows = db.prepare(`SELECT target FROM links WHERE source LIKE '%note-a%'`).all();
    db.close();
    const targets = rows.map(r => r.target);
    expect(targets).toContain('note-b');
    expect(targets).not.toContain('bogus-nonexistent');

    process.env.ADVISOR_VAULT = saved;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  });
});

// ============================================================================
// P6b — Auto-recompute communities post-rebuildIndex
// ============================================================================

describe('P6b — auto-recompute communities post-rebuildIndex', () => {
  let vaultDir;
  let v;

  beforeAll(async () => {
    vaultDir = makeTmpVault('p6b');
    process.env.ADVISOR_VAULT = vaultDir;
    v = await import('../lib/vault.js');

    // Triangle A-B-C + bridge C-D + triangle D-E-F
    // All wikilinks are to basenames of existing files → accepted by rule (c)
    // This generates 14 directed link rows (> 10 threshold for auto-recompute)
    const notes = [
      ['synthesis/a.md', '---\ntype: synthesis\nsid: a\nseq: 1\n---\n\n[[b]] [[c]]\n'],
      ['synthesis/b.md', '---\ntype: synthesis\nsid: b\nseq: 1\n---\n\n[[a]] [[c]]\n'],
      ['synthesis/c.md', '---\ntype: synthesis\nsid: c\nseq: 1\n---\n\n[[a]] [[b]] [[d]]\n'],
      ['synthesis/d.md', '---\ntype: synthesis\nsid: d\nseq: 1\n---\n\n[[c]] [[e]] [[f]]\n'],
      ['synthesis/e.md', '---\ntype: synthesis\nsid: e\nseq: 1\n---\n\n[[d]] [[f]]\n'],
      ['synthesis/f.md', '---\ntype: synthesis\nsid: f\nseq: 1\n---\n\n[[d]] [[e]]\n'],
    ];
    for (const [rel, content] of notes) {
      fs.writeFileSync(path.join(vaultDir, rel), content);
    }
    // rebuildIndex should auto-recompute communities (>10 links)
    v.rebuildIndex();
  });

  afterAll(() => {
    try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('[P6b] rebuildIndex returns an object with communities property', () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const result = v.rebuildIndex();
    expect(result).toHaveProperty('communities');
    expect(result.communities).not.toBeNull();
  });

  test('[P6b] rebuildIndex communities result has count >= 2', () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const result = v.rebuildIndex();
    expect(result.communities.communities).toBeGreaterThanOrEqual(2);
  });

  test('[P6b] listCommunities returns non-empty rows without calling computeCommunities manually', () => {
    // vault was rebuilt in beforeAll; no manual recompute call after that
    process.env.ADVISOR_VAULT = vaultDir;
    const rows = v.listCommunities(10);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  test('[P6b] auto-recomputed communities span all 6 nodes', () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const rows = v.listCommunities(10);
    const totalNodes = rows.reduce((sum, r) => {
      const members = Array.isArray(r.members) ? r.members : r.members.split(', ').filter(Boolean);
      return sum + members.length;
    }, 0);
    expect(totalNodes).toBeGreaterThanOrEqual(6);
  });
});

// ============================================================================
// P6c — Richer communities response
// ============================================================================

describe('P6c — richer communities (representative_titles, time_range, edge_density)', () => {
  let vaultDir;
  let v;

  beforeAll(async () => {
    vaultDir = makeTmpVault('p6c');
    process.env.ADVISOR_VAULT = vaultDir;
    v = await import('../lib/vault.js');

    const ts = new Date().toISOString();
    const notes = [
      ['synthesis/a.md', `---\ntype: synthesis\nsid: a\nseq: 1\nestablished: A established fact.\ncreated_at: ${ts}\n---\n\n[[b]] [[c]]\n`],
      ['synthesis/b.md', `---\ntype: synthesis\nsid: b\nseq: 1\nestablished: B established fact.\ncreated_at: ${ts}\n---\n\n[[a]] [[c]]\n`],
      ['synthesis/c.md', `---\ntype: synthesis\nsid: c\nseq: 1\nestablished: C bridge fact.\ncreated_at: ${ts}\n---\n\n[[a]] [[b]] [[d]]\n`],
      ['synthesis/d.md', `---\ntype: synthesis\nsid: d\nseq: 1\nestablished: D bridge fact.\ncreated_at: ${ts}\n---\n\n[[c]] [[e]] [[f]]\n`],
      ['synthesis/e.md', `---\ntype: synthesis\nsid: e\nseq: 1\nestablished: E established fact.\ncreated_at: ${ts}\n---\n\n[[d]] [[f]]\n`],
      ['synthesis/f.md', `---\ntype: synthesis\nsid: f\nseq: 1\nestablished: F established fact.\ncreated_at: ${ts}\n---\n\n[[d]] [[e]]\n`],
    ];
    for (const [rel, content] of notes) {
      fs.writeFileSync(path.join(vaultDir, rel), content);
    }
    v.rebuildIndex();
  });

  afterAll(() => {
    try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('[P6c] listCommunities()[0] has all 6 required keys', () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const rows = v.listCommunities(10);
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0];
    expect(row).toHaveProperty('community_id');
    expect(row).toHaveProperty('size');
    expect(row).toHaveProperty('members');
    expect(row).toHaveProperty('representative_titles');
    expect(row).toHaveProperty('time_range');
    expect(row).toHaveProperty('edge_density');
  });

  test('[P6c] members is an array (not a comma-separated string)', () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const rows = v.listCommunities(10);
    expect(Array.isArray(rows[0].members)).toBe(true);
  });

  test('[P6c] representative_titles is an array of up to 3 items', () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const rows = v.listCommunities(10);
    const row = rows[0];
    expect(Array.isArray(row.representative_titles)).toBe(true);
    expect(row.representative_titles.length).toBeGreaterThanOrEqual(1);
    expect(row.representative_titles.length).toBeLessThanOrEqual(3);
  });

  test('[P6c] time_range has min and max keys', () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const rows = v.listCommunities(10);
    const row = rows[0];
    expect(row.time_range).toHaveProperty('min');
    expect(row.time_range).toHaveProperty('max');
  });

  test('[P6c] edge_density is a number between 0 and 1', () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const rows = v.listCommunities(10);
    const row = rows[0];
    expect(typeof row.edge_density).toBe('number');
    expect(row.edge_density).toBeGreaterThanOrEqual(0);
    expect(row.edge_density).toBeLessThanOrEqual(1);
  });

  test('[P6c] representative_titles contains non-null entries from notes with established field', () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const rows = v.listCommunities(10);
    // At least one community should have at least one non-null title
    const hasTitle = rows.some(r => r.representative_titles.some(t => t !== null));
    expect(hasTitle).toBe(true);
  });
});
