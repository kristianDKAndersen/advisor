import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { spawnSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const HOOK = path.join(REPO_ROOT, 'lib', 'hooks', 'publish-guard.js');

let tmp, adv, other, noOrigin, plain;

function initRepo(dir, origin) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  if (origin) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'publish-guard-')));
  adv = path.join(tmp, 'advisor');
  other = path.join(tmp, 'ai-koala');
  noOrigin = path.join(tmp, 'no-origin');
  plain = path.join(tmp, 'plain');
  initRepo(adv, 'git@github.com:me/advisor.git');
  initRepo(other, 'https://github.com/org/ai-koala.git');
  initRepo(noOrigin);
  fs.mkdirSync(plain);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// The hook only inspects the command string; nothing here runs a real push or gh call.
function runHook(command, cwd, extraEnv = {}) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: tmp, ADV: adv, ...extraEnv },
  });
}

function expectBlocked(r) {
  expect(r.status).toBe(2);
  expect(r.stdout).toMatch(/^publish-guard: .+ - publish through bin\/advisor-publish \(claude\.md, Guardrails\)$/m);
}

function expectAllowed(r) {
  expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: '' });
}

describe('spec cases', () => {
  test('PG-1: blocks git push origin x in a non-advisor repo', () => {
    const r = runHook('git push origin x', other);
    expectBlocked(r);
    expect(r.stdout).toBe('publish-guard: git push origin x - publish through bin/advisor-publish (claude.md, Guardrails)\n');
  });

  test('PG-2: blocks cd <repo> && git push (cd tracked away from the advisor cwd)', () => {
    expectBlocked(runHook(`cd '${other}' && git push`, adv));
  });

  test('PG-3: blocks git -C <repo> push from the advisor cwd', () => {
    expectBlocked(runHook(`git -C '${other}' push`, adv));
  });

  test('PG-4: blocks FOO=1 git push in a non-advisor repo', () => {
    expectBlocked(runHook('FOO=1 git push', other));
  });

  test('PG-5: allows git push with cwd at the advisor repo', () => {
    expectAllowed(runHook('git push', adv));
  });

  test('PG-6: blocks gh pr comment in a repo with no origin (unresolved target fails closed)', () => {
    expectBlocked(runHook('gh pr comment 17 --body x', noOrigin));
  });

  test('PG-7: blocks gh pr comment -R org/ai-koala from the advisor cwd', () => {
    expectBlocked(runHook('gh pr comment 17 -R org/ai-koala --body x', adv));
  });

  test('PG-8: blocks GH_REPO=org/ai-koala gh pr comment from the advisor cwd', () => {
    expectBlocked(runHook('GH_REPO=org/ai-koala gh pr comment 17 --body x', adv));
  });

  test('PG-9: blocks gh api -X POST repos/org/ai-koala/... -f body=x from the advisor cwd', () => {
    expectBlocked(runHook('gh api -X POST repos/org/ai-koala/issues/1/comments -f body=x', adv));
  });

  test('PG-10: allows plain gh pr create from the advisor cwd (target resolves to me/advisor)', () => {
    expectAllowed(runHook('gh pr create', adv));
  });

  test('PG-11: allows gh pr view 17', () => {
    expectAllowed(runHook('gh pr view 17', other));
  });

  test('PG-12: allows gh api repos/o/r/pulls/17/comments (GET read)', () => {
    expectAllowed(runHook('gh api repos/o/r/pulls/17/comments', other));
  });

  test('PG-13: blocks gh api -X POST repos/o/r/issues/1/comments', () => {
    expectBlocked(runHook('gh api -X POST repos/o/r/issues/1/comments', adv));
  });

  test('PG-14: blocks gh api repos/o/r/issues/1/comments -f body=x', () => {
    expectBlocked(runHook('gh api repos/o/r/issues/1/comments -f body=x', adv));
  });

  test('PG-15: allows bin/advisor-publish --repo <repo> --execute from any cwd, and its dry run in a worker', () => {
    const cmd = `bin/advisor-publish --repo '${other}' --execute`;
    for (const cwd of [adv, other, noOrigin, plain]) {
      expectAllowed(runHook(cmd, cwd));
      expectAllowed(runHook(cmd.replace(' --execute', ''), cwd, { ADVISOR_SID: 'x' }));
    }
  });

  test('PG-16: allows echo "git push"', () => {
    expectAllowed(runHook('echo "git push"', other));
  });

  test('PG-17: blocks git push in the advisor repo when ADVISOR_SID is set', () => {
    expectBlocked(runHook('git push', adv, { ADVISOR_SID: 'x' }));
  });

  test('PG-18: malformed JSON exits 0', () => {
    const r = spawnSync('node', [HOOK], { input: '{not json', encoding: 'utf8', env: { PATH: process.env.PATH } });
    expectAllowed(r);
  });
});

