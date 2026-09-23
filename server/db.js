import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let db = null;

export function openDb(file = process.env.LB_DB ?? join(root, 'data', 'learnzen.db')) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const handle = new DatabaseSync(file);
  handle.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  // schema.sql sets these, but PRAGMAs are per-connection, so re-assert them.
  handle.exec('PRAGMA foreign_keys = ON');
  handle.exec('PRAGMA busy_timeout = 5000');
  return handle;
}

export function getDb() {
  if (!db) db = openDb();
  return db;
}

export function setDb(handle) {
  db = handle;
  return db;
}

export function closeDb() {
  db?.close();
  db = null;
}

/** Run `fn` inside a transaction, rolling back if it throws. */
export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(d);
    d.exec('COMMIT');
    return out;
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

export const all = (sql, ...args) => getDb().prepare(sql).all(...args);
export const get = (sql, ...args) => getDb().prepare(sql).get(...args);
export const run = (sql, ...args) => getDb().prepare(sql).run(...args);

export const now = () => Date.now();

export function audit({ actorId = null, action, target = null, ip = null, detail = null }) {
  run(
    'INSERT INTO audit_log (at, actor_id, action, target, ip, detail) VALUES (?, ?, ?, ?, ?, ?)',
    now(), actorId, action, target, ip,
    detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
  );
}
