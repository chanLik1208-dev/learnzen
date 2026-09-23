import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, routeTable } from './app.js';
import { getDb } from './db.js';
import { pruneRefreshTokens } from './auth.js';
import { sweep } from './ratelimit.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = join(root, 'web', 'dist');

const PORT = Number(process.env.PORT ?? 8787);
const ORIGINS = (process.env.LB_ORIGINS ?? `http://localhost:${PORT},http://localhost:5173`)
  .split(',').map((s) => s.trim()).filter(Boolean);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

const api = createApp({ allowedOrigins: ORIGINS });

/**
 * Serve the built front end, falling back to index.html so client-side routes
 * survive a refresh. Paths are normalised and confined to web/dist, so a
 * request for ../../data/learnzen.db cannot escape the directory.
 */
async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\.])+/, '');
  let file = join(webRoot, rel);

  if (!file.startsWith(webRoot)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(webRoot, 'index.html');
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('前端尚未建置，請先在 web/ 執行 npm run build');
  }
}

const server = createServer((req, res) => {
  if (req.url.startsWith('/api/')) return api(req, res);
  return serveStatic(req, res);
});

getDb();
const pruned = pruneRefreshTokens();
if (pruned) console.log(`清理了 ${pruned} 筆過期的 refresh token`);
setInterval(pruneRefreshTokens, 6 * 60 * 60 * 1000).unref();
// Expired buckets are harmless but would otherwise accumulate one entry per
// address seen since the process started.
setInterval(sweep, 10 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`LearnZen → http://localhost:${PORT}`);
  console.log(`已註冊 ${routeTable().length} 條路由，全部帶權限宣告`);
  console.log(
    process.env.LB_TRUST_PROXY === '1'
      ? '節流：信任 X-Forwarded-For（部署在反向代理後）'
      : '節流：以連線來源位址計數（未信任 X-Forwarded-For）',
  );
  if (process.env.LB_ROUTES === '1') console.table(routeTable());
});
