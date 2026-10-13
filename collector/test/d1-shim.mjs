/** A minimal D1-compatible adapter over node:sqlite, so tests run the Worker's real SQL. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.sql'), 'utf8'));
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}