describe('every listed write form', () => {
  const PR_WRITES = ['create', 'edit', 'comment', 'review', 'merge', 'close', 'ready', 'reopen'];

  test.each(PR_WRITES)('PG-20: blocks gh pr %s -R org/ai-koala from the advisor cwd', (sub) => {
    expectBlocked(runHook(`gh pr ${sub} 17 -R org/ai-koala`, adv));
  });

  test.each(PR_WRITES)('PG-21: blocks gh pr %s in a worker even when it targets the advisor repo', (sub) => {
    expectBlocked(runHook(`gh pr ${sub} 17`, adv, { ADVISOR_SID: 'x' }));
  });

  test.each([
    '-X PUT', '--method PATCH', '--method=DELETE', '-XPOST',
    '-f body=x', '-F n=1', '--field body=x', '--raw-field body=x', '--input body.json', '-fbody=x', '--field=body=x',
  ])('PG-22: blocks gh api repos/o/r/issues/1 %s', (flags) => {
    expectBlocked(runHook(`gh api repos/o/r/issues/1 ${flags}`, adv));
  });

  test('PG-23: allows gh api -X GET with -f query parameters (gh sends GET)', () => {
    expectAllowed(runHook('gh api -X GET search/issues -f q=x', other, { ADVISOR_SID: 'x' }));
  });

  test('PG-24: blocks gh issue comment -R org/ai-koala (sibling of gh pr comment)', () => {
    expectBlocked(runHook('gh issue comment 3 -R org/ai-koala --body x', adv));
  });

  test('PG-25: allows gh issue view and gh pr list', () => {
    expectAllowed(runHook('gh issue view 3 && gh pr list', other, { ADVISOR_SID: 'x' }));
  });

  test.each([
    'release create v1', 'release delete-asset v1 a.zip', 'repo edit --description x', 'repo set-default',
    'label clone src/repo', 'workflow run ci.yml', 'run rerun 42', 'gist create f.txt', 'secret set TOKEN',
    'variable delete NAME',
  ])('PG-26: blocks gh %s -R org/ai-koala from the advisor cwd and in a worker', (cmd) => {
    expectBlocked(runHook(`gh ${cmd} -R org/ai-koala`, adv));
    expectBlocked(runHook(`gh ${cmd}`, adv, { ADVISOR_SID: 'x' }));
  });

  test('PG-27: gh repo <verb> <owner/repo> targets the positional repo', () => {
    expectBlocked(runHook('gh repo delete org/ai-koala --yes', adv));
    expectBlocked(runHook('gh repo create org/new --public', adv));
    expectAllowed(runHook('gh repo edit me/advisor --description x', other));
  });

  test('PG-28: gh gist writes have no repo target, so they fail closed in the Advisor session', () => {
    expectBlocked(runHook('gh gist create notes.md', adv));
  });

  test('PG-29: allows gh pr checkout, gh release view, gh run list and gh repo clone', () => {
    expectAllowed(runHook('gh pr checkout 17 && gh release view v1 && gh run list && gh repo clone o/r', other, { ADVISOR_SID: 'x' }));
  });
});

