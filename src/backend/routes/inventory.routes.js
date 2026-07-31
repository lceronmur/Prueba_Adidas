import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { inventoryQuerySchema } from '../schemas/query.schema.js';
import { paginationMeta, toLimitOffset, toMovementDTO } from './presenters.js';

export function createInventoryRouter({ inventoryService, alertRepo }) {
  const router = Router();

  /**
   * GET /inventory — inventory with filters (store, product, low-stock range).
   *
   * `group_by=product` (default) consolidates at the network level;
   * `group_by=store` returns the per-store breakdown. Both compare against
   * the same product threshold.
   */
  router.get('/', validate(inventoryQuerySchema, 'query'), (req, res) => {
    const query = req.validated.query;
    const { limit, offset, page, pageSize } = toLimitOffset(query);

    const { rows, total } = inventoryService.listInventory({
      groupBy: query.group_by,
      storeId: query.store_id,
      sku: query.sku,
      category: query.category,
      lowStock: query.low_stock,
      minQty: query.min_qty,
      maxQty: query.max_qty,
      limit,
      offset,
    });

    const data = query.group_by === 'store'
      ? rows.map((row) => ({
        store_id: row.store_id,
        store_name: row.store_name,
        sku: row.sku,
        product_name: row.product_name,
        category: row.category,
        quantity: row.quantity,
        threshold: row.threshold,
        low_stock: Boolean(row.low_stock),
        updated_at: row.updated_at,
      }))
      : rows.map((row) => ({
        sku: row.sku,
        name: row.name,
        category: row.category,
        network_quantity: row.network_quantity,
        threshold: row.threshold,
        low_stock: row.network_quantity <= row.threshold,
        by_store: inventoryService.breakdown(row.sku).map((entry) => ({
          store_id: entry.store_id,
          store_name: entry.store_name,
          quantity: entry.quantity,
        })),
      }));

    res.json({ data, meta: { ...paginationMeta({ page, pageSize, total }), group_by: query.group_by } });
  });

  /** GET /inventory/:sku — a product's detail across the whole network. */
  router.get('/:sku', (req, res) => {
    const detail = inventoryService.productDetail(req.params.sku);
    const openAlerts = alertRepo.list({ sku: req.params.sku, status: 'OPEN', limit: 1, offset: 0 });

    res.json({
      sku: detail.product.sku,
      name: detail.product.name,
      category: detail.product.category,
      threshold: detail.product.low_stock_threshold,
      network_quantity: detail.networkQuantity,
      low_stock: detail.networkQuantity <= detail.product.low_stock_threshold,
      by_store: detail.byStore.map((row) => ({
        store_id: row.store_id,
        store_name: row.store_name,
        quantity: row.quantity,
        updated_at: row.updated_at,
      })),
      open_alert: openAlerts.rows[0] ? { id: openAlerts.rows[0].id, threshold: openAlerts.rows[0].threshold } : null,
      recent_movements: detail.movements.map(toMovementDTO),
    });
  });

  return router;
}
