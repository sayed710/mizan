import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, search, read, write } from './orm.js';
import { postMove, payMove } from './models/accounting.js';
import { taxSnapshot } from './models/taxes.js';
import { taxReport, taxesByTax } from './models/finance.js';
import { payOrder, startSession } from './models/pos.js';
import { addDays, today } from './models/common.js';
import { seed } from './seed.js';
import { models } from './models/index.js';

const taxNamed = (db, name) => search(db, 'account.tax').find((t) => t.name === name && t.type_tax_use === 'sale');
const line = (db, name, vals) => ({ product_id: 1, qty: 1, price_unit: 100, discount: 0, ...taxSnapshot(taxNamed(db, name)), ...vals });
const invoice = (db, lines, vals = {}) => {
  const { db: next, id } = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: today(), invoice_line_ids: lines, ...vals });
  return { db: postMove(next, id), id };
};
const row = (rows, name) => rows.find((r) => r.side === 'sale' && r.name === name);
const period = { from: addDays(today(), -60), to: today() };
const delta = (before, after) => ({ output: Math.round((after.output - before.output) * 100) / 100, input: Math.round((after.input - before.input) * 100) / 100 });
const sumRows = (rows, side) => Math.round(rows.filter((r) => r.side === side).reduce((s, r) => s + r.tax, 0) * 100) / 100;

test('the per-tax rows add up to the return totals: foreign invoices, cash basis, POS', () => {
  let db = seed();
  const before = taxReport(db, period);
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR').id;
  // 920 EUR at 0.92 → 1000 base and 140 tax in company currency, not 128.8 in invoice currency.
  db = invoice(db, [line(db, 'VAT 14%', { price_unit: 920 })], { currency_id: eur, invoice_date: addDays(today(), -30) }).db;
  // Unpaid cash-basis tax is not due yet; half paid releases half the tax and half the base.
  const cash = invoice(db, [line(db, 'VAT 14% (Cash Basis)', { price_unit: 1000 })]);
  db = invoice(cash.db, [line(cash.db, 'VAT 14% (Cash Basis)', { price_unit: 500 })]).db;
  db = payMove(db, cash.id, 570, today());
  // POS sales book their tax per tax too.
  db = startSession(db, 0).db;
  db = payOrder(db, { lines: [line(db, 'VAT 14%', { price_unit: 50 })], method: 'cash' }).db;

  const totals = delta(before, taxReport(db, period));
  const rows = taxesByTax(db, period);
  assert.equal(totals.output, Math.round((140 + 70 + 7) * 100) / 100);
  assert.equal(sumRows(rows, 'sale'), taxReport(db, period).output);
  assert.equal(sumRows(rows, 'purchase'), taxReport(db, period).input);
  const cashRow = row(rows, 'VAT 14% (Cash Basis)');
  assert.deepEqual([cashRow.base, cashRow.tax], [500, 70]);
});

test('a taxable negative adjustment offsets the posted tax and reported base', () => {
  const db = seed();
  const posted = invoice(db, [line(db, 'VAT 14%', {}), line(db, 'VAT 14%', { price_unit: -20 })]);
  const move = read(posted.db, 'account.move', posted.id);
  const taxItem = move.line_ids.find((l) => l.tax_name === 'VAT 14%');
  assert.ok(taxItem);
  assert.equal(taxItem.credit, 11.20);
  assert.equal(taxItem.tax_base, 80);
  assert.deepEqual(row(taxesByTax(posted.db), 'VAT 14%'), { side: 'sale', name: 'VAT 14%', base: 80, tax: 11.20 });
});

test('separately taxed negative adjustments retain their signed base on invoices and refunds', () => {
  for (const [type, side, sign] of [['out_invoice', 'sale', 1], ['out_refund', 'sale', -1], ['in_invoice', 'purchase', 1], ['in_refund', 'purchase', -1]]) {
    const db = seed();
    const name = `Adjustment ${type}`;
    const tax = create(db, 'account.tax', { name, amount: 14, type_tax_use: side });
    const inv = create(tax.db, 'account.move', { move_type: type, partner_id: 1, invoice_date: today(), invoice_line_ids: [
      { qty: 1, price_unit: 100, tax: 0 },
      { qty: 1, price_unit: -20, ...taxSnapshot(read(tax.db, 'account.tax', tax.id)) },
    ] });
    const posted = models['account.move'].form.buttons.find((b) => b.label === 'Confirm').run(inv.db, read(inv.db, 'account.move', inv.id)).db;
    const item = read(posted, 'account.move', inv.id).line_ids.find((l) => l.tax_name === name);
    assert.equal(item.tax_base, -20);
    assert.deepEqual(taxesByTax(posted).find((r) => r.name === name), { side, name, base: -20 * sign, tax: -2.8 * sign }, type);
  }
});

