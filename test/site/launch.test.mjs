import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLaunchUrl, buildManifest, checkAppName, defaultAppName, defaultTarget, isCloudHost,
  launchablePermissions, manifestFormAction, manifestSupported, MAX_APP_NAME, newState, parseTarget,
  registrationUrl, TARGET_KINDS,
} from '../../site/lib/launch.js';
import { makeEntry, makeWebhookEntry, realData } from '../helpers.mjs';

let table;
before(async () => {
  table = (await realData()).permissions;
});

const org = { kind: 'org', owner: 'acme', host: 'github.com' };

describe('isCloudHost', () => {
  test('accepts github.com and ghe.com subdomains only', () => {
    assert.equal(isCloudHost('github.com'), true);
    assert.equal(isCloudHost('octo.ghe.com'), true);
    assert.equal(isCloudHost('ghe.com'), false);
    assert.equal(isCloudHost('a.b.ghe.com'), false);
    assert.equal(isCloudHost('github.example.com'), false);
    assert.equal(isCloudHost('evilghe.com'), false);
  });
});

describe('parseTarget', () => {
  test('normalizes valid targets', () => {
    assert.deepEqual(parseTarget({ kind: 'org', owner: ' acme ', host: ' HTTPS://GitHub.Example.com/ ' }), { ok: true, target: { kind: 'org', owner: 'acme', host: 'github.example.com' } });
    assert.deepEqual(parseTarget({ kind: 'personal', owner: 'ignored' }), { ok: true, target: { kind: 'personal', owner: '', host: 'github.com' } });
    assert.deepEqual(parseTarget({ kind: 'enterprise', owner: 'big-co', host: '' }), { ok: true, target: { kind: 'enterprise', owner: 'big-co', host: 'github.com' } });
    assert.deepEqual(parseTarget({ kind: 'personal', host: 'http://x.ghe.com' }).target.host, 'x.ghe.com');
  });

  test('rejects bad input', () => {
    assert.deepEqual(parseTarget({ kind: 'team' }), { ok: false, error: 'Choose who will own the app.' });
    assert.deepEqual(parseTarget({ kind: 'org', owner: '' }), { ok: false, error: 'Enter the organization name (letters, numbers and hyphens).' });
    assert.deepEqual(parseTarget({ kind: 'enterprise', owner: 'bad/name' }), { ok: false, error: 'Enter the enterprise name (letters, numbers and hyphens).' });
    assert.equal(parseTarget({ kind: 'org', owner: '-leading' }).ok, false);
    assert.equal(parseTarget({ kind: 'org', owner: 'a'.repeat(40) }).ok, false);
    assert.equal(parseTarget({ kind: 'org', owner: 'a'.repeat(39) }).ok, true);
    assert.deepEqual(parseTarget({ kind: 'personal', host: 'not a host' }), { ok: false, error: 'Enter a host name such as github.example.com.' });
    assert.equal(parseTarget({ kind: 'personal', host: 'localhost' }).ok, false);
    assert.equal(parseTarget({ kind: 'personal', host: 'evil.com/path' }).ok, false);
  });

  test('can require a host for GHES-only entries', () => {
    assert.deepEqual(parseTarget({ kind: 'personal', host: '  ' }, { requireHost: true }), { ok: false, error: 'Enter your GitHub Enterprise Server host name.' });
    assert.equal(parseTarget({ kind: 'personal', host: 'ghe.acme.io' }, { requireHost: true }).ok, true);
  });
});

