// parallel.js — fan-out N briefs to parallel worker sessions and collect results.
//
// Usage as library:
//   const { runParallel } = require('./parallel');
//   const report = await runParallel(briefs, { outputDir, ... });
//
// briefs: [{ agent, task, goal, model? }, ...]
// options: { outputDir, silenceNudgeMs, silenceTerminateMs, pollIntervalMs }
//
// Returns Promise<SessionReport>:
//   { workers: [{ sid, agent, outputDir, status: 'result'|'terminated'|'silent',
//                 toolCalls?, tokenEstimate?, summary?, paths?, verdict? }],
//     startedAt, endedAt }

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const channel = require('./channel');

const ADVISOR_ROOT = path.resolve(__dirname, '..');
const SUMMON_BIN = path.join(ADVISOR_ROOT, 'bin', 'summon');
const CLOSE_WORKER_TAB = path.join(ADVISOR_ROOT, 'bin', 'close-worker-tab');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Replicate the SYNTHESIS REQUIRED block that channel.js tail/recv emits so
// the advisor sees the prompt in-line during a parallel run.
function printSynthesisBlock(msg, sid) {
  const seq = msg.seq;
  const from = msg.from || 'unknown';
  const body = msg.body;
  const envelopeBlock =
    typeof body === 'object' && body !== null
      ? '\nResult envelope received:\n' +
        `  SUMMARY: ${body.summary}\n` +
        `  VERDICT: ${body.verdict}\n` +
        `  PATHS:\n${(body.paths || []).map((p) => '    ' + p).join('\n')}\n`
      : '';
  process.stdout.write(
    '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
      `SYNTHESIS REQUIRED — worker result received (seq=${seq}, agent=${from}, sid=${sid})\n` +
      envelopeBlock +
      '\nBefore any other action (spawning workers, sending guidance, closing tab),\n' +
      'run this command with the four fields filled in:\n' +
      '\n' +
      `  bun $ADV/lib/channel.js synthesize \\\n` +
      `    --sid ${sid} \\\n` +
      `    --seq ${seq} \\\n` +
      `    --established '<2-3 sentences: what do the findings establish?>' \\\n` +
      `    --gap '<one sentence: what specific question remains? or "none">' \\\n` +
      `    --material <yes|no|partial> \\\n` +
      `    --next '<proceed-to-step-8 | spawn-refinement: <gap> | spawn-evaluator>' \\\n` +
      `    --key-quotes '<1–2 verbatim quotes from the result most important for downstream use; empty string if none>'\n` +
      '\nThis is logged to ~/.advisor/runs/' +
      sid +
      '/synthesis.log for cross-session audit.\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
  );
}

