import { InsufficientStockError, NotFoundError } from './errors.js';

/**
 * Inventory service. Contains the system's only write path.
 *
 * Structural rule: stock is NEVER written directly. A movement is recorded
 * and the projection is updated in the same transaction, so
 * `inventory.quantity` always equals `SUM(stock_movements.delta)` for every
 * (store, sku) pair.
 */
export function createInventoryService({ db, inventoryRepo, movementRepo, alertService }) {
  /**
   * Core transactional path.
   *
   * Everything below runs inside a single `BEGIN IMMEDIATE...COMMIT`: the
   * delta update, the ledger insert, and the alert evaluation. Either all
   * of it applies, or none of it does.
   */
  const applyOne = db.transaction((cmd) => {
    const { storeId, sku, type, quantity, reason } = cmd;

    const product = inventoryRepo.findProduct(sku);
    if (!product) {
      throw new NotFoundError('PRODUCT_NOT_FOUND', `Product ${sku} does not exist in the catalog.`, { sku });
    }

    inventoryRepo.ensureRow(storeId, sku);

    const delta = type === 'IN' ? quantity : -quantity;
    const resultingQty = inventoryRepo.applyDelta({ storeId, sku, delta });

    if (resultingQty === undefined) {
      // The UPDATE touched no row: its `quantity + delta >= 0` guard blocked
      // it. Nothing changed, so it's safe to just read the current value.
      throw new InsufficientStockError({
        storeId,
        sku,
        available: inventoryRepo.quantity(storeId, sku),
        requested: quantity,
      });
    }

    const movement = movementRepo.insert({
      storeId, sku, type, quantity, delta, resultingQty,
      reason: reason ?? null,
    });

    const alert = alertService.evaluate(sku);

    return {
      movement,
      storeQuantity: resultingQty,
      networkQuantity: inventoryRepo.networkQuantity(sku),
      alert,
    };
  });

  return {
    applyMovement: (cmd) => applyOne(cmd),

    /** Changes a product's threshold and re-evaluates its alert immediately. */
    updateThreshold: db.transaction(({ sku, threshold }) => {
      const product = inventoryRepo.updateThreshold({ sku, threshold });
      if (!product) {
        throw new NotFoundError('PRODUCT_NOT_FOUND', `Product ${sku} does not exist in the catalog.`, { sku });
      }
      return { product, alert: alertService.evaluate(sku) };
    }),

    /** Compares the projection against the ledger; should always be empty. */
    reconcile() {
      const discrepancies = inventoryRepo.reconcile();
      return { consistent: discrepancies.length === 0, discrepancies };
    },

    // --- Reads ----------------------------------------------------------
    // Routed through the service so routes never depend on a repository
    // directly.

    listMovements: (filters) => movementRepo.list(filters),

    listInventory: ({ groupBy, ...filters }) =>
      (groupBy === 'store'
        ? inventoryRepo.listByStore(filters)
        : inventoryRepo.listByProduct(filters)),

    breakdown: (sku) => inventoryRepo.byStore(sku),

    /** Detail of a product across the whole network, with its recent movements. */
    productDetail(sku, { historyLimit = 20 } = {}) {
      const product = inventoryRepo.findProduct(sku);
      if (!product) {
        throw new NotFoundError('PRODUCT_NOT_FOUND', `Product ${sku} does not exist in the catalog.`, { sku });
      }

      return {
        product,
        networkQuantity: inventoryRepo.networkQuantity(sku),
        byStore: inventoryRepo.byStore(sku),
        movements: movementRepo.forProduct(sku, historyLimit),
      };
    },

    recentMovements: (limit) => movementRepo.recent(limit),
    listProducts: () => inventoryRepo.listProducts(),
    listStores: () => inventoryRepo.listStores(),
  };
}
