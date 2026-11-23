import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const { setupDom } = await import('./test-support/dom.js');
setupDom();

const { seed } = await import('./seed.js');
const { create, read, search } = await import('./orm.js');
const { diffDb, applyDiff } = await import('./sync.js');
const { models } = await import('./models/index.js');
const { isSelfBillingMove, postMove } = await import('./models/accounting.js');
const { PrintDoc } = await import('./views/PrintDoc.jsx');
const { ownArabic } = await import('./i18n.js');
const { initStore, commit } = await import('./store.js');
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');

test('purchase-journal-only guard through diffDb + applyDiff', () => {
  const db = seed();
  const purchaseJournal = search(db, 'account.journal').find((j) => j.type === 'purchase');
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const generalJournal = search(db, 'account.journal').find((j) => j.type === 'general');

  assert.ok(purchaseJournal, 'seed contains a purchase journal');
  assert.ok(saleJournal, 'seed contains a sale journal');

  // Verify default value is false
  const defaultVals = models['account.journal'].defaults();
  assert.equal(defaultVals.is_self_billing, false, 'is_self_billing defaults to false');

  // Guard diff-verifiable: setting is_self_billing on a non-purchase journal must fail via diffDb + applyDiff
  for (const nonPurchase of [saleJournal, bankJournal, generalJournal].filter(Boolean)) {
    const forged = {
      ...db,
      records: {
        ...db.records,
        'account.journal': db.records['account.journal'].map((j) => (j.id === nonPurchase.id ? { ...j, is_self_billing: true } : j)),
      },
    };
    assert.throws(
      () => applyDiff(db, diffDb(db, forged), { isAdmin: true }),
      /Self Billing is only valid for purchase journals/,
      `expected non-purchase journal ${nonPurchase.type} to reject is_self_billing via diffDb + applyDiff`,
    );
  }

  // Guard diff-verifiable: setting is_self_billing on a purchase journal succeeds via diffDb + applyDiff
  const validPurchase = {
    ...db,
    records: {
      ...db.records,
      'account.journal': db.records['account.journal'].map((j) => (j.id === purchaseJournal.id ? { ...j, is_self_billing: true } : j)),
    },
  };
  const synced = applyDiff(db, diffDb(db, validPurchase), { isAdmin: true });
  assert.equal(read(synced, 'account.journal', purchaseJournal.id).is_self_billing, true);

  // Advanced settings tab check
  const purchaseTabs = models['account.journal'].form.tabs({ type: 'purchase' });
  const purchaseAdvanced = purchaseTabs.find((t) => t.label === 'Advanced Settings');
  assert.ok(purchaseAdvanced, 'purchase journal has Advanced Settings tab');
  const selfBillingGroup = purchaseAdvanced.groups.find((g) => g.title === 'Self Billing');
  assert.ok(selfBillingGroup, 'purchase journal has Self Billing group in Advanced Settings');
  assert.deepEqual(selfBillingGroup.fields, ['is_self_billing']);

  const saleTabs = models['account.journal'].form.tabs({ type: 'sale' });
  const saleAdvanced = saleTabs.find((t) => t.label === 'Advanced Settings');
  assert.equal(saleAdvanced?.groups.find((g) => g.title === 'Self Billing'), undefined);
});

