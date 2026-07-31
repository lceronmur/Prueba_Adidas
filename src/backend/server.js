import { createApp } from './app.js';
import { config } from './config.js';
import { createDb } from './db/index.js';

const db = createDb(config.dbPath);
const app = createApp(db);

const server = app.listen(config.port, () => {
  console.log(`Network inventory listening on http://localhost:${config.port}`);
  console.log(`  panel -> http://localhost:${config.port}/`);
  console.log(`  api   -> http://localhost:${config.port}/api/v1`);
  console.log(`  db    -> ${config.dbPath}`);
});

/** Graceful shutdown: without this, WAL can be left with a pending checkpoint. */
function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
