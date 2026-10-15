#!/usr/bin/env node
// Converts entries/*.yaml and the shared tables into one site/registry.json.
// Node built-ins only. Run `node scripts/validate.mjs` first; the build refuses
// invalid entries too, so a broken entry can never be published.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkEntry } from './lib/entry-rules.mjs';
import { ROOT, contributorsOf, entryPath, listEntrySlugs, loadData, readEntry, todayUtc } from './lib/repo.mjs';

/** Builds the registry object. `contributors` is injectable for tests. */
export function buildRegistry({ root = ROOT, now = new Date(), contributors = (slug) => contributorsOf(entryPath(slug), root) } = {}) {
  const data = loadData(root);
  const entries = [];
  const problems = [];
  for (const slug of listEntrySlugs(root)) {
    const { entry, error } = readEntry(slug, root);
    const errors = error ? [error] : checkEntry(entry, { slug, today: todayUtc(now), data });
    if (errors.length > 0) problems.push(...errors.map((e) => `${slug}: ${e}`));
    else entries.push(entry);
  }
  if (problems.length > 0) throw new Error(`Refusing to build with invalid entries:\n${problems.join('\n')}`);
  for (const entry of entries) delete entry.$schema;
  return {
    generated_at: now.toISOString(),
    entries,
    permissions: data.permissions,
    events: data.events,
    categories: data.categories,
    contributors: Object.fromEntries(entries.map((e) => [e.slug, contributors(e.slug)])),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const registry = buildRegistry();
  const out = join(ROOT, 'site/registry.json');
  writeFileSync(out, `${JSON.stringify(registry)}\n`);
  console.log(`Wrote site/registry.json: ${registry.entries.length} entries`);
}
