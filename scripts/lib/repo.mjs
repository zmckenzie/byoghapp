// File-system and git access for the scripts. Kept separate from the pure rules
// so those can be tested without touching disk.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './yaml.mjs';

// BYOGHAPP_ROOT lets tests point the command-line scripts at a fixture repository.
export const ROOT = resolve(process.env.BYOGHAPP_ROOT ?? fileURLToPath(new URL('../..', import.meta.url)));

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readYaml(path) {
  return parseYaml(readFileSync(path, 'utf8'));
}

/** Repository-relative path of an entry file. */
export function entryPath(slug) {
  return `entries/${slug}.yaml`;
}

/** The shared tables every check needs. */
export function loadData(root = ROOT) {
  return {
    schema: readJson(join(root, 'schema/entry.schema.json')),
    permissions: readYaml(join(root, 'data/permissions.yaml')),
    events: readYaml(join(root, 'data/events.yaml')),
    categories: readYaml(join(root, 'data/categories.yaml')),
  };
}

/** Slugs of entries/*.yaml, sorted. */
export function listEntrySlugs(root = ROOT) {
  return readdirSync(join(root, 'entries'))
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.slice(0, -'.yaml'.length))
    .sort();
}

/** Reads an entry, returning {entry} or {error} for unreadable YAML. */
export function readEntry(slug, root = ROOT) {
  try {
    return { entry: readYaml(join(root, entryPath(slug))) };
  } catch (err) {
    return { error: `could not read ${entryPath(slug)}: ${err.message}` };
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
  const text = git(['show', `${ref}:${entryPath(slug)}`], root);
  return text === null ? null : parseYaml(text);
}

/** Slugs of entries added or modified between a base ref and the working tree. */
export function changedEntrySlugs(base, root = ROOT) {
  const out = git(['diff', '--name-only', '--diff-filter=AM', `${base}...HEAD`, '--', 'entries/'], root);
  if (out === null) throw new Error(`git diff against "${base}" failed: fetch the base branch first`);
  return out.split('\n').filter((p) => /^entries\/[^/]+\.yaml$/.test(p)).map((p) => p.slice('entries/'.length, -'.yaml'.length)).sort();
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
