import test from 'node:test';
import assert from 'node:assert/strict';
import { journalAudit } from './models/journal_audit.js';
import { readFileSync } from 'node:fs';

const db = { records: {
  'account.journal': [{ id: 1, name: 'Sales' }, { id: 2, name: 'Bank' }],
  'account.payment': [{ move_id: 4 }],
  'account.move': [
    { id: 1, journal_id: 1, state: 'posted', date: '2026-01-01', to_check: true, line_ids: [{ debit: 12, credit: 2, currency_id: 2, amount_currency: 7 }] },
    { id: 2, journal_id: 1, state: 'draft', date: '2026-01-02', line_ids: [{ debit: 5, credit: 0 }] },
    { id: 3, journal_id: 1, state: 'cancel', date: '2026-01-03', line_ids: [{ debit: 99 }] },
    { id: 4, journal_id: 2, state: 'posted', date: '2026-01-04', line_ids: [{ debit: 0, credit: 3 }] },
  ],
} };

test('journal audit counts moves and entries to review, and balances totals', () => {
  const [sales, bank] = journalAudit(db);
  assert.equal(sales.count, 1); assert.equal(sales.to_review, 1);
  assert.equal(bank.count, 1); assert.equal(bank.to_review, 0);
  assert.equal(sales.balance, sales.debit - sales.credit);
  assert.equal(sales.items[0].line.amount_currency, 7);
});
test('draft and payment options filter whole moves', () => {
  const groups = journalAudit(db, { includeDraft: true, includePayments: false });
  assert.equal(groups.length, 1); assert.equal(groups[0].count, 2);
  assert.deepEqual(groups[0].items.map((item) => item.move.id), [1, 2]);
});
test('new labels have Arabic translations', () => {
  const source = readFileSync(new URL('./i18n.js', import.meta.url), 'utf8');
  for (const label of ['Include Payments', 'Draft Entries', 'To Review']) assert.match(source, new RegExp(`'${label}': '[\\u0600-\\u06ff ]+'`));
});

import { journalAuditExportRows } from './models/journal_audit_export.js';

test('tax grids total tagged line balances per journal and export all filtered details', () => {
  const fixture = { records: { ...db.records,
    'account.account.tag': [{ id: 8, name: 'Grid A' }, { id: 9, name: 'Grid zero' }],
    'account.move': db.records['account.move'].map((move) => move.id === 1 ? { ...move, name: 'S/1', line_ids: [
      { name: 'Sale', debit: 12, credit: 2, tax_tag_ids: [8, 9, 8], tax_name: 'VAT', tax_base: 10 },
      { name: 'Adjustment', debit: 0, credit: 10, tax_tag_ids: [9] },
    ] } : move),
  } };
  const [group] = journalAudit(fixture, { includePayments: false });
  assert.deepEqual(group.grids.map(({ name, amount }) => [name, amount]), [['Grid A', 10], ['Grid zero', 0]]);
  const { rows } = journalAuditExportRows(fixture, { includeDraft: true, includePayments: false });
  assert.ok(rows.some((row) => row[0].startsWith('Sales (') && row[1] === 2));
  assert.ok(rows.some((row) => row[4] === 'S/1' && row[7] === 'Sale'));
  assert.ok(rows.some((row) => row[7] === 'Adjustment'));
  assert.ok(rows.some((row) => row[0] === 'Tax Summary'));
  assert.ok(rows.some((row) => row[7] === 'VAT'));
  assert.ok(rows.some((row) => row[0] === 'Tax Grids'));
  assert.ok(rows.some((row) => row[7] === 'Grid A' && row[11] === 10));
  assert.ok(!rows.some((row) => String(row[0]).startsWith('Bank (')));
  assert.equal(rows.at(-1)[0], 'Total');
  const allRows = journalAuditExportRows(fixture).rows;
  assert.ok(allRows.some((row) => String(row[0]).startsWith('Bank (')));
  assert.equal(allRows.filter((row) => row[0] === 'Tax Grids').length, 1);
});
