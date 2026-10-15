import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TYPES, bumpFor, latestVersion, nextVersion, parseCommit, releaseNotes, tagVersion, titleProblem,
} from '../../scripts/lib/conventional.mjs';
import {
  RELEASE_BRANCH, RELEASE_PR_CHECKS, bumpLockfile, bumpPackageJson, parseGitLog, planRelease, proposeRelease,
  releasePrBody, releaseTitle,
} from '../../scripts/lib/release.mjs';
import { createClient, GitHubError } from '../../scripts/lib/github.mjs';
import { commitsSince, readRepoState } from '../../scripts/release.mjs';
import { REPO, fakeFetch, fakeServer, fixtureRepo, git, runScript, runScriptAsync } from '../helpers.mjs';

const REPO_URL = 'https://github.com/o/r';

describe('conventional commits', () => {
  test('parseCommit reads type, scope, breaking marks and description', () => {
    assert.deepEqual(parseCommit('feat(entries): add Renovate (#12)'), { type: 'feat', scope: 'entries', breaking: false, description: 'add Renovate (#12)' });
    assert.deepEqual(parseCommit('fix!: drop the old field'), { type: 'fix', scope: null, breaking: true, description: 'drop the old field' });
    assert.deepEqual(parseCommit('chore(deps/npm): bump x\n\nBREAKING CHANGE: y'), { type: 'chore', scope: 'deps/npm', breaking: true, description: 'bump x' });
    assert.equal(parseCommit('docs: a\n\nBREAKING-CHANGE: b').breaking, true);
    assert.equal(parseCommit('docs: a\n\nnot BREAKING CHANGE: b').breaking, false);
    assert.equal(parseCommit('docs: a\n\nsome text\nBREAKING CHANGE: b').breaking, true, 'a footer on its own line');
    for (const type of TYPES) assert.equal(parseCommit(`${type}: x`)?.type, type);
    assert.deepEqual(TYPES, ['feat', 'fix', 'perf', 'revert', 'docs', 'test', 'refactor', 'style', 'build', 'ci', 'chore']);
    assert.equal(parseCommit('  feat: padded  ').description, 'padded');
    for (const bad of ['Merge pull request #3 from x/y', 'feat:missing space', 'feat: ', 'Feat: capital', 'wip: x', 'feat(Bad Scope): x', 'feat(): x', '']) {
      assert.equal(parseCommit(bad), null, bad);
    }
    assert.ok(TYPES.includes('feat') && TYPES.includes('chore'));
  });

  test('titleProblem explains what is wrong', () => {
    assert.equal(titleProblem('feat(site): dark mode'), null);
    assert.match(titleProblem('feature: dark mode'), /^"feature" is not a commit type; use one of: feat, fix/);
    assert.match(titleProblem('wip(x)!: y'), /"wip" is not a commit type/);
    for (const bad of ['Add dark mode', 'feat dark mode', '', undefined, 'Feature: x', 'feat: ', 'wip dark mode']) {
      assert.match(titleProblem(bad), /must look like "type\(scope\): description"/, String(bad));
    }
  });

  test('tags, bumps and versions', () => {
    assert.equal(tagVersion('v1.2.3'), '1.2.3');
    assert.equal(tagVersion('v1.2'), null);
    assert.equal(tagVersion('1.2.3'), null);
    assert.equal(tagVersion('v1.2.3-rc.1'), null);
    assert.equal(latestVersion(['v0.2.0', 'v0.10.0', 'v0.9.1', 'other']), '0.10.0');
    assert.equal(latestVersion(['nope']), null);
    assert.equal(bumpFor(['docs: a', 'chore: b']), null);
    assert.equal(bumpFor(['docs: a', 'fix: b']), 'patch');
    assert.equal(bumpFor(['perf: a']), 'patch');
    assert.equal(bumpFor(['revert: a']), 'patch');
    assert.equal(bumpFor(['fix: a', 'feat: b']), 'minor');
    assert.equal(bumpFor(['feat: a', 'chore!: b']), 'major');
    assert.equal(bumpFor(['not conventional']), null);
    assert.equal(nextVersion('0.1.0', 'major'), '0.2.0');
    assert.equal(nextVersion('0.1.3', 'minor'), '0.2.0');
    assert.equal(nextVersion('0.1.3', 'patch'), '0.1.4');
    assert.equal(nextVersion('1.4.2', 'major'), '2.0.0');
    assert.equal(nextVersion('1.4.2', 'minor'), '1.5.0');
    assert.equal(nextVersion('1.4.2', 'patch'), '1.4.3');
  });

  test('releaseNotes groups commits and links pull requests', () => {
    const commits = [
      { sha: 'aaaaaaa1111', message: 'feat(entries): add Renovate (#12)' },
      { sha: 'bbbbbbb2222', message: 'fix: escape names' },
      { sha: 'ccccccc3333', message: 'docs: typo' },
      { sha: 'ddddddd4444', message: 'feat!: new schema\n\ndetails' },
      { sha: 'eeeeeee5555', message: 'perf: faster' },
      { sha: 'fffffff6666', message: 'Merge branch x' },
      { sha: '99999998888', message: 'revert: undo y' },
    ];
    assert.equal(releaseNotes({ version: '0.2.0', previous: '0.1.0', commits, repoUrl: REPO_URL }), [
      '## byoghapp 0.2.0', '',
      '### Breaking changes', '', '- new schema (ddddddd)', '',
      '### Features', '', '- **entries:** add Renovate ([#12](https://github.com/o/r/pull/12)) (aaaaaaa)', '',
      '### Fixes', '', '- escape names (bbbbbbb)', '',
      '### Performance', '', '- faster (eeeeeee)', '',
      '### Reverts', '', '- undo y (9999999)', '',
      '2 other changes (documentation, tests, maintenance).', '',
      '**Full changes:** https://github.com/o/r/compare/v0.1.0...v0.2.0', '',
    ].join('\n'));
    const first = releaseNotes({ version: '0.1.0', previous: null, commits: [{ sha: 'abcdefg1', message: 'chore: x' }], repoUrl: REPO_URL });
    assert.equal(first, '## byoghapp 0.1.0\n\n1 other change (documentation, tests, maintenance).\n\nFirst release.\n');
    assert.equal(releaseNotes({ version: '1.0.0', previous: null, commits: [], repoUrl: REPO_URL }), '## byoghapp 1.0.0\n\nFirst release.\n');
  });
});

