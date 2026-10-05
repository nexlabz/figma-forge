/**
 * Tiny static file server — zero dependencies.
 *
 * A saved artifact (or any local HTML) has to be fetched over http for the
 * renderer to behave like the real page: file:// blocks module scripts, fetch
 * and some font loading, so a local origin is the difference between a blank
 * page and the real thing.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve, extname, normalize, basename, dirname } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serve `filePath`'s directory on an ephemeral loopback port.
 * Returns { url, root, close } — url points at the file itself.
 */
export async function serveLocalFile(filePath) {
  const full = resolve(filePath);
  const info = await stat(full);
  const root = info.isDirectory() ? full : dirname(full);
  const entry = info.isDirectory() ? 'index.html' : basename(full);

  const server = createServer(async (req, res) => {
    try {
      const rel = normalize(decodeURIComponent((req.url || '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '');
      const target = join(root, rel === '/' ? entry : rel);
      if (!target.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
      const s = await stat(target).catch(() => null);
      if (!s || !s.isFile()) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, {
        'content-type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
        'content-length': s.size,
        'cache-control': 'no-store',
      });
      createReadStream(target).pipe(res);
    } catch (e) {
      res.writeHead(500).end(String(e && e.message));
    }
  });

  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ok);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/${encodeURIComponent(entry)}`,
    root,
    close: () => new Promise((ok) => server.close(ok)),
  };
}
