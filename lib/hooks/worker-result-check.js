#!/usr/bin/env node
// worker-result-check.js — Stop hook: append synthetic no_verdict result if none sent.
// Env vars consumed: OUTBOX, ADV, ADVISOR_WORKER_HOOKS

const path = require('path');

function main() {
  if (process.env.ADVISOR_WORKER_HOOKS === '0') return;
  const outboxPath = process.env.OUTBOX;
  if (!outboxPath) return;
  const adv = process.env.ADV;
  if (!adv) return;

  const { appendSyntheticIfAbsent } = require(path.join(adv, 'lib', 'channel.js'));
  appendSyntheticIfAbsent(outboxPath, {
    type: 'result',
    from: 'worker-result-check',
    body: { verdict: 'no_verdict', summary: 'worker exited without sending a result envelope' }
  });
}

try { main(); } catch (_) {}
