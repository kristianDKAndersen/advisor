const path = require('path');
const { execFileSync } = require('child_process');
const { append } = require('./channel.js');
const { mintSessionId } = require('./session');

const SUMMON_BIN_PATH = path.resolve(__dirname, '../bin/summon');

function processHandoff(handoffBody, senderOutbox, opts = {}) {
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
    process.stderr.write('[handoff-receiver] summon failed: ' + _e.message + '\n');
    sid = mintSessionId();
  }

  append(senderOutbox, {
    type: 'guidance',
    from: 'handoff-receiver',
    body: 'spawned ' + receiver_agent + ' as ' + sid,
  });

  return { sid, agent: receiver_agent };
}

module.exports = { processHandoff };
