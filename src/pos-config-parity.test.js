import { models } from './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { migrate } from './migrations.js';
import { closeSession, openSession, payCart, payOrder, posOrderTotal, refundOrder, sessionTotals, startSession } from './models/pos.js';
import { payWithMethods, posCategories, posPaymentMethods, posProducts, refundBill, zReport } from './models/posplus.js';
import { runOperation } from './operations.js';
import { accountId, journalId, postEntry } from './models/ledger.js';
import { payMove, postMove } from './models/accounting.js';
import { runPosting } from '../server/posting.js';
import { deliver, receive } from './models/valuation.js';
import { setCompanies } from './models/company.js';
import { remapDiff } from './sync.js';

test('migration creates company payment methods and preserves legacy payment values', () => {
  const base = seed();
  const legacy = { ...base, schema_version: 5, records: { ...base.records, 'pos.config': [{ id: 1, name: 'Register', company_id: 1, payment_method_ids: [{ name: 'Cash', journal: 'cash' }, { name: 'Card', journal: 'bank' }] }], 'pos.order': [{ id: 1, name: 'Old', company_id: 1, config_id: 1, payment_method: 'cash', payment_ids: [{ method: 'cash', amount: 12 }] }] }, seq: { ...base.seq, 'pos.config': 1, 'pos.order': 1 } };
  const next = migrate(legacy);
  const methods = search(next, 'pos.payment.method');
  assert.deepEqual(methods.map((m) => m.type).sort(), ['bank', 'cash']);
  assert.equal(read(next, 'pos.order', 1).payment_ids[0].amount, 12);
  assert.equal(read(next, 'pos.order', 1).payment_ids[0].payment_method_id, methods.find((m) => m.type === 'cash').id);
  assert.equal(read(next, 'pos.order', 1).payment_method, 'cash');
  assert.strictEqual(migrate(next), next);
});

test('record-based payments use their own journal and pay later requires a customer', () => {
  let db = startSession(migrate({ ...seed(), schema_version: 5 }), 0).db;
  const cfg = search(db, 'pos.config')[0];
  const cash = search(db, 'pos.payment.method').find((m) => m.type === 'cash');
  const later = create(db, 'pos.payment.method', { name: 'Account', type: 'pay_later', company_id: 1, config_ids: [cfg.id] });
  db = write(later.db, 'pos.config', cfg.id, { payment_method_ids: [...(cfg.payment_method_ids ?? [cash.id]), later.id] });
  const lines = [{ product_id: 5, qty: 1, price_unit: 10, tax: 0 }];
  assert.throws(() => payOrder(db, { lines, method: later.id }), /customer/i);
  const paid = payOrder(db, { lines, method: cash.id });
  const order = read(paid.db, 'pos.order', paid.id);
  assert.equal(order.payment_method_id, cash.id);
  const payment = search(paid.db, 'account.move').find((m) => m.ref === order.name && m.journal_id === journalId(db, 'CSH1'));
  assert.ok(payment.line_ids.some((l) => l.account_id === accountId(db, '101501') && l.debit === 10));
  const deferred = payOrder(db, { lines, method: later.id, partner_id: 1 });
  const sale = search(deferred.db, 'account.move').find((m) => m.ref === read(deferred.db, 'pos.order', deferred.id).name && m.journal_id === journalId(db, 'POSS'));
  assert.ok(sale.line_ids.some((l) => l.account_id === accountId(db, '121000') && l.debit === 10));
});

test('string tenders post identically to their configured records for sales, rounding, pay later and returns', () => {
  let db = startSession(migrate({ ...seed(), schema_version: 5 }), 0).db;
  const cfg = search(db, 'pos.config')[0];
  const cash = search(db, 'pos.payment.method').find((m) => m.type === 'cash');
  const custom = create(db, 'pos.payment.method', {
    name: 'Special Cash', type: 'cash', company_id: 1, journal_id: cash.journal_id,
    receivable_account_id: accountId(db, '121000'), outstanding_account_id: accountId(db, '101501'),
  });
  const later = create(custom.db, 'pos.payment.method', { name: 'Customer Account', type: 'pay_later', company_id: 1, receivable_account_id: accountId(db, '121000') });
  const rounding = create(later.db, 'account.cash.rounding', { name: 'Up', rounding: 0.05, rounding_method: 'UP', strategy: 'add_invoice_line' });
  const preset = create(rounding.db, 'pos.preset', { name: 'Return', is_return: true, identification: 'none', service_at: 'counter' });
  db = write(preset.db, 'pos.config', cfg.id, { payment_method_ids: [custom.id, later.id], available_preset_ids: [preset.id] });

  const entries = (out) => {
    const order = read(out.db, 'pos.order', out.id);
    return search(out.db, 'account.move').filter((m) => m.ref === order.name).map((m) => ({
      journal_id: m.journal_id,
      lines: m.line_ids.map((l) => ({ account_id: l.account_id, debit: l.debit, credit: l.credit })),
    }));
  };
  const compare = (base, args, name, id) => {
    const byName = payOrder(base, { ...args, method: name });
    const byId = payOrder(base, { ...args, method: id });
    assert.deepEqual(entries(byName), entries(byId));
    return entries(byName);
  };
  const lines = [{ product_id: 5, qty: 1, price_unit: 10.02, tax: 0 }];
  db = write(db, 'pos.config', cfg.id, { available_preset_ids: [] });
  const sale = compare(db, { lines }, 'Special Cash', custom.id);
  assert.equal(sale.length, 2);
  const deferred = compare(db, { lines, partner_id: 1 }, 'Customer Account', later.id);
  assert.equal(deferred.length, 1);
  const rounded = write(db, 'pos.config', cfg.id, { cash_rounding: true, rounding_method_id: rounding.id, only_round_cash_method: true });
  const roundedSale = compare(rounded, { lines }, 'Special Cash', custom.id);
  assert.ok(roundedSale[0].lines.some((l) => l.credit === 0.03));
  const returns = write(db, 'pos.config', cfg.id, { available_preset_ids: [preset.id] });
  const returned = compare(returns, { lines: [{ ...lines[0], qty: -1 }], preset_id: preset.id }, 'Special Cash', custom.id);
  assert.ok(returned[1].lines.some((l) => l.account_id === accountId(db, '101501') && l.credit === 10.02));
});

test('migration preserves all configured methods across pos.config and companies', () => {
  const base = seed();
  const legacy = {
    ...base,
    schema_version: 5,
    records: {
      ...base.records,
      'pos.config': [
        { id: 1, name: 'Main Shop', company_id: 1, payment_method_ids: [{ name: 'Cash', journal: 'cash' }, { name: 'Card', journal: 'bank' }, { name: 'Gift Voucher', journal: 'bank' }] },
        { id: 2, name: 'Branch', company_id: 2, payment_method_ids: [{ name: 'Branch Cash', journal: 'cash' }] },
      ],
      'pos.order': [
        { id: 1, name: 'POS/1', company_id: 1, config_id: 1, payment_method: 'bank', payment_ids: [{ method: 'bank', amount: 45 }] },
      ],
    },
    seq: { ...base.seq, 'pos.config': 2, 'pos.order': 1 },
  };
  const next = migrate(legacy);
  const methods = search(next, 'pos.payment.method');
  const voucher = methods.find((m) => m.name === 'Gift Voucher');
  assert.ok(voucher, 'Gift Voucher must be preserved as pos.payment.method');
  assert.equal(voucher.company_id, 1);
  assert.equal(voucher.type, 'bank');

  const branchCash = methods.find((m) => m.name === 'Branch Cash');
  assert.ok(branchCash, 'Branch Cash must be preserved as pos.payment.method');
  assert.equal(branchCash.company_id, 2);

  assert.ok(methods.some((m) => m.company_id === 1 && m.type === 'cash'));
  assert.ok(methods.some((m) => m.company_id === 1 && m.type === 'bank'));
  assert.ok(methods.some((m) => m.company_id === 2 && m.type === 'cash'));
  assert.ok(methods.some((m) => m.company_id === 2 && m.type === 'bank'));

  assert.ok(read(next, 'pos.order', 1).payment_method_id);
  assert.equal(read(next, 'pos.order', 1).payment_ids[0].amount, 45);
});

test('session cash control only counts cash methods in expected drawer cash', () => {
  let db = startSession(migrate({ ...seed(), schema_version: 5 }), 100).db;
  const session = search(db, 'pos.session').find((s) => s.state === 'opened');
  const cfg = search(db, 'pos.config')[0];
  const cash = search(db, 'pos.payment.method').find((m) => m.type === 'cash');
  const card = search(db, 'pos.payment.method').find((m) => m.type === 'bank');
  const later = create(db, 'pos.payment.method', { name: 'Customer Credit', type: 'pay_later', company_id: 1, config_ids: [cfg.id] });
  db = write(later.db, 'pos.config', cfg.id, { payment_method_ids: [...(cfg.payment_method_ids ?? [cash.id, card.id]), later.id] });

  const lines = [{ product_id: 5, qty: 1, price_unit: 50, tax: 0 }];
  db = payOrder(db, { lines, method: cash.id }).db;
  db = payOrder(db, { lines, method: card.id }).db;
  db = payOrder(db, { lines, method: later.id, partner_id: 1 }).db;

  const totals = sessionTotals(db, session);
  assert.equal(totals.cash, 50, 'Only cash methods count towards total cash');
  assert.equal(totals.card, 50, 'Bank methods count towards card');
  assert.equal(totals.expected, 150, 'Opening cash (100) + cash payments (50) = 150');

  const closed = closeSession(db, session, 150);
  const closedSession = read(closed, 'pos.session', session.id);
  assert.equal(closedSession.state, 'closed');
  assert.equal(closedSession.cash_difference, 0);
  assert.equal(closedSession.total_cash, 50);
});

test('session cash and card totals reverse signed sales and returns, including split tenders', () => {
  for (const isReturn of [false, true]) {
    for (const split of [false, true]) {
      let db = seed();
      const cfg = search(db, 'pos.config')[0];
      if (isReturn) {
        const preset = create(db, 'pos.preset', { name: 'Return', is_return: true, identification: 'none', service_at: 'counter' });
        db = write(preset.db, 'pos.config', cfg.id, { available_preset_ids: [preset.id], default_preset_id: preset.id });
      }
      const session = startSession(db, 100, cfg.id);
      db = session.db;
      const direction = isReturn ? -1 : 1;
      const payments = split ? [{ method: 'cash', amount: 6 * direction }, { method: 'card', amount: 4 * direction }] : null;
      const paid = payOrder(db, { lines: [{ product_id: 5, qty: direction, price_unit: 10, tax: 0 }], method: 'cash', payments });
      const before = sessionTotals(paid.db, read(paid.db, 'pos.session', session.id));
      assert.deepEqual(before, { orders: 1, cash: (split ? 6 : 10) * direction, card: split ? 4 * direction : 0, expected: 100 + (split ? 6 : 10) * direction });
      const reversed = refundOrder(paid.db, read(paid.db, 'pos.order', paid.id));
      const after = sessionTotals(reversed.db, read(reversed.db, 'pos.session', session.id));
      assert.deepEqual(after, { orders: 2, cash: 0, card: 0, expected: 100 });
      assert.deepEqual(zReport(reversed.db, session.id).byMethod, { cash: 0, bank: 0 });
      const closed = closeSession(reversed.db, read(reversed.db, 'pos.session', session.id), 100);
      assert.equal(read(closed, 'pos.session', session.id).cash_difference, 0);
    }
  }
});

