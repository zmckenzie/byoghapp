// Fuzz target for rendering contributed entries (site/lib/render.js) and building
// their launch URLs (site/lib/launch.js). Inputs are entry YAML; only entries that
// pass the validator are rendered, as on the site. For those, the HTML may only
// contain tags the renderer itself writes, no event-handler attributes, and links
// to https: URLs or in-page fragments; the launch URL must point at github.com.
//
// Run with Jazzer.js (npm run fuzz:render) or ClusterFuzzLite (.clusterfuzzlite/).
// test/fuzz/targets.test.mjs runs it over the seed corpus on every `npm test`.

import { readFileSync } from 'node:fs';
import { checkEntry } from '../scripts/lib/entry-rules.mjs';
import { ROOT, loadData } from '../scripts/lib/repo.mjs';
import { parse, YAMLError } from '../scripts/lib/yaml.mjs';
import { buildLaunchUrl, defaultAppName, defaultTarget } from '../site/lib/launch.js';
import { renderEntryCard, renderEntryDetail } from '../site/lib/render.js';
import { highestTier } from '../site/lib/risk.js';

const data = loadData(ROOT);
const table = data.permissions;
const categories = data.categories.categories;

/** Every tag name the renderer writes, read from its source. */
export const RENDER_TAGS = new Set(
  [...readFileSync(new URL('../site/lib/render.js', import.meta.url), 'utf8').matchAll(/<([a-z][a-z0-9]*)\b/g)].map((m) => m[1]),
);

/**
 * Problems with rendered HTML; an empty list means it is safe. Text is escaped,
 * so every "<" starts a tag the renderer wrote, and quoted attribute values are
 * escaped too, so only the unquoted part of a tag can hold an attribute name.
 */
export function htmlProblems(html) {
  const problems = [];
  for (const [, name, attrs] of html.matchAll(/<\/?([^\s/>]+)([^>]*)>?/g)) {
    if (!RENDER_TAGS.has(name)) problems.push(`unexpected tag <${name}>`);
    const handler = attrs.replace(/"[^"]*"/g, '""').match(/\son[a-z]+\s*=/i);
    if (handler) problems.push(`event-handler attribute ${handler[0].trim()}`);
    for (const [, href] of attrs.matchAll(/\shref="([^"]*)"/g)) {
      if (!href.startsWith('#') && !href.startsWith('https://')) problems.push(`unsafe link ${href}`);
    }
  }
  return problems;
}

/**
 * @param {Buffer} input
 * @returns {'rejected' | 'skipped' | 'checked'} what happened, for the unit tests
 */
export function fuzz(input) {
  let entry;
  try {
    entry = parse(input.toString('utf8'));
  } catch (err) {
    if (err instanceof YAMLError) return 'rejected';
    throw err;
  }
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return 'skipped';
  if (checkEntry(entry, { slug: entry.slug, today: '2099-12-31', data }).length > 0) return 'skipped';

  const target = { ...defaultTarget(entry), owner: 'acme', host: 'github.com' };
  const appName = defaultAppName(entry, target);
  const variantId = entry.variants?.[0].id;
  const html = renderEntryDetail(entry, { table, categories, variantId, target, appName })
    + renderEntryCard(entry, { table, categories, highest: highestTier(entry, table) });
  const problems = htmlProblems(html);
  if (problems.length > 0) throw new Error(`unsafe HTML for ${entry.slug}: ${problems.join('; ')}`);

  const url = new URL(buildLaunchUrl(entry, { target, appName, variantId, table }));
  if (url.origin !== 'https://github.com') throw new Error(`launch URL left github.com: ${url}`);
  return 'checked';
}
