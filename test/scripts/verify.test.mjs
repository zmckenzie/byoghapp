import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDocumentation, fetchPage, fingerprint, htmlToText, relevantLines } from '../../scripts/lib/online.mjs';
import { currentFingerprint, summaryMarkdown, verifyEntries } from '../../scripts/verify.mjs';
import { fakeFetch, fixtureRepo, makeEntry, realData } from '../helpers.mjs';

let data;
before(async () => {
  data = await realData();
});

const DOC = 'https://example.com/docs/github-app';
const PAGE = '<html><head><script>var x = "Contents: write";</script><style>p{}</style></head><body>'
  + '<nav>Home</nav><h1>Example Corp setup</h1><p>Grant <b>Contents</b>: Read-only</p><ul><li>Pull requests: read &amp; write</li></ul>'
  + '<p>Subscribe to the push event.</p><p>Unrelated paragraph about pricing.</p><!-- Contents: admin --></body></html>';

describe('htmlToText', () => {
  test('drops scripts, styles, comments and tags; keeps blocks on lines', () => {
    const text = htmlToText(PAGE);
    assert.ok(!text.includes('var x'));
    assert.ok(!text.includes('admin'));
    assert.deepEqual(text.split('\n'), ['Home Example Corp setup', 'Grant Contents : Read-only', 'Pull requests: read & write', 'Subscribe to the push event.', 'Unrelated paragraph about pricing.']);
    assert.equal(htmlToText('a&nbsp;b&lt;c&gt;&quot;d&#39;e&#x27;f'), 'a b<c>"d\'e\'f');
    assert.equal(htmlToText('<br>one<br/>two'), 'one\ntwo');
    assert.equal(htmlToText('&amp;lt;b&amp;gt; &amp;amp;'), '&lt;b&gt; &amp;');
  });
});

describe('relevantLines and fingerprint', () => {
  test('keeps lines that mention a permission or event with an access word', () => {
    const lines = relevantLines(htmlToText(PAGE), data.permissions, data.events);
    assert.deepEqual(lines, ['grant contents : read-only', 'pull requests: read & write', 'subscribe to the push event.']);
    assert.deepEqual(relevantLines('Contents\nread only things', data.permissions, data.events), []);
  });

  test('fingerprints are stable sha256 digests', () => {
    assert.equal(fingerprint(['a', 'b']), fingerprint(['a', 'b']));
    assert.notEqual(fingerprint(['a', 'b']), fingerprint(['a', 'c']));
    assert.match(fingerprint([]), /^sha256:[0-9a-f]{64}$/);
    assert.equal(fingerprint(['x']), 'sha256:2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881');
  });
});

describe('fetchPage', () => {
  test('returns text for OK responses only', async () => {
    const fetch = fakeFetch({ [DOC]: { body: 'hello' }, 'https://x/err': { status: 500, body: 'boom' } });
    assert.deepEqual(await fetchPage(DOC, fetch), { status: 200, text: 'hello' });
    assert.deepEqual(await fetchPage('https://x/err', fetch), { status: 500, text: '' });
    assert.deepEqual(await fetchPage('https://x/net', fakeFetch(() => new Error('dns'))), { error: 'dns' });
    const { init } = fetch.calls[0];
    assert.equal(init.redirect, 'follow');
    assert.match(init.headers['user-agent'], /byoghapp-verifier/);
    assert.ok(init.signal instanceof AbortSignal);
  });
});

describe('checkDocumentation', () => {
  test('requires every page to load and name the vendor or product', async () => {
    const entry = makeEntry({ documentation_urls: ['https://example.com/more'] });
    const ok = fakeFetch({ [DOC]: { body: 'EXAMPLE CORP docs' }, 'https://example.com/more': { body: 'about example' } });
    assert.deepEqual(await checkDocumentation(entry, ok), []);
    const bad = fakeFetch({ [DOC]: { body: 'nothing here' }, 'https://example.com/more': new Error('timeout') });
    assert.deepEqual(await checkDocumentation(entry, bad), [
      `${DOC} doesn't mention "Example Corp" or "Example"`,
      'https://example.com/more could not be fetched: timeout',
    ]);
    const product = makeEntry({ vendor: 'Acme (Group)', name: 'Widget' });
    assert.deepEqual(await checkDocumentation(product, fakeFetch({ [DOC]: { body: 'acme docs' } })), []);
    assert.deepEqual(await checkDocumentation(product, fakeFetch({ [DOC]: { body: 'widget docs' } })), []);
  });
});

