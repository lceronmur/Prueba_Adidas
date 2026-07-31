import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { thresholdSchema } from '../schemas/movement.schema.js';
import { toMovementDTO, toProductDTO } from './presenters.js';

export function createAdminRouter({ inventoryService, auth }) {
  const router = Router();

  /** Catalog, used to populate the panel's filters. */
  router.get('/stores', (_req, res) => {
    res.json({ data: inventoryService.listStores().map((store) => ({ id: store.id, name: store.name })) });
  });

  router.get('/products', (_req, res) => {
    res.json({ data: inventoryService.listProducts().map(toProductDTO) });
  });

  /**
   * PATCH /products/:sku/threshold — configurable low-stock threshold.
   *
   * Re-evaluates the product's alert in the same transaction: raising the
   * threshold can open an alert immediately, lowering it can resolve one,
   * without waiting for the next movement.
   */
  router.patch(
    '/products/:sku/threshold',
    auth.requireAdmin,
    validate(thresholdSchema),
    (req, res) => {
      const { product, alert } = inventoryService.updateThreshold({
        sku: req.params.sku,
        threshold: req.validated.body.low_stock_threshold,
      });

      res.json({ product: toProductDTO(product), alert_event: alert });
    },
  );

  /**
   * GET /reconcile — consistency check.
   *
   * Compares the `inventory` projection against the sum of the ledger. It
   * should always report zero discrepancies, even under concurrent load:
   * this is the executable proof that the single-transaction design works.
   */
  router.get('/reconcile', auth.requireAdmin, (_req, res) => {
    const result = inventoryService.reconcile();
    res.status(result.consistent ? 200 : 500).json(result);
  });

  /** Recent movements across the whole network: feeds the panel's activity list. */
  router.get('/activity', (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 15), 100);
    res.json({ data: inventoryService.recentMovements(limit).map(toMovementDTO) });
  });

  return router;
}