test('historical tax items retain their side after editing and archiving the tax', () => {
  const db = seed();
  const custom = create(db, 'account.account', { code: '259999', name: 'Custom VAT', account_type: 'liability_current' });
  const tax = create(custom.db, 'account.tax', { name: 'Custom historical tax', amount: 10, type_tax_use: 'sale', account_id: custom.id });
  const posted = invoice(tax.db, [{ qty: 1, price_unit: 100, ...taxSnapshot(read(tax.db, 'account.tax', tax.id)) }]);
  const before = taxReport(tax.db, {});
  const changed = write(posted.db, 'account.tax', tax.id, { account_id: null, active: false });
  assert.equal(taxReport(changed, {}).output - before.output, 10);
  assert.deepEqual(row(taxesByTax(changed), 'Custom historical tax'), { side: 'sale', name: 'Custom historical tax', base: 100, tax: 10 });
});

test('sales and purchases using the same tax account remain on their own sides', () => {
  const db = seed();
  const account = db.records['account.account'].find((a) => a.code === '251000').id;
  const tax = create(db, 'account.tax', { name: 'Shared input', amount: 10, type_tax_use: 'purchase', account_id: account });
  const posted = invoice(tax.db, [{ qty: 1, price_unit: 100, ...taxSnapshot(read(tax.db, 'account.tax', tax.id)) }], { move_type: 'in_invoice' });
  const before = taxReport(tax.db, {});
  const after = taxReport(posted.db, {});
  assert.equal(after.input - before.input, 10);
  assert.equal(after.output, before.output);
});

test('the final cash-basis release clears the taxable base rounding remainder', () => {
  const db = seed();
  const posted = invoice(db, [line(db, 'VAT 14% (Cash Basis)', { price_unit: 100 })]);
  let paid = posted.db;
  for (let i = 0; i < 3; i++) paid = payMove(paid, posted.id, 38, today());
  assert.deepEqual(row(taxesByTax(paid), 'VAT 14% (Cash Basis)'), { side: 'sale', name: 'VAT 14% (Cash Basis)', base: 100, tax: 14 });
});

test('reversing a final cash-basis payment removes its exact rounded release', () => {
  const button = (model, name) => models[model].form.buttons.find((b) => b.label === name);
  const confirm = (db, model, id) => button(model, 'Confirm').run(db, read(db, model, id)).db;
  for (const [type, side, sign] of [['out_invoice', 'sale', 1], ['out_refund', 'sale', -1], ['in_invoice', 'purchase', 1], ['in_refund', 'purchase', -1]]) {
    for (const direct of [true, false]) {
      let db = seed();
      const name = `Rounding ${type} ${direct}`;
      const tax = create(db, 'account.tax', { name, amount: 14, type_tax_use: side, tax_exigibility: 'on_payment' });
      const inv = create(tax.db, 'account.move', { move_type: type, partner_id: 1, invoice_date: today(), invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(read(tax.db, 'account.tax', tax.id)) }] });
      db = confirm(inv.db, 'account.move', inv.id);
      let last;
      for (let i = 0; i < 3; i++) {
        const payment = create(db, 'account.payment', { partner_id: 1, ...(direct ? { invoice_id: inv.id } : {}), amount: 38, date: today(), partner_type: side === 'sale' ? 'customer' : 'supplier', payment_type: (side === 'sale') === (sign === 1) ? 'inbound' : 'outbound' });
        db = confirm(payment.db, 'account.payment', payment.id);
        last = payment.id;
      }
      assert.deepEqual(taxesByTax(db).find((r) => r.name === name), { side, name, base: sign * 100, tax: sign * 14 });
      db = button('account.payment', 'Reverse').run(db, read(db, 'account.payment', last)).db;
      assert.deepEqual(taxesByTax(db).find((r) => r.name === name), { side, name, base: sign * 66.66, tax: sign * 9.34 }, `${type}, direct=${direct}`);
    }
  }
});

