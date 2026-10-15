// Client-side search and filters over the registry.

import { highestTier, tierRank, permissionSet } from './risk.js';

/** Lower-cased text an entry can be found by. */
export function searchText(entry, categories) {
  const keys = new Set(Object.keys(entry.manifest.default_permissions));
  for (const v of entry.variants ?? []) for (const k of Object.keys(v.default_permissions)) keys.add(k);
  return [entry.slug, entry.name, entry.vendor, entry.category, categories?.[entry.category] ?? '', ...keys]
    .join(' ')
    .toLowerCase();
}

/**
 * Filters and sorts entries.
 * @param {object[]} entries
 * @param {{query?: string, category?: string, maxTier?: string, owner?: string}} filters
 *   owner: "user" | "org" | "enterprise" | "ghes" — only entries that support it
 * @param {{permissions: object, categories?: object}} tables
 */
export function filterEntries(entries, { query = '', category = '', maxTier = '', owner = '' }, tables) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries
    .filter((e) => !category || e.category === category)
    .filter((e) => !owner || e.supports[owner])
    .filter((e) => !maxTier || tierRank(highestTier(e, tables.permissions)) <= tierRank(maxTier))
    .filter((e) => {
      const text = searchText(e, tables.categories);
      return words.every((w) => text.includes(w));
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Reads filters from a URL hash such as `#q=renovate&category=iac`. */
export function filtersFromHash(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return {
    query: params.get('q') ?? '',
    category: params.get('category') ?? '',
    maxTier: params.get('tier') ?? '',
    owner: params.get('owner') ?? '',
  };
}

/** The inverse of filtersFromHash; empty filters are left out. */
export function hashFromFilters({ query, category, maxTier, owner }) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (category) params.set('category', category);
  if (maxTier) params.set('tier', maxTier);
  if (owner) params.set('owner', owner);
  const s = params.toString();
  return s ? `#${s}` : '';
}

/** Total permission count for the default variant, shown in the list. */
export function permissionCount(entry) {
  return Object.keys(permissionSet(entry).permissions).length;
}
