// Runs the fuzz targets over their seed inputs and over every input a fuzzing
// run has turned up, so `npm test` keeps them passing without Jazzer.js.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fuzz as fuzzYaml } from '../../fuzz/fuzz_yaml.js';
import { RENDER_TAGS, fuzz as fuzzRender, htmlProblems } from '../../fuzz/fuzz_render.js';
import { stringify } from '../../scripts/lib/yaml.mjs';
import { REPO, makeEntry, makeWebhookEntry } from '../helpers.mjs';

const seeds = (dir) => readdirSync(join(REPO, dir)).map((f) => readFileSync(join(REPO, dir, f)));
const bytes = (text) => Buffer.from(text, 'utf8');
const unreadable = { toString() { throw new TypeError('not text'); } };

// Inputs fuzzing found; each once crashed fuzz_yaml.js.
const FOUND = [
  '"\0\0\0ma\x84x\0"  -l_steps:\n  -  ~', // raw control character in a quoted key
  '__proto__: s!', // dropped key, then an unparseable round trip
  '__proto__:\n  slug: evil\nname: x', // prototype set from the document
  'r{ : -0\n\n', // -0 written back as 0
  '# y_id\n-  p riva\0erific', // top-level list (now rejected for its NUL)
  'eed:\n- "\uFFFD,a\\b" ', // escaped control character written back unquoted
];

describe('fuzz_yaml', () => {
  test('passes the seed corpus: every entry and data file', () => {
    for (const data of [...seeds('entries'), ...seeds('data')]) assert.equal(fuzzYaml(data), 'checked');
  });

  test('passes every input fuzzing has found', () => {
    assert.deepEqual(FOUND.map((input) => fuzzYaml(bytes(input))), ['rejected', 'rejected', 'rejected', 'checked', 'rejected', 'checked']);
  });

  test('round-trips mappings and skips other documents', () => {
    assert.equal(fuzzYaml(bytes('a: "x\\ty"\nb:\n  - -0\n  - {}\n')), 'checked');
    assert.equal(fuzzYaml(bytes('{}')), 'checked');
    assert.equal(fuzzYaml(bytes('- a\n- b')), 'skipped');
    assert.equal(fuzzYaml(bytes('[]')), 'skipped');
    assert.equal(fuzzYaml(bytes('a: [1]')), 'rejected');
  });

  test('errors other than YAMLError are failures', () => {
    assert.throws(() => fuzzYaml(unreadable), /not text/);
  });
});

describe('fuzz_render', () => {
  test('passes the seed corpus: every entry', () => {
    for (const data of seeds('entries')) assert.equal(fuzzRender(data), 'checked');
  });

  test('renders valid entries carrying markup in their text', () => {
    const xss = '<script>alert(1)</script> "><img src=x onerror=alert(1)> \' javascript:alert(1)';
    assert.equal(fuzzRender(bytes(stringify(makeEntry({ notes: xss, manual_steps: [xss] })))), 'checked');
    assert.equal(fuzzRender(bytes(stringify(makeWebhookEntry({ name: xss })))), 'checked');
    // Dates are checked against a far-future "today", so recent entries render.
    assert.equal(fuzzRender(bytes(stringify(makeEntry({ last_verified: '2098-01-01', verified_by: 'zmckenzie', verification: { status: 'ok', method: 'doc-hash', doc_hash: null } })))), 'checked');
  });

  test('skips inputs that are not valid entries', () => {
    const inherited = stringify(makeEntry({ manifest: { default_permissions: { constructor: 'read' } } })); // once crashed the validator
    assert.deepEqual(FOUND.map((input) => fuzzRender(bytes(input))), ['rejected', 'rejected', 'rejected', 'skipped', 'rejected', 'skipped']);
    for (const input of ['- a', '[]', 'a: 1', stringify(makeEntry({ category: 'nope' })), inherited]) {
      assert.equal(fuzzRender(bytes(input)), 'skipped', input);
    }
    assert.equal(fuzzRender(bytes('a: [1]')), 'rejected');
    assert.throws(() => fuzzRender(unreadable), /not text/);
  });

  test('RENDER_TAGS lists the tags render.js writes', () => {
    for (const tag of ['a', 'p', 'table', 'details', 'code']) assert.ok(RENDER_TAGS.has(tag), tag);
    for (const tag of ['script', 'img', 'style', 'iframe']) assert.ok(!RENDER_TAGS.has(tag), tag);
  });

  test('htmlProblems flags foreign tags, handlers and unsafe links', () => {
    assert.deepEqual(htmlProblems('<p><a href="#/entry/x">a</a> <a href="https://x.test/">b</a></p>'), []);
    assert.deepEqual(htmlProblems('<p>&lt;script&gt; onclick=x</p>'), []);
    assert.deepEqual(htmlProblems('<p title="a onclick=b">'), []);
    assert.deepEqual(htmlProblems('<script>x</script>'), ['unexpected tag <script>', 'unexpected tag <script>']);
    assert.deepEqual(htmlProblems('<IMG src=x>'), ['unexpected tag <IMG>']);
    assert.deepEqual(htmlProblems('<p onclick="x">'), ['event-handler attribute onclick=']);
    assert.deepEqual(htmlProblems('<p\tONLOAD = "x">'), ['event-handler attribute ONLOAD =']);
    assert.deepEqual(htmlProblems('<a href="javascript:alert(1)">'), ['unsafe link javascript:alert(1)']);
    assert.deepEqual(htmlProblems('<a href="http://x.test/">'), ['unsafe link http://x.test/']);
    assert.deepEqual(htmlProblems('<a href="">'), ['unsafe link ']);
    assert.deepEqual(htmlProblems('<p>x</p><script'), ['unexpected tag <script>']);
  });
});
