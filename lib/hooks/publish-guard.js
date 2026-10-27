#!/usr/bin/env node
// PreToolUse hook (Bash): blocks raw publish commands so every outward publish goes
// through bin/advisor-publish. Workers (ADVISOR_SID set): block every publish segment.
// Advisor session: allow only when the target resolves to the advisor repo; unresolved fails closed.
// Convention (same as tool-guard.js): exit 2 = block, stdout = reason; unparseable input exits 0.
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

const SUBST = '\u0000'; // stands in for $(...) output: never part of a real path
const META = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);
const VAR_RE = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/y;
const ASSIGN_RE = /^([A-Za-z_]\w*)=(.*)$/s;
const MAX_DEPTH = 16;

// Prefix words that run the rest of argv as a command -> their options that take a value.
const WRAPPERS = new Map(Object.entries({
  command: [], builtin: [], exec: ['-a'], nohup: [], time: [], noglob: [],
  '!': [], '{': [], if: [], then: [], else: [], elif: [], do: [], while: [], until: [],
  env: ['-u', '-C', '-S'], sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'],
  nice: ['-n'], timeout: ['-s', '-k'], xargs: ['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a'],
}));
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const GIT_VALUED = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);
// gh command group -> its write verbs (one line per group).
const GH_WRITES = new Map(Object.entries({
  pr: ['create', 'edit', 'comment', 'review', 'merge', 'close', 'ready', 'reopen'],
  issue: ['create', 'edit', 'comment', 'close', 'reopen', 'delete', 'transfer', 'lock', 'unlock', 'pin', 'unpin'],
  release: ['create', 'edit', 'delete', 'delete-asset', 'upload'],
  repo: ['create', 'edit', 'delete', 'rename', 'archive', 'unarchive', 'sync', 'set-default'],
  label: ['create', 'edit', 'delete', 'clone'],
  workflow: ['run', 'enable', 'disable'],
  run: ['rerun', 'cancel', 'delete'],
  gist: ['create', 'edit', 'delete', 'clone'],
  secret: ['set', 'delete'],
  variable: ['set', 'delete'],
}).map(([group, verbs]) => [group, new Set(verbs)]));
const GH_FIELDS = new Set(['-f', '-F', '--field', '--raw-field', '--input']);
const GH_VALUED = new Set(['-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '-p', '--preview', '--cache']);

function decodeAnsiC(s) {
  return s.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/gs, (_, e) => {
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return { n: '\n', t: '\t' }[e] ?? e;
  });
}

// Reads one shell word from src[i]: quote removal, backslash escapes, $VAR from env,
// and command substitutions (parsed into item lists, replaced by SUBST in the value).
function readWord(src, i, env) {
  let value = '';
  const subs = [];
  let inDq = false;
  if (src[i] === '~' && (i + 1 === src.length || src[i + 1] === '/' || META.has(src[i + 1]))) {
    value = env.HOME || '~';
    i++;
  }
  while (i < src.length) {
    const c = src[i];
    if (!inDq && META.has(c)) break;
    if (c === '\\') {
      const n = src[i + 1];
      if (n === '\n') { i += 2; continue; }
      if (inDq && !(n && '$`"\\'.includes(n))) { value += c; i++; continue; }
      value += n ?? '';
      i += 2;
      continue;
    }
    if (c === "'" && !inDq) {
      const k = src.indexOf("'", i + 1);
      const e = k < 0 ? src.length : k;
      value += src.slice(i + 1, e);
      i = e + 1;
      continue;
    }
    if (c === '$' && src[i + 1] === "'" && !inDq) {
      let j = i + 2;
      while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
      value += decodeAnsiC(src.slice(i + 2, j));
      i = j + 1;
      continue;
    }
    if (c === '"') { inDq = !inDq; i++; continue; }
    if (c === '$' && src[i + 1] === '(') {
      const sub = parseScript(src, i + 2, env, true);
      subs.push(sub.items);
      value += SUBST;
      i = sub.end + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
      subs.push(parseScript(src.slice(i + 1, j), 0, env, false).items);
      value += SUBST;
      i = j + 1;
      continue;
    }
    if (c === '$') {
      VAR_RE.lastIndex = i;
      const m = VAR_RE.exec(src);
      const name = m && (m[1] || m[2]);
      if (name && env[name] !== undefined) { value += env[name]; i = VAR_RE.lastIndex; continue; }
    }
    value += c;
    i++;
  }
  return { value, end: i, subs };
}

// Splits src into simple-command segments ({argv, heredocs, subs}) and subshell markers
// ({op}). Heredoc bodies are kept as text, not parsed. inSub: stop at the unmatched ')'.
function parseScript(src, i, env, inSub) {
  const items = [];
  const pending = [];
  let seg = { argv: [], heredocs: [], subs: [] };
  let depth = 0;
  const endSeg = () => {
    if (seg.argv.length || seg.subs.length) items.push(seg);
    seg = { argv: [], heredocs: [], subs: [] };
  };
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '\n') {
      endSeg();
      i++;
      for (const h of pending.splice(0)) {
        const lines = [];
        while (i < src.length) {
          let e = src.indexOf('\n', i);
          if (e < 0) e = src.length;
          const line = src.slice(i, e);
          i = e + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
          lines.push(line);
        }
        h.seg.heredocs.push(lines.join('\n'));
      }
      continue;
    }
    if (c === '<' || c === '>' || (c === '&' && src[i + 1] === '>')) {
      const op = /^(?:<<<|<<-|<<|&>>|&>|>>|>&|<&|>\||<>|<|>)/.exec(src.slice(i))[0];
      i += op.length;
      while (src[i] === ' ' || src[i] === '\t') i++;
      const w = readWord(src, i, env);
      i = w.end;
      seg.subs.push(...w.subs);
      if (op === '<<' || op === '<<-') pending.push({ seg, delim: w.value, strip: op === '<<-' });
      continue;
    }
    if (c === ';' || c === '&' || c === '|') {
      endSeg();
      i += src[i + 1] === c ? 2 : 1;
      continue;
    }
    if (c === '(') { endSeg(); items.push({ op: '(' }); depth++; i++; continue; }
    if (c === ')') {
      endSeg();
      if (inSub && depth === 0) return { items, end: i };
      items.push({ op: ')' });
      depth--;
      i++;
      continue;
    }
    const w = readWord(src, i, env);
    i = w.end;
    seg.subs.push(...w.subs);
    if (/^\d+$/.test(w.value) && (src[i] === '<' || src[i] === '>')) continue; // fd of a redirect
    seg.argv.push(w.value);
  }
  endSeg();
  return { items, end: i };
}

