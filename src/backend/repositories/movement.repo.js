/** Movement ledger: inserts and reads only. */
export function createMovementRepo(db) {
  const stmt = {
    insert: db.prepare(`
      INSERT INTO stock_movements
        (store_id, sku, type, quantity, delta, resulting_qty, reason)
      VALUES
        (@storeId, @sku, @type, @quantity, @delta, @resultingQty, @reason)
      RETURNING *
    `),

    recent: db.prepare(`
      SELECT m.*, s.name AS store_name, p.name AS product_name
        FROM stock_movements m
        JOIN stores   s ON s.id  = m.store_id
        JOIN products p ON p.sku = m.sku
       ORDER BY m.id DESC
       LIMIT ?
    `),

    forProduct: db.prepare(`
      SELECT * FROM stock_movements WHERE sku = ? ORDER BY id DESC LIMIT ?
    `),
  };

  return {
    insert: (params) => stmt.insert.get(params),
    recent: (limit = 20) => stmt.recent.all(limit),
    forProduct: (sku, limit = 20) => stmt.forProduct.all(sku, limit),

    list({ storeId, sku, type, from, to, limit, offset }) {
      const where = ['1 = 1'];
      const params = {};
      if (storeId) { where.push('m.store_id = @storeId'); params.storeId = storeId; }
      if (sku) { where.push('m.sku = @sku'); params.sku = sku; }
      if (type) { where.push('m.type = @type'); params.type = type; }
      if (from) { where.push('m.created_at >= @from'); params.from = from; }
      if (to) { where.push('m.created_at <= @to'); params.to = to; }

      const base = `
        FROM stock_movements m
        JOIN stores   s ON s.id  = m.store_id
        JOIN products p ON p.sku = m.sku
        WHERE ${where.join(' AND ')}
      `;

      const rows = db.prepare(`
        SELECT m.*, s.name AS store_name, p.name AS product_name
        ${base}
        ORDER BY m.id DESC
        LIMIT @limit OFFSET @offset
      `).all({ ...params, limit, offset });

      const { total } = db.prepare(`SELECT COUNT(*) AS total ${base}`).get(params);
      return { rows, total };
    },
  };
}