test('pos.category hierarchy, complete_name, config filtering and product matching', () => {
  let db = migrate({ ...seed(), schema_version: 5 });
  const config1 = search(db, 'pos.config')[0];
  const config2 = create(db, 'pos.config', { name: 'Kiosk', company_id: 1 }).db;
  const cfg2 = search(config2, 'pos.config').find((c) => c.name === 'Kiosk');

  const parent = create(config2, 'pos.category', { name: 'Food', sequence: 1 });
  db = parent.db;
  const child = create(db, 'pos.category', { name: 'Drinks', parent_id: parent.id, sequence: 2, pos_config_ids: [config1.id] });
  db = child.db;

  const drinks = read(db, 'pos.category', child.id);
  assert.equal(drinks.complete_name, 'Food / Drinks');

  db = write(db, 'product', 1, { pos_categ_ids: [child.id] });

  const catsForConfig1 = posCategories(db, config1.id);
  const catsForConfig2 = posCategories(db, cfg2.id);
  assert.ok(catsForConfig1.some((c) => c.id === child.id));
  assert.ok(!catsForConfig2.some((c) => c.id === child.id));

  const prods1 = posProducts(db, { configId: config1.id, selectedCatId: parent.id });
  assert.ok(prods1.some((p) => p.id === 1), 'Products in child category appear when parent category is selected in POS');
  const prods2 = posProducts(db, { configId: cfg2.id, selectedCatId: parent.id });
  assert.ok(!prods2.some((p) => p.id === 1), 'Products do not appear when category is filtered out of config');
});

test('pos.preset applies pricelist, fiscal position and enforces customer identification and returns', () => {
  let db = startSession(migrate({ ...seed(), schema_version: 5 }), 0).db;
  const cash = search(db, 'pos.payment.method').find((m) => m.type === 'cash');
  const mappedAcc = accountId(db, '450000');
  const fp = create(db, 'account.fiscal.position', {
    name: 'Delivery FP',
    account_ids: [{ account_src_id: accountId(db, '400000'), account_dest_id: mappedAcc }],
  });
  db = fp.db;
  const pricelist = create(db, 'product.pricelist', {
    name: 'Dine In List',
    items: [{ product_id: 5, min_qty: 1, fixed_price: 6.5 }],
  });
  db = pricelist.db;

  const eatIn = create(db, 'pos.preset', {
    name: 'Eat In',
    pricelist_id: pricelist.id,
    identification: 'none',
    service_at: 'table',
  });
  db = eatIn.db;

  const takeaway = create(db, 'pos.preset', {
    name: 'Takeaway',
    identification: 'name',
    service_at: 'counter',
  });
  db = takeaway.db;

  const delivery = create(db, 'pos.preset', {
    name: 'Delivery',
    identification: 'address',
    service_at: 'delivery',
    fiscal_position_id: fp.id,
  });
  db = delivery.db;

  const returnPreset = create(db, 'pos.preset', {
    name: 'Return Mode',
    identification: 'none',
    service_at: 'counter',
    is_return: true,
  });
  db = returnPreset.db;

  const cfg = search(db, 'pos.config')[0];
  db = write(db, 'pos.config', cfg.id, { available_preset_ids: [eatIn.id, takeaway.id, delivery.id, returnPreset.id] });
  const lines = [{ product_id: 5, qty: 1, price_unit: 10, tax: 0 }];

  // Pricelist application on eatIn
  const dineInOrder = runPosting(db, null, '/api/pos/pay', { lines: [{ product_id: 5, qty: 1 }], method: cash.id, preset_id: eatIn.id });
  const dineInRec = read(dineInOrder.db, 'pos.order', dineInOrder.body.id);
  assert.equal(dineInRec.lines[0].price_unit, 6.5, 'Preset pricelist applies to price lines');

  assert.throws(() => payOrder(db, { lines, method: cash.id, preset_id: takeaway.id }), /customer/i);

  const noAddressPartner = create(db, 'res.partner', { name: 'Homeless Bob' });
  db = noAddressPartner.db;
  assert.throws(() => payOrder(db, { lines, method: cash.id, preset_id: delivery.id, partner_id: noAddressPartner.id }), /address/i);

  const withAddress = create(db, 'res.partner', { name: 'Alice', street: '123 Main St', city: 'Metropolis' });
  db = withAddress.db;
  const paid = payOrder(db, { lines, method: cash.id, preset_id: delivery.id, partner_id: withAddress.id });
  const order = read(paid.db, 'pos.order', paid.id);
  assert.equal(order.preset_id, delivery.id);
  assert.equal(order.fiscal_position_id, fp.id);
  const saleMove = search(paid.db, 'account.move').find((m) => m.ref === order.name && m.journal_id === journalId(paid.db, 'POSS'));
  assert.ok(saleMove.line_ids.some((l) => l.account_id === mappedAcc && l.credit === 10), 'Fiscal position revenue account mapping applied');

  // is_return preset mode with negative quantities
  const returnRes = runPosting(db, null, '/api/pos/pay', { lines: [{ product_id: 5, qty: -1, price_unit: 10 }], method: cash.id, preset_id: returnPreset.id });
  const returnRec = read(returnRes.db, 'pos.order', returnRes.body.id);
  assert.equal(returnRec.lines[0].qty, -1);
  assert.equal(returnRec.amount_total, -171);
  const returnMove = search(returnRes.db, 'account.move').find((m) => m.ref === returnRec.name && m.journal_id === cash.journal_id);
  assert.ok(returnMove.line_ids.some((l) => l.credit === 171), 'Cash is credited for refund payment');
});

test('cash rounding methods UP, DOWN, HALF-UP, only_round_cash_method and profit/loss posting', () => {
  let base = migrate({ ...seed(), schema_version: 5 });
  const profitAcc = accountId(base, '450000');
  const lossAcc = accountId(base, '690000');

  const roundUp = create(base, 'account.cash.rounding', {
    name: '0.05 UP',
    rounding: 0.05,
    rounding_method: 'UP',
    strategy: 'add_invoice_line',
    profit_account_id: profitAcc,
    loss_account_id: lossAcc,
  });
  base = roundUp.db;

  const roundDown = create(base, 'account.cash.rounding', {
    name: '0.05 DOWN',
    rounding: 0.05,
    rounding_method: 'DOWN',
    strategy: 'add_invoice_line',
    profit_account_id: profitAcc,
    loss_account_id: lossAcc,
  });
  base = roundDown.db;

  const cfg = search(base, 'pos.config')[0];
  const cash = search(base, 'pos.payment.method').find((m) => m.type === 'cash');
  const card = search(base, 'pos.payment.method').find((m) => m.type === 'bank');

  // 1. Config with Round UP (10.02 -> 10.05 => 0.03 profit)
  let db1 = write(base, 'pos.config', cfg.id, { cash_rounding: true, rounding_method_id: roundUp.id, only_round_cash_method: false });
  db1 = startSession(db1, 0, cfg.id).db;
  const lines1 = [{ product_id: 5, qty: 1, price_unit: 10.02, tax: 0 }];
  const paid1 = payOrder(db1, { lines: lines1, method: cash.id, config_id: cfg.id });
  const o1 = read(paid1.db, 'pos.order', paid1.id);
  assert.equal(o1.payment_ids[0].amount, 10.05);
  const move1 = search(paid1.db, 'account.move').find((m) => m.ref === o1.name && m.journal_id === journalId(paid1.db, 'POSS'));
  const profitLine = move1.line_ids.find((l) => l.account_id === profitAcc);
  assert.ok(profitLine, 'Profit line must exist');
  assert.equal(profitLine.credit, 0.03);

  // 2. Config with Round DOWN (10.04 -> 10.00 => 0.04 loss)
  let db2 = write(base, 'pos.config', cfg.id, { cash_rounding: true, rounding_method_id: roundDown.id, only_round_cash_method: false });
  db2 = startSession(db2, 0, cfg.id).db;
  const lines2 = [{ product_id: 5, qty: 1, price_unit: 10.04, tax: 0 }];
  const paid2 = payOrder(db2, { lines: lines2, method: cash.id, config_id: cfg.id });
  const o2 = read(paid2.db, 'pos.order', paid2.id);
  assert.equal(o2.payment_ids[0].amount, 10.00);
  const move2 = search(paid2.db, 'account.move').find((m) => m.ref === o2.name && m.journal_id === journalId(paid2.db, 'POSS'));
  const lossLine = move2.line_ids.find((l) => l.account_id === lossAcc);
  assert.ok(lossLine, 'Loss line must exist');
  assert.equal(lossLine.debit, 0.04);

  // 3. only_round_cash_method: true
  let db3 = write(base, 'pos.config', cfg.id, { cash_rounding: true, rounding_method_id: roundUp.id, only_round_cash_method: true });
  db3 = startSession(db3, 0, cfg.id).db;
  const paidCard = payOrder(db3, { lines: lines1, method: card.id, config_id: cfg.id });
  const oCard = read(paidCard.db, 'pos.order', paidCard.id);
  assert.equal(oCard.payment_ids[0].amount, 10.02, 'Card payment is not rounded when only_round_cash_method is true');

  const paidCash = payOrder(db3, { lines: lines1, method: cash.id, config_id: cfg.id });
  const oCash = read(paidCash.db, 'pos.order', paidCash.id);
  assert.equal(oCash.payment_ids[0].amount, 10.05, 'Cash payment is rounded when only_round_cash_method is true');

  // 4. Config with HALF-UP (10.02 -> 10.00; 10.03 -> 10.05)
  const roundHalfUp = create(base, 'account.cash.rounding', {
    name: '0.05 HALF-UP',
    rounding: 0.05,
    rounding_method: 'HALF-UP',
    strategy: 'add_invoice_line',
    profit_account_id: profitAcc,
    loss_account_id: lossAcc,
  });
  let db4 = write(roundHalfUp.db, 'pos.config', cfg.id, { cash_rounding: true, rounding_method_id: roundHalfUp.id, only_round_cash_method: false });
  db4 = startSession(db4, 0, cfg.id).db;
  const pDown = payOrder(db4, { lines: [{ product_id: 5, qty: 1, price_unit: 10.02, tax: 0 }], method: cash.id, config_id: cfg.id });
  assert.equal(read(pDown.db, 'pos.order', pDown.id).payment_ids[0].amount, 10.00);
  const pUp = payOrder(db4, { lines: [{ product_id: 5, qty: 1, price_unit: 10.03, tax: 0 }], method: cash.id, config_id: cfg.id });
  assert.equal(read(pUp.db, 'pos.order', pUp.id).payment_ids[0].amount, 10.05);

  // 5. posOrderTotal and split tenders under only_round_cash_method
  const cardOnly = posOrderTotal(db3, lines1, { configId: cfg.id, method: card.id });
  assert.equal(cardOnly.roundedTotal, 10.02);
  const cashOnly = posOrderTotal(db3, lines1, { configId: cfg.id, method: cash.id });
  assert.equal(cashOnly.roundedTotal, 10.05);
  const splitWithCash = posOrderTotal(db3, lines1, { configId: cfg.id, payments: [{ payment_method_id: card.id, amount: 5 }, { payment_method_id: cash.id, amount: 5.05 }] });
  assert.equal(splitWithCash.roundedTotal, 10.05);
});

