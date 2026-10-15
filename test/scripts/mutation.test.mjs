import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyMutant, generateMutants, mutationScore, tokenize } from '../../scripts/lib/mutation.mjs';
import { DEFAULT_THRESHOLD, formatReport, listTestCases, namePattern, planRuns, profileTests, runMutation, runTests, sourceFiles, summarize, testFiles, testsCovering } from '../../scripts/mutation.mjs';
import testListReporter from '../../scripts/lib/test-list-reporter.mjs';
import { REPO, fixtureRepo, runScriptAsync } from '../helpers.mjs';

const values = (src) => tokenize(src).tokens.map((t) => `${t.type}:${t.value}`);
const mutate = (src) => generateMutants(src).map((m) => `${m.operator}:${m.original}->${m.replacement}`);

describe('tokenize', () => {
  test('words, numbers, strings and punctuators', () => {
    assert.deepEqual(values('const a = b.c >= 10;'), ['word:const', 'word:a', 'punct:=', 'word:b', 'punct:.', 'word:c', 'punct:>=', 'number:10', 'punct:;']);
    assert.deepEqual(values(`x('a\\'b', "c")`), ['word:x', 'punct:(', "string:'a\\'b'", 'punct:,', 'string:"c"', 'punct:)']);
    assert.deepEqual(values('a ?? b ?. c ... d === e !== f'), ['word:a', 'punct:??', 'word:b', 'punct:?.', 'word:c', 'punct:...', 'word:d', 'punct:===', 'word:e', 'punct:!==', 'word:f']);
    assert.deepEqual(values('.5 + 1_000'), ['number:.5', 'punct:+', 'number:1_000']);
  });

  test('drops comments but reports them with lines', () => {
    const { tokens, comments } = tokenize('a // one\n/* two\nlines */ b');
    assert.deepEqual(tokens.map((t) => [t.value, t.line]), [['a', 1], ['b', 3]]);
    assert.deepEqual(comments, [{ value: '// one', line: 1 }, { value: '/* two\nlines */', line: 2 }]);
  });

  test('template literals keep ${} code as tokens', () => {
    assert.deepEqual(values('`a${b + `c${d}`}e`'), ['template:a', 'word:b', 'punct:+', 'template:c', 'word:d', 'template:', 'template:e']);
    assert.deepEqual(values('`x${ {a: 1}.a }y`'), ['template:x', 'punct:{', 'word:a', 'punct::', 'number:1', 'punct:}', 'punct:.', 'word:a', 'template:y']);
    assert.deepEqual(values('`\\`${1}`'), ['template:\\`', 'number:1', 'template:']);
  });

  test('tells regular expressions from division', () => {
    assert.deepEqual(values('x = /a[/]b/g.test(y)'), ['word:x', 'punct:=', 'regex:/a[/]b/g', 'punct:.', 'word:test', 'punct:(', 'word:y', 'punct:)']);
    assert.deepEqual(values('a / b / c'), ['word:a', 'punct:/', 'word:b', 'punct:/', 'word:c']);
    assert.deepEqual(values('return /x\\/y/'), ['word:return', 'regex:/x\\/y/']);
    assert.deepEqual(values('(a) / 2'), ['punct:(', 'word:a', 'punct:)', 'punct:/', 'number:2']);
    assert.deepEqual(values('/^a/.test(s)')[0], 'regex:/^a/');
  });

  test('reports errors for unterminated input', () => {
    assert.throws(() => tokenize('"abc'), /Unterminated string at line 1/);
    assert.throws(() => tokenize("'a\nb'"), /Unterminated string/);
    assert.throws(() => tokenize('/* never'), /Unterminated comment/);
    assert.throws(() => tokenize('`abc'), /Unterminated template literal/);
    assert.throws(() => tokenize('x = /abc\n/'), /Unterminated regular expression at line 1/);
    assert.throws(() => tokenize('a ¬ b'), /Unexpected character "¬" at line 1/);
  });

  test('tracks line numbers', () => {
    assert.deepEqual(tokenize('a\n\nb\n  c').tokens.map((t) => t.line), [1, 3, 4]);
  });
});

