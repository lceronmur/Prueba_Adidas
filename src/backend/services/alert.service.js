/**
 * Low-stock alert evaluation.
 *
 * Always called from inside the transaction that applies a movement, so a
 * stock level under the threshold can never exist without its alert.
 */
export function createAlertService({ inventoryRepo, alertRepo }) {
  /**
   * Evaluates the open/resolve rule for a product and returns the event
   * produced, or null if nothing changed.
   */
  function evaluate(sku) {
    const product = inventoryRepo.findProduct(sku);
    if (!product) return null;

    const quantity = inventoryRepo.networkQuantity(sku);
    const threshold = product.low_stock_threshold;
    const existing = alertRepo.findOpen(sku);

    if (!existing && quantity <= threshold) {
      const alert = alertRepo.open({ sku, quantity, threshold });
      return { action: 'OPENED', sku, quantity, threshold, alert_id: alert.id };
    }

    if (existing && quantity > threshold) {
      alertRepo.resolve(existing.id, quantity);
      return { action: 'RESOLVED', sku, quantity, threshold, alert_id: existing.id };
    }

    return null;
  }

  return { evaluate };
}
