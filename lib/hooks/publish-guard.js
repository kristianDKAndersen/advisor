#!/usr/bin/env node
// PreToolUse hook (Bash): blocks raw git/gh publish commands so outward publishes go through bin/advisor-publish.
// It guards against careless or prompt-injected agents; it is a string parser, not a sandbox.
// Exit 2 blocks (reason on stderr and stdout); malformed JSON exits 0, an internal error exits 2.
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

const SUBST = '\u0000'; // stands in for $(...) output: never part of a real path
const DYN = '\u0001'; // precedes an expansion the hook cannot resolve ($VAR not in its env, ${...}, $1)
const META = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);
const VAR_RE = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/y;
const ASSIGN_RE = /^([A-Za-z_]\w*)=(.*)$/s;
const MAX_DEPTH = 16;
const MAX_COMMAND = 1 << 20; // longer commands are blocked unread
const MAX_FINDINGS = 50; // more publish segments are blocked unresolved: a hook timeout fails open

// Prefix words that run the rest of argv as a command -> their options that take a value.
const WRAPPERS = new Map(Object.entries({
  command: [], builtin: [], exec: ['-a'], nohup: [], time: [], noglob: [],
  '!': [], '{': [], if: [], then: [], else: [], elif: [], do: [], while: [], until: [],
  env: ['-u', '-C'], sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'],
  nice: ['-n'], timeout: ['-s', '-k'], xargs: ['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a'],
  caffeinate: ['-t', '-w'], stdbuf: ['-i', '-o', '-e'], arch: ['-arch', '-e'], doas: ['-u', '-C'],
  unbuffer: [], chronic: [], watch: ['-n'], parallel: ['-j', '-S', '-a', '--jobs', '--sshlogin'],
}));
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const GIT_VALUED = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);
// gh groups that act on one repo, and groups whose writes target an account or project instead.
const GH_REPO_GROUPS = new Set(['pr', 'issue', 'release', 'repo', 'label', 'workflow', 'run', 'secret', 'variable',
  'cache', 'ruleset', 'attestation', 'agent-task']);
const GH_ACCOUNT_GROUPS = new Set(['gist', 'ssh-key', 'gpg-key', 'project', 'extension', 'codespace', 'alias']);
// gh groups with no write subcommand (gh 2.80.0) and help topics. Any unknown group (an alias such as
// the default `co`, which `gh alias set --clobber` can redefine, or an extension) counts as a write with no resolvable target.
const GH_READ_GROUPS = new Set(['', 'search', 'status', 'browse', 'org', 'config', 'completion', 'preview',
  'help', 'version', 'accessibility', 'actions', 'environment', 'exit-codes', 'formatting', 'mintty', 'reference']);
// Read-only verbs of the groups above (gh 2.80.0, plus every *-list); any other verb counts as a write.
const GH_READ_VERBS = new Set(['view', 'list', 'status', 'checks', 'diff', 'checkout', 'clone', 'download', 'watch',
  'browse', 'get', 'check', 'verify', 'trusted-root', 'logs', 'search']);
