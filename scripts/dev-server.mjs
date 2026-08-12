/**
 * Local dev server: serves public/ and runs the same API routes the deployed
 * functions use. `npm run dev` → http://localhost:8888
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './load-env.mjs';

loadEnv();

const { handleApiRequest } = await import('../src/lib/api.mjs');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const port = Number(process.env.PORT || 8888);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          return send(res, 400, JSON.stringify({ error: 'Body must be valid JSON.' }), MIME['.json']);
        }
      }
    }
    const started = Date.now();
    const result = await handleApiRequest({
      method: req.method,
      path: url.pathname.replace(/^\/api/, ''),
      body,
    });
    console.log(`${req.method} ${url.pathname} → ${result.status} (${Date.now() - started}ms)`);
    return send(
      res,
      result.status,
      result.body === null ? '' : JSON.stringify(result.body),
      MIME['.json'],
    );
  }

  // Static files, with an SPA fallback so /c/<uuid> deep links work.
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(publicDir, relative);
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(publicDir, 'index.html');
  }

  try {
    const data = await readFile(file);
    send(res, 200, data, MIME[extname(file)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
});

function send(res, status, body, type) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

server.listen(port, () => {
  console.log(`ClashSwap dev server → http://localhost:${port}`);
  if (!process.env.DATABASE_URL) console.warn('⚠  DATABASE_URL is not set — API calls will fail.');
});
