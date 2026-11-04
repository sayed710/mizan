import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { accountId, journalItems } from './models/ledger.js';
import { postMove, payMove } from './models/accounting.js';
import { postPayment, reversePayment } from './models/pay.js';
import { agedBalance } from './models/finance.js';
import { unrealizedExchange } from './models/closing.js';
import { cashFlow, partnerLedger } from './models/reports.js';
const invoice = (db, partner, date, account, currency) => { const m = create(db, 'account.move', { move_type: 'out_invoice', partner_id: partner, invoice_date: date, invoice_date_due: date, currency_id: currency, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0, account_id: account }] }); return { id: m.id, db: postMove(m.db, m.id) }; };
const apply = (db, id, move, date, amount) => write(db, 'account.move', id, { amount_paid: amount, payment_date: date, payments: [{ date, amount, move_id: move, company_amount: amount }] });

test('cash flow consumes overpayment once and reclassifies later application and reversal', () => {
  let db = seed(); const asset = accountId(db, '151000');
  const first = invoice(db, 1, '2026-01-01', asset); db = payMove(first.db, first.id, 150, '2026-01-02');
  const payment = search(db, 'account.payment').find((p) => p.invoice_id === first.id);
  let flow = cashFlow(db, { from: '2026-01-02', to: '2026-01-02' });
  assert.deepEqual([flow.investing, flow.operating, flow.net], [100, 50, 150]);
  const second = invoice(db, 1, '2026-01-03', asset); db = apply(second.db, second.id, payment.move_id, '2026-01-04', 50);
  flow = cashFlow(db, { from: '2026-01-02', to: '2026-01-04' });
  assert.deepEqual([flow.investing, flow.operating, flow.net], [150, 0, 150]);
  db = reversePayment(db, read(db, 'account.payment', payment.id), '2026-01-05');
  flow = cashFlow(db, { from: '2026-01-02', to: '2026-01-05' });
  assert.deepEqual([flow.investing, flow.operating, flow.net], [0, 0, 0]);
});

test('posted reversal entry date controls aging and revaluation and cannot be changed by write', () => {
  let db = seed(); const fx = create(db, 'res.currency', { name: 'FXTEST', rate_ids: [{ date: '2026-01-01', rate: 2 }] }); db = fx.db;
  const inv = invoice(db, 1, '2026-01-01', null, fx.id); db = payMove(inv.db, inv.id, 40, '2026-01-10');
  const payment = search(db, 'account.payment').find((p) => p.invoice_id === inv.id); db = reversePayment(db, payment, '2026-01-20');
  const m = read(db, 'account.move', inv.id);
  assert.throws(() => write(db, 'account.move', inv.id, { payments: m.payments.map((p) => ({ ...p, reversal_date: '2026-01-12' })) }), /revers|payment/i);
  assert.equal(agedBalance(db, 'receivable', '2026-01-15').rows.find((r) => r.partner_id === 1).total, 30);
  assert.equal(unrealizedExchange(db, '2026-01-15').find((r) => r.invoice_id === inv.id).residual, 60);
  assert.equal(unrealizedExchange(db, '2026-01-21').find((r) => r.invoice_id === inv.id).residual, 100);
});

test('aged balances reflect a partially applied advance at each cutoff', () => {
  let db = seed(); const advance = create(db, 'account.payment', { partner_id: 1, partner_type: 'customer', payment_type: 'inbound', amount: 70, date: '2026-01-01' }); db = postPayment(advance.db, read(advance.db, 'account.payment', advance.id));
  const inv = invoice(db, 1, '2026-01-02'); db = apply(inv.db, inv.id, read(db, 'account.payment', advance.id).move_id, '2026-01-03', 40);
  const total = (date) => agedBalance(db, 'receivable', date).rows.find((r) => r.partner_id === 1)?.total ?? 0;
  assert.equal(total('2026-01-01'), -70); assert.equal(total('2026-01-02'), 30); assert.equal(total('2026-01-03'), 30);
  const before = agedBalance(db, 'receivable', '2026-01-02').rows.find((r) => r.partner_id === 1);
  assert.equal(before.current, 100); assert.equal(before['1_30'], -70);
  const after = agedBalance(db, 'receivable', '2026-01-03').rows.find((r) => r.partner_id === 1);
  assert.equal(after['1_30'], 30);
  assert.equal(read(db, 'account.move', inv.id).amount_residual, 60);
});

test('vendor bill overpayment and reversal preserve outstanding operating credit', () => {
  let db = seed(); const asset = accountId(db, '151000');
  const bill = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, invoice_date: '2026-01-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0, account_id: asset }] });
  db = payMove(postMove(bill.db, bill.id), bill.id, 150, '2026-01-02');
  let flow = cashFlow(db, { from: '2026-01-02', to: '2026-01-02' });
  assert.deepEqual([flow.investing, flow.operating, flow.net], [-100, -50, -150]);
  const payment = search(db, 'account.payment').find((p) => p.invoice_id === bill.id);
  db = reversePayment(db, payment, '2026-01-03');
  flow = cashFlow(db, { from: '2026-01-02', to: '2026-01-03' });
  assert.deepEqual([flow.investing, flow.operating, flow.net], [0, 0, 0]);
});

