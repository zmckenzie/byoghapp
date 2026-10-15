#!/usr/bin/env node
// Checks that a pull request title is a conventional commit
// (https://www.conventionalcommits.org/). Titles become the squash-merge commit
// subjects on main, which decide the next version and the release notes.
//
//   PR_TITLE="feat(entries): add Renovate" node scripts/check-pr-title.mjs

import { titleProblem } from './lib/conventional.mjs';

const title = process.env.PR_TITLE ?? '';
const problem = titleProblem(title);
if (problem) {
  console.error(`::error title=Pull request title::${problem} (got "${title}")`);
  process.exitCode = 1;
} else {
  console.log(`Pull request title OK: ${title}`);
}
