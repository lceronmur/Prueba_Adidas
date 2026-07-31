import { z } from 'zod';

/**
 * `z.coerce.boolean()` doesn't work here: it turns any non-empty string into
 * true, so `?low_stock=false` would also come out true. Accept explicit
 * true/false forms instead.
 */
const boolish = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
};

export const inventoryQuerySchema = z
  .object({
    store_id: z.string().min(1).optional(),
    sku: z.string().min(1).optional(),
    category: z.string().min(1).optional(),
    low_stock: boolish.optional(),
    min_qty: z.coerce.number().int().min(0).optional(),
    max_qty: z.coerce.number().int().min(0).optional(),
    group_by: z.enum(['product', 'store']).default('product'),
    ...pagination,
  })
  .strip()
  .refine((data) => data.min_qty == null || data.max_qty == null || data.min_qty <= data.max_qty, {
    message: 'min_qty cannot be greater than max_qty.',
    path: ['min_qty'],
  });

export const movementsQuerySchema = z
  .object({
    store_id: z.string().min(1).optional(),
    sku: z.string().min(1).optional(),
    type: z.enum(['IN', 'OUT']).optional(),
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    ...pagination,
  })
  .strip();

export const alertsQuerySchema = z
  .object({
    // ALL disables the filter; by default only open alerts matter.
    status: z.enum(['OPEN', 'RESOLVED', 'ALL']).default('OPEN'),
    sku: z.string().min(1).optional(),
    ...pagination,
  })
  .strip();