test('titles: form subtitle and PrintDoc show Self Billing and Self Billing Credit Note regardless of state', async () => {
  let db = seed();
  const expAccount = search(db, 'account.account').find((a) => a.account_type === 'expense')
    ?? search(db, 'account.account').find((a) => a.code === '600000');

  const sbJournal = create(db, 'account.journal', {
    name: 'Self-Billing Bills',
    code: 'SBILL',
    type: 'purchase',
    company_id: 1,
    default_account_id: expAccount.id,
    is_self_billing: true,
  });
  db = sbJournal.db;

  const partner = search(db, 'res.partner')[0];

  // 1. in_invoice in self-billing journal
  const billDraft = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: partner.id,
    journal_id: sbJournal.id,
    invoice_date: '2026-03-15',
    invoice_line_ids: [{ name: 'Supplies', qty: 10, price_unit: 50, tax: 0, account_id: expAccount.id }],
  });
  db = billDraft.db;
  const draftRecord = read(db, 'account.move', billDraft.id);

  // Helper check
  assert.equal(isSelfBillingMove(db, draftRecord), true, 'isSelfBillingMove returns true for move in self-billing journal');

  // Form subtitle for in_invoice is "Self Billing" regardless of state
  assert.equal(models['account.move'].form.subtitle(draftRecord, db), 'Self Billing');

  // Post the bill
  db = postMove(db, billDraft.id);
  const billPosted = read(db, 'account.move', billDraft.id);
  assert.equal(models['account.move'].form.subtitle(billPosted, db), 'Self Billing');

  // Cancelled bill
  const billCancelled = { ...billPosted, state: 'cancel' };
  assert.equal(models['account.move'].form.subtitle(billCancelled, db), 'Self Billing');

  // 2. in_refund in self-billing journal
  const refundDraft = create(db, 'account.move', {
    move_type: 'in_refund',
    company_id: 1,
    partner_id: partner.id,
    journal_id: sbJournal.id,
    invoice_date: '2026-03-16',
    invoice_line_ids: [{ name: 'Returned Supplies', qty: 2, price_unit: 50, tax: 0, account_id: expAccount.id }],
  });
  db = refundDraft.db;
  const draftRefundRecord = read(db, 'account.move', refundDraft.id);

  assert.equal(isSelfBillingMove(db, draftRefundRecord), true);
  assert.equal(models['account.move'].form.subtitle(draftRefundRecord, db), 'Self Billing Credit Note');

  db = postMove(db, refundDraft.id);
  const refundPosted = read(db, 'account.move', refundDraft.id);
  assert.equal(models['account.move'].form.subtitle(refundPosted, db), 'Self Billing Credit Note');

  const refundCancelled = { ...refundPosted, state: 'cancel' };
  assert.equal(models['account.move'].form.subtitle(refundCancelled, db), 'Self Billing Credit Note');

  // 3. PrintDoc rendering verifies printed titles
  await initStore();
  await React.act(async () => commit(db));

  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    // Draft bill print
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.move', id: refundDraft.id })));
    assert.match(host.textContent, /Self Billing Credit Note/);
    assert.doesNotMatch(host.textContent, /Customer Invoice|Draft Credit Note|Draft Invoice/);

    // Posted bill print
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.move', id: billDraft.id })));
    assert.match(host.textContent, /Self Billing/);
    assert.doesNotMatch(host.textContent, /Customer Invoice|Vendor Bill/);
  } finally {
    await React.act(async () => root.unmount());
  }

  // 4. Standard non-self-billing purchase journal comparison
  const stdJournal = search(db, 'account.journal').find((j) => j.type === 'purchase' && !j.is_self_billing);
  const stdBill = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: partner.id,
    journal_id: stdJournal.id,
    invoice_date: '2026-03-15',
    invoice_line_ids: [{ name: 'Goods', qty: 1, price_unit: 10, tax: 0, account_id: expAccount.id }],
  });
  assert.equal(isSelfBillingMove(stdBill.db, read(stdBill.db, 'account.move', stdBill.id)), false);
  assert.equal(models['account.move'].form.subtitle(read(stdBill.db, 'account.move', stdBill.id), stdBill.db), 'Vendor Bill');

  // 5. Arabic i18n
  assert.equal(ownArabic('Self Billing'), 'الفوترة الذاتية');
  assert.equal(ownArabic('Self Billing Credit Note'), 'إشعار دائن للفوترة الذاتية');
});

