import { config } from '../config.js';
import { createAlertRepo } from '../repositories/alert.repo.js';
import { createInventoryRepo } from '../repositories/inventory.repo.js';
import { createMovementRepo } from '../repositories/movement.repo.js';
import { createAlertService } from '../services/alert.service.js';
import { createInventoryService } from '../services/inventory.service.js';
import { createDb } from './index.js';

export const STORES = [
  { id: 'store-a', name: 'Inkwell Books - Downtown', api_key: 'sk_store_a_demo' },
  { id: 'store-b', name: 'Inkwell Books - Riverside', api_key: 'sk_store_b_demo' },
  { id: 'store-c', name: 'Inkwell Books - Uptown', api_key: 'sk_store_c_demo' },
];

export const PRODUCTS = [
  { sku: 'BOOK-HB-CP', name: 'The Cruel Prince — Holly Black', category: 'ya-fantasy', threshold: 12 },
  { sku: 'BOOK-HB-WK', name: 'The Wicked King — Holly Black', category: 'ya-fantasy', threshold: 12 },
  { sku: 'BOOK-HB-QN', name: 'The Queen of Nothing — Holly Black', category: 'ya-fantasy', threshold: 12 },
  { sku: 'BOOK-SJM-ACOTAR', name: 'A Court of Thorns and Roses — Sarah J. Maas', category: 'romantasy', threshold: 20 },
  { sku: 'BOOK-SJM-ACOMAF', name: 'A Court of Mist and Fury — Sarah J. Maas', category: 'romantasy', threshold: 20 },
  { sku: 'BOOK-VES-DSOM', name: 'A Darker Shade of Magic — V.E. Schwab', category: 'fantasy', threshold: 25 },
  { sku: 'BOOK-VES-ADDIE', name: 'The Invisible Life of Addie LaRue — V.E. Schwab', category: 'fantasy', threshold: 25 },
  { sku: 'BOOK-CSP-CAPTIVE', name: 'Captive Prince — C.S. Pacat', category: 'fantasy', threshold: 30 },
  { sku: 'BOOK-HK-VEGET', name: 'The Vegetarian — Han Kang', category: 'literary-fiction', threshold: 8 },
];

/**
 * Initial stock per store. `BOOK-HK-VEGET` starts under its threshold (8) on
 * purpose, so the demo panel opens with an alert already visible.
 */
const INITIAL_STOCK = {
  'store-a': {
    'BOOK-HB-CP': 18, 'BOOK-HB-WK': 24, 'BOOK-HB-QN': 15,
    'BOOK-SJM-ACOTAR': 22, 'BOOK-SJM-ACOMAF': 31,
    'BOOK-VES-DSOM': 20, 'BOOK-VES-ADDIE': 18, 'BOOK-CSP-CAPTIVE': 40, 'BOOK-HK-VEGET': 2,
  },
  'store-b': {
    'BOOK-HB-CP': 12, 'BOOK-HB-WK': 19, 'BOOK-HB-QN': 11,
    'BOOK-SJM-ACOTAR': 16, 'BOOK-SJM-ACOMAF': 24,
    'BOOK-VES-DSOM': 15, 'BOOK-VES-ADDIE': 12, 'BOOK-CSP-CAPTIVE': 33, 'BOOK-HK-VEGET': 3,
  },
  'store-c': {
    'BOOK-HB-CP': 7, 'BOOK-HB-WK': 9, 'BOOK-HB-QN': 6,
    'BOOK-SJM-ACOTAR': 11, 'BOOK-SJM-ACOMAF': 18,
    'BOOK-VES-DSOM': 12, 'BOOK-VES-ADDIE': 10, 'BOOK-CSP-CAPTIVE': 26, 'BOOK-HK-VEGET': 1,
  },
};

/**
 * Seeds the catalog and the initial stock.
 *
 * Stock is NOT inserted into `inventory` directly: it is applied as `IN`
 * movements through the service, exactly like a real store report. That way
 * the ledger explains the entire inventory from the first unit, and the
 * reconcile check holds from the moment the database starts.
 */
export function seed(db, { quiet = false } = {}) {
  const inventoryRepo = createInventoryRepo(db);
  const movementRepo = createMovementRepo(db);
  const alertRepo = createAlertRepo(db);
  const alertService = createAlertService({ inventoryRepo, alertRepo });
  const inventoryService = createInventoryService({
    db, inventoryRepo, movementRepo, alertService,
  });

  const insertCatalog = db.transaction(() => {
    const insertStore = db.prepare(`
      INSERT INTO stores (id, name, api_key) VALUES (@id, @name, @api_key)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name
    `);
    const insertProduct = db.prepare(`
      INSERT INTO products (sku, name, category, low_stock_threshold)
      VALUES (@sku, @name, @category, @threshold)
      ON CONFLICT(sku) DO UPDATE SET
        name = excluded.name,
        category = excluded.category,
        low_stock_threshold = excluded.low_stock_threshold
    `);

    STORES.forEach((store) => insertStore.run(store));
    PRODUCTS.forEach((product) => insertProduct.run(product));
  });

  insertCatalog();

  let movements = 0;
  for (const [storeId, stock] of Object.entries(INITIAL_STOCK)) {
    for (const [sku, quantity] of Object.entries(stock)) {
      if (quantity <= 0) continue;
      inventoryService.applyMovement({
        storeId,
        sku,
        type: 'IN',
        quantity,
        reason: 'initial-load',
      });
      movements += 1;
    }
  }

  // Alerts are recomputed ONCE the initial load has fully settled.
  //
  // The load walks the stores one at a time, so halfway through, the network
  // total is artificially low and would trigger alerts based on a transient
  // state that never really existed. Discarding and re-evaluating leaves
  // snapshots that match the real starting inventory.
  db.transaction(() => {
    db.prepare('DELETE FROM alerts').run();
    PRODUCTS.forEach(({ sku }) => alertService.evaluate(sku));
  })();

  const openAlerts = alertRepo.countOpen();

  if (!quiet) {
    console.log(`- catalog: ${STORES.length} stores, ${PRODUCTS.length} products`);
    console.log(`- initial stock: ${movements} IN movements applied through the service`);
    console.log(`- open alerts after load: ${openAlerts}`);
    console.log('\n  Demo API keys');
    STORES.forEach((store) => {
      console.log(`   ${store.api_key.padEnd(20)} ${store.id}`);
    });
    console.log(`   ${config.adminApiKey.padEnd(20)} admin (read + thresholds)`);
  }

  return { stores: STORES.length, products: PRODUCTS.length, movements, openAlerts };
}

// Run directly: node src/backend/db/seed.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = createDb(config.dbPath);
  seed(db);
  db.close();
}
