import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, unlink, write } from './orm.js';
import { apps, leavesOf, models } from './models/index.js';
import { seed } from './seed.js';

const run = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id));

for (const change of ['cancel', 'delete', 'post', 'reset']) test(`regular invoice refreshes advance deduction after credit ${change}`, () => {
  const order = create(seed(), 'sale.order', { partner_id: 3, order_line: [{ product_id: 7, qty: 10, price_unit: 100, tax: 0 }] });
  let db = run(order.db, 'sale.order', order.id, 'Confirm').db;
  const button = models['sale.order'].form.buttons.find((b) => b.label === 'Create Invoice');
  db = button.run(db, read(db, 'sale.order', order.id), { method: 'fixed', amount: 500 }).db;
  const advance = search(db, 'account.move').find((m) => m.sale_id === order.id);
  db = run(db, 'account.move', advance.id, 'Confirm').db;
  if (change === 'reset') {
    const credit = create(db, 'account.move', { move_type: 'out_refund', partner_id: 3, sale_id: order.id, invoice_line_ids: advance.invoice_line_ids });
    db = run(credit.db, 'account.move', credit.id, 'Confirm').db;
  } else db = run(db, 'account.move', advance.id, 'Credit Note').db;
  const credit = search(db, 'account.move').find((m) => m.sale_id === order.id && m.move_type === 'out_refund');
  db = run(db, 'sale.order', order.id, 'Create Invoice').db;
  const invoice = search(db, 'account.move').filter((m) => m.sale_id === order.id && m.move_type === 'out_invoice').at(-1);
  assert.equal(invoice.amount_total, change === 'reset' ? 1000 : 500);
  if (change === 'delete') db = unlink(db, 'account.move', [credit.id]);
  else db = run(db, 'account.move', credit.id, { cancel: 'Cancel', post: 'Confirm', reset: 'Reset to Draft' }[change]).db;
  db = run(db, 'account.move', invoice.id, 'Confirm').db;
  assert.equal(read(db, 'account.move', invoice.id).amount_total, change === 'post' ? 1000 : 500);
  const net = search(db, 'account.move').filter((m) => m.sale_id === order.id && m.state === 'posted')
    .reduce((sum, m) => sum + (m.move_type === 'out_refund' ? -1 : 1) * m.amount_total, 0);
  assert.equal(net, 1000);
});

test('advance before partial delivery is deducted without negative invoices', () => {
  const configured = write(seed(), 'product', 7, { invoice_policy: 'delivery' });
  const order = create(configured, 'sale.order', { partner_id: 3, order_line: [{ product_id: 7, qty: 10, price_unit: 100, tax: 0 }] });
  let db = run(order.db, 'sale.order', order.id, 'Confirm').db;
  const button = models['sale.order'].form.buttons.find((b) => b.label === 'Down Payment');
  db = button.run(db, read(db, 'sale.order', order.id), { method: 'fixed', amount: 1000 }).db;
  const advance = search(db, 'account.move').find((m) => m.sale_id === order.id);
  db = run(db, 'account.move', advance.id, 'Confirm').db;
  const deliver = (qty) => { const current = read(db, 'sale.order', order.id); db = write(db, 'sale.order', order.id, { order_line: current.order_line.map((l) => ({ ...l, qty_delivered: qty })) }); };
  deliver(5);
  db = run(db, 'sale.order', order.id, 'Create Invoice').db;
  const partial = search(db, 'account.move').filter((m) => m.sale_id === order.id).at(-1);
  assert.equal(partial.amount_total, 0);
  assert.equal(partial.invoice_line_ids.find((l) => l.down_payment_key).qty, -5);
  db = run(db, 'account.move', partial.id, 'Confirm').db;
  deliver(10);
  db = run(db, 'sale.order', order.id, 'Create Invoice').db;
  const final = search(db, 'account.move').filter((m) => m.sale_id === order.id).at(-1);
  assert.equal(final.amount_total, 0);
  assert.equal(final.invoice_line_ids.find((l) => l.down_payment_key).qty, -5);
});