test('legacy final payment reversal removes the original rounded cash-basis release', () => {
  const button = (model, name) => models[model].form.buttons.find((b) => b.label === name);
  let db = seed();
  const tax = create(db, 'account.tax', { name: 'Legacy cash rounding', amount: 14, type_tax_use: 'sale', tax_exigibility: 'on_payment' });
  const inv = create(tax.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: today(), invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(read(tax.db, 'account.tax', tax.id)) }] });
  db = button('account.move', 'Confirm').run(inv.db, read(inv.db, 'account.move', inv.id)).db;
  let last;
  for (let i = 0; i < 3; i++) {
    const payment = create(db, 'account.payment', { partner_id: 1, invoice_id: inv.id, amount: 38, date: today(), payment_type: 'inbound' });
    db = button('account.payment', 'Confirm').run(payment.db, read(payment.db, 'account.payment', payment.id)).db;
    last = payment.id;
  }
  const invoiceName = read(db, 'account.move', inv.id).name;
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => {
    if (m.id === inv.id) return { ...m, payments: m.payments.map(({ cash_basis_move_id, ...payment }) => payment) };
    if (m.ref === `Cash basis taxes ${invoiceName}`) return { ...m, line_ids: m.line_ids.map(({ tax_base_signed, ...line }) => line) };
    return m;
  }) } };
  db = button('account.payment', 'Reverse').run(db, read(db, 'account.payment', last)).db;
  assert.deepEqual(row(taxesByTax(db), 'Legacy cash rounding'), { side: 'sale', name: 'Legacy cash rounding', base: 66.67, tax: 9.33 });
});

test('legacy cash-basis reversals do not inflate the final release base', () => {
  const button = (model, name) => models[model].form.buttons.find((b) => b.label === name);
  const run = (db, model, id, action) => button(model, action).run(db, read(db, model, id)).db;
  for (const [type, side, sign] of [['out_invoice', 'sale', 1], ['out_refund', 'sale', -1], ['in_invoice', 'purchase', 1], ['in_refund', 'purchase', -1]]) {
    for (const scenario of ['one', 'partial reversal', 'two legacy', 'mixed']) {
      let db = seed();
      const name = `Legacy ${type} ${scenario}`;
      const tax = create(db, 'account.tax', { name, amount: 14, type_tax_use: side, tax_exigibility: 'on_payment' });
      const inv = create(tax.db, 'account.move', { move_type: type, partner_id: 1, invoice_date: today(), invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(read(tax.db, 'account.tax', tax.id)) }] });
      db = run(inv.db, 'account.move', inv.id, 'Confirm');
      const pay = (amount, legacy) => {
        const p = create(db, 'account.payment', { partner_id: 1, invoice_id: inv.id, amount, date: today(), partner_type: side === 'sale' ? 'customer' : 'supplier', payment_type: (side === 'sale') === (sign === 1) ? 'inbound' : 'outbound' });
        db = run(p.db, 'account.payment', p.id, 'Confirm');
        if (legacy) {
          const invoice = read(db, 'account.move', inv.id);
          const releaseId = invoice.payments.at(-1).cash_basis_move_id;
          db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => {
            if (m.id === inv.id) return { ...m, payments: m.payments.map((allocation) => {
              if (allocation.cash_basis_move_id !== releaseId) return allocation;
              const { cash_basis_move_id, ...old } = allocation;
              return old;
            }) };
            if (m.id === releaseId) return { ...m, line_ids: m.line_ids.map(({ tax_base_signed, ...line }) => line) };
            return m;
          }) } };
          assert.equal(read(db, 'account.move', releaseId).line_ids.find((l) => l.tax_name === name).tax_base_signed, undefined);
        }
        return p.id;
      };
      const first = pay(38, true);
      if (scenario !== 'one') pay(38, scenario !== 'mixed');
      db = run(db, 'account.payment', first, 'Reverse');
      if (scenario === 'two legacy') {
        const second = search(db, 'account.payment').filter((p) => p.invoice_id === inv.id && p.state === 'posted').at(-1);
        db = run(db, 'account.payment', second.id, 'Reverse');
      }
      pay(read(db, 'account.move', inv.id).amount_residual, false);
      assert.deepEqual(taxesByTax(db).find((r) => r.name === name && r.side === side), { side, name, base: sign * 100, tax: sign * 14 }, `${type}: ${scenario}`);
    }
  }
});

