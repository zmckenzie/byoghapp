// End-to-end tests for the command-line entry points that talk to the network,
// using a local fake server for both vendor docs and the GitHub API.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeServer, fixtureRepo, makeEntry, runScript, runScriptAsync } from '../helpers.mjs';
import { parse, stringify } from '../../scripts/lib/yaml.mjs';

const DOC_PAGE = '<p>Contents: read-only</p>';

describe('verify.mjs CLI', () => {
  test('prints the summary and writes the report', async () => {
    const server = await fakeServer({ 'GET /docs': { body: DOC_PAGE } });
    const repo = fixtureRepo({ example: makeEntry({ documentation_url: `${server.url}/docs` }) }, { gitInit: false });
    try {
      const reportPath = join(repo.root, 'report.json');
      const r = await runScriptAsync('scripts/verify.mjs', ['--report', reportPath], { root: repo.root });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /no-baseline: 1/);
      const reportText = readFileSync(reportPath, 'utf8');
      assert.ok(reportText.startsWith('{\n  "generated_at"'), 'the report is indented for reading');
      const report = JSON.parse(reportText);
      assert.equal(report.results[0].status, 'no-baseline');
      const noReport = await runScriptAsync('scripts/verify.mjs', ['example'], { root: repo.root });
      assert.match(noReport.stdout, /\| example \| no-baseline \|/);
    } finally {
      repo.cleanup();
      await server.close();
    }
  });
});

describe('verification-issues.mjs CLI', () => {
  test('opens an issue through the API', async () => {
    const server = await fakeServer({
      'GET /repos/o/r/issues': { json: [] },
      'POST /repos/o/r/issues': { status: 201, json: { number: 9 } },
    });
    const repo = fixtureRepo({}, { gitInit: false });
    try {
      const reportPath = join(repo.root, 'report.json');
      writeFileSync(reportPath, JSON.stringify({ results: [{ slug: 'x', status: 'changed', stored_hash: 'a', current_hash: 'b' }] }));
      const r = await runScriptAsync('scripts/verification-issues.mjs', [reportPath], {
        env: { GITHUB_TOKEN: 'secret', GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: server.url },
      });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /created: x; updated: none; already reported: none/);
      const post = server.requests.find((q) => q.method === 'POST');
      assert.equal(post.headers.authorization, 'Bearer secret');
      assert.equal(JSON.parse(post.body).title, 'Verify entry: x');
    } finally {
      repo.cleanup();
      await server.close();
    }
  });
});