describe('verifyEntries', () => {
  const hashOf = (html) => fingerprint(relevantLines(htmlToText(html), data.permissions, data.events));

  test('classifies ok, changed, no-baseline and unreachable entries', async () => {
    const withHash = (slug, hash, url = `https://docs.example/${slug}`) => makeEntry({ slug, documentation_url: url, verification: { status: 'needs-review', method: 'doc-hash', doc_hash: hash } });
    const repo = fixtureRepo({
      same: withHash('same', hashOf(PAGE)),
      moved: withHash('moved', hashOf(PAGE)),
      fresh: withHash('fresh', null),
      down: withHash('down', null),
      empty: withHash('empty', null),
    });
    repo.write('entries/broken.yaml', '{');
    try {
      const fetch = fakeFetch({
        'https://docs.example/same': { body: PAGE },
        'https://docs.example/moved': { body: PAGE.replace('Read-only', 'Read and write') },
        'https://docs.example/fresh': { body: PAGE },
        'https://docs.example/down': { status: 503 },
        'https://docs.example/empty': { body: '<p>nothing relevant</p>' },
      });
      const report = await verifyEntries({ root: repo.root, fetch, now: new Date('2026-06-01T00:00:00Z') });
      assert.equal(report.generated_at, '2026-06-01T00:00:00.000Z');
      const by = Object.fromEntries(report.results.map((r) => [r.slug, r]));
      assert.equal(by.same.status, 'ok');
      assert.equal(by.moved.status, 'changed');
      assert.notEqual(by.moved.current_hash, by.moved.stored_hash);
      assert.equal(by.fresh.status, 'no-baseline');
      assert.equal(by.fresh.current_hash, hashOf(PAGE));
      assert.deepEqual(by.down, { slug: 'down', documentation_url: 'https://docs.example/down', last_verified: null, stored_hash: null, status: 'unreachable', error: 'https://docs.example/down: HTTP 503' });
      assert.equal(by.empty.error, 'no permission-related text found on the documentation pages');
      assert.equal(by.broken.status, 'unreachable');
      assert.match(by.broken.error, /could not read/);

      const only = await verifyEntries({ root: repo.root, fetch, slugs: ['same'] });
      assert.deepEqual(only.results.map((r) => r.slug), ['same']);
    } finally {
      repo.cleanup();
    }
  });

  test('currentFingerprint combines all documentation pages', async () => {
    const entry = makeEntry({ documentation_urls: ['https://example.com/b'] });
    const fetch = fakeFetch({ [DOC]: { body: '<p>Contents: read</p>' }, 'https://example.com/b': { body: '<p>Issues: write</p>' } });
    assert.deepEqual(await currentFingerprint(entry, data, fetch), { hash: fingerprint(['contents: read', 'issues: write']) });
    const failing = fakeFetch({ [DOC]: { body: '<p>Contents: read</p>' }, 'https://example.com/b': new Error('reset') });
    assert.deepEqual(await currentFingerprint(entry, data, failing), { error: 'https://example.com/b: reset' });
  });

  test('summaryMarkdown counts statuses and escapes pipes', () => {
    const md = summaryMarkdown({ results: [
      { slug: 'a', status: 'ok' },
      { slug: 'b', status: 'no-baseline', current_hash: 'sha256:1' },
      { slug: 'c', status: 'unreachable', error: 'x | y' },
      { slug: 'd', status: 'ok' },
    ] });
    assert.match(md, /^## Documentation verification\n\nok: 2 · no-baseline: 1 · unreachable: 1\n\n\| Entry \| Status \| Detail \|\n\| --- \| --- \| --- \|\n\| a \| ok \|  \|\n/);
    assert.ok(md.endsWith('| d | ok |  |\n'));
    assert.ok(md.includes('| a | ok |  |'));
    assert.ok(md.includes('| b | no-baseline | record `sha256:1` with /verified |'));
    assert.ok(md.includes('| c | unreachable | x \\| y |'));
  });
});
