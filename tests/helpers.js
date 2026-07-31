import { createApp } from '../src/backend/app.js';
import { createDb } from '../src/backend/db/index.js';
import { seed } from '../src/backend/db/seed.js';

export const KEYS = {
  storeA: 'sk_store_a_demo',
  storeB: 'sk_store_b_demo',
  storeC: 'sk_store_c_demo',
  admin: 'sk_admin_demo',
};

/**
 * Boots an isolated app on top of an in-memory database.
 *
 * The logger is silenced so the 500-error tests don't pollute test output.
 */
export function buildTestApp({ withSeed = true } = {}) {
  const db = createDb(':memory:');
  if (withSeed) seed(db, { quiet: true });

  const app = createApp(db, {
    logger: { error() {}, warn() {}, log() {} },
  });

  return { app, db };
}

/** Reads a store's stock straight from the projection. */
export function stockOf(db, storeId, sku) {
  return db.prepare('SELECT quantity FROM inventory WHERE store_id = ? AND sku = ?')
    .get(storeId, sku)?.quantity ?? 0;
}

/** Ledger sum: must always match the projection (see reconcile). */
export function ledgerOf(db, storeId, sku) {
  return db.prepare('SELECT COALESCE(SUM(delta), 0) AS total FROM stock_movements WHERE store_id = ? AND sku = ?')
    .get(storeId, sku).total;
}

export function countMovements(db, storeId, sku) {
  return db.prepare('SELECT COUNT(*) AS total FROM stock_movements WHERE store_id = ? AND sku = ?')
    .get(storeId, sku).total;
}

export function openAlert(db, sku) {
  return db.prepare("SELECT * FROM alerts WHERE sku = ? AND status = 'OPEN'").get(sku);
}
