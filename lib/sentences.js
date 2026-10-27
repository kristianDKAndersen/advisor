'use strict';
// Markdown-aware sentence splitter shared by bin/advisor-claims-check and bin/advisor-prose-lint.

const norm = (s) => s.replace(/\s+/g, ' ').trim();

// Cells of a markdown table row; `\|` is a literal pipe inside a cell.
const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());

const ABBREV = new Set(['e.g', 'i.e', 'vs']);

// entries: [{line, text}] in file order. Returns [{sentence, line, endLine}].
// Skips code fences (opts.fences, default true), strips list/quote/heading markers, joins
// wrapped lines of a paragraph, splits on . ! ? except after e.g. / i.e. / vs. A table (contiguous
// lines starting with '|') yields one sentence per body row (opts.tableRows, default true; header
// and separator rows skipped), or nothing when tableRows is false.
function splitEntries(entries, opts = {}) {
  const { fences = true, tableRows = true } = opts;
  const out = [];
  let inFence = false;
  let inTable = false;
  let para = null;
  const push = (s, line, endLine) => {
    const n = norm(s);
    if (n && /[A-Za-z0-9]/.test(n)) out.push({ sentence: n, line, endLine });
  };
  const flush = () => {
    if (!para) return;
    let text = '';
    const starts = [];
    for (const l of para) {
      if (text) text += ' ';
      starts.push({ off: text.length, line: l.line });
      text += l.text;
    }
    const lineAt = (off) => starts.filter((s) => s.off <= off).pop().line;
    const lead = (s) => s.length - s.trimStart().length;
    let begin = 0;
    const re = /[.!?]+[)"'\]*_`]*(?=\s|$)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const before = text.slice(begin, m.index).split(/\s+/).pop().toLowerCase();
      if (m[0][0] === '.' && ABBREV.has(before)) continue;
      push(text.slice(begin, re.lastIndex), lineAt(begin + lead(text.slice(begin))), lineAt(m.index));
      begin = re.lastIndex;
    }
    push(text.slice(begin), lineAt(begin + lead(text.slice(begin))), lineAt(Math.max(0, text.length - 1)));
    para = null;
  };
  for (const { line, text: raw } of entries) {
    if (fences && /^\s*(```|~~~)/.test(raw)) {
      flush();
      inTable = false;
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (raw.trim().startsWith('|')) {
      flush();
      const wasTable = inTable;
      inTable = true;
      if (!tableRows || !wasTable) continue; // header row
      const cells = splitRow(raw);
      if (!cells.every((c) => /^:?-+:?$/.test(c))) push(cells.join(' | '), line, line);
      continue;
    }
    inTable = false;
    if (!raw.trim()) {
      flush();
      continue;
    }
    const isItem = /^\s*([-*+]|\d+[.)])\s+/.test(raw);
    const isHeading = /^#{1,6}\s/.test(raw.trim());
    const stripped = raw.replace(/^\s*(>\s*)*/, '').replace(/^(#{1,6}\s+|([-*+]|\d+[.)])\s+)/, '');
    if (isItem || isHeading) flush();
    (para = para || []).push({ text: stripped.trim(), line });
    if (isHeading) flush();
  }
  flush();
  return out;
}

const splitSentences = (content, opts) => splitEntries(content.split('\n').map((text, i) => ({ line: i + 1, text })), opts);

module.exports = { splitSentences, splitEntries, splitRow, norm };
