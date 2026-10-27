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

  const { appendSyntheticIfAbsent, extractSid, syntheticResultBody } = require(path.join(adv, 'lib', 'channel.js'));
  const summary = 'worker exited without sending a result envelope';
  let body = { verdict: 'no_verdict', summary };
  try {
    body = { ...syntheticResultBody(extractSid(outboxPath), summary), verdict: 'no_verdict' };
  } catch (_) {}
  appendSyntheticIfAbsent(outboxPath, { type: 'result', from: 'worker-result-check', body });
}

try { main(); } catch (_) {}
