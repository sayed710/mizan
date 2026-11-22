import { test } from 'node:test';
import assert from 'node:assert/strict';
import { purchaseInvoiceView, salesInvoiceView } from './models/accounting.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { create, read } from './orm.js';

test('BILL-9: purchaseInvoiceView.list includes should_be_paid column', () => {
  assert.ok(
    purchaseInvoiceView.list.includes('should_be_paid'),
    'purchaseInvoiceView.list must include should_be_paid column'
  );

  // Sales/customer invoice list must NOT include should_be_paid (it is 3-way matching for vendor bills)
  assert.ok(
    !salesInvoiceView.list.includes('should_be_paid'),
    'salesInvoiceView.list must not include should_be_paid'
  );
});

test('BILL-9: should_be_paid field configuration and options on account.move', () => {
  const moveFields = models['account.move'].fields;
  assert.ok(moveFields.should_be_paid, 'account.move must declare should_be_paid field');
  assert.equal(moveFields.should_be_paid.type, 'selection');
  assert.equal(moveFields.should_be_paid.label, 'Should Be Paid');

  const options = moveFields.should_be_paid.options;
  assert.ok(Array.isArray(options), 'should_be_paid options must be an array');
  const optKeys = options.map(([k]) => k);
  assert.ok(optKeys.includes('yes'), 'options must include yes');
  assert.ok(optKeys.includes('no'), 'options must include no');
  assert.ok(optKeys.includes('exception'), 'options must include exception');

  // Verify compute function evaluates on records
  let db = seed();
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-04-01',
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax: 0 }],
  });
  const rec = read(bill.db, 'account.move', bill.id);
  const computed = moveFields.should_be_paid.compute(rec, bill.db);
  assert.ok(['yes', 'no', 'exception'].includes(computed), `computed should_be_paid was ${computed}`);
});

test('BILL-9: Arabic translations exist for Should Be Paid and its options/values', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null) };
  let tAr;
  try {
    ({ t: tAr } = await import(`./i18n.js?ar=${Date.now()}`));
  } finally {
    globalThis.localStorage = prevStorage;
  }

  // Label translation
  assert.equal(tAr('Should Be Paid'), 'توصية الدفع', 'Should Be Paid must translate to Arabic توصية الدفع');

  // Option label translations
  assert.equal(tAr('Yes'), 'نعم', 'Yes must translate to Arabic نعم');
  assert.equal(tAr('No'), 'لا', 'No must translate to Arabic لا');
  assert.equal(tAr('Exception'), 'استثناء', 'Exception must translate to Arabic استثناء');

  // Option value translations
  assert.equal(tAr('yes'), 'نعم', 'yes value must translate to Arabic نعم');
  assert.equal(tAr('no'), 'لا', 'no value must translate to Arabic لا');
  assert.equal(tAr('exception'), 'استثناء', 'exception value must translate to Arabic استثناء');
});
