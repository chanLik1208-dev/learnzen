/**
 * Which registered endpoints have no screen behind them.
 *
 * An API nobody can reach from the interface is not a feature — it is either
 * work still to do or dead weight, and this makes the difference visible
 * rather than leaving it to memory.
 *
 *   node scripts/coverage.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { routeTable } from '../server/app.js';

const DIRS = ['web/src', 'web/src/views', 'web/src/components', 'web/src/lib'];

let source = '';
for (const dir of DIRS) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) source += readFileSync(join(dir, entry.name), 'utf8');
  }
}

/** Template holes and route parameters both collapse to the same marker. */
const normalise = (path) => path
  .replace(/\$\{[^}]*\}/g, ':x')
  .replace(/:[A-Za-z]+/g, ':x')
  .replace(/[?#].*$/, '')
  .replace(/\/+$/, '');

const referenced = new Set();
for (const m of source.matchAll(/\/api\/[A-Za-z0-9/_:${}.-]*/g)) {
  referenced.add(normalise(m[0]));
}

const hasScreen = (path) => {
  const target = normalise(path);
  for (const ref of referenced) if (ref === target) return true;
  return false;
};

const rows = routeTable().map((r) => ({ ...r, screen: hasScreen(r.path) ? '有' : '—' }));
const missing = rows.filter((r) => r.screen === '—');

console.log(`已註冊 ${rows.length} 條路由，其中 ${missing.length} 條沒有畫面：\n`);
for (const r of missing) {
  console.log(`  ${r.method.padEnd(7)} ${r.path.padEnd(44)} ${r.permission}`);
}