describe('target resolution in the Advisor session', () => {
  test('PG-30: allows git -C <advisor> push from a non-advisor cwd', () => {
    expectAllowed(runHook(`git -C '${adv}' push`, other));
  });

  test('PG-31: allows cd <advisor> && git push from a non-advisor cwd', () => {
    expectAllowed(runHook(`cd '${adv}' && git push`, other));
  });

  test('PG-32: blocks git push when cd target does not exist (unresolved)', () => {
    expectBlocked(runHook(`cd '${tmp}/missing' && git push`, adv));
  });

  test('PG-33: blocks git push when cd target is computed by $(...)', () => {
    expectBlocked(runHook('cd "$(mktemp -d)" && git push', adv));
  });

  test('PG-34: blocks git --git-dir=<other> push from the advisor cwd', () => {
    expectBlocked(runHook(`git --git-dir='${other}/.git' push`, adv));
    expectBlocked(runHook(`GIT_DIR='${other}/.git' git push`, adv));
  });

  test('PG-35: blocks gh pr comment with a PR URL for another repo from the advisor cwd', () => {
    expectBlocked(runHook('gh pr comment https://github.com/org/ai-koala/pull/17 --body x', adv));
  });

  test('PG-36: blocks gh pr create from the advisor cwd when the hook env has GH_REPO=org/ai-koala', () => {
    expectBlocked(runHook('gh pr create', adv, { GH_REPO: 'org/ai-koala' }));
  });

  test('PG-37: blocks gh api write to repos/org/ai-koala even when GH_REPO names the advisor repo', () => {
    expectBlocked(runHook('GH_REPO=me/advisor gh api -X POST repos/org/ai-koala/issues/1/comments', adv));
  });

  test('PG-38: allows gh pr create -R me/advisor and --repo=github.com/Me/Advisor from a non-advisor cwd', () => {
    expectAllowed(runHook('gh pr create -R me/advisor', other));
    expectAllowed(runHook('gh pr create --repo=github.com/Me/Advisor', other));
  });

  test('PG-39: allows gh api write to repos/me/advisor', () => {
    expectAllowed(runHook('gh api -X POST repos/me/advisor/issues/1/comments -f body=x', other));
  });

  test('PG-40: blocks git push from a plain non-git directory (unresolved)', () => {
    expectBlocked(runHook('git push', plain));
  });

  test('PG-41: with ADV unset, the advisor repo is the hook\'s own repo, so the temp repo is blocked', () => {
    // ADV unset falls back to the hook's own repo, which is not the temp repo.
    expectBlocked(runHook('git push', adv, { ADV: '' }));
  });
});

