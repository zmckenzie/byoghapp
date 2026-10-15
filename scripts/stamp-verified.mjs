#!/usr/bin/env node
// Records a maintainer's verification of entries: sets last_verified,
// verified_by, verification.status and (optionally) the current doc_hash.
// Driven by the /verified comment command (.github/workflows/stamp-verified.yml);
// maintainers can also run `apply` locally.
//
//   node scripts/stamp-verified.mjs plan --pr <n> --commenter <login> --body-file <file>
//   node scripts/stamp-verified.mjs push --head-ref <branch> --head-sha <sha> --login <login> [--fetch] <slug> ...
//   node scripts/stamp-verified.mjs apply --root <dir> --login <login> [--fetch] <slug> ...

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { codeOwnersFor } from './lib/entry-rules.mjs';
import { createClient } from './lib/github.mjs';
import { ROOT, entryPath, loadData, todayUtc } from './lib/repo.mjs';
import { parse, setTopLevel } from './lib/yaml.mjs';
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
 * @returns {Promise<{ok: false, message: string} | {ok: true, sameRepo: boolean, headRef: string, headSha: string, slugs: string[]}>}
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
  return { ok: true, sameRepo: pr.head.repo?.full_name === pr.base.repo.full_name, headRef: pr.head.ref, headSha: pr.head.sha, slugs };
}

/**
 * Stamps one entry file's text, editing only the verification keys so the rest
 * of the file (comments included) is untouched. `fetch` enables recording the
 * current doc_hash, using the trusted data tables in `data`.
 */
async function stampText(text, slug, { login, date, data, fetch }) {
  const entry = parse(text);
  let docHash;
  if (fetch) {
    const current = await currentFingerprint(entry, data, fetch);
    if (current.error) throw new Error(`${slug}: ${current.error}`);
    docHash = current.hash;
  }
  const stamped = stampEntry(entry, { login, date, docHash });
  return {
    text: setTopLevel(text, { last_verified: stamped.last_verified, verified_by: stamped.verified_by, verification: stamped.verification }),
    docHash: docHash ?? null,
  };
}

function checkSlug(slug) {
  if (!SLUG_RE.test(slug)) throw new Error(`Invalid slug: ${slug}`);
}

/** Stamps entries in a local checkout under root. */
export async function applyStamp({ root, slugs, login, date, fetch }) {
  const data = fetch ? loadData(root) : null;
  const results = [];
  for (const slug of slugs) {
    checkSlug(slug);
    const path = join(root, entryPath(slug));
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      throw new Error(`could not read ${entryPath(slug)}: ${err.message}`);
    }
    const stamped = await stampText(text, slug, { login, date, data, fetch });
    writeFileSync(path, stamped.text);
    results.push({ slug, docHash: stamped.docHash });
  }
  return results;
}

/**
 * Stamps entries on a pull request branch through the API, without checking the
 * branch out. Entries are read at headSha (the commit the plan saw), and the new
 * commit only lands if the branch still points there: a push made after the
 * plan makes GitHub refuse the fast-forward, so unreviewed content is never stamped.
 */
export async function pushStamp({ client, headRef, headSha, slugs, login, date, data, fetch }) {
  slugs.forEach(checkSlug);
  const head = await client.getCommit(headSha);
  const results = [];
  const tree = [];
  for (const slug of slugs) {
    const stamped = await stampText(await client.getFileText(entryPath(slug), headSha), slug, { login, date, data, fetch });
    tree.push({ path: entryPath(slug), mode: '100644', type: 'blob', content: stamped.text });
    results.push({ slug, docHash: stamped.docHash });
  }
  const newTree = await client.createTree({ base_tree: head.tree.sha, tree });
  const commit = await client.createCommit({
    message: `Record verification of ${slugs.join(' ')} by @${login}`,
    tree: newTree.sha,
    parents: [headSha],
  });
  await client.fastForward(headRef, commit.sha);
  return { sha: commit.sha, results };
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
      'head-ref': { type: 'string' }, 'head-sha': { type: 'string' },
    },
  });
  const date = values.date ?? todayUtc();
  const client = () => createClient({ fetch: globalThis.fetch, token: process.env.GITHUB_TOKEN, repo: process.env.GITHUB_REPOSITORY, apiUrl: process.env.GITHUB_API_URL });
  const fetch = values.fetch ? globalThis.fetch : undefined;
  if (command === 'plan') {
    const plan = await planStamp({
      client: client(),
      prNumber: Number(values.pr),
      commenter: values.commenter,
      body: readFileSync(values['body-file'], 'utf8'),
      codeowners: readFileSync(join(ROOT, '.github/CODEOWNERS'), 'utf8'),
    });
    const out = plan.ok
      ? { ok: 'true', same_repo: String(plan.sameRepo), head_ref: plan.headRef, head_sha: plan.headSha, slugs: plan.slugs.join(' '), message: plan.sameRepo ? '' : forkInstructions(plan.slugs, values.commenter, date) }
      : { ok: 'false', same_repo: 'false', head_ref: '', head_sha: '', slugs: '', message: plan.message };
    const lines = Object.entries(out).map(([k, v]) => (v.includes('\n') ? `${k}<<EOF_STAMP\n${v}\nEOF_STAMP` : `${k}=${v}`));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
    else console.log(lines.join('\n'));
  } else if (command === 'push') {
    const { sha, results } = await pushStamp({
      client: client(), headRef: values['head-ref'], headSha: values['head-sha'], slugs: positionals, login: values.login, date,
      data: fetch ? loadData(ROOT) : null, fetch,
    });
    for (const s of results) console.log(`Stamped ${s.slug}${s.docHash ? ` (${s.docHash})` : ''}`);
    console.log(`Pushed ${sha}`);
  } else if (command === 'apply') {
    const stamped = await applyStamp({ root: values.root ?? ROOT, slugs: positionals, login: values.login, date, fetch });
    for (const s of stamped) console.log(`Stamped ${s.slug}${s.docHash ? ` (${s.docHash})` : ''}`);
  } else {
    console.error('Usage: stamp-verified.mjs plan|push|apply …');
    process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
