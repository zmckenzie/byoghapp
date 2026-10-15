#!/usr/bin/env node
// Scheduled verification: fetches each entry's documentation and compares a
// fingerprint of its permission-related text with the stored doc_hash.
// It never edits entries; it writes a report that verification-issues.mjs
// turns into issues for a person to review.
//
//   node scripts/verify.mjs [--report report.json] [slug ...]
//
// Statuses: ok (unchanged), changed, no-baseline (no doc_hash recorded yet),
// unreachable (a page failed to load).

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fetchPage, fingerprint, htmlToText, relevantLines } from './lib/online.mjs';
import { ROOT, listEntrySlugs, loadData, readEntry } from './lib/repo.mjs';

/** Fetches an entry's pages and computes its current fingerprint. */
export async function currentFingerprint(entry, data, fetch) {
  const urls = [entry.documentation_url, ...(entry.documentation_urls ?? [])];
  const lines = [];
  for (const url of urls) {
    const page = await fetchPage(url, fetch);
    if (page.error || page.status !== 200) {
      return { error: `${url}: ${page.error ?? `HTTP ${page.status}`}` };
    }
    lines.push(...relevantLines(htmlToText(page.text), data.permissions, data.events));
  }
  if (lines.length === 0) return { error: 'no permission-related text found on the documentation pages' };
  return { hash: fingerprint(lines) };
}

/** Verifies entries and returns the report object. */
export async function verifyEntries({ root = ROOT, slugs, fetch = globalThis.fetch, now = new Date() } = {}) {
  const data = loadData(root);
  const results = [];
  for (const slug of slugs?.length ? slugs : listEntrySlugs(root)) {
    const { entry, error } = readEntry(slug, root);
    if (error) {
      results.push({ slug, status: 'unreachable', error });
      continue;
    }
    const stored = entry.verification.doc_hash;
    const current = await currentFingerprint(entry, data, fetch);
    const base = { slug, documentation_url: entry.documentation_url, last_verified: entry.last_verified, stored_hash: stored };
    if (current.error) results.push({ ...base, status: 'unreachable', error: current.error });
    else if (!stored) results.push({ ...base, status: 'no-baseline', current_hash: current.hash });
    else results.push({ ...base, status: current.hash === stored ? 'ok' : 'changed', current_hash: current.hash });
  }
  return { generated_at: now.toISOString(), results };
}

/** Markdown summary for the workflow run page. */
export function summaryMarkdown(report) {
  const counts = {};
  for (const r of report.results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const lines = ['## Documentation verification', '', Object.entries(counts).map(([s, n]) => `${s}: ${n}`).join(' · '), '',
    '| Entry | Status | Detail |', '| --- | --- | --- |'];
  for (const r of report.results) {
    const detail = r.error ?? (r.status === 'no-baseline' ? `record \`${r.current_hash}\` with /verified` : '');
    lines.push(`| ${r.slug} | ${r.status} | ${detail.replaceAll('|', '\\|')} |`);
  }
  return `${lines.join('\n')}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values, positionals } = parseArgs({ options: { report: { type: 'string' } }, allowPositionals: true });
  const report = await verifyEntries({ slugs: positionals });
  if (values.report) writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(summaryMarkdown(report));
}
