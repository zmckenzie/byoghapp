// Conventional Commits (https://www.conventionalcommits.org/) for pull request
// titles, which become the squash-merge commit subjects on main, and the
// semantic version bump and release notes they imply.

import { compareVersions } from './entry-rules.mjs';

/** Allowed types, and the release-notes heading for those that cut a release. */
export const TYPES = ['feat', 'fix', 'perf', 'revert', 'docs', 'test', 'refactor', 'style', 'build', 'ci', 'chore'];
const RELEASE_TYPES = { feat: 'minor', fix: 'patch', perf: 'patch', revert: 'patch' };
const HEADINGS = [
  ['breaking', 'Breaking changes'],
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
  ['revert', 'Reverts'],
];

const SUBJECT = /^([a-z]+)(?:\(([a-z0-9][a-z0-9._/-]*)\))?(!)?: (\S.*)$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE: /m;

/** A version tag (v1.2.3) as a version string, or null. */
export function tagVersion(tag) {
  const m = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  return m ? m[1] : null;
}

/** The highest v<semver> tag's version, or null when there is none. */
export function latestVersion(tags) {
  return tags.map(tagVersion).filter(Boolean).sort(compareVersions).at(-1) ?? null;
}

/**
 * Parses a commit message (subject line, optional body). Returns
 * {type, scope, breaking, description}, or null if the subject isn't a
 * conventional commit.
 */
export function parseCommit(message) {
  const [subject, ...body] = String(message).split('\n');
  const m = SUBJECT.exec(subject.trim());
  if (!m || !TYPES.includes(m[1])) return null;
  return {
    type: m[1],
    scope: m[2] ?? null,
    breaking: Boolean(m[3]) || BREAKING_FOOTER.test(body.join('\n')),
    description: m[4].trim(),
  };
}

/** Why a pull request title isn't a conventional commit, or null when it is. */
export function titleProblem(title) {
  const text = String(title ?? '').trim();
  if (parseCommit(text)) return null;
  const type = /^([a-z]+)/.exec(text)?.[1];
  if (type && !TYPES.includes(type) && /^[a-z]+(\(.*\))?!?:/.test(text)) {
    return `"${type}" is not a commit type; use one of: ${TYPES.join(', ')}`;
  }
  return 'the title must look like "type(scope): description", for example "feat(entries): add Renovate" or "fix!: drop the old field"';
}

/** The bump a set of commit messages calls for: 'major', 'minor', 'patch' or null. */
export function bumpFor(messages) {
  const parsed = messages.map(parseCommit).filter(Boolean);
  if (parsed.some((c) => c.breaking)) return 'major';
  if (parsed.some((c) => RELEASE_TYPES[c.type] === 'minor')) return 'minor';
  if (parsed.some((c) => RELEASE_TYPES[c.type] === 'patch')) return 'patch';
  return null;
}

/**
 * The next version. Before 1.0.0, breaking changes and features bump the minor
 * version and everything else the patch version, as semver allows for 0.x.
 */
export function nextVersion(version, bump) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (bump === 'major' && major > 0) return `${major + 1}.0.0`;
  if (bump === 'major' || bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The first line of a commit message with a trailing "(#123)" turned into a link. */
function noteLine({ sha, message }, repoUrl) {
  const c = parseCommit(message);
  const scope = c.scope ? `**${c.scope}:** ` : '';
  const text = c.description.replace(/\(#(\d+)\)$/, `([#$1](${repoUrl}/pull/$1))`);
  return `- ${scope}${text} (${sha.slice(0, 7)})`;
}

/**
 * Release notes in Markdown for commits [{sha, message}], newest first, grouped
 * by kind. Commits that don't cut a release (docs, chore, ...) are counted, not
 * listed.
 */
export function releaseNotes({ version, previous, commits, repoUrl }) {
  const parsed = commits.map((c) => ({ ...c, parsed: parseCommit(c.message) })).filter((c) => c.parsed);
  const lines = [`## byoghapp ${version}`, ''];
  for (const [key, heading] of HEADINGS) {
    const items = parsed.filter((c) => (key === 'breaking' ? c.parsed.breaking : !c.parsed.breaking && c.parsed.type === key));
    if (items.length > 0) lines.push(`### ${heading}`, '', ...items.map((c) => noteLine(c, repoUrl)), '');
  }
  const other = commits.length - parsed.filter((c) => c.parsed.breaking || RELEASE_TYPES[c.parsed.type]).length;
  if (other > 0) lines.push(`${other} other ${other === 1 ? 'change' : 'changes'} (documentation, tests, maintenance).`, '');
  lines.push(previous ? `**Full changes:** ${repoUrl}/compare/v${previous}...v${version}` : `First release.`);
  return `${lines.join('\n')}\n`;
}
