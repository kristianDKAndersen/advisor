'use strict';
// `advisor-vault lessons ...`: parsing and dispatch. Exit codes: 0 ok, 1 usage or library error, 2 unknown flag.
const fs = require('fs');
const path = require('path');
const vault = require('./vault');
const lessons = require('./lessons');
const { lessonStats } = require('./recall-telemetry');
const { recallLessonsForAdvisor } = require('./vault-recall');
const capture = require('./lesson-capture');

const SOURCES = ['return', 'corrections', 'gaps', 'all'];
const REF = '(--lesson REF | REF)';
const J = '--json';
const DRY = '--dry-run';

// flags: name -> 'value' | 'bool'. ref: accepts --lesson REF or one positional REF.
const SUBS = {
  list: { usage: `lessons list [--status S] [--audience A] [${J}]`, flags: { '--status': 'value', '--audience': 'value', [J]: 'bool' } },
  review: { usage: `lessons review [${J}]`, flags: { [J]: 'bool' } },
  stats: { usage: `lessons stats [--lesson REF | REF] [${J}]`, flags: { '--lesson': 'value', [J]: 'bool' }, ref: true, refOptional: true },
  recall: { usage: `lessons recall --text Q [--audience advisor] [--limit N] [${J}]`, flags: { '--text': 'value', '--audience': 'value', '--limit': 'value', [J]: 'bool' }, required: ['--text'] },
  approve: { usage: `lessons approve ${REF} [--audience advisor|worker|both] [${DRY}]`, flags: { '--lesson': 'value', '--audience': 'value', [DRY]: 'bool' }, ref: true },
  audience: { usage: `lessons audience ${REF} --set advisor|worker|both [${DRY}]`, flags: { '--lesson': 'value', '--set': 'value', [DRY]: 'bool' }, ref: true, required: ['--set'] },
  promote: { usage: `lessons promote ${REF} --to "<anchor text>" [${DRY}]`, flags: { '--lesson': 'value', '--to': 'value', [DRY]: 'bool' }, ref: true, required: ['--to'] },
  retire: { usage: `lessons retire ${REF} [--reason TEXT] [${DRY}]`, flags: { '--lesson': 'value', '--reason': 'value', [DRY]: 'bool' }, ref: true },
  keep: { usage: `lessons keep ${REF} [${DRY}]`, flags: { '--lesson': 'value', [DRY]: 'bool' }, ref: true },
  capture: { usage: `lessons capture [--source ${SOURCES.join('|')}] [--since-days N] [${DRY}]`, flags: { '--source': 'value', '--since-days': 'value', [DRY]: 'bool' } },
};

const fullUsage = () => `Usage: advisor-vault <subcommand> [options]\n${Object.values(SUBS).map(s => `  advisor-vault ${s.usage}`).join('\n')}\n`;

// Returns { opts, ref } or { exit, message }. Help is handled by the caller before this runs.
function parse(sub, argv) {
  const spec = SUBS[sub];
  const opts = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-') && a !== '-') {
      const kind = spec.flags[a];
      if (!kind) return { exit: 2, message: `unknown flag: ${a}` };
      if (kind === 'bool') opts[a] = true;
      else if (i + 1 < argv.length) opts[a] = argv[++i];
      else return { exit: 1, message: `${a} requires a value` };
    } else positionals.push(a);
  }
  for (const f of spec.required || []) if (!opts[f]) return { exit: 1, message: `${f} is required` };
  let ref;
  if (spec.ref) {
    if (positionals.length > 1 || (positionals.length === 1 && opts['--lesson'] !== undefined)) return { exit: 1, message: 'give exactly one lesson ref' };
    ref = opts['--lesson'] !== undefined ? opts['--lesson'] : positionals[0];
    if (!ref && !spec.refOptional) return { exit: 1, message: 'a lesson ref is required (--lesson REF)' };
  } else if (positionals.length) return { exit: 1, message: `unexpected argument: ${positionals[0]}` };
  return { opts, ref };
}

const doctrinePath = () => process.env.ADVISOR_DOCTRINE_FILE || undefined;
const fmtSet = set => Object.entries(set).map(([k, v]) => `${k}=${v}`).join(' ');
const captureStatePath = () => path.join(vault.vaultRoot(), '.cache', 'capture-state.json');

function readCaptureTs() {
  try { const ts = JSON.parse(fs.readFileSync(captureStatePath(), 'utf8')).last_capture_ts; return typeof ts === 'number' ? ts : null; } catch (_) { return null; }
}

function writeCaptureState(ts) {
  const p = captureStatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(`${p}.tmp`, JSON.stringify({ last_capture_ts: ts }) + '\n');
  fs.renameSync(`${p}.tmp`, p);
}

function printMutation(res, out, ref) {
  if (!res.changed.length) { out(`no change: ${ref}`); return; }
  for (const c of res.changed) out(`${res.dryRun ? 'would change' : 'changed'}: ${c.path} ${fmtSet(c.set)}${c.moved_to ? ` moved_to=${c.moved_to}` : ''}`);
}