describe('release planning', () => {
  const plan = (over) => planRelease({ version: '0.1.0', parentVersion: '0.1.0', tags: ['v0.1.0'], messages: [], ...over });

  test('publishes a merged version change, or on a manual run', () => {
    assert.deepEqual(plan({ version: '0.2.0', parentVersion: '0.1.0' }), { action: 'publish', version: '0.2.0', previous: '0.1.0' });
    assert.deepEqual(plan({ tags: [], manual: true }), { action: 'publish', version: '0.1.0', previous: null });
    assert.deepEqual(plan({ tags: [], parentVersion: null }), { action: 'publish', version: '0.1.0', previous: null });
  });

  test('waits while an untagged version is pending approval', () => {
    assert.deepEqual(plan({ tags: [] }), { action: 'pending', version: '0.1.0', reason: 'v0.1.0 is waiting to be published' });
  });

  test('proposes the next version from the commits since the last tag', () => {
    assert.deepEqual(plan({ messages: ['fix: a'] }), { action: 'propose', version: '0.1.1', previous: '0.1.0' });
    assert.deepEqual(plan({ messages: ['feat: a', 'docs: b'] }), { action: 'propose', version: '0.2.0', previous: '0.1.0' });
    assert.deepEqual(plan({ messages: ['docs: b'] }), { action: 'none', reason: 'no feat, fix, perf, revert or breaking commits since v0.1.0' });
  });

  test('refuses a package.json version that is not newer than the latest release', () => {
    assert.deepEqual(plan({ version: '0.0.9', parentVersion: '0.1.0' }), { action: 'none', reason: 'package.json version 0.0.9 is not newer than the latest release 0.1.0' });
    assert.equal(plan({ version: '0.1.0', tags: ['v0.2.0'], manual: true }).action, 'none');
  });

  test('bumps package.json and package-lock.json in npm formatting', () => {
    const pkg = readFileSync(join(REPO, 'package.json'), 'utf8');
    assert.equal(JSON.parse(bumpPackageJson(pkg, '9.8.7')).version, '9.8.7');
    assert.equal(bumpPackageJson(pkg, JSON.parse(pkg).version), pkg, 'unchanged when the version is the same');
    const lock = readFileSync(join(REPO, 'package-lock.json'), 'utf8');
    const bumped = JSON.parse(bumpLockfile(lock, '9.8.7'));
    assert.equal(bumped.version, '9.8.7');
    assert.equal(bumped.packages[''].version, '9.8.7');
    assert.equal(bumpLockfile(lock, JSON.parse(lock).version), lock);
    assert.equal(bumpLockfile('{"version":"1.0.0"}', '2.0.0'), '{\n  "version": "2.0.0"\n}\n');
  });

  test('parseGitLog and the release PR text', () => {
    assert.deepEqual(parseGitLog('abc\x1ffeat: x\n\nbody\n\x1e\ndef\x1ffix: y\x1e\n'), [
      { sha: 'abc', message: 'feat: x\n\nbody' },
      { sha: 'def', message: 'fix: y' },
    ]);
    assert.deepEqual(parseGitLog('lonely\x1e'), [{ sha: 'lonely', message: '' }]);
    assert.deepEqual(parseGitLog(''), []);
    assert.equal(releaseTitle('1.2.3'), 'chore(release): v1.2.3');
    const body = releasePrBody('## notes\n\n- a\n');
    assert.ok(body.startsWith('## notes\n\n- a\n\n---\n\nThis pull request is maintained by the Release PR workflow: it sets the version in `package.json` and\n`package-lock.json`, and it is rewritten whenever `main` changes, so edits to it are lost.\n'));
    assert.match(body, /waits for a maintainer to approve\nthe `release` environment/);
  });
});

