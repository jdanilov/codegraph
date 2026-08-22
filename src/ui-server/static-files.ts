/**
 * Static file serving for the built frontend (`dist/ui-web/`), with SPA
 * fallback: any path that isn't a real file and isn't under `/api/` resolves
 * to `index.html` so client-side routes survive a page reload.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ServerResponse } from 'http';

/** Directory the frontend build (`npm run build:web`) writes into. */
export function webRoot(): string {
  return path.join(__dirname, '..', 'ui-web');
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** Page shown when the frontend hasn't been built (source checkouts). */
const NOT_BUILT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>CodeGraph UI</title></head>
<body style="font-family: ui-sans-serif, system-ui; padding: 3rem; line-height: 1.6">
<h1>Web UI not built</h1>
<p>The API is running, but the frontend bundle is missing.</p>
<p>Build it with <code>npm run build</code> (or <code>npm run build:web</code>), then reload.</p>
</body></html>
`;

/**
 * Serve `urlPath` from the web root. Returns false when the request should be
 * handled elsewhere (it never is today — the caller falls through to 404).
 */
export function serveStatic(res: ServerResponse, urlPath: string): boolean {
  const root = webRoot();
  const indexHtml = path.join(root, 'index.html');

  if (!fs.existsSync(indexHtml)) {
    res.writeHead(503, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(NOT_BUILT_HTML);
    return true;
  }

  const decoded = safeDecode(urlPath);
  const candidate = path.join(root, path.normalize(decoded).replace(/^([/\\])+/, ''));

  // Containment check: a crafted `..` must never escape the bundle directory.
  const withinRoot = candidate === root || candidate.startsWith(root + path.sep);
  const file = withinRoot && isFile(candidate) ? candidate : indexHtml;

  const body = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const isHtml = file === indexHtml;
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': body.length,
    // Hashed assets are immutable; the HTML shell must never be cached, or a
    // rebuilt bundle keeps loading yesterday's script tags.
    'Cache-Control': isHtml ? 'no-store' : 'public, max-age=3600',
  });
  res.end(body);
  return true;
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function safeDecode(urlPath: string): string {
  try {
    return decodeURIComponent(urlPath);
  } catch {
    return urlPath;
  }
}
