// Cross-file rules for registry entries that JSON Schema can't express.
// Every function is pure: data comes in as arguments, so tests need no files.

import { validate as validateSchema, jsonEqual } from './json-schema.mjs';

export const PLACEHOLDER_HOST = 'example.invalid';
const LEVEL_RANK = { read: 1, write: 2, admin: 3 };

/** True for URLs under https://example.invalid/, the placeholder for customer-specific URLs. */
export function isPlaceholderUrl(url) {
  try {
    return new URL(url).hostname === PLACEHOLDER_HOST;
  } catch {
    return false;
  }
}

/** Compares two x.y.z versions; negative when a < b. */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function permissionSets(entry) {
  const sets = [{ label: 'manifest', permissions: entry.manifest.default_permissions, events: entry.manifest.default_events }];
  for (const v of entry.variants ?? []) {
    sets.push({ label: `variants[${v.id}]`, permissions: v.default_permissions, events: v.default_events });
  }
  return sets;
}

/**
 * Checks one permission/event set against the shared tables.
 * @returns {string[]} error messages
 */
export function checkPermissionSet({ label, permissions, events }, data) {
  const errors = [];
  for (const [key, level] of Object.entries(permissions)) {
    const def = data.permissions.permissions[key];
    if (!def) {
      errors.push(`${label}: unknown permission "${key}" (not in data/permissions.yaml)`);
    } else if (!def.levels[level]) {
      errors.push(`${label}: permission "${key}" has no "${level}" level (allowed: ${Object.keys(def.levels).join(', ')})`);
    }
  }
  for (const event of events) {
    const def = data.events.events[event];
    if (!def) {
      errors.push(`${label}: unknown webhook event "${event}" (not in data/events.yaml)`);
    } else if (def.subscribable === false) {
      errors.push(`${label}: webhook event "${event}" can't be subscribed to by a GitHub App (${def.note})`);
    } else if (def.requires_any.length > 0 && !def.requires_any.some((key) => LEVEL_RANK[permissions[key]] >= LEVEL_RANK.read)) {
      errors.push(`${label}: webhook event "${event}" needs one of these permissions: ${def.requires_any.join(', ')}`);
    }
  }
  return errors;
}

/**
 * All single-entry checks: schema, filename, category, permissions, events,
 * webhook placeholders, verification fields and changelog order.
 * @param {object} entry parsed JSON
 * @param {{slug: string, today: string, data: {schema: object, permissions: object, events: object, categories: object}}} ctx
 * @returns {string[]} error messages (empty when valid)
 */
export function checkEntry(entry, { slug, today, data }) {
  const schemaErrors = validateSchema(data.schema, entry);
  if (schemaErrors.length > 0) return schemaErrors.map((e) => `${e.path} ${e.message}`);

  const errors = [];
  if (entry.slug !== slug) errors.push(`slug "${entry.slug}" must match the file name "${slug}.yaml"`);
  if (!Object.hasOwn(data.categories.categories, entry.category)) {
    errors.push(`category "${entry.category}" is not in data/categories.yaml`);
  }

  for (const set of permissionSets(entry)) errors.push(...checkPermissionSet(set, data));
  if (entry.variants && !jsonEqual(entry.variants[0].default_permissions, entry.manifest.default_permissions)) {
    errors.push('variants[0] must have the same permissions as manifest (the default variant)');
  }
  if (entry.variants) {
    const ids = entry.variants.map((v) => v.id);
    if (new Set(ids).size !== ids.length) errors.push('variant ids must be unique');
  }

  const manualOnly = permissionSets(entry).flatMap((s) =>
    Object.keys(s.permissions).filter((k) => data.permissions.permissions[k]?.manual_only));
  if (manualOnly.length > 0 && entry.manual_steps.length === 0) {
    errors.push(`permissions ${[...new Set(manualOnly)].join(', ')} can only be set by hand: describe them in manual_steps`);
  }

  const hook = entry.manifest.hook_attributes;
  const anyEvents = permissionSets(entry).some((s) => s.events.length > 0);
  if (anyEvents && !hook.active) errors.push('webhook events are listed but manifest.hook_attributes.active is false');
  if (hook.active && isPlaceholderUrl(hook.url) !== entry.two_step_webhook) {
    errors.push(entry.two_step_webhook
      ? `two_step_webhook is true, so hook_attributes.url must be a placeholder under https://${PLACEHOLDER_HOST}/`
      : `hook_attributes.url is a placeholder: set two_step_webhook to true, or use the vendor's real webhook URL`);
  }
  if (entry.supports.enterprise && entry.manifest.public) {
    errors.push('manifest.public must be false when supports.enterprise is true (enterprise-owned apps ignore "public")');
  }
  if (!Object.values(entry.supports).some(Boolean)) errors.push('supports must allow at least one owner type');

  if ((entry.last_verified === null) !== (entry.verified_by === null)) {
    errors.push('last_verified and verified_by must both be set or both be null');
  }
  if (entry.last_verified && entry.last_verified > today) errors.push(`last_verified ${entry.last_verified} is in the future`);
  if (entry.verification.status === 'ok' && !entry.last_verified) {
    errors.push('verification.status "ok" needs last_verified and verified_by');
  }

  entry.changelog.forEach((c, i) => {
    if (c.date > today) errors.push(`changelog[${i}].date ${c.date} is in the future`);
    const next = entry.changelog[i + 1];
    if (next && (c.date < next.date || compareVersions(c.version, next.version) <= 0)) {
      errors.push(`changelog[${i}] must be newer than changelog[${i + 1}] (newest first, increasing versions)`);
    }
  });
  return errors;
}