async function runParallel(briefs, options = {}) {
  const {
    outputDir,
    silenceNudgeMs = 5 * 60_000,
    silenceTerminateMs = 10 * 60_000,
    pollIntervalMs = 1000,
    maxToolCalls,
    timeoutSec,
    requiredOutput,
    fanInGroups,
  } = options;

  const _execFileSync = options.execFileSync || childProcess.execFileSync;

  const groupMap = new Map();
  if (Array.isArray(fanInGroups)) {
    for (const g of fanInGroups) {
      groupMap.set(g.task_group_id, { threshold: g.fan_in_threshold, submittedCount: 0, sids: [] });
    }
  }

  const startedAt = new Date().toISOString();

  // Provision all worker sessions via bin/summon (opens a Terminal tab per worker).
  const workers = [];
  for (const brief of briefs) {
    const args = ['--agent', brief.agent, '--task', brief.task, '--goal', brief.goal];
    if (brief.model) args.push('--model', brief.model);
    const taskGroupId = brief.task_group_id || null;
    if (taskGroupId && groupMap.has(taskGroupId)) {
      groupMap.get(taskGroupId).submittedCount++;
    }
    let stdout;
    try {
      stdout = _execFileSync(SUMMON_BIN, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      });
    } catch (e) {
      if (groupMap.size > 0) {
        workers.push({
          sid: null,
          agent: brief.agent,
          outputDir: null,
          outbox: null,
          inbox: null,
          status: 'error',
          summary: e.message,
          task_group_id: taskGroupId,
          lastSeq: 0,
          lastMessageAt: Date.now(),
          nudged: false,
          stalled: false,
        });
        continue;
      }
      throw new Error(`bin/summon failed for agent=${brief.agent}: ${e.message}`);
    }
    const jsonLine = stdout.trim().split('\n').find(l => l.startsWith('{')) || stdout.trim();
    const meta = JSON.parse(jsonLine);
    workers.push({
      sid: meta.sid,
      agent: brief.agent,
      outputDir: meta.outputDir,
      outbox: meta.outbox,
      inbox: meta.inbox,
      status: 'running',
      lastSeq: 0,
      lastMessageAt: Date.now(),
      nudged: false,
      stalled: false,
      task_group_id: taskGroupId,
    });
  }

  const startMs = Date.now();

  // Round-robin polling loop until all workers are terminal.
  while (workers.some((w) => w.status === 'running')) {
    await sleep(pollIntervalMs);
    const now = Date.now();

    for (const w of workers) {
      if (w.status !== 'running') continue;

      const msgs = channel.readAfter(w.outbox, w.lastSeq);
      for (const msg of msgs) {
        w.lastSeq = Math.max(w.lastSeq, msg.seq);
        w.lastMessageAt = now;

        if (msg.type === 'progress') {
          // Any activity resets the stall and nudge flags.
          w.stalled = false;
          w.nudged = false;
        } else if (msg.type === 'result') {
          let body = msg.body;
          if (typeof body === 'string') {
            try {
              body = JSON.parse(body);
            } catch (_) {}
          }
          w.status = 'result';
          if (typeof body === 'object' && body !== null) {
            w.summary = body.summary;
            w.paths = body.paths;
            w.verdict = body.verdict;
          } else {
            w.summary = String(body);
          }
          if (msg.meta) {
            w.toolCalls = msg.meta.tool_calls;
            w.tokenEstimate = msg.meta.token_estimate;
            if (maxToolCalls != null && msg.meta.tool_calls > maxToolCalls) {
              channel.append(w.inbox, { type: 'terminate', body: 'tool-call limit exceeded', from: 'parallel' });
              w.status = 'terminated';
              childProcess.spawnSync(CLOSE_WORKER_TAB, [w.sid], { stdio: 'ignore' });
            }
          }
          if (requiredOutput && w.status !== 'terminated') {
            const fields = requiredOutput.split(',').map((f) => f.trim());
            const bodyObj = typeof body === 'object' && body !== null ? body : {};
            if (fields.some((f) => bodyObj[f] == null)) {
              channel.append(w.inbox, { type: 'terminate', body: 'missing required output fields', from: 'parallel' });
              w.status = 'terminated';
              childProcess.spawnSync(CLOSE_WORKER_TAB, [w.sid], { stdio: 'ignore' });
            }
          }
          printSynthesisBlock(msg, w.sid);
          if (w.task_group_id && w.status === 'result' && groupMap.has(w.task_group_id)) {
            groupMap.get(w.task_group_id).sids.push(w.sid);
          }
        } else if (msg.type === 'question') {
          const bodyStr =
            typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body);
          process.stderr.write(
            `[parallel] question from sid=${w.sid} agent=${w.agent}: ${bodyStr}\n`
          );
        }
      }

      // Silence timeout handling (only re-check if still running after processing msgs).
      if (w.status === 'running') {
        const silentMs = now - w.lastMessageAt;
        if (timeoutSec != null && (now - startMs) > timeoutSec * 1000) {
          channel.append(w.inbox, { type: 'terminate', body: 'timeout exceeded', from: 'parallel' });
          w.status = 'terminated';
          childProcess.spawnSync(CLOSE_WORKER_TAB, [w.sid], { stdio: 'ignore' });
        } else if (!w.stalled && silentMs >= 60_000) {
          channel.append(w.inbox, { type: 'stalled', body: 'worker silent 60s', from: 'parallel' });
          w.stalled = true;
        } else if (!w.nudged && silentMs > silenceNudgeMs) {
          channel.append(w.inbox, { type: 'guidance', body: 'status?', from: 'parallel' });
          w.nudged = true;
        } else if (silentMs > silenceTerminateMs) {
          channel.append(w.inbox, { type: 'terminate', body: 'silence timeout', from: 'parallel' });
          w.status = 'silent';
          childProcess.spawnSync(CLOSE_WORKER_TAB, [w.sid], { stdio: 'ignore' });
        }
      }
    }
  }

  const endedAt = new Date().toISOString();

  const report = {
    workers: workers.map((w) => {
      const entry = {
        sid: w.sid,
        agent: w.agent,
        outputDir: w.outputDir,
        status: w.status,
      };
      if (w.toolCalls != null) entry.toolCalls = w.toolCalls;
      if (w.tokenEstimate != null) entry.tokenEstimate = w.tokenEstimate;
      if (w.summary != null) entry.summary = w.summary;
      if (w.paths != null) entry.paths = w.paths;
      if (w.verdict != null) entry.verdict = w.verdict;
      return entry;
    }),
    startedAt,
    endedAt,
  };

  if (groupMap.size > 0) {
    report.groups = [];
    for (const [task_group_id, { threshold, submittedCount, sids }] of groupMap) {
      report.groups.push({
        task_group_id,
        worker_sids: [...sids],
        status: submittedCount >= threshold ? 'fan-in-complete' : 'fan-in-pending',
      });
    }
  }

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    const reportPath = path.join(outputDir, 'session-report.json');
    const tmp = reportPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2));
    fs.renameSync(tmp, reportPath);
  }

  return report;
}

function aggregateSynthesis(workers, synthesizer) {
  if (typeof synthesizer === 'function') {
    return synthesizer(workers);
  }
  const summary = workers
    .map((w, i) => '[Worker ' + (i + 1) + ': ' + (w.agent || 'worker') + ']\n' + (w.summary || ''))
    .join('\n\n');
  const worker_count = workers.length;
  const verdict_counts = { complete: 0, partial: 0, blocked: 0 };
  for (const w of workers) {
    if (w.verdict in verdict_counts) {
      verdict_counts[w.verdict]++;
    }
  }
  return { synthesis: { summary, worker_count, verdict_counts } };
}

module.exports = { runParallel, aggregateSynthesis };
