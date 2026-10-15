import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRegistry, buildTime } from '../../scripts/build.mjs';
import { ALLOWED_URL, EXPECTED_CSP, lintHtml, lintSite, lintUrls } from '../../scripts/lint-site.mjs';
import { REPO, fixtureRepo, makeEntry, runScript } from '../helpers.mjs';

describe('buildRegistry', () => {
  test('bundles entries, tables and contributors', () => {
    const repo = fixtureRepo({ example: { $schema: '../schema/entry.schema.json', ...makeEntry() } });
    try {
      const registry = buildRegistry({ root: repo.root, now: new Date('2026-06-01T00:00:00Z'), contributors: (slug) => [`${slug}-author`] });
      assert.equal(registry.generated_at, '2026-06-01T00:00:00.000Z');
      assert.equal(registry.entries.length, 1);
      assert.equal('$schema' in registry.entries[0], false);
      assert.ok(registry.permissions.permissions.contents);
      assert.ok(registry.events.events.push);
      assert.ok(registry.categories.categories['ci-cd']);
      assert.deepEqual(registry.contributors, { example: ['example-author'] });
    } finally {
      repo.cleanup();
    }
  });

  test('uses git history for contributors by default', () => {
    const repo = fixtureRepo({ example: makeEntry() });
    try {
      assert.deepEqual(buildRegistry({ root: repo.root, now: new Date('2026-06-01') }).contributors, { example: ['Test Author'] });
    } finally {
      repo.cleanup();
    }
  });

  test('refuses invalid entries', () => {
    const repo = fixtureRepo({ example: makeEntry({ category: 'nope' }) });
    repo.write('entries/broken.yaml', '{');
    try {
      assert.throws(() => buildRegistry({ root: repo.root, now: new Date('2026-06-01'), contributors: () => [] }), (err) => {
        assert.match(err.message, /Refusing to build with invalid entries/);
        assert.match(err.message, /broken: could not read/);
        assert.match(err.message, /example: category "nope"/);
        return true;
      });
    } finally {
      repo.cleanup();
    }
  });

  test('the CLI writes site/registry.json', () => {
    const repo = fixtureRepo({ example: makeEntry() });
    mkdirSync(join(repo.root, 'site'));
    try {
      const r = runScript('scripts/build.mjs', [], { root: repo.root });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Wrote site\/registry\.json: 1 entries/);
      assert.equal(JSON.parse(readFileSync(join(repo.root, 'site/registry.json'), 'utf8')).entries[0].slug, 'example');
      const pinned = () => {
        assert.equal(runScript('scripts/build.mjs', [], { root: repo.root, env: { SOURCE_DATE_EPOCH: '1780000000' } }).code, 0);
        return readFileSync(join(repo.root, 'site/registry.json'), 'utf8');
      };
      const first = pinned();
      assert.equal(JSON.parse(first).generated_at, '2026-05-28T20:26:40.000Z');
      assert.equal(pinned(), first, 'the same commit and SOURCE_DATE_EPOCH build the same file');
    } finally {
      repo.cleanup();
    }
  });

  test('buildTime honours SOURCE_DATE_EPOCH', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    assert.equal(buildTime({}, now), now);
    assert.equal(buildTime({ SOURCE_DATE_EPOCH: '' }, now), now);
    assert.equal(buildTime({ SOURCE_DATE_EPOCH: '0' }, now).toISOString(), '1970-01-01T00:00:00.000Z');
    assert.equal(buildTime({ SOURCE_DATE_EPOCH: '1780000000' }, now).toISOString(), '2026-05-28T20:26:40.000Z');
    for (const bad of ['-1', '1.5', 'soon', ' 1']) {
      assert.throws(() => buildTime({ SOURCE_DATE_EPOCH: bad }, now), new RegExp(`whole number of seconds, not "${bad.replace('.', '\\.')}"`));
    }
    assert.ok(buildTime({ SOURCE_DATE_EPOCH: '5' }) instanceof Date);
  });
});

