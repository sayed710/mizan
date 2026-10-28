// Pagination for list and kanban views (Odoo's default page is 80 records, kanban columns load 40 at a time).
export const PAGE_SIZE = 80;
export const COLUMN_SIZE = 40;

/** Visible window for `total` records starting at `offset`, clamped so a shrinking list never shows an empty page. */
export function pageWindow(total, offset = 0, limit = PAGE_SIZE) {
  const last = total ? Math.floor((total - 1) / limit) * limit : 0;
  const start = Math.min(Math.max(0, offset), last);
  const end = Math.min(total, start + limit);
  return { start, end, total, prev: start > 0 ? Math.max(0, start - limit) : null, next: end < total ? end : null, label: total ? `${start + 1}-${end}` : '0' };
}