test('draft advance posting respects partial billing and remaining invoices deduct it', () => {
  const configured = write(seed(), 'product', 7, { invoice_policy: 'delivery' });
  const order = create(configured, 'sale.order', { partner_id: 3, order_line: [{ product_id: 7, qty: 10, price_unit: 100, tax: 0 }] });
  let db = run(order.db, 'sale.order', order.id, 'Confirm').db;
  const button = models['sale.order'].form.buttons.find((b) => b.label === 'Down Payment');
  db = button.run(db, read(db, 'sale.order', order.id), { method: 'fixed', amount: 1000 }).db;
  const advance = search(db, 'account.move').find((m) => m.sale_id === order.id);
  const deliver = (qty) => { const current = read(db, 'sale.order', order.id); db = write(db, 'sale.order', order.id, { order_line: current.order_line.map((l) => ({ ...l, qty_delivered: qty })) }); };
  deliver(5);
  db = run(db, 'sale.order', order.id, 'Create Invoice').db;
  const partial = search(db, 'account.move').filter((m) => m.sale_id === order.id).at(-1);
  db = run(db, 'account.move', partial.id, 'Confirm').db;
  assert.throws(() => run(db, 'account.move', advance.id, 'Confirm'), /down payment.*remaining/i);
  db = write(db, 'account.move', advance.id, { invoice_line_ids: advance.invoice_line_ids.map((l) => ({ ...l, qty: l.qty / 2 })) });
  db = run(db, 'account.move', advance.id, 'Confirm').db;
  deliver(10);
  db = run(db, 'sale.order', order.id, 'Create Invoice').db;
  const final = search(db, 'account.move').filter((m) => m.sale_id === order.id).at(-1);
  assert.equal(final.amount_total, 0);
  assert.ok(final.invoice_line_ids.some((l) => l.down_payment_key && l.qty < 0));
  db = run(db, 'account.move', final.id, 'Confirm').db;
  assert.equal(search(db, 'account.move').filter((m) => m.sale_id === order.id && m.state === 'posted').reduce((sum, m) => sum + m.amount_total, 0), 1000);
});

for (const removal of ['cancel', 'delete', 'reset']) test(`draft credit cannot free advance balance after ${removal}`, () => {
  const configured = write(seed(), 'product', 7, { invoice_policy: 'delivery' });
  const order = create(configured, 'sale.order', { partner_id: 3, order_line: [{ product_id: 7, qty: 10, price_unit: 100, tax: 0 }] });
  let db = run(order.db, 'sale.order', order.id, 'Confirm').db;
  const button = models['sale.order'].form.buttons.find((b) => b.label === 'Down Payment');
  // Draft the advance before the partial invoice so posting must recheck the balance.
  db = button.run(db, read(db, 'sale.order', order.id), { method: 'fixed', amount: 1000 }).db;
  const advance = search(db, 'account.move').find((m) => m.sale_id === order.id);
  db = write(db, 'sale.order', order.id, { order_line: read(db, 'sale.order', order.id).order_line.map((l) => ({ ...l, qty_delivered: 5 })) });
  db = run(db, 'sale.order', order.id, 'Create Invoice').db;
  const invoice = search(db, 'account.move').filter((m) => m.sale_id === order.id).at(-1);
  db = run(db, 'account.move', invoice.id, 'Confirm').db;
  db = run(db, 'account.move', invoice.id, 'Credit Note').db;
  const credit = search(db, 'account.move').find((m) => m.reversed_entry_id === invoice.id);
  assert.throws(() => run(db, 'account.move', advance.id, 'Confirm'), /down payment.*remaining/i);
  assert.throws(() => button.run(db, read(db, 'sale.order', order.id), { method: 'fixed', amount: 1000 }), /down payment/i);
  if (removal === 'reset') {
    db = run(db, 'account.move', credit.id, 'Confirm').db;
    db = run(db, 'account.move', advance.id, 'Confirm').db;
    assert.throws(() => run(db, 'account.move', credit.id, 'Reset to Draft'), /not available|down payment.*remaining/i);
  } else {
    db = removal === 'cancel' ? run(db, 'account.move', credit.id, 'Cancel').db : unlink(db, 'account.move', [credit.id]);
    assert.throws(() => run(db, 'account.move', advance.id, 'Confirm'), /down payment.*remaining/i);
  }
});

