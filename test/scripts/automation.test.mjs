import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, GitHubError } from '../../scripts/lib/github.mjs';
import { formatOutcome, issueBody, issueTitle, LABEL, marker, syncIssues } from '../../scripts/verification-issues.mjs';
import { applyStamp, forkInstructions, parseCommand, planStamp, pushStamp, stampEntry } from '../../scripts/stamp-verified.mjs';
import { fakeFetch, fixtureRepo, makeEntry, realData } from '../helpers.mjs';
import { parse, stringify } from '../../scripts/lib/yaml.mjs';

describe('GitHub client', () => {
  test('sends authenticated requests and parses JSON', async () => {
    const fetch = fakeFetch((url) => (url.endsWith('/pulls/3') ? { json: { number: 3 } } : { status: 204 }));
    const client = createClient({ fetch, token: 't0k', repo: 'o/r', apiUrl: 'https://api.test' });
    assert.deepEqual(await client.getPull(3), { number: 3 });
    const { url, init } = fetch.calls[0];
    assert.equal(url, 'https://api.test/repos/o/r/pulls/3');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.authorization, 'Bearer t0k');
    assert.equal(init.headers.accept, 'application/vnd.github+json');
    assert.equal(init.headers['x-github-api-version'], '2022-11-28');
    assert.equal(init.headers['content-type'], undefined);
    assert.equal(init.body, undefined);
    assert.equal(await client.request('DELETE', '/x'), null);
  });

  test('builds each endpoint', async () => {
    const fetch = fakeFetch(() => ({ json: [] }));
    const client = createClient({ fetch, token: 't', repo: 'o/r' });
    await client.listPullFiles(4);
    await client.listOpenIssues('a b');
    await client.listComments(5);
    await client.createIssue({ title: 'T' });
    await client.createComment(6, 'hi');
    assert.deepEqual(fetch.calls.map((c) => `${c.init.method} ${c.url}`), [
      'GET https://api.github.com/repos/o/r/pulls/4/files?per_page=100',
      'GET https://api.github.com/repos/o/r/issues?state=open&labels=a%20b&per_page=100',
      'GET https://api.github.com/repos/o/r/issues/5/comments?per_page=100',
      'POST https://api.github.com/repos/o/r/issues',
      'POST https://api.github.com/repos/o/r/issues/6/comments',
    ]);
    assert.equal(fetch.calls[3].init.body, '{"title":"T"}');
    assert.equal(fetch.calls[3].init.headers['content-type'], 'application/json');
    assert.equal(fetch.calls[4].init.body, '{"body":"hi"}');
  });

  test('throws GitHubError with the status', async () => {
    const client = createClient({ fetch: fakeFetch(() => ({ status: 403, body: 'nope' })), token: 't', repo: 'o/r' });
    await assert.rejects(client.getPull(1), (err) => err instanceof GitHubError && err.status === 403 && /GET \/repos\/o\/r\/pulls\/1 failed with HTTP 403: nope/.test(err.message));
  });
});

