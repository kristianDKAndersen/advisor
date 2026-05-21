// Phase 5 tests: P5a retro-link + P5b community detection
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
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

// ════════════════════════════════════════════════════════════════════════════
// P5a — Retroactive Related-section rewrite
// ════════════════════════════════════════════════════════════════════════════

describe('P5a — retroLink', () => {
  let vaultDir;
  let v;

  beforeAll(async () => {
    vaultDir = makeTmpVault('p5a');
    process.env.ADVISOR_VAULT = vaultDir;
    v = await import('../lib/vault.js');

    const sid1 = '1779000001-aaa001';
    // Note 1: synthesis with SID refs in body → should get Related
    fs.writeFileSync(path.join(vaultDir, `synthesis/${sid1}-1.md`), `---
type: synthesis
sid: ${sid1}
seq: 1
established: We learned from 1779000002-bbb002 that caching matters.
gap: See 1779000003-ccc003 for follow-up.
next_action: proceed
---

## Established
We learned from 1779000002-bbb002 that caching matters.

## Gap
See 1779000003-ccc003 for follow-up.
`);

    const sid2 = '1779000002-bbb002';
    // Note 2: session with SID ref in task → should get Related
    fs.writeFileSync(path.join(vaultDir, `sessions/${sid2}.md`), `---
type: session
sid: ${sid2}
---

## Task
Follow up on 1779000003-ccc003 findings.

## Goal
Confirm hypothesis.

## Plan
_none_
`);

    const sid3 = '1779000003-ccc003';
    // Note 3: lesson already has ## Related → skippedHasSection
    fs.writeFileSync(path.join(vaultDir, `lessons/${sid3}-agent-1.md`), `---
type: lesson
sid: ${sid3}
---

## Root cause
Something failed.

## Heuristic
Do better.

## Related
[[${sid3}]]
`);

    // Note 4: synthesis with no SIDs in body → skippedNoSids
    const sid4 = '1779000004-ddd004';
    fs.writeFileSync(path.join(vaultDir, `synthesis/${sid4}-1.md`), `---
type: synthesis
sid: ${sid4}
seq: 1
established: Nothing references anything.
gap: No gaps.
next_action: proceed
---

## Established
Nothing references anything.

## Gap
No gaps.
`);

    v.rebuildIndex();
  });

  afterAll(() => {
    try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('[P5a] retroLink is exported', () => {
    expect(typeof v.retroLink).toBe('function');
  });

  test('[P5a] dry-run counts: 4 candidates, >=2 rewritten, >=1 skippedHasSection', () => {
    process.env.ADVISOR_VAULT = vaultDir;
    v.rebuildIndex();
    const r = v.retroLink({ dryRun: true });
    expect(r.candidates).toBeGreaterThanOrEqual(4);
    expect(r.skippedHasSection).toBeGreaterThanOrEqual(1);
    expect(r.rewritten).toBeGreaterThanOrEqual(2);
    // dry-run: files unchanged
    const text1 = fs.readFileSync(path.join(vaultDir, 'synthesis/1779000001-aaa001-1.md'), 'utf8');
    expect(text1).not.toContain('## Related');
  });

  test('[P5a] live run writes Related to synthesis note', () => {
    process.env.ADVISOR_VAULT = vaultDir;
    v.rebuildIndex();
    v.retroLink({ dryRun: false });

    const text = fs.readFileSync(path.join(vaultDir, 'synthesis/1779000001-aaa001-1.md'), 'utf8');
    expect(text).toContain('## Related');
    expect(text).toContain('[[1779000002-bbb002]]');
    expect(text).toContain('[[1779000003-ccc003]]');
  });

  test('[P5a] live run writes Related to session note', () => {
    const text = fs.readFileSync(path.join(vaultDir, 'sessions/1779000002-bbb002.md'), 'utf8');
    expect(text).toContain('## Related');
    expect(text).toContain('[[1779000003-ccc003]]');
  });

  test('[P5a] lesson with existing Related has exactly one Related section', () => {
    const text = fs.readFileSync(path.join(vaultDir, 'lessons/1779000003-ccc003-agent-1.md'), 'utf8');
    expect((text.match(/## Related/g) || []).length).toBe(1);
  });

  test('[P5a] idempotent — second run rewrites 0', () => {
    process.env.ADVISOR_VAULT = vaultDir;
    v.rebuildIndex();
    const r = v.retroLink({ dryRun: false });
    expect(r.rewritten).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P5b — Community detection (Louvain)
// ════════════════════════════════════════════════════════════════════════════

describe('P5b — computeCommunities / listCommunities', () => {
  let vaultDir;
  let v;

  beforeAll(async () => {
    vaultDir = makeTmpVault('p5b');
    process.env.ADVISOR_VAULT = vaultDir;
    v = await import('../lib/vault.js');
    v.rebuildIndex();
  });

  afterAll(() => {
    try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('[P5b] computeCommunities is exported', () => {
    expect(typeof v.computeCommunities).toBe('function');
  });

  test('[P5b] listCommunities is exported', () => {
    expect(typeof v.listCommunities).toBe('function');
  });

  test('[P5b] communities table is auto-created by computeCommunities', () => {
    process.env.ADVISOR_VAULT = vaultDir;
    v.rebuildIndex();
    v.computeCommunities();
    expect(() => v.listCommunities(5)).not.toThrow();
  });

  test('[P5b] Louvain finds 2-3 communities in 6-node triangle graph with bridge', () => {
    // Fresh vault for this test
    const tmp = makeTmpVault('p5b-louvain');
    const saved = process.env.ADVISOR_VAULT;
    process.env.ADVISOR_VAULT = tmp;

    // Use filenames where basename matches the wikilink targets (a.md, b.md, etc.)
    // Triangle A-B-C + bridge C-D + triangle D-E-F
    const notes = [
      ['synthesis/a.md', '---\ntype: synthesis\nsid: a\nseq: 1\n---\n\n[[b]] [[c]]\n'],
      ['synthesis/b.md', '---\ntype: synthesis\nsid: b\nseq: 1\n---\n\n[[a]] [[c]]\n'],
      ['synthesis/c.md', '---\ntype: synthesis\nsid: c\nseq: 1\n---\n\n[[a]] [[b]] [[d]]\n'],
      ['synthesis/d.md', '---\ntype: synthesis\nsid: d\nseq: 1\n---\n\n[[c]] [[e]] [[f]]\n'],
      ['synthesis/e.md', '---\ntype: synthesis\nsid: e\nseq: 1\n---\n\n[[d]] [[f]]\n'],
      ['synthesis/f.md', '---\ntype: synthesis\nsid: f\nseq: 1\n---\n\n[[d]] [[e]]\n'],
    ];
    for (const [rel, content] of notes) {
      fs.writeFileSync(path.join(tmp, rel), content);
    }
    v.rebuildIndex();

    const result = v.computeCommunities();

    expect(result.communities).toBeGreaterThanOrEqual(2);
    expect(result.communities).toBeLessThanOrEqual(3);
    expect(result.nodes).toBe(6);
    expect(typeof result.modularity).toBe('number');
    expect(result.modularity).toBeGreaterThan(0);

    const rows = v.listCommunities(10);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.length).toBeLessThanOrEqual(3);

    // Two largest communities each have >= 2 members
    const sizes = rows.map(r => r.size).sort((a, b) => b - a);
    expect(sizes[0]).toBeGreaterThanOrEqual(2);
    expect(sizes[1]).toBeGreaterThanOrEqual(2);

    process.env.ADVISOR_VAULT = saved;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  });
});
