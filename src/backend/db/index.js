import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(here, 'schema.sql');

/**
 * Opens (or creates) the database and applies the schema.
 *
 * The PRAGMAs matter for correctness, not just performance:
 *  - WAL          lets readers query while a write is in flight, so the panel
 *                  can poll while stores are reporting.
 *  - foreign_keys SQLite ignores foreign keys unless this is set explicitly.
 *  - busy_timeout retries automatically on a lock instead of failing outright.
 */
export function createDb(dbPath = ':memory:') {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

  return db;
}