// Strips VAR=value prefixes and wrapper commands; null when the command is not executed.
function unwrap(argv) {
  const assigns = {};
  let k = 0;
  for (;;) {
    let m;
    while (k < argv.length && (m = ASSIGN_RE.exec(argv[k]))) { assigns[m[1]] = m[2]; k++; }
    const name = path.basename(argv[k] || '');
    const valued = WRAPPERS.get(name);
    if (!valued) break;
    k++;
    if (name === 'command' && /^-[a-zA-Z]*[vV]/.test(argv[k] || '')) return null;
    while (k < argv.length && argv[k].startsWith('-')) {
      if (argv[k] === '--') { k++; break; }
      k += valued.includes(argv[k]) ? 2 : 1;
    }
    if (name === 'timeout') k++;
  }
  let rest = argv.slice(k);
  // A word like `git\ push` is one argv entry; split it anyway (fail closed).
  if (rest.length && /\s/.test(rest[0])) rest = [...rest[0].split(/\s+/).filter(Boolean), ...rest.slice(1)];
  return { argv: rest, assigns };
}

function cdTarget(argv, cwd, env) {
  const d = argv.slice(1).filter(a => !/^-(-|[LPe@]+)$/.test(a))[0];
  if (d === undefined) return env.HOME || null;
  if (d === '-') return null;
  if (path.isAbsolute(d)) return d;
  return cwd && path.resolve(cwd, d);
}

// The script string of `bash -c <script>` (any -c cluster such as -lc), else null.
function shellScript(argv) {
  for (let k = 1; k < argv.length; k++) {
    const a = argv[k];
    if (a === '-o' || a === '+o' || a === '-O' || a === '+O') { k++; continue; }
    if (!/^[-+]/.test(a)) return null;
    if (/^-[a-zA-Z]*c/.test(a)) return argv[k + 1] ?? '';
  }
  return null;
}

