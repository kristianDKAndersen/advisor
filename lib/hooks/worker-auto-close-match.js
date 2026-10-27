#!/usr/bin/env node
// worker-auto-close-match.js - prints '1' when a Bash PostToolUse event is a real, successful result send.
// Rule: some command segment (split outside quotes/heredocs/comments) runs channel.js send --type result to
// the outbox, AND the output has a '#<seq> [result]' marker or the outbox's last line is a result under 10s old.
const fs = require('fs');
const path = require('path');

const OPERATORS = ['&&', '||', '|', ';', '&'];
const WRAPPERS = new Set(['env', 'exec', 'time', 'command', 'nohup']);

// Split a shell command into segments of unquoted words; heredoc bodies and comments are dropped.
function parseSegments(cmd) {
  const segments = [];
  let words = [];
  let word = null;
  let heredocs = [];
  const endWord = () => { if (word !== null) { words.push(word); word = null; } };
  const endSegment = () => { endWord(); if (words.length) segments.push(words); words = []; };
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === '\\' && i + 1 < cmd.length) { word = (word || '') + cmd[i + 1]; i += 2; continue; }
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      const stop = end === -1 ? cmd.length : end;
      word = (word || '') + cmd.slice(i + 1, stop);
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let text = '';
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === '\\' && j + 1 < cmd.length) { text += cmd[j + 1]; j += 2; } else text += cmd[j++];
      }
      word = (word || '') + text;
      i = j + 1;
      continue;
    }
    if (c === '$' && cmd[i + 1] === '(') {
      let depth = 0;
      let j = i + 1;
      for (; j < cmd.length; j++) {
        if (cmd[j] === '(') depth++;
        else if (cmd[j] === ')' && --depth === 0) break;
      }
      word = (word || '') + cmd.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const end = cmd.indexOf('`', i + 1);
      const stop = end === -1 ? cmd.length : end;
      word = (word || '') + cmd.slice(i, stop + 1);
      i = stop + 1;
      continue;
    }
    if (c === '#' && word === null) {
      while (i < cmd.length && cmd[i] !== '\n') i++;
      continue;
    }
    if (c === '\n') {
      endSegment();
      i++;
      // Pending heredoc bodies start on the next line and run to the delimiter line.
      for (const h of heredocs) {
        while (i < cmd.length) {
          let eol = cmd.indexOf('\n', i);
          if (eol === -1) eol = cmd.length;
          const line = cmd.slice(i, eol);
          i = eol + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        }
      }
      heredocs = [];
      continue;
    }
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      endWord();
      i += 2;
      const strip = cmd[i] === '-';
      if (strip) i++;
      while (cmd[i] === ' ' || cmd[i] === '\t') i++;
      let delim = '';
      while (i < cmd.length && !/[\s;&|<>()]/.test(cmd[i])) {
        if (cmd[i] === "'" || cmd[i] === '"') {
          const end = cmd.indexOf(cmd[i], i + 1);
          const stop = end === -1 ? cmd.length : end;
          delim += cmd.slice(i + 1, stop);
          i = stop + 1;
        } else if (cmd[i] === '\\' && i + 1 < cmd.length) { delim += cmd[i + 1]; i += 2; } else delim += cmd[i++];
      }
      heredocs.push({ delim, strip });
      continue;
    }
    const op = OPERATORS.find((o) => cmd.startsWith(o, i));
    if (op) { endSegment(); i += op.length; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }
    word = (word || '') + c;
    i++;
  }
  endSegment();
  return segments;
}

// Returns the --file value of a `channel.js send --type result` segment, or null if the segment is not one.
function resultSendFile(words) {
  let k = 0;
  while (k < words.length && (/^[A-Za-z_]\w*=/.test(words[k]) || WRAPPERS.has(words[k]))) k++;
  if (['bun', 'node'].includes(path.basename(words[k] || ''))) k++;
  if (path.basename(words[k] || '') !== 'channel.js' || words[k + 1] !== 'send') return null;
  const args = words.slice(k + 2);
  const flag = (name) => {
    const at = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (at === -1) return null;
    return args[at].includes('=') ? args[at].slice(name.length + 3) : args[at + 1] || null;
  };
  if (flag('type') !== 'result') return null;
  return flag('file') || '';
}

function isOutbox(fileWord) {
  const outbox = process.env.OUTBOX || '';
  return fileWord.includes('OUTBOX') || fileWord.endsWith('outbox.jsonl') || (outbox !== '' && fileWord === outbox);
}

function freshResultInOutbox(fileWord) {
  const env = process.env.OUTBOX || '';
  const file = /\$\{?OUTBOX\}?/.test(fileWord) ? fileWord.replace(/\$\{?OUTBOX\}?/g, env) : fileWord || env;
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    const ts = last.ts > 1e12 ? last.ts / 1000 : last.ts;
    return last.type === 'result' && Math.abs(Date.now() / 1000 - ts) <= 10;
  } catch (_) {
    return false;
  }
}

function main() {
  const data = JSON.parse(fs.readFileSync(0, 'utf8'));
  const cmd = (data.tool_input && data.tool_input.command) || '';
  const file = parseSegments(cmd).map(resultSendFile).find((f) => f !== null && isOutbox(f));
  if (file === undefined) return false;
  const resp = data.tool_response;
  const out = typeof resp === 'string' ? resp : ['output', 'stdout', 'stderr']
    .map((k) => (resp && typeof resp[k] === 'string' ? resp[k] : '')).join('\n');
  if (/^#\d+ \[result\]/m.test(out)) return true;
  if (/^Error:/m.test(out) || (resp && resp.interrupted)) return false;
  // --quiet sends print nothing, so fall back to the outbox itself.
  return freshResultInOutbox(file);
}

try {
  process.stdout.write(main() ? '1' : '');
} catch (_) {
  process.stdout.write('');
}