describe('generateMutants', () => {
  test('swaps operators, booleans and methods', () => {
    assert.deepEqual(mutate('a === b && c < d'), ['operator:===->!==', 'operator:&&->||', 'operator:<-><=']);
    assert.deepEqual(mutate('x.some(f) || true'), ['method:some->every', 'operator:||->&&', 'boolean:true->false']);
    assert.deepEqual(mutate('some(x)'), []);
    assert.deepEqual(mutate('a ?? b'), ['operator:??->&&']);
    assert.deepEqual(mutate('n += 1'), ['operator:+=->-=', 'number:1->2']);
  });

  test('only swaps binary arithmetic', () => {
    assert.deepEqual(mutate('a + b'), ['operator:+->-']);
    assert.deepEqual(mutate('f(-1)'), ['number:1->2']);
    assert.deepEqual(mutate('return -x'), ['return-void:return ->return void ']);
    assert.deepEqual(mutate('(a) * b[0] % 2'), ['operator:*->/', 'number:0->1', 'operator:%->*', 'number:2->3']);
    assert.deepEqual(mutate('typeof -x'), []);
  });

  test('negation, conditions, numbers, strings and returns', () => {
    assert.deepEqual(mutate('!a'), ['negation-removal:!->']);
    assert.deepEqual(mutate('!!a'), ['negation-removal:!->']);
    assert.deepEqual(mutate('if (a) b()'), ['condition-true:a->true', 'condition-false:a->false']);
    assert.deepEqual(mutate('if (f(a)) {}'), ['condition-true:f(a)->true', 'condition-false:f(a)->false']);
    assert.deepEqual(mutate('if () x'), []);
    assert.deepEqual(mutate('x = "hello"'), ['string-empty:"hello"->""']);
    assert.deepEqual(mutate("x = ''"), []);
    assert.deepEqual(mutate('return;'), []);
    assert.deepEqual(mutate('{ return }'), []);
    assert.deepEqual(mutate('x = 1.5'), []);
  });

  test('never mutates module specifiers', () => {
    assert.deepEqual(mutate("import a from './a.js';\nimport './b.js';\nexport { c } from './c.js';\nconst d = import('./d.js');"), []);
  });

  test('honours mutation-ignore comments', () => {
    assert.deepEqual(mutate('a === b; // mutation-ignore\nc === d;'), ['operator:===->!==']);
  });

  test('applyMutant replaces the span and ids are sequential', () => {
    const src = 'if (a > 1) return "x";';
    const mutants = generateMutants(src);
    assert.deepEqual(mutants.map((m) => m.id), mutants.map((_, i) => i));
    assert.equal(applyMutant(src, mutants.find((m) => m.operator === 'operator')), 'if (a >= 1) return "x";');
    assert.equal(applyMutant(src, mutants.find((m) => m.operator === 'return-void')), 'if (a > 1) return void "x";');
    assert.equal(mutants[0].line, 1);
  });

  test('tokenizes every source file in the repository', () => {
    for (const file of [...sourceFiles(REPO), 'site/app.js', 'site/callback.js', 'scripts/mutation.mjs']) {
      assert.ok(generateMutants(readFileSync(join(REPO, file), 'utf8')).length > 0, file);
    }
  });
});

