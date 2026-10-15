import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { highestTier, permissionSet, permissionTier, summarize, tierRank, TIER_ORDER } from '../../site/lib/risk.js';
import { makeEntry, makeWebhookEntry, realData } from '../helpers.mjs';

let table;
before(async () => {
  table = (await realData()).permissions;
});

describe('tierRank', () => {
  test('orders tiers low to critical', () => {
    assert.deepEqual(TIER_ORDER.map(tierRank), [1, 2, 3, 4]);
    assert.equal(tierRank(null), 0);
    assert.equal(tierRank('nope'), 0);
  });
});

describe('permissionSet', () => {
  const variants = [
    { id: 'a', name: 'A', default_permissions: { contents: 'read' }, default_events: [] },
    { id: 'b', name: 'B', default_permissions: { contents: 'write' }, default_events: ['push'] },
  ];
  test('returns the manifest by default and a variant by id', () => {
    const entry = makeEntry({ variants });
    assert.deepEqual(permissionSet(entry), { permissions: entry.manifest.default_permissions, events: [], variant: null });
    assert.deepEqual(permissionSet(entry, 'b'), { permissions: { contents: 'write' }, events: ['push'], variant: variants[1] });
    assert.equal(permissionSet(entry, 'missing').variant, null);
    assert.equal(permissionSet(makeEntry(), 'a').variant, null);
  });
});

describe('permissionTier', () => {
  test('uses the level tier and escalates on all repositories', () => {
    assert.equal(permissionTier(table, 'contents', 'read'), 'medium');
    assert.equal(permissionTier(table, 'contents', 'write'), 'high');
    assert.equal(permissionTier(table, 'contents', 'write', 'all'), 'critical');
    assert.equal(permissionTier(table, 'contents', 'read', 'all'), 'medium');
    assert.equal(permissionTier(table, 'workflows', 'write'), 'critical');
    assert.equal(permissionTier(table, 'nope', 'read'), null);
    assert.equal(permissionTier(table, 'workflows', 'read'), null);
    assert.equal(permissionTier(table, 'constructor', 'read'), null);
    assert.equal(permissionTier(table, 'contents', 'constructor'), null);
  });
});

describe('summarize', () => {
  test('builds items sorted by tier then key, with a histogram', () => {
    const entry = makeEntry({ manifest: { default_permissions: { metadata: 'read', contents: 'write', issues: 'read', workflows: 'write' } } });
    const s = summarize(entry, table);
    assert.deepEqual(s.items.map((i) => [i.key, i.tier]), [['workflows', 'critical'], ['contents', 'high'], ['issues', 'low'], ['metadata', 'low']]);
    assert.deepEqual(s.histogram, { low: 2, medium: 0, high: 1, critical: 1 });
    assert.equal(s.highest, 'critical');
    assert.equal(s.writeAnywhere, true);
    assert.deepEqual(s.manualOnly, []);
    const contents = s.items[1];
    assert.equal(contents.name, 'Contents');
    assert.equal(contents.scope, 'repository');
    assert.equal(contents.level, 'write');
    assert.match(contents.blastRadius, /Push code/);
    assert.match(contents.docsUrl, /^https:\/\/docs\.github\.com\//);
    assert.equal(contents.manualOnly, false);
  });

  test('read-only entries and the all-repositories escalation', () => {
    const entry = makeEntry({ install_scope: { repositories: 'all', level: 'org' }, manifest: { default_permissions: { contents: 'read' } } });
    const s = summarize(entry, table);
    assert.equal(s.writeAnywhere, false);
    assert.equal(s.highest, 'medium');
    const writer = makeEntry({ install_scope: { repositories: 'all', level: 'org' }, manifest: { default_permissions: { contents: 'write' } } });
    assert.equal(summarize(writer, table).highest, 'critical');
    const admin = makeEntry({ manifest: { default_permissions: { organization_projects: 'admin' } } });
    assert.equal(summarize(admin, table).writeAnywhere, true);
    const noScope = makeEntry({ manifest: { default_permissions: { contents: 'write' } } });
    delete noScope.install_scope;
    assert.equal(summarize(noScope, table).highest, 'high');
  });

  test('unknown permissions are unrated but listed', () => {
    const s = summarize(makeEntry({ manifest: { default_permissions: { mystery: 'read' } } }), table);
    assert.deepEqual(s.items[0], {
      key: 'mystery', name: 'mystery', scope: 'unknown', level: 'read', tier: null,
      blastRadius: 'Not in the permissions table.', docsUrl: null, manualOnly: false,
    });
    assert.equal(s.highest, null);
    assert.deepEqual(s.histogram, { low: 0, medium: 0, high: 0, critical: 0 });
    assert.equal(summarize(makeEntry({ manifest: { default_permissions: {} } }), table).highest, null);
    assert.equal(summarize(makeEntry({ manifest: { default_permissions: { constructor: 'read' } } }), table).items[0].name, 'constructor');
  });

  test('flags manual-only permissions', () => {
    const s = summarize(makeEntry({ manifest: { default_permissions: { enterprise_copilot_metrics: 'read' } } }), table);
    assert.deepEqual(s.manualOnly, ['enterprise_copilot_metrics']);
  });

  test('describes the webhook', () => {
    assert.deepEqual(summarize(makeEntry(), table).webhook, { active: false, events: [], secretRecommended: false });
    assert.deepEqual(summarize(makeWebhookEntry(), table).webhook, { active: true, events: ['pull_request', 'push'], secretRecommended: true });
  });

  test('summarizes a variant', () => {
    const entry = makeEntry({
      variants: [
        { id: 'a', name: 'A', default_permissions: { contents: 'read', metadata: 'read' }, default_events: [] },
        { id: 'b', name: 'B', default_permissions: { administration: 'write' }, default_events: [] },
      ],
    });
    assert.equal(summarize(entry, table, 'b').highest, 'critical');
    assert.equal(summarize(entry, table, 'a').highest, 'medium');
  });
});

describe('highestTier', () => {
  test('takes the maximum across the manifest and all variants', () => {
    const entry = makeEntry({
      variants: [
        { id: 'a', name: 'A', default_permissions: { contents: 'read', metadata: 'read' }, default_events: [] },
        { id: 'b', name: 'B', default_permissions: { pull_requests: 'write' }, default_events: [] },
      ],
    });
    assert.equal(highestTier(entry, table), 'high');
    // A lower tier in a later variant must not replace a higher one found earlier.
    const decreasing = makeEntry({
      manifest: { default_permissions: { workflows: 'write' } },
      variants: [
        { id: 'a', name: 'A', default_permissions: { workflows: 'write' }, default_events: [] },
        { id: 'b', name: 'B', default_permissions: { metadata: 'read' }, default_events: [] },
      ],
    });
    assert.equal(highestTier(decreasing, table), 'critical');
    assert.equal(highestTier(makeEntry(), table), 'medium');
    assert.equal(highestTier(makeEntry({ manifest: { default_permissions: {} } }), table), null);
  });
});
