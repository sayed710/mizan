import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { payMove, postMove } from './models/accounting.js';
import { accountId, journalId } from './models/ledger.js';
import { revalueForeignBalances } from './models/closing.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

test('foreign invoice payments revalue bank liquidity only for matching foreign journals', () => {
  for (const matching of [false, true]) {
    const currency = create(seed(), 'res.currency', { name: 'Test foreign currency', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }] });
    const journal = journalId(currency.db, 'BNK1');
    let db = matching ? write(currency.db, 'account.journal', journal, { currency_id: currency.id }) : currency.db;
    const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, currency_id: currency.id, invoice_date: '2026-01-01', invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax: 0 }] });
    db = payMove(postMove(invoice.db, invoice.id), invoice.id, 120, '2026-01-10', { journalId: journal, directBank: true });
    const payment = search(db, 'account.payment').find((p) => p.invoice_id === invoice.id);
    const entry = read(db, 'account.move', payment.move_id);
    const bank = accountId(db, '101401');
    const liquidity = entry.line_ids.find((line) => line.account_id === bank);
    assert.equal(liquidity.currency_id ?? null, matching ? currency.id : null);
    if (matching) assert.equal(liquidity.amount_currency, 120);
    const counterpart = entry.line_ids.filter((line) => line.account_id === accountId(db, '121000'));
    assert.deepEqual(counterpart.map((line) => [line.currency_id, line.amount_currency]), [[currency.id, -100], [currency.id, -20]]);
    const revalued = revalueForeignBalances(db, '2026-02-28');
    const adjustment = search(revalued, 'account.move').find((move) => move.revaluation_date === '2026-02-28');
    assert.equal(adjustment?.line_ids.find((line) => line.account_id === bank)?.debit ?? 0, matching ? 60 : 0);
  }
});

test('many2one journal picker filters by invoice domain while retaining its current value', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { FieldInput } = await import('./ui.jsx');
  const { models } = await import('./models/index.js');
  let db = seed();
  const acc = (code) => db.records['account.account'].find((a) => a.code === code).id;
  const sale = create(db, 'account.journal', { name: 'Local sale option', code: 'RSAL', type: 'sale', company_id: 1, default_account_id: acc('400000') });
  const purchase = create(sale.db, 'account.journal', { name: 'Local purchase option', code: 'RPUR', type: 'purchase', company_id: 1, default_account_id: acc('600000') });
  const bank = create(purchase.db, 'account.journal', { name: 'Local bank option', code: 'RBAN', type: 'bank', company_id: 1, suspense_account_id: acc('101404') });
  const foreign = create(bank.db, 'account.journal', { name: 'Other company sale option', code: 'ROTH', type: 'sale', company_id: 2, default_account_id: acc('400000') });
  db = foreign.db;
  const field = models['account.move'].fields.journal_id;
  const render = (move_type, value) => renderToStaticMarkup(React.createElement(FieldInput, { db, field, value, record: { company_id: 1, move_type }, onChange: () => {} }));
  const invoice = render('out_invoice', null);
  assert.match(invoice, /Local sale option/);
  assert.doesNotMatch(invoice, /Local purchase option|Local bank option|Other company sale option/);
  const bill = render('in_invoice', String(bank.id));
  assert.match(bill, /Local purchase option/);
  assert.match(bill, /Local bank option/);
  assert.doesNotMatch(bill, /Local sale option|Other company sale option/);
});
