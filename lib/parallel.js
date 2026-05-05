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
const { execFileSync, spawnSync } = require('child_process');
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
  } = options;

  const startedAt = new Date().toISOString();

  // Provision all worker sessions via bin/summon (opens a Terminal tab per worker).
  const workers = [];
  for (const brief of briefs) {
    const args = ['--agent', brief.agent, '--task', brief.task, '--goal', brief.goal];
    if (brief.model) args.push('--model', brief.model);
    let stdout;
    try {
      stdout = execFileSync(SUMMON_BIN, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      });
    } catch (e) {
      throw new Error(`bin/summon failed for agent=${brief.agent}: ${e.message}`);
    }
    const meta = JSON.parse(stdout.trim());
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
    });
  }

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
          // Any activity resets the nudge so we don't double-nudge.
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
          }
          printSynthesisBlock(msg, w.sid);
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
        if (!w.nudged && silentMs > silenceNudgeMs) {
          channel.append(w.inbox, { type: 'guidance', body: 'status?', from: 'parallel' });
          w.nudged = true;
        } else if (silentMs > silenceTerminateMs) {
          channel.append(w.inbox, { type: 'terminate', body: 'silence timeout', from: 'parallel' });
          w.status = 'silent';
          spawnSync(CLOSE_WORKER_TAB, [w.sid], { stdio: 'ignore' });
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

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    const reportPath = path.join(outputDir, 'session-report.json');
    const tmp = reportPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2));
    fs.renameSync(tmp, reportPath);
  }

  return report;
}

module.exports = { runParallel };
