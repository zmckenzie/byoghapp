import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { entryHistoryUrl, entrySourceUrl, reportProblemUrl } from '../../site/lib/links.js';
import { REPO_URL, SITE_NAME, SITE_TAGLINE } from '../../site/lib/config.js';
import { makeEntry } from '../helpers.mjs';

describe('links', () => {
  const entry = makeEntry({ slug: 'renovate', documentation_url: 'https://docs.renovatebot.com/x?y=1' });

  test('report a problem pre-fills the issue form fields by id', () => {
    const url = new URL(reportProblemUrl(entry));
    assert.equal(`${url.origin}${url.pathname}`, `${REPO_URL}/issues/new`);
    assert.equal(url.searchParams.get('template'), 'report-problem.yml');
    assert.equal(url.searchParams.get('title'), 'Problem with entry: renovate');
    assert.equal(url.searchParams.get('labels'), 'entry-problem,triage');
    assert.equal(url.searchParams.get('entry'), 'renovate');
    assert.equal(url.searchParams.get('doc_url'), 'https://docs.renovatebot.com/x?y=1');
    assert.match(reportProblemUrl(entry, 'https://github.com/o/r'), /^https:\/\/github\.com\/o\/r\/issues\/new\?/);
  });

  test('source and history links', () => {
    assert.equal(entrySourceUrl(entry), `${REPO_URL}/blob/main/entries/renovate.json`);
    assert.equal(entryHistoryUrl(entry), `${REPO_URL}/commits/main/entries/renovate.json`);
    assert.equal(entrySourceUrl(entry, 'https://x'), 'https://x/blob/main/entries/renovate.json');
    assert.equal(entryHistoryUrl(entry, 'https://x'), 'https://x/commits/main/entries/renovate.json');
  });

  test('site constants', () => {
    assert.equal(REPO_URL, 'https://github.com/zmckenzie/byoghapp');
    assert.equal(SITE_NAME, 'byoghapp');
    assert.match(SITE_TAGLINE, /GitHub App definitions/);
  });
});