test('resetting an unsettled posted credit cannot overcommit a posted advance', () => {
  const configured = write(seed(), 'product', 7, { invoice_policy: 'delivery' });
  const order = create(configured, 'sale.order', { partner_id: 3, order_line: [{ product_id: 7, qty: 10, price_unit: 100, tax: 0 }] });
  let db = run(order.db, 'sale.order', order.id, 'Confirm').db;
  db = write(db, 'sale.order', order.id, { order_line: read(db, 'sale.order', order.id).order_line.map((l) => ({ ...l, qty_delivered: 5 })) });
  db = run(db, 'sale.order', order.id, 'Create Invoice').db;
  const invoice = search(db, 'account.move').find((m) => m.sale_id === order.id);
  db = run(db, 'account.move', invoice.id, 'Confirm').db;
  const credit = create(db, 'account.move', { move_type: 'out_refund', partner_id: 3, sale_id: order.id, invoice_line_ids: invoice.invoice_line_ids });
  db = run(credit.db, 'account.move', credit.id, 'Confirm').db;
  const record = read(db, 'sale.order', order.id);
  const button = models['sale.order'].form.buttons.find((b) => b.label === (record.invoice_status === 'to_invoice' ? 'Create Invoice' : 'Down Payment'));
  db = button.run(db, record, { method: 'fixed', amount: 1000 }).db;
  const advance = search(db, 'account.move').filter((m) => m.sale_id === order.id && m.move_type === 'out_invoice').at(-1);
  db = run(db, 'account.move', advance.id, 'Confirm').db;
  assert.throws(() => run(db, 'account.move', credit.id, 'Reset to Draft'), /down payment.*remaining/i);
  assert.equal(read(db, 'account.move', credit.id).state, 'posted');
});

test('partial delivery invoices limit advances to the remaining order value', () => {
  const configured = write(seed(), 'product', 7, { invoice_policy: 'delivery' });
  const order = create(configured, 'sale.order', { partner_id: 3, order_line: [{ product_id: 7, qty: 10, price_unit: 100, tax: 0 }] });
  let db = run(order.db, 'sale.order', order.id, 'Confirm').db;
  const deliver = (quantity) => {
    const current = read(db, 'sale.order', order.id);
    db = write(db, 'sale.order', order.id, { order_line: current.order_line.map((line) => ({ ...line, qty_delivered: quantity })) });
  };
  deliver(5);
  db = run(db, 'sale.order', order.id, 'Create Invoice').db;
  const invoice = search(db, 'account.move').find((m) => m.sale_id === order.id);
  db = run(db, 'account.move', invoice.id, 'Confirm').db;
  const advance = (amount) => {
    const record = read(db, 'sale.order', order.id);
    const label = record.invoice_status === 'to_invoice' ? 'Create Invoice' : 'Down Payment';
    return models['sale.order'].form.buttons.find((b) => b.label === label).run(db, record, { method: 'fixed', amount }).db;
  };
  assert.throws(() => advance(1000), /down payment/i);
  db = run(db, 'account.move', invoice.id, 'Credit Note').db;
  const credit = search(db, 'account.move').find((m) => m.reversed_entry_id === invoice.id);
  db = write(db, 'account.move', credit.id, { invoice_line_ids: credit.invoice_line_ids.map((line) => ({ ...line, qty: 2 })) });
  assert.throws(() => advance(501), /down payment/i);
  db = run(db, 'account.move', credit.id, 'Confirm').db;
  assert.throws(() => advance(701), /down payment/i);
  db = advance(700);
  const deposit = search(db, 'account.move').filter((m) => m.sale_id === order.id && m.move_type === 'out_invoice').at(-1);
  db = run(db, 'account.move', deposit.id, 'Confirm').db;
  deliver(10);
  db = run(db, 'sale.order', order.id, 'Create Invoice').db;
  const final = search(db, 'account.move').filter((m) => m.sale_id === order.id && m.move_type === 'out_invoice').at(-1);
  assert.equal(final.amount_total, 0);
});

test('sales invoice buttons cap outstanding advances and release cancelled or credited amounts', () => {
  const order = create(seed(), 'sale.order', { partner_id: 3, order_line: [{ product_id: 7, qty: 10, price_unit: 100, tax: 10 }] });
  let db = run(order.db, 'sale.order', order.id, 'Confirm').db;
  const button = models['sale.order'].form.buttons.find((b) => b.label === 'Create Invoice');
  const advance = (state, method, amount) => button.run(state, read(state, 'sale.order', order.id), { method, amount }).db;
  db = advance(db, 'percentage', 100);
  const first = search(db, 'account.move').find((m) => m.sale_id === order.id);
  assert.throws(() => advance(db, 'percentage', 100), /down payment/i);
  db = run(db, 'account.move', first.id, 'Confirm').db;
  assert.throws(() => advance(db, 'percentage', 100), /down payment/i);
  db = run(db, 'account.move', first.id, 'Credit Note').db;
  const credit = search(db, 'account.move').find((m) => m.reversed_entry_id === first.id);
  db = write(db, 'account.move', credit.id, { invoice_line_ids: credit.invoice_line_ids.map((line) => ({ ...line, qty: line.qty / 2 })) });
  assert.throws(() => advance(db, 'fixed', 0.01), /down payment/i);
  db = run(db, 'account.move', credit.id, 'Confirm').db;
  assert.throws(() => advance(db, 'fixed', 550.01), /down payment/i);
  db = advance(db, 'fixed', 550);
  const second = search(db, 'account.move').filter((m) => m.sale_id === order.id && m.move_type === 'out_invoice').at(-1);
  assert.throws(() => advance(db, 'fixed', 0.01), /down payment/i);
  db = run(db, 'account.move', second.id, 'Cancel').db;
  db = advance(db, 'percentage', 50);
  const replacement = search(db, 'account.move').filter((m) => m.sale_id === order.id && m.move_type === 'out_invoice').at(-1);
  assert.equal(replacement.amount_total, 550);
  db = run(db, 'account.move', replacement.id, 'Confirm').db;
  db = run(db, 'sale.order', order.id, 'Create Invoice').db;
  assert.equal(search(db, 'account.move').filter((m) => m.sale_id === order.id && m.move_type === 'out_invoice').at(-1).amount_total, 0);
});

