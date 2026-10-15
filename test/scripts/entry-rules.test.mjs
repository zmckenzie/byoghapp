import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkChange, checkEntry, checkPermissionSet, codeOwnersFor, compareVersions, isPlaceholderUrl,
} from '../../scripts/lib/entry-rules.mjs';
import { makeEntry, makeWebhookEntry, realData } from '../helpers.mjs';

let data;
before(async () => {
  data = await realData();
});

const TODAY = '2026-06-01';
const check = (entry, slug = entry.slug) => checkEntry(entry, { slug, today: TODAY, data });

describe('isPlaceholderUrl', () => {
  test('recognises example.invalid only', () => {
    assert.equal(isPlaceholderUrl('https://example.invalid/x'), true);
    assert.equal(isPlaceholderUrl('https://example.com/x'), false);
    assert.equal(isPlaceholderUrl('not a url'), false);
  });
});

describe('compareVersions', () => {
  test('orders x.y.z numerically', () => {
    assert.ok(compareVersions('1.0.0', '1.0.1') < 0);
    assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
    assert.ok(compareVersions('2.0.0', '10.0.0') < 0);
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  });
});

describe('checkPermissionSet', () => {
  const set = (permissions, events = []) => checkPermissionSet({ label: 'manifest', permissions, events }, data);

  test('accepts known permissions, levels and satisfied events', () => {
    assert.deepEqual(set({ contents: 'read' }, ['push']), []);
    assert.deepEqual(set({ issues: 'write', pull_requests: 'read' }, ['milestone']), []);
    assert.deepEqual(set({}, ['security_advisory']), []);
  });

  test('rejects unknown permissions and levels', () => {
    assert.deepEqual(set({ nope: 'read' }), ['manifest: unknown permission "nope" (not in data/permissions.json)']);
    assert.match(set({ workflows: 'read' })[0], /permission "workflows" has no "read" level \(allowed: write\)/);
  });

  test('rejects events without their permission', () => {
    assert.deepEqual(set({ metadata: 'read' }, ['push']), ['manifest: webhook event "push" needs one of these permissions: contents']);
  });

  test('rejects unknown and unsubscribable events', () => {
    assert.match(set({}, ['made_up'])[0], /unknown webhook event "made_up"/);
    assert.match(set({}, ['installation'])[0], /can't be subscribed to by a GitHub App/);
  });
});

describe('checkEntry', () => {
  test('accepts a valid entry', () => {
    assert.deepEqual(check(makeEntry()), []);
    assert.deepEqual(check(makeWebhookEntry()), []);
  });

  test('reports schema errors first and only', () => {
    const errors = check({ ...makeEntry(), slug: 'Bad Slug' }, 'x');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^\$\.slug must match pattern/);
  });

  test('slug must match the file name', () => {
    assert.deepEqual(check(makeEntry(), 'other'), ['slug "example" must match the file name "other.json"']);
  });

  test('category must exist', () => {
    assert.deepEqual(check(makeEntry({ category: 'not-a-category' })), ['category "not-a-category" is not in data/categories.json']);
  });

  test('checks variants and requires variant 0 to match the manifest', () => {
    const v = (id, perms) => ({ id, name: id, default_permissions: perms, default_events: [] });
    const ok = makeEntry({ variants: [v('a', { contents: 'read', metadata: 'read' }), v('b', { contents: 'write', metadata: 'read' })] });
    assert.deepEqual(check(ok), []);
    const mismatch = makeEntry({ variants: [v('a', { contents: 'write' }), v('b', { contents: 'read' })] });
    assert.deepEqual(check(mismatch), ['variants[0] must have the same permissions as manifest (the default variant)']);
    const dup = makeEntry({ variants: [v('a', { contents: 'read', metadata: 'read' }), v('a', { contents: 'read' })] });
    assert.deepEqual(check(dup), ['variant ids must be unique']);
    const badVariant = makeEntry({ variants: [v('a', { contents: 'read', metadata: 'read' }), v('b', { nope: 'read' })] });
    assert.deepEqual(check(badVariant), ['variants[b]: unknown permission "nope" (not in data/permissions.json)']);
  });

  test('manual-only permissions need manual steps', () => {
    const entry = makeEntry({ manifest: { default_permissions: { enterprise_copilot_metrics: 'read' } } });
    assert.deepEqual(check(entry), ['permissions enterprise_copilot_metrics can only be set by hand: describe them in manual_steps']);
    assert.deepEqual(check({ ...entry, manual_steps: ['Add it by hand.'] }), []);
  });

  test('events need an active webhook', () => {
    const entry = makeWebhookEntry({ manifest: { hook_attributes: { url: 'https://hooks.example.com', active: false } } });
    assert.deepEqual(check(entry), ['webhook events are listed but manifest.hook_attributes.active is false']);
  });

  test('placeholder webhook URLs and two_step_webhook go together', () => {
    const placeholder = makeWebhookEntry({ manifest: { hook_attributes: { url: 'https://example.invalid/hook', active: true } } });
    assert.match(check(placeholder)[0], /hook_attributes.url is a placeholder: set two_step_webhook to true/);
    assert.deepEqual(check({ ...placeholder, two_step_webhook: true }), []);
    const real = makeWebhookEntry({ two_step_webhook: true });
    assert.match(check(real)[0], /two_step_webhook is true, so hook_attributes.url must be a placeholder/);
    // An inactive webhook may keep any URL.
    assert.deepEqual(check(makeEntry({ two_step_webhook: true })), []);
  });

  test('enterprise support requires a private app', () => {
    const entry = makeEntry({ supports: { user: false, org: true, enterprise: true, ghes: false }, manifest: { public: true } });
    assert.deepEqual(check(entry), ['manifest.public must be false when supports.enterprise is true (enterprise-owned apps ignore "public")']);
    assert.deepEqual(check(makeEntry({ manifest: { public: true } })), []);
  });

  test('at least one owner type', () => {
    assert.deepEqual(check(makeEntry({ supports: { user: false, org: false, enterprise: false, ghes: false } })), ['supports must allow at least one owner type']);
  });

  test('verification fields are consistent', () => {
    assert.deepEqual(check(makeEntry({ last_verified: '2026-05-01', verified_by: null })), ['last_verified and verified_by must both be set or both be null']);
    assert.deepEqual(check(makeEntry({ last_verified: null, verified_by: 'alice' })), ['last_verified and verified_by must both be set or both be null']);
    assert.deepEqual(check(makeEntry({ last_verified: '2026-07-01', verified_by: 'alice' })), ['last_verified 2026-07-01 is in the future']);
    assert.deepEqual(check(makeEntry({ last_verified: TODAY, verified_by: 'alice' })), []);
    const okStatus = { status: 'ok', method: 'doc-hash', doc_hash: null };
    assert.deepEqual(check(makeEntry({ verification: okStatus })), ['verification.status "ok" needs last_verified and verified_by']);
    assert.deepEqual(check(makeEntry({ verification: okStatus, last_verified: TODAY, verified_by: 'alice' })), []);
  });

  test('changelog dates and order', () => {
    const line = (date, version) => ({ date, version, author: 'alice', summary: 's' });
    assert.deepEqual(check(makeEntry({ changelog: [line('2026-07-01', '1.0.0')] })), ['changelog[0].date 2026-07-01 is in the future']);
    assert.deepEqual(check(makeEntry({ changelog: [line(TODAY, '1.0.0')] })), []);
    assert.deepEqual(check(makeEntry({ changelog: [line('2026-03-01', '1.1.0'), line('2026-02-01', '1.0.0')] })), []);
    assert.deepEqual(check(makeEntry({ changelog: [line('2026-03-01', '1.1.0'), line('2026-03-01', '1.0.0')] })), []);
    const wrongOrder = [line('2026-02-01', '1.1.0'), line('2026-03-01', '1.0.0')];
    assert.deepEqual(check(makeEntry({ changelog: wrongOrder })), ['changelog[0] must be newer than changelog[1] (newest first, increasing versions)']);
    const sameVersion = [line('2026-03-01', '1.0.0'), line('2026-02-01', '1.0.0')];
    assert.equal(check(makeEntry({ changelog: sameVersion })).length, 1);
  });
});

