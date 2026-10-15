#!/usr/bin/env node
// Converts entries/*.yaml and the shared tables into one site/registry.json.
// Node built-ins only. Run `node scripts/validate.mjs` first; the build refuses
// invalid entries too, so a broken entry can never be published.
//
// Set SOURCE_DATE_EPOCH (seconds since the epoch, as in reproducible-builds.org)
// to fix generated_at, so the same commit always builds the same file; the
// release workflow sets it to the commit time.

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

/** The build time: SOURCE_DATE_EPOCH when set, otherwise now. */
export function buildTime(env = process.env, now = new Date()) {
  const epoch = env.SOURCE_DATE_EPOCH;
  if (epoch === undefined || epoch === '') return now;
  if (!/^\d+$/.test(epoch)) throw new Error(`SOURCE_DATE_EPOCH must be a whole number of seconds, not "${epoch}"`);
  return new Date(Number(epoch) * 1000);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const registry = buildRegistry({ now: buildTime() });
  const out = join(ROOT, 'site/registry.json');
  writeFileSync(out, `${JSON.stringify(registry)}\n`);
  console.log(`Wrote site/registry.json: ${registry.entries.length} entries`);
}
