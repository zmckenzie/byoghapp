// File-system and git access for the scripts. Kept separate from the pure rules
// so those can be tested without touching disk.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The shared tables every check needs. */
export function loadData(root = ROOT) {
  return {
    schema: readJson(join(root, 'schema/entry.schema.json')),
    permissions: readJson(join(root, 'data/permissions.json')),
    events: readJson(join(root, 'data/events.json')),
    categories: readJson(join(root, 'data/categories.json')),
  };
}

/** Slugs of entries/*.json, sorted. */
export function listEntrySlugs(root = ROOT) {
  return readdirSync(join(root, 'entries'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

/** Reads entries/<slug>.json, returning {entry} or {error} for unparsable JSON. */
export function readEntry(slug, root = ROOT) {
  try {
    return { entry: readJson(join(root, 'entries', `${slug}.json`)) };
  } catch (err) {
    return { error: `could not read entries/${slug}.json: ${err.message}` };
  }
}

/** Runs git and returns stdout, or null when the command fails. */
export function git(args, root = ROOT) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** Entry file content at a git ref, parsed; null if it didn't exist there. */
export function entryAtRef(ref, slug, root = ROOT) {
  const text = git(['show', `${ref}:entries/${slug}.json`], root);
  return text === null ? null : JSON.parse(text);
}

/** Slugs of entries added or modified between a base ref and the working tree. */
export function changedEntrySlugs(base, root = ROOT) {
  const out = git(['diff', '--name-only', '--diff-filter=AM', `${base}...HEAD`, '--', 'entries/'], root);
  if (out === null) throw new Error(`git diff against "${base}" failed: fetch the base branch first`);
  return out.split('\n').filter((p) => /^entries\/[^/]+\.json$/.test(p)).map((p) => p.slice(8, -5)).sort();
}

/** Distinct commit author names for a path, oldest first. */
export function contributorsOf(path, root = ROOT) {
  const out = git(['log', '--reverse', '--format=%an', '--', path], root);
  if (!out) return [];
  return [...new Set(out.split('\n').filter(Boolean))];
}

/** Today's date in UTC as YYYY-MM-DD. */
export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}