describe('scoring and reporting', () => {
  test('mutationScore', () => {
    assert.equal(mutationScore({ killed: 3, survived: 1 }), 75);
    assert.equal(mutationScore({ killed: 0, survived: 0 }), 100);
  });

  test('summarize counts timeouts as killed and lists survivors', () => {
    const results = [
      { source: 'b.js', line: 2, operator: 'o', original: 'x', replacement: 'y', status: 'killed' },
      { source: 'b.js', line: 1, operator: 'o', original: 'x', replacement: 'y', status: 'survived' },
      { source: 'a.js', line: 5, operator: 'o', original: 'x', replacement: 'y', status: 'timeout' },
      { source: 'a.js', line: 3, operator: 'o', original: 'x', replacement: 'y', status: 'no-coverage' },
    ];
    const s = summarize(['a.js', 'b.js', 'c.js'], results);
    assert.deepEqual(s.files, [
      { source: 'a.js', total: 2, killed: 1, survived: 1, score: 50 },
      { source: 'b.js', total: 2, killed: 1, survived: 1, score: 50 },
      { source: 'c.js', total: 0, killed: 0, survived: 0, score: 100 },
    ]);
    assert.equal(s.killed, 2);
    assert.equal(s.survived, 2);
    assert.equal(s.score, 50);
    assert.deepEqual(s.survivors.map((r) => `${r.source}:${r.line}`), ['a.js:3', 'b.js:1']);
    const report = formatReport(s, 80);
    assert.ok(report.includes(' 50.0%       1/2      a.js'));
    assert.ok(report.includes('Overall: 50.0% (2 killed, 2 survived), threshold 80%'));
    assert.ok(report.includes('a.js:3  o  "x" -> "y"  (no test runs this code)'));
    assert.ok(report.includes('b.js:1  o  "x" -> "y"\n') || report.endsWith('b.js:1  o  "x" -> "y"'));
    assert.ok(!formatReport(summarize(['c.js'], []), 80).includes('Surviving'));
    assert.equal(DEFAULT_THRESHOLD, 80);
  });

  test('source and test discovery', () => {
    const sources = sourceFiles(REPO);
    assert.ok(sources.includes('site/lib/risk.js'));
    assert.ok(sources.includes('scripts/lib/mutation.mjs'));
    assert.ok(!sources.includes('scripts/mutation.mjs'));
    assert.ok(!sources.some((f) => f.startsWith('test/')));
    const tests = testFiles(REPO);
    assert.ok(tests.includes('test/site/risk.test.mjs'));
    assert.ok(tests.every((t) => t.endsWith('.test.mjs')));
    assert.ok(!tests.some((t) => t.startsWith('test/e2e/')));
    assert.deepEqual(sourceFiles(join(REPO, 'no-such-dir')), []);
  });

  test('namePattern matches one full test path literally', () => {
    assert.equal(namePattern('suite a (b) one'), '^suite a \\(b\\) one$');
    const re = new RegExp(namePattern('x.y [z]*'));
    assert.ok(re.test('x.y [z]*'));
    assert.ok(!re.test('xay [z]*'));
    assert.ok(!re.test('prefix x.y [z]*'));
  });

  test('planRuns tries the fastest case alone, then the rest by file', () => {
    const c = (file, path, ms) => ({ file, path, ms });
    assert.deepEqual(planRuns([]), []);
    const runs = planRuns([c('a.mjs', 'one', 10), c('b.mjs', 'two', 20), c('a.mjs', 'three', 30), c('b.mjs', 'four', 1), c('c.mjs', 'five', 2000)]);
    assert.deepEqual(runs, [
      { file: 'a.mjs', patterns: ['^one$'], timeoutMs: 5000 },
      { file: 'b.mjs', patterns: ['^two$', '^four$'], timeoutMs: 5000 },
      { file: 'a.mjs', patterns: ['^three$'], timeoutMs: 5000 },
      { file: 'c.mjs', patterns: ['^five$'], timeoutMs: 8000 },
    ]);
  });

  test('the test-list reporter prints full paths of leaf cases only', async () => {
    async function* events() {
      yield { type: 'test:start', data: { name: 'suite', nesting: 0 } };
      yield { type: 'test:start', data: { name: 'inner', nesting: 1 } };
      yield { type: 'test:pass', data: { name: 'inner', nesting: 1, details: { duration_ms: 2, type: 'test' } } };
      yield { type: 'test:start', data: { name: 'bad', nesting: 1 } };
      yield { type: 'test:fail', data: { name: 'bad', nesting: 1, details: { duration_ms: 3 } } };
      yield { type: 'test:pass', data: { name: 'suite', nesting: 0, details: { duration_ms: 6, type: 'suite' } } };
      yield { type: 'test:start', data: { name: 'top', nesting: 0 } };
      yield { type: 'test:pass', data: { name: 'top', nesting: 0, details: {} } };
      yield { type: 'test:diagnostic', data: { message: 'x' } };
    }
    const lines = [];
    for await (const line of testListReporter(events())) lines.push(JSON.parse(line));
    assert.deepEqual(lines, [
      { path: 'suite inner', ms: 2, passed: true },
      { path: 'suite bad', ms: 3, passed: false },
      { path: 'top', ms: 0, passed: true },
    ]);
  });

  test('testsCovering picks profiled tests that execute an offset, in profile order', () => {
    const mask = (bits) => Uint8Array.from(bits);
    const profiles = [
      { test: 'fast', ms: 1, masks: new Map([['a.js', mask([1, 0, 1])]]) },
      { test: 'slow', ms: 9, masks: new Map([['a.js', mask([1, 1, 0])], ['b.js', mask([1])]]) },
    ];
    assert.deepEqual(testsCovering(profiles, 'a.js', 0).map((p) => p.test), ['fast', 'slow']);
    assert.deepEqual(testsCovering(profiles, 'a.js', 1).map((p) => p.test), ['slow']);
    assert.deepEqual(testsCovering(profiles, 'a.js', 2).map((p) => p.test), ['fast']);
    assert.deepEqual(testsCovering(profiles, 'b.js', 0).map((p) => p.test), ['slow']);
    assert.deepEqual(testsCovering(profiles, 'c.js', 0), []);
  });
});

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
      const result = await runMutation({ root: repo.root, files: ['site/lib/loop.js'], concurrency: 2 });
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
