import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { YAMLError, isPlainSafe, parse, parseScalar, setTopLevel, stringify } from '../../scripts/lib/yaml.mjs';
import { REPO } from '../helpers.mjs';

const fails = (src, pattern) => assert.throws(() => parse(src), (err) => {
  assert.ok(err instanceof YAMLError, err.message);
  assert.match(err.message, pattern);
  return true;
});

describe('parse: supported syntax', () => {
  test('nested mappings, sequences and scalars', () => {
    const src = [
      '# leading comment',
      'name: Example   # trailing comment',
      'count: 12',
      'negative: -3',
      'zero: 0',
      'on_off: true',
      'nothing: null',
      'tilde: ~',
      'date: 2026-10-15',
      'version: 1.0.0',
      'url: https://example.com/a#b',
      'hash: not#a-comment',
      'empty_list: []',
      'empty_map: {}',
      'nested:',
      '  inner:',
      '    deep: x',
      '',
      '  other: why',
      'list:',
      '  - a',
      '  - "b c"',
      "  - 'it''s'",
      'same_indent_list:',
      '- one',
      '- two',
    ].join('\n');
    assert.deepEqual(parse(src), {
      name: 'Example', count: 12, negative: -3, zero: 0, on_off: true, nothing: null, tilde: null,
      date: '2026-10-15', version: '1.0.0', url: 'https://example.com/a#b', hash: 'not#a-comment',
      empty_list: [], empty_map: {}, nested: { inner: { deep: 'x' }, other: 'why' },
      list: ['a', 'b c', "it's"], same_indent_list: ['one', 'two'],
    });
  });

  test('sequences of mappings, nested sequences and items with nested blocks', () => {
    const src = [
      'items:',
      '  - id: a',
      '    tags:',
      '      - x',
      '  -   id: b',
      '      n: 2',
      '  -',
      '    - nested',
      '  -',
      '    k: v',
      '  - "quoted": yes-really',
    ].join('\n');
    assert.deepEqual(parse(src), {
      items: [{ id: 'a', tags: ['x'] }, { id: 'b', n: 2 }, ['nested'], { k: 'v' }, { quoted: 'yes-really' }],
    });
  });

  test('a top-level sequence', () => {
    assert.deepEqual(parse('- a\n- b: c\n'), ['a', { b: 'c' }]);
  });

  test('quoted keys and strings with escapes', () => {
    assert.deepEqual(parse('"a b": "line\\nnext \\"q\\" \\u00e9 \\\\ \\/"\n\'c:d\': \'x\' # c\n'), { 'a b': 'line\nnext "q" é \\ /', 'c:d': 'x' });
  });

  test('literal and folded block scalars', () => {
    const src = [
      'keep: |',
      '  line one',
      '    indented',
      '',
      '  # not a comment',
      'strip: |-',
      '  a',
      '  b',
      '',
      'folded: >',
      '  one',
      '  two',
      '',
      '  three',
      'folded_strip: >- # comment',
      '  x',
      '  y',
      'empty: |',
      'after: z',
    ].join('\n');
    assert.deepEqual(parse(src), {
      keep: 'line one\n  indented\n\n# not a comment\n',
      strip: 'a\nb',
      folded: 'one two\nthree\n',
      folded_strip: 'x y',
      empty: '',
      after: 'z',
    });
    assert.deepEqual(parse('- |\n  text\n- b'), ['text\n', 'b']);
  });

  test('BOM and CRLF line endings', () => {
    assert.deepEqual(parse('\uFEFFa: 1\r\nb: 2\r\n'), { a: 1, b: 2 });
  });
});