test('draft invoice deductions do not release posted advance capacity', () => {
  const order = create(seed(), 'sale.order', { partner_id: 3, order_line: [{ product_id: 7, qty: 10, price_unit: 100, tax: 0 }] });
  let db = run(order.db, 'sale.order', order.id, 'Confirm').db;
  const button = models['sale.order'].form.buttons.find((b) => b.label === 'Create Invoice');
  const advance = (amount) => button.run(db, read(db, 'sale.order', order.id), { method: 'percentage', amount }).db;
  db = advance(50);
  const first = search(db, 'account.move').find((m) => m.sale_id === order.id);
  db = run(db, 'account.move', first.id, 'Confirm').db;
  db = run(db, 'sale.order', order.id, 'Create Invoice').db;
  const invoice = search(db, 'account.move').filter((m) => m.sale_id === order.id).at(-1);
  db = write(db, 'account.move', invoice.id, { invoice_line_ids: invoice.invoice_line_ids.map((line) => ({ ...line, qty: line.qty / 2 })) });
  assert.throws(() => advance(51), /down payment/i);
  db = advance(50);
  const second = search(db, 'account.move').filter((m) => m.sale_id === order.id).at(-1);
  assert.equal(second.amount_total, 500);
});

test('draft advances must be resolved before the final sales invoice', () => {
  const order = create(seed(), 'sale.order', { partner_id: 3, order_line: [{ product_id: 7, qty: 10, price_unit: 100, tax: 0 }] });
  let db = run(order.db, 'sale.order', order.id, 'Confirm').db;
  db = models['sale.order'].form.buttons.find((b) => b.label === 'Create Invoice').run(db, read(db, 'sale.order', order.id), { method: 'percentage', amount: 30 }).db;
  const advance = search(db, 'account.move').find((m) => m.sale_id === order.id);
  assert.throws(() => run(db, 'sale.order', order.id, 'Create Invoice'), /draft down payment/i);
  db = run(db, 'account.move', advance.id, 'Confirm').db;
  db = run(db, 'sale.order', order.id, 'Create Invoice').db;
  assert.equal(search(db, 'account.move').filter((m) => m.sale_id === order.id).at(-1).amount_total, 700);
});

test('company down payment account is snapshotted on advances and deductions without the default chart code', () => {
  let db = seed();
  const defaultAccount = search(db, 'account.account').find((a) => a.code === '212000');
  db = write(db, 'account.account', defaultAccount.id, { code: '212999' });
  const alternate = create(db, 'account.account', { code: '220100', name: 'Customer deposits', account_type: 'liability_current' });
  db = write(alternate.db, 'res.company', 1, { down_payment_account_id: alternate.id });
  const order = create(db, 'sale.order', { partner_id: 3, order_line: [{ product_id: 7, qty: 10, price_unit: 100, tax: 10 }] });
  db = run(order.db, 'sale.order', order.id, 'Confirm').db;
  const button = models['sale.order'].form.buttons.find((b) => b.label === 'Create Invoice');
  db = button.run(db, read(db, 'sale.order', order.id), { method: 'percentage', amount: 30 }).db;
  const advance = search(db, 'account.move').find((m) => m.sale_id === order.id);
  assert.equal(advance.invoice_line_ids[0].account_id, alternate.id);
  db = run(db, 'account.move', advance.id, 'Confirm').db;
  assert.equal(read(db, 'account.move', advance.id).line_ids.filter((l) => l.account_id === alternate.id).reduce((sum, l) => sum + l.credit - l.debit, 0), 300);
  db = write(db, 'res.company', 1, { down_payment_account_id: defaultAccount.id });
  db = run(db, 'sale.order', order.id, 'Create Invoice').db;
  const final = search(db, 'account.move').filter((m) => m.sale_id === order.id).at(-1);
  assert.equal(final.invoice_line_ids.find((l) => l.down_payment_key).account_id, alternate.id);
  db = run(db, 'account.move', final.id, 'Confirm').db;
  assert.equal(read(db, 'account.move', final.id).line_ids.filter((l) => l.account_id === alternate.id).reduce((sum, l) => sum + l.debit - l.credit, 0), 300);
});

