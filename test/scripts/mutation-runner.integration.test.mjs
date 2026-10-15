// End-to-end tests of the mutation runner (scripts/mutation.mjs): they start
// real child processes and whole nested mutation runs, so they take seconds.
// Files named *.integration.test.mjs run in npm test, coverage and CI, but the
// mutation runner doesn't use them to kill mutants: unit tests must do that.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listTestCases, profileTests, runMutation, runTests } from '../../scripts/mutation.mjs';
import { fixtureRepo, runScriptAsync } from '../helpers.mjs';

describe('profiling', () => {
  test('profileTests records coverage per test case, including child processes', async () => {
    const repo = fixtureRepo({}, { gitInit: false });
    repo.write('site/lib/a.js', 'export function a(x) {\n  if (x) return 1;\n  return 2;\n}\n');
    repo.write('test/site/a.test.mjs', "import { test } from 'node:test';\nimport { a } from '../../site/lib/a.js';\ntest('a', () => a(true));\n");
    repo.write('test/site/child.test.mjs', "import { test } from 'node:test';\nimport { execFileSync } from 'node:child_process';\ntest('child', () => { execFileSync(process.execPath, ['-e', \"import('./site/lib/a.js').then((m) => m.a(false))\"]); });\n");
    const src = readFileSync(join(repo.root, 'site/lib/a.js'), 'utf8');
    try {
      const cases = await listTestCases([repo.root], ['test/site/a.test.mjs', 'test/site/child.test.mjs']);
      assert.deepEqual(cases, [{ file: 'test/site/a.test.mjs', path: 'a' }, { file: 'test/site/child.test.mjs', path: 'child' }]);
      const profiles = await profileTests([repo.root], cases, new Map([['site/lib/a.js', src]]));
      assert.equal(profiles.length, 2);
      assert.ok(profiles[0].ms <= profiles[1].ms);
      const byTest = Object.fromEntries(profiles.map((p) => [p.path, p.masks.get('site/lib/a.js')]));
      const at = (text) => src.indexOf(text);
      assert.equal(byTest.a[at('return 1')], 1);
      assert.equal(byTest.a[at('return 2')], 0);
      assert.equal(byTest.child[at('return 2')], 1, 'coverage from a child process counts');
    } finally {
      repo.cleanup();
    }
  });

  test('runTests reports pass, failure and timeout', async () => {
    const repo = fixtureRepo({}, { gitInit: false });
    repo.write('test/site/pass.test.mjs', "import { test } from 'node:test';\ntest('ok', () => {});\n");
    repo.write('test/site/fail.test.mjs', "import { test } from 'node:test';\ntest('no', () => { throw new Error('x'); });\n");
    repo.write('test/site/hang.test.mjs', "import { test } from 'node:test';\ntest('hang', () => { for (;;); });\n");
    try {
      const pass = await runTests(repo.root, 'test/site/pass.test.mjs', 30_000);
      assert.deepEqual([pass.passed, pass.timedOut], [true, false]);
      const fail = await runTests(repo.root, 'test/site/fail.test.mjs', 30_000);
      assert.deepEqual([fail.passed, fail.timedOut], [false, false]);
      const onlyPass = await runTests(repo.root, 'test/site/fail.test.mjs', 30_000, { patterns: ['^nothing$'] });
      assert.equal(onlyPass.passed, true, 'patterns limit which cases run');
      const hang = await runTests(repo.root, 'test/site/hang.test.mjs', 1_000);
      assert.deepEqual([hang.passed, hang.timedOut], [false, true]);
    } finally {
      repo.cleanup();
    }
  });
});

