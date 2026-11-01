// Local dev server for the map client: `node serve.mjs [port]`, then open http://localhost:8080/.
// GitHub Pages serves the same files in production; this is only for trying changes before pushing.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8080);
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url))) + sep;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

  let file = normalize(join(ROOT, decodeURIComponent(pathname)));
  if (pathname.endsWith('/')) file = join(file, 'index.html');
  // Only files in this folder, and never the repository internals.
  if (!file.startsWith(ROOT) || file.includes(`${sep}.git`)) return send(res, 404, 'Not found');

  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    send(res, 404, 'Not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`MapBattle map client: http://localhost:${PORT}/`));

function send(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}