test('company down payment account rejects missing and other-company accounts', () => {
  let db = seed();
  assert.throws(() => write(db, 'res.company', 1, { down_payment_account_id: 999999 }), /down payment account/i);
  const foreign = create(db, 'account.account', { code: '220999', name: 'Other company deposits', account_type: 'liability_current', company_id: 2 });
  db = foreign.db;
  assert.throws(() => write(db, 'res.company', 1, { down_payment_account_id: foreign.id }), /down payment account/i);
});

test('down payment and final deduction post to the deferred revenue account with tax', () => {
  const order = create(seed(), 'sale.order', { partner_id: 3, order_line: [{ product_id: 7, qty: 10, price_unit: 100, tax: 10 }] });
  let db = run(order.db, 'sale.order', order.id, 'Confirm').db;
  db = models['sale.order'].form.buttons.find((b) => b.label === 'Create Invoice').run(db, read(db, 'sale.order', order.id), { method: 'fixed', amount: 110 }).db;
  const advance = search(db, 'account.move').find((m) => m.sale_id === order.id);
  const deferred = search(db, 'account.account').find((a) => a.code === '212000').id;
  assert.equal(advance.invoice_line_ids[0].account_id, deferred);
  assert.equal(advance.invoice_line_ids[0].product_id ?? null, null);
  db = run(db, 'account.move', advance.id, 'Confirm').db;
  assert.equal(read(db, 'account.move', advance.id).line_ids.filter((l) => l.account_id === deferred).reduce((s, l) => s + l.credit - l.debit, 0), 100);
  db = run(db, 'sale.order', order.id, 'Create Invoice').db;
  const final = search(db, 'account.move').filter((m) => m.sale_id === order.id).at(-1);
  assert.equal(final.amount_tax, 90);
  db = run(db, 'account.move', final.id, 'Confirm').db;
  assert.equal(read(db, 'account.move', final.id).line_ids.filter((l) => l.account_id === deferred).reduce((s, l) => s + l.debit - l.credit, 0), 100);
});

test('delivery-policy sales status and To Invoice menu follow invoiceable delivered quantities', () => {
  const configured = write(seed(), 'product', 7, { invoice_policy: 'delivery' });
  const order = create(configured, 'sale.order', { partner_id: 3, order_line: [{ product_id: 7, qty: 4, price_unit: 100, tax: 0 }] });
  let db = run(order.db, 'sale.order', order.id, 'Confirm').db;
  const button = models['sale.order'].form.buttons.find((b) => b.label === 'Create Invoice');
  const menu = leavesOf(apps.find((a) => a.id === 'sales')).find((leaf) => leaf.key === 'to-invoice');
  const check = (status, available) => {
    const record = read(db, 'sale.order', order.id);
    assert.equal(record.invoice_status, status);
    assert.equal(button.when(record, db), available);
    assert.equal(menu.domain(record), available);
  };
  check('no', false);
  const advance = models['sale.order'].form.buttons.find((b) => b.label === 'Down Payment');
  assert.equal(advance.when(read(db, 'sale.order', order.id), db), true);
  const advanceDb = advance.run(db, read(db, 'sale.order', order.id), { method: 'percentage', amount: 30 }).db;
  assert.equal(search(advanceDb, 'account.move').find((m) => m.sale_id === order.id).amount_total, 120);
  const picking = search(db, 'stock.picking').find((p) => p.sale_id === order.id);
  db = write(db, 'stock.picking', picking.id, { move_ids: picking.move_ids.map((l) => ({ ...l, quantity: 2 })) });
  db = run(db, 'stock.picking', picking.id, 'Validate').db;
  check('to_invoice', true);
  db = run(db, 'sale.order', order.id, 'Create Invoice').db;
  check('no', false);
  const remaining = search(db, 'stock.picking').find((p) => p.sale_id === order.id && p.id !== picking.id && p.state !== 'cancel');
  db = run(db, 'stock.picking', remaining.id, 'Validate').db;
  check('to_invoice', true);
  db = run(db, 'sale.order', order.id, 'Create Invoice').db;
  check('invoiced', false);
});

