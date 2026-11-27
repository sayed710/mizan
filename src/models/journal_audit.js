import { round } from '../money.js';
import { isNonZeroBaseGridLine } from './taxes.js';

/** Journal items and signed tax totals in the requested period and company, ordered by date or by entry number. */
export function journalAudit(db, { from = '', to = '', companyId = null, sort = 'date', includeDraft = false, includePayments = true } = {}) {
  const groups = new Map();
  const tags = new Map((db.records['account.account.tag'] ?? []).map((tag) => [tag.id, tag]));
  const journals = new Map((db.records['account.journal'] ?? []).map((j) => [j.id, j]));
  const byNumber = (a, b) => (a.move.name ?? '').localeCompare(b.move.name ?? '', undefined, { numeric: true });
  const byDate = (a, b) => a.date.localeCompare(b.date);
  const compareItems = (a, b) => (sort === 'number' ? byNumber(a, b) || byDate(a, b) : byDate(a, b) || (a.move.name ?? '').localeCompare(b.move.name ?? '')) || (a.move.id ?? 0) - (b.move.id ?? 0);
  const paymentMoves = new Set((db.records['account.payment'] ?? []).map((payment) => payment.move_id).filter(Boolean));
  for (const move of db.records['account.move'] ?? []) {
    const date = move.date ?? move.invoice_date ?? '';
    if (!(move.state === 'posted' || (includeDraft && move.state === 'draft')) || (!includePayments && paymentMoves.has(move.id)) || (from && date < from) || (to && date > to) || (companyId && (move.company_id ?? 1) !== companyId)) continue;
    const journal = journals.get(move.journal_id);
    if (!journal) continue;
    let group = groups.get(journal.id);
    if (!group) { group = { journal, items: [], count: 0, to_review: 0, debit: 0, credit: 0, taxes: new Map(), grids: new Map() }; groups.set(journal.id, group); }
    group.count += 1;
    if (move.to_check) group.to_review += 1;
    for (const line of move.line_ids ?? []) {
      const debit = Number(line.debit) || 0, credit = Number(line.credit) || 0;
      group.debit = round(group.debit + debit); group.credit = round(group.credit + credit);
      group.items.push({ move, line, date });
      for (const id of new Set(line.tax_tag_ids ?? [])) {
        const tag = tags.get(id);
        if (!tag) continue;
        const grid = group.grids.get(id) ?? { id, name: tag.name, amount: 0 };
        grid.amount = round(grid.amount + debit - credit);
        group.grids.set(id, grid);
      }
      if (line.tax_name && !isNonZeroBaseGridLine(line)) {
        const side = line.tax_side || (String(move.move_type).startsWith('in_') ? 'purchase' : 'sale');
        const amount = line.tax_zero ? 0 : side === 'purchase' ? debit - credit : credit - debit;
        const taxId = line.tax_id ?? null;
        const taxKey = taxId == null ? JSON.stringify([null, line.tax_name]) : JSON.stringify([taxId]);
        const tax = group.taxes.get(taxKey) ?? { tax_id: taxId, name: line.tax_name, base: 0, tax: 0 };
        tax.base = round(tax.base + (amount < 0 ? -1 : 1) * (Number(line.tax_base) || 0));
        tax.tax = round(tax.tax + amount);
        group.taxes.set(taxKey, tax);
      }
    }
  }
  return [...groups.values()].map((g) => ({
    ...g,
    balance: round(g.debit - g.credit),
    items: g.items.sort(compareItems),
    grids: [...g.grids.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id),
    taxes: [...g.taxes.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.tax_id ?? 0) - (b.tax_id ?? 0)).map(({ tax_id, ...row }) => {
      Object.defineProperty(row, 'tax_id', { value: tax_id });
      return row;
    }),
  }));
}
