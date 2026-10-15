import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyMutant, generateMutants, importClosure, importsOf, mutationScore, tokenize } from '../../scripts/lib/mutation.mjs';
import { DEFAULT_THRESHOLD, formatReport, runMutation, scriptsRunBy, sourceFiles, summarize, testFiles, testsFor } from '../../scripts/mutation.mjs';
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

describe('imports', () => {
  test('finds static, re-export, side-effect and dynamic relative imports', () => {
    const src = "import a from './a.js';\nimport { b } from \"../b.mjs\";\nexport * from './c.js';\nimport './d.js';\nconst e = await import('./e.js');\nimport fs from 'node:fs';";
    assert.deepEqual(importsOf(src), ['./a.js', '../b.mjs', './c.js', './d.js', './e.js']);
  });

  test('importClosure follows relative imports and tolerates missing files', () => {
    const files = { '/p/a.js': "import './b.js';", '/p/b.js': "import './c.js'; import './a.js';", '/p/c.js': "import './missing.js';" };
    const read = (p) => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p];
    };
    assert.deepEqual([...importClosure('/p/a.js', read)].sort(), ['/p/a.js', '/p/b.js', '/p/c.js', '/p/missing.js']);
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
      { source: 'a.js', line: 3, operator: 'o', original: 'x', replacement: 'y', status: 'no-tests' },
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
    assert.ok(report.includes('a.js:3  o  "x" -> "y"  (no tests import this file)'));
    assert.ok(report.includes('b.js:1  o  "x" -> "y"\n') || report.endsWith('b.js:1  o  "x" -> "y"'));
    assert.ok(!formatReport(summarize(['c.js'], []), 80).includes('Surviving'));
    assert.equal(DEFAULT_THRESHOLD, 80);
  });

  test('scriptsRunBy finds scripts tests launch', () => {
    const src = "runScript('scripts/a.mjs', []); await runScriptAsync( 'scripts/b.mjs'); spawn(x, [join(REPO, 'scripts/c.mjs')]); join(REPO, 'site'); other('scripts/d.mjs');";
    assert.deepEqual(scriptsRunBy(src), ['scripts/a.mjs', 'scripts/b.mjs', 'scripts/c.mjs']);
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
    assert.ok(testsFor('site/lib/risk.js', tests, REPO).includes('test/site/render.test.mjs'));
    assert.ok(testsFor('scripts/verify.mjs', tests, REPO).includes('test/scripts/cli.test.mjs'));
    // Mentioning a path in a string is not running it.
    assert.ok(!testsFor('site/lib/risk.js', tests, REPO).includes('test/scripts/mutation.test.mjs'));
    assert.deepEqual(sourceFiles(join(REPO, 'no-such-dir')), []);
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
      assert.ok(weakResult.survivors.some((s) => s.status === 'no-tests' && s.source === 'site/lib/untested.js'));
    } finally {
      good.cleanup();
      poor.cleanup();
    }
  });

  test('refuses to run when the tests already fail', async () => {
    const broken = project("import { test } from 'node:test';\nimport '../../site/lib/calc.js';\ntest('x', () => { throw new Error('red'); });\n");
    try {
      await assert.rejects(runMutation({ root: broken.root, files: ['site/lib/calc.js'], concurrency: 1 }), /Tests for site\/lib\/calc\.js fail without any mutation/);
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