test('duplicate product sales lines keep their invoice quantities through edits and credits', () => {
  const configured = write(seed(), 'product', 7, { invoice_policy: 'delivery' });
  const order = create(configured, 'sale.order', { partner_id: 3, order_line: [
    { product_id: 7, qty: 1, price_unit: 100, tax: 0 }, { product_id: 7, qty: 1, price_unit: 50, tax: 0 },
  ] });
  let db = run(order.db, 'sale.order', order.id, 'Confirm').db;
  const picking = search(db, 'stock.picking').find((p) => p.sale_id === order.id);
  db = write(db, 'stock.picking', picking.id, { move_ids: picking.move_ids.map((l, i) => ({ ...l, quantity: i })) });
  globalThis.confirm = () => true;
  try { db = run(db, 'stock.picking', picking.id, 'Validate').db; } finally { delete globalThis.confirm; }
  assert.deepEqual(read(db, 'sale.order', order.id).order_line.map((l) => l.qty_delivered || 0), [0, 1]);
  db = run(db, 'sale.order', order.id, 'Create Invoice').db;
  const invoice = search(db, 'account.move').find((m) => m.sale_id === order.id);
  assert.equal(invoice.invoice_line_ids[0].price_unit, 50);
  assert.deepEqual(read(db, 'sale.order', order.id).order_line.map((l) => l.qty_invoiced || 0), [0, 1]);
  db = write(db, 'account.move', invoice.id, { invoice_line_ids: invoice.invoice_line_ids.map((l) => ({ ...l, qty: 0.5 })) });
  assert.deepEqual(read(db, 'sale.order', order.id).order_line.map((l) => l.qty_invoiced || 0), [0, 0.5]);
  db = write(db, 'account.move', invoice.id, { invoice_line_ids: invoice.invoice_line_ids.map((l) => ({ ...l, qty: 1 })) });
  db = run(db, 'account.move', invoice.id, 'Confirm').db;
  db = run(db, 'account.move', invoice.id, 'Credit Note').db;
  const credit = search(db, 'account.move').find((m) => m.reversed_entry_id === invoice.id);
  assert.deepEqual(read(db, 'sale.order', order.id).order_line.map((l) => l.qty_invoiced || 0), [0, 0]);
  const credited = run(db, 'account.move', credit.id, 'Confirm').db;
  const replacement = run(credited, 'sale.order', order.id, 'Create Invoice').db;
  const replacementInvoice = search(replacement, 'account.move').filter((m) => m.sale_id === order.id && m.move_type === 'out_invoice').at(-1);
  assert.equal(replacementInvoice.invoice_line_ids[0].price_unit, 50);
  assert.deepEqual(read(replacement, 'sale.order', order.id).order_line.map((l) => l.qty_invoiced || 0), [0, 1]);
  db = run(db, 'account.move', credit.id, 'Cancel').db;
  const backorder = search(db, 'stock.picking').find((p) => p.sale_id === order.id && p.id !== picking.id && p.state !== 'cancel');
  db = run(db, 'stock.picking', backorder.id, 'Validate').db;
  db = run(db, 'sale.order', order.id, 'Create Invoice').db;
  const next = search(db, 'account.move').filter((m) => m.sale_id === order.id && m.move_type === 'out_invoice').at(-1);
  assert.equal(next.invoice_line_ids[0].price_unit, 100);
  assert.deepEqual(read(db, 'sale.order', order.id).order_line.map((l) => l.qty_invoiced), [1, 1]);
  const reordered = read(db, 'sale.order', order.id).order_line.toReversed();
  db = write(db, 'sale.order', order.id, { order_line: reordered });
  db = write(db, 'account.move', next.id, { invoice_line_ids: next.invoice_line_ids.map((l) => ({ ...l, qty: 0.5 })) });
  assert.deepEqual(read(db, 'sale.order', order.id).order_line.map((l) => [l.price_unit, l.qty_invoiced]), [[50, 1], [100, 0.5]]);
});