function normSlug(v) {
  const m = /([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(v || '');
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

// A publish segment as { kind, dir } (git) or { kind, dir, explicit } (gh), else null.
function classify(argv, assigns, cwd, env) {
  const prog = path.basename(argv[0]);
  if (prog === 'git') {
    let dir = cwd;
    let unresolved = 'GIT_DIR' in assigns || 'GIT_WORK_TREE' in assigns;
    let k = 1;
    while (k < argv.length && argv[k].startsWith('-')) {
      const a = argv[k];
      if (/^--(git-dir|work-tree)(=|$)/.test(a)) unresolved = true;
      if (a === '-C') {
        const v = argv[k + 1] ?? '';
        dir = path.isAbsolute(v) ? v : dir && path.resolve(dir, v);
      }
      k += a === '-C' || GIT_VALUED.has(a) ? 2 : 1;
    }
    if (argv[k] !== 'push') return null;
    return { kind: 'git', dir: unresolved ? null : dir };
  }
  if (prog !== 'gh') return null;
  const group = argv[1];
  let repo = null;
  let method = null;
  let fields = false;
  const pos = [];
  for (let k = 2; k < argv.length; k++) {
    const a = argv[k];
    if (a === '-R' || a === '--repo') repo = argv[++k] ?? '';
    else if (/^(-R|--repo=)/.test(a)) repo = a.replace(/^(-R|--repo=)/, '');
    else if (a === '-X' || a === '--method') method = argv[++k] ?? '';
    else if (/^(-X|--method=)/.test(a)) method = a.replace(/^(-X|--method=)/, '');
    else if (GH_FIELDS.has(a)) { fields = true; k++; }
    else if (/^(-[fF].|--(field|raw-field|input)=)/.test(a)) fields = true;
    else if (GH_VALUED.has(a)) k++;
    else if (!a.startsWith('-')) pos.push(a);
  }
  // gh sends POST once fields are present unless -X says otherwise.
  const write = group === 'api'
    ? (method !== null ? method.toUpperCase() !== 'GET' : fields)
    : Boolean(GH_WRITES.get(group)?.has(pos[0]));
  if (!write) return null;
  // Every explicit target must be the advisor repo; the cwd origin is the last resort.
  const explicit = [];
  if (group === 'api') {
    const m = /(?:^|\/)repos\/([^/{}?]+)\/([^/{}?]+)/.exec(pos[0] || '');
    if (m) explicit.push(`${m[1]}/${m[2]}`.toLowerCase());
  }
  for (const a of pos) {
    const m = /github\.com[/:]([^/]+)\/([^/]+)\/(?:pull|issues)\/\d+/.exec(a);
    if (m) explicit.push(`${m[1]}/${m[2]}`.toLowerCase());
  }
  if (group === 'repo' && pos[1] !== undefined) explicit.push(normSlug(pos[1]));
  if (group === 'gist') explicit.push(null); // a gist targets no repo: unresolvable
  if (repo !== null) explicit.push(normSlug(repo));
  if (assigns.GH_REPO !== undefined) explicit.push(normSlug(assigns.GH_REPO));
  if (env.GH_REPO) explicit.push(normSlug(env.GH_REPO));
  return { kind: 'gh', dir: cwd, explicit };
}

function analyze(items, cwd, env, out, depth) {
  if (depth > MAX_DEPTH) { out.push({ text: '(nesting too deep)', kind: 'git', dir: null }); return; }
  const stack = [];
  for (const it of items) {
    if (it.op === '(') { stack.push(cwd); continue; }
    if (it.op === ')') { if (stack.length) cwd = stack.pop(); continue; }
    for (const s of it.subs) analyze(s, cwd, env, out, depth + 1);
    const u = unwrap(it.argv);
    if (!u || !u.argv.length) continue;
    const { argv, assigns } = u;
    const prog = path.basename(argv[0]);
    const parse = s => parseScript(s, 0, env, false).items;
    if (prog === 'cd' || prog === 'pushd') { cwd = cdTarget(argv, cwd, env); continue; }
    if (prog === 'popd') { cwd = null; continue; }
    if (prog === 'eval') { analyze(parse(argv.slice(1).join(' ')), cwd, env, out, depth + 1); continue; }
    if (SHELLS.has(prog)) {
      const script = shellScript(argv);
      for (const s of script !== null ? [script] : it.heredocs) analyze(parse(s), cwd, env, out, depth + 1);
      continue;
    }
    const f = classify(argv, assigns, cwd, env);
    if (f) out.push({ text: it.argv.join(' ').replaceAll(SUBST, '$(...)'), ...f });
  }
}

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null; // not a repo, missing dir, or a SUBST placeholder in the path
  }
}

function isAdvisorTarget(f, adv) {
  if (f.kind === 'git') {
    const top = f.dir && git(f.dir, ['rev-parse', '--show-toplevel']);
    return Boolean(top) && top === git(adv, ['rev-parse', '--show-toplevel']);
  }
  const advSlug = normSlug(git(adv, ['remote', 'get-url', 'origin']));
  const slugs = f.explicit.length ? f.explicit : [f.dir && normSlug(git(f.dir, ['remote', 'get-url', 'origin']))];
  return Boolean(advSlug) && slugs.every(s => s === advSlug);
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => {
    let msg;
    try { msg = JSON.parse(raw); } catch { process.exit(0); }
    const command = msg && msg.tool_name === 'Bash' && msg.tool_input && msg.tool_input.command;
    if (typeof command !== 'string') process.exit(0);

    const env = process.env;
    const findings = [];
    analyze(parseScript(command, 0, env, false).items, msg.cwd || process.cwd(), env, findings, 0);
    if (!findings.length) process.exit(0);

    const adv = env.ADV || path.resolve(__dirname, '..', '..');
    const blocked = env.ADVISOR_SID ? findings : findings.filter(f => !isAdvisorTarget(f, adv));
    if (!blocked.length) process.exit(0);
    for (const f of blocked) {
      process.stdout.write(`publish-guard: ${f.text} - publish through bin/advisor-publish (claude.md, Publish gate)\n`);
    }
    process.exit(2);
  });
}
