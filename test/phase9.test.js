// Phase 9 tests: P9a (prune-fixtures CLI), P9b (vault.pruneFixtures API)
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

// ============================================================================
// P9b — vault.pruneFixtures export exists
// ============================================================================

describe('P9b — pruneFixtures export', () => {
  let vaultDir;
  let v;

  beforeAll(async () => {
    vaultDir = makeTmpVault('p9b-export');
    process.env.ADVISOR_VAULT = vaultDir;
    v = await import('../lib/vault.js');
  });

  afterAll(() => {
    try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('[P9b-0] pruneFixtures is exported as a function', () => {
    expect(typeof v.pruneFixtures).toBe('function');
  });
});

// ============================================================================
// P9a — prefix-match pruning (verdict-test-*, test-checkpoint-*, test-*)
// ============================================================================

describe('P9a — prefix-match fixture pruning', () => {
  let vaultDir;
  let v;

  beforeAll(async () => {
    vaultDir = makeTmpVault('p9a-prefix');
    process.env.ADVISOR_VAULT = vaultDir;
    v = await import('../lib/vault.js');
    // Fixture notes: all three prefix patterns
    fs.writeFileSync(
      path.join(vaultDir, 'sessions/verdict-test-abc.md'),
      `---\ntype: session\nsid: 1779000001-vtabc\nseq: 1\n---\n\nThis is a verdict-test stub note with enough body length.`
    );
    fs.writeFileSync(
      path.join(vaultDir, 'sessions/test-checkpoint-xyz.md'),
      `---\ntype: session\nsid: 1779000002-tcxyz\nseq: 1\n---\n\nThis is a test-checkpoint stub note with enough body length.`
    );
    fs.writeFileSync(
      path.join(vaultDir, 'sessions/test-some-feature.md'),
      `---\ntype: session\nsid: 1779000003-tsf\nseq: 1\n---\n\nThis is a test-prefix stub note with enough body length.`
    );
    // Normal note: must NOT be pruned
    fs.writeFileSync(
      path.join(vaultDir, 'sessions/real-session-abc123.md'),
      `---\ntype: session\nsid: 1779000099-real\nseq: 1\n---\n\nThis is a real session note that should never be pruned by the fixture cleaner.`
    );
    v.rebuildIndex();
  });

  afterAll(() => {
    try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('[P9a-1] dry-run returns count ≥ 3 and does NOT delete files', () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const result = v.pruneFixtures({ dryRun: true });
    expect(result.count).toBeGreaterThanOrEqual(3);
    // Files must still exist
    expect(fs.existsSync(path.join(vaultDir, 'sessions/verdict-test-abc.md'))).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, 'sessions/test-checkpoint-xyz.md'))).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, 'sessions/test-some-feature.md'))).toBe(true);
  });

  test('[P9a-2] real run deletes fixture files', () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const result = v.pruneFixtures({ dryRun: false });
    expect(result.count).toBeGreaterThanOrEqual(3);
    expect(fs.existsSync(path.join(vaultDir, 'sessions/verdict-test-abc.md'))).toBe(false);
    expect(fs.existsSync(path.join(vaultDir, 'sessions/test-checkpoint-xyz.md'))).toBe(false);
    expect(fs.existsSync(path.join(vaultDir, 'sessions/test-some-feature.md'))).toBe(false);
  });

  test('[P9a-3] normal notes are NOT pruned', () => {
    expect(fs.existsSync(path.join(vaultDir, 'sessions/real-session-abc123.md'))).toBe(true);
  });
});

// ============================================================================
// P9a — short-body pruning
// ============================================================================

describe('P9a — short-body pruning', () => {
  let vaultDir;
  let v;

  beforeAll(async () => {
    vaultDir = makeTmpVault('p9a-short');
    process.env.ADVISOR_VAULT = vaultDir;
    v = await import('../lib/vault.js');
    // Short body (body "test" = 4 chars < 20)
    fs.writeFileSync(
      path.join(vaultDir, 'sessions/legit-looking-session.md'),
      `---\ntype: session\nsid: 1779000010-short\nseq: 1\n---\n\ntest`
    );
    // Normal body (> 20 chars)
    fs.writeFileSync(
      path.join(vaultDir, 'sessions/real-proper-session.md'),
      `---\ntype: session\nsid: 1779000011-norm\nseq: 1\n---\n\nThis note has a substantial body with real content that exceeds twenty characters.`
    );
    v.rebuildIndex();
  });

  afterAll(() => {
    try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('[P9a-4] short-body note is pruned (body "test" < 20 chars)', () => {
    process.env.ADVISOR_VAULT = vaultDir;
    const result = v.pruneFixtures({ dryRun: false, minBodyLength: 20 });
    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(vaultDir, 'sessions/legit-looking-session.md'))).toBe(false);
  });

  test('[P9a-5] normal-body note is NOT pruned', () => {
    expect(fs.existsSync(path.join(vaultDir, 'sessions/real-proper-session.md'))).toBe(true);
  });
});
