/**
 * Mechanical checks that catch the kinds of mistake a test suite does not:
 * imports nobody uses, front-end calls to endpoints that do not exist,
 * routes with no screen, and permissions declared but never granted.
 *
 *   node scripts/audit.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { routeTable } from '../server/app.js';
import { PERMISSIONS, ALL_PERMISSIONS } from '../server/rbac.js';

const problems = [];
const note = (kind, detail) => problems.push({ kind, detail });

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git', 'data', 'shots', 'docs'].includes(entry.name)) continue;
      walk(path, out);
    } else if (['.js', '.mjs', '.vue'].includes(extname(entry.name))) {
      out.push(path);
    }
  }
  return out;
}

const files = walk('.');

// ------------------------------------------------------------- 1. imports --

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const body = src.replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];?/gm, '');

  for (const m of src.matchAll(/import\s+\{([^}]+)\}\s+from\s+['"][^'"]+['"]/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop().trim();
      if (!name) continue;
      // A bare word boundary match is enough: these are small files and a
      // false negative is better than a noisy false positive.
      if (!new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`).test(body)) {
        note('未使用的 import', `${file} → ${name}`);
      }
    }
  }
}

// ------------------------------------------ 2. front-end calls vs routes --

const webSrc = files.filter((f) => f.startsWith('web') && !f.includes('vite.config'))
  .map((f) => readFileSync(f, 'utf8')).join('\n');

const normalise = (p) => p
  .replace(/\$\{[^}]*\}/g, ':x')
  .replace(/:[A-Za-z]+/g, ':x')
  .replace(/[?#].*$/, '')
  .replace(/\/+$/, '');

// Keyed on method *and* path: matching on the path alone let a POST pass as
// covered because a GET on the same path had a screen, which hid the fact
// that nothing in the interface could create a question.
const declared = new Map(routeTable().map((r) => [`${r.method} ${normalise(r.path)}`, r]));

const METHOD_OF = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', del: 'DELETE' };
const called = new Set();
for (const m of webSrc.matchAll(/api\.(get|post|put|patch|del)\(\s*[`'"]([^`'"]+)/g)) {
  called.add(`${METHOD_OF[m[1]]} ${normalise(m[2])}`);
}
// The event-stream client, which opens a GET of its own.
for (const m of webSrc.matchAll(/openStream\(\s*[`'"](\/api\/[^`'"]+)/g)) {
  called.add(`GET ${normalise(m[1])}`);
}
// The client's own low-level sender, which the refresh path uses directly.
for (const m of webSrc.matchAll(/send\(\s*['"](\w+)['"]\s*,\s*['"](\/api\/[^'"]+)/g)) {
  called.add(`${m[1].toUpperCase()} ${normalise(m[2])}`);
}
// Anything fetched directly, which the demo and login paths do.
for (const m of webSrc.matchAll(/fetch\(\s*[`'"](\/api\/[^`'"]+)[`'"]\s*,\s*\{\s*method:\s*['"](\w+)/g)) {
  called.add(`${m[2].toUpperCase()} ${normalise(m[1])}`);
}

for (const key of called) {
  if (!declared.has(key)) note('前端呼叫了不存在的端點', key);
}
for (const key of declared.keys()) {
  if (!called.has(key)) note('端點沒有畫面', `${key}  (${declared.get(key).permission})`);
}

// ------------------------------------------------------- 3. permissions --

const granted = new Set(Object.values(PERMISSIONS).flat());
const used = new Set(routeTable().map((r) => r.permission).filter((p) => p !== 'PUBLIC'));
// A route may also gate part of its behaviour with an in-handler can() check
// rather than by declaring the permission, so those count as used too.
const routeSource = readdirSync('server/routes')
  .map((f) => readFileSync(join('server/routes', f), 'utf8'))
  .join('\n');
for (const m of routeSource.matchAll(/can\(\s*ctx\.user\s*,\s*['"]([^'"]+)['"]/g)) used.add(m[1]);

for (const permission of ALL_PERMISSIONS) {
  if (!used.has(permission)) note('權限宣告了但沒有路由使用', permission);
}
for (const permission of used) {
  if (!granted.has(permission)) note('路由要求的權限沒有任何角色擁有', permission);
}

const missingFromAdmin = PERMISSIONS.TEACHER.filter((p) => !PERMISSIONS.ADMIN.includes(p));
if (missingFromAdmin.length) note('管理員缺少教師權限', missingFromAdmin.join(', '));

// ----------------------------------------------------------- 4. reporting --

if (problems.length === 0) {
  console.log('沒有發現問題。');
} else {
  const byKind = new Map();
  for (const p of problems) {
    if (!byKind.has(p.kind)) byKind.set(p.kind, []);
    byKind.get(p.kind).push(p.detail);
  }
  for (const [kind, list] of byKind) {
    console.log(`\n${kind}（${list.length}）`);
    for (const detail of list) console.log(`  ${detail}`);
  }
  console.log(`\n合計 ${problems.length} 項`);
}
