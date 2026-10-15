import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiBaseFor, convertManifest, forgetLaunch, pemFileName, readCallback, rememberLaunch, STATE_KEY,
} from '../../site/lib/callback.js';
import { fakeFetch } from '../helpers.mjs';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    data,
  };
}

const NOW = 1_000_000_000_000;

describe('launch state', () => {
  test('remember and forget', () => {
    const storage = memoryStorage();
    rememberLaunch(storage, { state: 's1', host: 'github.com', slug: 'renovate' }, NOW);
    assert.deepEqual(JSON.parse(storage.getItem(STATE_KEY)), { state: 's1', host: 'github.com', slug: 'renovate', created: NOW });
    forgetLaunch(storage);
    assert.equal(storage.getItem(STATE_KEY), null);
  });
});

describe('readCallback', () => {
  const saved = (over = {}) => {
    const storage = memoryStorage();
    rememberLaunch(storage, { state: 'abc', host: 'github.com', slug: 'renovate', ...over }, NOW);
    return storage;
  };

  test('accepts a matching state within the hour', () => {
    assert.deepEqual(readCallback('?code=xyz_1-2&state=abc', saved(), NOW + 1000), { ok: true, code: 'xyz_1-2', host: 'github.com', slug: 'renovate' });
    assert.equal(readCallback('?code=x&state=abc', saved(), NOW + 60 * 60 * 1000).ok, true);
  });

  test('rejects a missing or malformed code', () => {
    assert.match(readCallback('', saved(), NOW).error, /expects a code from GitHub/);
    assert.match(readCallback('?code=a%2Fb&state=abc', saved(), NOW).error, /unexpected format/);
    assert.match(readCallback(`?code=${'a'.repeat(129)}&state=abc`, saved(), NOW).error, /unexpected format/);
  });

  test('rejects without a saved launch', () => {
    assert.match(readCallback('?code=x&state=abc', memoryStorage(), NOW).error, /No launch from this browser tab/);
    assert.match(readCallback('?code=x&state=abc', memoryStorage({ [STATE_KEY]: '{bad json' }), NOW).error, /No launch/);
    assert.match(readCallback('?code=x&state=abc', memoryStorage({ [STATE_KEY]: '{"state":5}' }), NOW).error, /No launch/);
  });

  test('rejects a mismatched state, an expired launch or a bad host', () => {
    assert.match(readCallback('?code=x&state=other', saved(), NOW).error, /does not match/);
    assert.match(readCallback('?code=x', saved(), NOW).error, /does not match/);
    assert.match(readCallback('?code=x&state=abc', saved(), NOW + 60 * 60 * 1000 + 1).error, /more than an hour old/);
    assert.match(readCallback('?code=x&state=abc', saved({ host: 'evil.example' }), NOW).error, /unsupported host/);
  });
});

describe('apiBaseFor', () => {
  test('maps hosts to API bases', () => {
    assert.equal(apiBaseFor('github.com'), 'https://api.github.com');
    assert.equal(apiBaseFor('octo.ghe.com'), 'https://api.octo.ghe.com');
    assert.throws(() => apiBaseFor('github.example.com'), /Unsupported host/);
  });
});

describe('convertManifest', () => {
  const body = { id: 7, slug: 'my-app', name: 'My App', html_url: 'https://github.com/apps/my-app', client_id: 'Iv1', client_secret: 'cs', webhook_secret: 'ws', pem: '-----BEGIN-----' };

  test('posts the code and maps the response', async () => {
    const fetch = fakeFetch({ 'https://api.github.com/app-manifests/c0de/conversions': { status: 201, json: body } });
    const result = await convertManifest(fetch, 'github.com', 'c0de');
    assert.deepEqual(result, { ok: true, app: { id: 7, slug: 'my-app', name: 'My App', htmlUrl: 'https://github.com/apps/my-app', clientId: 'Iv1', clientSecret: 'cs', webhookSecret: 'ws', pem: '-----BEGIN-----' } });
    const { init } = fetch.calls[0];
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(init.headers.accept, 'application/vnd.github+json');
    assert.equal(init.headers['x-github-api-version'], '2022-11-28');
  });

  test('uses null when there is no webhook secret', async () => {
    const fetch = fakeFetch(() => ({ status: 201, json: { ...body, webhook_secret: undefined } }));
    assert.equal((await convertManifest(fetch, 'x.ghe.com', 'c')).app.webhookSecret, null);
    assert.equal(fetch.calls[0].url, 'https://api.x.ghe.com/app-manifests/c/conversions');
  });

  test('explains used, expired and other failures', async () => {
    for (const status of [404, 422]) {
      const r = await convertManifest(fakeFetch(() => ({ status })), 'github.com', 'c');
      assert.equal(r.ok, false);
      assert.match(r.error, /already used or has expired/);
    }
    const r = await convertManifest(fakeFetch(() => ({ status: 500 })), 'github.com', 'c');
    assert.match(r.error, /HTTP 500/);
    assert.match(r.error, /can't be reused/);
    const ok200 = await convertManifest(fakeFetch(() => ({ status: 200, json: body })), 'github.com', 'c');
    assert.match(ok200.error, /HTTP 200/);
  });

  test('handles network errors and incomplete responses', async () => {
    const down = await convertManifest(fakeFetch(() => new Error('offline')), 'github.com', 'c');
    assert.deepEqual(down, { ok: false, error: 'Could not reach GitHub: offline' });
    const noPem = await convertManifest(fakeFetch(() => ({ status: 201, json: { ...body, pem: '' } })), 'github.com', 'c');
    assert.match(noPem.error, /missing the app ID or private key/);
    const noId = await convertManifest(fakeFetch(() => ({ status: 201, json: { ...body, id: 0 } })), 'github.com', 'c');
    assert.equal(noId.ok, false);
  });
});

describe('pemFileName', () => {
  test('matches GitHub\'s naming and sanitizes the slug', () => {
    const date = new Date('2026-03-04T10:00:00Z');
    assert.equal(pemFileName({ slug: 'my-app' }, date), 'my-app.2026-03-04.private-key.pem');
    assert.equal(pemFileName({ slug: '../x y' }, date), '---x-y.2026-03-04.private-key.pem');
    assert.equal(pemFileName({}, date), 'github-app.2026-03-04.private-key.pem');
    assert.match(pemFileName({ slug: 'a' }), /^a\.\d{4}-\d{2}-\d{2}\.private-key\.pem$/);
  });
});