/** A fake GitHub API for the release PR: records requests, answers from state. */
function fakeGitHub({ existingBranch = true, openPull = null } = {}) {
  return fakeFetch((url, init) => {
    const path = url.replace('https://api.test/repos/o/r', '');
    const route = `${init.method} ${path.split('?')[0]}`;
    if (route === 'GET /git/commits/base1') return { json: { tree: { sha: 'tree0' } } };
    if (route === 'POST /git/trees') return { status: 201, json: { sha: 'tree1' } };
    if (route === 'POST /git/commits') return { status: 201, json: { sha: 'bump1' } };
    if (route === `PATCH /git/refs/heads/${RELEASE_BRANCH}`) return existingBranch ? { json: {} } : { status: 422, body: 'Reference does not exist' };
    if (route === 'POST /git/refs') return { status: 201, json: {} };
    if (route === 'GET /pulls') return { json: openPull ? [openPull] : [] };
    if (route === 'POST /pulls') return { status: 201, json: { number: 9, html_url: 'https://github.com/o/r/pull/9' } };
    if (route === 'PATCH /pulls/7') return { json: { number: 7, html_url: 'https://github.com/o/r/pull/7' } };
    if (/^POST \/actions\/workflows\/[a-z-]+\.yml\/dispatches$/.test(route)) return { status: 204 };
    return undefined;
  });
}

