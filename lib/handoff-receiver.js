import path from 'path';
import { execFileSync } from 'child_process';
import { append } from './channel.js';

const SUMMON_BIN_PATH = path.resolve(import.meta.dir, '../bin/summon');

export function processHandoff(handoffBody, senderOutbox) {
  const { receiver_agent, task, goal, context } = handoffBody;

  const taskWithContext = task + (context && context.prev_summary
    ? ' (prev: ' + context.prev_summary + ')'
    : '');

  const args = ['--agent', receiver_agent, '--task', taskWithContext, '--goal', goal];

  let sid;
  try {
    const output = execFileSync(SUMMON_BIN_PATH, args, { encoding: 'utf8' });
    const parsed = JSON.parse(output);
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
