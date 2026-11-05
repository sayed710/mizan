import './models/index.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, setActiveCompany } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { accountId, journalId } from './models/ledger.js';
import { foreignBalanceReport, revalueForeignBalances } from './models/closing.js';
import { rateAt } from './models/currency.js';
import { createCompany, ensureMainCompany } from './models/company.js';
import { consolidationModels, periodRates } from './models/consolidation.js';
import { applyDiff, diffDb } from './sync.js';

const previous = Object.fromEntries(Object.keys(consolidationModels).map((key) => [key, models[key]]));
Object.assign(models, consolidationModels);
after(() => {
  setActiveCompany(null);
  for (const [key, model] of Object.entries(previous)) {
    if (model) models[key] = model;
    else delete models[key];
  }
});

const withMoves = (db, moves) => ({ ...db, records: { ...db.records, 'account.move': moves } });
/** Submit extra moves with the posted credit note resubmitted in the same change set, as a client could. */
const submit = (db, note, moves) => {
  const d = diffDb(db, withMoves(db, [...db.records['account.move'], ...moves]));
  return applyDiff(db, { ...d, upserts: { ...d.upserts, 'account.move': [...(d.upserts?.['account.move'] ?? []), read(db, 'account.move', note)] } });
};

/** A foreign invoice credited at a different rate posts its exchange entry when the note is posted. */
function creditedAtNewRate() {
  const currency = create(seed(), 'res.currency', { name: 'Q8CFX', rate_ids: [{ date: '2037-01-01', rate: 2 }, { date: '2037-02-01', rate: 1 }] });
  const invoice = create(currency.db, 'account.move', { move_type: 'out_invoice', partner_id: 2, currency_id: currency.id, invoice_date: '2037-01-02', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  let db = postMove(invoice.db, invoice.id);
  const note = create(db, 'account.move', { move_type: 'out_refund', partner_id: 2, currency_id: currency.id, reversed_entry_id: invoice.id, invoice_date: '2037-02-02', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(note.db, note.id);
  const fx = search(db, 'account.move').find((m) => m.fx_payment_move_id === note.id && m.fx_invoice_id === invoice.id);
  assert.ok(fx);
  return { db, fx };
}

test('Qodo 7: a synced credit-note exchange entry must offset the configured exchange account', () => {
  const { db, fx } = creditedAtNewRate();
  const base = withMoves(db, db.records['account.move'].filter((m) => m.id !== fx.id));
  const exchange = new Set([read(db, 'res.company', 1).income_currency_exchange_account_id, read(db, 'res.company', 1).expense_currency_exchange_account_id]);
  const unrelated = accountId(db, '600000');
  const forged = { ...fx, line_ids: fx.line_ids.map((l) => (exchange.has(l.account_id) ? { ...l, account_id: unrelated } : l)) };
  assert.throws(() => submit(base, fx.fx_payment_move_id, [forged]), /exchange entry must match/);
  // The entry exactly as the credit note books it is still accepted.
  const synced = submit(base, fx.fx_payment_move_id, [fx]);
  assert.ok(read(synced, 'account.move', fx.id));
});

test('Qodo 8: a second exchange entry for the same credit note is rejected', () => {
  const { db, fx } = creditedAtNewRate();
  const id = Math.max(...db.records['account.move'].map((m) => m.id)) + 1;
  const duplicate = { ...fx, id, name: `${fx.name}-DUP` };
  assert.throws(() => submit(db, fx.fx_payment_move_id, [duplicate]), /already used by another settlement/);
});

let sequence = 0;
/** A foreign bank account in company 1 with a posted foreign movement. */
function bankMovement(db, { currency, date, foreign, company }) {
  const bank = accountId(db, '101401');
  const equity = accountId(db, '301000');
  const amount = Math.abs(company);
  const created = create(db, 'account.move', { name: `MISC/2026/Q8C${++sequence}`, move_type: 'entry', state: 'posted', journal_id: journalId(db, 'MISC'), invoice_date: date, line_ids: [
    { account_id: bank, debit: company > 0 ? amount : 0, credit: company < 0 ? amount : 0, currency_id: currency, amount_currency: foreign },
    { account_id: equity, debit: company < 0 ? amount : 0, credit: company > 0 ? amount : 0 },
  ] });
  return created.db;
}

test('Qodo 30: a zero foreign bank balance with a company-currency remainder is revalued to zero', () => {
  const currency = create(seed(), 'res.currency', { name: 'Q8CBANK', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }] });
  let db = bankMovement(currency.db, { currency: currency.id, date: '2026-01-05', foreign: 100, company: 50 });
  db = bankMovement(db, { currency: currency.id, date: '2026-02-05', foreign: -100, company: -100 });
  const bank = accountId(db, '101401');
  const row = foreignBalanceReport(db, '2026-02-28').find((r) => r.account_id === bank);
  assert.deepEqual([row.residual, row.booked, row.value, row.difference], [0, -50, 0, 50]);
  const done = revalueForeignBalances(db, '2026-02-28');
  const entry = search(done, 'account.move').find((m) => m.revaluation_date === '2026-02-28');
  assert.equal(entry.line_ids.find((l) => l.account_id === bank).debit, 50);
});

test('Qodo 31: a revaluation made stale by a later posting is cleared on rerun', () => {
  const currency = create(seed(), 'res.currency', { name: 'Q8CSTALE', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }] });
  const bank = accountId(currency.db, '101401');
  const first = revalueForeignBalances(bankMovement(currency.db, { currency: currency.id, date: '2026-01-05', foreign: 100, company: 50 }), '2026-02-28');
  // A later correction books the remaining company-currency value, so no difference is left at the date.
  const corrected = bankMovement(first, { currency: currency.id, date: '2026-02-10', foreign: 0, company: 50 });
  assert.equal(foreignBalanceReport(corrected, '2026-02-28').filter((r) => r.account_id === bank && r.difference).length, 0);
  const rerun = revalueForeignBalances(corrected, '2026-02-28');
  const adjustments = search(rerun, 'account.move').filter((m) => m.revaluation_date === '2026-02-28');
  assert.equal(adjustments.length, 2);
  const net = adjustments.flatMap((m) => m.line_ids).filter((l) => l.account_id === bank).reduce((sum, l) => sum + l.debit - l.credit, 0);
  assert.equal(net, 0);
  assert.equal(revalueForeignBalances(rerun, '2026-02-28'), rerun);
});

