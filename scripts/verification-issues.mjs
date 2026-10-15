#!/usr/bin/env node
// Turns a verify.mjs report into issues: one open "verification-failed" issue
// per entry, created or updated, never duplicated. Runs in the scheduled
// workflow with GITHUB_TOKEN (issues: write).
//
//   node scripts/verification-issues.mjs report.json

import { readFileSync } from 'node:fs';
import { createClient } from './lib/github.mjs';

export const LABEL = 'verification-failed';
const ACTIONABLE = new Set(['changed', 'unreachable']);

export function issueTitle(slug) {
  return `Verify entry: ${slug}`;
}

/** Hidden marker so the same finding isn't reported twice. */
export function marker(result) {
  return `<!-- byoghapp-verify ${result.slug} ${result.status} ${result.current_hash ?? result.error ?? ''} -->`;
}

/** Issue body laid out like the verification-failed issue form. */
export function issueBody(result) {
  const change = result.status === 'changed'
    ? `The permission-related text changed.\nstored:  ${result.stored_hash}\ncurrent: ${result.current_hash}`
    : `The documentation could not be checked: ${result.error}`;
  return [
    '### Entry slug', '', result.slug, '',
    '### Documentation URL checked', '', result.documentation_url ?? '_unknown_', '',
    "### Entry's last_verified date", '', result.last_verified ?? '_never verified_', '',
    '### What changed', '', '```text', change, '```', '',
    '### Resolution', '',
    '_For the maintainer: compare the vendor documentation with the entry. Update the entry if needed, then comment `/verified <slug>` on the pull request (or open one) to record the new fingerprint._',
    '', marker(result),
  ].join('\n');
}

/**
 * Creates or updates issues for actionable results.
 * @returns {Promise<{created: string[], commented: string[], skipped: string[]}>}
 */
export async function syncIssues(report, client) {
  const open = await client.listOpenIssues(LABEL);
  const outcome = { created: [], commented: [], skipped: [] };
  for (const result of report.results.filter((r) => ACTIONABLE.has(r.status))) {
    const existing = open.find((i) => i.title === issueTitle(result.slug));
    if (!existing) {
      await client.createIssue({ title: issueTitle(result.slug), body: issueBody(result), labels: [LABEL] });
      outcome.created.push(result.slug);
      continue;
    }
    const comments = await client.listComments(existing.number);
    const seen = [existing.body ?? '', ...comments.map((c) => c.body ?? '')].some((b) => b.includes(marker(result)));
    if (seen) {
      outcome.skipped.push(result.slug);
    } else {
      await client.createComment(existing.number, `The scheduled check found this again.\n\n${issueBody(result)}`);
      outcome.commented.push(result.slug);
    }
  }
  return outcome;
}

/** One-line summary of what syncIssues did. */
export function formatOutcome({ created, commented, skipped }) {
  const list = (items) => items.join(', ') || 'none';
  return `created: ${list(created)}; updated: ${list(commented)}; already reported: ${list(skipped)}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const client = createClient({
    fetch: globalThis.fetch,
    token: process.env.GITHUB_TOKEN,
    repo: process.env.GITHUB_REPOSITORY,
    apiUrl: process.env.GITHUB_API_URL,
  });
  const outcome = await syncIssues(report, client);
  console.log(formatOutcome(outcome));
}