describe('defaultTarget', () => {
  test('prefers an organization, then personal, then enterprise', () => {
    assert.deepEqual(defaultTarget(makeEntry()), { kind: 'org', owner: '', host: 'github.com' });
    assert.equal(defaultTarget(makeEntry({ supports: { user: true, org: false, enterprise: true, ghes: false } })).kind, 'personal');
    assert.equal(defaultTarget(makeEntry({ supports: { user: false, org: false, enterprise: true, ghes: false } })).kind, 'enterprise');
    assert.equal(defaultTarget(makeEntry({ supports: { user: false, org: false, enterprise: false, ghes: true } })).kind, 'org');
    assert.equal(defaultTarget(makeEntry({ own_app: 'ghes-only' })).host, '');
  });
  test('knows the owner kinds', () => {
    assert.deepEqual(TARGET_KINDS, {
      personal: { label: 'Personal account', needsOwner: false },
      org: { label: 'Organization', needsOwner: true },
      enterprise: { label: 'Enterprise', needsOwner: true },
    });
  });
});

describe('registrationUrl', () => {
  test('builds the three owner URLs', () => {
    assert.equal(registrationUrl({ kind: 'personal', host: 'github.com' }), 'https://github.com/settings/apps/new');
    assert.equal(registrationUrl(org), 'https://github.com/organizations/acme/settings/apps/new');
    assert.equal(registrationUrl({ kind: 'enterprise', owner: 'big', host: 'ghe.acme.io' }), 'https://ghe.acme.io/enterprises/big/settings/apps/new');
  });
});

describe('checkAppName', () => {
  test('trims and limits length', () => {
    assert.deepEqual(checkAppName('  My App '), { ok: true, name: 'My App' });
    assert.deepEqual(checkAppName('   '), { ok: false, error: 'Enter a name for the app.' });
    assert.equal(checkAppName('x'.repeat(MAX_APP_NAME)).ok, true);
    assert.deepEqual(checkAppName('x'.repeat(MAX_APP_NAME + 1)), { ok: false, error: 'GitHub app names can be at most 34 characters.' });
  });
});

describe('launchablePermissions', () => {
  test('drops manual-only permissions', () => {
    assert.deepEqual(launchablePermissions({ contents: 'read', enterprise_copilot_metrics: 'read', unknown: 'read' }, table), { contents: 'read', unknown: 'read' });
  });
});

describe('buildLaunchUrl', () => {
  test('pre-fills everything for an organization', () => {
    const entry = makeWebhookEntry({
      manifest: {
        description: 'Does things & stuff',
        callback_urls: ['https://example.com/cb1', 'https://example.com/cb2'],
        request_oauth_on_install: true,
        setup_url: 'https://example.com/setup',
        setup_on_update: false,
        public: true,
        default_permissions: { pull_requests: 'write', contents: 'read', metadata: 'read', enterprise_copilot_metrics: 'read' },
      },
    });
    const url = buildLaunchUrl(entry, { target: org, appName: 'Example (acme)', table });
    assert.equal(url, 'https://github.com/organizations/acme/settings/apps/new?'
      + 'name=Example%20(acme)&description=Does%20things%20%26%20stuff&url=https%3A%2F%2Fexample.com'
      + '&callback_urls[]=https%3A%2F%2Fexample.com%2Fcb1&callback_urls[]=https%3A%2F%2Fexample.com%2Fcb2'
      + '&request_oauth_on_install=true&setup_url=https%3A%2F%2Fexample.com%2Fsetup&setup_on_update=false'
      + '&public=true&webhook_active=true&webhook_url=https%3A%2F%2Fhooks.example.com%2Fgithub'
      + '&events[]=pull_request&events[]=push'
      + '&contents=read&metadata=read&pull_requests=write');
  });

  test('omits the webhook URL and events when inactive, and public for enterprises', () => {
    const url = buildLaunchUrl(makeEntry(), { target: { kind: 'enterprise', owner: 'big', host: 'github.com' }, appName: 'E', table });
    assert.equal(url, 'https://github.com/enterprises/big/settings/apps/new?name=E&url=https%3A%2F%2Fexample.com&webhook_active=false&contents=read&metadata=read');
  });

  test('uses the selected variant', () => {
    const entry = makeWebhookEntry({
      variants: [
        { id: 'a', name: 'A', default_permissions: { contents: 'read', metadata: 'read', pull_requests: 'write' }, default_events: ['push'] },
        { id: 'b', name: 'B', default_permissions: { issues: 'write' }, default_events: ['issues'] },
      ],
    });
    const url = buildLaunchUrl(entry, { target: org, appName: 'X', variantId: 'b', table });
    assert.match(url, /&events\[\]=issues&issues=write$/);
    assert.doesNotMatch(url, /contents=/);
  });
});

