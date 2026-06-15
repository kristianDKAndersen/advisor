'use strict';

const STRIP_ANSI = /\x1b\[[0-9;]*[a-zA-Z]/g;
const NORMALIZE_NOISE = /\b(?:[0-9a-f]{8,}|[0-9a-f]{6}|\d+)\b/gi;

function stripAnsi(s) {
  return s.replace(STRIP_ANSI, '');
}

function normalizeLine(s) {
  return s.replace(NORMALIZE_NOISE, '#').replace(/\s+/g, ' ').trim();
}

const RE_HIGH = /(error|fail(?:ed)?|panic|exception|fatal|assert(?:ion)?|crash|abort)/i;
const RE_WARN = /\b(warn|warning)\b/i;
const RE_SUMMARY = /\b(pass|ok|done|success|total|tests?|suites?|passed|skipped|pending|coverage|duration|elapsed)\b/i;
const RE_FILE_LINE = /[\w./\\-]+\.[a-z]{1,6}:\d+/;

function scoreLine(clean) {
  if (!clean) return 0.1;
  if (RE_HIGH.test(clean)) return 1.0;
  if (RE_WARN.test(clean)) return 0.7;
  if (RE_SUMMARY.test(clean)) return 0.6;
  if (RE_FILE_LINE.test(clean)) return 0.5;
  return 0.1;
}

// Fold consecutive near-identical low-signal lines into one entry with "(xN)".
// Returns array of {text, score, origStart, origEnd}.
function foldLines(rawLines) {
  const items = [];
  let foldNorm = null;
  let foldCount = 0;
  let foldText = '';
  let foldScore = 0;
  let foldStart = 0;

  const flushFold = (nextIdx) => {
    if (foldCount === 0) return;
    items.push({
      text: foldCount > 1 ? `${foldText} (x${foldCount})` : foldText,
      score: foldScore,
      origStart: foldStart,
      origEnd: nextIdx - 1,
    });
    foldNorm = null;
    foldCount = 0;
  };

  for (let i = 0; i < rawLines.length; i++) {
    const clean = stripAnsi(rawLines[i]).trim();
    const score = scoreLine(clean);

    if (score < 0.5) {
      const norm = normalizeLine(clean);
      if (foldNorm !== null && norm === foldNorm) {
        foldCount++;
      } else {
        flushFold(i);
        foldNorm = norm;
        foldCount = 1;
        foldText = clean;
        foldScore = score;
        foldStart = i;
      }
    } else {
      flushFold(i);
      items.push({ text: clean, score, origStart: i, origEnd: i });
    }
  }
  flushFold(rawLines.length);

  return items;
}

/**
 * Filter verbose Bash output to a scored summary.
 *
 * @param {string} rawText - raw tool output
 * @param {object} opts
 * @param {number} opts.lineBudget - max output lines (default 80)
 * @param {number} opts.minBytes  - passthrough floor in bytes (default 2048)
 * @returns {{ summary: string, stats: { rawBytes, rawLines, keptLines, droppedLines } }}
 */
function filter(rawText, { lineBudget = 80, minBytes = 2048 } = {}) {
  const rawBytes = Buffer.byteLength(rawText, 'utf8');
  const rawLines = rawText.split('\n');

  if (rawBytes < minBytes) {
    return {
      summary: rawText,
      stats: { rawBytes, rawLines: rawLines.length, keptLines: rawLines.length, droppedLines: 0 },
    };
  }

  const items = foldLines(rawLines);
  const n = items.length;

  // Mark items to keep: high-signal + first 12 + last 12
  const keep = new Set();
  for (let i = 0; i < n; i++) {
    if (items[i].score >= 0.5) keep.add(i);
  }
  for (let i = 0; i < Math.min(12, n); i++) keep.add(i);
  for (let i = Math.max(0, n - 12); i < n; i++) keep.add(i);

  let keepArr = [...keep].sort((a, b) => a - b);

  // Cap to lineBudget: if over budget, drop lowest-signal middle items
  if (keepArr.length > lineBudget) {
    const first12 = new Set();
    for (let i = 0; i < Math.min(12, n); i++) first12.add(i);
    const last12 = new Set();
    for (let i = Math.max(0, n - 12); i < n; i++) last12.add(i);

    const mandatory = keepArr.filter(i => first12.has(i) || last12.has(i) || items[i].score >= 1.0);
    const optional = keepArr
      .filter(i => !first12.has(i) && !last12.has(i) && items[i].score < 1.0)
      .sort((a, b) => items[b].score - items[a].score);

    const budget = Math.max(0, lineBudget - mandatory.length);
    const selected = new Set([...mandatory, ...optional.slice(0, budget)]);
    keepArr = [...selected].sort((a, b) => a - b);
  }

  // Assemble with elision markers
  const outputLines = [];
  let prevEnd = -1;

  for (const idx of keepArr) {
    const gapStart = prevEnd + 1;
    if (idx > gapStart) {
      let elided = 0;
      for (let g = gapStart; g < idx; g++) {
        elided += items[g].origEnd - items[g].origStart + 1;
      }
      if (elided > 0) outputLines.push(`... [${elided} lines elided] ...`);
    }
    outputLines.push(items[idx].text);
    prevEnd = idx;
  }

  if (prevEnd < n - 1) {
    let elided = 0;
    for (let g = prevEnd + 1; g < n; g++) {
      elided += items[g].origEnd - items[g].origStart + 1;
    }
    if (elided > 0) outputLines.push(`... [${elided} lines elided] ...`);
  }

  // Stats
  let keptLines = 0;
  for (const idx of keepArr) {
    keptLines += items[idx].origEnd - items[idx].origStart + 1;
  }
  const droppedLines = rawLines.length - keptLines;

  return {
    summary: outputLines.join('\n'),
    stats: { rawBytes, rawLines: rawLines.length, keptLines, droppedLines },
  };
}

module.exports = { filter, scoreLine, foldLines };