describe('stamp-verified.mjs CLI', () => {
  const pr = { state: 'open', head: { ref: 'feature', sha: 'abc123', repo: { full_name: 'o/r' } }, base: { repo: { full_name: 'o/r' } } };

  test('plan writes step outputs for a same-repo PR', async () => {
    const server = await fakeServer({
      'GET /repos/o/r/pulls/5': { json: pr },
      'GET /repos/o/r/pulls/5/files': { json: [{ filename: 'entries/example.yaml', status: 'modified' }] },
    });
    const repo = fixtureRepo({}, { gitInit: false });
    try {
      const bodyFile = join(repo.root, 'body.txt');
      const output = join(repo.root, 'out.txt');
      writeFileSync(bodyFile, '/verified');
      writeFileSync(output, '');
      const r = await runScriptAsync('scripts/stamp-verified.mjs', ['plan', '--pr', '5', '--commenter', 'zmckenzie', '--body-file', bodyFile], {
        env: { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: server.url, GITHUB_OUTPUT: output },
      });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(readFileSync(output, 'utf8'), 'ok=true\nsame_repo=true\nhead_ref=feature\nhead_sha=abc123\nslugs=example\nmessage=\n');
    } finally {
      repo.cleanup();
      await server.close();
    }
  });

  test('plan prints multi-line outputs for forks and refusals', async () => {
    const fork = { ...pr, head: { ref: 'f', sha: 'def456', repo: { full_name: 'x/r' } } };
    const server = await fakeServer({
      'GET /repos/o/r/pulls/6': { json: fork },
      'GET /repos/o/r/pulls/6/files': { json: [{ filename: 'entries/example.yaml', status: 'added' }] },
    });
    const repo = fixtureRepo({}, { gitInit: false });
    try {
      const bodyFile = join(repo.root, 'body.txt');
      writeFileSync(bodyFile, '/verified');
      const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: server.url, GITHUB_OUTPUT: '' };
      const r = await runScriptAsync('scripts/stamp-verified.mjs', ['plan', '--pr', '6', '--commenter', 'zmckenzie', '--body-file', bodyFile, '--date', '2026-06-01'], { env });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^ok=true\nsame_repo=false\nhead_ref=f\nhead_sha=def456\nslugs=example\nmessage<<EOF_STAMP\nVerified by @zmckenzie/);
      assert.match(r.stdout, /last_verified: 2026-06-01/);
      const refused = await runScriptAsync('scripts/stamp-verified.mjs', ['plan', '--pr', '6', '--commenter', 'mallory', '--body-file', bodyFile], { env });
      assert.match(refused.stdout, /^ok=false\nsame_repo=false\nhead_ref=\nhead_sha=\nslugs=\nmessage=@mallory isn't a code owner/);
    } finally {
      repo.cleanup();
      await server.close();
    }
  });

  test('push stamps the planned head through the API', async () => {
    const server = await fakeServer({ 'GET /d': { body: DOC_PAGE } });
    const entry = stringify(makeEntry({ documentation_url: `${server.url}/d` }));
    const routes = {
      'GET /repos/o/r/git/commits/abc123': { json: { tree: { sha: 'tree0' } } },
      'GET /repos/o/r/contents/entries/example.yaml': { json: { content: Buffer.from(entry).toString('base64') } },
      'POST /repos/o/r/git/trees': { status: 201, json: { sha: 'tree1' } },
      'POST /repos/o/r/git/commits': { status: 201, json: { sha: 'new1' } },
      'PATCH /repos/o/r/git/refs/heads/feature': { json: {} },
    };
    const api = await fakeServer(routes);
    try {
      const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: api.url };
      const args = ['push', '--head-ref', 'feature', '--head-sha', 'abc123', '--login', 'maint', '--date', '2026-06-01'];
      const plain = await runScriptAsync('scripts/stamp-verified.mjs', [...args, 'example'], { env });
      assert.equal(plain.code, 0, plain.stderr);
      assert.equal(plain.stdout, 'Stamped example\nPushed new1\n');
      const fetched = await runScriptAsync('scripts/stamp-verified.mjs', [...args, '--fetch', 'example'], { env });
      assert.equal(fetched.code, 0, fetched.stderr);
      assert.match(fetched.stdout, /^Stamped example \(sha256:[0-9a-f]{64}\)\nPushed new1\n$/);
      const tree = JSON.parse(api.requests.find((r) => r.method === 'POST' && r.url.endsWith('/git/trees')).body);
      assert.equal(parse(tree.tree[0].content).last_verified, '2026-06-01');
    } finally {
      await server.close();
      await api.close();
    }
  });

  test('apply stamps files; unknown commands print usage', async () => {
    const repo = fixtureRepo({ example: makeEntry() }, { gitInit: false });
    try {
      const r = runScript('scripts/stamp-verified.mjs', ['apply', '--root', repo.root, '--login', 'maint', '--date', '2026-06-01', 'example']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout.trim(), 'Stamped example');
      assert.equal(parse(readFileSync(join(repo.root, 'entries/example.yaml'), 'utf8')).last_verified, '2026-06-01');
      const fetched = await (async () => {
        const server = await fakeServer({ 'GET /d': { body: DOC_PAGE } });
        try {
          writeFileSync(join(repo.root, 'entries/example.yaml'), stringify(makeEntry({ documentation_url: `${server.url}/d` })));
          return await runScriptAsync('scripts/stamp-verified.mjs', ['apply', '--root', repo.root, '--login', 'maint', '--fetch', 'example']);
        } finally {
          await server.close();
        }
      })();
      assert.match(fetched.stdout, /Stamped example \(sha256:[0-9a-f]{64}\)/);
      const usage = runScript('scripts/stamp-verified.mjs', ['nope']);
      assert.equal(usage.code, 2);
      assert.match(usage.stderr, /Usage: stamp-verified\.mjs plan\|push\|apply/);
    } finally {
      repo.cleanup();
    }
  });
});

describe('check-repo-hygiene CLI', () => {
  test('passes the real repository and fails a dirty fixture', () => {
    const ok = runScript('scripts/check-repo-hygiene.mjs');
    assert.equal(ok.code, 0);
    assert.equal(ok.stdout.trim(), 'Repository hygiene: OK');
    const repo = fixtureRepo({ example: makeEntry() });
    try {
      repo.write('TASKS.md', '- [ ] x');
      repo.write('key.pem', 'x');
      repo.commit('oops');
      const r = runScript('scripts/check-repo-hygiene.mjs', [], { root: repo.root });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /::error file=TASKS\.md::TASKS\.md: planning and task notes/);
      assert.match(r.stderr, /key\.pem: possible credential/);
      assert.match(r.stderr, /2 file\(s\) must not be committed/);
    } finally {
      repo.cleanup();
    }
  });
});
