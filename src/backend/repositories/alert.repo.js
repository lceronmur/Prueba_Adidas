/** Low-stock alerts. At most one open alert per product (see schema.sql). */
export function createAlertRepo(db) {
  const stmt = {
    findOpen: db.prepare(`
      SELECT * FROM alerts WHERE sku = ? AND status = 'OPEN'
    `),

    open: db.prepare(`
      INSERT INTO alerts (sku, quantity_at_trigger, threshold)
      VALUES (@sku, @quantity, @threshold)
      RETURNING *
    `),

    resolve: db.prepare(`
      UPDATE alerts
         SET status = 'RESOLVED', resolved_at = datetime('now'), resolved_qty = @quantity
       WHERE id = @id AND status = 'OPEN'
      RETURNING *
    `),

    countOpen: db.prepare(`SELECT COUNT(*) AS total FROM alerts WHERE status = 'OPEN'`),
  };

  return {
    findOpen: (sku) => stmt.findOpen.get(sku),
    open: (params) => stmt.open.get(params),
    resolve: (id, quantity) => stmt.resolve.get({ id, quantity }),
    countOpen: () => stmt.countOpen.get().total,

    list({ status, sku, limit, offset }) {
      const where = ['1 = 1'];
      const params = {};
      if (status) { where.push('a.status = @status'); params.status = status; }
      if (sku) { where.push('a.sku = @sku'); params.sku = sku; }

      const base = `
        FROM alerts a
        JOIN products p ON p.sku = a.sku
        WHERE ${where.join(' AND ')}
      `;

      const rows = db.prepare(`
        SELECT a.*, p.name AS product_name
        ${base}
        ORDER BY a.status = 'OPEN' DESC, a.id DESC
        LIMIT @limit OFFSET @offset
      `).all({ ...params, limit, offset });

      const { total } = db.prepare(`SELECT COUNT(*) AS total ${base}`).get(params);
      return { rows, total };
    },
  };
}