describe('release pull request', () => {
  const options = (client) => ({ client, owner: 'o', base: 'main', baseSha: 'base1', version: '0.2.0', files: { 'package.json': 'P', 'package-lock.json': 'L' }, body: 'notes' });

  test('commits the bump, opens the PR and starts its checks', async () => {
    const fetch = fakeGitHub({ existingBranch: false });
    const client = createClient({ fetch, token: 't', repo: 'o/r', apiUrl: 'https://api.test' });
    assert.deepEqual(await proposeRelease(options(client)), { number: 9, url: 'https://github.com/o/r/pull/9', sha: 'bump1', created: true });
    const sent = (method, suffix) => fetch.calls.filter((c) => c.init.method === method && c.url.split('?')[0].endsWith(suffix)).map((c) => JSON.parse(c.init.body));
    assert.deepEqual(sent('POST', '/git/trees'), [{ base_tree: 'tree0', tree: [
      { path: 'package.json', mode: '100644', type: 'blob', content: 'P' },
      { path: 'package-lock.json', mode: '100644', type: 'blob', content: 'L' },
    ] }]);
    assert.deepEqual(sent('POST', '/git/commits'), [{ message: 'chore(release): v0.2.0', tree: 'tree1', parents: ['base1'] }]);
    assert.deepEqual(sent('PATCH', `/git/refs/heads/${RELEASE_BRANCH}`), [{ sha: 'bump1', force: true }]);
    assert.deepEqual(sent('POST', '/git/refs'), [{ ref: `refs/heads/${RELEASE_BRANCH}`, sha: 'bump1' }]);
    assert.ok(fetch.calls.some((c) => c.url === `https://api.test/repos/o/r/pulls?state=open&head=o%3Arelease%2Fnext&base=main`));
    assert.deepEqual(sent('POST', '/pulls'), [{ title: 'chore(release): v0.2.0', body: 'notes', head: RELEASE_BRANCH, base: 'main' }]);
    const dispatched = fetch.calls.filter((c) => c.url.endsWith('/dispatches'));
    assert.deepEqual(dispatched.map((c) => c.url.split('/').at(-2)), RELEASE_PR_CHECKS);
    assert.deepEqual(dispatched.map((c) => JSON.parse(c.init.body)), [
      ...RELEASE_PR_CHECKS.slice(0, -1).map(() => ({ ref: RELEASE_BRANCH })),
      { ref: RELEASE_BRANCH, inputs: { title: 'chore(release): v0.2.0' } },
    ]);
  });

  test('updates an open release PR in place', async () => {
    const fetch = fakeGitHub({ openPull: { number: 7 } });
    const client = createClient({ fetch, token: 't', repo: 'o/r', apiUrl: 'https://api.test' });
    const result = await proposeRelease(options(client));
    assert.equal(result.created, false);
    assert.equal(result.number, 7);
    assert.ok(!fetch.calls.some((c) => c.url.endsWith('/git/refs') && c.init.method === 'POST'), 'an existing branch is moved, not created');
    assert.ok(!fetch.calls.some((c) => c.url.endsWith('/pulls') && c.init.method === 'POST'));
    assert.deepEqual(JSON.parse(fetch.calls.find((c) => c.init.method === 'PATCH' && c.url.endsWith('/pulls/7')).init.body), { title: 'chore(release): v0.2.0', body: 'notes' });
  });

  test('setBranch only falls back to creating the branch on 422', async () => {
    const failing = (status) => createClient({ fetch: fakeFetch(() => ({ status, body: 'nope' })), token: 't', repo: 'o/r', apiUrl: 'https://api.test' });
    const forbidden = fakeFetch(() => ({ status: 403, body: 'nope' }));
    await assert.rejects(createClient({ fetch: forbidden, token: 't', repo: 'o/r', apiUrl: 'https://api.test' }).setBranch('b', 's'), (err) => err instanceof GitHubError && err.status === 403);
    assert.equal(forbidden.calls.length, 1, 'no create attempt after a 403');
    const moved = createClient({ fetch: fakeFetch(() => ({ json: { ref: 'refs/heads/b' } })), token: 't', repo: 'o/r', apiUrl: 'https://api.test' });
    assert.deepEqual(await moved.setBranch('b', 's'), { ref: 'refs/heads/b' });
    await assert.rejects(failing(422).setBranch('b', 's'), (err) => err instanceof GitHubError && err.status === 422 && /POST/.test(err.message));
    const offline = createClient({ fetch: fakeFetch(() => new Error('offline')), token: 't', repo: 'o/r', apiUrl: 'https://api.test' });
    await assert.rejects(offline.setBranch('b', 's'), /offline/);
  });
});

