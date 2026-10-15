// Network checks and documentation fingerprints. `fetch` is always passed in,
// so tests run offline.

import { createHash } from 'node:crypto';

const TIMEOUT_MS = 20_000;
const USER_AGENT = 'byoghapp-verifier (+https://github.com/zmckenzie/byoghapp)';

/** Fetches a page as text; returns {status, text} or {error}. */
export async function fetchPage(url, fetch) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,text/plain' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: res.status, text: res.ok ? await res.text() : '' };
  } catch (err) {
    return { error: err.message };
  }
}

/** Plain text of an HTML page: no scripts, styles or tags; one block per line. */
export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/li|\/tr|\/h[1-6]|\/div|\/pre|\/td|\/th)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x?27;|&#39;/g, "'")
    // Last, so "&amp;lt;" becomes "&lt;" and not "<".
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * Lines of a page that describe permissions or events: they mention a permission
 * name or key, or an event name, together with an access word. Navigation, ads and
 * dates rarely match, so the fingerprint only moves when the permission text does.
 */
export function relevantLines(text, permissions, events) {
  const names = new Set();
  for (const [key, def] of Object.entries(permissions.permissions)) {
    names.add(key.toLowerCase());
    names.add(def.name.toLowerCase());
  }
  for (const key of Object.keys(events.events)) names.add(key);
  const words = [...names].filter((n) => n.length > 3);
  const access = /\b(read|write|read-only|admin|access|permission|subscribe|event)/i;
  return [...new Set(
    text.toLowerCase().split('\n').filter((line) => access.test(line) && words.some((w) => line.includes(w))),
  )].sort();
}

/** sha256 fingerprint of the relevant lines, as stored in verification.doc_hash. */
export function fingerprint(lines) {
  return `sha256:${createHash('sha256').update(lines.join('\n')).digest('hex')}`;
}

/** Errors when an entry's documentation page doesn't load or doesn't name the vendor. */
export async function checkDocumentation(entry, fetch) {
  const urls = [entry.documentation_url, ...(entry.documentation_urls ?? [])];
  const errors = [];
  for (const url of urls) {
    const page = await fetchPage(url, fetch);
    if (page.error) errors.push(`${url} could not be fetched: ${page.error}`);
    else if (page.status !== 200) errors.push(`${url} returned HTTP ${page.status}`);
    else {
      const text = page.text.toLowerCase();
      const named = [entry.vendor, entry.name].some((n) => text.includes(n.toLowerCase().split(/[\s(]/)[0]));
      if (!named) errors.push(`${url} doesn't mention "${entry.vendor}" or "${entry.name}"`);
    }
  }
  return errors;
}