function exec(sub, { opts, ref }, out) {
  const dryRun = !!opts[DRY];
  switch (sub) {
    case 'list': {
      const rows = lessons.listLessons({ status: opts['--status'], audience: opts['--audience'] });
      if (opts[J]) out(JSON.stringify(rows, null, 2));
      else if (!rows.length) out('(no lessons)');
      else for (const r of rows) out(`${r.path}  status=${r.status} audience=${r.audience} created=${r.created_at}`);
      return;
    }
    case 'review': {
      const queue = lessons.reviewQueue({ doctrinePath: doctrinePath() });
      const ts = readCaptureTs();
      if (opts[J]) out(JSON.stringify({ last_capture_ts: ts, queue }, null, 2));
      else {
        out(`last_capture_ts: ${ts === null ? 'never' : ts}`);
        if (!queue.length) out('(review queue empty)');
        for (const q of queue) out(`[${q.reason}] ${q.path}`);
      }
      return;
    }
    case 'stats': {
      const stats = lessonStats();
      let rows = Object.entries(stats.lessons);
      if (ref !== undefined) {
        const { rel } = lessons.resolveLessonRef(ref);
        rows = [[rel, stats.lessons[rel] || { recall_count: 0, last_recalled: 0, success_after_recall: null, n: 0 }]];
      }
      if (opts[J]) { out(JSON.stringify({ lessons: Object.fromEntries(rows), baseline: stats.baseline }, null, 2)); return; }
      for (const [p, s] of rows) {
        const last = s.last_recalled ? new Date(s.last_recalled * 1000).toISOString() : 'never';
        out(`${p}  recall_count=${s.recall_count} last_recalled=${last} success_after_recall=${s.success_after_recall === null ? 'n/a' : s.success_after_recall} n=${s.n}`);
      }
      if (!rows.length) out('(no recalls recorded)');
      out(`baseline: n=${stats.baseline.n} success_rate=${stats.baseline.success_rate === null ? 'n/a' : stats.baseline.success_rate}`);
      return;
    }
    case 'recall': {
      if (opts['--audience'] !== undefined && opts['--audience'] !== 'advisor') throw new Error('recall supports only --audience advisor');
      const limit = opts['--limit'] === undefined ? 3 : Number(opts['--limit']);
      if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
      const rows = recallLessonsForAdvisor(opts['--text'], { limit });
      if (opts[J]) out(JSON.stringify(rows, null, 2));
      else if (!rows.length) out('No lessons.');
      else for (const r of rows) { out(`${r.path}  score=${r.score.toFixed(3)} routing_hits=${r.routing_hits}`); out(`  ${r.heuristic}`); }
      return;
    }
    case 'approve': return printMutation(lessons.approveLesson(ref, { dryRun, audience: opts['--audience'] }), out, ref);
    case 'audience': return printMutation(lessons.setAudience(ref, { audience: opts['--set'], dryRun }), out, ref);
    case 'promote': return printMutation(lessons.promoteLesson(ref, { to: opts['--to'], dryRun, doctrinePath: doctrinePath() }), out, ref);
    case 'retire': return printMutation(lessons.retireLesson(ref, { reason: opts['--reason'], dryRun }), out, ref);
    case 'keep': return printMutation(lessons.keepLesson(ref, { dryRun }), out, ref);
    case 'capture': {
      const source = opts['--source'] || 'all';
      if (!SOURCES.includes(source)) throw new Error(`--source must be one of ${SOURCES.join(', ')}`);
      const sinceDays = opts['--since-days'] === undefined ? undefined : Number(opts['--since-days']);
      if (sinceDays !== undefined && (!Number.isFinite(sinceDays) || sinceDays <= 0)) throw new Error('--since-days must be a positive number');
      const base = sinceDays === undefined ? { dryRun } : { dryRun, sinceDays };
      const runs = [];
      if (source === 'return' || source === 'all') runs.push(capture.captureReturnRounds(base));
      if (source === 'corrections' || source === 'all') runs.push(capture.captureCorrections({ dryRun }));
      if (source === 'gaps' || source === 'all') runs.push(capture.captureGapClusters(base));
      let proposed = 0, skipped = 0;
      for (const r of runs) {
        for (const p of r.proposed) { proposed++; out(`${dryRun ? 'would propose' : 'proposed'}: ${p.path} (${p.source})`); }
        for (const s of r.skipped) { skipped++; out(`skipped: ${s.capture_key.slice(0, 8)} (${s.source}, ${s.reason})`); }
      }
      out(`${dryRun ? '[dry-run] ' : ''}Proposed: ${proposed}  Skipped: ${skipped}`);
      if (!dryRun) writeCaptureState(Math.floor(Date.now() / 1000));
    }
  }
}

function runLessonsCli(argv, { stdout, stderr }) {
  const out = s => stdout.write(s + '\n');
  const err = s => stderr.write(s + '\n');
  const sub = argv[0];
  const wantsHelp = argv.some(a => a === '-h' || a === '--help');
  if (sub === undefined) { err(fullUsage().trimEnd()); return 1; }
  if (sub === '-h' || sub === '--help') { out(fullUsage().trimEnd()); return 0; }
  if (!Object.hasOwn(SUBS, sub)) { err(`unknown lessons subcommand: ${sub}\n${fullUsage().trimEnd()}`); return 1; }
  if (wantsHelp) { out(`Usage: advisor-vault ${SUBS[sub].usage}`); return 0; }
  const parsed = parse(sub, argv.slice(1));
  if (parsed.exit) {
    err(`${parsed.message}\nUsage: advisor-vault ${SUBS[sub].usage}`);
    return parsed.exit;
  }
  try {
    exec(sub, parsed, out);
    return 0;
  } catch (e) {
    err(`error: ${e && e.message ? e.message : e}`);
    return 1;
  }
}

module.exports = { runLessonsCli };
