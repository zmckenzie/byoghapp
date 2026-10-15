import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { filterEntries, filtersFromHash, hashFromFilters, permissionCount, searchText } from '../../site/lib/search.js';
import { makeEntry, realData } from '../helpers.mjs';

let tables;
before(async () => {
  const data = await realData();
  tables = { permissions: data.permissions, categories: data.categories.categories };
});

const renovate = makeEntry({ slug: 'renovate', name: 'Renovate', vendor: 'Mend', category: 'dependencies', manifest: { default_permissions: { contents: 'write', workflows: 'write' } } });
const argo = makeEntry({ slug: 'argo-cd', name: 'Argo CD', vendor: 'CNCF', category: 'gitops', supports: { user: false, org: true, enterprise: false, ghes: false } });
const sg = makeEntry({
  slug: 'sourcegraph', name: 'sourcegraph', vendor: 'Sourcegraph', category: 'code-search',
  supports: { user: false, org: true, enterprise: true, ghes: true },
  variants: [
    { id: 'a', name: 'A', default_permissions: { contents: 'read', metadata: 'read' }, default_events: [] },
    { id: 'b', name: 'B', default_permissions: { emails: 'read' }, default_events: [] },
  ],
});
const all = [renovate, argo, sg];
const slugs = (list) => list.map((e) => e.slug);

describe('searchText', () => {
  test('includes names, category label and permission keys from all variants', () => {
    const text = searchText(sg, tables.categories);
    for (const word of ['sourcegraph', 'code-search', 'code search', 'contents', 'emails']) assert.ok(text.includes(word), word);
    assert.equal(searchText(argo), 'argo-cd argo cd cncf gitops  contents metadata');
  });
});

describe('filterEntries', () => {
  test('sorts by name with no filters', () => {
    assert.deepEqual(slugs(filterEntries(all, {}, tables)), ['argo-cd', 'renovate', 'sourcegraph']);
  });

  test('matches every query word, case-insensitively', () => {
    assert.deepEqual(slugs(filterEntries(all, { query: 'WORKFLOWS' }, tables)), ['renovate']);
    assert.deepEqual(slugs(filterEntries(all, { query: '  contents   mend ' }, tables)), ['renovate']);
    assert.deepEqual(slugs(filterEntries(all, { query: 'emails' }, tables)), ['sourcegraph']);
    assert.deepEqual(slugs(filterEntries(all, { query: 'nothing-matches' }, tables)), []);
    assert.deepEqual(slugs(filterEntries(all, { query: 'dependency updates' }, tables)), ['renovate']);
  });

  test('filters by category, owner and maximum tier', () => {
    assert.deepEqual(slugs(filterEntries(all, { category: 'gitops' }, tables)), ['argo-cd']);
    assert.deepEqual(slugs(filterEntries(all, { owner: 'enterprise' }, tables)), ['sourcegraph']);
    assert.deepEqual(slugs(filterEntries(all, { owner: 'user' }, tables)), ['renovate']);
    assert.deepEqual(slugs(filterEntries(all, { maxTier: 'medium' }, tables)), ['argo-cd', 'sourcegraph']);
    assert.deepEqual(slugs(filterEntries(all, { maxTier: 'critical' }, tables)), ['argo-cd', 'renovate', 'sourcegraph']);
    assert.deepEqual(slugs(filterEntries(all, { maxTier: 'low' }, tables)), []);
  });
});

describe('hash round trip', () => {
  test('reads and writes filters', () => {
    const filters = { query: 'a b', category: 'iac', maxTier: 'high', owner: 'org' };
    const hash = hashFromFilters(filters);
    assert.equal(hash, '#q=a+b&category=iac&tier=high&owner=org');
    assert.deepEqual(filtersFromHash(hash), filters);
    assert.equal(hashFromFilters({ query: '', category: '', maxTier: '', owner: '' }), '');
    assert.deepEqual(filtersFromHash(''), { query: '', category: '', maxTier: '', owner: '' });
    assert.equal(hashFromFilters({ query: 'x' }), '#q=x');
    assert.equal(hashFromFilters({ category: 'c' }), '#category=c');
    assert.equal(hashFromFilters({ maxTier: 'low' }), '#tier=low');
    assert.equal(hashFromFilters({ owner: 'user' }), '#owner=user');
  });
});

describe('permissionCount', () => {
  test('counts the default permission set', () => {
    assert.equal(permissionCount(renovate), 2);
    assert.equal(permissionCount(sg), 2);
  });
});
