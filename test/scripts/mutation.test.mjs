import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyMutant, generateMutants, mutationScore, tokenize } from '../../scripts/lib/mutation.mjs';
import { DEFAULT_THRESHOLD, SLOW_CASE_MS, formatReport, namePattern, planRuns, sourceFiles, summarize, testFiles, testsCovering } from '../../scripts/mutation.mjs';
import testListReporter from '../../scripts/lib/test-list-reporter.mjs';
import { REPO } from '../helpers.mjs';

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

  test('a "/" after any operator or keyword that ends an expression start starts a regex', () => {
    const punct = ['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '&&', '||', '??', '=>', '==', '===', '!=', '!==', '<', '>', '<=', '>=', '+', '-', '*', '%', '+=', '-=', '*=', '/=', '...', '~', '^'];
    const words = ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'];
    for (const before of [...punct, ...words]) {
      const last = tokenize(`a ${before} /x/g`).tokens.at(-1);
      assert.deepEqual([last.type, last.value], ['regex', '/x/g'], `after ${before}`);
    }
    for (const before of ['a', '1', '"s"', ')', ']', 'x.y']) {
      const types = tokenize(`${before} / x / g`).tokens.map((t) => t.type);
      assert.ok(!types.includes('regex'), `division after ${before}`);
    }
  });

  test('skips a #! line at the start of a file', () => {
    assert.deepEqual(values('#!/usr/bin/env node\nconst a = 1;'), ['word:const', 'word:a', 'punct:=', 'number:1', 'punct:;']);
    assert.deepEqual(values('#!/usr/bin/env node'), []);
    assert.equal(tokenize('#!/x\na').tokens[0].line, 2);
    assert.deepEqual(mutate('#!/usr/bin/env node\nx = a / b;'), ['operator:/->*']);
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
      { source: 'b.js', line: 2, operator: 'o', original: 'x', replacement: 'y', status: 'killed', ms: 1500 },
      { source: 'b.js', line: 1, operator: 'o', original: 'x', replacement: 'y', status: 'survived' },
      { source: 'a.js', line: 5, operator: 'o', original: 'x', replacement: 'y', status: 'timeout' },
      { source: 'a.js', line: 3, operator: 'o', original: 'x', replacement: 'y', status: 'no-coverage' },
    ];
    const s = summarize(['a.js', 'b.js', 'c.js'], results);
    assert.deepEqual(s.files, [
      { source: 'a.js', total: 2, killed: 1, survived: 1, score: 50, ms: 0 },
      { source: 'b.js', total: 2, killed: 1, survived: 1, score: 50, ms: 1500 },
      { source: 'c.js', total: 0, killed: 0, survived: 0, score: 100, ms: 0 },
    ]);
    assert.equal(s.killed, 2);
    assert.equal(s.survived, 2);
    assert.equal(s.score, 50);
    assert.deepEqual(s.survivors.map((r) => `${r.source}:${r.line}`), ['a.js:3', 'b.js:1']);
    const report = formatReport(s, 80);
    assert.ok(report.includes(' 50.0%       1/2           0.0s  a.js'));
    assert.ok(report.includes(' 50.0%       1/2           1.5s  b.js'));
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
    assert.ok(sources.includes('fuzz/fuzz_yaml.js'));
    assert.ok(!sources.includes('scripts/mutation.mjs'));
    assert.ok(!sources.some((f) => f.startsWith('test/')));
    const tests = testFiles(REPO);
    assert.ok(tests.includes('test/site/risk.test.mjs'));
    assert.ok(tests.includes('test/fuzz/targets.test.mjs'));
    assert.ok(tests.every((t) => t.endsWith('.test.mjs')));
    assert.ok(!tests.some((t) => t.startsWith('test/e2e/')));
    assert.ok(!tests.some((t) => t.endsWith('.integration.test.mjs')), 'integration tests do not kill mutants');
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
    // Slow cases (>= SLOW_CASE_MS) run alone, after every fast group, fastest first.
    const mixed = planRuns([c('a.mjs', 'f1', 1), c('a.mjs', 's2', 900), c('a.mjs', 'f2', 2), c('a.mjs', 's1', 600)]);
    assert.deepEqual(mixed.map((r) => r.patterns), [['^f1$'], ['^f2$'], ['^s1$'], ['^s2$']]);
    assert.equal(SLOW_CASE_MS, 500);
    assert.equal(planRuns([c('a.mjs', 'one', 10)], { minTimeoutMs: 100 })[0].timeoutMs, 2030);
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
