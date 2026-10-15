// The opt-in manifest return leg. GitHub redirects back with a one-time `code`;
// on the user's click the browser exchanges it for the app's credentials. Nothing
// is persisted except the CSRF state, which lives in sessionStorage and is
// removed as soon as it's used.

import { isCloudHost } from './launch.js';

export const STATE_KEY = 'byoghapp:manifest-launch';
const MAX_AGE_MS = 60 * 60 * 1000; // GitHub's codes expire after an hour
const CODE_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Saves the launch details the callback page needs to check. */
export function rememberLaunch(storage, { state, host, slug }, now = Date.now()) {
  storage.setItem(STATE_KEY, JSON.stringify({ state, host, slug, created: now }));
}

/** Removes the saved launch so a state value can't be used twice. */
export function forgetLaunch(storage) {
  storage.removeItem(STATE_KEY);
}

/**
 * Reads GitHub's redirect: checks the code's shape and the state against the
 * saved launch.
 * @returns {{ok: true, code: string, host: string, slug: string} | {ok: false, error: string}}
 */
export function readCallback(search, storage, now = Date.now()) {
  const params = new URLSearchParams(search);
  const code = params.get('code');
  const state = params.get('state');
  if (!code) return { ok: false, error: 'This page expects a code from GitHub. Start from an entry\'s "Create from manifest" button.' };
  if (!CODE_RE.test(code)) return { ok: false, error: 'The code from GitHub has an unexpected format.' };

  let saved;
  try {
    saved = JSON.parse(storage.getItem(STATE_KEY)); // a missing key parses as null
  } catch {
    saved = null;
  }
  if (!saved || typeof saved.state !== 'string') {
    return { ok: false, error: 'No launch from this browser tab was found. Start again from the registry.' };
  }
  if (saved.state !== state) return { ok: false, error: 'The state from GitHub does not match this launch, so the code was not used.' };
  if (now - saved.created > MAX_AGE_MS) return { ok: false, error: 'This launch is more than an hour old and GitHub\'s code has expired.' };
  if (!isCloudHost(saved.host)) return { ok: false, error: 'The saved launch has an unsupported host.' };
  return { ok: true, code, host: saved.host, slug: saved.slug };
}

/** REST API base for github.com or a ghe.com host. */
export function apiBaseFor(host) {
  if (isCloudHost(host)) return `https://api.${host}`;
  throw new Error(`Unsupported host: ${host}`);
}

/**
 * Exchanges the one-time code for the app's credentials.
 * @returns {Promise<{ok: true, app: object} | {ok: false, error: string}>}
 */
export async function convertManifest(fetch, host, code) {
  let res;
  try {
    res = await fetch(`${apiBaseFor(host)}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch (err) {
    return { ok: false, error: `Could not reach GitHub: ${err.message}` };
  }
  if (res.status !== 201) {
    const reason = res.status === 404 || res.status === 422 ? 'the code was already used or has expired' : `HTTP ${res.status}`;
    return { ok: false, error: `GitHub did not return the app's credentials (${reason}). The code can't be reused: create the app's key and secrets in GitHub's settings instead.` };
  }
  const body = await res.json();
  const app = {
    id: body.id,
    slug: body.slug,
    name: body.name,
    htmlUrl: body.html_url,
    clientId: body.client_id,
    clientSecret: body.client_secret,
    webhookSecret: body.webhook_secret ?? null,
    pem: body.pem,
  };
  if (!app.id || !app.pem) return { ok: false, error: 'GitHub\'s response was missing the app ID or private key.' };
  return { ok: true, app };
}

/** File name for the private key download, like GitHub's own. */
export function pemFileName(app, date = new Date()) {
  const safe = String(app.slug ?? 'github-app').replace(/[^a-z0-9-]/gi, '-');
  return `${safe}.${date.toISOString().slice(0, 10)}.private-key.pem`;
}
