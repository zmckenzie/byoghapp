// V8 block coverage, as produced by Chrome's DevTools Profiler and by Node's
// NODE_V8_COVERAGE: which characters of a file ran, and line coverage from that.
// Used by the browser tests (coverage of site/app.js and site/callback.js) and
// by mutation testing (which tests execute each mutant).

import { readdirSync, readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Executed-character mask for one script from V8 block coverage. Ranges are
 * nested and listed outer-first, so later (inner) ranges override earlier ones.
 */
export function executedMask(source, functions) {
  const counts = new Int32Array(source.length).fill(-1);
  for (const fn of functions) {
    for (const range of fn.ranges) counts.fill(range.count, range.startOffset, Math.min(range.endOffset, source.length));
  }
  return Uint8Array.from(counts, (c) => (c > 0 ? 1 : 0));
}

/** Lines that contain code (not blank, not only comments or closing brackets). */
export function codeLines(source) {
  const lines = source.split('\n');
  let inBlockComment = false;
  return lines.map((raw) => {
    let line = raw.trim();
    if (inBlockComment) {
      if (!line.includes('*/')) return false;
      inBlockComment = false;
      line = line.slice(line.indexOf('*/') + 2).trim();
    }
    if (line.startsWith('/*') && !line.includes('*/')) {
      inBlockComment = true;
      return false;
    }
    return line !== '' && !line.startsWith('//') && !/^[\])};,]+$/.test(line);
  });
}

/** Line coverage of a source given merged masks. */
export function lineCoverage(source, mask) {
  const isCode = codeLines(source);
  const uncovered = [];
  let offset = 0;
  let total = 0;
  source.split('\n').forEach((line, i) => {
    if (isCode[i]) {
      total += 1;
      let hit = false;
      for (let k = 0; k < line.length; k += 1) {
        if (!/\s/.test(line[k]) && mask[offset + k]) {
          hit = true;
          break;
        }
      }
      if (!hit) uncovered.push(i + 1);
    }
    offset += line.length + 1;
  });
  return { total, covered: total - uncovered.length, percent: total === 0 ? 100 : ((total - uncovered.length) / total) * 100, uncovered };
}

/**
 * Reads a NODE_V8_COVERAGE directory and returns executed-character masks for
 * the given sources: Map<repo-relative path, Uint8Array>. Every process that
 * wrote coverage (child processes included) is merged.
 * @param {string} dir coverage directory
 * @param {string} root directory the paths are relative to
 * @param {Map<string, string>} sources repo-relative path -> source text
 */
export function readCoverageDir(dir, root, sources) {
  const masks = new Map();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const { result } = JSON.parse(readFileSync(`${dir}/${name}`, 'utf8'));
    for (const script of result) {
      if (!script.url.startsWith('file://')) continue;
      const path = relative(root, fileURLToPath(script.url)).split(sep).join('/');
      const source = sources.get(path);
      if (source === undefined) continue;
      const mask = executedMask(source, script.functions);
      const merged = masks.get(path) ?? new Uint8Array(source.length);
      for (let i = 0; i < mask.length; i += 1) merged[i] |= mask[i];
      masks.set(path, merged);
    }
  }
  return masks;
}

/** Accumulates coverage snapshots for URLs ending with the given paths. */
export class CoverageCollector {
  constructor(paths, readSource) {
    this.paths = paths;
    this.readSource = readSource;
    this.masks = new Map();
  }

  add(result) {
    for (const script of result) {
      const path = this.paths.find((p) => script.url.split('?')[0].endsWith(`/${p}`));
      if (!path) continue;
      const source = this.readSource(path);
      const mask = executedMask(source, script.functions);
      const merged = this.masks.get(path) ?? new Uint8Array(source.length);
      for (let i = 0; i < mask.length; i += 1) merged[i] |= mask[i];
      this.masks.set(path, merged);
    }
  }

  report() {
    return this.paths.map((path) => {
      const source = this.readSource(path);
      return { path, ...lineCoverage(source, this.masks.get(path) ?? new Uint8Array(source.length)) };
    });
  }
}
