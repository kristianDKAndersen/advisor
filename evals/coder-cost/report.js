#!/usr/bin/env bun
'use strict';
/* Aggregates evals/coder-cost/results/*.jsonl into a markdown report. Usage: bun report.js [--out <path>] */
const fs = require('fs');
const path = require('path');

const EVAL_DIR = __dirname;
const RESULTS_DIR = path.join(EVAL_DIR, 'results');

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter(Boolean);
}

function loadAllResults() {
  if (!fs.existsSync(RESULTS_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(RESULTS_DIR)) {
    if (f.endsWith('.jsonl')) out.push(...readJsonl(path.join(RESULTS_DIR, f)));
  }
  return out;
}

function costOf(rec) {
  const a = rec.cost_instrument_a && typeof rec.cost_instrument_a.cost === 'number' ? rec.cost_instrument_a.cost : null;
  if (a != null) return a;
  const b = rec.cost_instrument_b && typeof rec.cost_instrument_b.cost === 'number' ? rec.cost_instrument_b.cost : null;
  return b;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function buildReport(results) {
  const byConfig = {};
  for (const r of results) {
    if (!byConfig[r.config]) byConfig[r.config] = [];
    byConfig[r.config].push(r);
  }

  let md = '# Coder-cost eval report\n\n';
  md += `Total runs recorded: ${results.length}\n\n`;
  md += '## Per-config summary\n\n';
  md += '| config | runs | pass | fail | timeout | error | pass rate | mean cost/run | p90 cost/run | cost/solved task | disagreement>5% |\n';
  md += '|---|---|---|---|---|---|---|---|---|---|---|\n';

  const paretoRows = [];
  for (const [config, recs] of Object.entries(byConfig)) {
    const counts = { pass: 0, fail: 0, timeout: 0, error: 0 };
    const costs = [];
    const solvedCosts = [];
    let disagreements = 0;
    for (const r of recs) {
      counts[r.outcome] = (counts[r.outcome] || 0) + 1;
      const c = costOf(r);
      if (c != null) costs.push(c);
      if (r.outcome === 'pass' && c != null) solvedCosts.push(c);
      if (r.cost_disagreement_flag) disagreements++;
    }
    const sortedCosts = [...costs].sort((a, b) => a - b);
    const mean = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null;
    const p90 = percentile(sortedCosts, 90);
    const passRate = recs.length ? counts.pass / recs.length : null;
    const costPerSolved = solvedCosts.length ? solvedCosts.reduce((a, b) => a + b, 0) / solvedCosts.length : null;

    md += `| ${config} | ${recs.length} | ${counts.pass} | ${counts.fail || 0} | ${counts.timeout || 0} | ${counts.error || 0} | ${passRate != null ? (passRate * 100).toFixed(1) + '%' : 'n/a'} | ${mean != null ? '$' + mean.toFixed(4) : 'n/a'} | ${p90 != null ? '$' + p90.toFixed(4) : 'n/a'} | ${costPerSolved != null ? '$' + costPerSolved.toFixed(4) : 'n/a'} | ${disagreements} |\n`;

    paretoRows.push({ config, passRate: passRate || 0, mean: mean || Infinity, costPerSolved });
  }

  md += '\n## Score-vs-cost Pareto (lower cost, higher pass rate is better)\n\n';
  md += '| config | pass rate | mean cost/run | cost/solved task | pareto-dominated? |\n';
  md += '|---|---|---|---|---|\n';
  for (const row of paretoRows) {
    const dominated = paretoRows.some((o) => o.config !== row.config && o.passRate >= row.passRate && o.mean <= row.mean && (o.passRate > row.passRate || o.mean < row.mean));
    md += `| ${row.config} | ${(row.passRate * 100).toFixed(1)}% | $${row.mean === Infinity ? 'n/a' : row.mean.toFixed(4)} | ${row.costPerSolved != null ? '$' + row.costPerSolved.toFixed(4) : 'n/a'} | ${dominated ? 'yes' : 'no'} |\n`;
  }

  return md;
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  const results = loadAllResults();
  const md = buildReport(results);
  if (outPath) {
    fs.writeFileSync(outPath, md);
    console.log(`Report written to ${outPath}`);
  } else {
    console.log(md);
  }
}

if (require.main === module) main();

module.exports = { buildReport, costOf, percentile, loadAllResults };
