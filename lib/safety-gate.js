// safety-gate.js — mechanical enforcement of the "no deploy/spend/credentials/
// contact/irreversible-change without approval" constraint. See
// advisor-loop-design.md section 6 for the declarative gate file format and
// round-lifecycle check points this module is checked against.
//
// Usage:
//   const { checkGate, loadGateConfig } = require('./safety-gate');
//   const gate = loadGateConfig('<outputDir>/safety-gate.json');
//   const result = checkGate(gate, files_changed, action);
//   // result: { allowed: true } | { allowed: false, reason, path?, action? }

const fs = require('fs');
const path = require('path');

// Minimal glob matcher supporting the subset used in path_denylist:
// '**' (any number of path segments, including zero) and '*' (any run of
// characters within a single segment).
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      // '**/' matches zero-or-more leading segments; bare '**' matches any.
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function matchesGlob(filePath, glob) {
  const normalized = filePath.split(path.sep).join('/');
  return globToRegExp(glob).test(normalized);
}

function matchDenylist(filePath, denylist) {
  for (const glob of denylist) {
    if (matchesGlob(filePath, glob)) return glob;
  }
  return null;
}

function isOutsideWorktree(filePath, worktreeRoot) {
  if (!worktreeRoot) return false;
  const abs = path.resolve(worktreeRoot, filePath);
  const rootResolved = path.resolve(worktreeRoot);
  const rel = path.relative(rootResolved, abs);
  return rel.startsWith('..') || path.isAbsolute(rel);
}

// checkGate(gateConfig, files_changed, action)
//   gateConfig: parsed safety-gate.json shape (path_denylist, action_allowlist,
//     worktree_root, on_violation)
//   files_changed: array of repo-relative (or worktree-relative) path strings,
//     e.g. from `git diff --name-only`
//   action: string key to look up in action_allowlist, or null/undefined to
//     skip the action check (path-only check)
//
// Returns a structured result, never a bare boolean:
//   { allowed: true }
//   { allowed: false, reason: 'path_denylist', path, matched }
//   { allowed: false, reason: 'action_not_allowlisted', action }
//   { allowed: false, reason: 'outside_worktree', path }
function checkGate(gateConfig, files_changed, action) {
  const denylist = gateConfig.path_denylist || [];
  const allowlist = gateConfig.action_allowlist || {};
  const worktreeRoot = gateConfig.worktree_root;

  for (const filePath of files_changed || []) {
    const matched = matchDenylist(filePath, denylist);
    if (matched) {
      return {
        allowed: false,
        reason: 'path_denylist',
        path: filePath,
        matched,
        action: action || null,
      };
    }
    if (isOutsideWorktree(filePath, worktreeRoot)) {
      return {
        allowed: false,
        reason: 'outside_worktree',
        path: filePath,
        action: action || null,
      };
    }
  }

  if (action != null) {
    // Deny-by-default: an action must be present AND true to proceed.
    if (allowlist[action] !== true) {
      return {
        allowed: false,
        reason: 'action_not_allowlisted',
        action,
        path: null,
      };
    }
  }

  return { allowed: true };
}

function loadGateConfig(gatePath) {
  const raw = fs.readFileSync(gatePath, 'utf8');
  return JSON.parse(raw);
}

module.exports = { checkGate, loadGateConfig, matchesGlob };
