/** Resolve a legacy key only when it identifies one purchase line unambiguously. */
export function purchaseLineId(db, line, orderId = null) {
  if (line.purchase_line_id != null) return line.purchase_line_id;
  if (!line.purchase_line_key) return null;
  const lines = (db.records?.['purchase.order'] ?? []).filter((order) => !orderId || order.id === orderId)
    .flatMap((order) => (order.order_line ?? []).filter((item) => item.purchase_line_key === line.purchase_line_key));
  return lines.length === 1 ? lines[0].id : null;
}