test('customer invoice cash rounding adds invoice rounding line and balances', () => {
  let db = migrate({ ...seed(), schema_version: 5 });
  const profitAcc = accountId(db, '450000');
  const lossAcc = accountId(db, '690000');
  const rounding = create(db, 'account.cash.rounding', {
    name: '0.05 UP',
    rounding: 0.05,
    rounding_method: 'UP',
    strategy: 'add_invoice_line',
    profit_account_id: profitAcc,
    loss_account_id: lossAcc,
  });
  db = rounding.db;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_cash_rounding_id: rounding.id,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 10.02, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  const posted = read(db, 'account.move', inv.id);
  assert.equal(posted.state, 'posted');
  const roundingLine = posted.line_ids.find((l) => l.account_id === profitAcc);
  assert.ok(roundingLine, 'Invoice must have cash rounding line');
  assert.equal(roundingLine.credit, 0.03);
  const recLine = posted.line_ids.find((l) => l.account_id === accountId(db, '121000'));
  assert.equal(recLine.debit, 10.05, 'Receivable line is rounded to 10.05');
});

test('product form exposes POS categories and category writes reject cycles', () => {
  const db = seed();
  assert.ok(models.product.form.groups.flat().includes('pos_categ_ids'));
  const parent = create(db, 'pos.category', { name: 'Parent' });
  const child = create(parent.db, 'pos.category', { name: 'Child', parent_id: parent.id });
  assert.throws(() => write(child.db, 'pos.category', parent.id, { parent_id: child.id }), /ancestor|cycle/i);
  assert.throws(() => write(child.db, 'pos.category', child.id, { parent_id: child.id }), /ancestor|cycle/i);
});

test('invoice form exposes rounding and draft totals reflect it', () => {
  let db = seed();
  assert.ok(models['account.move'].form.groups.flat().includes('invoice_cash_rounding_id'));
  const rounding = create(db, 'account.cash.rounding', { name: 'Up', rounding: 0.05, rounding_method: 'UP', strategy: 'add_invoice_line' });
  const inv = create(rounding.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_cash_rounding_id: rounding.id, invoice_line_ids: [{ qty: 1, price_unit: 10.02, tax: 0 }] });
  assert.equal(read(inv.db, 'account.move', inv.id).amount_total, 10.05);
});


test('migration preserves named legacy tender identity within its company and POS', () => {
  const base = seed();
  const legacy = { ...base, schema_version: 9, records: { ...base.records,
    'pos.payment.method': [],
    'pos.config': [
      { id: 1, name: 'One', company_id: 1, payment_method_ids: [{ name: 'Card', journal: 'bank' }, { name: 'Gift Voucher', journal: 'bank' }] },
      { id: 2, name: 'Two', company_id: 2, payment_method_ids: [{ name: 'Gift Voucher', journal: 'bank' }] },
    ],
    'pos.order': [
      { id: 1, name: 'One order', company_id: 1, config_id: 1, payment_ids: [{ method: 'Gift Voucher', amount: 5 }] },
      { id: 2, name: 'Two order', company_id: 2, config_id: 2, payment_ids: [{ method: 'Gift Voucher', amount: 7 }] },
    ],
  }, seq: { ...base.seq, 'pos.payment.method': 0, 'pos.config': 2, 'pos.order': 2 } };
  const next = migrate(legacy);
  for (const id of [1, 2]) {
    const order = read(next, 'pos.order', id);
    const method = read(next, 'pos.payment.method', order.payment_ids[0].payment_method_id);
    assert.equal(method.name, 'Gift Voucher');
    assert.equal(method.company_id, id);
  }
});

test('refund reverses original POS journal lines after tender and rounding settings change', () => {
  let db = migrate({ ...seed(), schema_version: 5 });
  const cfg = search(db, 'pos.config')[0];
  const cash = search(db, 'pos.payment.method').find((m) => m.type === 'cash');
  const rounding = create(db, 'account.cash.rounding', { name: 'Up', rounding: 0.05, rounding_method: 'UP', strategy: 'add_invoice_line', profit_account_id: accountId(db, '450000'), loss_account_id: accountId(db, '690000') });
  db = write(rounding.db, 'pos.config', cfg.id, { cash_rounding: true, rounding_method_id: rounding.id });
  db = startSession(db, 0, cfg.id).db;
  const sale = payOrder(db, { lines: [{ product_id: 5, qty: 1, price_unit: 10.02, tax: 0 }], method: cash.id });
  const order = read(sale.db, 'pos.order', sale.id);
  const entries = search(sale.db, 'account.move').filter((m) => m.ref === order.name && m.state === 'posted');
  db = write(sale.db, 'pos.payment.method', cash.id, { active: false });
  db = write(db, 'pos.config', cfg.id, { cash_rounding: false });
  const refunded = refundOrder(db, read(db, 'pos.order', sale.id));
  const refund = search(refunded.db, 'pos.order').find((o) => o.refund_of === order.id);
  const reversals = search(refunded.db, 'account.move').filter((m) => m.ref === refund.name && m.state === 'posted');
  assert.equal(reversals.length, entries.length);
  for (const entry of entries) {
    const reversal = reversals.find((m) => m.journal_id === entry.journal_id);
    assert.deepEqual(reversal.line_ids.map((l) => [l.account_id, l.debit, l.credit]), entry.line_ids.map((l) => [l.account_id, l.credit, l.debit]));
  }
});


test('POS refund reverses only its originating sale and split-tender entries despite a colliding reference', () => {
  let db = startSession(seed(), 0).db;
  const cfg = search(db, 'pos.config')[0];
  const methods = posPaymentMethods(db, cfg.id);
  const cash = methods.find((m) => m.type === 'cash');
  const card = methods.find((m) => m.type === 'bank');
  const sale = payOrder(db, { lines: [{ product_id: 5, qty: 1, price_unit: 10, tax: 0 }], payments: [{ payment_method_id: cash.id, amount: 4 }, { payment_method_id: card.id, amount: 6 }] });
  const order = read(sale.db, 'pos.order', sale.id);
  const unrelated = postEntry(sale.db, { journal: 'MISC', company: 1, ref: order.name, lines: [{ account: '101501', debit: 7 }, { account: '450000', credit: 7 }] });
  const refund = refundOrder(unrelated.db, order);
  const refundOrderRecord = read(refund.db, 'pos.order', refund.id);
  const originals = order.accounting_entries.map(({ move_id }) => read(refund.db, 'account.move', move_id));
  const reversals = search(refund.db, 'account.move').filter((m) => m.ref === refundOrderRecord.name);
  assert.equal(originals.length, 3);
  assert.ok(!order.accounting_entries.some(({ move_id }) => move_id === unrelated.id));
  assert.equal(reversals.length, originals.length);
  for (const [index, entry] of originals.entries()) {
    assert.equal(reversals[index].journal_id, entry.journal_id);
    assert.deepEqual(reversals[index].line_ids.map((l) => [l.account_id, l.debit, l.credit]), entry.line_ids.map((l) => [l.account_id, l.credit, l.debit]));
  }
  assert.deepEqual(read(refund.db, 'account.move', unrelated.id), read(unrelated.db, 'account.move', unrelated.id));
  const first = order.accounting_entries[0].move_id;
  const diff = { upserts: { 'pos.order': [order] } };
  const remapped = remapDiff(diff, { 'account.move': { [first]: 99999 } });
  assert.equal(remapped.upserts['pos.order'][0].accounting_entries[0].move_id, 99999);
  assert.equal(order.accounting_entries[0].move_id, first);
});

test('historical POS orders without move provenance fail safely instead of reversing entries by reference', () => {
  const db = startSession(seed(), 0).db;
  const sale = payOrder(db, { lines: [{ product_id: 5, qty: 1, price_unit: 10, tax: 0 }], method: 'cash' });
  const order = read(sale.db, 'pos.order', sale.id);
  const legacy = write(sale.db, 'pos.order', order.id, { accounting_entries: null });
  assert.throws(() => refundOrder(legacy, read(legacy, 'pos.order', order.id)), /historical orders require manual refund/i);
  assert.equal(read(legacy, 'pos.order', order.id).state, 'paid');
});

test('checkout rejects presets outside the active POS and requires its default', () => {
  let db = seed();
  const cfg = search(db, 'pos.config')[0];
  const p = create(db, 'pos.preset', { name: 'Table' });
  const other = create(p.db, 'pos.preset', { name: 'Other' });
  db = write(other.db, 'pos.config', cfg.id, { available_preset_ids: [p.id], default_preset_id: p.id });
  db = startSession(db, 0, cfg.id).db;
  const cash = search(db, 'pos.payment.method').find((m) => m.type === 'cash');
  const lines = [{ product_id: 5, qty: 1, price_unit: 10, tax: 0 }];
  assert.throws(() => payOrder(db, { lines, method: cash.id, preset_id: other.id }), /preset/i);
  assert.throws(() => payOrder(db, { lines, method: cash.id, preset_id: 99999 }), /preset/i);
  const paid = payOrder(db, { lines, method: cash.id });
  assert.equal(read(paid.db, 'pos.order', paid.id).preset_id, p.id);
});

test('foreign rounded invoices and credit notes retain currency amounts and can be settled', () => {
  let db = seed();
  const currency = search(db, 'res.currency').find((c) => c.name === 'SAR');
  const rounding = create(db, 'account.cash.rounding', { name: 'Up', rounding: 0.05, rounding_method: 'UP', strategy: 'add_invoice_line', profit_account_id: accountId(db, '450000'), loss_account_id: accountId(db, '690000') });
  db = rounding.db;
  for (const move_type of ['out_invoice', 'out_refund']) {
    const made = create(db, 'account.move', { move_type, partner_id: 3, currency_id: currency.id, invoice_date: '2026-10-01', invoice_cash_rounding_id: rounding.id, invoice_line_ids: [{ qty: 1, price_unit: 10.02, tax: 0 }] });
    assert.equal(read(made.db, 'account.move', made.id).amount_total, 10.05);
    db = postMove(made.db, made.id);
    const posted = read(db, 'account.move', made.id);
    const line = posted.line_ids.find((l) => l.name === 'Cash Rounding');
    assert.equal(line.currency_id, currency.id);
    assert.equal(line.amount_currency, move_type === 'out_invoice' ? -0.03 : 0.03);
    assert.equal(posted.line_ids.reduce((sum, l) => sum + Math.round((l.amount_currency || 0) * 100), 0), 0);
    db = payMove(db, made.id, 10.05, '2026-10-02');
    assert.equal(read(db, 'account.move', made.id).amount_residual, 0);
  }
});


test('POS posts and closes in the session company using that company journals and accounts', () => {
  let db = seed();
  const company = create(db, 'res.company', { name: 'Branch' }); db = company.db;
  for (const [code, type] of [['121000', 'asset_receivable'], ['400000', 'income'], ['101501', 'asset_cash'], ['450000', 'income_other'], ['690000', 'expense_other']]) {
    db = create(db, 'account.account', { code, name: `Branch ${code}`, account_type: type, company_id: company.id }).db;
  }
  const account = (code) => search(db, 'account.account').find((a) => a.code === code && a.company_id === company.id);
  for (const [code, type, acc] of [['POSS', 'sale', '400000'], ['CSH1', 'cash', '101501']]) {
    db = create(db, 'account.journal', { name: `Branch ${code}`, code, type, company_id: company.id, default_account_id: account(acc).id }).db;
  }
  const cfg = create(db, 'pos.config', { name: 'Branch POS', company_id: company.id }); db = cfg.db;
  const method = create(db, 'pos.payment.method', { name: 'Branch cash', type: 'cash', company_id: company.id, config_ids: [cfg.id], journal_id: search(db, 'account.journal').find((j) => j.code === 'CSH1' && j.company_id === company.id).id }); db = method.db;
  db = startSession(db, 0, cfg.id).db;
  const paid = payOrder(db, { lines: [{ product_id: 5, qty: 1, price_unit: 10, tax: 0 }], method: method.id });
  const order = read(paid.db, 'pos.order', paid.id);
  const moves = search(paid.db, 'account.move').filter((m) => m.ref === order.name);
  assert.equal(moves.length, 2);
  for (const move of moves) {
    assert.equal(move.company_id, company.id);
    assert.equal(read(paid.db, 'account.journal', move.journal_id).company_id, company.id);
    for (const line of move.line_ids) assert.equal(read(paid.db, 'account.account', line.account_id).company_id, company.id);
  }
  const session = search(paid.db, 'pos.session').find((s) => s.state === 'opened');
  const closed = closeSession(paid.db, session, 11);
  const difference = search(closed, 'account.move').find((m) => m.ref === `${session.name} cash difference`);
  assert.equal(difference.company_id, company.id);
  assert.equal(read(closed, 'account.journal', difference.journal_id).company_id, company.id);
});

