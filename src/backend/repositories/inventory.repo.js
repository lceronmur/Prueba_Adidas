/**
 * Access to the stock projection and the catalog.
 * No business rules here: prepared SQL only.
 */
export function createInventoryRepo(db) {
  const stmt = {
    ensureRow: db.prepare(`
      INSERT OR IGNORE INTO inventory (store_id, sku, quantity) VALUES (?, ?, 0)
    `),

    /**
     * Applies the delta and returns the resulting quantity, or undefined if
     * the operation would leave stock negative.
     *
     * The arithmetic happens INSIDE the engine: there is no prior read in
     * JavaScript, so there is no window between reading and writing.
     */
    applyDelta: db.prepare(`
      UPDATE inventory
         SET quantity   = quantity + @delta,
             updated_at = datetime('now')
       WHERE store_id = @storeId
         AND sku      = @sku
         AND quantity + @delta >= 0
      RETURNING quantity
    `),

    quantity: db.prepare(`
      SELECT quantity FROM inventory WHERE store_id = ? AND sku = ?
    `),

    networkQuantity: db.prepare(`
      SELECT COALESCE(SUM(quantity), 0) AS qty FROM inventory WHERE sku = ?
    `),

    byStore: db.prepare(`
      SELECT i.store_id, s.name AS store_name, i.quantity, i.updated_at
        FROM inventory i
        JOIN stores s ON s.id = i.store_id
       WHERE i.sku = ?
       ORDER BY i.store_id
    `),

    product: db.prepare(`SELECT * FROM products WHERE sku = ?`),
    products: db.prepare(`SELECT * FROM products ORDER BY sku`),
    store: db.prepare(`SELECT * FROM stores WHERE id = ?`),
    storeByKey: db.prepare(`SELECT * FROM stores WHERE api_key = ?`),
    stores: db.prepare(`SELECT id, name, created_at FROM stores ORDER BY id`),

    updateThreshold: db.prepare(`
      UPDATE products SET low_stock_threshold = @threshold WHERE sku = @sku
      RETURNING *
    `),

    /** Checks that the projection equals the sum of the ledger for every row. */
    reconcile: db.prepare(`
      SELECT i.store_id,
             i.sku,
             i.quantity                        AS projected,
             COALESCE(m.total, 0)              AS ledger,
             i.quantity - COALESCE(m.total, 0)  AS diff
        FROM inventory i
        LEFT JOIN (
          SELECT store_id, sku, SUM(delta) AS total
            FROM stock_movements
           GROUP BY store_id, sku
        ) m ON m.store_id = i.store_id AND m.sku = i.sku
       WHERE i.quantity <> COALESCE(m.total, 0)
    `),
  };

  return {
    ensureRow: (storeId, sku) => stmt.ensureRow.run(storeId, sku),
    applyDelta: (params) => stmt.applyDelta.get(params)?.quantity,
    quantity: (storeId, sku) => stmt.quantity.get(storeId, sku)?.quantity ?? 0,
    networkQuantity: (sku) => stmt.networkQuantity.get(sku).qty,
    byStore: (sku) => stmt.byStore.all(sku),
    findProduct: (sku) => stmt.product.get(sku),
    listProducts: () => stmt.products.all(),
    findStore: (id) => stmt.store.get(id),
    findStoreByApiKey: (key) => stmt.storeByKey.get(key),
    listStores: () => stmt.stores.all(),
    updateThreshold: (params) => stmt.updateThreshold.get(params),
    reconcile: () => stmt.reconcile.all(),

    /** Network-wide inventory, one row per product. */
    listByProduct({ sku, category, lowStock, minQty, maxQty, limit, offset }) {
      const where = ['1 = 1'];
      const params = {};
      if (sku) { where.push('p.sku LIKE @sku'); params.sku = `%${sku}%`; }
      if (category) { where.push('p.category = @category'); params.category = category; }

      const having = [];
      if (lowStock === true) having.push('network_quantity <= p.low_stock_threshold');
      if (lowStock === false) having.push('network_quantity > p.low_stock_threshold');
      if (minQty != null) { having.push('network_quantity >= @minQty'); params.minQty = minQty; }
      if (maxQty != null) { having.push('network_quantity <= @maxQty'); params.maxQty = maxQty; }

      const base = `
        FROM products p
        LEFT JOIN inventory i ON i.sku = p.sku
        WHERE ${where.join(' AND ')}
        GROUP BY p.sku
        ${having.length ? `HAVING ${having.join(' AND ')}` : ''}
      `;
      const select = `
        SELECT p.sku,
               p.name,
               p.category,
               p.low_stock_threshold          AS threshold,
               COALESCE(SUM(i.quantity), 0)   AS network_quantity
      `;

      const rows = db.prepare(`
        ${select} ${base}
        ORDER BY (network_quantity <= p.low_stock_threshold) DESC, p.sku
        LIMIT @limit OFFSET @offset
      `).all({ ...params, limit, offset });

      // The COUNT reuses the same SELECT because the HAVING clause
      // references the network_quantity alias, which only exists once the
      // aggregate is computed.
      const { total } = db
        .prepare(`SELECT COUNT(*) AS total FROM (${select} ${base})`)
        .get(params);

      return { rows, total };
    },

    /** Inventory broken down one row per (store, product). */
    listByStore({ storeId, sku, category, lowStock, minQty, maxQty, limit, offset }) {
      const where = ['1 = 1'];
      const params = {};
      if (storeId) { where.push('i.store_id = @storeId'); params.storeId = storeId; }
      if (sku) { where.push('i.sku LIKE @sku'); params.sku = `%${sku}%`; }
      if (category) { where.push('p.category = @category'); params.category = category; }
      if (lowStock === true) where.push('i.quantity <= p.low_stock_threshold');
      if (lowStock === false) where.push('i.quantity > p.low_stock_threshold');
      if (minQty != null) { where.push('i.quantity >= @minQty'); params.minQty = minQty; }
      if (maxQty != null) { where.push('i.quantity <= @maxQty'); params.maxQty = maxQty; }

      const base = `
        FROM inventory i
        JOIN products p ON p.sku = i.sku
        JOIN stores   s ON s.id  = i.store_id
        WHERE ${where.join(' AND ')}
      `;

      const rows = db.prepare(`
        SELECT i.store_id, s.name AS store_name, i.sku, p.name AS product_name,
               p.category, i.quantity, p.low_stock_threshold AS threshold,
               (i.quantity <= p.low_stock_threshold) AS low_stock, i.updated_at
        ${base}
        ORDER BY low_stock DESC, i.store_id, i.sku
        LIMIT @limit OFFSET @offset
      `).all({ ...params, limit, offset });

      const { total } = db.prepare(`SELECT COUNT(*) AS total ${base}`).get(params);
      return { rows, total };
    },
  };
}