const page = (csp, body = '') => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><script type="module" src="app.js"></script></head><body>${body}</body></html>`;

describe('lintHtml', () => {
  test('accepts the real pages', () => {
    for (const name of Object.keys(EXPECTED_CSP)) {
      assert.deepEqual(lintHtml(name, readFileSync(join(REPO, 'site', name), 'utf8')), [], name);
    }
  });

  test('requires the exact CSP for known pages', () => {
    assert.deepEqual(lintHtml('index.html', '<html></html>'), ['missing Content-Security-Policy meta tag']);
    assert.match(lintHtml('index.html', page("default-src *"))[0], /CSP differs from the expected policy/);
    assert.deepEqual(lintHtml('new.html', page('x')), ['page has no expected CSP: add it to EXPECTED_CSP in scripts/lint-site.mjs']);
    const late = `<html><head><link rel="stylesheet" href="s.css"><meta http-equiv="Content-Security-Policy" content="${EXPECTED_CSP['index.html']}"></head></html>`;
    assert.deepEqual(lintHtml('index.html', late), ['the CSP meta tag must come before any script, link or style element']);
  });

  test('rejects inline code, styles, handlers and remote assets', () => {
    const csp = EXPECTED_CSP['index.html'];
    assert.deepEqual(lintHtml('index.html', page(csp, '<script>alert(1)</script>')), ['inline <script> is not allowed', '<script> elements must be empty']);
    assert.deepEqual(lintHtml('index.html', page(csp, '<script>alert(1)</script >')), ['inline <script> is not allowed', '<script> elements must be empty']);
    assert.deepEqual(lintHtml('index.html', page(csp, '<script>alert(1)</script\tfoo>')), ['inline <script> is not allowed', '<script> elements must be empty']);
    assert.deepEqual(lintHtml('index.html', page(csp, '<style>p{}</style>')), ['<style> elements are not allowed']);
    assert.deepEqual(lintHtml('index.html', page(csp, '<p style="color:red">')), ['style attributes are not allowed']);
    assert.deepEqual(lintHtml('index.html', page(csp, '<button onclick="x()">')), ['event-handler attribute onclick= is not allowed']);
    assert.deepEqual(lintHtml('index.html', page(csp, '<script src="https://cdn.example/x.js"></script>')), ['https://cdn.example/x.js: scripts and stylesheets must load from the same origin']);
    assert.deepEqual(lintHtml('index.html', page(csp, '<link rel="stylesheet" href="//cdn.example/x.css">')), ['//cdn.example/x.css: scripts and stylesheets must load from the same origin']);
  });
});

describe('lintUrls', () => {
  test('allows GitHub, ghe.com and placeholders only', () => {
    assert.deepEqual(lintUrls('https://github.com/x https://api.github.com https://docs.github.com/y https://octo.ghe.com/z https://*.ghe.com; https://example.invalid/a `https://${host}/x` `https://api.${host}`'), []);
    assert.deepEqual(lintUrls('see https://evil.example/x and http://github.com'), ['URL not on the allowlist: https://evil.example/x', 'URL not on the allowlist: http://github.com']);
    assert.equal(ALLOWED_URL.test('https://github.com.evil.example/'), false);
  });
});

describe('lintSite', () => {
  test('passes the real site', () => {
    assert.deepEqual(lintSite(join(REPO, 'site')), []);
  });

  test('walks subdirectories, skips registry.json and flags other file types', () => {
    const dir = mkdtempSync(join(tmpdir(), 'byoghapp-site-'));
    try {
      mkdirSync(join(dir, 'lib'));
      writeFileSync(join(dir, 'lib/a.js'), 'fetch("https://tracker.example/p")');
      writeFileSync(join(dir, 'registry.json'), '{"url":"https://anything.example"}');
      writeFileSync(join(dir, 'logo.png'), '');
      writeFileSync(join(dir, 'index.html'), page(EXPECTED_CSP['index.html']));
      const results = lintSite(dir).sort((a, b) => a.file.localeCompare(b.file));
      assert.deepEqual(results, [
        { file: 'site/lib/a.js', problem: 'URL not on the allowlist: https://tracker.example/p' },
        { file: 'site/logo.png', problem: 'unexpected file type in site/ (only .html, .js and .css are published)' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the CLI reports OK for the real site', () => {
    const r = runScript('scripts/lint-site.mjs');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Site lint: OK/);
  });

  test('the CLI fails with annotations', () => {
    const repo = fixtureRepo({}, { gitInit: false });
    mkdirSync(join(repo.root, 'site'));
    writeFileSync(join(repo.root, 'site/x.js'), '"https://bad.example"');
    try {
      const r = runScript('scripts/lint-site.mjs', [], { root: repo.root });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /::error file=site\/x\.js::site\/x\.js: URL not on the allowlist/);
    } finally {
      repo.cleanup();
    }
  });
});
