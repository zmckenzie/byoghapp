// Builds GitHub's two pre-filled app registration flows from one entry:
//   - a GET link with URL parameters (user, organization, enterprise; never touches secrets)
//   - a POST manifest form (user and organization only; GitHub returns credentials)

import { permissionSet } from './risk.js';

export const MAX_APP_NAME = 34;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** Owner types and whether each needs a name. */
export const TARGET_KINDS = {
  personal: { label: 'Personal account', needsOwner: false },
  org: { label: 'Organization', needsOwner: true },
  enterprise: { label: 'Enterprise', needsOwner: true },
};

/** True when a host is github.com or a GitHub Enterprise Cloud data-residency host. */
export function isCloudHost(host) {
  return host === 'github.com' || /^[a-z0-9-]+\.ghe\.com$/.test(host);
}

/**
 * Normalizes and checks a registration target.
 * @param {{kind: string, owner?: string, host?: string}} input
 * @returns {{ok: true, target: {kind: string, owner: string, host: string}} | {ok: false, error: string}}
 */
export function parseTarget({ kind, owner = '', host = '' }, { requireHost = false } = {}) {
  if (!Object.hasOwn(TARGET_KINDS, kind)) return { ok: false, error: 'Choose who will own the app.' };
  const typedHost = host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (requireHost && !typedHost) return { ok: false, error: 'Enter your GitHub Enterprise Server host name.' };
  const cleanHost = typedHost || 'github.com';
  if (!HOST_RE.test(cleanHost)) return { ok: false, error: 'Enter a host name such as github.example.com.' };
  const cleanOwner = owner.trim();
  if (TARGET_KINDS[kind].needsOwner && !OWNER_RE.test(cleanOwner)) {
    return { ok: false, error: `Enter the ${kind === 'org' ? 'organization' : 'enterprise'} name (letters, numbers and hyphens).` };
  }
  return { ok: true, target: { kind, owner: TARGET_KINDS[kind].needsOwner ? cleanOwner : '', host: cleanHost } };
}

/** Which entry.supports flag each owner type needs. */
export const KIND_SUPPORT = { personal: 'user', org: 'org', enterprise: 'enterprise' };

/**
 * The starting target for an entry: the first supported owner type (organization
 * first), and an empty host for entries that only work on GitHub Enterprise Server.
 */
export function defaultTarget(entry) {
  const kind = ['org', 'personal', 'enterprise'].find((k) => entry.supports[KIND_SUPPORT[k]]) ?? 'org';
  return { kind, owner: '', host: entry.own_app === 'ghes-only' ? '' : 'github.com' };
}

/** GitHub's "new app" page for a target. */
export function registrationUrl({ kind, owner, host }) {
  const base = `https://${host}`;
  if (kind === 'org') return `${base}/organizations/${encodeURIComponent(owner)}/settings/apps/new`;
  if (kind === 'enterprise') return `${base}/enterprises/${encodeURIComponent(owner)}/settings/apps/new`;
  return `${base}/settings/apps/new`;
}

/** Checks a user-chosen app name against GitHub's length limit. */
export function checkAppName(name) {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: 'Enter a name for the app.' };
  if (trimmed.length > MAX_APP_NAME) return { ok: false, error: `GitHub app names can be at most ${MAX_APP_NAME} characters.` };
  return { ok: true, name: trimmed };
}

/** Permissions that can be pre-filled: GitHub won't accept manual-only (enterprise) ones in a form. */
export function launchablePermissions(permissions, table) {
  return Object.fromEntries(Object.entries(permissions).filter(([key]) => !table.permissions[key]?.manual_only));
}

/**
 * The GET registration link. Values are percent-encoded; array keys keep GitHub's
 * literal `[]` form (`events[]=push`).
 */
export function buildLaunchUrl(entry, { target, appName, variantId, table }) {
  const { permissions, events } = permissionSet(entry, variantId);
  const m = entry.manifest;
  const params = [['name', appName]];
  if (m.description) params.push(['description', m.description]);
  params.push(['url', m.url]);
  for (const url of m.callback_urls ?? []) params.push(['callback_urls[]', url]);
  if (m.request_oauth_on_install !== undefined) params.push(['request_oauth_on_install', String(m.request_oauth_on_install)]);
  if (m.setup_url) params.push(['setup_url', m.setup_url]);
  if (m.setup_on_update !== undefined) params.push(['setup_on_update', String(m.setup_on_update)]);
  // GitHub ignores "public" for enterprise-owned apps, so leave it out there.
  if (target.kind !== 'enterprise') params.push(['public', String(m.public)]);
  params.push(['webhook_active', String(m.hook_attributes.active)]);
  if (m.hook_attributes.active) {
    params.push(['webhook_url', m.hook_attributes.url]);
    for (const event of events) params.push(['events[]', event]);
  }
  for (const [key, level] of Object.entries(launchablePermissions(permissions, table)).sort(([a], [b]) => a.localeCompare(b))) {
    params.push([key, level]);
  }
  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `${registrationUrl(target)}?${query}`;
}

/** True when the manifest flow can be used: user/org owners on github.com or *.ghe.com. */
export function manifestSupported(target) {
  return target.kind !== 'enterprise' && isCloudHost(target.host);
}

/** The manifest JSON GitHub expects in the form's `manifest` field. */
export function buildManifest(entry, { appName, variantId, redirectUrl, table }) {
  const { permissions, events } = permissionSet(entry, variantId);
  const m = entry.manifest;
  const manifest = {
    name: appName,
    url: m.url,
    hook_attributes: { ...m.hook_attributes },
    redirect_url: redirectUrl,
    public: m.public,
    default_permissions: launchablePermissions(permissions, table),
    default_events: m.hook_attributes.active ? [...events] : [],
  };
  for (const key of ['description', 'callback_urls', 'setup_url', 'setup_on_update', 'request_oauth_on_install']) {
    if (m[key] !== undefined) manifest[key] = m[key];
  }
  return manifest;
}

/** Form action for the manifest POST, carrying the CSRF state. */
export function manifestFormAction(target, state) {
  if (!manifestSupported(target)) throw new Error('The manifest flow only supports personal and organization owners on github.com or ghe.com.');
  return `${registrationUrl(target)}?state=${encodeURIComponent(state)}`;
}

/** A random, URL-safe state value for CSRF protection. */
export function newState(crypto = globalThis.crypto) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Default app name: the manifest name, with the owner appended when it fits. */
export function defaultAppName(entry, target) {
  const base = entry.manifest.name;
  const withOwner = target?.owner ? `${base} (${target.owner})` : base;
  return withOwner.length <= MAX_APP_NAME ? withOwner : base.slice(0, MAX_APP_NAME);
}
