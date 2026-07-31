/** Turns DB rows into the API's public shape (stable snake_case). */

export function toMovementDTO(row) {
  return {
    id: row.id,
    store_id: row.store_id,
    store_name: row.store_name,
    sku: row.sku,
    product_name: row.product_name,
    type: row.type,
    quantity: row.quantity,
    delta: row.delta,
    resulting_qty: row.resulting_qty,
    reason: row.reason,
    created_at: row.created_at,
  };
}

export function toAlertDTO(row) {
  return {
    id: row.id,
    sku: row.sku,
    product_name: row.product_name,
    quantity_at_trigger: row.quantity_at_trigger,
    threshold: row.threshold,
    status: row.status,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
    resolved_qty: row.resolved_qty,
  };
}

export function toProductDTO(row) {
  return {
    sku: row.sku,
    name: row.name,
    category: row.category,
    low_stock_threshold: row.low_stock_threshold,
  };
}

export function paginationMeta({ page, pageSize, total }) {
  return {
    page,
    page_size: pageSize,
    total,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Converts page/page_size into the limit/offset the repositories expect. */
export function toLimitOffset({ page, page_size: pageSize }) {
  return { limit: pageSize, offset: (page - 1) * pageSize, page, pageSize };
}