test('POS server prices and posts the configured preset fiscal position', () => {
  let db = seed();
  const cfg = search(db, 'pos.config')[0];
  const income = accountId(db, '400000');
  const mapped = accountId(db, '450000');
  const fp = create(db, 'account.fiscal.position', { name: 'Preset mapping', account_ids: [{ account_src_id: income, account_dest_id: mapped }] });
  const list = create(fp.db, 'product.pricelist', { name: 'Preset prices', items: [{ product_id: 5, min_qty: 1, fixed_price: 7 }] });
  const preset = create(list.db, 'pos.preset', { name: 'Preset', pricelist_id: list.id, fiscal_position_id: fp.id });
  db = write(preset.db, 'pos.config', cfg.id, { available_preset_ids: [preset.id], default_preset_id: preset.id });
  db = startSession(db, 0, cfg.id).db;
  const cash = search(db, 'pos.payment.method').find((m) => m.type === 'cash');
  const result = runPosting(db, null, '/api/pos/pay', { lines: [{ product_id: 5, qty: 1 }], method: cash.id });
  const order = read(result.db, 'pos.order', result.body.id);
  assert.equal(order.lines[0].price_unit, 7);
  assert.equal(order.fiscal_position_id, fp.id);
  const sale = search(result.db, 'account.move').find((m) => m.ref === order.name && m.journal_id === journalId(db, 'POSS'));
  assert.ok(sale.line_ids.some((l) => l.account_id === mapped && l.credit === 7));
});

test('POS config form edits payment_method_ids and checkout rejects unconfigured methods without fallback', () => {
  let db = seed();
  assert.equal(models['pos.config'].fields.payment_method_ids.type, 'many2many');
  assert.equal(models['pos.config'].fields.payment_method_ids.relation, 'pos.payment.method');
  const paymentsTab = models['pos.config'].form.tabs.find((t) => t.label === 'Payments');
  assert.ok(paymentsTab.fields.includes('payment_method_ids'));

  const cfg = search(db, 'pos.config')[0];
  const cash = search(db, 'pos.payment.method').find((m) => m.type === 'cash');
  const card = search(db, 'pos.payment.method').find((m) => m.type === 'bank');

  // Configure only Card on cfg
  db = write(db, 'pos.config', cfg.id, { payment_method_ids: [card.id] });
  db = startSession(db, 0, cfg.id).db;

  const methods = posPaymentMethods(db, cfg.id);
  assert.equal(methods.length, 1);
  assert.equal(methods[0].id, card.id);

  // Paying with cash must be rejected
  assert.throws(() => runPosting(db, null, '/api/pos/pay', { lines: [{ product_id: 5, qty: 1 }], method: cash.id }), /Invalid payment method/);

  // Clear all payment methods on cfg: checkout rejects without fallback to hardcoded Cash/Card
  db = write(db, 'pos.config', cfg.id, { payment_method_ids: [] });
  assert.equal(posPaymentMethods(db, cfg.id).length, 0);
  assert.throws(() => runPosting(db, null, '/api/pos/pay', { lines: [{ product_id: 5, qty: 1 }], method: card.id }), /Invalid payment method/);
  assert.throws(() => runPosting(db, null, '/api/pos/pay', { lines: [{ product_id: 5, qty: 1 }], method: 'cash' }), /Invalid payment method/);
});

test('direct payOrder validates method strings against configured records and rejects unconfigured methods', () => {
  let db = seed();
  const cfg = search(db, 'pos.config')[0];
  const card = search(db, 'pos.payment.method').find((m) => m.type === 'bank');
  // Configure ONLY card on cfg
  db = write(db, 'pos.config', cfg.id, { payment_method_ids: [card.id] });
  db = startSession(db, 0, cfg.id).db;
  const lines = [{ product_id: 5, qty: 1, price_unit: 10, tax: 0 }];
  // String method 'cash' must throw Invalid payment method
  assert.throws(() => payOrder(db, { lines, method: 'cash' }), /Invalid payment method/);
  // String method 'card' succeeds and resolves to card record
  const paid = payOrder(db, { lines, method: 'card' });
  const order = read(paid.db, 'pos.order', paid.id);
  assert.equal(order.payment_method_id, card.id);
  assert.equal(order.payment_ids[0].payment_method_id, card.id);
});

test('default return preset resolves before quantity check in both payOrder and server checkout', () => {
  let db = seed();
  const cfg = search(db, 'pos.config')[0];
  const cash = search(db, 'pos.payment.method').find((m) => m.type === 'cash');
  const returnPreset = create(db, 'pos.preset', { name: 'Default Return', is_return: true, identification: 'none', service_at: 'counter' });
  db = write(returnPreset.db, 'pos.config', cfg.id, { available_preset_ids: [returnPreset.id], default_preset_id: returnPreset.id });
  db = startSession(db, 0, cfg.id).db;
  // With preset_id omitted, default preset is return: negative quantity is required and accepted!
  assert.throws(() => payOrder(db, { lines: [{ product_id: 5, qty: 1, price_unit: 10, tax: 0 }], method: cash.id }), /Return cart quantity must be negative/);
  const paidLocal = payOrder(db, { lines: [{ product_id: 5, qty: -1, price_unit: 10, tax: 0 }], method: cash.id });
  assert.equal(read(paidLocal.db, 'pos.order', paidLocal.id).preset_id, returnPreset.id);

  // Server checkout with omitted preset_id
  assert.throws(() => runPosting(db, null, '/api/pos/pay', { lines: [{ product_id: 5, qty: 1 }], method: cash.id }), /Return cart quantity must be negative/);
  const paidServer = runPosting(db, null, '/api/pos/pay', { lines: [{ product_id: 5, qty: -1 }], method: cash.id });
  const serverOrder = read(paidServer.db, 'pos.order', paidServer.body.id);
  assert.equal(serverOrder.preset_id, returnPreset.id);
  assert.ok(serverOrder.amount_total < 0);
});

test('explicit return split payments with negative amounts are accepted and posted by server checkout', () => {
  let db = seed();
  const cfg = search(db, 'pos.config')[0];
  const cash = search(db, 'pos.payment.method').find((m) => m.type === 'cash');
  const card = search(db, 'pos.payment.method').find((m) => m.type === 'bank');
  const returnPreset = create(db, 'pos.preset', { name: 'Return Split', is_return: true, identification: 'none', service_at: 'counter' });
  db = write(returnPreset.db, 'pos.config', cfg.id, { available_preset_ids: [returnPreset.id], default_preset_id: returnPreset.id });
  db = startSession(db, 0, cfg.id).db;

  const payments = [
    { payment_method_id: cash.id, amount: -100 },
    { payment_method_id: card.id, amount: -71 },
  ];
  const res = runPosting(db, null, '/api/pos/pay', {
    lines: [{ product_id: 5, qty: -1 }],
    payments,
    preset_id: returnPreset.id,
  });
  const order = read(res.db, 'pos.order', res.body.id);
  assert.equal(order.amount_total, -171);
  assert.equal(order.payment_ids.length, 2);
  assert.equal(order.payment_ids[0].amount, -100);
  assert.equal(order.payment_ids[1].amount, -71);

  const cashMove = search(res.db, 'account.move').find((m) => m.ref === order.name && m.journal_id === cash.journal_id);
  assert.ok(cashMove.line_ids.some((l) => l.credit === 100));
  const cardMove = search(res.db, 'account.move').find((m) => m.ref === order.name && m.journal_id === card.journal_id);
  assert.ok(cardMove.line_ids.some((l) => l.credit === 71));
});

test('automatically valued sale and refund does not duplicate stock valuation moves', () => {
  let db = seed();
  const prod = create(db, 'product', { name: 'Auto Valued Product', type: 'goods', valuation: 'automated', cost: 20, available_in_pos: true, sale_ok: true });
  db = prod.db;
  db = receive(db, prod.id, 10, 20);
  const cfg = search(db, 'pos.config')[0];
  const cash = search(db, 'pos.payment.method').find((m) => m.type === 'cash');
  db = startSession(db, 0, cfg.id).db;

  const sale = payOrder(db, { lines: [{ product_id: prod.id, qty: 2, price_unit: 50, tax: 0 }], method: cash.id });
  const saleOrder = read(sale.db, 'pos.order', sale.id);

  const saleMoves = search(sale.db, 'account.move').filter((m) => m.ref === saleOrder.name && m.state === 'posted');
  assert.equal(saleMoves.length, 3, 'Sale should produce 3 posted moves: sale, tender, and valuation');
  const valMove = saleMoves.find((m) => m.journal_id === journalId(sale.db, 'MISC'));
  assert.ok(valMove, 'Valuation move must exist for automated product sale');
  assert.ok(valMove.line_ids.some((l) => l.account_id === accountId(sale.db, '500000') && l.debit === 40));
  assert.ok(valMove.line_ids.some((l) => l.account_id === accountId(sale.db, '110100') && l.credit === 40));

  const refunded = refundOrder(sale.db, saleOrder);
  const refundOrderRec = search(refunded.db, 'pos.order').find((o) => o.refund_of === saleOrder.id);
  const refundMoves = search(refunded.db, 'account.move').filter((m) => m.ref === refundOrderRec.name && m.state === 'posted');

  assert.equal(refundMoves.length, 3, 'Refund must have exactly 3 moves (valuation return, reversed sale, reversed tender)');
  const refundValuation = refundMoves.filter((m) => m.journal_id === journalId(sale.db, 'MISC'));
  assert.equal(refundValuation.length, 1, 'Exactly one stock valuation move on refund, no duplicate reversal');
  assert.ok(refundValuation[0].line_ids.some((l) => l.account_id === accountId(refunded.db, '110100') && l.debit === 40));
  assert.ok(refundValuation[0].line_ids.some((l) => l.account_id === accountId(refunded.db, '500000') && l.credit === 40));
});

test('reversing a return removes the returned stock and reverses its valuation', () => {
  for (const valuation of ['automated', 'manual_periodic']) {
    let db = seed();
    const prod = create(db, 'product', { name: `Return ${valuation}`, type: 'goods', valuation, cost: 20, available_in_pos: true, sale_ok: true });
    db = prod.db;
    const cfg = search(db, 'pos.config')[0];
    const preset = create(db, 'pos.preset', { name: 'Return', is_return: true, identification: 'none', service_at: 'counter' });
    db = write(preset.db, 'pos.config', cfg.id, { available_preset_ids: [preset.id], default_preset_id: preset.id });
    db = startSession(db, 0, cfg.id).db;
    const qty = (state) => (state.records['stock.quant'] ?? []).filter((q) => q.product_id === prod.id).reduce((sum, q) => sum + q.quantity, 0);
    const layers = (state) => (state.records['stock.valuation.layer'] ?? []).filter((l) => l.product_id === prod.id);
    assert.equal(qty(db), 0);
    const returned = payOrder(db, { lines: [{ product_id: prod.id, qty: -2, price_unit: 50, tax: 0 }], method: 'cash' });
    assert.equal(qty(returned.db), 2);
    if (valuation === 'automated') assert.deepEqual(layers(returned.db).map((l) => [l.quantity, l.value]), [[2, 40]]);
    const reversed = refundOrder(returned.db, read(returned.db, 'pos.order', returned.id));
    assert.equal(qty(reversed.db), 0);
    if (valuation === 'automated') {
      assert.deepEqual(layers(reversed.db).map((l) => [l.quantity, l.value]), [[2, 40], [-2, -40]]);
      const outgoing = layers(reversed.db)[1];
      const move = read(reversed.db, 'account.move', outgoing.move_id);
      assert.ok(move.line_ids.some((l) => l.account_id === accountId(reversed.db, '110100') && l.credit === 40));
      assert.ok(move.line_ids.some((l) => l.account_id === accountId(reversed.db, '500000') && l.debit === 40));
    } else assert.equal(layers(reversed.db).length, 0);
  }
});