describe('release.mjs', () => {
  const repoWith = (version) => {
    const repo = fixtureRepo({}, { gitInit: false });
    repo.write('package.json', { name: 'x', version });
    git(repo.root, 'init', '-q', '-b', 'main');
    repo.commit('chore: initial');
    return repo;
  };

  test('readRepoState and commitsSince read tags, versions and history', () => {
    const repo = repoWith('0.1.0');
    try {
      assert.deepEqual(readRepoState(repo.root), { tags: [], version: '0.1.0', parentVersion: null });
      git(repo.root, 'tag', 'v0.1.0');
      repo.write('a.txt', 'a');
      repo.commit('feat: a');
      assert.deepEqual(readRepoState(repo.root), { tags: ['v0.1.0'], version: '0.1.0', parentVersion: '0.1.0' });
      assert.deepEqual(commitsSince('0.1.0', repo.root).map((c) => c.message), ['feat: a']);
      assert.deepEqual(commitsSince(null, repo.root).map((c) => c.message), ['feat: a', 'chore: initial']);
      assert.match(commitsSince(null, repo.root)[0].sha, /^[0-9a-f]{40}$/);
    } finally {
      repo.cleanup();
    }
  });

  test('plan writes outputs and notes for each case', () => {
    const repo = repoWith('0.1.0');
    try {
      const notes = join(repo.root, 'notes.md');
      const output = join(repo.root, 'out.txt');
      const plan = (...args) => {
        writeFileSync(output, '');
        const r = runScript('scripts/release.mjs', ['plan', '--notes', notes, ...args], { root: repo.root, env: { GITHUB_OUTPUT: output } });
        assert.equal(r.code, 0, r.stderr);
        return { out: readFileSync(output, 'utf8'), log: r.stderr };
      };
      assert.equal(plan().out, 'action=publish\nversion=0.1.0\nprevious=\n', 'the commit that adds package.json introduces its version');
      repo.write('c.txt', 'c');
      repo.commit('chore: second');
      assert.equal(plan().out, 'action=pending\nversion=0.1.0\nprevious=\n');
      const first = plan('--manual');
      assert.equal(first.out, 'action=publish\nversion=0.1.0\nprevious=\n');
      assert.match(first.log, /Release plan: publish v0\.1\.0/);
      assert.match(readFileSync(notes, 'utf8'), /^## byoghapp 0\.1\.0\n[\s\S]*First release\.\n$/);

      git(repo.root, 'tag', 'v0.1.0');
      repo.write('a.txt', 'a');
      repo.commit('docs: a');
      rmSync(notes);
      const none = plan();
      assert.ok(!existsSync(notes), 'no notes when there is nothing to release');
      assert.equal(none.out, 'action=none\nversion=\nprevious=\n');
      assert.match(none.log, /Release plan: none \(no feat, fix/);

      repo.write('b.txt', 'b');
      repo.commit('feat(site): b');
      assert.equal(plan().out, 'action=propose\nversion=0.2.0\nprevious=0.1.0\n');
      assert.match(readFileSync(notes, 'utf8'), /### Features\n\n- \*\*site:\*\* b /);

      repo.write('package.json', { name: 'x', version: '0.2.0' });
      repo.commit('chore(release): v0.2.0');
      assert.equal(plan().out, 'action=publish\nversion=0.2.0\nprevious=0.1.0\n');

      const stdout = runScript('scripts/release.mjs', ['plan'], { root: repo.root, env: { GITHUB_OUTPUT: '' } });
      assert.equal(stdout.stdout, 'action=publish\nversion=0.2.0\nprevious=0.1.0\n');
    } finally {
      repo.cleanup();
    }
  });

  test('propose opens the release PR; unknown commands print usage', async () => {
    const repo = repoWith('0.1.0');
    const server = await fakeServer({
      'GET /repos/o/r/git/commits/base1': { json: { tree: { sha: 'tree0' } } },
      'POST /repos/o/r/git/trees': { status: 201, json: { sha: 'tree1' } },
      'POST /repos/o/r/git/commits': { status: 201, json: { sha: 'bump1' } },
      'PATCH /repos/o/r/git/refs/heads/release/next': { json: {} },
      'GET /repos/o/r/pulls': { json: [] },
      'POST /repos/o/r/pulls': { status: 201, json: { number: 9, html_url: 'https://github.com/o/r/pull/9' } },
      ...Object.fromEntries(RELEASE_PR_CHECKS.map((w) => [`POST /repos/o/r/actions/workflows/${w}/dispatches`, { status: 204 }])),
    });
    try {
      repo.write('package-lock.json', { name: 'x', version: '0.1.0', packages: { '': { version: '0.1.0' } } });
      const notes = join(repo.root, 'notes.md');
      writeFileSync(notes, '## byoghapp 0.2.0\n');
      const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_SHA: 'base1', GITHUB_API_URL: server.url };
      const r = await runScriptAsync('scripts/release.mjs', ['propose', '--version', '0.2.0', '--notes', notes], { root: repo.root, env });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout.trim(), 'Opened release pull request #9 for v0.2.0: https://github.com/o/r/pull/9');
      const tree = JSON.parse(server.requests.find((q) => q.url.endsWith('/git/trees')).body).tree;
      assert.equal(JSON.parse(tree[0].content).version, '0.2.0');
      assert.equal(JSON.parse(tree[1].content).packages[''].version, '0.2.0');
      assert.ok(server.requests.some((q) => q.url === '/repos/o/r/pulls?state=open&head=o%3Arelease%2Fnext&base=main'));
      assert.deepEqual(tree.map((t) => t.path), ['package.json', 'package-lock.json']);

      const failed = await runScriptAsync('scripts/release.mjs', ['propose', '--version', '0.2.0', '--notes', notes], { root: repo.root, env: { ...env, GITHUB_SHA: 'missing' } });
      assert.equal(failed.code, 1);
      assert.match(failed.stderr, /GET \/repos\/o\/r\/git\/commits\/missing failed with HTTP 404/);

      const usage = runScript('scripts/release.mjs', ['nope']);
      assert.equal(usage.code, 2);
      assert.match(usage.stderr, /Usage: release\.mjs plan\|propose/);
    } finally {
      repo.cleanup();
      await server.close();
    }
  });
});

describe('check-pr-title.mjs', () => {
  test('passes conventional titles and fails others with an annotation', () => {
    const ok = runScript('scripts/check-pr-title.mjs', [], { env: { PR_TITLE: 'feat(entries): add X' } });
    assert.equal(ok.code, 0);
    assert.equal(ok.stdout.trim(), 'Pull request title OK: feat(entries): add X');
    const bad = runScript('scripts/check-pr-title.mjs', [], { env: { PR_TITLE: 'Add X' } });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /^::error title=Pull request title::the title must look like .* \(got "Add X"\)/);
    const empty = runScript('scripts/check-pr-title.mjs', [], { env: { PR_TITLE: '' } });
    assert.equal(empty.code, 1);
    const { PR_TITLE, ...rest } = process.env; // eslint-disable-line no-unused-vars
    const unset = spawnSync(process.execPath, [join(REPO, 'scripts/check-pr-title.mjs')], { encoding: 'utf8', env: rest });
    assert.equal(unset.status, 1);
    assert.match(unset.stderr, /\(got ""\)/);
  });
});