describe('manifest flow', () => {
  test('is supported for user and org owners on cloud hosts only', () => {
    assert.equal(manifestSupported(org), true);
    assert.equal(manifestSupported({ kind: 'personal', host: 'x.ghe.com' }), true);
    assert.equal(manifestSupported({ kind: 'enterprise', owner: 'e', host: 'github.com' }), false);
    assert.equal(manifestSupported({ kind: 'org', owner: 'a', host: 'github.example.com' }), false);
  });

  test('builds the form action with state', () => {
    assert.equal(manifestFormAction(org, 'ab cd'), 'https://github.com/organizations/acme/settings/apps/new?state=ab%20cd');
    assert.throws(() => manifestFormAction({ kind: 'enterprise', owner: 'e', host: 'github.com' }, 's'), /only supports personal and organization owners/);
  });

  test('builds the manifest from the entry', () => {
    const entry = makeWebhookEntry({ manifest: { description: 'D', callback_urls: ['https://e.com/cb'], setup_url: 'https://e.com/s', setup_on_update: true, request_oauth_on_install: false } });
    const manifest = buildManifest(entry, { appName: 'Mine', redirectUrl: 'https://site/callback.html', table });
    assert.deepEqual(manifest, {
      name: 'Mine',
      url: 'https://example.com',
      hook_attributes: { url: 'https://hooks.example.com/github', active: true },
      redirect_url: 'https://site/callback.html',
      public: false,
      default_permissions: { contents: 'read', metadata: 'read', pull_requests: 'write' },
      default_events: ['pull_request', 'push'],
      description: 'D',
      callback_urls: ['https://e.com/cb'],
      setup_url: 'https://e.com/s',
      setup_on_update: true,
      request_oauth_on_install: false,
    });
    assert.notEqual(manifest.hook_attributes, entry.manifest.hook_attributes);
  });

  test('sends no events for an inactive webhook and drops manual-only permissions', () => {
    const entry = makeEntry({ manifest: { default_events: ['push'], default_permissions: { contents: 'read', enterprise_copilot_metrics: 'read' } } });
    const manifest = buildManifest(entry, { appName: 'A', redirectUrl: 'https://r', table });
    assert.deepEqual(manifest.default_events, []);
    assert.deepEqual(manifest.default_permissions, { contents: 'read' });
    assert.equal('description' in manifest, false);
  });

  test('newState returns 32 hex characters from the crypto source', () => {
    const fake = { getRandomValues: (a) => a.fill(10) };
    assert.equal(newState(fake), '0a'.repeat(16));
    assert.match(newState(), /^[0-9a-f]{32}$/);
    assert.notEqual(newState(), newState());
  });
});

describe('defaultAppName', () => {
  test('appends the owner when it fits', () => {
    const entry = makeEntry({ manifest: { name: 'Example' } });
    assert.equal(defaultAppName(entry), 'Example');
    assert.equal(defaultAppName(entry, { owner: 'acme' }), 'Example (acme)');
    assert.equal(defaultAppName(entry, { owner: 'x'.repeat(30) }), 'Example');
    const long = makeEntry({ manifest: { name: 'y'.repeat(34) } });
    assert.equal(defaultAppName(long, { owner: 'a' }), 'y'.repeat(34));
    // 30 + " (a)" is exactly 34 characters and fits; 31 + " (a)" doesn't.
    assert.equal(defaultAppName(makeEntry({ manifest: { name: 'z'.repeat(30) } }), { owner: 'a' }), `${'z'.repeat(30)} (a)`);
    assert.equal(defaultAppName(makeEntry({ manifest: { name: 'z'.repeat(31) } }), { owner: 'a' }), 'z'.repeat(31));
  });
});