const GH_SUBGROUPS = new Set(['deploy-key', 'autolink', 'gitignore', 'license', 'ports']);
const GH_FIELDS = new Set(['-f', '-F', '--field', '--raw-field']);
const GH_VALUED = new Set(['-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '-p', '--preview', '--cache']);
// Text flags outside gh api: their values never name a target.
const GH_TEXT = new Set(['-b', '--body', '-F', '--body-file', '--title', '-n', '--notes', '--notes-file', '-m', '--subject', '--description']);

function decodeAnsiC(s) {
  return s.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/gs, (_, e) => {
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return { n: '\n', t: '\t' }[e] ?? e;
  });
}

// Reads one shell word from src[i]: quote removal, backslash escapes, $VAR from env,
// and command substitutions (parsed into item lists, replaced by SUBST in the value).
function readWord(src, i, env, depth) {
  let value = '';
  let quoted = false; // a quoted heredoc delimiter keeps the body literal
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
      quoted = true;
      const n = src[i + 1];
      if (n === '\n') { i += 2; continue; }
      if (inDq && !(n && '$`"\\'.includes(n))) { value += c; i++; continue; }
      value += n ?? '';
      i += 2;
      continue;
    }
    if (c === "'" && !inDq) {
      quoted = true;
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
    if (c === '"') { inDq = !inDq; quoted = true; i++; continue; }
    if (c === '$' && src[i + 1] === '(') {
      const sub = parseScript(src, i + 2, env, true, depth + 1);
      subs.push(sub.items);
      value += SUBST;
      i = sub.end + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
      subs.push(parseScript(src.slice(i + 1, j), 0, env, false, depth + 1).items);
      value += SUBST;
      i = j + 1;
      continue;
    }
    if (c === '$') {
      VAR_RE.lastIndex = i;
      const m = VAR_RE.exec(src);
      const name = m && (m[1] || m[2]);
      if (name && env[name] !== undefined) { value += env[name]; i = VAR_RE.lastIndex; continue; }
      if (/[\w{@*#?$!-]/.test(src[i + 1] ?? '')) value += DYN;
    }
    value += c;
    i++;
  }
  return { value, end: i, subs, quoted };
}

// Splits src into simple-command segments ({argv, heredocs, subs}) and subshell markers
// ({op}). Heredoc bodies stay text; an unquoted one also yields its $(...). inSub: stop at the unmatched ')'.
function parseScript(src, i, env, inSub, nest = 0) {
  if (nest > MAX_DEPTH) throw new Error(`nesting deeper than ${MAX_DEPTH}`);
  const items = [];
  const pending = [];
  let seg = { argv: [], heredocs: [], subs: [] };
  let depth = 0;
  const endSeg = () => {
    // A bare `G=git` sets a shell variable that later words expand ($G push).
    if (seg.argv.length && seg.argv.every(a => ASSIGN_RE.test(a))) {
      for (const a of seg.argv) { const m = ASSIGN_RE.exec(a); env[m[1]] = m[2]; }
    }
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
        if (h.expand) h.seg.subs.push(...bodySubs(lines.join('\n'), env, nest));
      }
      continue;
    }
    if (c === '<' || c === '>' || (c === '&' && src[i + 1] === '>')) {
      const op = /^(?:<<<|<<-|<<|&>>|&>|>>|>&|<&|>\||<>|<|>)/.exec(src.slice(i))[0];
      i += op.length;
      while (src[i] === ' ' || src[i] === '\t') i++;
      const w = readWord(src, i, env, nest);
      i = w.end;
      seg.subs.push(...w.subs);
      if (op === '<<' || op === '<<-') pending.push({ seg, delim: w.value, strip: op === '<<-', expand: !w.quoted });
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
    const w = readWord(src, i, env, nest);
    i = w.end;
    seg.subs.push(...w.subs);
    if (/^\d+$/.test(w.value) && (src[i] === '<' || src[i] === '>')) continue; // fd of a redirect
    seg.argv.push(w.value);
  }
  endSeg();
  return { items, end: i };
}

// Command substitutions in an unquoted heredoc body (the shell runs them).
function bodySubs(body, env, depth) {
  const subs = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') i++;
    else if (body[i] === '$' && body[i + 1] === '(') {
      const s = parseScript(body, i + 2, env, true, depth + 1);
      subs.push(s.items);
      i = s.end;
    } else if (body[i] === '`') {
      let j = i + 1;
      while (j < body.length && body[j] !== '`') j += body[j] === '\\' ? 2 : 1;
      subs.push(parseScript(body.slice(i + 1, j), 0, env, false, depth + 1).items);
      i = j;
    }
  }
  return subs;
}

// Strips VAR=value prefixes and wrapper commands; null when the command is not executed.
// xargs: the command gets more arguments from stdin.
function unwrap(argv) {
  const assigns = {};
  let xargs = false;
  let envUsed = false;
  let k = 0;
  for (;;) {
    let m;
    while (k < argv.length && (m = ASSIGN_RE.exec(argv[k]))) { assigns[m[1]] = m[2]; k++; }
    const name = path.basename(argv[k] || '');
    const valued = WRAPPERS.get(name);
    if (!valued) break;
    if (name === 'xargs' || name === 'parallel') xargs = true;
    if (name === 'env' || name === 'sudo' || name === 'doas') envUsed = true; // each can set or reset the env
    k++;
    if (name === 'command' && /^-[a-zA-Z]*[vV]/.test(argv[k] || '')) return null;
    while (k < argv.length && argv[k].startsWith('-')) {
      if (name === 'exec' && /^-[a-zA-Z]*c/.test(argv[k])) envUsed = true; // exec -c clears the env
      if (argv[k] === '--') { k++; break; }
      if (name === 'env' && /^(-S|--split-string)/.test(argv[k])) { // env -S 'git push' splits its value into argv
        const joined = /^(-S|--split-string)$/.test(argv[k]);
        const v = joined ? argv[k + 1] ?? '' : argv[k].replace(/^(-S|--split-string=)/, '');
        argv = [...argv.slice(0, k), ...v.split(/\s+/).filter(Boolean), ...argv.slice(k + (joined ? 2 : 1))];
        break;
      }
      k += valued.includes(argv[k]) ? 2 : 1;
    }
    if (name === 'timeout') k++;
  }
  let rest = argv.slice(k);
  // A word like `git\ push` is one argv entry; split it anyway (fail closed).
  if (rest.length && /\s/.test(rest[0])) rest = [...rest[0].split(/\s+/).filter(Boolean), ...rest.slice(1)];
  return { argv: rest, assigns, xargs, env: envUsed };
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

// A publish segment as { kind, dir, remote } (git) or { kind, dir, useCwd, explicit } (gh);
// { kind: 'remote-mut' } for a git command that rewrites push destinations; else null.
function classify(argv, assigns, xargs, cwd) {
  const prog = path.basename(argv[0]);
  if (prog === 'git' || /^git-(push|send-pack|http-push)$/.test(prog)) {
    let dir = cwd;
    // Config or env that can rewrite the push destination leaves the target unresolved.
    let unresolved = xargs || Object.keys(assigns).some(n => n.startsWith('GIT_'))
      || 'GIT_CONFIG_PARAMETERS' in process.env || 'GIT_CONFIG_COUNT' in process.env;
    let alias = false;
    let k = prog === 'git' ? 1 : 0;
    while (k > 0 && k < argv.length && argv[k].startsWith('-')) {
      const a = argv[k];
      if (/^(-c|--config-env|--git-dir|--work-tree|--exec-path)/.test(a)) unresolved = true;
      if (/^(-c|--config-env)$/.test(a) ? /^alias\./i.test(argv[k + 1] ?? '') : /^(-c|--config-env=)alias\./i.test(a)) alias = true;
      if (a === '-C') {
        const v = argv[k + 1] ?? '';
        dir = path.isAbsolute(v) ? v : dir && path.resolve(dir, v);
      }
      k += a === '-C' || GIT_VALUED.has(a) ? 2 : 1;
    }
    const sub = k > 0 ? argv[k] : prog.slice(4);
    const rest = argv.slice(k + 1);
    if (/[\0$*?[{]/.test(sub ?? '')) return { kind: 'git', dir: null }; // a computed subcommand may be push
    if (sub === 'remote' && /^(add|set-url|rename|remove|rm)$/.test(rest[0] ?? '')) return { kind: 'remote-mut' };
    if (sub === 'config' && rest.some(a => /^(remote|url|branch)\.|insteadof|pushdefault/i.test(a))
      && !rest.some(a => /^(--get|--list$|-l$|get$|list$)/.test(a))) return { kind: 'remote-mut' };
    // Publish forms other than a plain `git push` never resolve to the advisor repo.
    const other = k === 0 || /^(send-pack|http-push|send-email)$/.test(sub ?? '')
      || ((sub === 'subtree' || sub === 'lfs') && rest.includes('push')) || (sub === 'svn' && rest.includes('dcommit'))
      || alias || (xargs && !/^[a-z][a-z-]*$/.test(sub ?? ''));
    if (other) return { kind: 'git', dir: null };
    if (sub !== 'push') return null;
    let remote;
    for (let j = 0; j < rest.length && remote === undefined; j++) {
      const a = rest[j];
      if (/^--(repo|receive-pack|exec)(=|$)/.test(a)) unresolved = true;
      else if (a === '-o' || a === '--push-option') j++;
      else if (a === '--') remote = rest[j + 1] ?? '';
      else if (!a.startsWith('-')) remote = a;
    }
    return { kind: 'git', dir: unresolved ? null : dir, remote };
  }
  if (prog !== 'gh') return null;
  const group = argv[1] ?? '';
  let repo = null;
  let method = null;
  let input = false;
  let orgLevel = false;
  const fields = [];
  const pos = [];
  for (let k = 2; k < argv.length; k++) {
    const a = argv[k];
    if (a === '-R' || a === '--repo') repo = argv[++k] ?? '';
    else if (/^(-R|--repo=)/.test(a)) repo = a.replace(/^(-R|--repo=)/, '');
    else if (a === '-X' || a === '--method') method = argv[++k] ?? '';
    else if (/^(-X|--method=)/.test(a)) method = a.replace(/^(-X|--method=)/, '');
    else if (group === 'api' && /^--input(=|$)/.test(a)) { input = true; if (a === '--input') k++; }
    else if (group === 'api' && GH_FIELDS.has(a)) fields.push(argv[++k] ?? '');
    else if (group === 'api' && /^(-[fF].|--(field|raw-field)=)/.test(a)) fields.push(a.replace(/^(-[fF]|--(field|raw-field)=)/, ''));
    else if (GH_VALUED.has(a) || (group !== 'api' && GH_TEXT.has(a))) k++;
    else if (!a.startsWith('-')) pos.push(a);
    if ((group === 'secret' || group === 'variable') && /^(-o|--org|-u|--user)/.test(a)) orgLevel = true;
  }
  const explicit = [];
  let useCwd = repo === null;
  let write;
  if (group === 'api') {
    const ep = pos[0] || '';
    if (ep === 'graphql' || ep.endsWith('/graphql')) {
      // Only a mutation writes; a query from a file, --input or an expansion cannot be read here.
      const queries = fields.filter(f => f.startsWith('query=')).map(f => f.slice(6));
      write = input || !queries.length || queries.some(q => q.startsWith('@') || /[\0\u0001]|\bmutation\b/i.test(q));
      explicit.push(null); // node IDs name no repo
    } else {
      // gh sends POST once fields are present unless -X says otherwise.
      write = method !== null ? method.toUpperCase() !== 'GET' : fields.length > 0 || input;
      const m = /^\/?(?:https?:\/\/[^/]+\/)?repos\/([^/{}?]+)\/([^/{}?]+)(?:\/|$|\?)/.exec(ep);
      if (m) explicit.push(`${m[1]}/${m[2]}`.toLowerCase());
      else if (!/^\/?repos\/\{owner\}\/\{repo\}(\/|$)/.test(ep)) explicit.push(null); // /user, /orgs, /gists, ...
    }
    useCwd = !explicit.length;
  } else if (group === 'auth') {
    // A raw token lets a worker publish with curl; the Advisor may read it.
    return pos[0] === 'token' ? { kind: 'gh', workerOnly: true } : null;
  } else if (GH_READ_GROUPS.has(group) || group.startsWith('-')) {
    write = false;
  } else if (GH_REPO_GROUPS.has(group) || GH_ACCOUNT_GROUPS.has(group)) {
    const verb = GH_SUBGROUPS.has(pos[0]) ? pos[1] : pos[0];
    write = (verb !== undefined && !GH_READ_VERBS.has(verb) && !verb.endsWith('-list')) || (group === 'label' && verb === 'clone');
    if (GH_ACCOUNT_GROUPS.has(group) || orgLevel) explicit.push(null);
  } else {
    write = true; // an alias or extension can run any gh command
    explicit.push(null);
  }
  if (xargs && (write || !group || group === 'api')) { write = true; explicit.push(null); } // stdin may append the target
  if (!write) return null;
  if (group !== 'api') {
    // Only an argument that is exactly a PR/issue URL names a target; a URL inside body text does not.
    for (const a of argv.slice(2)) {
      const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/(?:pull|issues)\/\d+(?:[/?#]\S*)?$/.exec(a);
      if (!m) continue;
      explicit.push(`${m[1]}/${m[2]}`.toLowerCase());
      if (a === pos[1]) useCwd = false;
    }
  }
  if (group === 'repo' && pos[1] !== undefined) { explicit.push(normSlug(pos[1])); useCwd = false; }
  if (repo !== null) explicit.push(normSlug(repo));
  if (assigns.GH_REPO !== undefined) explicit.push(normSlug(assigns.GH_REPO));
  if (process.env.GH_REPO) explicit.push(normSlug(process.env.GH_REPO));
  if (assigns.GH_REPO !== undefined || process.env.GH_REPO) useCwd = false;
  return { kind: 'gh', dir: cwd, useCwd, explicit };
}

let remoteMutated = false; // set once a segment rewrites git remotes or push config; later pushes are unresolved
let envChanged = false; // set once a segment changes an exported variable; a later advisor-publish is blocked
const words = items => items.flatMap(s => [...(s.argv || []), ...(s.subs || []).flatMap(words)]);

function analyze(items, cwd, env, out, depth) {
  if (depth > MAX_DEPTH) { out.push({ text: '(nesting too deep)', kind: 'git', dir: null }); return; }
  const stack = [];
  for (const it of items) {
    if (it.op === '(') { stack.push(cwd); continue; }
    if (it.op === ')') { if (stack.length) cwd = stack.pop(); continue; }
    for (const s of it.subs) analyze(s, cwd, env, out, depth + 1);
    const u = unwrap(it.argv);
    if (!u) continue;
    if (!u.argv.length) { if (Object.keys(u.assigns).some(n => n in process.env)) envChanged = true; continue; }
    const { argv, assigns, xargs } = u;
    const prog = path.basename(argv[0]);
    const text = it.argv.join(' ').replaceAll(SUBST, '$(...)').replaceAll(DYN, '');
    const parse = s => parseScript(s, 0, env, false).items;
    // A computed program name ($(...), $VAR, {a,b}, a glob) is opaque: a worker may not run one near git/gh/push.
    const opaque = argv[0] !== '[' && argv[0] !== '[[' && /[\0$*?[]|\{[^}]*,[^}]*\}/.test(argv[0]);
    if ((opaque || (prog === 'eval' && argv.some(a => a.includes(SUBST))))
      && [...argv, ...it.subs.flatMap(words)].some(w => /\b(git|gh|push|send-pack)\b/.test(w))) {
      out.push({ text, kind: 'opaque', workerOnly: true });
    }
    if (/^(export|unset|declare|typeset|source|\.)$/.test(prog)) envChanged = true;
    // advisor-publish passes only as a plain call: no env or PATH change and no --policy-paths, in either mode.
    // Only the Advisor publishes: a worker may dry-run the gate but not pass --execute.
    const apArg = /^(bun|node|bash|sh|zsh)$/.test(prog) ? argv.slice(1).find(a => !a.startsWith('-') && a !== 'run') : argv[0];
    if (path.basename(apArg || '') === 'advisor-publish'
      && (u.env || xargs || Object.keys(assigns).length || envChanged || argv.some(a => /^--policy-paths(=|$)/.test(a))
        || (process.env.ADVISOR_SID && argv.includes('--execute')))) {
      out.push({ text, kind: 'advisor-publish', always: true });
      continue;
    }
    if (prog === 'cd' || prog === 'pushd') { cwd = cdTarget(argv, cwd, env); continue; }
    if (prog === 'popd') { cwd = null; continue; }
    if (prog === 'eval') { analyze(parse(argv.slice(1).join(' ')), cwd, env, out, depth + 1); continue; }
    if (SHELLS.has(prog)) {
      const script = shellScript(argv);
      for (const s of script !== null ? [script] : it.heredocs) analyze(parse(s), cwd, env, out, depth + 1);
      continue;
    }
    if (prog === 'find') { // -exec/-execdir/-ok/-okdir run argv up to ';' or '+'
      for (let j = 1; j < argv.length; j++) {
        if (!/^-(exec|execdir|ok|okdir)$/.test(argv[j])) continue;
        let e = j + 1;
        while (e < argv.length && argv[e] !== ';' && argv[e] !== '+') e++;
        analyze([{ argv: argv.slice(j + 1, e), subs: [], heredocs: [] }], cwd, env, out, depth + 1);
        j = e;
      }
      continue;
    }
    const f = classify(argv, assigns, xargs, cwd);
    if (!f) continue;
    if (f.kind === 'remote-mut') { remoteMutated = true; continue; }
    if (f.kind === 'git' && remoteMutated) f.dir = null;
    if (f.kind === 'gh' && f.useCwd && remoteMutated) f.explicit.push(null);
    out.push({ text, ...f });
  }
}

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || null;
  } catch {
    return null; // not a repo, missing dir, a SUBST placeholder in the path, or a timeout
  }
}

function isAdvisorTarget(f, adv) {
  if (f.always) return false;
  if (f.workerOnly) return true;
  const advSlug = normSlug(git(adv, ['remote', 'get-url', 'origin']));
  if (!advSlug) return false;
  if (f.kind === 'git') {
    // The identity is the push URL of the remote git would use, not the checkout path.
    if (!f.dir) return false;
    const remote = f.remote ?? pushRemote(f.dir);
    if (!(git(f.dir, ['remote']) || '').split('\n').includes(remote)) return false; // a URL or a path
    return normSlug(git(f.dir, ['remote', 'get-url', '--push', remote])) === advSlug;
  }
  const slugs = [...f.explicit, ...(f.useCwd ? cwdSlugs(f.dir) : [])];
  return slugs.length > 0 && slugs.every(s => s === advSlug);
}

// The remote a bare `git push` uses: branch pushRemote, remote.pushDefault, branch remote, else origin.
function pushRemote(dir) {
  const branch = (git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']) || '').toLowerCase();
  const cfg = new Map();
  for (const l of (git(dir, ['config', '--get-regexp', '^(remote\\.pushdefault|branch\\..*\\.(pushremote|remote))$']) || '').split('\n')) {
    const sp = l.indexOf(' ');
    if (sp > 0) cfg.set(l.slice(0, sp).toLowerCase(), l.slice(sp + 1));
  }
  return cfg.get(`branch.${branch}.pushremote`) ?? cfg.get('remote.pushdefault') ?? cfg.get(`branch.${branch}.remote`) ?? 'origin';
}

// Repo slugs gh may pick from the cwd: the gh-resolved remote when one is set, else every remote.
function cwdSlugs(dir) {
  if (!dir) return [null];
  const urls = new Map();
  for (const l of (git(dir, ['remote', '-v']) || '').split('\n')) {
    const m = /^(\S+)\t(\S+) \(fetch\)$/.exec(l);
    if (m) urls.set(m[1], m[2]);
  }
  const resolved = (git(dir, ['config', '--get-regexp', '^remote\\..*\\.gh-resolved$']) || '').split('\n')
    .filter(Boolean).map(l => l.slice('remote.'.length, l.indexOf(' ') - '.gh-resolved'.length));
  const names = resolved.length ? resolved : [...urls.keys()];
  return names.length ? names.map(n => normSlug(urls.get(n))) : [null];
}

// Findings to block: all of them in a worker, else those whose target is not the advisor repo.
function check(command, cwd) {
  if (command.length > MAX_COMMAND) return [{ text: `(command longer than ${MAX_COMMAND} characters)` }];
  const vars = { ...process.env };
  const findings = [];
  analyze(parseScript(command, 0, vars, false).items, cwd, vars, findings, 0);
  if (process.env.ADVISOR_SID || findings.length > MAX_FINDINGS) return findings;
  const adv = process.env.ADV || path.resolve(__dirname, '..', '..');
  return findings.filter(f => !isAdvisorTarget(f, adv));
}

if (require.main === module) {
  const block = texts => {
    const reason = texts.map(t => `publish-guard: ${t} - publish through bin/advisor-publish (claude.md, Guardrails)\n`).join('');
    process.stderr.write(reason);
    process.stdout.write(reason);
    process.exit(2);
  };
  process.on('uncaughtException', e => block([`(internal error: ${e.message})`]));
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => {
    let msg;
    try { msg = JSON.parse(raw); } catch { process.exit(0); }
    const command = msg && msg.tool_name === 'Bash' && msg.tool_input && msg.tool_input.command;
    if (typeof command !== 'string') process.exit(0);
    let blocked;
    try {
      blocked = check(command, msg.cwd || process.cwd());
    } catch (e) {
      blocked = [{ text: `(command not analyzable: ${e.message})` }];
    }
    if (blocked.length) block(blocked.map(f => f.text));
    process.exit(0);
  });
}
