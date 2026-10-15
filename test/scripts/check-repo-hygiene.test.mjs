import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findViolations } from '../../scripts/check-repo-hygiene.mjs';

const flagged = (path) => findViolations([path]).length > 0;

test('rejects planning and scratch files', () => {
  for (const p of ['TASKS.md', 'tasks.md', 'docs/TODO.md', 'PLAN.md', 'notes.md',
    'research/vendors.md', 'docs/research/sweep.md', '.scratch/x.txt', 'byoghapp-research.md']) {
    assert.ok(flagged(p), p);
  }
});

test('rejects credentials and npm artifacts', () => {
  for (const p of ['app.private-key.pem', '.env', '.env.local', 'node_modules/x/index.js',
    'package-lock.json', '.claude/settings.local.json', 'CLAUDE.local.md']) {
    assert.ok(flagged(p), p);
  }
});

test('allows normal project files', () => {
  for (const p of ['README.md', 'AGENTS.md', 'CLAUDE.md', 'docs/maintainers/repository-settings.md',
    'entries/atlantis.json', '.env.example', 'scripts/build.mjs', 'site/app.js']) {
    assert.ok(!flagged(p), p);
  }
});