test('numbering: bill numbers in a self-billing journal are sequenced per commercial partner', () => {
  let db = seed();
  const expAccount = search(db, 'account.account').find((a) => a.account_type === 'expense')
    ?? search(db, 'account.account').find((a) => a.code === '600000');

  const sbJournal = create(db, 'account.journal', {
    name: 'Self-Billing Bills',
    code: 'SBILL',
    type: 'purchase',
    company_id: 1,
    default_account_id: expAccount.id,
    is_self_billing: true,
  });
  db = sbJournal.db;

  const partner1 = create(db, 'res.partner', { name: 'Vendor One', is_company: true });
  db = partner1.db;
  const partner2 = create(db, 'res.partner', { name: 'Vendor Two', is_company: true });
  db = partner2.db;
  const partner1Contact = create(db, 'res.partner', { name: 'Vendor One Branch', is_company: false, parent_id: partner1.id });
  db = partner1Contact.db;

  const partner1Padded = String(partner1.id).padStart(5, '0');
  const partner2Padded = String(partner2.id).padStart(5, '0');

  // Partner 1 - First bill in 2026-03
  const bill1P1 = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: partner1.id,
    journal_id: sbJournal.id,
    invoice_date: '2026-03-10',
    invoice_line_ids: [{ name: 'Item A', qty: 1, price_unit: 100, tax: 0, account_id: expAccount.id }],
  });
  db = bill1P1.db;

  // Verify is_self_billing is computed and NOT stored directly on the record
  const rawCreated = db.records['account.move'].find((m) => m.id === bill1P1.id);
  assert.equal(rawCreated.is_self_billing, undefined, 'is_self_billing must not be stored in db.records on account.move');
  assert.equal(read(db, 'account.move', bill1P1.id).is_self_billing, true, 'is_self_billing is computed as true via relation');

  db = postMove(db, bill1P1.id);
  const posted1P1 = read(db, 'account.move', bill1P1.id);
  assert.equal(posted1P1.name, `SBILL${partner1Padded}/2026/03/0001`, 'first bill for partner 1 starts at 0001');

  // Partner 2 - First bill in 2026-03 (independent sequence!)
  const bill1P2 = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: partner2.id,
    journal_id: sbJournal.id,
    invoice_date: '2026-03-12',
    invoice_line_ids: [{ name: 'Item B', qty: 2, price_unit: 50, tax: 0, account_id: expAccount.id }],
  });
  db = postMove(bill1P2.db, bill1P2.id);
  const posted1P2 = read(db, 'account.move', bill1P2.id);
  assert.equal(posted1P2.name, `SBILL${partner2Padded}/2026/03/0001`, 'first bill for partner 2 starts at 0001 independently');

  // Partner 1 - Second bill in 2026-03 (increments partner 1 sequence)
  const bill2P1 = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: partner1.id,
    journal_id: sbJournal.id,
    invoice_date: '2026-03-18',
    invoice_line_ids: [{ name: 'Item C', qty: 1, price_unit: 150, tax: 0, account_id: expAccount.id }],
  });
  db = postMove(bill2P1.db, bill2P1.id);
  const posted2P1 = read(db, 'account.move', bill2P1.id);
  assert.equal(posted2P1.name, `SBILL${partner1Padded}/2026/03/0002`, 'second bill for partner 1 is 0002');

  // Partner 1 Contact (child partner sharing commercial partner) - Third bill in 2026-03
  const bill3P1 = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: partner1Contact.id,
    journal_id: sbJournal.id,
    invoice_date: '2026-03-22',
    invoice_line_ids: [{ name: 'Item D', qty: 1, price_unit: 200, tax: 0, account_id: expAccount.id }],
  });
  db = postMove(bill3P1.db, bill3P1.id);
  const posted3P1 = read(db, 'account.move', bill3P1.id);
  assert.equal(
    posted3P1.name,
    `SBILL${partner1Padded}/2026/03/0003`,
    'bill for child partner uses commercial partner sequence and increments to 0003',
  );

  // Partner 1 Credit Note in 2026-03
  const refundP1 = create(db, 'account.move', {
    move_type: 'in_refund',
    company_id: 1,
    partner_id: partner1.id,
    journal_id: sbJournal.id,
    invoice_date: '2026-03-25',
    invoice_line_ids: [{ name: 'Item A Return', qty: 1, price_unit: 100, tax: 0, account_id: expAccount.id }],
  });
  db = postMove(refundP1.db, refundP1.id);
  const postedRefundP1 = read(db, 'account.move', refundP1.id);
  assert.equal(postedRefundP1.name, `SBILL${partner1Padded}/2026/03/0004`, 'refund for partner 1 continues partner sequence');

  // Verify journal does not have an undefined sequence field written to it
  const sbJournalRecord = read(db, 'account.journal', sbJournal.id);
  assert.equal('undefined' in sbJournalRecord, false);
});