describe('runMutation', () => {
  function project(testSource) {
    const repo = fixtureRepo({}, { gitInit: false });
    repo.write('site/lib/calc.js', 'export function isBigger(a, b) {\n  return a > b;\n}\n');
    repo.write('site/lib/untested.js', 'export const flag = true;\n');
    repo.write('test/site/calc.test.mjs', testSource);
    return repo;
  }
  const strong = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { isBigger } from '../../site/lib/calc.js';\ntest('isBigger', () => { assert.equal(isBigger(2, 1), true); assert.equal(isBigger(1, 2), false); assert.equal(isBigger(2, 2), false); });\n";
  const weak = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { isBigger } from '../../site/lib/calc.js';\ntest('isBigger', () => { assert.ok(isBigger(2, 1)); });\n";

  test('kills mutants with good tests and reports survivors with weak ones', async () => {
    const good = project(strong);
    const poor = project(weak);
    try {
      const logs = [];
      const strongResult = await runMutation({ root: good.root, files: ['site/lib/calc.js'], concurrency: 2, log: (m) => logs.push(m) });
      assert.equal(strongResult.files[0].survived, 0);
      assert.equal(strongResult.score, 100);
      const weakResult = await runMutation({ root: poor.root, files: ['site/lib/calc.js', 'site/lib/untested.js'], concurrency: 1 });
      assert.ok(weakResult.files[0].survived > 0);
      assert.equal(weakResult.files[1].score, 0);
      assert.ok(weakResult.survivors.some((s) => s.status === 'no-coverage' && s.source === 'site/lib/untested.js'));
      assert.ok(logs.some((m) => /Profiling \d+ test cases/.test(m)));
      assert.ok(logs.some((m) => /Testing \d+ mutants in 2 sandboxes/.test(m)));
    } finally {
      good.cleanup();
      poor.cleanup();
    }
  });

  test('refuses order-dependent cases that fail when run alone', async () => {
    const coupled = project("import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport '../../site/lib/calc.js';\nlet ready = false;\ntest('setup', () => { ready = true; });\ntest('uses setup', () => assert.ok(ready));\n");
    try {
      await assert.rejects(runMutation({ root: coupled.root, files: ['site/lib/calc.js'], concurrency: 1 }), /"uses setup" in test\/site\/calc\.test\.mjs fails when run alone/);
    } finally {
      coupled.cleanup();
    }
  });

  test('refuses to run when the tests already fail', async () => {
    const broken = project("import { test } from 'node:test';\nimport '../../site/lib/calc.js';\ntest('x', () => { throw new Error('red'); });\n");
    try {
      await assert.rejects(runMutation({ root: broken.root, files: ['site/lib/calc.js'], concurrency: 1 }), /test\/site\/calc\.test\.mjs fails without any mutation/);
    } finally {
      broken.cleanup();
    }
  });

  test('times out runaway mutants', async () => {
    const repo = fixtureRepo({}, { gitInit: false });
    repo.write('site/lib/loop.js', 'export function count(n) {\n  let i = 0;\n  while (i < n) i += 1;\n  return i;\n}\n');
    repo.write('test/site/loop.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { count } from '../../site/lib/loop.js';\ntest('count', () => { assert.equal(count(3), 3); assert.equal(count(0), 0); });\n");
    try {
      const result = await runMutation({ root: repo.root, files: ['site/lib/loop.js'], concurrency: 2, minTimeoutMs: 1_000 });
      assert.equal(result.survived, 0, JSON.stringify(result.survivors));
    } finally {
      repo.cleanup();
    }
  });

  test('the CLI enforces the threshold and writes a report', async () => {
    const poor = project(weak);
    try {
      const reportPath = join(poor.root, 'm.json');
      const r = await runScriptAsync('scripts/mutation.mjs', ['--file', 'site/lib/calc.js', '--threshold', '99', '--concurrency', '1', '--report', reportPath], { root: poor.root });
      assert.equal(r.code, 1);
      assert.match(r.stdout, /Surviving mutants/);
      assert.match(r.stderr, /is below the 99% threshold/);
      const ok = await runScriptAsync('scripts/mutation.mjs', ['--file', 'site/lib/calc.js', '--threshold', '0', '--concurrency', '1'], { root: poor.root });
      assert.equal(ok.code, 0);
    } finally {
      poor.cleanup();
    }
  });

  test('the CLI --changed mode skips when nothing relevant changed', async () => {
    const repo = fixtureRepo({});
    try {
      repo.write('README.md', 'x');
      repo.commit('docs');
      const r = await runScriptAsync('scripts/mutation.mjs', ['--changed', 'main~1'], { root: repo.root });
      assert.equal(r.code, 0);
      assert.match(r.stdout, /No mutable source files changed/);
    } finally {
      repo.cleanup();
    }
  });
});