test('rounded-to-zero cash-basis tax bases are released on payment for invoices and refunds', () => {
  const confirm = (db, model, id) => models[model].form.buttons.find((b) => b.label === 'Confirm').run(db, read(db, model, id)).db;
  for (const [type, side, sign] of [['out_invoice', 'sale', 1], ['out_refund', 'sale', -1], ['in_invoice', 'purchase', 1], ['in_refund', 'purchase', -1]]) {
    let db = seed();
    const tax = create(db, 'account.tax', { name: `Micro cash ${type}`, amount: 1, type_tax_use: side, tax_exigibility: 'on_payment' });
    const inv = create(tax.db, 'account.move', { move_type: type, partner_id: 1, invoice_date: today(), invoice_line_ids: [{ qty: 1, price_unit: 0.10, ...taxSnapshot(read(tax.db, 'account.tax', tax.id)) }] });
    db = confirm(inv.db, 'account.move', inv.id);
    const posted = read(db, 'account.move', inv.id);
    const transition = posted.line_ids.find((l) => l.tax_name === `Micro cash ${type}`);
    assert.ok(transition, `${type}: transition item retained`);
    assert.equal(transition.tax_base, sign * 0.10);
    assert.equal(transition.debit + transition.credit, 0);
    assert.equal(transition.tax_side, undefined);
    assert.equal(taxesByTax(db).find((r) => r.name === `Micro cash ${type}`), undefined, `${type}: not due before payment`);
    for (const [amount, expected] of [[0.03, 0.03], [0.07, 0.10]]) {
      const payment = create(db, 'account.payment', { partner_id: 1, invoice_id: inv.id, amount, date: today(), partner_type: side === 'sale' ? 'customer' : 'supplier', payment_type: (side === 'sale') === (sign === 1) ? 'inbound' : 'outbound' });
      db = confirm(payment.db, 'account.payment', payment.id);
      assert.deepEqual(taxesByTax(db).find((r) => r.name === `Micro cash ${type}`), { side, name: `Micro cash ${type}`, base: sign * expected, tax: 0 }, `${type}: released base`);
      const releases = search(db, 'account.move').filter((m) => m.ref === `Cash basis taxes ${posted.name}`);
      assert.ok(releases.some((m) => m.line_ids.some((l) => l.tax_name === `Micro cash ${type}` && l.tax_side === side && l.tax_base === sign * amount)), `${type}: posted release`);
    }
  }
});