describe('evasion forms', () => {
  test.each([
    ["'git' 'push'"],
    ['"git" push'],
    ['g\\it pu\\sh'],
    ['\\git push'],
    ["$'\\x67it' push"],
    ['bash -c "git\\ push"'],
    ["bash -c 'g\\it push'"],
    ["sh -lc 'git push origin main'"],
    ['command git push'],
    ['env FOO=1 git push'],
    ['env -i PATH=/usr/bin git push'],
    ['sudo -u me git push'],
    ['nohup git push &'],
    ['time git push'],
    ['timeout 30 git push'],
    ['xargs git push'],
    ['xargs -I{} git push'],
    ['/usr/bin/git push'],
    ['git -c core.askpass=true push'],
    ['git --no-pager push'],
    ['git push 2>&1 | tail -5'],
    ['git status; git push'],
    ['true || git push'],
    ['if true; then git push; fi'],
    ['{ git push; }'],
    ['echo $(git push)'],
    ['echo "$(git push)"'],
    ['echo `git push`'],
    ['eval "git push"'],
    ['bash <<EOF\ngit push\nEOF'],
    ['ls \\\n  && git push'],
  ])('PG-50: blocks %p in a non-advisor repo', (cmd) => {
    expectBlocked(runHook(cmd, other));
  });

  test('PG-51: blocks (cd <repo> && git push) subshell from the advisor cwd', () => {
    expectBlocked(runHook(`(cd '${other}' && git push)`, adv));
  });

  test('PG-52: cd inside a subshell does not leak: (cd <other>) && git push from the advisor cwd is allowed', () => {
    expectAllowed(runHook(`(cd '${other}') && git push`, adv));
  });

  test('PG-53: blocks sh -c "cd <other> && git push" from the advisor cwd', () => {
    expectBlocked(runHook(`sh -c "cd '${other}' && git push"`, adv));
  });

  test('PG-54: allows a heredoc whose text contains git push', () => {
    expectAllowed(runHook('cat <<EOF\ngit push\ngh pr comment 1 --body x\nEOF', other));
    expectAllowed(runHook("cat > notes.md <<'EOF'\ngit push origin main\nEOF\necho done", other));
  });

  test('PG-55: a heredoc commit message with apostrophes and parens does not hide a chained push', () => {
    const cmd = "git commit -m \"$(cat <<'EOF'\nfix(x): don't push (yet\n1) step\nEOF\n)\" && git push";
    expectBlocked(runHook(cmd, other));
    expectAllowed(runHook(cmd.replace(' && git push', ''), other));
  });

  test('PG-56: allows non-push git and quoted mentions', () => {
    expectAllowed(runHook("git stash push -m wip && git log --grep 'git push' && grep -r 'gh pr create' .", other));
    expectAllowed(runHook('command -v git && echo git push', other));
  });
});

describe('gh evasion and cwd forms', () => {
  test('PG-57: blocks cd <other> && gh pr create from the advisor cwd', () => {
    expectBlocked(runHook(`cd '${other}' && gh pr create`, adv));
  });

  test('PG-58: allows cd <advisor> && gh pr create from a non-advisor cwd', () => {
    expectAllowed(runHook(`cd '${adv}' && gh pr create`, other));
  });

  test.each([
    ["'gh' 'pr' 'comment' 17 -R org/ai-koala --body x"],
    ['bash -c "gh api -X POST repos/org/ai-koala/issues/1/comments"'],
    ['true && (gh pr comment 17 -R org/ai-koala --body x)'],
    ['env FOO=1 gh pr comment 17 -R org/ai-koala --body x'],
  ])('PG-59: blocks %p from the advisor cwd', (cmd) => {
    expectBlocked(runHook(cmd, adv));
  });

  test('PG-59b: gh api {owner}/{repo} placeholder resolves through the cwd origin', () => {
    const cmd = "gh api -X POST 'repos/{owner}/{repo}/issues/1/comments'";
    expectBlocked(runHook(cmd, other));
    expectAllowed(runHook(cmd, adv));
  });
});

describe('non-Bash and empty input', () => {
  test('PG-60: non-Bash tool exits 0', () => {
    const r = spawnSync('node', [HOOK], {
      input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'x' } }),
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ADVISOR_SID: 'x' },
    });
    expectAllowed(r);
  });

  test('PG-61: Bash payload without a command exits 0', () => {
    const r = spawnSync('node', [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: {} }),
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ADVISOR_SID: 'x' },
    });
    expectAllowed(r);
  });
});

