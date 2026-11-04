// Tests for lib/handover.js: header parser, legacy rule, header rewrite and the
// atomic file helpers shared by lib/maintenance.js and the handover CLIs.
import { test, expect, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  classifyContent,
  applyHeaderUpdates,
  renderHeader,
  atomicReplace,
  createExclusive,
  readHandover,
} from '../lib/handover.js';

const CREATED = 1_793_186_067;
const NOW_MS = (CREATED + 3600) * 1000;
const MTIME_MS = 1_700_000_000_000;
const opts = { mtimeMs: MTIME_MS, nowMs: NOW_MS };

const tmpDirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-header-'));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function hdr(fields = {}, body = '# Handover\n\nbody\n') {
  const f = { status: 'open', created: String(CREATED), sid: 's-1', ...fields };
  const lines = Object.entries(f).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

test('classifyContent: valid open header is header/open with created epoch', () => {
  const r = classifyContent(hdr(), opts);
  expect(r.kind).toBe('header');
  expect(r.status).toBe('open');
  expect(r.createdMs).toBe(CREATED * 1000);
  expect(r.sid).toBe('s-1');
});

test('classifyContent: valid resolved header carries resolved epoch and outcome', () => {
  const r = classifyContent(hdr({ status: 'resolved', resolved: String(CREATED + 60), outcome: 'all done' }), opts);
  expect(r.kind).toBe('header');
  expect(r.status).toBe('resolved');
  expect(r.resolvedMs).toBe((CREATED + 60) * 1000);
  expect(r.outcome).toBe('all done');
});

test('classifyContent: resolved header without resolved field falls back to mtime', () => {
  const r = classifyContent(hdr({ status: 'resolved' }), opts);
  expect(r.status).toBe('resolved');
  expect(r.resolvedMs).toBe(MTIME_MS);
});

test('classifyContent: body FINAL OUTCOME line inside an open header file does not resolve it', () => {
  const r = classifyContent(hdr({}, '# H\n\nFINAL OUTCOME: done\n'), opts);
  expect(r.kind).toBe('header');
  expect(r.status).toBe('open');
});

test('classifyContent: legacy line-start FINAL OUTCOME is resolved', () => {
  const r = classifyContent('# H\n\nwork\n\nFINAL OUTCOME: shipped\n', opts);
  expect(r.kind).toBe('legacy');
  expect(r.status).toBe('resolved');
  expect(r.createdMs).toBe(MTIME_MS);
  expect(r.resolvedMs).toBe(MTIME_MS);
});

test('classifyContent: legacy "## FINAL OUTCOME" heading is resolved', () => {
  const r = classifyContent('# H\n\n## FINAL OUTCOME\nshipped\n', opts);
  expect(r.kind).toBe('legacy');
  expect(r.status).toBe('resolved');
});

test('classifyContent: legacy mid-line mention stays open', () => {
  const r = classifyContent('# H\n\nthe notes mention FINAL OUTCOME in passing\n', opts);
  expect(r.kind).toBe('legacy');
  expect(r.status).toBe('open');
});

test('classifyContent: unclosed header is invalid unclosed-header', () => {
  const r = classifyContent('---\nstatus: open\ncreated: 1793186067\n# no close\n', opts);
  expect(r.kind).toBe('invalid');
  expect(r.reason).toBe('unclosed-header');
  expect(r.status).toBe(null);
});

test('classifyContent: bad status is invalid bad-status', () => {
  for (const status of ['pending', 'OPEN', '']) {
    const r = classifyContent(hdr({ status }), opts);
    expect(r.kind).toBe('invalid');
    expect(r.reason).toBe('bad-status');
  }
});

test('classifyContent: non-digit or 13-digit created is invalid bad-created', () => {
  for (const created of ['yesterday', '1793186067000 ', '1793186067000', '-5', '']) {
    const r = classifyContent(hdr({ created }), opts);
    expect(r.kind).toBe('invalid');
    expect(r.reason).toBe('bad-created');
  }
});

test('classifyContent: created 301s in the future is invalid future-created', () => {
  const future = classifyContent(hdr({ created: String(NOW_MS / 1000 + 301) }), opts);
  expect(future.kind).toBe('invalid');
  expect(future.reason).toBe('future-created');
  const skewOk = classifyContent(hdr({ created: String(NOW_MS / 1000 + 300) }), opts);
  expect(skewOk.kind).toBe('header');
});

test('classifyContent: empty and whitespace-only content is kind empty', () => {
  for (const c of ['', '  \n\t\n', '﻿\n']) {
    const r = classifyContent(c, opts);
    expect(r.kind).toBe('empty');
    expect(r.status).toBe(null);
  }
});

test('classifyContent: CRLF and BOM headers parse as valid', () => {
  const crlf = hdr().replace(/\n/g, '\r\n');
  expect(classifyContent(crlf, opts).status).toBe('open');
  const bom = classifyContent('﻿' + hdr(), opts);
  expect(bom.kind).toBe('header');
  expect(bom.status).toBe('open');
});

test('classifyContent: duplicate keys keep first value', () => {
  const content = '---\nstatus: open\nstatus: resolved\ncreated: 1793186067\n---\nbody\n';
  expect(classifyContent(content, opts).status).toBe('open');
});

test('classifyContent: Status OPEN (case variant key) is not a key', () => {
  const content = `---\nStatus: open\ncreated: ${CREATED}\n---\nbody\n`;
  const r = classifyContent(content, opts);
  expect(r.kind).toBe('invalid');
  expect(r.reason).toBe('bad-status');
});