test('negative cash-basis groups release and reverse with signed bases on invoices and refunds', () => {
  const button = (model, name) => models[model].form.buttons.find((b) => b.label === name);
  const confirm = (db, model, id) => button(model, 'Confirm').run(db, read(db, model, id)).db;
  for (const [type, side, sign] of [['out_invoice', 'sale', 1], ['out_refund', 'sale', -1], ['in_invoice', 'purchase', 1], ['in_refund', 'purchase', -1]]) {
    let db = seed();
    const name = `Negative cash ${type}`;
    const tax = create(db, 'account.tax', { name, amount: 14, type_tax_use: side, tax_exigibility: 'on_payment' });
    const inv = create(tax.db, 'account.move', { move_type: type, partner_id: 1, invoice_date: today(), invoice_line_ids: [
      { qty: 1, price_unit: 100, tax: 0 },
      { qty: 1, price_unit: -20, ...taxSnapshot(read(tax.db, 'account.tax', tax.id)) },
    ] });
    db = confirm(inv.db, 'account.move', inv.id);
    const posted = read(db, 'account.move', inv.id);
    const transition = posted.line_ids.find((l) => l.tax_name === name);
    assert.ok(transition, type);
    assert.equal(transition.tax_base, -20);
    assert.equal(taxesByTax(db).find((r) => r.name === name), undefined);
    const before = taxReport(db);
    const pay = (amount) => create(db, 'account.payment', { partner_id: 1, invoice_id: inv.id, amount, date: today(), partner_type: side === 'sale' ? 'customer' : 'supplier', payment_type: (side === 'sale') === (sign === 1) ? 'inbound' : 'outbound' });
    const first = pay(38.60);
    db = confirm(first.db, 'account.payment', first.id);
    const check = (base, taxAmount) => {
      assert.deepEqual(taxesByTax(db).find((r) => r.name === name), { side, name, base: base * sign || 0, tax: taxAmount * sign || 0 }, type);
      const totals = delta(before, taxReport(db));
      assert.equal(totals[side === 'sale' ? 'output' : 'input'], taxAmount * sign || 0, type);
    };
    check(-10, -1.4);
    const release = search(db, 'account.move').find((m) => m.ref === `Cash basis taxes ${posted.name}`);
    const item = release.line_ids.find((l) => l.tax_name === name);
    assert.equal(item.tax_base, -10 * sign);
    assert.equal((item.debit - item.credit) * (side === 'sale' ? -1 : 1), -1.4 * sign);
    assert.equal(release.line_ids.reduce((sum, l) => sum + l.debit - l.credit, 0), 0);
    db = button('account.payment', 'Reverse').run(db, read(db, 'account.payment', first.id)).db;
    check(0, 0);
    for (const amount of [38.60, 38.60]) {
      const payment = pay(amount);
      db = confirm(payment.db, 'account.payment', payment.id);
    }
    check(-20, -2.8);
    const releases = search(db, 'account.move').filter((m) => m.ref === `Cash basis taxes ${posted.name}`);
    const transitionBalance = [transition, ...releases.flatMap((m) => m.line_ids.filter((l) => l.account_id === transition.account_id))].reduce((sum, l) => sum + l.debit - l.credit, 0);
    assert.ok(Math.abs(transitionBalance) < 0.001, `${type}: transition cleared`);
  }
});

test('cash-basis base survives a zero-tax partial release and payment reversal', () => {
  let db = seed();
  const tax = create(db, 'account.tax', { name: 'Small cash refund', amount: 14, type_tax_use: 'sale', tax_exigibility: 'on_payment' });
  const inv = create(tax.db, 'account.move', { move_type: 'out_refund', partner_id: 1, invoice_date: today(), invoice_line_ids: [{ qty: 1, price_unit: 0.10, ...taxSnapshot(read(tax.db, 'account.tax', tax.id)) }] });
  const button = (model, name) => models[model].form.buttons.find((b) => b.label === name);
  db = button('account.move', 'Confirm').run(inv.db, read(inv.db, 'account.move', inv.id)).db;
  const payment = create(db, 'account.payment', { partner_id: 1, invoice_id: inv.id, amount: 0.03, payment_type: 'outbound', date: today() });
  db = button('account.payment', 'Confirm').run(payment.db, read(payment.db, 'account.payment', payment.id)).db;
  assert.deepEqual(row(taxesByTax(db), 'Small cash refund'), { side: 'sale', name: 'Small cash refund', base: -0.03, tax: 0 });
  db = button('account.payment', 'Reverse').run(db, read(db, 'account.payment', payment.id)).db;
  assert.deepEqual(row(taxesByTax(db), 'Small cash refund'), { side: 'sale', name: 'Small cash refund', base: 0, tax: 0 });
  const final = create(db, 'account.payment', { partner_id: 1, invoice_id: inv.id, amount: 0.11, payment_type: 'outbound', date: today() });
  db = button('account.payment', 'Confirm').run(final.db, read(final.db, 'account.payment', final.id)).db;
  assert.deepEqual(row(taxesByTax(db), 'Small cash refund'), { side: 'sale', name: 'Small cash refund', base: -0.10, tax: -0.01 });
});

