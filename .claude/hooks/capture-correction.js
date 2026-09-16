#!/usr/bin/env node
'use strict';
// UserPromptSubmit hook: STAGE Advisor-directed corrections for manual triage.
// Safety floor (do not weaken): stdout MUST stay byte-empty (a UserPromptSubmit
// hook's stdout is injected into model context) and it MUST NOT exit non-zero
// (that can block the user's prompt). Node builtins only — never require
// lib/vault.js, which does require('bun:sqlite') and throws under plain node.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Tightened from the plan's Appendix D, which over-fired on ordinary imperatives
// ("don't push yet", "never commit to master", "use Edit not Write"). A correction
// negates or references something already done/said; a forward-looking instruction
// does not. matched_pattern is logged so the table can be tuned from real data.
const PATTERNS = [
  ['neg-rejection', /^no\s*[,.:;!—-]/i, true],
  ['explicit-wrong', /\b(?:that'?s|thats|this is|it'?s)\s+(?:wrong|incorrect|not right|not what)\b/i, true],
  ['told-you', /\bi (?:already |just )?(?:told|asked) you\b/i, true],
  ['i-said', /\bi said\b/i, true],
  ['not-what', /\bnot what i (?:asked|wanted|meant|said)\b/i, true],
  ['stop-doing', /\bstop (?:doing|it|that)\b/i, true],
  ['supposed-to', /\byou (?:were supposed to|shouldn'?t have|weren'?t supposed to)\b/i, true],
  ['undo-revert', /\b(?:undo|revert) (?:that|this|it|your)\b/i, true],
  ['prior-ref', /\bas i (?:said|mentioned)\b|\blike i (?:said|told)\b/i, true],
  ['soft-actually', /^actually\s*[,.: ]/i, false],
];

// 1 MiB cap; rotate once so a runaway detector tops out near 2x on disk. The
// env override exists for tests (mirrors house style, e.g. ADVISOR_STATE_DIR).
const MAX_BYTES = parseInt(process.env.ADVISOR_CORRECTIONS_MAX_BYTES || '', 10) || 1048576;

// Re-derive the vault root with lib/vault.js:11-13's exact logic, without loading it.
function vaultRoot() {
  return process.env.ADVISOR_VAULT || path.join(os.homedir(), '.advisor', 'vault');
}

// Secret-shaped substrings are redacted before the 300-char slice so a secret
// can't survive truncation. Assignment/Bearer forms keep the label, replace
// only the value, so triage wording ("the password is ...") stays legible.
const SECRET_PATTERNS = [
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{10,}\b/gi,
  /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{10,}\b/g,
  /\bAKIA[0-9A-Z]{10,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{10,}\b/g,
];
function redact(text) {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  out = out.replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]');
  out = out.replace(
    /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key)\b(\s*(?:[:=]|\bis\b)\s*)(\S+)/gi,
    '$1$2[REDACTED]'
  );
  out = out.replace(/[A-Za-z0-9_-]{32,}/g, '[REDACTED]');
  return out;
}

try {
  if (process.env.ADVISOR_CAPTURE === '0') process.exit(0); // opt-out
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { raw = ''; } // never let a read error escape
  let data;
  try { data = JSON.parse(raw || '{}'); } catch { process.exit(0); }
  const p = (typeof data.prompt === 'string' ? data.prompt : '').trim();
  if (!p || p.length > 500) process.exit(0); // corrections are short
  const hits = PATTERNS.filter(([, re]) => re.test(p));
  if (hits.length) {
    let safe;
    try {
      safe = redact(p);
      if (typeof safe !== 'string') throw new Error('redact did not return a string');
    } catch {
      process.exit(0); // fail closed: never write raw text if redaction breaks
    }
    const entry = {
      ts: Date.now() / 1000,
      sid: typeof data.session_id === 'string' ? data.session_id : '',
      target: 'advisor',
      confidence: hits.some(([, , strong]) => strong) ? 0.75 : 0.55,
      matched_pattern: hits.map(([name]) => name).join(','),
      text: safe.slice(0, 300),
    };
    const file = path.join(vaultRoot(), '.cache', 'corrections.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(file).size >= MAX_BYTES) {
        fs.renameSync(file, file + '.1');
        try { fs.chmodSync(file + '.1', 0o600); } catch { /* best-effort */ }
      }
    } catch { /* no file yet, or stat/rename raced — fall through and append */ }
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* best-effort; never throw */ }
  }
} catch { /* capture is advisory; never block or crash the prompt */ }
process.exit(0);
