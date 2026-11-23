import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { create, read, search, write } from './orm.js';
import { payMove, postMove } from './models/accounting.js';
import { postBatch } from './models/payments.js';
import * as paymentsMod from './models/payments.js';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const today = () => new Date().toISOString().slice(0, 10);
const props = (node) => Object.entries(node ?? {}).find(([k]) => k.startsWith('__reactProps$'))?.[1];

const findAll = (node, pred, acc = []) => {
  if (!node) return acc;
  if (pred(node)) acc.push(node);
  for (const child of node.childNodes ?? []) findAll(child, pred, acc);
  return acc;
};

test('CHK-1: manual check number becomes read only once printed', () => {
  let db = seed();
  const journal = search(db, 'account.journal').find((j) => j.type === 'bank');
  db = write(db, 'account.journal', journal.id, { check_manual_sequencing: true });
  const field = models['account.payment'].fields.check_number;
  assert.equal(field.readonly({ journal_id: journal.id, check_printed: false }, db), false);
  assert.equal(field.readonly({ journal_id: journal.id, check_printed: true }, db), true);
});

test('CHK-1: journal fields check_manual_sequencing and check_next_number exist with proper defaults', () => {
  const fields = models['account.journal'].fields;
  assert.equal(fields.check_manual_sequencing.type, 'boolean');
  assert.equal(fields.check_manual_sequencing.label, 'Manual Numbering');
  assert.equal(fields.check_next_number.type, 'integer');

  const def = models['account.journal'].defaults();
  assert.equal(def.check_manual_sequencing, false);
});

test('CHK-1: unlockedFields on posted payment allows check_number when manual sequencing and not printed', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, { check_manual_sequencing: true });
  const checkLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id)?.code === 'check_printing'
  );
  const unlocked = models['account.payment'].form.unlockedFields;

  const payment = {
    state: 'posted',
    payment_type: 'outbound',
    journal_id: bank.id,
    payment_method_line_id: checkLine?.id,
    check_printed: false,
    date: today(),
  };

  assert.ok(unlocked(payment, db).includes('check_number'), 'check_number should be editable before print');

  const printedPayment = { ...payment, check_printed: true };
  assert.ok(!unlocked(printedPayment, db).includes('check_number'), 'check_number should be locked after print');
});

test('CHK-2: payment by check gets number at print time, not at confirmation', () => {
  let db = seed();
  const partner = search(db, 'res.partner')[0];
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, { check_next_number: 100, check_manual_sequencing: false });
  const checkLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id)?.code === 'check_printing'
  );

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Supplies', price_unit: 200, qty: 1 }],
  });
  db = postMove(bill.db, bill.id);

  const draftPay = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 200,
    journal_id: bank.id,
    payment_method_line_id: checkLine.id,
  });

  db = payMove(draftPay.db, bill.id, 200, today(), {
    paymentId: draftPay.id,
    journalId: bank.id,
  });

  const payment = read(db, 'account.payment', draftPay.id);
  assert.equal(payment.state, 'posted');
  assert.ok(payment.check_number == null, 'Check number must not be assigned at payment confirmation');
  assert.equal(payment.check_printed, false, 'check_printed must be false before print');

  // Print Check button wizard
  const printAction = models['account.payment'].form.buttons.find((b) => b.label === 'Print Check');
  assert.equal(typeof printAction.wizard, 'function');
  const wizSpec = printAction.wizard(db, payment);
  assert.equal(wizSpec.fields[0].name, 'next_check_number');
  assert.equal(wizSpec.fields[0].default, 100);

  // Run the print action with the prefilled next number
  const runRes = printAction.run(db, payment, { next_check_number: 100 });
  db = runRes.db;
  assert.equal(runRes.go, `#/print/account.payment/${payment.id}`);

  const printedPay = read(db, 'account.payment', payment.id);
  assert.equal(printedPay.check_number, 100, 'Check number assigned at print time');
  assert.equal(printedPay.check_printed, true, 'Payment marked as printed');

  const updatedJournal = read(db, 'account.journal', bank.id);
  assert.equal(updatedJournal.check_next_number, 101, 'Journal sequence advanced');

  // Standalone voidCheck is not exported on paymentsMod
  assert.equal('voidCheck' in paymentsMod, false, 'No standalone voidCheck on paymentsMod');
});