test('return cancellation preserves differently valued stock and rejects consumed return layers', () => {
  for (const method of ['fifo', 'average']) {
    let db = seed();
    const prod = create(db, 'product', { name: method, type: 'goods', valuation: 'real_time', cost_method: method, cost: 10, sale_ok: true });
    db = receive(prod.db, prod.id, 1, 10);
    db = write(db, 'product', prod.id, { cost: 20 });
    const cfg = search(db, 'pos.config')[0];
    const preset = create(db, 'pos.preset', { name: 'Return', is_return: true, identification: 'none' });
    db = write(preset.db, 'pos.config', cfg.id, { available_preset_ids: [preset.id], default_preset_id: preset.id });
    db = startSession(db, 0, cfg.id).db;
    const returned = payOrder(db, { lines: [{ product_id: prod.id, qty: -2, price_unit: 30, tax: 0 }], method: 'cash' });
    const order = read(returned.db, 'pos.order', returned.id);
    const receipt = read(returned.db, 'stock.valuation.layer', order.return_layers[0].layer_id);
    assert.equal(receipt.value, 40);
    const reversed = refundOrder(returned.db, order);
    const ls = search(reversed.db, 'stock.valuation.layer').filter((l) => l.product_id === prod.id);
    assert.deepEqual(ls.map((l) => [l.quantity, l.value]), [[1, 10], [2, 40], [-2, -40]]);
    assert.equal(ls.reduce((s, l) => s + l.remaining_qty, 0), 1);
    assert.equal(ls.reduce((s, l) => s + l.remaining_value, 0), 10);
    const originalMove = read(reversed.db, 'account.move', receipt.move_id);
    const reverseMove = read(reversed.db, 'account.move', ls[2].move_id);
    assert.deepEqual(reverseMove.line_ids.map((l) => [l.account_id, l.debit, l.credit]), originalMove.line_ids.map((l) => [l.account_id, l.credit, l.debit]));
    const consumed = deliver(returned.db, prod.id, 1.5).db;
    assert.throws(() => refundOrder(consumed, read(consumed, 'pos.order', order.id)), /consumed or revalued/);
  }
});

test('automatically valued goods sold in a second company scope stock valuation to that company', () => {
  let db = seed();
  const company = create(db, 'res.company', { name: 'Company Two' });
  db = company.db;
  for (const [code, type] of [['121000', 'asset_receivable'], ['400000', 'income'], ['101501', 'asset_cash'], ['110100', 'asset_current'], ['500000', 'expense_direct'], ['450000', 'income_other'], ['690000', 'expense_other']]) {
    db = create(db, 'account.account', { code, name: `C2 ${code}`, account_type: type, company_id: company.id }).db;
  }
  const account = (code) => search(db, 'account.account').find((a) => a.code === code && a.company_id === company.id);
  for (const [code, type, acc] of [['POSS', 'sale', '400000'], ['CSH1', 'cash', '101501'], ['MISC', 'general', '110100']]) {
    db = create(db, 'account.journal', { name: `C2 ${code}`, code, type, company_id: company.id, default_account_id: account(acc).id }).db;
  }
  const cfg = create(db, 'pos.config', { name: 'C2 POS', company_id: company.id }); db = cfg.db;
  const method = create(db, 'pos.payment.method', { name: 'C2 Cash', type: 'cash', company_id: company.id, config_ids: [cfg.id], journal_id: search(db, 'account.journal').find((j) => j.code === 'CSH1' && j.company_id === company.id).id }); db = method.db;

  const prod = create(db, 'product', { name: 'Valued Widget', type: 'goods', valuation: 'automated', cost: 15, list_price: 30, company_id: company.id, available_in_pos: true, sale_ok: true, qty_available: 5 });
  db = prod.db;

  db = startSession(db, 0, cfg.id).db;
  const paid = payOrder(db, { lines: [{ product_id: prod.id, qty: 1, price_unit: 30, tax: 0 }], method: method.id });
  const order = read(paid.db, 'pos.order', paid.id);
  const moves = search(paid.db, 'account.move').filter((m) => m.ref === order.name);
  assert.equal(moves.length, 3, 'Should have sale, tender, and stock valuation moves');
  for (const move of moves) {
    assert.equal(move.company_id, company.id, 'Move must belong to company 2');
    assert.equal(read(paid.db, 'account.journal', move.journal_id).company_id, company.id, 'Journal must belong to company 2');
    for (const line of move.line_ids) {
      assert.equal(read(paid.db, 'account.account', line.account_id).company_id, company.id, 'All accounts must belong to company 2');
    }
  }
});

test('shared product POS valuation opens and consumes only the session company stock', () => {
  let db = seed();
  const company = create(db, 'res.company', { name: 'Independent stock company' }); db = company.db;
  for (const [code, type] of [['121000', 'asset_receivable'], ['400000', 'income'], ['101501', 'asset_cash'], ['110100', 'asset_current'], ['500000', 'expense_direct'], ['301000', 'equity']]) {
    db = create(db, 'account.account', { code, name: `C2 ${code}`, account_type: type, company_id: company.id }).db;
  }
  const c2account = (code) => (db.records['account.account'] ?? []).find((a) => a.code === code && a.company_id === company.id);
  for (const [code, type, acc] of [['POSS', 'sale', '400000'], ['CSH1', 'cash', '101501'], ['MISC', 'general', '110100']]) {
    db = create(db, 'account.journal', { name: `C2 ${code}`, code, type, company_id: company.id, default_account_id: c2account(acc).id }).db;
  }
  const cfg = create(db, 'pos.config', { name: 'C2 POS', company_id: company.id }); db = cfg.db;
  const method = create(db, 'pos.payment.method', { name: 'C2 Cash', type: 'cash', company_id: company.id, config_ids: [cfg.id], journal_id: (db.records['account.journal'] ?? []).find((j) => j.code === 'CSH1' && j.company_id === company.id).id }); db = method.db;
  const prod = create(db, 'product', { name: 'Shared FIFO', type: 'goods', company_id: null, valuation: 'real_time', cost_method: 'fifo', cost: 20, qty_available: 5, property_stock_valuation_account_id: accountId(db, '110100', 1), property_stock_journal: journalId(db, 'MISC', 1) }); db = prod.db;
  const loc1 = (db.records['stock.location'] ?? []).find((l) => l.usage === 'internal' && (l.company_id ?? 1) === 1);
  const loc2 = create(db, 'stock.location', { name: 'C2 stock', usage: 'internal', company_id: company.id }); db = loc2.db;
  db = create(db, 'stock.quant', { product_id: prod.id, location_id: loc1.id, company_id: 1, quantity: 2 }).db;
  db = create(db, 'stock.quant', { product_id: prod.id, location_id: loc2.id, company_id: company.id, quantity: 3 }).db;
  const old = create(db, 'stock.valuation.layer', { product_id: prod.id, company_id: 1, date: '0001-01-01', quantity: 2, value: 20, remaining_qty: 2, remaining_value: 20, unit_cost: 10, kind: 'in' }); db = old.db;
  db = startSession(db, 0, cfg.id).db;
  assert.throws(() => payOrder(db, { lines: [{ product_id: prod.id, qty: 4, price_unit: 30, tax: 0 }], method: method.id }), /not enough stock/i);
  const paid = payOrder(db, { lines: [{ product_id: prod.id, qty: 1, price_unit: 30, tax: 0 }], method: method.id });
  const ls = (paid.db.records['stock.valuation.layer'] ?? []).filter((l) => l.product_id === prod.id);
  assert.equal(ls.find((l) => l.id === old.id).remaining_qty, 2);
  const opening = ls.find((l) => l.opening && l.company_id === company.id);
  assert.equal(opening.quantity, 3);
  assert.equal(opening.value, 60);
  const outgoing = ls.find((l) => l.kind === 'out' && l.company_id === company.id);
  assert.equal(outgoing.value, -20);
  assert.equal(opening.remaining_qty, 2);
  for (const layer of [opening, outgoing]) {
    const move = read(paid.db, 'account.move', layer.move_id);
    assert.equal(move.company_id, company.id);
    assert.equal(read(paid.db, 'account.journal', move.journal_id).company_id, company.id);
    assert.ok(move.line_ids.every((l) => read(paid.db, 'account.account', l.account_id).company_id === company.id));
  }
  assert.equal((paid.db.records['stock.quant'] ?? []).find((q) => q.product_id === prod.id && q.company_id === 1).quantity, 2);
  const session = read(paid.db, 'pos.session', read(paid.db, 'pos.order', paid.id).session_id);
  db = closeSession(paid.db, session, 30);
  const mainConfig = (db.records['pos.config'] ?? []).find((c) => (c.company_id ?? 1) === 1);
  const mainCash = posPaymentMethods(db, mainConfig.id).find((m) => m.type === 'cash');
  db = startSession(db, 0, mainConfig.id).db;
  const mainSale = payOrder(db, { lines: [{ product_id: prod.id, qty: 1, price_unit: 30, tax: 0 }], method: mainCash.id });
  const mainLayers = (mainSale.db.records['stock.valuation.layer'] ?? []).filter((l) => l.product_id === prod.id);
  assert.equal(mainLayers.find((l) => l.company_id === 1 && l.kind === 'out').value, -10);
  assert.equal(mainLayers.find((l) => l.id === old.id).remaining_qty, 1);
  assert.equal(mainLayers.find((l) => l.id === opening.id).remaining_qty, 2);
});

test('posProducts filters products by configuration company and allowed company settings', () => {
  let db = seed();
  const c2 = create(db, 'res.company', { name: 'Company 2' }); db = c2.db;
  db = setCompanies(db, { current: 1, allowed: [1, c2.id] });
  const cfg1 = search(db, 'pos.config')[0];
  const cfg2 = create(db, 'pos.config', { name: 'C2 Config', company_id: c2.id }); db = cfg2.db;

  const p1 = create(db, 'product', { name: 'C1 Only Product', company_id: 1, available_in_pos: true, sale_ok: true }); db = p1.db;
  const p2 = create(db, 'product', { name: 'C2 Only Product', company_id: c2.id, available_in_pos: true, sale_ok: true }); db = p2.db;
  const pShared = create(db, 'product', { name: 'Shared Product', company_id: null, available_in_pos: true, sale_ok: true }); db = pShared.db;

  const prodsConfig1 = posProducts(db, { configId: cfg1.id });
  assert.ok(prodsConfig1.some((p) => p.id === p1.id));
  assert.ok(prodsConfig1.some((p) => p.id === pShared.id));
  assert.ok(!prodsConfig1.some((p) => p.id === p2.id), 'Company 2 product must not appear in Company 1 POS');

  const prodsConfig2 = posProducts(db, { configId: cfg2.id });
  assert.ok(prodsConfig2.some((p) => p.id === p2.id));
  assert.ok(prodsConfig2.some((p) => p.id === pShared.id));
  assert.ok(!prodsConfig2.some((p) => p.id === p1.id), 'Company 1 product must not appear in Company 2 POS');
});

