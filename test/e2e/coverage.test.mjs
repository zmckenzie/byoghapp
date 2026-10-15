// The browser coverage maths, tested without a browser.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CoverageCollector, codeLines, executedMask, lineCoverage } from './coverage.mjs';

const SRC = 'function f(x) {\n  if (x) {\n    return 1;\n  }\n  return 2;\n}\n// note\nf(true);\n';
// V8 reports the whole script, then the function, then the never-taken tail.
const ranOnlyTrueBranch = [
  { ranges: [{ startOffset: 0, endOffset: SRC.length, count: 1 }] },
  { ranges: [{ startOffset: 0, endOffset: 58, count: 1 }, { startOffset: SRC.indexOf('  return 2'), endOffset: SRC.indexOf('}\n//'), count: 0 }] },
];

describe('browser coverage maths', () => {
  test('codeLines skips blanks, comments and closing brackets', () => {
    assert.deepEqual(codeLines('a();\n\n// c\n/* d\n e */ x();\n});\n/* one */ y();'), [true, false, false, false, true, false, true]);
  });

  test('inner zero-count ranges override outer ranges', () => {
    const mask = executedMask(SRC, ranOnlyTrueBranch);
    const report = lineCoverage(SRC, mask);
    assert.deepEqual(report.uncovered, [5]);
    assert.equal(report.total, 5);
    assert.equal(report.covered, 4);
    assert.equal(report.percent, 80);
  });

  test('an unexecuted script is uncovered and empty sources are complete', () => {
    assert.equal(lineCoverage(SRC, new Uint8Array(SRC.length)).percent, 0);
    assert.equal(lineCoverage('', new Uint8Array(0)).percent, 100);
  });

  test('the collector merges snapshots by URL suffix', () => {
    const collector = new CoverageCollector(['a.js', 'b.js'], () => SRC);
    collector.add([{ url: 'http://x/a.js?v=1', functions: ranOnlyTrueBranch }, { url: 'http://x/other.js', functions: [] }]);
    const full = [{ ranges: [{ startOffset: 0, endOffset: SRC.length, count: 1 }] }];
    collector.add([{ url: 'http://x/a.js', functions: full }]);
    const [a, b] = collector.report();
    assert.equal(a.percent, 100);
    assert.equal(b.percent, 0);
  });
});
