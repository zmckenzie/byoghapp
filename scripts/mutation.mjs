#!/usr/bin/env node
// Mutation testing: makes small deliberate bugs ("mutants") in the source and
// checks that the unit tests fail for each one. A surviving mutant means a
// behaviour no test pins down. Zero dependencies; see scripts/lib/mutation.mjs.
//
// Each test file runs once with V8 coverage first; every mutant then runs only
// the test files that execute its position, fastest first, stopping at the
// first failure.
//
//   node scripts/mutation.mjs                        all files, fails below the threshold
//   node scripts/mutation.mjs --changed origin/main  only files changed since a ref
//   node scripts/mutation.mjs --file site/lib/risk.js --threshold 90 --report mutation.json

import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readCoverageDir } from './lib/coverage.mjs';
import { applyMutant, generateMutants, mutationScore } from './lib/mutation.mjs';
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

/**
 * Runs node --test on one or more files as a top-level process in its own
 * process group (so a timeout also kills the test files it started).
 * @returns {Promise<{passed: boolean, timedOut: boolean, ms: number}>}
 */
export function runTests(cwd, tests, timeoutMs, extraEnv = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const env = { ...process.env };
    delete env.NODE_V8_COVERAGE;
    delete env.NODE_TEST_CONTEXT;
    Object.assign(env, extraEnv);
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
  return realpathSync(dir);
}

/** Runs async jobs with one sandbox each, `sandboxes.length` at a time. */
async function pool(sandboxes, jobs, worker) {
  const queue = [...jobs];
  await Promise.all(sandboxes.map(async (dir) => {
    while (queue.length > 0) await worker(dir, queue.shift());
  }));
}

/**
 * Runs every test file once, unmutated, with V8 coverage (child processes
 * included). Returns, fastest first, each test's duration and which characters
 * of each source it executed.
 */
export async function profileTests(sandboxes, tests, sources) {
  const profiles = [];
  await pool(sandboxes, tests, async (dir, test) => {
    const covDir = mkdtempSync(join(tmpdir(), 'byoghapp-cov-'));
    try {
      const run = await runTests(dir, [test], 300_000, { NODE_V8_COVERAGE: covDir });
      if (!run.passed) throw new Error(`${test} fails without any mutation: fix it first`);
      profiles.push({ test, ms: run.ms, masks: readCoverageDir(covDir, dir, sources) });
    } finally {
      rmSync(covDir, { recursive: true, force: true });
    }
  });
  return profiles.sort((a, b) => a.ms - b.ms || a.test.localeCompare(b.test));
}

/** The profiled tests that execute a mutant's position, fastest first. */
export function testsCovering(profiles, source, offset) {
  return profiles.filter((p) => p.masks.get(source)?.[offset] === 1);
}

/**
 * Runs mutation testing. Each mutant runs only the tests whose coverage
 * includes it, fastest first, stopping at the first failure.
 * @returns {Promise<{files: object[], killed: number, survived: number, score: number, survivors: object[]}>}
 */
export async function runMutation({ root = ROOT, files, concurrency = Math.max(1, availableParallelism() - 1), log = () => {} } = {}) {
  const plan = (files ?? sourceFiles(root)).map((source) => ({ source, src: readFileSync(join(root, source), 'utf8') }));
  const sources = new Map(plan.map((p) => [p.source, p.src]));
  const sandboxes = Array.from({ length: concurrency }, () => makeSandbox(root));
  try {
    log(`Profiling ${testFiles(root).length} test files with coverage…`);
    const profiles = await profileTests(sandboxes, testFiles(root), sources);
    const mutants = plan.flatMap((p) => generateMutants(p.src).map((m) => ({ ...m, file: p })));
    log(`Testing ${mutants.length} mutants in ${sandboxes.length} sandboxes…`);
    const results = [];
    await pool(sandboxes, mutants, async (dir, mutant) => {
      const { file } = mutant;
      const covering = testsCovering(profiles, file.source, mutant.start);
      let status = covering.length === 0 ? 'no-coverage' : 'survived';
      if (covering.length > 0) {
        const target = join(dir, file.source);
        writeFileSync(target, applyMutant(file.src, mutant));
        try {
          for (const profile of covering) {
            const run = await runTests(dir, [profile.test], Math.max(5_000, profile.ms * 3 + 3_000));
            if (run.timedOut) status = 'timeout';
            else if (!run.passed) status = 'killed';
            if (status !== 'survived') break;
          }
        } finally {
          writeFileSync(target, file.src);
        }
      }
      results.push({ source: file.source, line: mutant.line, operator: mutant.operator, original: mutant.original, replacement: mutant.replacement, status });
      if (results.length % 50 === 0) log(`${results.length}/${mutants.length} mutants tested`);
    });
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
  const survivors = results.filter((r) => r.status === 'survived' || r.status === 'no-coverage')
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
      lines.push(`  ${s.source}:${s.line}  ${s.operator}  ${JSON.stringify(s.original)} -> ${JSON.stringify(s.replacement)}${s.status === 'no-coverage' ? '  (no test runs this code)' : ''}`);
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