describe('parse: rejections', () => {
  test('structure', () => {
    fails('', /line 1: the document is empty/);
    fails('# only\n\n', /the document is empty/);
    fails('  a: 1', /line 1: the document must start at column 1/);
    fails('a: 1\n  b: 2', /line 2: unexpected indentation/);
    fails('a:\n  b: 1\n    c: 2', /line 3: unexpected indentation/);
    fails('- a\n  - b', /line 2: unexpected indentation/);
    fails('a: 1\na: 2', /line 2: duplicate key "a"/);
    fails('a:\nb: 1', /line 1: missing value/);
    fails('a:', /line 1: missing value/);
    fails('a: \n', /missing value/);
    fails('just text', /line 1: expected "key: value"/);
    fails('a:b', /expected "key: value"/);
    fails('"a"b: 1', /expected ": " after the key/);
    fails('"": 1', /empty key/);
    fails('a:\n\tb: 1', /line 2: tabs are not allowed/);
    fails('---\na: 1', /line 1: document markers/);
    fails('a: 1\n...', /line 2: document markers/);
    fails('%YAML 1.2\na: 1', /directives are not supported/);
  });

  test('unsupported features', () => {
    fails('a: &x 1', /anchors and aliases are not supported/);
    fails('a: *x', /anchors and aliases/);
    fails('&a b: 1', /anchors, aliases, tags and complex keys/);
    fails('? a\n: b', /expected "key: value"|complex keys/);
    fails('a: !tag x', /tags are not supported/);
    fails('a: [1, 2]', /flow collections are not supported/);
    fails('a: {b: 1}', /flow collections are not supported/);
    fails('a: |+\n  x', /block scalars support only/);
    fails('a: |2\n  x', /block scalars support only/);
    fails('a: |\n    x\n  y', /line 3: block text is indented less than its first line/);
    fails('a: |\n  x\n \ty', /tabs are not allowed/);
  });

  test('ambiguous plain scalars', () => {
    for (const word of ['yes', 'No', 'ON', 'off', 'y', 'N', 'True', 'FALSE', 'Null', 'NULL']) fails(`a: ${word}`, /is ambiguous in YAML/);
    for (const num of ['1.5', '1e3', '0x1f', '0o17', '0b101', '.inf', '-.5', '+1', '012', '1_000']) fails(`a: ${num}`, /looks like a number/);
    fails('a: 99999999999999999999', /too large; quote it/);
    fails('a: b: c', /contains ": "; quote it/);
    fails('a: b:', /contains ": "/);
    for (const s of ['@x', '`x', '%x', '|x', '>x', ',x', '#x']) assert.throws(() => parseScalar(s), YAMLError, s);
    fails('a: - x', /starts with a YAML indicator/);
  });

  test('quoted string errors', () => {
    fails('a: "open', /unterminated double-quoted string/);
    fails("a: 'open", /unterminated single-quoted string/);
    fails('a: "bad \\q"', /unsupported escape/);
    fails('a: "x" y', /unexpected text after a quoted string/);
    assert.equal(parse('a: "x"   # fine').a, 'x');
  });
});

describe('stringify', () => {
  test('writes plain values when safe and quotes otherwise', () => {
    const value = {
      s: 'plain text', d: '2026-10-15', u: 'https://x.y/z?a=b#c',
      yes: 'yes', num: '12', float: '1.5', colon: 'a: b', hash: 'a #b', lead: ' x', empty: '',
      multi: 'a\nb', special: '- x', quote: '"q"',
      t: true, f: false, n: null, i: 42, list: [], map: {},
      'odd key': 1, '1': 'numeric key',
    };
    const text = stringify(value);
    assert.deepEqual(parse(text), value);
    assert.ok(text.includes('s: plain text\n'));
    assert.ok(text.includes('d: 2026-10-15\n'));
    assert.ok(text.includes('"yes": "yes"\n'), 'ambiguous keys are quoted too');
    assert.ok(text.includes('num: "12"\n'));
    assert.ok(text.includes('"odd key": 1\n'));
    assert.ok(text.includes('"1": numeric key\n'));
    assert.ok(text.includes('list: []\nmap: {}\n'));
  });

  test('nests mappings and sequences', () => {
    const value = { a: { b: [1, { c: 'd', e: ['f'] }, [], {}, ['g', ['h']]] } };
    const text = stringify(value);
    assert.equal(text, 'a:\n  b:\n    - 1\n    - c: d\n      e:\n        - f\n    - []\n    - {}\n    -\n      - g\n      -\n        - h\n');
    assert.deepEqual(parse(text), value);
  });

  test('folds long prose and reads it back identically', () => {
    const long = 'word '.repeat(60).trim();
    const value = { notes: long, list: [long], short: 'word '.repeat(10).trim(), spaced: `a  ${long}` };
    const text = stringify(value);
    assert.match(text, /^notes: >-\n  word word/);
    assert.match(text, /\nlist:\n  - >-\n    word/);
    assert.ok(text.split('\n').filter((l) => !l.startsWith('spaced:')).every((l) => l.length <= 100), 'lines wrap at 100 columns');
    assert.ok(text.includes('short: word word'));
    assert.ok(text.includes('spaced: a  word'), 'double spaces stay plain but are not folded');
    assert.deepEqual(parse(text), value);
    assert.deepEqual(parse(stringify({ x: `${'y'.repeat(120)} z` })), { x: `${'y'.repeat(120)} z` });
  });

  test('rejects values outside the subset', () => {
    assert.throws(() => stringify(['a']), /top level must be a mapping/);
    assert.throws(() => stringify({ a: 1.5 }), /only safe integers/);
    assert.throws(() => stringify({ a: undefined }), /cannot write undefined/);
    assert.equal(stringify({}), '{}\n');
  });

  test('isPlainSafe', () => {
    for (const s of ['abc', 'a-b', '2026-01-01', 'https://x', 'a#b', 'x: y'.replace(': ', ':')]) assert.equal(isPlainSafe(s), true, s);
    for (const s of ['', ' a', 'a ', 'yes', '12', 'true', 'a: b', 'a #b', '[x', '- a', '-', 'a\nb', 'x:']) assert.equal(isPlainSafe(s), false, s);
  });

  test('every real entry and data file round-trips', () => {
    for (const dir of ['entries', 'data']) {
      for (const f of readdirSync(join(REPO, dir))) {
        const value = parse(readFileSync(join(REPO, dir, f), 'utf8'));
        assert.deepEqual(parse(stringify(value)), value, f);
      }
    }
  });
});

