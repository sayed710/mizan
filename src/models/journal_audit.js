import { round } from '../money.js';

/** Journal items and signed tax totals in the requested period and company. */
export function journalAudit(db, { from = '', to = '', companyId = null } = {}) {
  const groups = new Map();
  const journals = new Map((db.records['account.journal'] ?? []).map((j) => [j.id, j]));
  for (const move of db.records['account.move'] ?? []) {
    const date = move.date ?? move.invoice_date ?? '';
    if (move.state !== 'posted' || (from && date < from) || (to && date > to) || (companyId && (move.company_id ?? 1) !== companyId)) continue;
    const journal = journals.get(move.journal_id);
    if (!journal) continue;
    let group = groups.get(journal.id);
    if (!group) { group = { journal, items: [], debit: 0, credit: 0, taxes: new Map() }; groups.set(journal.id, group); }
    for (const line of move.line_ids ?? []) {
      const debit = Number(line.debit) || 0, credit = Number(line.credit) || 0;
      group.debit = round(group.debit + debit); group.credit = round(group.credit + credit);
      group.items.push({ move, line, date });
      if (line.tax_name) {
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
    items: g.items.sort((a, b) => a.date.localeCompare(b.date) || a.move.name.localeCompare(b.move.name)),
    taxes: [...g.taxes.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.tax_id ?? 0) - (b.tax_id ?? 0)).map(({ tax_id, ...row }) => {
      Object.defineProperty(row, 'tax_id', { value: tax_id });
      return row;
    }),
  }));
}
