// Release planning: what a push to main should do (propose a release, publish
// one, or nothing), the version bump in package.json and package-lock.json, and
// the release pull request. Used by scripts/release.mjs.

import { bumpFor, latestVersion, nextVersion } from './conventional.mjs';
import { compareVersions } from './entry-rules.mjs';

export const RELEASE_BRANCH = 'release/next';

/** The workflows a release pull request needs, since a bot's PR starts none by itself. */
export const RELEASE_PR_CHECKS = ['ci.yml', 'validate.yml', 'dependency-review.yml', 'codeql.yml', 'pr-title.yml'];

export const releaseTitle = (version) => `chore(release): v${version}`;

/**
 * Decides what to do for the commit main now points at.
 *
 * - publish: package.json names a version with no tag yet, and this push changed
 *   it (a merged release pull request) or a maintainer started the workflow.
 * - pending: package.json names an untagged version this push didn't change, so
 *   a release is already waiting for approval; propose nothing new.
 * - propose: the commits since the last release call for a new version.
 * - none: nothing to release, or package.json is behind the latest tag.
 *
 * @param {{version: string, parentVersion: string|null, tags: string[], messages: string[], manual?: boolean}} input
 *   messages: commit messages since the latest release tag
 */
export function planRelease({ version, parentVersion, tags, messages, manual = false }) {
  const latest = latestVersion(tags);
  if (!tags.includes(`v${version}`)) {
    if (latest && compareVersions(version, latest) <= 0) { // mutation-ignore: < is equivalent; a version equal to the latest is tagged
      return { action: 'none', reason: `package.json version ${version} is not newer than the latest release ${latest}` };
    }
    if (manual || version !== parentVersion) return { action: 'publish', version, previous: latest };
    return { action: 'pending', version, reason: `v${version} is waiting to be published` };
  }
  const bump = bumpFor(messages);
  if (!bump) return { action: 'none', reason: `no feat, fix, perf, revert or breaking commits since v${version}` };
  return { action: 'propose', version: nextVersion(version, bump), previous: latest };
}

/** package.json text with a new version, in npm's formatting. */
export function bumpPackageJson(text, version) {
  return `${JSON.stringify({ ...JSON.parse(text), version }, null, 2)}\n`;
}

/** package-lock.json text with the root package's new version. */
export function bumpLockfile(text, version) {
  const lock = JSON.parse(text);
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  return `${JSON.stringify(lock, null, 2)}\n`;
}

/** Parses `git log --format=%H%x1f%B%x1e` output into [{sha, message}], newest first. */
export function parseGitLog(output) {
  return output.split('\x1e').map((record) => record.trim()).filter(Boolean).map((record) => {
    const [sha, message = ''] = record.split('\x1f');
    return { sha: sha.trim(), message: message.trim() };
  });
}

/** The release pull request's description. */
export function releasePrBody(notes) {
  return [
    notes.trim(),
    '',
    '---',
    '',
    'This pull request is maintained by the Release PR workflow: it sets the version in `package.json` and',
    '`package-lock.json`, and it is rewritten whenever `main` changes, so edits to it are lost.',
    '',
    'Merging it starts the Release workflow, which builds the site and then waits for a maintainer to approve',
    'the `release` environment before it signs the build provenance and publishes the release.',
    '',
  ].join('\n');
}

/**
 * Points the release branch at a commit that sets the new version on top of
 * baseSha (created through the API, so GitHub signs it), opens or updates the
 * release pull request, and starts the checks it needs.
 *
 * @param {{client: object, owner: string, base: string, baseSha: string, version: string,
 *   files: Record<string, string>, body: string}} options files: path -> new content
 */
export async function proposeRelease({ client, owner, base, baseSha, version, files, body }) {
  const title = releaseTitle(version);
  const head = await client.getCommit(baseSha);
  const tree = await client.createTree({
    base_tree: head.tree.sha,
    tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
  });
  const commit = await client.createCommit({ message: title, tree: tree.sha, parents: [baseSha] });
  await client.setBranch(RELEASE_BRANCH, commit.sha);
  const [open] = await client.listPulls({ head: `${owner}:${RELEASE_BRANCH}`, base });
  const pr = open
    ? await client.updatePull(open.number, { title, body })
    : await client.createPull({ title, body, head: RELEASE_BRANCH, base });
  for (const workflow of RELEASE_PR_CHECKS) {
    await client.dispatchWorkflow(workflow, RELEASE_BRANCH, workflow === 'pr-title.yml' ? { title } : undefined);
  }
  return { number: pr.number, url: pr.html_url, sha: commit.sha, created: !open };
}