test('sales credit notes and vendor refunds restore invoiceable quantities and cancellation restores them', () => {
  for (const purchase of [false, true]) {
    const model = purchase ? 'purchase.order' : 'sale.order';
    const field = purchase ? 'purchase_id' : 'sale_id';
    const created = create(seed(), model, { partner_id: purchase ? 2 : 3, order_line: [{ product_id: 7, qty: 10, price_unit: 100, tax: 0 }] });
    let db = purchase ? write(created.db, 'product', 7, { purchase_method: 'purchase' }) : created.db;
    db = run(db, model, created.id, purchase ? 'Confirm Order' : 'Confirm').db;
    db = run(db, model, created.id, purchase ? 'Create Bill' : 'Create Invoice').db;
    const invoice = search(db, 'account.move').find((m) => m[field] === created.id);
    db = run(db, 'account.move', invoice.id, 'Confirm').db;
    db = run(db, 'account.move', invoice.id, 'Credit Note').db;
    const credit = search(db, 'account.move').find((m) => m.reversed_entry_id === invoice.id);
    assert.equal(credit[field], created.id);
    assert.equal(read(db, model, created.id).order_line[0].qty_invoiced, 0);
    const fullCredit = run(db, 'account.move', credit.id, 'Confirm').db;
    assert.equal(read(fullCredit, model, created.id).order_line[0].qty_invoiced, 0);
    const fullReplacement = run(fullCredit, model, created.id, purchase ? 'Create Bill' : 'Create Invoice').db;
    assert.equal(search(fullReplacement, 'account.move').filter((m) => m[field] === created.id && m.move_type === (purchase ? 'in_invoice' : 'out_invoice')).at(-1).invoice_line_ids[0].qty, 10);
    db = write(db, 'account.move', credit.id, { invoice_line_ids: credit.invoice_line_ids.map((l) => ({ ...l, qty: 4 })) });
    assert.equal(read(db, model, created.id).order_line[0].qty_invoiced, 6);
    const cancelled = run(db, 'account.move', credit.id, 'Cancel').db;
    assert.equal(read(cancelled, model, created.id).order_line[0].qty_invoiced, 10);
    db = run(db, 'account.move', credit.id, 'Confirm').db;
    assert.equal(read(db, model, created.id).order_line[0].qty_invoiced, 6);
    db = run(db, model, created.id, purchase ? 'Create Bill' : 'Create Invoice').db;
    assert.equal(search(db, 'account.move').filter((m) => m[field] === created.id && m.move_type === (purchase ? 'in_invoice' : 'out_invoice')).at(-1).invoice_line_ids[0].qty, 4);
  }
});

test('percentage down payment is invoiced and deducted from the final invoice', () => {
  const order = create(seed(), 'sale.order', { partner_id: 3, order_line: [{ product_id: 7, qty: 10, price_unit: 100, tax: 0 }] });
  const confirmed = run(order.db, 'sale.order', order.id, 'Confirm').db;
  const button = models['sale.order'].form.buttons.find((b) => b.label === 'Create Invoice');
  const advance = button.run(confirmed, read(confirmed, 'sale.order', order.id), { method: 'percentage', amount: 30 }).db;
  const invoice = search(advance, 'account.move').find((m) => m.sale_id === order.id);
  assert.equal(invoice.amount_total, 300);
  const posted = run(advance, 'account.move', invoice.id, 'Confirm').db;
  const final = button.run(posted, read(posted, 'sale.order', order.id), { method: 'regular' }).db;
  const balance = search(final, 'account.move').filter((m) => m.sale_id === order.id).at(-1);
  assert.equal(balance.amount_total, 700);
});

test('fixed down payment preserves tax on posted advances and final invoices, including cancelled drafts', () => {
  const order = create(seed(), 'sale.order', { partner_id: 3, order_line: [{ product_id: 7, qty: 10, price_unit: 100, tax: 10 }] });
  let db = run(order.db, 'sale.order', order.id, 'Confirm').db;
  const button = models['sale.order'].form.buttons.find((b) => b.label === 'Create Invoice');
  assert.deepEqual(button.wizard(db, read(db, 'sale.order', order.id)).fields[0].options.map(([id]) => id), ['regular', 'percentage', 'fixed']);
  db = button.run(db, read(db, 'sale.order', order.id), { method: 'fixed', amount: 110 }).db;
  const advance = search(db, 'account.move').find((m) => m.sale_id === order.id);
  assert.equal(advance.amount_total, 110);
  assert.equal(advance.amount_tax, 10);
  assert.equal(read(db, 'sale.order', order.id).order_line[0].qty_invoiced, 0);
  db = run(db, 'account.move', advance.id, 'Confirm').db;
  assert.equal(read(db, 'account.move', advance.id).line_ids.reduce((sum, l) => sum + l.debit - l.credit, 0), 0);
  db = button.run(db, read(db, 'sale.order', order.id), { method: 'regular' }).db;
  const final = search(db, 'account.move').filter((m) => m.sale_id === order.id).at(-1);
  assert.equal(final.amount_total, 990);
  assert.equal(final.amount_tax, 90);
  db = run(db, 'account.move', final.id, 'Cancel').db;
  db = button.run(db, read(db, 'sale.order', order.id), { method: 'regular' }).db;
  const replacement = search(db, 'account.move').filter((m) => m.sale_id === order.id).at(-1);
  assert.equal(replacement.amount_total, 990);
  db = run(db, 'account.move', replacement.id, 'Confirm').db;
  assert.equal(read(db, 'account.move', replacement.id).line_ids.reduce((sum, l) => sum + l.debit - l.credit, 0), 0);
});

