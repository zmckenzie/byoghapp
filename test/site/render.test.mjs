import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  esc, renderEntryCard, renderEntryDetail, renderEntryList, renderNotFound, renderOptions, renderRisk, safeUrl, tierBadge,
} from '../../site/lib/render.js';
import { makeEntry, makeWebhookEntry, realData } from '../helpers.mjs';

let table;
let categories;
before(async () => {
  const data = await realData();
  table = data.permissions;
  categories = data.categories.categories;
});

const XSS = '<img src=x onerror="alert(1)">\'&';

describe('esc and safeUrl', () => {
  test('escapes HTML-significant characters', () => {
    assert.equal(esc(XSS), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;');
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
    assert.equal(esc(5), '5');
  });

  test('only allows https and fragments', () => {
    assert.equal(safeUrl('https://example.com/a?b=1&c="2"'), 'https://example.com/a?b=1&amp;c=&quot;2&quot;');
    assert.equal(safeUrl('#/entry/x'), '#/entry/x');
    assert.equal(safeUrl('javascript:alert(1)'), '#');
    assert.equal(safeUrl('http://example.com'), '#');
    assert.equal(safeUrl('data:text/html,hi'), '#');
    assert.equal(safeUrl('not a url'), '#');
    assert.equal(safeUrl(null), '#');
  });
});

describe('tierBadge', () => {
  test('labels tiers and unrated', () => {
    assert.equal(tierBadge('critical', table), '<span class="tier tier-critical">Critical</span>');
    assert.equal(tierBadge(null, table), '<span class="tier tier-none">Unrated</span>');
    assert.equal(tierBadge('weird', table), '<span class="tier tier-weird">weird</span>');
  });
});

describe('renderOptions', () => {
  test('marks the selected option and escapes', () => {
    assert.equal(renderOptions([['a', 'A'], ['<b>', 'B&']], '<b>'), '<option value="a">A</option><option value="&lt;b&gt;" selected>B&amp;</option>');
  });
});

describe('list view', () => {
  test('cards escape entry data and link by slug', () => {
    const entry = makeEntry({ slug: 'x-y', name: XSS, vendor: XSS });
    const html = renderEntryCard(entry, { table, categories, highest: 'high' });
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('href="#/entry/x-y"'));
    assert.ok(html.includes('tier-high'));
    assert.ok(html.includes('CI/CD'));
    assert.ok(html.includes('Requires your own app'));
    assert.ok(html.includes('Needs review'));
    assert.ok(html.includes('>Personal<') && html.includes('>Organization<') && html.includes('>GHES<'));
    assert.ok(!html.includes('>Enterprise<'));
  });

  test('cards show verification and unknown categories', () => {
    const entry = makeEntry({ category: 'mystery', last_verified: '2026-01-02', verified_by: 'maint', verification: { status: 'ok', method: 'doc-hash', doc_hash: null } });
    const html = renderEntryCard(entry, { table, categories, highest: null });
    assert.ok(html.includes('Verified'));
    assert.ok(html.includes('on 2026-01-02 by maint'));
    assert.ok(html.includes('>mystery<'));
    const failed = renderEntryCard(makeEntry({ verification: { status: 'failed', method: 'manual', doc_hash: null } }), { table, categories, highest: null });
    assert.ok(failed.includes('Verification failed'));
  });

  test('the list counts entries and has an empty state', () => {
    const ctx = { table, categories, highestBySlug: new Map([['example', 'low']]) };
    assert.match(renderEntryList([makeEntry()], ctx), /^<p class="count">1 entry<\/p>/);
    assert.match(renderEntryList([makeEntry(), makeEntry({ slug: 'b' })], ctx), /2 entries/);
    assert.match(renderEntryList([], ctx), /No entries match these filters/);
  });
});

describe('renderRisk', () => {
  test('shows the headline, histogram, webhook and rows', () => {
    const html = renderRisk(makeWebhookEntry(), table);
    assert.ok(html.includes('Can write'));
    assert.ok(html.includes('Active, 2 events: <code>pull_request</code> <code>push</code>'));
    assert.ok(html.includes('Pull requests'));
    assert.ok(html.includes('<code>pull_requests</code>'));
    assert.ok(html.includes('href="https://docs.github.com/'));
    assert.equal((html.match(/<tr>/g) ?? []).length, 1 + 3);
  });

  test('read-only, single event, no events and manual-only wording', () => {
    assert.ok(renderRisk(makeEntry(), table).includes('Read-only'));
    assert.ok(renderRisk(makeEntry(), table).includes('Inactive: GitHub sends no events'));
    const one = makeWebhookEntry({ manifest: { default_events: ['push'] } });
    assert.ok(renderRisk(one, table).includes('Active, 1 event: <code>push</code>'));
    const none = makeWebhookEntry({ manifest: { default_events: [] } });
    assert.ok(renderRisk(none, table).includes('Active, 0 events: none'));
    const manual = makeEntry({ manifest: { default_permissions: { enterprise_copilot_metrics: 'read' } } });
    assert.ok(renderRisk(manual, table).includes("can't be pre-filled: add it by hand"));
    assert.ok(renderRisk(manual, table).includes('Set by hand'));
    const two = makeEntry({ manifest: { default_permissions: { enterprise_copilot_metrics: 'read', enterprise_custom_properties_for_organizations: 'read' } } });
    assert.ok(renderRisk(two, table).includes('add them by hand'));
    assert.ok(!renderRisk(makeEntry(), table).includes('by hand'));
  });

  test('unknown permission docs links are neutralized', () => {
    const html = renderRisk(makeEntry({ manifest: { default_permissions: { mystery: 'read' } } }), table);
    assert.ok(html.includes('<a href="#"'));
  });
});