test('CHK-2: batch payment print checks uses wizard and numbers at print time', () => {
  let db = seed();
  const partner = search(db, 'res.partner')[0];
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, { check_next_number: 300, check_manual_sequencing: false });
  const checkLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id)?.code === 'check_printing'
  );

  // Create two bills
  const bill1 = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: partner.id, invoice_date: today(),
    invoice_line_ids: [{ name: 'Item 1', price_unit: 100, qty: 1 }],
  });
  const bill2 = create(bill1.db, 'account.move', {
    move_type: 'in_invoice', partner_id: partner.id, invoice_date: today(),
    invoice_line_ids: [{ name: 'Item 2', price_unit: 150, qty: 1 }],
  });
  db = postMove(postMove(bill2.db, bill1.id), bill2.id);

  // Create batch payment
  const batchRes = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: bank.id,
    payment_method_id: checkLine.payment_method_id,
    date: today(),
    lines: [
      { move_id: bill1.id, amount: 100 },
      { move_id: bill2.id, amount: 150 },
    ],
  });
  db = postBatch(batchRes.db, read(batchRes.db, 'account.batch.payment', batchRes.id));

  const postedBatch = read(db, 'account.batch.payment', batchRes.id);
  assert.equal(postedBatch.state, 'posted');
  assert.ok(postedBatch.lines[0].check_number == null, 'Batch line 1 unnumbered at confirmation');
  assert.ok(postedBatch.lines[1].check_number == null, 'Batch line 2 unnumbered at confirmation');

  const pay1 = read(db, 'account.payment', postedBatch.lines[0].payment_id);
  const pay2 = read(db, 'account.payment', postedBatch.lines[1].payment_id);
  assert.ok(pay1.check_number == null, 'Payment 1 unnumbered at confirmation');
  assert.ok(pay2.check_number == null, 'Payment 2 unnumbered at confirmation');

  // Print Checks wizard on batch
  const batchPrintAction = models['account.batch.payment'].form.buttons.find((b) => b.label === 'Print Checks');
  assert.equal(typeof batchPrintAction.wizard, 'function');
  const batchWiz = batchPrintAction.wizard(db, postedBatch);
  assert.equal(batchWiz.fields[0].default, 300);

  // Run the batch print action
  const batchRunRes = batchPrintAction.run(db, postedBatch, { next_check_number: 300 });
  db = batchRunRes.db;
  assert.equal(batchRunRes.go, `#/print/account.batch.payment/${postedBatch.id}`);

  const printedBatch = read(db, 'account.batch.payment', postedBatch.id);
  assert.equal(printedBatch.lines[0].check_number, 300);
  assert.equal(printedBatch.lines[1].check_number, 301);

  const updatedPay1 = read(db, 'account.payment', pay1.id);
  const updatedPay2 = read(db, 'account.payment', pay2.id);
  assert.equal(updatedPay1.check_number, 300);
  assert.equal(updatedPay1.check_printed, true);
  assert.equal(updatedPay2.check_number, 301);
  assert.equal(updatedPay2.check_printed, true);

  const updatedBank = read(db, 'account.journal', bank.id);
  assert.equal(updatedBank.check_next_number, 302, 'Journal sequence advanced by 2');
});

test('CHK-3: company exposes check layout selection and validates write', async () => {
  const { validateCompanySettingWrite } = await import('./views/Settings.jsx');
  const field = models['res.company'].fields.account_check_printing_layout;
  assert.deepEqual(field.options.map(([value]) => value), ['none', 'top', 'middle', 'bottom']);

  const db = seed();
  const company = search(db, 'res.company')[0];

  assert.equal(validateCompanySettingWrite(db, company, { account_check_printing_layout: 'invalid' }), 'Select a valid check layout');
  assert.equal(validateCompanySettingWrite(db, company, { account_check_printing_layout: 'none' }), null);
  assert.equal(validateCompanySettingWrite(db, company, { account_check_printing_layout: 'top' }), null);
  assert.equal(validateCompanySettingWrite(db, company, { account_check_printing_layout: 'middle' }), null);
  assert.equal(validateCompanySettingWrite(db, company, { account_check_printing_layout: 'bottom' }), null);
});

test('CHK-3: PrintDoc check card respects company account_check_printing_layout', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js');
  const { PrintDoc } = await import('./views/PrintDoc.jsx');
  const { printCheck } = await import('./models/pay.js');

  await initStore();
  let db = getDb();
  const company = search(db, 'res.company')[0];
  const partner = search(db, 'res.partner')[0];
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const checkLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id)?.code === 'check_printing'
  );

  db = write(db, 'res.company', company.id, { account_check_printing_layout: 'middle' });
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Test Item', price_unit: 100, qty: 1 }],
  });
  db = postMove(bill.db, bill.id);

  const draftPay = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 100,
    journal_id: bank.id,
    payment_method_line_id: checkLine.id,
  });
  db = payMove(draftPay.db, bill.id, 100, today(), { paymentId: draftPay.id, journalId: bank.id });
  db = printCheck(db, draftPay.id);

  await React.act(async () => commit(db));
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.payment', id: draftPay.id })));
    const articleMiddle = find(host, (n) => n.tagName === 'ARTICLE' && props(n)?.className?.includes('check-layout-middle'));
    assert.ok(articleMiddle, 'Article has check-layout-middle class from company setting');

    // Test layout none: renders check-layout-none without remittance-stub
    db = write(db, 'res.company', company.id, { account_check_printing_layout: 'none' });
    await React.act(async () => commit(db));
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.payment', id: draftPay.id })));
    const articleNone = find(host, (n) => n.tagName === 'ARTICLE' && props(n)?.className?.includes('check-layout-none'));
    assert.ok(articleNone, 'Article has check-layout-none class');
    const stubs = findAll(articleNone, (n) => props(n)?.className?.includes('remittance-stub'));
    assert.equal(stubs.length, 0, 'No remittance stub rendered when layout is none');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('i18n: Arabic coverage for check printing strings', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {}, removeItem() {}, clear() {} };
  try {
    const { t } = await import('./i18n.js?lang=ar-chk1');
    assert.equal(t('Check on top'), 'شيك في الأعلى');
    assert.equal(t('Check in middle'), 'شيك في المنتصف');
    assert.equal(t('Check on bottom'), 'شيك في الأسفل');
    assert.equal(t('Check Printed'), 'تمت طباعة الشيك');
    assert.equal(t('Select a valid check layout'), 'اختر تخطيط شيك صالح');
    assert.equal(t('Select the layout used when printing checks.'), 'حدد التخطيط المستخدم عند طباعة الشيكات.');
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
