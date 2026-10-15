#!/usr/bin/env node
// Enforces the site's security rules on the files that get published:
//   - every HTML page carries its exact expected Content-Security-Policy meta tag
//   - no inline scripts, inline styles or event-handler attributes
//   - scripts and stylesheets load from the same origin only
//   - every absolute URL in HTML, JS and CSS is on the allowlist

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './lib/repo.mjs';

const BASE = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:";
export const EXPECTED_CSP = {
  'index.html': `${BASE}; connect-src 'self'; form-action https://github.com https://*.ghe.com; base-uri 'none'`,
  'callback.html': `${BASE}; connect-src https://api.github.com https://*.ghe.com; form-action 'none'; base-uri 'none'`,
};

/** Hosts that may appear in absolute URLs in site files. */
export const ALLOWED_URL = /^https:\/\/((api\.|docs\.)?github\.com|example\.invalid|(api\.)?\$\{host\}|([a-z0-9-]+|\*)\.ghe\.com)(\/|$|\?|#|;)/;

/** Problems in one HTML document. */
export function lintHtml(name, html) {
  const problems = [];
  const csp = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i);
  if (!csp) problems.push('missing Content-Security-Policy meta tag');
  else if (!Object.hasOwn(EXPECTED_CSP, name)) problems.push('page has no expected CSP: add it to EXPECTED_CSP in scripts/lint-site.mjs');
  else if (csp[1] !== EXPECTED_CSP[name]) problems.push(`CSP differs from the expected policy:\n  found:    ${csp[1]}\n  expected: ${EXPECTED_CSP[name]}`);
  if (csp && html.search(/<meta\s+http-equiv="Content-Security-Policy"/i) > html.search(/<(script|link|style)\b/i)) {
    problems.push('the CSP meta tag must come before any script, link or style element');
  }
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)) {
    if (!/\bsrc=/.test(m[1])) problems.push('inline <script> is not allowed');
    if (m[2].trim()) problems.push('<script> elements must be empty');
  }
  if (/<style\b/i.test(html)) problems.push('<style> elements are not allowed');
  if (/\sstyle\s*=/i.test(html)) problems.push('style attributes are not allowed');
  const handler = html.match(/\son[a-z]+\s*=/i);
  if (handler) problems.push(`event-handler attribute ${handler[0].trim()} is not allowed`);
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/gi)) {
    if (/^(https?:)?\/\//i.test(m[1])) problems.push(`${m[1]}: scripts and stylesheets must load from the same origin`);
  }
  return problems;
}

/** Absolute URLs in any text file that aren't on the allowlist. */
export function lintUrls(text) {
  const problems = [];
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s"'`<>)]+/g)) {
    if (!ALLOWED_URL.test(m[0])) problems.push(`URL not on the allowlist: ${m[0]}`);
  }
  return problems;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** Lints every published file under site/ (registry.json is data, not code, and is skipped). */
export function lintSite(siteDir = join(ROOT, 'site')) {
  const results = [];
  for (const path of walk(siteDir)) {
    const name = relative(siteDir, path);
    if (name === 'registry.json') continue;
    const text = readFileSync(path, 'utf8');
    const problems = [];
    if (name.endsWith('.html')) problems.push(...lintHtml(name, text));
    if (/\.(html|js|css)$/.test(name)) problems.push(...lintUrls(text));
    else problems.push('unexpected file type in site/ (only .html, .js and .css are published)');
    for (const problem of problems) results.push({ file: `site/${name}`, problem });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = lintSite();
  for (const { file, problem } of results) console.error(`::error file=${file}::${file}: ${problem}`);
  if (results.length > 0) process.exitCode = 1;
  else console.log('Site lint: OK');
}