describe('renderEntryDetail', () => {
  const ctx = (over = {}) => ({ table, categories, target: { kind: 'org', owner: 'acme', host: 'github.com' }, appName: 'Example', ...over });

  test('renders an unverified entry with its facts and launcher', () => {
    const entry = makeEntry({ notes: XSS, manual_steps: ['Do <this>'], documentation_urls: ['https://example.com/more'] });
    const html = renderEntryDetail(entry, ctx());
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('data-slug="example"'));
    assert.ok(html.includes('A maintainer has not yet confirmed'));
    assert.ok(html.includes('Do &lt;this&gt;'));
    assert.ok(html.includes('https://example.com/more'));
    assert.ok(html.includes('Report a problem'));
    assert.ok(html.includes('report-problem.yml'));
    assert.ok(html.includes('value="acme"'));
    assert.ok(html.includes('value="org" checked'));
    assert.ok(html.includes('value="enterprise" disabled'));
    assert.ok(html.includes('not supported by the vendor'));
    assert.ok(html.includes('placeholder="github.com"'));
    assert.ok(html.includes('App ID, Private key'));
    assert.ok(html.includes('Selected repositories'));
    assert.ok(html.includes('Pre-filled'));
    assert.ok(html.includes('Steps GitHub'));
    assert.ok(!html.includes('Contributors:'));
    assert.ok(!html.includes('id="variant"'));
  });

  test('renders verification, two-step webhooks, variants and contributors', () => {
    const entry = makeEntry({
      own_app: 'ghes-only',
      two_step_webhook: true,
      credentials_needed: [],
      supports: { user: false, org: false, enterprise: false, ghes: true },
      install_scope: { repositories: 'all', level: 'org', notes: 'Every org' },
      last_verified: '2026-01-02',
      verified_by: 'maint',
      verification: { status: 'ok', method: 'doc-hash', doc_hash: null },
      variants: [
        { id: 'a', name: 'Alpha', description: 'First <one>', default_permissions: { contents: 'read', metadata: 'read' }, default_events: [] },
        { id: 'b', name: 'Beta', description: 'Second', default_permissions: { issues: 'write' }, default_events: [] },
      ],
      changelog: [{ date: '2026-01-02', version: '1.1.0', author: 'maint', summary: 'Changed', pr: 12 }, { date: '2026-01-01', version: '1.0.0', author: 'alice', summary: 'Initial' }],
    });
    const html = renderEntryDetail(entry, ctx({ variantId: 'b', contributors: ['Alice <a>'] }));
    assert.ok(!html.includes('A maintainer has not yet confirmed'));
    assert.ok(html.includes('Own app on GitHub Enterprise Server'));
    assert.ok(html.includes('Known only after the vendor side is set up'));
    assert.ok(html.includes('Nothing: the vendor stores its own credentials'));
    assert.ok(html.includes('All repositories · org · Every org'));
    assert.ok(html.includes('None listed') === false);
    assert.ok(html.includes('<option value="b" selected>Beta</option>'));
    assert.ok(html.includes('>Second<'));
    assert.ok(html.includes('placeholder="github.example.com"'));
    assert.ok(html.includes('pull/12">#12</a>'));
    assert.ok(html.includes('Contributors: Alice &lt;a&gt;'));
    assert.ok(!html.includes('Steps GitHub'));
    const first = renderEntryDetail(entry, ctx({ variantId: undefined }));
    assert.ok(first.includes('<option value="a" selected>Alpha</option>'));
    assert.ok(first.includes('First &lt;one&gt;'));
  });

  test('handles entries without supported owners or variant descriptions', () => {
    const entry = makeEntry({
      supports: { user: false, org: false, enterprise: false, ghes: false },
      install_scope: { repositories: 'either', level: 'user' },
      variants: [
        { id: 'a', name: 'A', default_permissions: { contents: 'read', metadata: 'read' }, default_events: [] },
        { id: 'b', name: 'B', default_permissions: {}, default_events: [] },
      ],
    });
    const html = renderEntryDetail(entry, ctx({ variantId: 'missing' }));
    assert.ok(html.includes('None listed'));
    assert.ok(html.includes('All or selected repositories · user</dd>'));
    assert.ok(html.includes('id="variant-description"></p>'));
  });
});

describe('renderNotFound', () => {
  test('escapes the slug', () => {
    assert.ok(renderNotFound('<x>').includes('<code>&lt;x&gt;</code>'));
  });
});
