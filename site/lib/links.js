// Links back to the repository: issue forms prefilled from an entry.

import { REPO_URL } from './config.js';

/** "Report a problem" link that opens the report-problem issue form, prefilled. */
export function reportProblemUrl(entry, repoUrl = REPO_URL) {
  const params = new URLSearchParams({
    template: 'report-problem.yml',
    title: `Problem with entry: ${entry.slug}`,
    labels: 'entry-problem,triage',
    entry: entry.slug,
    doc_url: entry.documentation_url,
  });
  return `${repoUrl}/issues/new?${params}`;
}

/** Link to an entry's YAML file and its history on GitHub. */
export function entrySourceUrl(entry, repoUrl = REPO_URL) {
  return `${repoUrl}/blob/main/entries/${encodeURIComponent(entry.slug)}.yaml`;
}

export function entryHistoryUrl(entry, repoUrl = REPO_URL) {
  return `${repoUrl}/commits/main/entries/${encodeURIComponent(entry.slug)}.yaml`;
}