test('migration 11 repairs schema 10 databases by resolving tenders within order configuration', () => {
  const base = seed();
  const schema10Db = {
    ...base,
    schema_version: 10,
    records: {
      ...base.records,
      'pos.payment.method': [
        { id: 101, name: 'Main Card', type: 'bank', company_id: 1, config_ids: [1] },
        { id: 102, name: 'Branch Card', type: 'bank', company_id: 1, config_ids: [2] },
      ],
      'pos.config': [
        { id: 1, name: 'Main Shop', company_id: 1, payment_method_ids: [101] },
        { id: 2, name: 'Branch Shop', company_id: 1, payment_method_ids: [102] },
      ],
      'pos.order': [
        { id: 1, name: 'Branch Order', company_id: 1, config_id: 2, payment_method: 'card', payment_method_id: 101, payment_ids: [{ method: 'card', payment_method_id: 101, amount: 25 }] },
      ],
    },
    seq: { ...base.seq, 'pos.payment.method': 102, 'pos.config': 2, 'pos.order': 1 },
  };
  const repaired = migrate(schema10Db);
  assert.equal(repaired.schema_version, 11);
  const order = read(repaired, 'pos.order', 1);
  assert.equal(order.payment_method_id, 102, 'Order tender repaired to match the configuration payment method');
  assert.equal(order.payment_ids[0].payment_method_id, 102);
});

test('migration preserves explicit configured tenders of the same type and repairs invalid selections idempotently', () => {
  const base = seed();
  const legacy = {
    ...base,
    schema_version: 10,
    records: {
      ...base.records,
      'pos.payment.method': [
        { id: 101, name: 'First Card', type: 'bank', company_id: 1, config_ids: [1] },
        { id: 102, name: 'Second Card', type: 'bank', company_id: 1, config_ids: [1], active: false },
        { id: 103, name: 'Other Card', type: 'bank', company_id: 1, config_ids: [2] },
        { id: 104, name: 'Foreign Card', type: 'bank', company_id: 2, config_ids: [1] },
      ],
      'pos.config': [
        { id: 1, name: 'Shop', company_id: 1, payment_method_ids: [101, 102] },
        { id: 2, name: 'Other Shop', company_id: 1, payment_method_ids: [103] },
      ],
      'pos.order': [
        { id: 1, company_id: 1, config_id: 1, payment_method: 'card', payment_method_id: 102, payment_ids: [{ method: 'card', payment_method_id: 101, amount: 5 }, { method: 'card', payment_method_id: 102, amount: 10 }] },
        { id: 2, company_id: 1, config_id: 1, payment_method: 'card', payment_method_id: 103, payment_ids: [{ method: 'card', payment_method_id: 103, amount: 5 }, { method: 'card', payment_method_id: 104, amount: 5 }, { method: 'card', payment_method_id: 999, amount: 5 }, { method: 'card', amount: 5 }] },
      ],
    },
  };
  const repaired = migrate(legacy);
  const explicit = read(repaired, 'pos.order', 1);
  assert.equal(explicit.payment_method_id, 102);
  assert.deepEqual(explicit.payment_ids.map((p) => p.payment_method_id), [101, 102]);
  const invalid = read(repaired, 'pos.order', 2);
  assert.equal(invalid.payment_method_id, 101);
  assert.deepEqual(invalid.payment_ids.map((p) => p.payment_method_id), [101, 101, 101, 101]);
  assert.strictEqual(migrate(repaired), repaired);
  const rerun = migrate({ ...repaired, schema_version: 10 });
  assert.deepEqual(rerun.records['pos.order'], repaired.records['pos.order']);
});

test('biggest_tax strategy without taxes falls back to cash rounding line preserving document currency balance', () => {
  let db = seed();
  const currency = search(db, 'res.currency').find((c) => c.name === 'SAR');
  const rounding = create(db, 'account.cash.rounding', {
    name: '0.05 UP biggest_tax',
    rounding: 0.05,
    rounding_method: 'UP',
    strategy: 'biggest_tax',
    profit_account_id: accountId(db, '450000'),
    loss_account_id: accountId(db, '690000'),
  });
  db = rounding.db;

  for (const move_type of ['out_invoice', 'out_refund']) {
    const made = create(db, 'account.move', {
      move_type,
      partner_id: 3,
      currency_id: currency.id,
      invoice_date: '2026-10-01',
      invoice_cash_rounding_id: rounding.id,
      invoice_line_ids: [{ qty: 1, price_unit: 10.02, tax: 0 }],
    });
    assert.equal(read(made.db, 'account.move', made.id).amount_total, 10.05);
    db = postMove(made.db, made.id);
    const posted = read(db, 'account.move', made.id);

    const roundingLine = posted.line_ids.find((l) => l.name === 'Cash Rounding');
    assert.ok(roundingLine, 'Fallback rounding line must be generated when biggest_tax has no tax lines');
    assert.equal(roundingLine.currency_id, currency.id);
    assert.equal(roundingLine.amount_currency, move_type === 'out_invoice' ? -0.03 : 0.03);

    assert.equal(posted.line_ids.reduce((sum, l) => sum + Math.round((l.amount_currency || 0) * 100), 0), 0);
    assert.equal(posted.line_ids.reduce((sum, l) => sum + Math.round((l.debit - l.credit) * 100), 0), 0);
  }
});

test('zero-total POS checkout rejects offsetting tenders and leaves drawer totals and accounting unchanged', () => {
  const sessionRes = startSession(seed(), 100);
  const db = sessionRes.db;
  const session = read(db, 'pos.session', sessionRes.id);
  const methods = search(db, 'pos.payment.method');
  const cash = methods.find((m) => m.type === 'cash');
  const card = methods.find((m) => m.type === 'bank');
  assert.ok(cash && card);

  const initialTotals = sessionTotals(db, session);
  assert.deepEqual(initialTotals, { orders: 0, cash: 0, card: 0, expected: 100 });
  const initialMoves = search(db, 'account.move').length;

  const lines = [{ product_id: 5, qty: 1, price_unit: 0, tax: 0 }];
  const offsettingPayments = [
    { payment_method_id: cash.id, amount: 100 },
    { payment_method_id: card.id, amount: -100 },
  ];

  assert.throws(() => payOrder(db, { lines, payments: offsettingPayments }), /Invalid payment/);
  assert.throws(() => payCart(db, { cart: [{ product_id: 5, qty: 1, discount: 100 }], payments: offsettingPayments }), /Invalid payment/);

  // Assert drawer totals and accounting entries remain unchanged
  assert.deepEqual(sessionTotals(db, session), initialTotals);
  assert.equal(search(db, 'account.move').length, initialMoves);

  // Legitimate zero-total checkout with zero tender succeeds without altering drawer totals or posting moves
  const validSale = payOrder(db, { lines, payments: [{ payment_method_id: cash.id, amount: 0 }] });
  assert.deepEqual(sessionTotals(validSale.db, session), { orders: 1, cash: 0, card: 0, expected: 100 });
  assert.equal(search(validSale.db, 'account.move').length, initialMoves);
  assert.deepEqual(read(validSale.db, 'pos.order', validSale.id).accounting_entries, []);
});

test('zero-total POS refund rejects offsetting tenders and legitimate zero-total refund preserves drawer totals and accounting', () => {
  const sessionRes = startSession(seed(), 100);
  const db = sessionRes.db;
  const session = read(db, 'pos.session', sessionRes.id);
  const methods = search(db, 'pos.payment.method');
  const cash = methods.find((m) => m.type === 'cash');
  const card = methods.find((m) => m.type === 'bank');

  const lines = [{ product_id: 5, qty: 1, price_unit: 0, tax: 0 }];
  const sale = payOrder(db, { lines, method: 'cash' });
  const saleOrder = read(sale.db, 'pos.order', sale.id);
  assert.equal(saleOrder.amount_total, 0);
  assert.deepEqual(saleOrder.accounting_entries, []);

  const beforeRefundTotals = sessionTotals(sale.db, session);
  const beforeRefundMoves = search(sale.db, 'account.move').length;

  const offsettingPayments = [
    { payment_method_id: cash.id, amount: 100 },
    { payment_method_id: card.id, amount: -100 },
  ];

  // Sibling: attempting refund of zero-total order with offsetting tenders must be rejected
  assert.throws(() => payOrder(sale.db, { lines, refund_of: sale.id, payments: offsettingPayments }), /Invalid payment/);
  assert.deepEqual(sessionTotals(sale.db, session), beforeRefundTotals);
  assert.equal(search(sale.db, 'account.move').length, beforeRefundMoves);

  // Legitimate refund of zero-total order
  const refunded = refundOrder(sale.db, saleOrder);
  assert.equal(read(refunded.db, 'pos.order', sale.id).state, 'refunded');
  assert.deepEqual(sessionTotals(refunded.db, session), { orders: 2, cash: 0, card: 0, expected: 100 });
  assert.equal(search(refunded.db, 'account.move').length, beforeRefundMoves);
  assert.deepEqual(read(refunded.db, 'pos.order', refunded.id).accounting_entries, []);
});

