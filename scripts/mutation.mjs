#!/usr/bin/env node
// Mutation testing: makes small deliberate bugs ("mutants") in the source and
// checks that the unit tests fail for each one. A surviving mutant means a
// behaviour no test pins down. Zero dependencies; see scripts/lib/mutation.mjs.
//
//   node scripts/mutation.mjs                        all files, fails below the threshold
//   node scripts/mutation.mjs --changed origin/main  only files changed since a ref
//   node scripts/mutation.mjs --file site/lib/risk.js --threshold 90 --report mutation.json

import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { applyMutant, generateMutants, importClosure, mutationScore } from './lib/mutation.mjs';
import { ROOT, git } from './lib/repo.mjs';

export const DEFAULT_THRESHOLD = 80;
const SOURCE_DIRS = ['scripts', 'scripts/lib', 'site/lib'];
const EXCLUDED = new Set(['scripts/mutation.mjs']);
const TEST_DIRS = ['test/scripts', 'test/site'];

function listFiles(root, dir, pattern) {
  try {
    return readdirSync(join(root, dir), { withFileTypes: true })
      .filter((d) => d.isFile() && pattern.test(d.name))
      .map((d) => `${dir}/${d.name}`);
  } catch {
    return [];
  }
}

/** Source files under mutation, repo-relative. */
export function sourceFiles(root = ROOT) {
  return SOURCE_DIRS.flatMap((d) => listFiles(root, d, /\.(mjs|js)$/)).filter((f) => !EXCLUDED.has(f)).sort();
}

/** Unit test files, repo-relative. */
export function testFiles(root = ROOT) {
  return TEST_DIRS.flatMap((d) => listFiles(root, d, /\.test\.mjs$/)).sort();
}

/** Script paths a test runs as child processes: runScript('x'), runScriptAsync('x') or join(REPO, 'x'). */
export function scriptsRunBy(testSource) {
  return [...testSource.matchAll(/\b(?:runScript|runScriptAsync)\(\s*'([^']+)'|\bjoin\(REPO,\s*'([^']+\.m?js)'\)/g)].map((m) => m[1] ?? m[2]);
}

/**
 * Tests that exercise a source file: those that import it (directly or
 * transitively) or run it, or a script that imports it, as a child process.
 */
export function testsFor(source, tests, root = ROOT, read = (p) => readFileSync(p, 'utf8')) {
  const abs = resolve(root, source);
  return tests.filter((t) => {
    const path = resolve(root, t);
    if (importClosure(path, read).has(abs)) return true;
    return scriptsRunBy(read(path)).some((script) => importClosure(resolve(root, script), read).has(abs));
  });
}

/** Runs node --test on the given files; resolves to {passed, timedOut, ms}. */
function runTests(cwd, tests, timeoutMs) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const env = { ...process.env };
    // Run as a top-level test process even when started from inside node --test.
    delete env.NODE_V8_COVERAGE;
    delete env.NODE_TEST_CONTEXT;
    // Own process group, so a timeout also kills the test files node --test started.
    const child = spawn(process.execPath, ['--test', '--test-reporter=dot', ...tests], { cwd, env, stdio: 'ignore', detached: true });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ passed: code === 0, timedOut: signal === 'SIGKILL', ms: Date.now() - started });
    });
  });
}

function makeSandbox(root) {
  const dir = mkdtempSync(join(tmpdir(), 'byoghapp-mutation-'));
  cpSync(root, dir, { recursive: true, filter: (src) => !/[/\\](\.git|node_modules|coverage)$/.test(src) });
  return dir;
}

/**
 * Runs mutation testing.
 * @returns {Promise<{files: object[], killed: number, survived: number, score: number, survivors: object[]}>}
 */