test('editing a draft sales invoice releases the remaining quantity for invoicing', () => {
  const order = create(seed(), 'sale.order', { partner_id: 3, order_line: [{ product_id: 7, qty: 10, price_unit: 100, tax: 0 }] });
  const confirmed = run(order.db, 'sale.order', order.id, 'Confirm').db;
  const invoiced = run(confirmed, 'sale.order', order.id, 'Create Invoice').db;
  const invoice = search(invoiced, 'account.move').find((m) => m.sale_id === order.id);
  const edited = write(invoiced, 'account.move', invoice.id, { invoice_line_ids: invoice.invoice_line_ids.map((l) => ({ ...l, qty: 6 })) });
  assert.equal(read(edited, 'sale.order', order.id).order_line[0].qty_invoiced, 6);
  const posted = run(edited, 'account.move', invoice.id, 'Confirm').db;
  const remainder = run(posted, 'sale.order', order.id, 'Create Invoice').db;
  assert.deepEqual(search(remainder, 'account.move').filter((m) => m.sale_id === order.id).map((m) => m.invoice_line_ids[0].qty), [6, 4]);
  assert.equal(read(invoiced, 'sale.order', order.id).order_line[0].qty_invoiced, 10);
});

test('a sales order invoices only what is left, tracks delivered quantities and uses its payment term', () => {
  const db0 = seed();
  const term = search(db0, 'account.payment.term').find((t) => t.name === '30 Days').id;
  const { db, id } = create(db0, 'sale.order', { partner_id: 3, payment_term_id: term, commitment_date: '2026-12-01', order_line: [{ product_id: 7, qty: 4, price_unit: 100, tax: 0 }] });
  const confirmed = run(db, 'sale.order', id, 'Confirm').db;
  const picking = search(confirmed, 'stock.picking').find((p) => p.sale_id === id);
  assert.equal(picking.scheduled_date, '2026-12-01');

  const delivered = run(confirmed, 'stock.picking', picking.id, 'Validate').db;
  assert.equal(read(delivered, 'sale.order', id).order_line[0].qty_delivered, 4);

  const invoiced = run(delivered, 'sale.order', id, 'Create Invoice').db;
  const inv = search(invoiced, 'account.move').find((m) => m.sale_id === id);
  assert.equal(inv.invoice_payment_term_id, term);
  assert.equal(inv.invoice_line_ids[0].qty, 4);
  assert.equal(read(invoiced, 'sale.order', id).invoice_status, 'invoiced');
  assert.throws(() => run(invoiced, 'sale.order', id, 'Create Invoice'), /already invoiced|not available/);
});

test('delivered-quantity products invoice only what was delivered; product tax and income account apply', () => {
  const db0 = seed();
  const income = db0.records['account.account'].find((a) => a.code === '450000').id;
  let db = write(db0, 'product', 7, { invoice_policy: 'delivery', sale_tax: 5, property_account_income_id: income });
  const line = models['sale.order'].fields.order_line.onchange({ product_id: 7, qty: 5 }, 'product_id', db, {});
  assert.equal(line.tax, 5);
  const created = create(db, 'sale.order', { partner_id: 3, order_line: [{ ...line, qty: 5, price_unit: 100 }] });
  db = run(created.db, 'sale.order', created.id, 'Confirm').db;
  assert.throws(() => run(db, 'sale.order', created.id, 'Create Invoice'), /Nothing left to invoice/);
  const picking = search(db, 'stock.picking').find((p) => p.sale_id === created.id);
  const partial = write(db, 'stock.picking', picking.id, { move_ids: [{ product_id: 7, qty: 2 }] });
  const delivered = run(partial, 'stock.picking', picking.id, 'Validate').db;
  const invoiced = run(delivered, 'sale.order', created.id, 'Create Invoice').db;
  const inv = search(invoiced, 'account.move').find((m) => m.sale_id === created.id);
  assert.equal(inv.invoice_line_ids[0].qty, 2);
  const posted = models['account.move'].form.buttons.find((b) => b.label === 'Confirm').run(invoiced, read(invoiced, 'account.move', inv.id)).db;
  assert.ok(read(posted, 'account.move', inv.id).line_ids.some((l) => l.account_id === income && l.credit > 0));
});
