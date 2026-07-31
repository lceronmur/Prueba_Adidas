import fs from 'node:fs';
import { config } from '../config.js';
import { createDb } from './index.js';

const force = process.argv.includes('--force');

if (force && config.dbPath !== ':memory:') {
  // WAL leaves satellite files behind; remove them too so no orphan journal
  // is reopened against a schema that no longer matches.
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${config.dbPath}${suffix}`, { force: true });
  }
  console.log(`- previous database removed (${config.dbPath})`);
}

const db = createDb(config.dbPath);
const tables = db
  .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
  .all()
  .map((row) => row.name);

console.log(`- schema applied at ${config.dbPath}`);
console.log(`  tables: ${tables.join(', ')}`);

db.close();
