#!/usr/bin/env node
// Fails if tracked files include planning or scratch documents, credentials, or npm artifacts.
// Uses Node.js built-ins only. Runs in CI and locally: `node scripts/check-repo-hygiene.mjs`.

import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

/** Each rule: a test on a repo-relative path and the reason it is rejected. */
export const RULES = [
  {
    reason: 'planning and task notes are tracked in GitHub Issues and Projects, not in the repo',
    test: (p) => /^(tasks|todo|plan|notes)\.md$/i.test(basename(p)),
  },
  {
    reason: 'research and notes documents stay out of the repo',
    test: (p) =>
      /(^|\/)(research|notes|\.notes|\.scratch|plans)\//i.test(p) ||
      /[.-](research|notes|plan)\.md$/i.test(basename(p)),
  },
  {
    reason: 'agent-local configuration is personal and not committed',
    test: (p) =>
      /^(CLAUDE|AGENTS)\.local\.md$/.test(basename(p)) || p === '.claude/settings.local.json',
  },
  {
    reason: 'possible credential or private key',
    test: (p) =>
      /\.(pem|key|p12|pfx)$/i.test(p) ||
      (/(^|\/)\.env(\..+)?$/.test(p) && !p.endsWith('.env.example')) ||
      /(^|\/)\.dev\.vars/.test(p),
  },
  {
    reason: 'the project has zero npm dependencies (see AGENTS.md)',
    test: (p) => /(^|\/)(node_modules\/|package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$)/.test(p),
  },
];

export function findViolations(paths) {
  const violations = [];
  for (const path of paths) {
    for (const rule of RULES) {
      if (rule.test(path)) violations.push({ path, reason: rule.reason });
    }
  }
  return violations;
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = findViolations(trackedFiles());
  if (violations.length === 0) {
    console.log('Repository hygiene: OK');
  } else {
    for (const { path, reason } of violations) {
      console.error(`::error file=${path}::${path}: ${reason}`);
    }
    console.error(`\n${violations.length} file(s) must not be committed. See CONTRIBUTING.md.`);
    process.exitCode = 1;
  }
}