test('payOrder enforces refund-state, duplicate refund rejection, and rejects mismatched refund tenders leaving drawer and accounting consistent', () => {
  let db = seed();
  const sessionRes = startSession(db, 100);
  db = sessionRes.db;
  const session = read(db, 'pos.session', sessionRes.id);

  const methods = search(db, 'pos.payment.method');
  const cash = methods.find((m) => m.type === 'cash');
  const card = methods.find((m) => m.type === 'bank');
  assert.ok(cash && card);

  // 1. Single cash sale of 10
  const lines = [{ product_id: 5, qty: 1, price_unit: 10, tax: 0 }];
  const sale = payOrder(db, { lines, method: cash.id });
  const saleOrder = read(sale.db, 'pos.order', sale.id);
  assert.equal(saleOrder.amount_total, 10);
  assert.deepEqual(sessionTotals(sale.db, session), { orders: 1, cash: 10, card: 0, expected: 110 });

  // Repro: cash sale 10, direct refund with cash -90 / card 100 -> must be rejected
  assert.throws(
    () => payOrder(sale.db, {
      lines,
      refund_of: sale.id,
      payments: [
        { payment_method_id: cash.id, amount: -90 },
        { payment_method_id: card.id, amount: 100 },
      ],
    }),
    /Invalid payment|match.*original/i
  );

  // Mismatched single tender: cash sale refunded with card
  assert.throws(
    () => payOrder(sale.db, { lines, refund_of: sale.id, method: card.id }),
    /Invalid payment|match.*original/i
  );

  // Mismatched tender in payments: cash sale refunded with card payments
  assert.throws(
    () => payOrder(sale.db, { lines, refund_of: sale.id, payments: [{ payment_method_id: card.id, amount: 10 }] }),
    /Invalid payment|match.*original/i
  );

  // Correct refund deriving tenders when omitted
  const refunded = payOrder(sale.db, { lines, refund_of: sale.id });
  const refundOrderRec = read(refunded.db, 'pos.order', refunded.id);
  assert.equal(refundOrderRec.state, 'refund');
  assert.equal(read(refunded.db, 'pos.order', sale.id).state, 'refunded');

  // Drawer totals and accounting consistent
  const totals = sessionTotals(refunded.db, session);
  assert.deepEqual(totals, { orders: 2, cash: 0, card: 0, expected: 100 });
  const cashAccountId = accountId(refunded.db, '101501', session.company_id);
  assert.ok(cashAccountId);
  const saleMoves = search(refunded.db, 'account.move').filter((m) => m.ref === saleOrder.name && m.state === 'posted');
  const refundMoves = search(refunded.db, 'account.move').filter((m) => m.ref === refundOrderRec.name && m.state === 'posted');
  assert.ok(saleMoves.length > 0);
  assert.ok(refundMoves.length > 0);
  const saleCashLines = saleMoves.flatMap((m) => m.line_ids).filter((l) => l.account_id === cashAccountId);
  const refundCashLines = refundMoves.flatMap((m) => m.line_ids).filter((l) => l.account_id === cashAccountId);
  assert.ok(saleCashLines.length > 0);
  assert.ok(refundCashLines.length > 0);
  const saleCashContribution = saleCashLines.reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0);
  const refundCashContribution = refundCashLines.reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0);
  const netCashDebit = saleCashContribution + refundCashContribution;
  assert.equal(Math.round(saleCashContribution * 100) / 100, 10);
  assert.equal(Math.round(refundCashContribution * 100) / 100, -10);
  assert.equal(Math.round(netCashDebit * 100) / 100, 0);

  // Duplicate refund rejected through payOrder
  assert.throws(
    () => payOrder(refunded.db, { lines, refund_of: sale.id }),
    /already refunded/i
  );

  // Refund of non-paid order rejected through payOrder
  const draftOrder = create(db, 'pos.order', { session_id: session.id, lines, state: 'draft' });
  assert.throws(
    () => payOrder(draftOrder.db, { lines, refund_of: draftOrder.id }),
    /Only paid orders can be refunded/i
  );

  // 2. Split sale: Cash 4, Card 6
  const splitSale = payOrder(refunded.db, {
    lines,
    payments: [
      { payment_method_id: cash.id, amount: 4 },
      { payment_method_id: card.id, amount: 6 },
    ],
  });
  const splitOrder = read(splitSale.db, 'pos.order', splitSale.id);
  assert.equal(splitOrder.amount_total, 10);
  assert.deepEqual(sessionTotals(splitSale.db, session), { orders: 3, cash: 4, card: 6, expected: 104 });

  // Mismatched refund tenders on split sale: single method cash rejected
  assert.throws(
    () => payOrder(splitSale.db, { lines, refund_of: splitSale.id, method: cash.id }),
    /Invalid payment|match.*original/i
  );

  // Mismatched refund tenders on split sale: swapped amounts (cash 6, card 4) rejected
  assert.throws(
    () => payOrder(splitSale.db, {
      lines,
      refund_of: splitSale.id,
      payments: [
        { payment_method_id: cash.id, amount: 6 },
        { payment_method_id: card.id, amount: 4 },
      ],
    }),
    /Invalid payment|match.*original/i
  );

  // Correct refund of split sale
  const splitRefunded = payOrder(splitSale.db, { lines, refund_of: splitSale.id });
  const splitRefundOrder = read(splitRefunded.db, 'pos.order', splitRefunded.id);
  assert.equal(splitRefundOrder.state, 'refund');
  assert.equal(read(splitRefunded.db, 'pos.order', splitSale.id).state, 'refunded');
  assert.deepEqual(sessionTotals(splitRefunded.db, session), { orders: 4, cash: 0, card: 0, expected: 100 });
});




test('refund rejects a different same-type method through direct and server posting', () => {
  let db = startSession(seed(), 0).db;
  const card = search(db, 'pos.payment.method').find((m) => m.type === 'bank');
  const other = create(db, 'pos.payment.method', { ...card, id: undefined, name: 'Other card' });
  db = other.db;
  const config = search(db, 'pos.config')[0];
  db = write(db, 'pos.config', config.id, { payment_method_ids: [...config.payment_method_ids, other.id] });
  const lines = [{ product_id: 5, qty: 1, price_unit: 10, tax: 0 }];
  const direct = payOrder(db, { lines, method: card.id });
  const sale = read(direct.db, 'pos.order', direct.id);
  for (const selection of [{ method: other.id }, { payments: [{ payment_method_id: other.id, amount: sale.amount_total }] }]) {
    assert.throws(() => payOrder(direct.db, { lines: sale.lines, refund_of: sale.id, ...selection }), /match.*original/i);
    assert.doesNotThrow(() => payOrder(direct.db, { lines: sale.lines, refund_of: sale.id, ...(selection.method ? { method: String(card.id) } : { payments: [{ payment_method_id: String(card.id), amount: sale.amount_total }] }) }));
  }
  const posted = runPosting(db, null, '/api/pos/pay', { lines: [{ product_id: 5, qty: 1 }], method: card.id });
  for (const path of ['/api/pos/refund', '/api/pos/pay']) {
    const base = path.endsWith('refund') ? { id: posted.body.id } : { refund_of: posted.body.id };
    for (const selection of [{ method: other.id }, { payments: [{ payment_method_id: other.id, amount: posted.body.total }] }]) {
      assert.throws(() => runPosting(posted.db, null, path, { ...base, ...selection }), /match.*original/i);
      assert.doesNotThrow(() => runPosting(posted.db, null, path, { ...base, ...(selection.method ? { method: card.id } : { payments: [{ payment_method_id: card.id, amount: posted.body.total }] }) }));
    }
  }
});

test('legacy refund tenders without IDs retain type matching', () => {
  const db = startSession(seed(), 0).db;
  const card = search(db, 'pos.payment.method').find((m) => m.type === 'bank');
  const lines = [{ product_id: 5, qty: 1, price_unit: 10, tax: 0 }];
  const sale = payOrder(db, { lines, method: card.id });
  const order = read(sale.db, 'pos.order', sale.id);
  for (const legacy of [
    { payment_ids: [{ method: 'bank', amount: order.amount_total }] },
    { payment_ids: [], payment_method_id: null, payment_method: 'card' },
  ]) {
    const snapshot = write(sale.db, 'pos.order', sale.id, legacy);
    for (const selection of [{ method: card.id }, { payments: [{ payment_method_id: card.id, amount: order.amount_total }] }]) {
      assert.doesNotThrow(() => payOrder(snapshot, { lines: order.lines, refund_of: order.id, ...selection }));
    }
  }
});

test('public checkout regression: session without config, supplied config whose default preset has a different pricelist and fiscal position', () => {
  let db = seed();
  const income = accountId(db, '400000');
  const mapped = accountId(db, '450000');
  const fp = create(db, 'account.fiscal.position', { name: 'Preset FP', account_ids: [{ account_src_id: income, account_dest_id: mapped }] });
  const list = create(fp.db, 'product.pricelist', { name: 'Preset pricelist', items: [{ product_id: 5, min_qty: 1, fixed_price: 6 }] });
  const preset = create(list.db, 'pos.preset', { name: 'Special preset', pricelist_id: list.id, fiscal_position_id: fp.id });
  const cash = search(preset.db, 'pos.payment.method').find((m) => m.type === 'cash');
  const cfg = create(preset.db, 'pos.config', { name: 'Custom POS', available_preset_ids: [preset.id], default_preset_id: preset.id, payment_method_ids: [cash.id] });

  // Open session WITHOUT config
  db = startSession(cfg.db, 0).db;
  db = write(db, 'pos.session', openSession(db).id, { config_id: null });
  assert.equal(openSession(db).config_id, null);

  // payCart supplying config_id without preset_id (must resolve default preset of supplied config)
  const out = payCart(db, { cart: [{ product_id: 5, qty: 1 }], method: 'cash', config_id: cfg.id });
  const order = read(out.db, 'pos.order', out.id);
  assert.equal(order.config_id, cfg.id);
  assert.equal(order.preset_id, preset.id);
  assert.equal(order.fiscal_position_id, fp.id);
  assert.equal(order.lines[0].price_unit, 6, 'lines should be priced with preset pricelist');
  const sale = search(out.db, 'account.move').find((m) => m.ref === order.name && m.journal_id === journalId(db, 'POSS'));
  assert.ok(sale.line_ids.some((l) => l.account_id === mapped && l.credit === 6), 'income account should be mapped by preset fiscal position');

  // Also via /api/pos/pay server endpoint
  const srv = runPosting(db, null, '/api/pos/pay', { lines: [{ product_id: 5, qty: 1 }], method: 'cash', config_id: cfg.id });
  const srvOrder = read(srv.db, 'pos.order', srv.body.id);
  assert.equal(srvOrder.config_id, cfg.id);
  assert.equal(srvOrder.preset_id, preset.id);
  assert.equal(srvOrder.fiscal_position_id, fp.id);
  assert.equal(srvOrder.lines[0].price_unit, 6, 'server lines should be priced with preset pricelist');
  const srvSale = search(srv.db, 'account.move').find((m) => m.ref === srvOrder.name && m.journal_id === journalId(db, 'POSS'));
  assert.ok(srvSale.line_ids.some((l) => l.account_id === mapped && l.credit === 6));
});

test('public settlement regression with two distinct configurations', () => {
  let db = seed();
  const cfg1 = search(db, 'pos.config')[0];
  assert.ok(cfg1);

  // Config 2: Restaurant with a distinct custom cash method, preset and rounding
  const income = accountId(db, '400000');
  const mapped = accountId(db, '450000');
  const fp = create(db, 'account.fiscal.position', { name: 'Restaurant FP', account_ids: [{ account_src_id: income, account_dest_id: mapped }] });
  const preset2 = create(fp.db, 'pos.preset', { name: 'Dine-in Preset', fiscal_position_id: fp.id });
  const rounding = create(preset2.db, 'account.cash.rounding', { name: 'Half-up 0.05', rounding: 0.05, rounding_method: 'HALF-UP', profit_account_id: mapped, loss_account_id: mapped });

  // Custom cash method exclusive to Config 2
  const customCash = create(rounding.db, 'pos.payment.method', {
    name: 'Restaurant Cash',
    type: 'cash',
    company_id: 1,
    journal_id: journalId(db, 'CSH1'),
  });

  const cfg2 = create(customCash.db, 'pos.config', {
    name: 'Restaurant POS',
    module_restaurant: true,
    available_preset_ids: [preset2.id],
    default_preset_id: preset2.id,
    payment_method_ids: [customCash.id],
    cash_rounding: true,
    rounding_method_id: rounding.id,
  });

  // Associate customCash only with cfg2
  db = write(cfg2.db, 'pos.payment.method', customCash.id, { config_ids: [cfg2.id] });

  // 1. Open session WITHOUT config (config-less session)
  db = startSession(db, 100).db;
  db = write(db, 'pos.session', openSession(db).id, { config_id: null });
  assert.equal(openSession(db).config_id, null);

  // 2. Draft order belonging to cfg2
  const lines = [{ product_id: 5, qty: 1, price_unit: 10.02, tax: 0 }];
  const draft = create(db, 'pos.order', {
    config_id: cfg2.id,
    state: 'draft',
    lines,
    table_id: '1:Table1',
  });

  // Pay with cfg2's exclusive payment method (which is NOT in cfg1)
  // Total is 10.02, with half-up 0.05 rounding expectedTotal is 10.00
  const paid = payWithMethods(draft.db, draft.id, [{ method: 'cash', payment_method_id: customCash.id, amount: 10.00 }]);
  const settlement = search(paid.db, 'pos.order').find((o) => o.settlement_of === draft.id);
  assert.ok(settlement, 'settlement order should be created');
  assert.equal(settlement.config_id, cfg2.id, 'settlement must retain cfg2 config_id');
  assert.equal(settlement.preset_id, preset2.id, 'settlement must use cfg2 default preset');
  assert.equal(settlement.fiscal_position_id, fp.id, 'settlement must use cfg2 default preset fiscal position');
  assert.equal(settlement.payment_ids[0].payment_method_id, customCash.id, 'settlement must record cfg2 payment method');
  assert.equal(settlement.rounding_difference, -0.02, 'settlement must use cfg2 cash rounding');

  // Verify posted accounting move belongs to cfg2's fiscal position and rounding
  const saleMove = search(paid.db, 'account.move').find((m) => m.ref === settlement.name && m.journal_id === journalId(db, 'POSS'));
  assert.ok(saleMove, 'posted sale move should exist');
  assert.ok(saleMove.line_ids.some((l) => l.account_id === mapped), 'income should map to destination account per preset FP');

  // Verify refundBill also preserves cfg2
  const refunded = refundBill(paid.db, read(paid.db, 'pos.order', draft.id));
  const refundOrderRec = search(refunded, 'pos.order').find((o) => o.refund_of === settlement.id);
  assert.ok(refundOrderRec, 'refund order should exist');
  assert.equal(refundOrderRec.config_id, cfg2.id, 'refund must also retain cfg2 config_id');

  // 3. Enforce session consistency: when session has config cfg1, paying a bill with cfg2 must throw
  let sessionDb = startSession(seed(), 100, cfg1.id).db;
  assert.equal(openSession(sessionDb).config_id, cfg1.id);
  const mismatchDraft = create(sessionDb, 'pos.order', {
    config_id: cfg2.id,
    state: 'draft',
    lines,
    table_id: '1:Table1',
  });
  assert.throws(
    () => payWithMethods(mismatchDraft.db, mismatchDraft.id, [{ method: 'cash', amount: 10 }]),
    /POS configuration does not match the session/i
  );

  // 4. Also via server operation pos.bill.pay
  const opDraft = create(refunded, 'pos.order', {
    config_id: cfg2.id,
    state: 'draft',
    lines,
    table_id: '1:Table1',
    payment_ids: [{ method: 'cash', payment_method_id: customCash.id, amount: 10.00 }],
  });
  const opOut = runOperation(opDraft.db, 'pos.bill.pay', { id: opDraft.id }, { allowed: null, direct: null });
  const opSettlement = search(opOut.db, 'pos.order').find((o) => o.settlement_of === opDraft.id);
  assert.ok(opSettlement);
  assert.equal(opSettlement.config_id, cfg2.id);
  assert.equal(opSettlement.preset_id, preset2.id);
  assert.equal(opSettlement.payment_ids[0].payment_method_id, customCash.id);
});

