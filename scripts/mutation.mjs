#!/usr/bin/env node
// Mutation testing: makes small deliberate bugs ("mutants") in the source and
// checks that the unit tests fail for each one. A surviving mutant means a
// behaviour no test pins down. Zero dependencies; see scripts/lib/mutation.mjs.
//
// Every test case runs once, alone, with V8 coverage first. Each mutant then
// runs only the test cases that execute its position: the fastest one first,
// then the rest grouped by file, stopping at the first failure.
//
//   node scripts/mutation.mjs                        all files, fails below the threshold
//   node scripts/mutation.mjs --changed origin/main  only files changed since a ref
//   node scripts/mutation.mjs --file site/lib/risk.js --threshold 90 --report mutation.json

import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const REPORTER = fileURLToPath(new URL('./lib/test-list-reporter.mjs', import.meta.url));

/** A regular expression matching exactly one test path for --test-name-pattern. */
export function namePattern(path) {
  return `^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

/**
 * Runs one test file with plain `node` (no --test wrapper process), optionally
 * limited to some test cases, in its own process group so a timeout also kills
 * anything the tests started.
 * @param {{patterns?: string[], env?: object, args?: string[]}} options
 * @returns {Promise<{passed: boolean, timedOut: boolean, ms: number}>}
 */
export function runTests(cwd, file, timeoutMs, { patterns = [], env: extraEnv = {}, args = [] } = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const env = { ...process.env };
    delete env.NODE_V8_COVERAGE;
    delete env.NODE_TEST_CONTEXT;
    Object.assign(env, extraEnv);
    const flags = [...args, ...patterns.map((p) => `--test-name-pattern=${p}`)];
    const child = spawn(process.execPath, [...flags, file], { cwd, env, stdio: 'ignore', detached: true });
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

/** The test cases in each file, from one run per file with the test-list reporter. */
export async function listTestCases(sandboxes, files) {
  const cases = [];
  await pool(sandboxes, files, async (dir, file) => {
    const out = join(mkdtempSync(join(tmpdir(), 'byoghapp-list-')), 'cases.jsonl');
    try {
      const run = await runTests(dir, file, 300_000, { args: [`--test-reporter=${REPORTER}`, `--test-reporter-destination=${out}`] });
      const lines = readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const failed = lines.filter((l) => !l.passed);
      if (!run.passed || failed.length > 0) {
        throw new Error(`${file} fails without any mutation: fix it first${failed.length ? ` (${failed.map((f) => f.path).join('; ')})` : ''}`);
      }
      for (const { path } of lines) cases.push({ file, path });
    } finally {
      rmSync(dirname(out), { recursive: true, force: true });
    }
  });
  return cases.sort((a, b) => a.file.localeCompare(b.file) || a.path.localeCompare(b.path));
}

/**
 * Runs every test case once, alone, with V8 coverage (child processes
 * included). Returns, fastest first, each case's duration and which characters
 * of each source it executed.
 */
export async function profileTests(sandboxes, cases, sources) {
  const profiles = [];
  await pool(sandboxes, cases, async (dir, testCase) => {
    const covDir = mkdtempSync(join(tmpdir(), 'byoghapp-cov-'));
    try {
      const run = await runTests(dir, testCase.file, 300_000, { patterns: [namePattern(testCase.path)], env: { NODE_V8_COVERAGE: covDir } });
      if (!run.passed) throw new Error(`"${testCase.path}" in ${testCase.file} fails when run alone: make it independent of other tests`);
      profiles.push({ ...testCase, ms: run.ms, masks: readCoverageDir(covDir, dir, sources) });
    } finally {
      rmSync(covDir, { recursive: true, force: true });
    }
  });
  return profiles.sort((a, b) => a.ms - b.ms || a.file.localeCompare(b.file) || a.path.localeCompare(b.path));
}

/** The profiled test cases that execute a mutant's position, fastest first. */
export function testsCovering(profiles, source, offset) {
  return profiles.filter((p) => p.masks.get(source)?.[offset] === 1);
}

/**
 * The runs that test one mutant, in order: the single fastest covering case
 * first (it kills most mutants), then the remaining cases grouped by file,
 * fastest file first. Each run is {file, patterns, timeoutMs}.
 */
export function planRuns(covering) {
  if (covering.length === 0) return [];
  const timeout = (ms) => Math.max(5_000, ms * 3 + 2_000);
  const [first, ...rest] = covering;
  const runs = [{ file: first.file, patterns: [namePattern(first.path)], timeoutMs: timeout(first.ms) }];
  const byFile = new Map();
  for (const c of rest) {
    const group = byFile.get(c.file) ?? { file: c.file, patterns: [], ms: 0 };
    group.patterns.push(namePattern(c.path));
    group.ms += c.ms;
    byFile.set(c.file, group);
  }
  for (const g of [...byFile.values()].sort((a, b) => a.ms - b.ms)) runs.push({ file: g.file, patterns: g.patterns, timeoutMs: timeout(g.ms) });
  return runs;
}

/**
 * Runs mutation testing. Each mutant runs only the test cases whose coverage
 * includes it (see planRuns), stopping at the first failure.
 * @returns {Promise<{files: object[], killed: number, survived: number, score: number, survivors: object[]}>}
 */
export async function runMutation({ root = ROOT, files, concurrency = availableParallelism(), log = () => {} } = {}) {
  const plan = (files ?? sourceFiles(root)).map((source) => ({ source, src: readFileSync(join(root, source), 'utf8') }));
  const sources = new Map(plan.map((p) => [p.source, p.src]));
  const sandboxes = Array.from({ length: concurrency }, () => makeSandbox(root));
  try {
    const cases = await listTestCases(sandboxes, testFiles(root));
    log(`Profiling ${cases.length} test cases with coverage…`);
    const profiles = await profileTests(sandboxes, cases, sources);
    const mutants = plan.flatMap((p) => generateMutants(p.src).map((m) => ({ ...m, file: p })));
    log(`Testing ${mutants.length} mutants in ${sandboxes.length} sandboxes…`);
    const results = [];
    await pool(sandboxes, mutants, async (dir, mutant) => {
      const { file } = mutant;
      const runs = planRuns(testsCovering(profiles, file.source, mutant.start));
      let status = runs.length === 0 ? 'no-coverage' : 'survived';
      if (runs.length > 0) {
        const target = join(dir, file.source);
        writeFileSync(target, applyMutant(file.src, mutant));
        try {
          for (const run of runs) {
            const result = await runTests(dir, run.file, run.timeoutMs, { patterns: run.patterns });
            if (result.timedOut) status = 'timeout';
            else if (!result.passed) status = 'killed';
            if (status !== 'survived') break;
          }
        } finally {
          writeFileSync(target, file.src);
        }
      }
      results.push({ source: file.source, line: mutant.line, operator: mutant.operator, original: mutant.original, replacement: mutant.replacement, status });
      if (results.length % 100 === 0) log(`${results.length}/${mutants.length} mutants tested`);
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

