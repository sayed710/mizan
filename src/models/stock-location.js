// Read-only lookup shared by stock availability, valuation and scrap.
import { read } from '../orm.js';

/** Warehouse stock location, or the first internal location of the company. */
export function defaultStockLocationId(db, company, { requireExisting = false } = {}) {
  const warehouse = (db.records['stock.warehouse'] ?? []).find((w) => (w.company_id ?? 1) === company && w.lot_stock_id);
  const id = warehouse?.lot_stock_id;
  // Quant initialization historically falls back if a warehouse references a missing location.
  if (id && (!requireExisting || read(db, 'stock.location', id))) return id;
  return (db.records['stock.location'] ?? []).find((l) => l.usage === 'internal' && (l.company_id ?? 1) === company)?.id;
}
