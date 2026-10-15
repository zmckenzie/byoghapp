import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  changedEntrySlugs, contributorsOf, entryAtRef, entryPath, git, listEntrySlugs, loadData, readEntry, readJson, readYaml, todayUtc, ROOT,
} from '../../scripts/lib/repo.mjs';
import { resolvePath, startServer } from '../../scripts/serve.mjs';
import { spawn } from 'node:child_process';
import { REPO, fixtureRepo, makeEntry, realData } from '../helpers.mjs';
import { checkEntry } from '../../scripts/lib/entry-rules.mjs';

describe('repo helpers', () => {
  test('ROOT is the repository by default', () => {
    assert.equal(ROOT, REPO);
  });

  test('read, list and git helpers', () => {
    const repo = fixtureRepo({ b: makeEntry({ slug: 'b' }), a: makeEntry({ slug: 'a' }) });
    try {
      repo.write('entries/notes.txt', 'ignored');
      assert.deepEqual(listEntrySlugs(repo.root), ['a', 'b']);
      assert.equal(readEntry('a', repo.root).entry.slug, 'a');
      assert.match(readEntry('zzz', repo.root).error, /could not read entries\/zzz\.yaml/);
      assert.equal(readYaml(join(repo.root, 'entries/a.yaml')).slug, 'a');
      assert.equal(readJson(join(repo.root, 'schema/entry.schema.json')).type, 'object');
      assert.equal(entryPath('a'), 'entries/a.yaml');
      assert.deepEqual(Object.keys(loadData(repo.root)), ['schema', 'permissions', 'events', 'categories']);
      assert.equal(git(['no-such-command'], repo.root), null);
      assert.equal(entryAtRef('main', 'a', repo.root).slug, 'a');
      assert.equal(entryAtRef('main', 'missing', repo.root), null);
      repo.write('entries/c.yaml', makeEntry({ slug: 'c' }));
      repo.write('entries/a.yaml', makeEntry({ slug: 'a', notes: 'n' }));
      repo.write('README.md', 'x');
      repo.commit('second');
      assert.deepEqual(changedEntrySlugs('main~1', repo.root), ['a', 'c']);
      assert.throws(() => changedEntrySlugs('nope', repo.root), /fetch the base branch first/);
      assert.deepEqual(contributorsOf('entries/a.yaml', repo.root), ['Test Author']);
      assert.deepEqual(contributorsOf('entries/never.yaml', repo.root), []);
    } finally {
      repo.cleanup();
    }
  });

  test('todayUtc', () => {
    assert.equal(todayUtc(new Date('2026-02-03T23:59:59Z')), '2026-02-03');
    assert.match(todayUtc(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('data integrity', () => {
  test('every real entry is valid', async () => {
    const data = await realData();
    for (const slug of listEntrySlugs()) {
      const { entry } = readEntry(slug);
      assert.deepEqual(checkEntry(entry, { slug, today: todayUtc(), data }), [], slug);
    }
  });

  test('permission tiers and event references are consistent', async () => {
    const { permissions, events, categories } = await realData();
    const tiers = Object.keys(permissions.tiers);
    for (const [key, def] of Object.entries(permissions.permissions)) {
      assert.ok(['repository', 'organization', 'user', 'enterprise'].includes(def.scope), key);
      assert.ok(Object.keys(def.levels).length > 0, key);
      for (const level of Object.values(def.levels)) {
        assert.ok(tiers.includes(level.tier), key);
        assert.ok(level.blast_radius.length > 10, key);
      }
      assert.match(def.docs_url, /^https:\/\/docs\.github\.com\//, key);
      if (def.alias_of) assert.ok(permissions.permissions[def.alias_of], key);
    }
    for (const [name, def] of Object.entries(events.events)) {
      for (const key of def.requires_any ?? []) assert.ok(permissions.permissions[key], `${name} -> ${key}`);
    }
    assert.ok(Object.keys(categories.categories).length > 5);
    assert.deepEqual(Object.keys(permissions.permissions), Object.keys(permissions.permissions).sort());
    assert.deepEqual(Object.keys(events.events), Object.keys(events.events).sort());
  });
});

describe('serve', () => {
  test('resolvePath stays inside the root', () => {
    assert.equal(resolvePath('/srv/site', '/'), '/srv/site/index.html');
    assert.equal(resolvePath('/srv/site', '/lib/a.js?x=1'), '/srv/site/lib/a.js');
    assert.equal(resolvePath('/srv/site', '/../secret'), null);
    assert.equal(resolvePath('/srv/site', '/%2e%2e/secret'), null);
    assert.equal(resolvePath('/srv/site', '/sub/'), '/srv/site/sub/index.html');
  });

  test('serves files with content types and handles errors', async () => {
    const { server, url } = await startServer({ port: 0 });
    try {
      const page = await fetch(url);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type'), /text\/html/);
      assert.equal(page.headers.get('cache-control'), 'no-store');
      assert.match((await fetch(`${url}style.css`)).headers.get('content-type'), /text\/css/);
      assert.match((await fetch(`${url}app.js`)).headers.get('content-type'), /text\/javascript/);
      assert.equal((await fetch(`${url}missing.json`)).status, 404);
      const bad = await fetch(`${url}%2e%2e%2fpackage.json`);
      assert.equal(bad.status, 400);
    } finally {
      server.close();
    }
  });

  test('serves registry.json as JSON and unknown types as octet-stream', async () => {
    const repo = fixtureRepo({}, { gitInit: false });
    repo.write('site/registry.json', '{}');
    repo.write('site/x.bin', 'x');
    const { server, url } = await startServer({ root: join(repo.root, 'site'), port: 0 });
    try {
      assert.match((await fetch(`${url}registry.json`)).headers.get('content-type'), /application\/json/);
      assert.equal((await fetch(`${url}x.bin`)).headers.get('content-type'), 'application/octet-stream');
    } finally {
      server.close();
      repo.cleanup();
    }
  });

  test('the CLI listens on PORT', async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [join(REPO, 'scripts/serve.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const line = await new Promise((r) => child.stdout.once('data', (d) => r(String(d))));
      assert.match(line, new RegExp(`Serving site/ at http://127\\.0\\.0\\.1:${port}/`));
      assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    } finally {
      child.kill();
    }
  });
});
