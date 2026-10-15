#!/usr/bin/env node
// Validates registry entries. Used by CI and locally.
//
//   node scripts/validate.mjs                       all entries
//   node scripts/validate.mjs --base origin/main    also check changes against a base branch
//   node scripts/validate.mjs --pr-author <login>   changelog authors must be the PR author
//   node scripts/validate.mjs --online              documentation URLs must load and name the vendor

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkChange, checkEntry, codeOwnersFor } from './lib/entry-rules.mjs';
import { ROOT, changedEntrySlugs, entryAtRef, listEntrySlugs, loadData, readEntry, todayUtc } from './lib/repo.mjs';
import { checkDocumentation } from './lib/online.mjs';

/**
 * Runs every check and returns {errors: {slug, message}[], checked: number}.
 * Options mirror the command-line flags; `fetch` is injectable for tests.
 */
export async function run({ root = ROOT, base, prAuthor, online = false, today = todayUtc(), fetch = globalThis.fetch } = {}) {
  const data = loadData(root);
  const errors = [];
  const slugs = listEntrySlugs(root);
  const entries = new Map();
  for (const slug of slugs) {
    const { entry, error } = readEntry(slug, root);
    if (error) {
      errors.push({ slug, message: error });
      continue;
    }
    entries.set(slug, entry);
    for (const message of checkEntry(entry, { slug, today, data })) errors.push({ slug, message });
  }

  if (base) {
    const maintainers = codeOwnersFor(readFileSync(join(root, '.github/CODEOWNERS'), 'utf8'), 'entries/x.json');
    for (const slug of changedEntrySlugs(base, root)) {
      if (!entries.has(slug)) continue;
      const before = entryAtRef(base, slug, root);
      for (const message of checkChange(before, entries.get(slug), { prAuthor, maintainers, today })) {
        errors.push({ slug, message });
      }
    }
  }

  if (online) {
    for (const [slug, entry] of entries) {
      for (const message of await checkDocumentation(entry, fetch)) errors.push({ slug, message });
    }
  }
  return { errors, checked: slugs.length };
}

async function main() {
  const { values } = parseArgs({
    options: { base: { type: 'string' }, 'pr-author': { type: 'string' }, online: { type: 'boolean' } },
  });
  const { errors, checked } = await run({ base: values.base, prAuthor: values['pr-author'], online: values.online });
  for (const { slug, message } of errors) console.error(`::error file=entries/${slug}.json::${slug}: ${message}`);
  if (errors.length > 0) {
    console.error(`\n${errors.length} problem(s) in ${checked} entries.`);
    process.exitCode = 1;
  } else {
    console.log(`Validated ${checked} entries: OK`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
