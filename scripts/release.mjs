#!/usr/bin/env node
// Release automation for .github/workflows/release-pr.yml and release.yml.
//
//   node scripts/release.mjs plan [--manual] [--notes <file>]
//     Decides what this commit means (publish, pending, propose or none) from
//     package.json, its first parent's package.json, the v* tags and the
//     conventional commits since the latest tag. Writes step outputs (action,
//     version, previous) and the release notes to --notes.
//
//   node scripts/release.mjs propose --version <x.y.z> --notes <file>
//     Opens or updates the release pull request that sets that version.
//     Needs GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_SHA.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { releaseNotes } from './lib/conventional.mjs';
import { createClient } from './lib/github.mjs';
import { REPO_URL } from '../site/lib/config.js';
import { ROOT, git } from './lib/repo.mjs';
import { bumpLockfile, bumpPackageJson, parseGitLog, planRelease, proposeRelease, releasePrBody } from './lib/release.mjs';

const versionOf = (text) => (text === null ? null : JSON.parse(text).version);

/** Gathers the plan's inputs from the repository at root. */
export function readRepoState(root = ROOT) {
  const tags = (git(['tag', '--list', 'v*'], root) ?? '').split('\n').filter(Boolean);
  const version = versionOf(readFileSync(join(root, 'package.json'), 'utf8'));
  const parentVersion = versionOf(git(['show', 'HEAD^1:package.json'], root));
  return { tags, version, parentVersion };
}

/** Commits since the given version's tag (all of them when there is none), newest first. */
export function commitsSince(previous, root = ROOT) {
  const range = previous ? [`v${previous}..HEAD`] : ['HEAD'];
  return parseGitLog(git(['log', '--format=%H%x1f%B%x1e', ...range], root) ?? '');
}

function output(values) {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v ?? ''}`).join('\n');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines}\n`);
  else console.log(lines);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: { manual: { type: 'boolean' }, notes: { type: 'string' }, version: { type: 'string' } },
  });
  if (command === 'plan') {
    const state = readRepoState();
    const sinceTag = state.tags.includes(`v${state.version}`) ? state.version : null;
    const plan = planRelease({ ...state, messages: commitsSince(sinceTag).map((c) => c.message), manual: values.manual });
    if (values.notes && (plan.action === 'publish' || plan.action === 'propose')) {
      writeFileSync(values.notes, releaseNotes({ version: plan.version, previous: plan.previous, commits: commitsSince(plan.previous), repoUrl: REPO_URL }));
    }
    console.error(`Release plan: ${plan.action}${plan.version ? ` v${plan.version}` : ''}${plan.reason ? ` (${plan.reason})` : ''}`);
    output({ action: plan.action, version: plan.version, previous: plan.previous });
  } else if (command === 'propose') {
    const [owner] = process.env.GITHUB_REPOSITORY.split('/');
    const client = createClient({ fetch: globalThis.fetch, token: process.env.GITHUB_TOKEN, repo: process.env.GITHUB_REPOSITORY, apiUrl: process.env.GITHUB_API_URL });
    const read = (path) => readFileSync(join(ROOT, path), 'utf8');
    const pr = await proposeRelease({
      client,
      owner,
      base: process.env.BASE_BRANCH ?? 'main',
      baseSha: process.env.GITHUB_SHA,
      version: values.version,
      files: {
        'package.json': bumpPackageJson(read('package.json'), values.version),
        'package-lock.json': bumpLockfile(read('package-lock.json'), values.version),
      },
      body: releasePrBody(readFileSync(values.notes, 'utf8')),
    });
    console.log(`${pr.created ? 'Opened' : 'Updated'} release pull request #${pr.number} for v${values.version}: ${pr.url}`);
  } else {
    console.error('Usage: release.mjs plan|propose …');
    process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
