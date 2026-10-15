// Permission risk model. Tiers come from data/permissions.json; this module only
// combines them, so no entry ever carries hand-written risk text.

export const TIER_ORDER = ['low', 'medium', 'high', 'critical'];

/** Numeric rank of a tier name (low = 1 … critical = 4); 0 for unknown. */
export function tierRank(tier) {
  return TIER_ORDER.indexOf(tier) + 1;
}

/**
 * The permission set and events for an entry, optionally for one variant.
 * Unknown variant ids fall back to the manifest.
 */
export function permissionSet(entry, variantId) {
  const variant = entry.variants?.find((v) => v.id === variantId);
  const source = variant ?? entry.manifest;
  return { permissions: source.default_permissions, events: source.default_events, variant: variant ?? null };
}

/**
 * Tier for one permission at one level, given the install scope.
 * Returns null when the key or level is not in the table.
 */
export function permissionTier(table, key, level, repositories = 'selected') {
  const def = table.permissions[key]?.levels?.[level];
  if (!def) return null;
  if (repositories === 'all' && def.tier_all_repositories) return def.tier_all_repositories;
  return def.tier;
}

/**
 * Risk summary for an entry (or one of its variants).
 * @returns {{
 *   items: {key: string, name: string, level: string, tier: string|null, blastRadius: string, docsUrl: string|null, manualOnly: boolean}[],
 *   histogram: Record<string, number>, highest: string|null, writeAnywhere: boolean,
 *   manualOnly: string[], webhook: {active: boolean, events: string[], secretRecommended: boolean}
 * }}
 */
export function summarize(entry, table, variantId) {
  const { permissions, events } = permissionSet(entry, variantId);
  const repositories = entry.install_scope?.repositories ?? 'selected';
  const histogram = Object.fromEntries(TIER_ORDER.map((t) => [t, 0]));
  const items = [];
  for (const [key, level] of Object.entries(permissions)) {
    const def = table.permissions[key];
    const tier = permissionTier(table, key, level, repositories);
    if (tier) histogram[tier] += 1;
    items.push({
      key,
      name: def?.name ?? key,
      scope: def?.scope ?? 'unknown',
      level,
      tier,
      blastRadius: def?.levels?.[level]?.blast_radius ?? 'Not in the permissions table.',
      docsUrl: def?.docs_url ?? null,
      manualOnly: Boolean(def?.manual_only),
    });
  }
  items.sort((a, b) => tierRank(b.tier) - tierRank(a.tier) || a.key.localeCompare(b.key));
  const highest = items.length > 0 && items[0].tier ? items[0].tier : null;
  const active = Boolean(entry.manifest.hook_attributes?.active);
  return {
    items,
    histogram,
    highest,
    writeAnywhere: items.some((i) => i.level === 'write' || i.level === 'admin'),
    manualOnly: items.filter((i) => i.manualOnly).map((i) => i.key),
    webhook: { active, events: [...events], secretRecommended: active },
  };
}

/** Highest tier across the manifest and every variant: used for list filtering. */
export function highestTier(entry, table) {
  const ids = [undefined, ...(entry.variants ?? []).map((v) => v.id)];
  let best = null;
  for (const id of ids) {
    const { highest } = summarize(entry, table, id);
    if (tierRank(highest) > tierRank(best)) best = highest;
  }
  return best;
}
