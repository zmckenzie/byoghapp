// Fuzz target for the strict YAML subset (scripts/lib/yaml.mjs), which parses
// every contributed entry. For any input, parse must either succeed or throw a
// YAMLError, and a parsed mapping (the shape of every entry and data file; stringify
// writes only mappings) must survive a stringify/parse round trip.
//
// Run with Jazzer.js (npm run fuzz:yaml) or ClusterFuzzLite (.clusterfuzzlite/).
// test/fuzz/targets.test.mjs runs it over the seed corpus on every `npm test`.

import { deepStrictEqual } from 'node:assert/strict';
import { parse, stringify, YAMLError } from '../scripts/lib/yaml.mjs';

/**
 * @param {Buffer} data
 * @returns {'rejected' | 'skipped' | 'checked'} what happened, for the unit tests
 */
export function fuzz(data) {
  let value;
  try {
    value = parse(data.toString('utf8'));
  } catch (err) {
    if (err instanceof YAMLError) return 'rejected';
    throw err;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'skipped';
  deepStrictEqual(parse(stringify(value)), value);
  return 'checked';
}