describe('verification issues', () => {
  const changed = { slug: 'renovate', status: 'changed', documentation_url: 'https://d', last_verified: '2026-01-01', stored_hash: 'sha256:a', current_hash: 'sha256:b' };
  const down = { slug: 'atlantis', status: 'unreachable', documentation_url: 'https://e', last_verified: null, stored_hash: null, error: 'HTTP 500' };

  test('issue text mirrors the form', () => {
    assert.equal(issueTitle('x'), 'Verify entry: x');
    assert.equal(LABEL, 'verification-failed');
    const body = issueBody(changed);
    assert.ok(body.startsWith('### Entry slug\n\nrenovate\n\n### Documentation URL checked\n\nhttps://d\n'));
    assert.ok(body.includes("### Entry's last_verified date\n\n2026-01-01"));
    assert.ok(body.includes('stored:  sha256:a\ncurrent: sha256:b'));
    assert.ok(body.endsWith(marker(changed)));
    const downBody = issueBody(down);
    assert.ok(downBody.includes('_never verified_'));
    assert.ok(downBody.includes('could not be checked: HTTP 500'));
    assert.ok(issueBody({ slug: 's', status: 'unreachable', error: 'x' }).includes('_unknown_'));
    assert.equal(marker(changed), '<!-- byoghapp-verify renovate changed sha256:b -->');
    assert.equal(marker(down), '<!-- byoghapp-verify atlantis unreachable HTTP 500 -->');
    assert.equal(marker({ slug: 'z', status: 'changed' }), '<!-- byoghapp-verify z changed  -->');
  });

  test('the full issue body', () => {
    assert.equal(issueBody(changed), [
      '### Entry slug', '', 'renovate', '',
      '### Documentation URL checked', '', 'https://d', '',
      "### Entry's last_verified date", '', '2026-01-01', '',
      '### What changed', '', '```text', 'The permission-related text changed.', 'stored:  sha256:a', 'current: sha256:b', '```', '',
      '### Resolution', '',
      '_For the maintainer: compare the vendor documentation with the entry. Update the entry if needed, then comment `/verified <slug>` on the pull request (or open one) to record the new fingerprint._',
      '', '<!-- byoghapp-verify renovate changed sha256:b -->',
    ].join('\n'));
  });

  test('formatOutcome lists slugs or none', () => {
    assert.equal(formatOutcome({ created: [], commented: [], skipped: [] }), 'created: none; updated: none; already reported: none');
    assert.equal(formatOutcome({ created: ['a', 'b'], commented: ['c', 'd'], skipped: ['e', 'f'] }), 'created: a, b; updated: c, d; already reported: e, f');
  });

  test('creates, comments on or skips issues', async () => {
    const calls = [];
    const client = {
      listOpenIssues: async (label) => {
        calls.push(['list', label]);
        return [
          { number: 1, title: 'Verify entry: atlantis', body: 'old' },
          { number: 2, title: 'Verify entry: dx', body: marker({ slug: 'dx', status: 'changed', current_hash: 'h' }) },
          { number: 3, title: 'Verify entry: sg', body: null },
        ];
      },
      listComments: async (n) => (n === 3 ? [{ body: marker({ slug: 'sg', status: 'changed', current_hash: 'q' }) }, { body: null }] : []),
      createIssue: async (issue) => calls.push(['create', issue.title, issue.labels]),
      createComment: async (n, body) => calls.push(['comment', n, body.split('\n')[0]]),
    };
    const report = { results: [
      changed, down,
      { slug: 'dx', status: 'changed', current_hash: 'h' },
      { slug: 'sg', status: 'changed', current_hash: 'q' },
      { slug: 'fine', status: 'ok' },
      { slug: 'new', status: 'no-baseline', current_hash: 'z' },
    ] };
    const outcome = await syncIssues(report, client);
    assert.deepEqual(outcome, { created: ['renovate'], commented: ['atlantis'], skipped: ['dx', 'sg'] });
    assert.deepEqual(calls, [
      ['list', 'verification-failed'],
      ['create', 'Verify entry: renovate', ['verification-failed']],
      ['comment', 1, 'The scheduled check found this again.'],
    ]);
  });
});