test('applyHeaderUpdates: rewrites only named keys and keeps body bytes identical', () => {
  const body = '# H\r\n\n\ttabs  and trailing   \n\nno final newline';
  const before = renderHeader({ status: 'open', created: CREATED, sid: 's-1' }) + body;
  const after = applyHeaderUpdates(before, { status: 'resolved', resolved: CREATED + 5 });
  expect(after.endsWith(body)).toBe(true);
  const lines = after.split('\n');
  expect(lines).toContain('status: resolved');
  expect(lines).toContain(`resolved: ${CREATED + 5}`);
  expect(lines).toContain(`created: ${CREATED}`);
  expect(lines).toContain('sid: s-1');
  expect(lines).toContain('outcome:');
});

test('applyHeaderUpdates: outcome with newline and --- cannot inject a key or close the header', () => {
  const before = renderHeader({ status: 'open', created: CREATED }) + 'body\n';
  const after = applyHeaderUpdates(before, { status: 'resolved', outcome: 'x\n---\nstatus: open\r\nsid: evil' });
  const headerEnd = after.split('\n').indexOf('---', 1);
  expect(headerEnd).toBe(8); // opening --- + 7 keys, closing --- is line index 8
  const r = classifyContent(after, opts);
  expect(r.status).toBe('resolved');
  expect(r.sid).toBe('');
  expect(r.outcome).toBe('x --- status: open sid: evil');
  expect(after.endsWith('---\nbody\n')).toBe(true);
});

test('renderHeader: fixed key order with empty values', () => {
  expect(renderHeader({ status: 'open', created: CREATED, sid: 'a/b c' })).toBe(
    `---\nstatus: open\ncreated: ${CREATED}\nsid: a_b_c\nresolved:\noutcome:\narchived:\narchive_reason:\n---\n`,
  );
});

test('atomicReplace: full content via same-dir tmp, no tmp left', () => {
  const dir = tmp();
  const target = path.join(dir, 'x-handover.md');
  fs.writeFileSync(target, 'old');
  atomicReplace(target, 'new content');
  expect(fs.readFileSync(target, 'utf8')).toBe('new content');
  expect(fs.readdirSync(dir)).toEqual(['x-handover.md']);
});

test('createExclusive: second create picks -2 suffix and never overwrites', () => {
  const dir = tmp();
  const nameFn = (n) => (n === 1 ? 'a-context-handover.md' : `a-${n}-context-handover.md`);
  const first = createExclusive(dir, nameFn, 'one');
  const second = createExclusive(dir, nameFn, 'two');
  expect(first).toBe('a-context-handover.md');
  expect(second).toBe('a-2-context-handover.md');
  expect(fs.readFileSync(path.join(dir, first), 'utf8')).toBe('one');
  expect(fs.readFileSync(path.join(dir, second), 'utf8')).toBe('two');
  expect(fs.readdirSync(dir).sort()).toEqual([first, second].sort());
});

test('readHandover: symlink is invalid symlink', () => {
  const dir = tmp();
  const real = path.join(dir, 'real.md');
  fs.writeFileSync(real, hdr());
  const link = path.join(dir, 'link-handover.md');
  fs.symlinkSync(real, link);
  const r = readHandover(link, NOW_MS);
  expect(r.kind).toBe('invalid');
  expect(r.reason).toBe('symlink');
});

test.skipIf(process.getuid && process.getuid() === 0)('readHandover: chmod 000 file is kind unreadable (skip if root)', () => {
  const dir = tmp();
  const f = path.join(dir, 'x-handover.md');
  fs.writeFileSync(f, hdr());
  fs.chmodSync(f, 0o000);
  try {
    const r = readHandover(f, NOW_MS);
    expect(r.kind).toBe('unreadable');
    expect(r.reason).toBe('unreadable:EACCES');
  } finally {
    fs.chmodSync(f, 0o644);
  }
});

test('readHandover: file over 1 MiB is too-large without reading', () => {
  const dir = tmp();
  const f = path.join(dir, 'big-handover.md');
  fs.writeFileSync(f, '');
  fs.truncateSync(f, 1048576 + 1);
  const r = readHandover(f, NOW_MS);
  expect(r.kind).toBe('invalid');
  expect(r.reason).toBe('too-large');
});

test('corpus-shaped fixtures: mid-line sentence "still lacks FINAL OUTCOME marker" stays open', () => {
  const content =
    '# Context handover 20261006-091939\n\nPrevious handover 20261005-102603 still lacks FINAL OUTCOME marker (its work is done).\n';
  const r = classifyContent(content, opts);
  expect(r.kind).toBe('legacy');
  expect(r.status).toBe('open');
});

test('classifyContent: opening fence with trailing space or tab still classifies the header', () => {
  for (const ws of [' ', '\t']) {
    const c = hdr({ status: 'resolved', resolved: String(CREATED + 60) }).replace(/^---\n/, `---${ws}\n`);
    const r = classifyContent(c, opts);
    expect(r.kind).toBe('header');
    expect(r.status).toBe('resolved');
  }
});

test('applyHeaderUpdates: trailing-space fences are found and their bytes kept', () => {
  const c = '--- \nstatus: open\ncreated: 5\n---\t\nbody\n';
  expect(applyHeaderUpdates(c, { status: 'resolved' })).toBe('--- \nstatus: resolved\ncreated: 5\n---\t\nbody\n');
});
