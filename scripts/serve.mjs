#!/usr/bin/env node
// A tiny static file server for local development and the browser tests.
// It serves site/ only; the pages carry their own CSP meta tags.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { ROOT } from './lib/repo.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** Maps a request path to a file under root, or null if it escapes root. */
export function resolvePath(root, urlPath) {
  let path = decodeURIComponent(urlPath.split('?')[0]);
  if (path.endsWith('/')) path += 'index.html';
  const full = normalize(join(root, path));
  return full === root || full.startsWith(root + sep) ? full : null;
}

/** Starts the server; resolves to {server, url}. Port 0 picks a free port. */
export function startServer({ root = join(ROOT, 'site'), port = 8000, host = '127.0.0.1' } = {}) {
  const server = createServer(async (req, res) => {
    const file = resolvePath(root, req.url);
    if (!file) {
      res.writeHead(400).end('Bad request');
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}/` }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await startServer({ port: Number(process.env.PORT ?? 8000) });
  console.log(`Serving site/ at ${url} (run "npm run build" first)`);
}