test('refunds, return cancellations, and restaurant settlements validate company consistency first before any write', () => {
  let db = seed();
  const c2 = create(db, 'res.company', { name: 'Branch Company' });
  db = c2.db;
  for (const [code, type] of [['121000', 'asset_receivable'], ['400000', 'income'], ['101501', 'asset_cash'], ['110100', 'asset_current'], ['500000', 'expense_direct'], ['450000', 'income_other'], ['690000', 'expense_other']]) {
    db = create(db, 'account.account', { code, name: `Branch ${code}`, account_type: type, company_id: c2.id }).db;
  }
  const account = (code) => search(db, 'account.account').find((a) => a.code === code && a.company_id === c2.id);
  const c2Journal = create(db, 'account.journal', { name: 'Branch Cash Journal', code: 'BCSH', type: 'cash', company_id: c2.id, default_account_id: account('101501').id });
  db = c2Journal.db;
  const cfg2 = create(db, 'pos.config', { name: 'Branch POS', company_id: c2.id, module_restaurant: true });
  db = cfg2.db;
  const c2Cash = create(db, 'pos.payment.method', { name: 'Branch Cash', type: 'cash', company_id: c2.id, config_ids: [cfg2.id], journal_id: c2Journal.id });
  db = c2Cash.db;
  db = write(db, 'pos.config', cfg2.id, { payment_method_ids: [c2Cash.id] });

  const cfg1 = search(db, 'pos.config').find((c) => (c.company_id ?? 1) === 1);
  const cash1 = search(db, 'pos.payment.method').find((m) => (m.company_id ?? 1) === 1 && m.type === 'cash');

  // 1. Nonzero sale in Company 1
  let sessionDb = startSession(db, 100, cfg1.id).db;
  const session1 = openSession(sessionDb);
  const sale = payOrder(sessionDb, { lines: [{ product_id: 5, qty: 2, price_unit: 10, tax: 0 }], method: cash1.id });
  const saleOrder = read(sale.db, 'pos.order', sale.id);

  // Return order in Company 1
  const returnPreset = create(sale.db, 'pos.preset', { name: 'Return', is_return: true, identification: 'none' });
  let returnDb = write(returnPreset.db, 'pos.config', cfg1.id, { available_preset_ids: [returnPreset.id], default_preset_id: returnPreset.id });
  const returnRes = payOrder(returnDb, { lines: [{ product_id: 5, qty: -1, price_unit: 10, tax: 0 }], method: cash1.id });
  const returnOrder = read(returnRes.db, 'pos.order', returnRes.id);

  // Draft restaurant order in Company 1
  const restDraft = create(returnRes.db, 'pos.order', {
    config_id: cfg1.id,
    company_id: 1,
    table_id: '1:Table1',
    state: 'draft',
    lines: [{ product_id: 5, qty: 1, price_unit: 10, tax: 0 }],
  });

  // Close Session 1
  let closedDb = closeSession(restDraft.db, session1, 100);

  // Open Session in Company 2
  let c2SessionDb = startSession(closedDb, 50, cfg2.id).db;
  const session2 = openSession(c2SessionDb);
  assert.equal(session2.company_id, c2.id);

  const snapshotBefore = JSON.parse(JSON.stringify(c2SessionDb));

  // Nonzero sale refund attempted in Company 2 session must throw and leave db untouched
  assert.throws(() => refundOrder(c2SessionDb, saleOrder), /company/i);
  assert.deepEqual(c2SessionDb, snapshotBefore);

  // Return cancellation attempted in Company 2 session must throw and leave db untouched
  assert.throws(() => refundOrder(c2SessionDb, returnOrder), /company/i);
  assert.deepEqual(c2SessionDb, snapshotBefore);

  // Restaurant settlement attempted in Company 2 session must throw and leave db untouched
  assert.throws(() => payWithMethods(c2SessionDb, restDraft.id, [{ method: 'cash', amount: 10 }]), /company/i);
  assert.deepEqual(c2SessionDb, snapshotBefore);

  // Restaurant bill refund attempted in Company 2 session must throw and leave db untouched
  assert.throws(() => refundBill(c2SessionDb, saleOrder), /company/i);
  assert.deepEqual(c2SessionDb, snapshotBefore);
});

test('pos.pay and checkout reject foreign-company products and accept shared products across the shared checkout boundary', () => {
  let db = seed();
  const c2Res = create(db, 'res.company', { name: 'Company 2', currency_id: 1 });
  const c2 = read(c2Res.db, 'res.company', c2Res.id);
  db = setCompanies(c2Res.db, { current: 1, allowed: [1, c2.id] });

  const cfg1 = search(db, 'pos.config').find((c) => (c.company_id ?? 1) === 1);
  const sessionDb = startSession(db, 100, cfg1.id).db;

  // Foreign company product (Company 2)
  const foreignProdRes = create(sessionDb, 'product', {
    name: 'C2 Foreign Product',
    company_id: c2.id,
    list_price: 25,
    sale_ok: true,
    available_in_pos: true,
    active: true,
    type: 'consu',
  });
  const foreignProd = read(foreignProdRes.db, 'product', foreignProdRes.id);
  db = foreignProdRes.db;

  // Shared product (company_id: null)
  const sharedProdRes = create(db, 'product', {
    name: 'Shared Product',
    company_id: null,
    list_price: 30,
    sale_ok: true,
    available_in_pos: true,
    active: true,
    type: 'consu',
  });
  const sharedProd = read(sharedProdRes.db, 'product', sharedProdRes.id);
  db = sharedProdRes.db;

  // 1. pos.pay public operation with foreign product MUST be rejected
  assert.throws(
    () => runOperation(db, 'pos.pay', { cart: [{ product_id: foreignProd.id, qty: 1 }], method: 'cash' }),
    /Product is not available in POS/
  );

  // 2. /api/pos/pay with foreign product MUST be rejected
  assert.throws(
    () => runPosting(db, null, '/api/pos/pay', { lines: [{ product_id: foreignProd.id, qty: 1 }], method: 'cash' }),
    /Product is not available in POS/
  );

  // 3. direct payOrder with foreign product MUST be rejected
  assert.throws(
    () => payOrder(db, { lines: [{ product_id: foreignProd.id, qty: 1, price_unit: 25, tax: 0 }], method: 'cash' }),
    /Product is not available in POS/
  );

  // 4. pos.pay public operation with shared product MUST be accepted
  const opShared = runOperation(db, 'pos.pay', { cart: [{ product_id: sharedProd.id, qty: 1 }], method: 'cash' });
  assert.ok(opShared.reply.id);

  // 5. /api/pos/pay with shared product MUST be accepted
  const postingShared = runPosting(db, null, '/api/pos/pay', { lines: [{ product_id: sharedProd.id, qty: 1 }], method: 'cash' });
  assert.ok(postingShared.body.id);
});

test('server checkout returns authoritative payable total with rounding difference for cash-rounded orders', () => {
  let db = seed();
  const cfg1 = search(db, 'pos.config').find((c) => (c.company_id ?? 1) === 1);
  const rounding = create(db, 'account.cash.rounding', {
    name: 'Half Up 0.05',
    rounding: 0.05,
    rounding_method: 'HALF-UP',
    strategy: 'add_invoice_line',
  });
  db = write(rounding.db, 'pos.config', cfg1.id, {
    cash_rounding: true,
    rounding_method_id: rounding.id,
    only_round_cash_method: false,
  });

  // Product priced at 10.02
  const prod = create(db, 'product', {
    name: 'Priced 10.02',
    list_price: 10.02,
    sale_ok: true,
    available_in_pos: true,
    active: true,
    type: 'consu',
    sale_tax: 0,
  });
  db = startSession(prod.db, 100, cfg1.id).db;

  // Unrounded lines total is 10.02, cash-rounded payable total is 10.00
  // 1. /api/pos/pay response total must be authoritative payable total (10.00)
  const postingOut = runPosting(db, null, '/api/pos/pay', {
    lines: [{ product_id: prod.id, qty: 1 }],
    method: 'cash',
  });
  assert.equal(postingOut.body.total, 10.00, 'server posting body.total must include rounding_difference');

  // 2. pos.pay operation response total must be authoritative payable total (10.00)
  const opOut = runOperation(db, 'pos.pay', {
    cart: [{ product_id: prod.id, qty: 1 }],
    method: 'cash',
  });
  assert.equal(opOut.reply.total, 10.00, 'pos.pay reply.total must include rounding_difference');

  // 3. payCart returned total must be authoritative payable total (10.00)
  const cartOut = payCart(db, {
    cart: [{ product_id: prod.id, qty: 1 }],
    method: 'cash',
  });
  assert.equal(cartOut.total, 10.00, 'payCart total must include rounding_difference');

  // 4. payOrder returned total must be authoritative payable total (10.00)
  const orderOut = payOrder(db, {
    lines: [{ product_id: prod.id, qty: 1, price_unit: 10.02, tax: 0 }],
    method: 'cash',
  });
  assert.equal(orderOut.total, 10.00, 'payOrder total must include rounding_difference');
});


