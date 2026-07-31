import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { movementSchema } from '../schemas/movement.schema.js';
import { movementsQuerySchema } from '../schemas/query.schema.js';
import { paginationMeta, toLimitOffset, toMovementDTO } from './presenters.js';

/** Normalizes the validated body into the command the service expects. */
function toCommand(body, storeId) {
  return {
    storeId,
    sku: body.sku,
    type: body.type,
    quantity: body.quantity,
    reason: body.reason,
  };
}

function movementResponse(result, product) {
  return {
    movement_id: result.movement.id,
    store_id: result.movement.store_id,
    sku: result.movement.sku,
    type: result.movement.type,
    delta: result.movement.delta,
    store_quantity: result.storeQuantity,
    network_quantity: result.networkQuantity,
    alert: {
      triggered: result.alert?.action === 'OPENED',
      threshold: product?.low_stock_threshold ?? null,
      event: result.alert,
    },
  };
}

export function createMovementsRouter({ inventoryService, inventoryRepo, auth }) {
  const router = Router();

  /** POST /movements — report a stock movement. */
  router.post(
    '/',
    auth.requireStore,
    validate(movementSchema),
    auth.assertOwnStore,
    (req, res) => {
      const body = req.validated.body;
      const result = inventoryService.applyMovement(toCommand(body, req.auth.store.id));
      const product = inventoryRepo.findProduct(body.sku);

      res.status(201).json(movementResponse(result, product));
    },
  );

  /** GET /movements — movement history, optionally filtered. */
  router.get('/', validate(movementsQuerySchema, 'query'), (req, res) => {
    const query = req.validated.query;
    const { limit, offset, page, pageSize } = toLimitOffset(query);

    const { rows, total } = inventoryService.listMovements({
      storeId: query.store_id,
      sku: query.sku,
      type: query.type,
      from: query.from,
      to: query.to,
      limit,
      offset,
    });

    res.json({
      data: rows.map(toMovementDTO),
      meta: paginationMeta({ page, pageSize, total }),
    });
  });

  return router;
}
