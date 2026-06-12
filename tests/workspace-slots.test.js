// workspace-slots.test.js — R1 pooled reusable workspace slots (lib/session.js).
//
// Same-agent-type workers lease a stable slot path (~/.advisor/slots/<agent>-<k>)
// so the worker cwd is byte-identical across sessions (prompt-cache prefix
// stability). Covers: lowest-free-k selection, mkdir-lock mutual exclusion
// under concurrency, scrub, release (by path and by sid), stale-TTL reclaim,
// and the sid-path fallback when every slot is leased.

const { test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.ADVISOR_RUNS_ROOT =
  process.env.ADVISOR_RUNS_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'slot-runs-'));
const session = require('../lib/session.js');

let root;
const sidsToClean = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'slots-'));
  process.env.ADVISOR_SLOTS_ROOT = root;
  delete process.env.ADVISOR_MAX_SLOTS;
  delete process.env.ADVISOR_SLOT_TTL_MS;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.ADVISOR_SLOTS_ROOT;
  delete process.env.ADVISOR_MAX_SLOTS;
  while (sidsToClean.length) {
    fs.rmSync(session.sessionDir(sidsToClean.pop()), { recursive: true, force: true });
  }
});

function mintTestSid() {
  const sid = 'slot-test-' + crypto.randomUUID().slice(0, 8);
  sidsToClean.push(sid);
  return sid;
}

test('leaseSlot picks the lowest free k and reuses a released slot', () => {
  const s1 = session.leaseSlot('researcher', 'sid-1');
  const s2 = session.leaseSlot('researcher', 'sid-2');
  expect(s1).toBe(path.join(root, 'researcher-1'));
  expect(s2).toBe(path.join(root, 'researcher-2'));
  session.releaseSlot(s1);
  expect(session.leaseSlot('researcher', 'sid-3')).toBe(s1);
});

test('mkdir-lock gives mutual exclusion under concurrent leases', async () => {
  const N = 6;
  const script =
    'const s=require(' +
    JSON.stringify(path.resolve(__dirname, '../lib/session.js')) +
    ");process.stdout.write(String(s.leaseSlot('researcher', process.argv[1])));";
  const procs = Array.from({ length: N }, (_, i) =>
    Bun.spawn(['node', '-e', script, `sid-c${i}`], {
      env: { ...process.env, ADVISOR_SLOTS_ROOT: root },
      stdout: 'pipe',
    })
  );
  const outs = await Promise.all(
    procs.map(async (p) => {
      await p.exited;
      return (await new Response(p.stdout).text()).trim();
    })
  );
  // Every concurrent leaser must get a DISTINCT slot — no double-grant.
  expect(new Set(outs).size).toBe(N);
  for (const o of outs) expect(o).toMatch(/researcher-[1-6]$/);
});

test('scrubSlot leaves an empty dir at the same path', () => {
  const s = session.leaseSlot('researcher', 'sid-scrub');
  fs.mkdirSync(path.join(s, 'junk', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(s, 'junk', 'stale.txt'), 'leftover state');
  fs.symlinkSync('/tmp', path.join(s, 'dangling-link'));
  session.scrubSlot(s);
  expect(fs.existsSync(s)).toBe(true);
  expect(fs.readdirSync(s).length).toBe(0);
});

test('releaseSlot frees the lock; releaseSlotBySid finds the lease by sid', () => {
  const s = session.leaseSlot('planner', 'sid-xyz');
  expect(fs.existsSync(s + '.lock')).toBe(true);
  // Held lease is not handed out again.
  expect(session.leaseSlot('planner', 'sid-other')).toBe(path.join(root, 'planner-2'));
  const freed = session.releaseSlotBySid('sid-xyz');
  expect(freed).toEqual([s]);
  expect(fs.existsSync(s + '.lock')).toBe(false);
  expect(session.leaseSlot('planner', 'sid-next')).toBe(s);
  // Unknown sid is a no-op.
  expect(session.releaseSlotBySid('sid-never-existed')).toEqual([]);
});

test('a stale lease (older than TTL) is reclaimed; a fresh one is not', () => {
  const s = session.leaseSlot('researcher', 'sid-crashed');
  const leasePath = path.join(s + '.lock', 'lease.json');
  const lease = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
  lease.ts = Date.now() - 3 * 60 * 60 * 1000; // 3h ago > 2h default TTL
  fs.writeFileSync(leasePath, JSON.stringify(lease));
  // Reclaims slot 1 instead of moving on to slot 2.
  expect(session.leaseSlot('researcher', 'sid-new')).toBe(s);
  // Now the lease is fresh again — next lease moves to slot 2.
  expect(session.leaseSlot('researcher', 'sid-third')).toBe(path.join(root, 'researcher-2'));
});

test('provisionWorkspace leases a slot and symlinks runs/<sid>/workspace to it', () => {
  const sid = mintTestSid();
  const ws = session.provisionWorkspace(sid, 'researcher');
  expect(ws).toBe(path.join(root, 'researcher-1'));
  expect(fs.existsSync(path.join(ws, 'CLAUDE.md'))).toBe(true);
  const legacy = path.join(session.sessionDir(sid), 'workspace');
  expect(fs.lstatSync(legacy).isSymbolicLink()).toBe(true);
  expect(fs.realpathSync(legacy)).toBe(fs.realpathSync(ws));
});

test('provisionWorkspace scrubs prior tenant state out of a reused slot', () => {
  const sidA = mintTestSid();
  const wsA = session.provisionWorkspace(sidA, 'researcher');
  fs.writeFileSync(path.join(wsA, 'prior-tenant-secret.txt'), 'leak');
  session.releaseSlotBySid(sidA);
  const sidB = mintTestSid();
  const wsB = session.provisionWorkspace(sidB, 'researcher');
  expect(wsB).toBe(wsA); // same stable path — the whole point
  expect(fs.existsSync(path.join(wsB, 'prior-tenant-secret.txt'))).toBe(false);
  expect(fs.existsSync(path.join(wsB, 'CLAUDE.md'))).toBe(true);
});

test('falls back to the legacy sid path when every slot is leased', () => {
  process.env.ADVISOR_MAX_SLOTS = '1';
  expect(session.leaseSlot('researcher', 'sid-hog')).toBe(path.join(root, 'researcher-1'));
  expect(session.leaseSlot('researcher', 'sid-late')).toBe(null);
  const sid = mintTestSid();
  const ws = session.provisionWorkspace(sid, 'researcher');
  expect(ws).toBe(path.join(session.sessionDir(sid), 'workspace'));
  expect(fs.lstatSync(ws).isSymbolicLink()).toBe(false);
  expect(fs.existsSync(path.join(ws, 'CLAUDE.md'))).toBe(true);
});