describe('setTopLevel', () => {
  const doc = [
    '# header comment',
    'slug: x',
    '# about verification',
    'verified_by: null',
    'verification:',
    '  status: needs-review # old',
    '  doc_hash: null',
    '',
    '# changelog comment',
    'changelog:',
    '  - version: 1.0.0 # keep me',
    '',
  ].join('\n');

  test('replaces keys and keeps every other line and comment', () => {
    const out = setTopLevel(doc, { verified_by: 'maint', verification: { status: 'ok', doc_hash: 'sha256:1' }, last_verified: '2026-06-01' });
    assert.equal(out, [
      '# header comment',
      'slug: x',
      '# about verification',
      'verified_by: maint',
      'verification:',
      '  status: ok',
      '  doc_hash: sha256:1',
      '',
      '# changelog comment',
      'changelog:',
      '  - version: 1.0.0 # keep me',
      'last_verified: 2026-06-01',
      '',
    ].join('\n'));
  });

  test('replaces the last key in a file and quoted keys', () => {
    assert.equal(setTopLevel('a: 1\nb:\n  - x\n  - y\n', { b: [] }), 'a: 1\nb: []\n');
    assert.equal(setTopLevel('"a b": 1\n', { 'a b': 2 }), '"a b": 2\n');
    assert.equal(setTopLevel('a: 1\r\nb: 2\r\n', { a: 3 }), 'a: 3\nb: 2\n');
  });

  test('quotes awkward keys and refuses to write an unreadable document', () => {
    assert.equal(setTopLevel('a: 1\n', { 'b: c': 1 }), 'a: 1\n"b: c": 1\n');
    assert.throws(() => setTopLevel('a: [1]\n', { b: 1 }), YAMLError);
  });
});

describe('edge cases', () => {
  test('leftover lines after the top-level block', () => {
    fails('a: 1\n- b', /line 2: a document holds one mapping or one list, not both/);
    fails('- a\nb: 1', /line 2: a document holds one mapping or one list, not both/);
    fails('a:\n  - x\n    y: 1', /line 3: unexpected indentation/);
  });

  test('parseScalar reports line 1 by default and rejects an empty value', () => {
    assert.throws(() => parseScalar('yes'), /^YAMLError: line 1: /);
    assert.throws(() => parseScalar('yes', 7), /^YAMLError: line 7: /);
    assert.throws(() => parseScalar(''), /missing value: write null, "" or \[\]/);
  });

  test('list items: empty items, quoted keys and quoted values with colons', () => {
    fails('-\n- a', /line 1: missing value/);
    assert.deepEqual(parse("- 'k': v\n- \"k2\": 2\n- \"a: b\"\n- 'c: d'"), [{ k: 'v' }, { k2: 2 }, 'a: b', 'c: d']);
    fails('- "unterminated', /unterminated double-quoted string/);
    assert.deepEqual(parse('a: # nested below\n  b: 1'), { a: { b: 1 } });
    assert.deepEqual(parse('- # nested below\n  - x'), [['x']]);
  });

  test('isPlainSafe rejects line breaks', () => {
    assert.equal(isPlainSafe('a\rb'), false);
    assert.equal(isPlainSafe('a\tb'), true, 'a tab inside a value reads back unchanged');
    assert.deepEqual(parse(stringify({ t: 'a\tb', r: 'a\rb' })), { t: 'a\tb', r: 'a\rb' });
  });

  test('folding starts above 80 characters and wraps at 100 columns', () => {
    const words = (n) => Array.from({ length: n }, () => 'abcd').join(' ');
    const at80 = words(16); // 16 * 5 - 1 = 79 characters
    assert.equal(stringify({ k: `${at80}x` }), `k: ${at80}x\n`, '80 characters stay on one line');
    assert.match(stringify({ k: `${at80}xy` }), /^k: >-\n/, '81 characters fold');
    // At indent 2 a folded line may hold 98 characters.
    const line98 = 'x'.repeat(98);
    const two = `${line98} y`;
    assert.equal(stringify({ k: two }), `k: >-\n  ${line98}\n  y\n`);
    const line97 = `${'x'.repeat(96)} z`;
    assert.equal(stringify({ k: `${line97} q` }), `k: >-\n  ${line97}\n  q\n`);
    assert.equal(stringify({ k: `${'x'.repeat(95)} zz q` }), `k: >-\n  ${'x'.repeat(95)} zz\n  q\n`, 'exactly 98 fits');
  });

  test('setTopLevel trims blank lines before the next key and escapes regex characters in keys', () => {
    assert.equal(setTopLevel('a:\n  - x\n\n\nb: 1\n', { a: 2 }), 'a: 2\n\n\nb: 1\n');
    assert.equal(setTopLevel('a:\n  - x\n\n', { a: 2 }), 'a: 2\n\n', 'blank lines outside the block are kept');
    assert.equal(setTopLevel('axb: 1\na.b: 2\n', { 'a.b': 3 }), 'axb: 1\na.b: 3\n');
    assert.equal(setTopLevel('a:\n  # inside\n  b: 1\n# outside\nc: 1\n', { a: 0 }), 'a: 0\n# outside\nc: 1\n');
  });
});