describe('review round 1 findings', () => {
  const W = { ADVISOR_SID: 'x' };
  const URL9 = 'https://github.com/me/advisor/pull/9';
  let advWt, adv2, adv3, adv4;

  beforeAll(() => {
    const g = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
    const both = [['origin', 'git@github.com:me/advisor.git'], ['upstream', 'https://github.com/org/ai-koala.git']];
    const mk = (name, remotes) => {
      const d = path.join(tmp, name);
      execFileSync('git', ['init', '-q', '-b', 'main', d]);
      for (const [n, u] of remotes) g(d, 'remote', 'add', n, u);
      return d;
    };
    const advC = mk('adv-c', [both[0]]);
    g(advC, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'i');
    advWt = path.join(tmp, 'adv-wt');
    g(advC, 'worktree', 'add', '-q', '-b', 'ws/x', advWt);
    adv2 = mk('adv2', both);
    adv3 = mk('adv3', both);
    g(adv3, 'config', 'remote.origin.gh-resolved', 'base');
    adv4 = mk('adv4', both);
    g(adv4, 'config', 'branch.main.pushRemote', 'upstream');
  });

  test.each([
    `gh pr comment 5 --body "follow-up to ${URL9}"`,
    `gh pr create --title t --body "ports ${URL9}"`,
    `gh issue create -t t -b "see ${URL9}"`,
    `gh pr comment 5 --body ${URL9}`,
  ])('PG-70: B1 blocks %p from a non-advisor cwd (a URL in a text flag is not the target)', (cmd) => {
    expectBlocked(runHook(cmd, other));
  });

  test('PG-70b: B1 mirror: a body citing another repo does not block an advisor-cwd comment', () => {
    expectAllowed(runHook('gh pr comment 17 --body "see https://github.com/org/x/pull/1"', adv));
    expectAllowed(runHook(`gh pr comment ${URL9} --body x`, other));
  });

  test('PG-70c: B1 a selector URL after a boolean flag still counts as a target', () => {
    expectBlocked(runHook('gh pr merge -m https://github.com/org/ai-koala/pull/1', adv));
  });

  test.each([
    'pr update-branch 5', 'pr lock 5', 'pr unlock 5', 'issue develop 5', 'repo fork org/ai-koala',
    'repo deploy-key add k.pub', "repo autolink create X- 'https://x/<num>'", 'gist rename a.md b.md',
  ])('PG-71: B2 blocks gh %s in a worker and from a non-advisor cwd', (cmd) => {
    expectBlocked(runHook(`gh ${cmd}`, adv, W));
    expectBlocked(runHook(`gh ${cmd}`, other));
  });

  test('PG-71b: B2/N1 read-only gh verbs and groups stay allowed in a worker', () => {
    const reads = [
      'gist clone abc', 'repo deploy-key list', 'repo autolink list', 'repo gitignore view Node',
      'project item-list 1 --owner me', 'variable get X', 'ruleset view 1', 'attestation verify a.tgz -o me',
      'search prs push', 'status', '--version', 'auth status', 'config get editor', 'alias list',
      'run watch 1', 'release download v1', 'pr status', 'label list', 'cache list', 'codespace list', 'extension list',
    ];
    expectAllowed(runHook(reads.map(c => `gh ${c}`).join(' && '), adv, W));
  });

  test.each([
    'cache delete --all', 'project item-add 1 --owner me --url x', 'ssh-key add k.pub', 'gpg-key add k.asc',
    'codespace create -R org/ai-koala', 'agent-task create x', 'extension install o/gh-x', 'frobnicate 5',
  ])('PG-72: W4 blocks gh %s in a worker', (cmd) => {
    expectBlocked(runHook(`gh ${cmd}`, adv, W));
  });

  test('PG-72b: W4 account-level, org-level and unknown gh writes have no repo target', () => {
    for (const cmd of ['ssh-key add k.pub', 'project item-add 1 --owner me --url x', 'secret set X --org o', 'secret set X --user', 'frobnicate 5']) {
      expectBlocked(runHook(`gh ${cmd}`, adv));
    }
    expectBlocked(runHook("gh alias set c 'pr comment' && gh c 5 -b x", adv));
    expectAllowed(runHook('gh cache delete --all', adv));
  });

  test.each([
    'git subtree push --prefix=x origin main', 'git lfs push origin main', 'git send-pack origin main',
    'git http-push https://x/r.git main', '/usr/libexec/git-core/git-push origin main', 'git-send-pack origin main',
    'git send-email 0001.patch', 'git svn dcommit', 'git -c alias.p=push p', 'git --config-env=alias.p=P p',
  ])('PG-73: W5 blocks %p in a worker and from the advisor cwd', (cmd) => {
    expectBlocked(runHook(cmd, adv, W));
    expectBlocked(runHook(cmd, adv));
  });

  test('PG-73b: W5 non-publish git forms stay allowed in a worker', () => {
    expectAllowed(runHook('git stash push -m x && git -c push.default=current status && git subtree split --prefix=x && git lfs ls-files && git svn log', adv, W));
  });

  test.each([
    'git push https://github.com/org/ai-koala main',
    'git push --repo=https://github.com/org/ai-koala',
    'git push ../ai-koala main',
    'git push --receive-pack=x origin main',
    'git -c remote.origin.pushurl=https://github.com/org/ai-koala push',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.url GIT_CONFIG_VALUE_0=https://github.com/org/ai-koala git push',
    'git remote set-url origin https://github.com/org/ai-koala && git push',
    'git config remote.origin.pushurl https://github.com/org/ai-koala; git push origin main',
    'git push nosuchremote main',
  ])('PG-74: W2 blocks %p from the advisor checkout (push destination, not checkout path)', (cmd) => {
    expectBlocked(runHook(cmd, adv));
  });

  test('PG-74b: W2 git target identity is the push remote URL', () => {
    expectAllowed(runHook('git push origin ws/x', advWt));
    expectAllowed(runHook('git push -o ci.skip --force-with-lease origin main', adv));
    expectAllowed(runHook('git push', adv2));
    expectBlocked(runHook('git push upstream main', adv2));
    expectBlocked(runHook('git push', adv4));
    expectBlocked(runHook('git push origin main', adv, { GIT_CONFIG_PARAMETERS: "'remote.origin.url'='x'" }));
  });

  test('PG-75: W8 a gh cwd target needs every remote (or the gh-resolved one) to be the advisor repo', () => {
    expectBlocked(runHook('gh pr comment 5 --body x', adv2));
    expectAllowed(runHook('gh pr comment 5 --body x', adv3));
  });

  test.each([
    `gh api graphql -f query='mutation{addComment(input:{subjectId:"X",body:"y"}){clientMutationId}}'`,
    'gh api graphql -F query=@q.graphql',
    'gh api graphql --input q.json',
    'gh api graphql -f owner=me',
    'gh api -X POST /user/repos -f name=x',
    'gh api orgs/o/repos -f name=x',
    'gh api -X PATCH gists/1 -f x=y',
  ])('PG-76: W1 blocks %p from the advisor cwd (no repos/<o>/<r> target)', (cmd) => {
    expectBlocked(runHook(cmd, adv));
  });

  test('PG-76b: W1 REST writes to repos/me/advisor resolve with a leading slash or a host', () => {
    expectAllowed(runHook('gh api -X POST /repos/me/advisor/issues/1/comments -f body=x', other));
    expectAllowed(runHook('gh api https://api.github.com/repos/me/advisor/issues/1/comments -f body=x', other));
  });

  test('PG-77: W3 GraphQL reads are allowed in a worker and from any cwd', () => {
    for (const q of ["'{viewer{login}}'", "'query($n:Int!){viewer{login}}' -F n=1", '"query { repository(owner:\\"o\\",name:\\"r\\"){id} }"']) {
      expectAllowed(runHook(`gh api graphql -f query=${q}`, adv, W));
      expectAllowed(runHook(`gh api graphql -f query=${q}`, other));
    }
  });

  test('PG-78: B3 deep $( nesting fails closed with a reason instead of crashing', () => {
    const r = runHook('echo ' + '$('.repeat(5000) + ')'.repeat(5000) + '; git push', other, W);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^publish-guard: /);
    expect(runHook('echo "' + '$(echo "'.repeat(3000) + '"; git push', other, W).status).toBe(2);
  });

  test('PG-78b: B3 size caps fail closed', () => {
    expect(runHook('echo a; '.repeat(140000), other).status).toBe(2);
    expect(runHook('git push origin main; '.repeat(60), adv).status).toBe(2);
  });

  test.each([
    "env -S 'git push'", 'find . -maxdepth 0 -exec git push \;', 'caffeinate git push', 'stdbuf -oL git push',
    'G=git; $G push', 'echo push | xargs git',
  ])('PG-79: W6 blocks %p in a worker and from a non-advisor cwd', (cmd) => {
    expectBlocked(runHook(cmd, other, W));
    expectBlocked(runHook(cmd, other));
  });

  test.each([
    '$(echo git) push', '${G:-git} push', '{git,push}', '/usr/bin/gi? push', '$"git" push',
    `eval "$(printf 'git push')"`, 'gh auth token',
  ])('PG-79b: W6 blocks the non-literal or token form %p in a worker', (cmd) => {
    expectBlocked(runHook(cmd, other, W));
  });

  test('PG-79c: W6 literal and env-expanded programs stay allowed', () => {
    expectAllowed(runHook('"$ADV/bin/capture" bun test && find . -name "*.js" -exec grep -l push {} + && gh auth status', adv, W));
    expectAllowed(runHook('gh auth token', adv));
  });

  test('PG-80: W7 substitutions in an unquoted heredoc body are analyzed', () => {
    expectBlocked(runHook('cat <<EOF\n$(git push)\nEOF', other, W));
    expectBlocked(runHook('cat <<EOF\n`gh pr comment 5 -b x`\nEOF', other));
    expectAllowed(runHook("cat <<'EOF'\n$(git push)\nEOF", other, W));
    expectAllowed(runHook('cat <<"EOF"\n`git push`\nEOF', other, W));
    expectAllowed(runHook('cat <<\\EOF\n$(git push)\nEOF', other, W));
  });

  test('PG-81: W9/W10 the block reason goes to stderr and stdout and cites an existing claude.md section', () => {
    const r = runHook('git push origin x', other);
    const msg = 'publish-guard: git push origin x - publish through bin/advisor-publish (claude.md, Guardrails)\n';
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ status: 2, stdout: msg, stderr: msg });
  });

  test.each([
    "bin/advisor-publish --repo . --policy-paths 'docs/**' --execute",
    "bin/advisor-publish --repo . --policy-paths='docs/**' --execute",
    "bun bin/advisor-publish --repo . --policy-paths 'docs/**'",
    "\"$ADV/bin/advisor-publish\" --policy-paths 'docs/**'",
    "echo --policy-paths=x | xargs bin/advisor-publish --repo .",
    'bash -c "bin/advisor-publish --policy-paths x"',
  ])('PG-82: blocks advisor-publish with --policy-paths %p in a worker and from the advisor cwd', (cmd) => {
    expectBlocked(runHook(cmd, adv, W));
    expectBlocked(runHook(cmd, adv));
  });

  test.each([
    'PATH=/tmp/x:$PATH bin/advisor-publish --repo . --execute',
    'ADVISOR_RUNS_ROOT=/tmp bin/advisor-publish --repo . --execute',
    'env PATH=/tmp/x bin/advisor-publish --repo . --execute',
    'env -i bin/advisor-publish --repo . --execute',
    'env -u HOME bun bin/advisor-publish --repo . --execute',
    'export PATH=/tmp/x; bin/advisor-publish --repo . --execute',
    'PATH=/tmp/x; bin/advisor-publish --repo . --execute',
    'unset HOME && bin/advisor-publish --repo . --execute',
    'exec -c bin/advisor-publish --repo .',
    'sudo bin/advisor-publish --repo .',
    'X=1 "$ADV/bin/advisor-publish" --repo .',
  ])('PG-83: blocks advisor-publish after an env or PATH change %p in a worker and from the advisor cwd', (cmd) => {
    expectBlocked(runHook(cmd, adv, W));
    expectBlocked(runHook(cmd, adv));
  });

  test('PG-83b: plain advisor-publish forms stay allowed', () => {
    const cmd = 'cd "$ADV" && n=1; bin/advisor-publish --repo . --execute && "$ADV/bin/advisor-publish" --repo . && bun bin/advisor-publish --repo .';
    expectAllowed(runHook(cmd.replace(' --execute', ''), adv, W));
    expectAllowed(runHook(cmd, other));
  });

  test.each([
    'gh api graphql -f query="$(cat m.graphql)"',
    'gh api graphql -f query="$(<m.graphql)" -f id=I_kwDOabc',
    'gh api graphql -f query="`cat m.graphql`"',
    'gh api graphql -f query="$Q"',
    'gh api graphql --raw-field=query="${MUT}"',
    'gh api graphql -f query=$Q',
    'Q=$(cat m.graphql); gh api graphql -f query="$Q"',
    "Q=$(cat <<'EOF'\nmutation { mergePullRequest(input:{pullRequestId:\"PR_x\"}) { clientMutationId } }\nEOF\n)\ngh api graphql -f query=\"$Q\"",
    'cat m.graphql | xargs -0 -I{} gh api graphql -f query={}',
  ])('PG-84: a non-literal GraphQL query %p is a write in a worker and from the advisor cwd', (cmd) => {
    expectBlocked(runHook(cmd, adv, W));
    expectBlocked(runHook(cmd, adv));
  });

  test.each([
    'git $(echo push) origin main', 'git `echo push` origin main', 'git ${S:-push} origin main',
    'git "${S:-push}" origin main', 'git "$SUB" origin main', 'git {push,} origin main', 'git pu?h origin main',
  ])('PG-85: a non-literal git subcommand %p is a publish in a worker and from the advisor cwd', (cmd) => {
    expectBlocked(runHook(cmd, adv, W));
    expectBlocked(runHook(cmd, adv));
  });

  test.each([
    "gh alias set co 'pr merge' --clobber",
    "gh alias set co 'pr merge' --clobber && gh co 5",
    `gh alias set --shell co 'gh pr merge "$1"' --clobber && gh co 5`,
    'gh alias import aliases.yml --clobber && gh co 5',
    'gh alias delete co',
    'gh co 5',
  ])('PG-86: gh alias writes and the co alias %p are writes in a worker and from the advisor cwd', (cmd) => {
    expectBlocked(runHook(cmd, adv, W));
    expectBlocked(runHook(cmd, adv));
  });

  test('PG-86b: gh alias list stays a read', () => {
    expectAllowed(runHook('gh alias list', other, W));
  });

  test('PG-87: a worker may dry-run advisor-publish but not run it with --execute', () => {
    for (const cmd of ['bin/advisor-publish --branch ws/abc --execute', 'bun bin/advisor-publish --pr 12 --execute',
      '"$ADV/bin/advisor-publish" --repo . --execute', 'bash -c "bin/advisor-publish --repo . --execute"']) {
      expectBlocked(runHook(cmd, adv, W));
      expectAllowed(runHook(cmd, adv));
    }
    expectAllowed(runHook('bin/advisor-publish --branch ws/abc --json', adv, W));
  });

  test('PG-88: a remote rewrite earlier in the command leaves a later gh cwd target unresolved', () => {
    expectBlocked(runHook('git remote add up https://github.com/o/x.git && git config remote.up.gh-resolved base && gh pr merge 5', adv));
    expectAllowed(runHook('gh pr comment 5 -b x', adv3));
    expectBlocked(runHook('git config remote.upstream.gh-resolved base; gh pr comment 5 -b x', adv3));
    expectAllowed(runHook('gh pr merge 5 -R me/advisor', adv));
    expectAllowed(runHook('git remote add up https://github.com/o/x.git && gh pr merge 5 -R me/advisor', adv));
  });
});
