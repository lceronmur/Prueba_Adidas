import { z } from 'zod';

/**
 * Input contract for a stock movement.
 *
 * Key decision: the API accepts DELTAS, never an absolute stock value.
 * `{"quantity": 42}` as a target state does not exist in this contract; a
 * client always says "3 units came in" or "3 units went out". Summing deltas
 * is commutative, so the arrival order of two concurrent reports never
 * changes the final result.
 */
export const movementSchema = z
  .object({
    // Optional and purely declarative: the effective store comes from the
    // API key. If present and it disagrees, the request is rejected with a
    // 403 instead of being silently corrected.
    store_id: z.string().min(1).max(64).optional(),
    sku: z.string().min(1).max(64),
    type: z.enum(['IN', 'OUT']),
    quantity: z.number().int().min(1),
    reason: z.string().trim().min(1).max(280).optional(),
  })
  .strict();

export const thresholdSchema = z
  .object({
    low_stock_threshold: z.number().int().min(0),
  })
  .strict();
