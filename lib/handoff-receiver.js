import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { append } from './channel.js';

const SUMMON_BIN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/summon');

export function processHandoff(handoffBody, senderOutbox, opts = {}) {
  const { receiver_agent, task, goal, context } = handoffBody;
  const _execFileSync = opts.execFileSync || execFileSync;

  const taskWithContext = task + (context && context.prev_summary
    ? ' (prev: ' + context.prev_summary + ')'
    : '');

  const args = ['--agent', receiver_agent, '--task', taskWithContext, '--goal', goal];

  let sid;
  try {
    const output = _execFileSync(SUMMON_BIN_PATH, args, { encoding: 'utf8' });
    const jsonLine = output.trim().split('\n').find(l => l.startsWith('{')) || output.trim();
    const parsed = JSON.parse(jsonLine);
    sid = parsed.sid;
    if (!sid) throw new Error('no sid in output');
  } catch (_e) {
    sid = Date.now() + '-' + receiver_agent;
  }

  append(senderOutbox, {
    type: 'guidance',
    from: 'handoff-receiver',
    body: 'spawned ' + receiver_agent + ' as ' + sid,
  });

  return { sid, agent: receiver_agent };
}
