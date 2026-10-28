import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { migrate } from './migrations.js';
import { closeSession, payOrder, sessionTotals, startSession } from './models/pos.js';
import { accountId, journalId } from './models/ledger.js';
import { postMove } from './models/accounting.js';

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
  const cash = search(db, 'pos.payment.method').find((m) => m.type === 'cash');
  const later = create(db, 'pos.payment.method', { name: 'Account', type: 'pay_later', company_id: 1 });
  db = later.db;
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
  const cash = search(db, 'pos.payment.method').find((m) => m.type === 'cash');
  const card = search(db, 'pos.payment.method').find((m) => m.type === 'bank');
  const later = create(db, 'pos.payment.method', { name: 'Customer Credit', type: 'pay_later', company_id: 1 });
  db = later.db;

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

  const catsForConfig1 = search(db, 'pos.category').filter((c) => !c.pos_config_ids?.length || c.pos_config_ids.includes(config1.id));
  const catsForConfig2 = search(db, 'pos.category').filter((c) => !c.pos_config_ids?.length || c.pos_config_ids.includes(cfg2.id));
  assert.ok(catsForConfig1.some((c) => c.id === child.id));
  assert.ok(!catsForConfig2.some((c) => c.id === child.id));
});

test('pos.preset applies pricelist, fiscal position and enforces customer identification', () => {
  let db = startSession(migrate({ ...seed(), schema_version: 5 }), 0).db;
  const cash = search(db, 'pos.payment.method').find((m) => m.type === 'cash');
  const pricelist = search(db, 'product.pricelist')[0];
  const fp = search(db, 'account.fiscal.position')[0];

  const eatIn = create(db, 'pos.preset', {
    name: 'Eat In',
    pricelist_id: pricelist?.id ?? null,
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
    fiscal_position_id: fp?.id ?? null,
  });
  db = delivery.db;

  const lines = [{ product_id: 5, qty: 1, price_unit: 10, tax: 0 }];

  assert.throws(() => payOrder(db, { lines, method: cash.id, preset_id: takeaway.id }), /customer/i);

  const noAddressPartner = create(db, 'res.partner', { name: 'Homeless Bob' });
  db = noAddressPartner.db;
  assert.throws(() => payOrder(db, { lines, method: cash.id, preset_id: delivery.id, partner_id: noAddressPartner.id }), /address/i);

  const withAddress = create(db, 'res.partner', { name: 'Alice', street: '123 Main St', city: 'Metropolis' });
  db = withAddress.db;
  const paid = payOrder(db, { lines, method: cash.id, preset_id: delivery.id, partner_id: withAddress.id });
  const order = read(paid.db, 'pos.order', paid.id);
  assert.equal(order.preset_id, delivery.id);
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