describe('stamp-verified', () => {
  test('parseCommand', () => {
    assert.deepEqual(parseCommand('/verified'), { slugs: [] });
    assert.deepEqual(parseCommand('  /verified renovate, atlantis renovate\nthanks'), { slugs: ['renovate', 'atlantis'] });
    assert.equal(parseCommand('/verifiedx'), null);
    assert.equal(parseCommand('please /verified'), null);
    assert.equal(parseCommand(null), null);
    assert.deepEqual(parseCommand('/verified ../etc'), { error: 'Slugs may only contain lowercase letters, numbers and hyphens.' });
  });

  test('stampEntry records the verification', () => {
    const entry = makeEntry();
    const stamped = stampEntry(entry, { login: 'maint', date: '2026-06-01', docHash: 'sha256:x' });
    assert.equal(stamped.last_verified, '2026-06-01');
    assert.equal(stamped.verified_by, 'maint');
    assert.deepEqual(stamped.verification, { status: 'ok', method: 'doc-hash', doc_hash: 'sha256:x' });
    assert.equal(entry.verification.status, 'needs-review');
    assert.equal(stampEntry(entry, { login: 'm', date: 'd' }).verification.doc_hash, null);
  });

  const codeowners = readFileSync(join(import.meta.dirname, '../../.github/CODEOWNERS'), 'utf8');
  const fakeClient = (pr, files) => ({ getPull: async () => pr, listPullFiles: async () => files });
  const pr = { state: 'open', head: { ref: 'feature', sha: 'abc123', repo: { full_name: 'o/r' } }, base: { repo: { full_name: 'o/r' } } };
  const files = [
    { filename: 'entries/renovate.yaml', status: 'modified' },
    { filename: 'entries/gone.yaml', status: 'removed' },
    { filename: 'README.md', status: 'modified' },
    { filename: 'entries/sub/x.json', status: 'added' },
  ];

  test('planStamp checks the command, the commenter and the PR', async () => {
    const plan = (over = {}) => planStamp({ client: fakeClient(pr, files), prNumber: 1, commenter: 'zmckenzie', body: '/verified', codeowners, ...over });
    assert.deepEqual(await plan(), { ok: true, sameRepo: true, headRef: 'feature', headSha: 'abc123', slugs: ['renovate'] });
    assert.deepEqual(await plan({ commenter: 'ZMcKenzie', body: '/verified a b' }), { ok: true, sameRepo: true, headRef: 'feature', headSha: 'abc123', slugs: ['a', 'b'] });
    assert.deepEqual(await plan({ body: 'hello' }), { ok: false, message: 'Not a /verified command.' });
    assert.deepEqual(await plan({ body: '/verified ../x' }), { ok: false, message: 'Slugs may only contain lowercase letters, numbers and hyphens.' });
    assert.match((await plan({ commenter: 'mallory' })).message, /@mallory isn't a code owner of entries\//);
    const closed = await planStamp({ client: fakeClient({ ...pr, state: 'closed' }, files), prNumber: 1, commenter: 'zmckenzie', body: '/verified', codeowners });
    assert.deepEqual(closed, { ok: false, message: 'The pull request is not open.' });
    const none = await planStamp({ client: fakeClient(pr, []), prNumber: 1, commenter: 'zmckenzie', body: '/verified', codeowners });
    assert.match(none.message, /changes no entries/);
    const fork = await planStamp({ client: fakeClient({ ...pr, head: { ref: 'f', repo: { full_name: 'x/r' } } }, files), prNumber: 1, commenter: 'zmckenzie', body: '/verified', codeowners });
    assert.equal(fork.sameRepo, false);
    const deletedFork = await planStamp({ client: fakeClient({ ...pr, head: { ref: 'f', repo: null } }, files), prNumber: 1, commenter: 'zmckenzie', body: '/verified', codeowners });
    assert.equal(deletedFork.sameRepo, false);
  });

  test('applyStamp writes stamped entries, with or without a fingerprint', async () => {
    const repo = fixtureRepo({ example: makeEntry() }, { gitInit: false });
    try {
      assert.deepEqual(await applyStamp({ root: repo.root, slugs: ['example'], login: 'maint', date: '2026-06-01' }), [{ slug: 'example', docHash: null }]);
      const written = parse(readFileSync(join(repo.root, 'entries/example.yaml'), 'utf8'));
      assert.equal(written.verified_by, 'maint');
      assert.equal(written.verification.status, 'ok');
      const fetch = fakeFetch({ 'https://example.com/docs/github-app': { body: '<p>Contents: read</p>' } });
      const [stamped] = await applyStamp({ root: repo.root, slugs: ['example'], login: 'maint', date: '2026-06-01', fetch });
      assert.match(stamped.docHash, /^sha256:/);
      await assert.rejects(applyStamp({ root: repo.root, slugs: ['example'], login: 'm', date: 'd', fetch: fakeFetch({}) }), /example: .*HTTP 404/);
      await assert.rejects(applyStamp({ root: repo.root, slugs: ['Bad'], login: 'm', date: 'd' }), /Invalid slug: Bad/);
      await assert.rejects(applyStamp({ root: repo.root, slugs: ['missing'], login: 'm', date: 'd' }), /could not read entries\/missing\.yaml/);
    } finally {
      repo.cleanup();
    }
  });

  test('pushStamp commits the stamp on top of the planned head through the API', async () => {
    const text = stringify(makeEntry());
    let branchMoved = false;
    const fetch = fakeFetch((url, init) => {
      const route = `${init.method} ${url.replace('https://api.test/repos/o/r', '')}`;
      if (route === 'GET /git/commits/abc123') return { json: { tree: { sha: 'tree0' } } };
      if (route === 'GET /contents/entries/example.yaml?ref=abc123') return { json: { content: Buffer.from(text).toString('base64'), encoding: 'base64' } };
      if (route === 'POST /git/trees') return { status: 201, json: { sha: 'tree1' } };
      if (route === 'POST /git/commits') return { status: 201, json: { sha: 'new1' } };
      if (route === 'PATCH /git/refs/heads/feat/x') return branchMoved ? { status: 422, body: 'Update is not a fast forward' } : { json: { object: { sha: 'new1' } } };
      if (url === 'https://example.com/docs/github-app') return { body: '<p>Contents: read</p>' };
      return undefined;
    });
    const client = createClient({ fetch, token: 't', repo: 'o/r', apiUrl: 'https://api.test' });
    const args = { client, headRef: 'feat/x', headSha: 'abc123', slugs: ['example'], login: 'maint', date: '2026-06-01' };
    assert.deepEqual(await pushStamp(args), { sha: 'new1', results: [{ slug: 'example', docHash: null }] });
    const body = (route) => JSON.parse(fetch.calls.find((c) => `${c.init.method} ${c.url}`.endsWith(route)).init.body);
    const tree = body('/git/trees');
    assert.equal(tree.base_tree, 'tree0');
    assert.equal(tree.tree.length, 1);
    assert.deepEqual({ ...tree.tree[0], content: undefined }, { path: 'entries/example.yaml', mode: '100644', type: 'blob', content: undefined });
    const written = parse(tree.tree[0].content);
    assert.equal(written.verified_by, 'maint');
    assert.equal(written.last_verified, '2026-06-01');
    assert.equal(written.verification.status, 'ok');
    assert.deepEqual(body('/git/commits'), { message: 'Record verification of example by @maint', tree: 'tree1', parents: ['abc123'] });
    assert.deepEqual(body('/git/refs/heads/feat/x'), { sha: 'new1', force: false });

    const withHash = await pushStamp({ ...args, data: await realData(), fetch });
    assert.match(withHash.results[0].docHash, /^sha256:/);
    await assert.rejects(pushStamp({ ...args, slugs: ['Bad'] }), /Invalid slug: Bad/);
    assert.equal(fetch.calls.filter((c) => c.url.endsWith('/git/commits/abc123')).length, 2);
    branchMoved = true;
    await assert.rejects(pushStamp(args), /PATCH .* HTTP 422: Update is not a fast forward/);
  });

  test('forkInstructions names the files and fields', () => {
    const text = forkInstructions(['a', 'b'], 'maint', '2026-06-01');
    assert.ok(text.startsWith('Verified by @maint.'));
    assert.ok(text.includes('`entries/a.yaml`, `entries/b.yaml`'));
    assert.ok(text.includes('```yaml\nlast_verified: 2026-06-01\nverified_by: maint\nverification:\n  status: ok\n```'));
  });
});
