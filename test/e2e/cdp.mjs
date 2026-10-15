// A minimal Chrome DevTools Protocol driver: launches headless Chrome and talks
// to it over Node's built-in WebSocket. Enough for the browser tests and their
// coverage, with no npm dependencies.

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Path to a Chrome or Chromium binary, or null. CHROME_PATH wins. */
export function findChrome() {
  const candidates = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium'].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      return execFileSync('which', [name], { encoding: 'utf8' }).trim();
    } catch {
      // try the next name
    }
  }
  return null;
}

class Connection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const listener of this.listeners) listener(msg);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** Resolves with the params of the first event named in `methods` (a name or a list). */
  waitForEvent(methods, sessionId, timeout = 10_000) {
    const names = [methods].flat();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`Timed out waiting for ${names.join(' or ')}`));
      }, timeout);
      const listener = (msg) => {
        if (names.includes(msg.method) && msg.sessionId === sessionId) {
          clearTimeout(timer);
          this.listeners.delete(listener);
          resolve(msg.params);
        }
      };
      this.listeners.add(listener);
    });
  }
}

export class Page {
  constructor(conn, sessionId) {
    this.conn = conn;
    this.sessionId = sessionId;
    this.consoleErrors = [];
    conn.listeners.add((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') this.consoleErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') this.consoleErrors.push(msg.params.entry.text);
    });
  }

  send(method, params) {
    return this.conn.send(method, params, this.sessionId);
  }

  /** Navigates and waits for the load event, or for a same-document (hash) navigation. */
  async goto(url) {
    const loaded = this.conn.waitForEvent(['Page.loadEventFired', 'Page.navigatedWithinDocument'], this.sessionId);
    await this.send('Page.navigate', { url });
    await loaded;
  }

  /** Evaluates an expression (awaiting promises) and returns its JSON value. */
  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(`Evaluation failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value;
  }

  /** Polls until the expression is truthy. */
  async waitFor(expression, timeout = 5000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this.evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for: ${expression}`);
  }

  async screenshot(path, { width = 1280, height = 900, fullPage = true } = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    let clip;
    if (fullPage) {
      const { cssContentSize } = await this.send('Page.getLayoutMetrics');
      clip = { x: 0, y: 0, width, height: Math.ceil(cssContentSize.height), scale: 1 };
    }
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
    writeFileSync(path, Buffer.from(data, 'base64'));
  }
}

export class Browser {
  static async launch({ chromePath = findChrome() } = {}) {
    if (!chromePath) throw new Error('No Chrome or Chromium found: set CHROME_PATH');
    const userDataDir = mkdtempSync(join(tmpdir(), 'byoghapp-chrome-'));
    const args = [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
      '--disable-background-networking', '--disable-component-update', '--no-proxy-server',
      '--disable-sync', '--metrics-recording-only', '--disable-default-apps', '--mute-audio',
    ];
    if (process.getuid?.() === 0) args.push('--no-sandbox');
    const proc = spawn(chromePath, [...args, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const wsUrl = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error(`Chrome did not start:\n${buffer}`)), 15_000);
      proc.stderr.on('data', (chunk) => {
        buffer += chunk;
        const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      proc.on('exit', (code) => reject(new Error(`Chrome exited with ${code}:\n${buffer}`)));
    });
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new Browser(proc, new Connection(ws), userDataDir);
  }

  constructor(proc, conn, userDataDir) {
    this.proc = proc;
    this.conn = conn;
    this.userDataDir = userDataDir;
  }

  async newPage() {
    const { targetId } = await this.conn.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this.conn, sessionId);
    await Promise.all([page.send('Page.enable'), page.send('Runtime.enable'), page.send('Log.enable')]);
    return page;
  }

  async close() {
    try {
      await this.conn.send('Browser.close');
    } catch {
      this.proc.kill();
    }
    this.conn.ws.close();
    await new Promise((r) => (this.proc.exitCode === null ? this.proc.on('exit', r) : r()));
    rmSync(this.userDataDir, { recursive: true, force: true });
  }
}