describe('checkChange', () => {
  const ctx = { today: TODAY, maintainers: ['maint'], prAuthor: 'alice' };
  const line = (version, author = 'alice', date = TODAY) => ({ date, version, author, summary: 's' });
  const v1 = makeEntry({ changelog: [line('1.0.0', 'alice', '2026-01-01')] });

  test('unchanged entries pass', () => {
    assert.deepEqual(checkChange(v1, structuredClone(v1), ctx), []);
  });

  test('new entries pass when the author matches', () => {
    assert.deepEqual(checkChange(null, v1, ctx), []);
    assert.deepEqual(checkChange(null, v1, { ...ctx, prAuthor: 'ALICE' }), []);
  });

  test('a change needs a new changelog line at the top', () => {
    const edited = { ...v1, notes: 'changed' };
    assert.deepEqual(checkChange(v1, edited, ctx), ['the entry changed but changelog has no new line: add one at the top']);
    const good = { ...edited, changelog: [line('1.0.1'), ...v1.changelog] };
    assert.deepEqual(checkChange(v1, good, ctx), []);
    const bottom = { ...edited, changelog: [...v1.changelog, line('1.0.1')] };
    assert.ok(checkChange(v1, bottom, ctx).includes('new changelog lines must go at the top'));
  });

  test('re-verifying alone needs no changelog line', () => {
    const stamped = { ...v1, last_verified: TODAY, verified_by: 'maint', verification: { status: 'ok', method: 'doc-hash', doc_hash: `sha256:${'a'.repeat(64)}` } };
    assert.deepEqual(checkChange(v1, stamped, ctx), []);
    assert.deepEqual(checkChange(v1, { ...stamped, notes: 'also changed' }, ctx), ['the entry changed but changelog has no new line: add one at the top']);
  });

  test('old changelog lines are immutable', () => {
    const rewritten = { ...v1, changelog: [line('1.0.1'), { ...v1.changelog[0], summary: 'rewritten' }] };
    assert.ok(checkChange(v1, rewritten, ctx).includes('existing changelog lines must not be edited or removed'));
  });

  test('definition changes reset verification unless re-stamped today', () => {
    const verified = { ...v1, last_verified: '2026-01-02', verified_by: 'maint', verification: { status: 'ok', method: 'doc-hash', doc_hash: null } };
    const changed = { ...verified, manifest: { ...verified.manifest, default_permissions: { contents: 'write' } }, changelog: [line('1.1.0'), ...v1.changelog] };
    assert.match(checkChange(verified, changed, ctx)[0], /set verification.status to "needs-review"/);
    const reset = { ...changed, verification: { ...changed.verification, status: 'needs-review' } };
    assert.deepEqual(checkChange(verified, reset, ctx), []);
    const restamped = { ...changed, last_verified: TODAY };
    assert.deepEqual(checkChange(verified, restamped, ctx), []);
    const variants = { ...verified, variants: [], changelog: [line('1.1.0'), ...v1.changelog] };
    assert.equal(checkChange(verified, variants, ctx).length, 1);
    const notes = { ...verified, notes: 'n', changelog: [line('1.0.1'), ...v1.changelog] };
    assert.deepEqual(checkChange(verified, notes, ctx), []);
  });

  test('changelog author must be the PR author unless a maintainer opened it', () => {
    const next = { ...v1, notes: 'n', changelog: [line('1.0.1', 'mallory'), ...v1.changelog] };
    assert.deepEqual(checkChange(v1, next, ctx), ['changelog author "mallory" must be the pull request author "alice"']);
    assert.deepEqual(checkChange(v1, next, { ...ctx, prAuthor: 'Maint' }), []);
    assert.deepEqual(checkChange(v1, next, { ...ctx, prAuthor: undefined }), []);
  });

  test('only maintainers can be verified_by', () => {
    const stamped = { ...v1, notes: 'n', last_verified: TODAY, verified_by: 'alice', changelog: [line('1.0.1'), ...v1.changelog] };
    assert.deepEqual(checkChange(v1, stamped, ctx), ['verified_by "alice" must be a maintainer listed for /entries/ in CODEOWNERS']);
    assert.deepEqual(checkChange(v1, { ...stamped, verified_by: 'maint' }, ctx), []);
    assert.deepEqual(checkChange(null, { ...v1, last_verified: TODAY, verified_by: 'alice' }, ctx), ['verified_by "alice" must be a maintainer listed for /entries/ in CODEOWNERS']);
    // An unchanged verification by a former maintainer is left alone.
    const old = { ...v1, last_verified: '2026-01-02', verified_by: 'former' };
    assert.deepEqual(checkChange(old, { ...old, notes: 'n', changelog: [line('1.0.1'), ...v1.changelog] }, ctx), []);
    const redated = { ...old, last_verified: TODAY, notes: 'n', changelog: [line('1.0.1'), ...v1.changelog] };
    assert.equal(checkChange(old, redated, ctx).length, 1);
  });
});

describe('codeOwnersFor', () => {
  const file = [
    '# comment',
    '*            @everyone',
    '',
    '/entries/    @maint @org/team @other  # trailing comment',
    'docs/        @writer',
    '/SECURITY.md @sec',
  ].join('\n');

  test('last matching rule wins and teams are skipped', () => {
    assert.deepEqual(codeOwnersFor(file, 'entries/x.json'), ['maint', 'other']);
    assert.deepEqual(codeOwnersFor(file, 'README.md'), ['everyone']);
    assert.deepEqual(codeOwnersFor(file, 'docs/a.md'), ['writer']);
    assert.deepEqual(codeOwnersFor(file, 'SECURITY.md'), ['sec']);
    assert.deepEqual(codeOwnersFor(file, 'other/SECURITY.md'), ['everyone']);
    assert.deepEqual(codeOwnersFor('', 'x'), []);
  });
});
