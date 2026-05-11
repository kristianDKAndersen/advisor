'use strict';

const { test, expect } = require('bun:test');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { persistTerminal } = require('../lib/terminal-persist');

test('advisor-observe emits persisted terminal payload and exits 0 quickly when seq > cursor', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-observe-test-'));
  const sid = 'test-observe-' + Date.now();
  const channelDir = path.join(tmpHome, '.advisor', 'runs', sid, 'channel');
  fs.mkdirSync(channelDir, { recursive: true });

  const payload = { seq: 99, type: 'result', body: 'ok' };
  persistTerminal(channelDir, payload);

  // Empty outbox so the tail loop has nothing to emit (without fast-exit, it'd time out)
  fs.writeFileSync(path.join(channelDir, 'outbox.jsonl'), '');

  const advisorObserveBin = path.join(__dirname, '..', 'bin', 'advisor-observe');
  const result = spawnSync('node', [advisorObserveBin, sid, '--after', '0', '--max-wait', '2'], {
    env: { ...process.env, HOME: tmpHome },
    encoding: 'utf8',
    timeout: 3000,
  });

  try {
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"seq":99');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