export async function runMutation({ root = ROOT, files, concurrency = Math.max(1, availableParallelism() - 1), log = () => {} } = {}) {
  const tests = testFiles(root);
  const plan = (files ?? sourceFiles(root)).map((source) => ({ source, tests: testsFor(source, tests, root), src: readFileSync(join(root, source), 'utf8') }));
  const sandboxes = Array.from({ length: concurrency }, () => makeSandbox(root));
  try {
    // Baseline: every test set must pass unmutated, and sets the per-file timeout.
    for (const p of plan) {
      if (p.tests.length === 0) continue;
      const base = await runTests(sandboxes[0], p.tests, 120_000);
      if (!base.passed) throw new Error(`Tests for ${p.source} fail without any mutation: fix them first (${p.tests.join(', ')})`);
      p.timeoutMs = Math.max(10_000, base.ms * 3 + 5_000);
    }
    const queue = plan.flatMap((p) => generateMutants(p.src).map((m) => ({ ...m, file: p })));
    const results = [];
    let done = 0;
    await Promise.all(sandboxes.map(async (dir) => {
      while (queue.length > 0) {
        const mutant = queue.shift();
        const { file } = mutant;
        let status = 'survived';
        if (file.tests.length > 0) {
          const target = join(dir, file.source);
          writeFileSync(target, applyMutant(file.src, mutant));
          try {
            const r = await runTests(dir, file.tests, file.timeoutMs);
            if (r.timedOut) status = 'timeout';
            else if (!r.passed) status = 'killed';
          } finally {
            writeFileSync(target, file.src);
          }
        } else {
          status = 'no-tests';
        }
        results.push({ source: file.source, line: mutant.line, operator: mutant.operator, original: mutant.original, replacement: mutant.replacement, status });
        done += 1;
        if (done % 25 === 0) log(`${done} mutants tested, ${queue.length} left`);
      }
    }));
    return summarize(plan.map((p) => p.source), results);
  } finally {
    for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  }
}

/** Aggregates per-mutant results. Timeouts count as killed: the tests noticed. */
export function summarize(sources, results) {
  const files = sources.map((source) => {
    const rs = results.filter((r) => r.source === source);
    const killed = rs.filter((r) => r.status === 'killed' || r.status === 'timeout').length;
    const survived = rs.length - killed;
    return { source, total: rs.length, killed, survived, score: mutationScore({ killed, survived }) };
  });
  const killed = files.reduce((n, f) => n + f.killed, 0);
  const survived = files.reduce((n, f) => n + f.survived, 0);
  const survivors = results.filter((r) => r.status === 'survived' || r.status === 'no-tests')
    .sort((a, b) => a.source.localeCompare(b.source) || a.line - b.line);
  return { files, killed, survived, score: mutationScore({ killed, survived }), survivors };
}

/** Human-readable report. */
export function formatReport(summary, threshold) {
  const lines = ['', 'Mutation testing', '', 'score   killed/total  file'];
  for (const f of summary.files) lines.push(`${f.score.toFixed(1).padStart(5)}%  ${String(f.killed).padStart(6)}/${String(f.total).padEnd(5)}  ${f.source}`);
  lines.push('', `Overall: ${summary.score.toFixed(1)}% (${summary.killed} killed, ${summary.survived} survived), threshold ${threshold}%`);
  if (summary.survivors.length > 0) {
    lines.push('', 'Surviving mutants (no test failed):');
    for (const s of summary.survivors) {
      lines.push(`  ${s.source}:${s.line}  ${s.operator}  ${JSON.stringify(s.original)} -> ${JSON.stringify(s.replacement)}${s.status === 'no-tests' ? '  (no tests import this file)' : ''}`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      file: { type: 'string', multiple: true },
      changed: { type: 'string' },
      threshold: { type: 'string' },
      concurrency: { type: 'string' },
      report: { type: 'string' },
    },
  });
  let files = values.file;
  if (values.changed) {
    const out = git(['diff', '--name-only', `${values.changed}...HEAD`]) ?? '';
    const all = new Set(sourceFiles());
    files = out.split('\n').filter((f) => all.has(f));
    if (files.length === 0) {
      console.log('No mutable source files changed.');
      return;
    }
  }
  const threshold = Number(values.threshold ?? DEFAULT_THRESHOLD);
  const summary = await runMutation({
    files,
    concurrency: values.concurrency ? Number(values.concurrency) : undefined,
    log: (m) => console.error(m),
  });
  console.log(formatReport(summary, threshold));
  if (values.report) writeFileSync(values.report, `${JSON.stringify(summary, null, 2)}\n`);
  if (summary.score < threshold) {
    console.error(`\nMutation score ${summary.score.toFixed(1)}% is below the ${threshold}% threshold: add tests that kill the surviving mutants.`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