test('revaluation uses stored dated allocations and matches the ledger at partial payment and reversal cutoffs', () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Revaluation partner' }); db = partner.db;
  const currency = create(db, 'res.currency', { name: 'REVAL_ALLOC', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-01-05', rate: 1 }] }); db = currency.db;
  const inv = create(db, 'account.move', { move_type: 'out_invoice', partner_id: partner.id, currency_id: currency.id, invoice_date: '2026-01-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 0.03, tax: 0 }] });
  db = postMove(inv.db, inv.id);
  db = payMove(db, inv.id, 0.01, '2026-01-02');
  db = payMove(db, inv.id, 0.01, '2026-01-03');
  const account = accountId(db, '121000');
  const ledger = (source, at) => Math.round(journalItems(source, { to: at }).filter((l) => l.partner_id === partner.id && l.account_id === account).reduce((sum, l) => sum + (l.debit || 0) - (l.credit || 0), 0) * 100) / 100;

  // Cutoff 2026-01-01 (before payments): residual 0.03, booked 0.02
  let row = unrealizedExchange(db, '2026-01-01').find((r) => r.invoice_id === inv.id);
  assert.equal(row.residual, 0.03);
  assert.equal(row.booked, 0.02);
  assert.equal(row.booked, ledger(db, '2026-01-01'));

  // Cutoff 2026-01-02 (after first payment of 0.01, allocated 0.01): residual 0.02, booked 0.01
  row = unrealizedExchange(db, '2026-01-02').find((r) => r.invoice_id === inv.id);
  assert.equal(row.residual, 0.02);
  assert.equal(row.booked, 0.01);
  assert.equal(row.booked, ledger(db, '2026-01-02'));

  // Cutoff 2026-01-03 (after second payment of 0.01, allocated 0.00): residual 0.01, booked 0.01
  row = unrealizedExchange(db, '2026-01-03').find((r) => r.invoice_id === inv.id);
  assert.equal(row.residual, 0.01);
  assert.equal(row.booked, 0.01);
  assert.equal(row.booked, ledger(db, '2026-01-03'));

  // Also verify legacy data where company_amount is not stored
  const legacy = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => m.id !== inv.id ? m : { ...m, payments: m.payments.map(({ company_amount, ...p }) => p) }) } };
  for (const date of ['2026-01-01', '2026-01-02', '2026-01-03']) {
    const legRow = unrealizedExchange(legacy, date).find((r) => r.invoice_id === inv.id);
    assert.equal(legRow.booked, ledger(legacy, date), `Legacy booked at ${date} must match ledger`);
  }

  // Reverse the first payment on 2026-01-04
  const firstPayment = search(db, 'account.payment').find((p) => p.invoice_id === inv.id && p.date === '2026-01-02');
  db = reversePayment(db, firstPayment, '2026-01-04');

  // Cutoff 2026-01-04: first payment reversed, second payment (allocated 0.00) remains active -> residual 0.02, booked 0.02
  row = unrealizedExchange(db, '2026-01-04').find((r) => r.invoice_id === inv.id);
  assert.equal(row.residual, 0.02);
  assert.equal(row.booked, 0.02);
  assert.equal(row.booked, ledger(db, '2026-01-04'));
});

test('advance dated before the invoice shows unapplied at reports cutoffs between the dates', () => {
  let db = seed();
  const asset = accountId(db, '151000');
  // 1. Advance customer payment of 100 received on 2026-01-02
  const advance = create(db, 'account.payment', {
    partner_id: 1,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 100,
    date: '2026-01-02',
  });
  db = postPayment(advance.db, read(advance.db, 'account.payment', advance.id));
  const advancePayment = read(db, 'account.payment', advance.id);

  // 2. Invoice dated later: 2026-01-10 (asset sale)
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-01-10',
    invoice_date_due: '2026-01-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0, account_id: asset }],
  });
  db = postMove(inv.db, inv.id);

  // 3. Apply the earlier advance to the later invoice with application date 2026-01-02 (before invoice date!)
  db = write(db, 'account.move', inv.id, {
    amount_paid: 100,
    payment_date: '2026-01-02',
    payments: [{ date: '2026-01-02', amount: 100, move_id: advancePayment.move_id, company_amount: 100 }],
  });

  // 4. Reports at cutoff between the two dates (2026-01-05):
  // Aging shows advance unapplied (-100 credit for customer, invoice not aged yet)
  const agedMid = agedBalance(db, 'receivable', '2026-01-05');
  const partnerRow = agedMid.rows.find((r) => r.partner_id === 1);
  assert.equal(partnerRow?.total, -100, 'Customer aged balance at 2026-01-05 must show unapplied advance credit');

  // Cash flow between 2026-01-02 and 2026-01-05 shows cash as operating (unapplied advance, NOT investing!)
  const flowMid = cashFlow(db, { from: '2026-01-02', to: '2026-01-05' });
  assert.deepEqual([flowMid.investing, flowMid.operating, flowMid.net], [0, 100, 100]);

  // Partner ledger at 2026-01-05 reflects unapplied advance credit (-100 ending balance)
  const plMid = partnerLedger(db, { from: '2026-01-02', to: '2026-01-05' });
  assert.equal(plMid.find((r) => r.partner_id === 1)?.end, -100);

  // 5. Reports on or after the invoice date (2026-01-10):
  // Aging shows invoice settled and advance applied (total 0)
  const agedAfter = agedBalance(db, 'receivable', '2026-01-10');
  assert.equal(agedAfter.rows.find((r) => r.partner_id === 1)?.total ?? 0, 0);

  // Cash flow now reclassifies the advance cash to investing (100 investing, 0 operating)
  const flowAfter = cashFlow(db, { from: '2026-01-02', to: '2026-01-10' });
  assert.deepEqual([flowAfter.investing, flowAfter.operating, flowAfter.net], [100, 0, 100]);
});
