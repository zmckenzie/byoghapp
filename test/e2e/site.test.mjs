// Browser tests: the real site in headless Chrome, driven over the DevTools
// protocol. Also measures line coverage of the browser-only glue (app.js and
// callback.js) and fails below 90%.
//
// Skipped when no Chrome is installed, unless E2E_REQUIRE_BROWSER=1 (CI sets it).

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser, findChrome } from './cdp.mjs';
import { CoverageCollector } from '../../scripts/lib/coverage.mjs';
import { buildRegistry } from '../../scripts/build.mjs';
import { startServer } from '../../scripts/serve.mjs';
import { REPO } from '../helpers.mjs';

const chrome = findChrome();
const required = process.env.E2E_REQUIRE_BROWSER === '1';
const skip = !chrome && !required ? 'no Chrome or Chromium found (set CHROME_PATH)' : false;
const COVERAGE_THRESHOLD = 90;
const GLUE = ['app.js', 'callback.js'];

describe('site in a browser', { skip }, () => {
  let browser;
  let page;
  let server;
  let base;
  let siteDir;
  const coverage = new CoverageCollector(GLUE, (p) => readFileSync(join(REPO, 'site', p), 'utf8'));

  /** A JavaScript literal for value, safe to splice into evaluated code. */
  const js = (value) => JSON.stringify(value).replace(/[<>/\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const $eval = (expr) => page.evaluate(expr);
  const text = (sel) => $eval(`document.querySelector(${js(sel)})?.textContent ?? null`);
  const count = (sel) => $eval(`document.querySelectorAll(${js(sel)}).length`);
  /** Sets a form control's value and fires the input event, as typing would. */
  const type = (sel, value) => $eval(`(() => { const el = document.querySelector(${js(sel)}); el.value = ${js(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const click = (sel) => $eval(`document.querySelector(${js(sel)}).click()`);
  const hidden = (sel) => $eval(`document.querySelector(${js(sel)}).hidden`);

  /** Full navigation: saves coverage from the outgoing document first. */
  async function load(url) {
    coverage.add(await page.takeCoverage());
    await page.goto(url);
  }

  before(async () => {
    // Serve a copy of site/ with a freshly built registry, so the working tree is untouched.
    siteDir = mkdtempSync(join(tmpdir(), 'byoghapp-e2e-'));
    cpSync(join(REPO, 'site'), siteDir, { recursive: true });
    writeFileSync(join(siteDir, 'registry.json'), JSON.stringify(buildRegistry({ contributors: () => ['Test Contributor'] })));
    ({ server, url: base } = await startServer({ root: siteDir, port: 0 }));
    browser = await Browser.launch({ chromePath: chrome });
    page = await browser.newPage();
    await page.startCoverage();
  });

  after(async () => {
    await browser?.close();
    server?.close();
    rmSync(siteDir, { recursive: true, force: true });
  });

  test('lists every entry and filters them', async () => {
    await load(base);
    await page.waitFor("document.querySelectorAll('.card').length > 0");
    const total = await count('.card');
    assert.ok(total >= 10);
    assert.match(await text('.count'), new RegExp(`^${total} entries$`));
    assert.match(await text('#generated'), /entries, built \d{4}-\d{2}-\d{2}/);
    assert.ok(await count('#category option') > 5);
    assert.equal(await count('#tier option'), 5);

    await type('#q', 'renovate');
    assert.equal(await count('.card'), 1);
    assert.equal(await $eval('location.hash'), '#q=renovate');
    assert.equal(await text('.count'), '1 entry');

    await type('#q', '');
    await type('#category', 'iac');
    assert.ok((await count('.card')) >= 2);
    assert.match(await $eval('location.hash'), /category=iac/);

    await type('#category', '');
    await type('#tier', 'medium');
    const mediumOrLower = await $eval("[...document.querySelectorAll('.card .tier')].map((t) => t.textContent)");
    assert.ok(mediumOrLower.length > 0 && mediumOrLower.every((t) => ['Low', 'Medium'].includes(t)));

    await type('#tier', '');
    await type('#owner-filter', 'enterprise');
    assert.ok(await count('.card') >= 1);

    await type('#owner-filter', '');
    await type('#q', 'zzz-no-such-thing');
    assert.match(await text('#view'), /No entries match these filters/);
    await type('#q', '');
    assert.equal(await $eval('location.hash'), '');
    assert.equal(await count('.card'), total);
  });

  test('restores filters from the URL and submitting does nothing', async () => {
    await load(`${base}#q=argo&tier=critical`);
    await page.waitFor("document.querySelectorAll('.card').length > 0");
    assert.equal(await $eval("document.querySelector('#q').value"), 'argo');
    assert.equal(await count('.card'), 1);
    await $eval("document.querySelector('#filters').dispatchEvent(new Event('submit', { cancelable: true }))");
    assert.equal(await count('.card'), 1);
  });

  test('shows an entry with variants and builds the launch link', async () => {
    await page.goto(`${base}#/entry/backstage`);
    await page.waitFor("!!document.querySelector('.detail h1')");
    assert.equal(await text('.detail h1'), 'Backstage');
    assert.equal(await $eval('document.title'), 'Backstage: byoghapp');
    assert.equal(await hidden('#filters'), true);
    assert.match(await text('.detail'), /Contributors: Test Contributor/);
    assert.equal(await $eval("document.querySelector('input[value=personal]').disabled"), true);

    // No organization yet: the link is disabled with an error.
    assert.equal(await hidden('#target-error'), false);
    assert.match(await text('#target-error'), /Enter the organization name/);
    assert.equal(await $eval("document.querySelector('#launch-link').getAttribute('aria-disabled')"), 'true');
    assert.equal(await $eval("document.querySelector('#launch-link').hasAttribute('href')"), false);

    await type('#owner', 'acme');
    assert.equal(await hidden('#target-error'), true);
    const href = await $eval("document.querySelector('#launch-link').href");
    assert.match(href, /^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?name=Backstage&/);
    assert.match(href, /&contents=read&/);

    await type('#variant', 'templates');
    assert.match(await text('#risk'), /Administration/);
    assert.match(await text('#variant-description'), /publishing software templates/);
    assert.match(await $eval("document.querySelector('#launch-link').href"), /administration=write/);
    await type('#variant', 'catalog');
    assert.equal(await $eval("document.querySelector('#launch-link').href.includes('administration')"), false);

    await type('#app-name', 'x'.repeat(30) + '    ');
    assert.equal(await hidden('#target-error'), true);
    await type('#app-name', '   ');
    assert.match(await text('#target-error'), /Enter a name for the app/);
    await type('#app-name', 'Backstage');

    await $eval("document.querySelector('#target-form').dispatchEvent(new Event('submit', { cancelable: true }))");
    assert.equal(await text('.detail h1'), 'Backstage');
  });

  test('enterprise and GHES targets switch off the manifest flow', async () => {
    await page.goto(`${base}#/entry/dx-github-security`);
    await page.waitFor("document.querySelector('.detail h1')?.textContent === 'DX GitHub Security connector'");
    await type('#owner', 'big-co');
    assert.equal(await $eval("document.querySelector('#manifest-button').disabled"), false);
    assert.equal(await hidden('#manifest-unavailable'), true);
    await click('input[value=enterprise]');
    await $eval("document.querySelector('#target-form').dispatchEvent(new Event('input', { bubbles: true }))");
    assert.match(await $eval("document.querySelector('#launch-link').href"), /^https:\/\/github\.com\/enterprises\/big-co\/settings\/apps\/new\?/);
    assert.equal(await $eval("document.querySelector('#manifest-button').disabled"), true);
    assert.equal(await hidden('#manifest-unavailable'), false);
    await click('input[value=org]');
    await type('#host', 'github.acme.internal');
    assert.match(await $eval("document.querySelector('#launch-link').href"), /^https:\/\/github\.acme\.internal\/organizations\/big-co\//);
    assert.equal(await $eval("document.querySelector('#manifest-button').disabled"), true);
    await type('#host', 'not a host');
    assert.match(await text('#target-error'), /Enter a host name/);
    assert.equal(await $eval("document.querySelector('#manifest-button').disabled"), true);
    // Clicking a disabled-state button does nothing.
    await $eval("document.querySelector('#manifest-button').disabled = false");
    await click('#manifest-button');
    assert.equal(await $eval("sessionStorage.length"), 0);
  });

  test('GHES-only entries ask for the host', async () => {
    await page.goto(`${base}#/entry/claude-code-ghes`);
    await page.waitFor("document.querySelector('.detail h1')?.textContent.startsWith('Claude Code')");
    await type('#owner', 'acme');
    assert.match(await text('#target-error'), /Enter your GitHub Enterprise Server host name/);
    await type('#host', 'ghe.acme.io');
    assert.match(await $eval("document.querySelector('#launch-link').href"), /^https:\/\/ghe\.acme\.io\//);
  });

  test('the manifest button posts the manifest and remembers the launch', async () => {
    await page.goto(`${base}#/entry/coderabbit-ghes`);
    await page.waitFor("document.querySelector('.detail h1')?.textContent.startsWith('CodeRabbit')");
    await $eval('HTMLFormElement.prototype.submit = function () { window.__submitted = { action: this.action, method: this.method, manifest: this.elements.manifest.value }; }');
    await type('#host', 'octo.ghe.com');
    await type('#owner', 'acme');
    await click('#manifest-button');
    const submitted = await $eval('window.__submitted');
    const state = JSON.parse(await $eval("sessionStorage.getItem('byoghapp:manifest-launch')"));
    assert.equal(submitted.method, 'post');
    assert.equal(submitted.action, `https://octo.ghe.com/organizations/acme/settings/apps/new?state=${state.state}`);
    assert.equal(state.host, 'octo.ghe.com');
    assert.equal(state.slug, 'coderabbit-ghes');
    const manifest = JSON.parse(submitted.manifest);
    assert.equal(manifest.redirect_url, `${base}callback.html`);
    assert.equal(manifest.hook_attributes.url, 'https://app.coderabbit.ai/githubHandler');
    assert.ok(manifest.default_events.includes('pull_request'));
  });

  test('unknown entries show a not-found page', async () => {
    await page.goto(`${base}#/entry/no-such-entry`);
    await page.waitFor("document.querySelector('.detail h1')?.textContent === 'Entry not found'");
    assert.match(await text('.detail'), /no-such-entry/);
  });

  const conversion = { id: 42, slug: 'my-app', name: 'My App', html_url: 'https://github.com/apps/my-app', client_id: 'Iv1.abc', client_secret: 'secret-1', webhook_secret: null, pem: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----' };
  const remember = (state, host = 'github.com') => $eval(`sessionStorage.setItem('byoghapp:manifest-launch', JSON.stringify({ state: ${js(state)}, host: ${js(host)}, slug: 'renovate', created: Date.now() }))`);
  const fakeConversion = (status, body) => $eval(`window.fetch = async (url, init) => { window.__converted = { url, method: init.method }; return new Response(${js(JSON.stringify(body))}, { status: ${status} }); }`);

  test('the callback shows the credentials once, after a click', async () => {
    await load(base);
    await remember('s-1');
    await load(`${base}callback.html?code=code-1&state=s-1`);
    await page.waitFor("!document.querySelector('#step-confirm').hidden");
    assert.equal(await $eval('location.search'), '');
    assert.equal(await text('#host'), 'github.com');
    await fakeConversion(201, conversion);
    await click('#convert');
    await page.waitFor("!document.querySelector('#step-done').hidden");
    assert.deepEqual(await $eval('window.__converted'), { url: 'https://api.github.com/app-manifests/code-1/conversions', method: 'POST' });
    assert.equal(await $eval("sessionStorage.getItem('byoghapp:manifest-launch')"), null);
    assert.equal(await text('#app-name'), 'My App');
    assert.equal(await $eval("document.querySelector('#app-id').value"), '42');
    assert.equal(await $eval("document.querySelector('#client-secret').value"), 'secret-1');
    assert.equal(await $eval("document.querySelector('#webhook-secret').value"), '(webhook inactive)');
    assert.match(await $eval("document.querySelector('#pem').value"), /BEGIN RSA PRIVATE KEY/);
    assert.match(await $eval("document.querySelector('#download').href"), /^blob:/);
    assert.match(await $eval("document.querySelector('#download').download"), /^my-app\.\d{4}-\d{2}-\d{2}\.private-key\.pem$/);
    assert.equal(await $eval("document.querySelector('#app-link').href"), 'https://github.com/apps/my-app');

    await click('#clear');
    assert.equal(await hidden('#step-cleared'), false);
    assert.equal(await $eval("document.querySelector('#pem').value"), '');
    assert.equal(await text('#app-name'), '');
    await page.send('Page.reload');
  });

  test('the callback clears secrets when the page is left', async () => {
    await load(base);
    await remember('s-2');
    await load(`${base}callback.html?code=code-2&state=s-2`);
    await page.waitFor("!document.querySelector('#step-confirm').hidden");
    await fakeConversion(201, { ...conversion, webhook_secret: 'wh', html_url: 'javascript:alert(1)' });
    await click('#convert');
    await page.waitFor("!document.querySelector('#step-done').hidden");
    assert.equal(await $eval("document.querySelector('#webhook-secret').value"), 'wh');
    assert.equal(await $eval("document.querySelector('#app-link').getAttribute('href')"), '#');
    await $eval("window.dispatchEvent(new Event('pagehide'))");
    assert.equal(await $eval("document.querySelector('#client-secret').value"), '');
  });

  test('the callback explains failures', async () => {
    await load(`${base}callback.html`);
    await page.waitFor("!document.querySelector('#step-error').hidden");
    assert.match(await text('#error-message'), /expects a code from GitHub/);

    await remember('s-3');
    await load(`${base}callback.html?code=c&state=wrong`);
    await page.waitFor("!document.querySelector('#step-error').hidden");
    assert.match(await text('#error-message'), /does not match/);

    await remember('s-4');
    await load(`${base}callback.html?code=used&state=s-4`);
    await page.waitFor("!document.querySelector('#step-confirm').hidden");
    await fakeConversion(422, { message: 'gone' });
    await click('#convert');
    await page.waitFor("!document.querySelector('#step-error').hidden");
    assert.match(await text('#error-message'), /already used or has expired/);
  });

  test('pages load without console errors or CSP violations', async () => {
    page.consoleErrors.length = 0;
    await load(base);
    await page.waitFor("document.querySelectorAll('.card').length > 0");
    await page.goto(`${base}#/entry/renovate`);
    await page.waitFor("!!document.querySelector('.detail h1')");
    assert.deepEqual(page.consoleErrors, []);
  });

  test('works at phone width without sideways scrolling', async () => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    try {
      for (const hash of ['', '#/entry/axonius']) {
        await page.goto(`${base}${hash || '#'}`);
        await page.waitFor("!!document.querySelector('.card, .detail h1')");
        assert.ok(await $eval('document.documentElement.scrollWidth <= window.innerWidth'), `overflow at ${hash || 'list'}`);
      }
    } finally {
      await page.send('Emulation.clearDeviceMetricsOverride');
    }
  });

  test('shows an error when the registry fails to load', async () => {
    rmSync(join(siteDir, 'registry.json'));
    try {
      await load(`${base}?missing`);
      await page.waitFor("document.querySelector('#view .error') !== null");
      assert.match(await text('#view .error'), /Could not load the registry: registry\.json returned HTTP 404/);
    } finally {
      writeFileSync(join(siteDir, 'registry.json'), JSON.stringify(buildRegistry({ contributors: () => [] })));
    }
  });

  test(`browser glue has at least ${COVERAGE_THRESHOLD}% line coverage`, async () => {
    coverage.add(await page.takeCoverage());
    const report = coverage.report();
    for (const r of report) console.log(`# browser coverage ${r.path}: ${r.percent.toFixed(1)}% (${r.covered}/${r.total})${r.uncovered.length ? ` uncovered lines ${r.uncovered.join(', ')}` : ''}`);
    for (const r of report) assert.ok(r.percent >= COVERAGE_THRESHOLD, `${r.path} line coverage ${r.percent.toFixed(1)}% is below ${COVERAGE_THRESHOLD}% (uncovered: ${r.uncovered.join(', ')})`);
  });
});