test('zero-rated exports keep a durable taxable base without changing return totals', () => {
  const db = seed();
  const tax = create(db, 'account.tax', { name: 'Zero export', amount: 0, type_tax_use: 'sale' });
  const posted = invoice(tax.db, [{ qty: 1, price_unit: 100, ...taxSnapshot(read(tax.db, 'account.tax', tax.id)) }]);
  assert.deepEqual(taxReport(posted.db, {}), taxReport(tax.db, {}));
  assert.deepEqual(row(taxesByTax(posted.db), 'Zero export'), { side: 'sale', name: 'Zero export', base: 100, tax: 0 });
});

test('without new documents the return and its rows still reconcile on the seeded data', () => {
  const db = seed();
  const r = taxReport(db, {});
  const rows = taxesByTax(db, {});
  assert.equal(sumRows(rows, 'sale'), r.output);
  assert.equal(sumRows(rows, 'purchase'), r.input);
});

test('unnamed zero-rated lines and small nonzero taxes rounded to zero retain taxable bases on sales, purchases and refunds', () => {
  let db = seed();
  // 1. Sales: unnamed 0% line invoice and refund
  const saleInv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 1, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(saleInv.db, saleInv.id);

  const saleRefund = create(db, 'account.move', {
    move_type: 'out_refund', partner_id: 1, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 40, tax: 0 }],
  });
  db = postMove(saleRefund.db, saleRefund.id);

  // 2. Purchases: unnamed 0% line bill and refund
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: 1, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(bill.db, bill.id);

  const billRefund = create(db, 'account.move', {
    move_type: 'in_refund', partner_id: 1, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 30, tax: 0 }],
  });
  db = postMove(billRefund.db, billRefund.id);

  // 3. Sales: nonzero tax whose journal amount rounds to zero
  const microSaleTax = create(db, 'account.tax', { name: 'Micro Sale VAT', amount: 1, type_tax_use: 'sale' });
  db = microSaleTax.db;
  const microTaxSale = read(db, 'account.tax', microSaleTax.id);

  // 0.10 * 1% = 0.001 -> rounds to 0.00 tax in ledger
  const microInv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 1, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 0.10, ...taxSnapshot(microTaxSale) }],
  });
  db = postMove(microInv.db, microInv.id);

  const microRefund = create(db, 'account.move', {
    move_type: 'out_refund', partner_id: 1, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 0.04, ...taxSnapshot(microTaxSale) }],
  });
  db = postMove(microRefund.db, microRefund.id);

  // 4. Purchases: nonzero tax whose journal amount rounds to zero
  const microPurchTax = create(db, 'account.tax', { name: 'Micro Purchase VAT', amount: 1, type_tax_use: 'purchase' });
  db = microPurchTax.db;
  const microTaxPurch = read(db, 'account.tax', microPurchTax.id);

  const microBill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: 1, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 0.10, ...taxSnapshot(microTaxPurch) }],
  });
  db = postMove(microBill.db, microBill.id);

  const microBillRefund = create(db, 'account.move', {
    move_type: 'in_refund', partner_id: 1, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 0.03, ...taxSnapshot(microTaxPurch) }],
  });
  db = postMove(microBillRefund.db, microBillRefund.id);

  const rows = taxesByTax(db, {});
  const zeroSaleRow = rows.find((r) => r.side === 'sale' && r.name === '0%');
  assert.ok(zeroSaleRow, 'unnamed 0% sale row should exist');
  assert.deepEqual(zeroSaleRow, { side: 'sale', name: '0%', base: 60, tax: 0 });

  const zeroPurchRow = rows.find((r) => r.side === 'purchase' && r.name === '0%');
  assert.ok(zeroPurchRow, 'unnamed 0% purchase row should exist');
  assert.deepEqual(zeroPurchRow, { side: 'purchase', name: '0%', base: 70, tax: 0 });

  const microSaleRow = rows.find((r) => r.side === 'sale' && r.name === 'Micro Sale VAT');
  assert.ok(microSaleRow, 'Micro Sale VAT row should exist');
  assert.deepEqual(microSaleRow, { side: 'sale', name: 'Micro Sale VAT', base: 0.06, tax: 0 });

  const microPurchRow = rows.find((r) => r.side === 'purchase' && r.name === 'Micro Purchase VAT');
  assert.ok(microPurchRow, 'Micro Purchase VAT row should exist');
  assert.deepEqual(microPurchRow, { side: 'purchase', name: 'Micro Purchase VAT', base: 0.07, tax: 0 });
});