test('Qodo 45: consolidation rates use the member company\'s own exchange rates', () => {
  let db = ensureMainCompany(seed());
  const group = create(db, 'res.currency', { name: 'Q8CGROUP', rate_ids: [{ date: '2089-12-31', rate: 1 }] });
  const source = create(group.db, 'res.currency', { name: 'Q8CSOURCE', rate_ids: [{ date: '2089-12-31', rate: 2 }] });
  const member = createCompany(source.db, { name: 'Q8C member', currency_id: source.id });
  db = member.db;
  // The member keeps its own group-currency rate, which differs from the shared one.
  db = { ...db, records: { ...db.records, 'res.currency': db.records['res.currency'].map((c) => (c.id === group.id ? { ...c, rate_ids: [...c.rate_ids, { date: '2089-12-31', rate: 0.5, company_id: member.id }] } : c)) } };
  const chart = create(db, 'consolidation.chart', { name: 'Q8C', currency_id: group.id, company_ids: [{ company_id: member.id, ownership: 100, method: 'full' }], account_ids: [] });
  const period = create(chart.db, 'consolidation.period', { name: 'Day', chart_id: chart.id, date_from: '2090-01-01', date_to: '2090-01-01' });
  const own = rateAt(period.db, group.id, '2090-01-01', member.id);
  assert.notEqual(own, rateAt(period.db, group.id, '2090-01-01') / rateAt(period.db, source.id, '2090-01-01'));
  assert.deepEqual(periodRates(period.db, read(period.db, 'consolidation.period', period.id)), [{ company_id: member.id, rate_avg: own, rate_closing: own }]);
});