/** Fields a maintainer's /verified stamp changes; re-verifying alone needs no changelog line. */
const VERIFICATION_KEYS = ['last_verified', 'verified_by', 'verification'];

function withoutVerification(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([k]) => !VERIFICATION_KEYS.includes(k)));
}

/** Keys whose change counts as a definition change (needs a version bump and review). */
const DEFINITION_KEYS = ['manifest', 'variants'];

/**
 * Rules for an entry changed in a pull request, comparing with the base branch.
 * @param {object|null} before entry on the base branch, or null for a new entry
 * @param {object} after entry on the pull request head
 * @param {{prAuthor?: string, maintainers?: string[], today: string}} ctx
 * @returns {string[]} error messages
 */
export function checkChange(before, after, { prAuthor, maintainers = [], today }) {
  const errors = [];
  if (before && jsonEqual(before, after)) return errors;

  const known = new Set((before?.changelog ?? []).map((c) => c.version));
  const added = after.changelog.filter((c) => !known.has(c.version));
  const onlyVerification = before && jsonEqual(withoutVerification(before), withoutVerification(after));
  if (before && added.length === 0 && !onlyVerification) errors.push('the entry changed but changelog has no new line: add one at the top');
  if (before && added.length > 0 && after.changelog[0] !== added[0]) errors.push('new changelog lines must go at the top');
  if (before && !jsonEqual(before.changelog, after.changelog.slice(added.length))) {
    errors.push('existing changelog lines must not be edited or removed');
  }

  const definitionChanged = before && DEFINITION_KEYS.some((k) => !jsonEqual(before[k], after[k]));
  if (definitionChanged) {
    const restamped = after.last_verified === today && after.last_verified !== before.last_verified;
    if (after.verification.status === 'ok' && !restamped) {
      errors.push('the app definition changed: set verification.status to "needs-review" (a maintainer re-verifies it with /verified)');
    }
  }

  const isMaintainer = (login) => maintainers.some((m) => m.toLowerCase() === login.toLowerCase());
  if (prAuthor) {
    for (const line of added) {
      if (line.author.toLowerCase() !== prAuthor.toLowerCase() && !isMaintainer(prAuthor)) {
        errors.push(`changelog author "${line.author}" must be the pull request author "${prAuthor}"`);
      }
    }
  }
  const verifierChanged = after.verified_by && (!before || before.verified_by !== after.verified_by || before.last_verified !== after.last_verified);
  if (verifierChanged && !isMaintainer(after.verified_by)) {
    errors.push(`verified_by "${after.verified_by}" must be a maintainer listed for /entries/ in CODEOWNERS`);
  }
  return errors;
}

/**
 * Logins that own a path in a CODEOWNERS file (last matching rule wins, like GitHub).
 * Only supports the directory and wildcard rules this repository uses.
 */
export function codeOwnersFor(codeowners, path) {
  let owners = [];
  for (const raw of codeowners.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [pattern, ...who] = line.split(/\s+/);
    const matches = pattern === '*'
      || (pattern.endsWith('/') && `/${path}`.startsWith(pattern.startsWith('/') ? pattern : `/${pattern}`))
      || `/${path}` === (pattern.startsWith('/') ? pattern : `/${pattern}`);
    if (matches) owners = who.filter((w) => w.startsWith('@') && !w.includes('/')).map((w) => w.slice(1));
  }
  return owners;
}
