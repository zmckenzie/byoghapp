// Shared test fixtures. Tests build small entries and throwaway repositories
// here instead of depending on the real entries, so changing an entry never
// breaks a test.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** A valid entry; pass overrides (shallow, plus `manifest` merged one level). */
export function makeEntry(overrides = {}) {
  const base = {
    slug: 'example',
    name: 'Example',
    vendor: 'Example Corp',
    category: 'ci-cd',
    website: 'https://example.com',
    documentation_url: 'https://example.com/docs/github-app',
    own_app: 'required',
    supports: { user: true, org: true, enterprise: false, ghes: true },
    install_scope: { repositories: 'selected', level: 'org-or-user' },
    credentials_needed: ['app_id', 'private_key'],
    two_step_webhook: false,
    manual_steps: [],
    manifest: {
      name: 'Example',
      url: 'https://example.com',
      hook_attributes: { url: 'https://example.invalid/unused', active: false },
      public: false,
      default_permissions: { contents: 'read', metadata: 'read' },
      default_events: [],
    },
    last_verified: null,
    verified_by: null,
    verification: { status: 'needs-review', method: 'doc-hash', doc_hash: null },
    changelog: [{ date: '2026-01-01', version: '1.0.0', author: 'alice', summary: 'Initial entry' }],
  };
  const { manifest, ...rest } = overrides;
  return { ...base, ...rest, manifest: { ...base.manifest, ...manifest } };
}

/** An entry with an active webhook and events. */
export function makeWebhookEntry(overrides = {}) {
  return makeEntry({
    ...overrides,
    manifest: {
      hook_attributes: { url: 'https://hooks.example.com/github', active: true },
      default_permissions: { contents: 'read', metadata: 'read', pull_requests: 'write' },
      default_events: ['pull_request', 'push'],
      ...overrides.manifest,
    },
  });
}

/** Runs git in a directory with a fixed identity. */
export function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 't@example.com' },
  });
}

/**
 * Creates a fixture repository with the real schema, data and CODEOWNERS plus
 * the given entries, committed on "main". Returns {root, cleanup, write, commit}.
 */
export function fixtureRepo(entries = {}, { gitInit = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'byoghapp-test-'));
  for (const dir of ['schema', 'data']) cpSync(join(REPO, dir), join(root, dir), { recursive: true });
  mkdirSync(join(root, '.github'), { recursive: true });
  cpSync(join(REPO, '.github/CODEOWNERS'), join(root, '.github/CODEOWNERS'));
  mkdirSync(join(root, 'entries'));
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  };
  for (const [slug, entry] of Object.entries(entries)) write(`entries/${slug}.json`, entry);
  const commit = (message = 'change') => {
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', message);
  };
  if (gitInit) {
    git(root, 'init', '-q', '-b', 'main');
    commit('initial');
  }
  return { root, write, commit, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Runs one of the repository's scripts against a fixture root. */
export function runScript(script, args = [], { root, env = {}, input } = {}) {
  const res = spawnSync(process.execPath, [join(REPO, script), ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, ...(root ? { BYOGHAPP_ROOT: root } : {}), ...env },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** A fake fetch that serves canned responses by URL (or a function). */
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const route = typeof routes === 'function' ? routes(String(url), init) : routes[String(url)];
    if (route instanceof Error) throw route;
    if (!route) return new Response('not found', { status: 404 });
    const { status = 200, body = '', json } = route;
    const content = status === 204 || status === 304 ? null : json !== undefined ? JSON.stringify(json) : body;
    return new Response(content, { status });
  };
  fn.calls = calls;
  return fn;
}

/** Real data tables, loaded once. */
export async function realData() {
  const { loadData } = await import('../scripts/lib/repo.mjs');
  return loadData(REPO);
}

/** Like runScript, but asynchronous, so an in-process server can answer the script. */
export function runScriptAsync(script, args = [], { root, env = {} } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(REPO, script), ...args], {
      env: { ...process.env, ...(root ? { BYOGHAPP_ROOT: root } : {}), ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

/**
 * A local HTTP server answering from a route table: {"METHOD /path": {status, json, body}}.
 * Records requests. Resolves to {url, requests, close}.
 */
export function fakeServer(routes) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const route = routes[`${req.method} ${req.url}`] ?? routes[`${req.method} ${req.url.split('?')[0]}`];
      if (!route) {
        res.writeHead(404).end('not found');
        return;
      }
      const { status = 200, json, body: text = '' } = route;
      res.writeHead(status, { 'content-type': json !== undefined ? 'application/json' : 'text/html' });
      res.end(json !== undefined ? JSON.stringify(json) : text);
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => resolvePromise({
      url: `http://127.0.0.1:${server.address().port}`,
      requests,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}
