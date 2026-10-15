import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../scripts/validate.mjs';
import { fakeFetch, fixtureRepo, makeEntry, runScript } from '../helpers.mjs';

const TODAY = '2026-06-01';

describe('validate run()', () => {
  test('passes valid entries', async () => {
    const repo = fixtureRepo({ example: makeEntry() });
    try {
      assert.deepEqual(await run({ root: repo.root, today: TODAY }), { errors: [], checked: 1 });
    } finally {
      repo.cleanup();
    }
  });

  test('reports invalid and unreadable entries', async () => {
    const repo = fixtureRepo({ example: makeEntry({ category: 'nope' }) });
    repo.write('entries/broken.json', '{ not json');
    try {
      const { errors, checked } = await run({ root: repo.root, today: TODAY });
      assert.equal(checked, 2);
      assert.equal(errors.length, 2);
      assert.equal(errors[0].slug, 'broken');
      assert.match(errors[0].message, /could not read entries\/broken\.json/);
      assert.deepEqual(errors[1], { slug: 'example', message: 'category "nope" is not in data/categories.json' });
    } finally {
      repo.cleanup();
    }
  });

  test('checks changes against a base ref with the PR author', async () => {
    const repo = fixtureRepo({ example: makeEntry(), other: makeEntry({ slug: 'other' }) });
    try {
      repo.write('entries/example.json', makeEntry({ notes: 'changed' }));
      repo.write('entries/new-one.json', makeEntry({ slug: 'new-one', changelog: [{ date: '2026-01-01', version: '1.0.0', author: 'mallory', summary: 'x' }] }));
      repo.commit('pr');
      const { errors } = await run({ root: repo.root, base: 'main~1', prAuthor: 'alice', today: TODAY });
      assert.deepEqual(errors, [
        { slug: 'example', message: 'the entry changed but changelog has no new line: add one at the top' },
        { slug: 'new-one', message: 'changelog author "mallory" must be the pull request author "alice"' },
      ]);
    } finally {
      repo.cleanup();
    }
  });

  test('skips changed entries that fail to parse in the change check', async () => {
    const repo = fixtureRepo({ example: makeEntry() });
    try {
      repo.write('entries/example.json', '{');
      repo.commit('break');
      const { errors } = await run({ root: repo.root, base: 'main~1', today: TODAY });
      assert.equal(errors.length, 1);
      assert.match(errors[0].message, /could not read/);
    } finally {
      repo.cleanup();
    }
  });

  test('fails clearly when the base ref is missing', async () => {
    const repo = fixtureRepo({ example: makeEntry() });
    try {
      await assert.rejects(run({ root: repo.root, base: 'no-such-ref', today: TODAY }), /git diff against "no-such-ref" failed/);
    } finally {
      repo.cleanup();
    }
  });

  test('online mode checks every entry, or only changed ones with a base', async () => {
    const docs = 'https://example.com/docs/github-app';
    const repo = fixtureRepo({ example: makeEntry(), other: makeEntry({ slug: 'other', documentation_url: 'https://other.example/docs' }) });
    try {
      const fetch = fakeFetch({ [docs]: { body: 'Example Corp GitHub App' } });
      const all = await run({ root: repo.root, online: true, fetch, today: TODAY });
      assert.deepEqual(all.errors, [{ slug: 'other', message: 'https://other.example/docs returned HTTP 404' }]);
      repo.write('entries/example.json', makeEntry({ notes: 'n', changelog: [{ date: TODAY, version: '1.0.1', author: 'alice', summary: 's' }, ...makeEntry().changelog] }));
      repo.commit('pr');
      const changedOnly = await run({ root: repo.root, online: true, base: 'main~1', fetch, today: TODAY });
      assert.deepEqual(changedOnly.errors, []);
    } finally {
      repo.cleanup();
    }
  });
});

describe('validate CLI', () => {
  test('prints OK for valid entries', () => {
    const repo = fixtureRepo({ example: makeEntry() });
    try {
      const r = runScript('scripts/validate.mjs', [], { root: repo.root });
      assert.equal(r.code, 0);
      assert.match(r.stdout, /Validated 1 entries: OK/);
    } finally {
      repo.cleanup();
    }
  });

  test('prints GitHub annotations and fails for problems', () => {
    const repo = fixtureRepo({ example: makeEntry() });
    try {
      repo.write('entries/example.json', makeEntry({ notes: 'x' }));
      repo.commit('pr');
      const r = runScript('scripts/validate.mjs', ['--base', 'main~1', '--pr-author', 'alice'], { root: repo.root });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /::error file=entries\/example\.json::example: the entry changed/);
      assert.match(r.stderr, /1 problem\(s\) in 1 entries\./);
    } finally {
      repo.cleanup();
    }
  });
});
