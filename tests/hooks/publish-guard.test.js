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
  expect(r.stdout).toMatch(/^publish-guard: .+ - publish through bin\/advisor-publish \(claude\.md, Publish gate\)$/m);
}

function expectAllowed(r) {
  expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: '' });
}

describe('spec cases', () => {
  test('PG-1: blocks git push origin x in a non-advisor repo', () => {
    const r = runHook('git push origin x', other);
    expectBlocked(r);
    expect(r.stdout).toBe('publish-guard: git push origin x - publish through bin/advisor-publish (claude.md, Publish gate)\n');
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

  test('PG-15: allows bin/advisor-publish --repo <repo> --execute from any cwd, worker or not', () => {
    const cmd = `bin/advisor-publish --repo '${other}' --execute`;
    for (const cwd of [adv, other, noOrigin, plain]) {
      expectAllowed(runHook(cmd, cwd));
      expectAllowed(runHook(cmd, cwd, { ADVISOR_SID: 'x' }));
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
