#!/usr/bin/env node
// Records a maintainer's verification of entries: sets last_verified,
// verified_by, verification.status and (optionally) the current doc_hash.
// Driven by the /verified comment command (.github/workflows/stamp-verified.yml);
// maintainers can also run `apply` locally.
//
//   node scripts/stamp-verified.mjs plan --pr <n> --commenter <login> --body-file <file>
//   node scripts/stamp-verified.mjs apply --root <dir> --login <login> [--fetch] <slug> ...

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { codeOwnersFor } from './lib/entry-rules.mjs';
import { createClient } from './lib/github.mjs';
import { ROOT, entryPath, loadData, readEntry, todayUtc } from './lib/repo.mjs';
import { setTopLevel } from './lib/yaml.mjs';
import { currentFingerprint } from './verify.mjs';

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Parses the first line of a comment. Returns {slugs} for "/verified [slug ...]"
 * (empty slugs = every entry the pull request changes), or null.
 */
export function parseCommand(body) {
  const line = String(body ?? '').trim().split('\n')[0].trim();
  const match = line.match(/^\/verified(?:\s+(.*))?$/);
  if (!match) return null;
  const slugs = (match[1] ?? '').split(/[\s,]+/).filter(Boolean);
  if (!slugs.every((s) => SLUG_RE.test(s))) return { error: 'Slugs may only contain lowercase letters, numbers and hyphens.' };
  return { slugs: [...new Set(slugs)] };
}

/** A copy of the entry with the verification recorded. */
export function stampEntry(entry, { login, date, docHash }) {
  return {
    ...entry,
    last_verified: date,
    verified_by: login,
    verification: { ...entry.verification, status: 'ok', ...(docHash ? { doc_hash: docHash } : {}) },
  };
}

/**
 * Decides what a /verified comment should do.
 * @returns {Promise<{ok: false, message: string} | {ok: true, sameRepo: boolean, headRef: string, slugs: string[]}>}
 */
export async function planStamp({ client, prNumber, commenter, body, codeowners }) {
  const command = parseCommand(body);
  if (!command) return { ok: false, message: 'Not a /verified command.' };
  if (command.error) return { ok: false, message: command.error };
  const maintainers = codeOwnersFor(codeowners, entryPath('x'));
  if (!maintainers.some((m) => m.toLowerCase() === commenter.toLowerCase())) {
    return { ok: false, message: `@${commenter} isn't a code owner of entries/, so the verification wasn't recorded.` };
  }
  const pr = await client.getPull(prNumber);
  if (pr.state !== 'open') return { ok: false, message: 'The pull request is not open.' };
  const files = await client.listPullFiles(prNumber);
  const changed = files
    .filter((f) => f.status !== 'removed' && /^entries\/[a-z0-9-]+\.yaml$/.test(f.filename))
    .map((f) => f.filename.slice('entries/'.length, -'.yaml'.length));
  const slugs = command.slugs.length > 0 ? command.slugs : changed;
  if (slugs.length === 0) return { ok: false, message: 'This pull request changes no entries: name them, as in `/verified renovate`.' };
  return { ok: true, sameRepo: pr.head.repo?.full_name === pr.base.repo.full_name, headRef: pr.head.ref, slugs };
}

/**
 * Stamps entries under root, editing only the verification keys so the rest of
 * the file (comments included) is untouched. `fetch` enables recording the
 * current doc_hash.
 */
export async function applyStamp({ root, slugs, login, date, fetch }) {
  const data = fetch ? loadData(root) : null;
  const results = [];
  for (const slug of slugs) {
    if (!SLUG_RE.test(slug)) throw new Error(`Invalid slug: ${slug}`);
    const { entry, error } = readEntry(slug, root);
    if (error) throw new Error(error);
    let docHash;
    if (fetch) {
      const current = await currentFingerprint(entry, data, fetch);
      if (current.error) throw new Error(`${slug}: ${current.error}`);
      docHash = current.hash;
    }
    const stamped = stampEntry(entry, { login, date, docHash });
    const path = join(root, entryPath(slug));
    writeFileSync(path, setTopLevel(readFileSync(path, 'utf8'), {
      last_verified: stamped.last_verified,
      verified_by: stamped.verified_by,
      verification: stamped.verification,
    }));
    results.push({ slug, docHash: docHash ?? null });
  }
  return results;
}

/** Instructions for fork pull requests, which the workflow can't push to. */
export function forkInstructions(slugs, login, date) {
  return [`Verified by @${login}. This pull request comes from a fork, so the bot can't push the change. Please set these fields in ${slugs.map((s) => `\`${entryPath(s)}\``).join(', ')}:`,
    '', '```yaml', `last_verified: ${date}`, `verified_by: ${login}`, 'verification:', '  status: ok', '```',
    '', 'A maintainer can also run `node scripts/stamp-verified.mjs apply --root . --login <login> --fetch <slug>` on a checkout of this branch.'].join('\n');
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      pr: { type: 'string' }, commenter: { type: 'string' }, 'body-file': { type: 'string' },
      root: { type: 'string' }, login: { type: 'string' }, fetch: { type: 'boolean' }, date: { type: 'string' },
    },
  });
  const date = values.date ?? todayUtc();
  if (command === 'plan') {
    const client = createClient({ fetch: globalThis.fetch, token: process.env.GITHUB_TOKEN, repo: process.env.GITHUB_REPOSITORY, apiUrl: process.env.GITHUB_API_URL });
    const plan = await planStamp({
      client,
      prNumber: Number(values.pr),
      commenter: values.commenter,
      body: readFileSync(values['body-file'], 'utf8'),
      codeowners: readFileSync(join(ROOT, '.github/CODEOWNERS'), 'utf8'),
    });
    const out = plan.ok
      ? { ok: 'true', same_repo: String(plan.sameRepo), head_ref: plan.headRef, slugs: plan.slugs.join(' '), message: plan.sameRepo ? '' : forkInstructions(plan.slugs, values.commenter, date) }
      : { ok: 'false', same_repo: 'false', head_ref: '', slugs: '', message: plan.message };
    const lines = Object.entries(out).map(([k, v]) => (v.includes('\n') ? `${k}<<EOF_STAMP\n${v}\nEOF_STAMP` : `${k}=${v}`));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
    else console.log(lines.join('\n'));
  } else if (command === 'apply') {
    const stamped = await applyStamp({ root: values.root ?? ROOT, slugs: positionals, login: values.login, date, fetch: values.fetch ? globalThis.fetch : undefined });
    for (const s of stamped) console.log(`Stamped ${s.slug}${s.docHash ? ` (${s.docHash})` : ''}`);
  } else {
    console.error('Usage: stamp-verified.mjs plan|apply …');
    process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
