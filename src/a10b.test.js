import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { models } from './models/index.js';
import { amounts } from './models/common.js';
import { accountId, isBalanced, journalId, postEntry } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { duplicateBillWarning } from './models/finance.js';
import { reverseEntry } from './models/pay.js';
import { taxSnapshot } from './models/taxes.js';
import { applyDiff, diffDb } from './sync.js';
import { seed } from './seed.js';

const button = (model, label) => models[model].form.buttons.find((b) => b.label === label);

test('Area 1 (Credit notes): partial credit note, full refund (cancel), and full refund + new draft (modify) reconcile and leave expected residuals', () => {
  const base = seed();
  const invCreated = create(base, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-04-01',
    invoice_date_due: '2026-04-30',
    ref: 'CUST-PO-99',
    invoice_line_ids: [
      { product_id: 1, qty: 2, price_unit: 100, tax: 14, tax_type: 'percent', tax_include: false, tax_name: 'VAT 14%' },
    ],
  });
  const db1 = postMove(invCreated.db, invCreated.id);
  const postedInv = read(db1, 'account.move', invCreated.id);
  assert.equal(postedInv.amount_total, 228);
  assert.equal(postedInv.amount_residual, 228);

  const cnButton = button('account.move', 'Credit Note');
  assert.ok(cnButton.wizard, 'Credit Note button exposes a wizard');
  const spec = cnButton.wizard(db1, postedInv);
  assert.deepEqual(spec.fields.map((f) => f.name), ['refund_method', 'reason', 'date', 'journal_id']);

  // 1a. Partial credit note via refund_method: 'refund' -> creates draft, user edits to partial amount and posts
  const partialRes = cnButton.run(db1, postedInv, {
    refund_method: 'refund',
    reason: 'Damaged unit',
    date: '2026-04-05',
  });
  const partialDraft = read(partialRes.db, 'account.move', partialRes.id);
  assert.equal(partialDraft.state, 'draft');
  assert.equal(partialDraft.move_type, 'out_refund');
  assert.equal(partialDraft.reversed_entry_id, postedInv.id);
  assert.equal(partialDraft.ref, `Reversal of ${postedInv.name}, Damaged unit`);
  assert.equal(partialDraft.invoice_date, '2026-04-05');

  const editedPartial = write(partialRes.db, 'account.move', partialRes.id, {
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 14, tax_type: 'percent', tax_include: false, tax_name: 'VAT 14%' }],
  });
  const postedPartialDb = postMove(editedPartial, partialRes.id);
  const invAfterPartial = read(postedPartialDb, 'account.move', postedInv.id);
  const noteAfterPartial = read(postedPartialDb, 'account.move', partialRes.id);
  assert.equal(noteAfterPartial.state, 'posted');
  assert.equal(noteAfterPartial.amount_total, 114);
  assert.equal(noteAfterPartial.amount_residual, 0);
  assert.equal(noteAfterPartial.payment_state, 'paid');
  assert.equal(invAfterPartial.amount_paid, 114);
  assert.equal(invAfterPartial.amount_residual, 114);
  assert.equal(invAfterPartial.payment_state, 'partial');

  // 1b. Full refund ('cancel') immediately posts the reversal entry and reconciles it with the original invoice
  const cancelRes = cnButton.run(db1, postedInv, {
    refund_method: 'cancel',
    reason: 'Cancelled order',
    date: '2026-04-10',
  });
  const invAfterCancel = read(cancelRes.db, 'account.move', postedInv.id);
  const fullNote = read(cancelRes.db, 'account.move', cancelRes.id);
  assert.equal(fullNote.state, 'posted');
  assert.equal(fullNote.reversed_entry_id, postedInv.id);
  assert.equal(invAfterCancel.reversal_move_id, fullNote.id);
  assert.equal(fullNote.ref, `Reversal of ${postedInv.name}, Cancelled order`);
  assert.equal(fullNote.amount_total, 228);
  assert.equal(fullNote.amount_residual, 0);
  assert.equal(fullNote.payment_state, 'paid');
  assert.equal(invAfterCancel.amount_residual, 0);
  assert.equal(invAfterCancel.payment_state, 'paid');
  assert.deepEqual(invAfterCancel.payments.map((p) => [p.amount, p.move_id]), [[228, fullNote.id]]);

  // 1c. Modify ('modify'): posts & reconciles the full credit note AND creates a new draft copy of the invoice
  const modifyRes = cnButton.run(db1, postedInv, {
    refund_method: 'modify',
    reason: 'Wrong price on invoice',
    date: '2026-04-12',
  });
  const invAfterModify = read(modifyRes.db, 'account.move', postedInv.id);
  const modifyCreditNote = read(modifyRes.db, 'account.move', modifyRes.credit_note_id);
  const newDraftInv = read(modifyRes.db, 'account.move', modifyRes.id);
  assert.equal(modifyCreditNote.state, 'posted');
  assert.equal(modifyCreditNote.reversed_entry_id, postedInv.id);
  assert.equal(modifyCreditNote.amount_residual, 0);
  assert.equal(invAfterModify.amount_residual, 0);
  assert.equal(invAfterModify.payment_state, 'paid');
  assert.equal(newDraftInv.state, 'draft');
  assert.equal(newDraftInv.move_type, 'out_invoice');
  assert.equal(newDraftInv.partner_id, postedInv.partner_id);
  assert.equal(newDraftInv.invoice_date, '2026-04-12');
  assert.equal(newDraftInv.amount_total, 228);
  assert.equal(modifyRes.go, `#/accounting/invoices/${newDraftInv.id}`);

  // Round-trip through sync diff
  const synced = applyDiff(db1, diffDb(db1, modifyRes.db));
  assert.equal(read(synced, 'account.move', postedInv.id).amount_residual, 0);
  assert.equal(read(synced, 'account.move', newDraftInv.id).state, 'draft');
});

test('Area 2 (Vendor bill duplicate detection): warns on same vendor + reference, or same vendor + date + amount when no reference, without blocking posting', () => {
  const base = seed();
  const bill1 = create(base, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 4,
    ref: 'VEND-2026-001',
    invoice_date: '2026-04-01',
    invoice_line_ids: [{ product_id: 2, qty: 1, price_unit: 500, tax: 0 }],
  });
  const db1 = postMove(bill1.db, bill1.id);

  // Same vendor + same reference -> warning shown on form, but posting is NOT blocked
  const dupRef = create(db1, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 4,
    ref: 'vend-2026-001',
    invoice_date: '2026-04-15',
    invoice_line_ids: [{ product_id: 2, qty: 1, price_unit: 300, tax: 0 }],
  });
  const dupRefRec = read(dupRef.db, 'account.move', dupRef.id);
  const warn1 = models['account.move'].form.warning(dupRefRec, dupRef.db);
  assert.match(warn1, /Duplicate bill warning/i);
  assert.match(warn1, /VEND-2026-001/i);
  assert.equal(duplicateBillWarning(dupRef.db, dupRefRec), warn1);

  // Different reference -> no warning
  const diffRef = write(dupRef.db, 'account.move', dupRef.id, { ref: 'VEND-2026-002' });
  assert.equal(models['account.move'].form.warning(read(diffRef, 'account.move', dupRef.id), diffRef), '');

  // Posting the duplicate-ref bill succeeds without throwing
  const postedDupRefDb = postMove(dupRef.db, dupRef.id);
  assert.equal(read(postedDupRefDb, 'account.move', dupRef.id).state, 'posted');

  // No reference: same vendor + same invoice_date + same amount_total -> warning
  const noRef1 = create(postedDupRefDb, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 4,
    ref: '',
    invoice_date: '2026-05-01',
    invoice_line_ids: [{ product_id: 2, qty: 2, price_unit: 125, tax: 0 }],
  });
  const dbNoRef1 = postMove(noRef1.db, noRef1.id);
  const noRef2 = create(dbNoRef1, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 4,
    ref: '',
    invoice_date: '2026-05-01',
    invoice_line_ids: [{ product_id: 2, qty: 1, price_unit: 250, tax: 0 }],
  });
  const warnNoRef = models['account.move'].form.warning(read(noRef2.db, 'account.move', noRef2.id), noRef2.db);
  assert.match(warnNoRef, /Duplicate bill warning/i);
  assert.match(warnNoRef, /2026-05-01/);
  assert.match(warnNoRef, /same amount/i);

  // Different date or different amount when no reference -> no warning
  const diffDate = write(noRef2.db, 'account.move', noRef2.id, { invoice_date: '2026-05-02' });
  assert.equal(models['account.move'].form.warning(read(diffDate, 'account.move', noRef2.id), diffDate), '');
  const diffAmt = write(noRef2.db, 'account.move', noRef2.id, { invoice_line_ids: [{ product_id: 2, qty: 1, price_unit: 251, tax: 0 }] });
  assert.equal(models['account.move'].form.warning(read(diffAmt, 'account.move', noRef2.id), diffAmt), '');

  // Posting the no-ref duplicate bill succeeds without blocking
  const postedNoRef2 = postMove(noRef2.db, noRef2.id);
  assert.equal(read(postedNoRef2, 'account.move', noRef2.id).state, 'posted');
});

test('Area 3 (Taxes): price-included, include_base_amount (tax-on-tax), group taxes, fixed taxes, and company rounding method (round_per_line vs round_globally)', () => {
  let db = seed();
  const vatAccount = accountId(db, '251000');
  const levyAccount = accountId(db, '230000');

  // Create a fixed eco-tax that affects the base of subsequent taxes (sequence 1)
  const ecoTax = create(db, 'account.tax', {
    name: 'Eco Levy $5',
    sequence: 1,
    amount_type: 'fixed',
    amount: 5,
    type_tax_use: 'sale',
    price_include: false,
    include_base_amount: true,
    account_id: levyAccount,
  });
  db = ecoTax.db;

  // Create a percentage VAT tax affected by previous taxes (sequence 10)
  const vat10 = create(db, 'account.tax', {
    name: 'VAT 10%',
    sequence: 10,
    amount_type: 'percent',
    amount: 10,
    type_tax_use: 'sale',
    price_include: false,
    is_base_affected: true,
    account_id: vatAccount,
  });
  db = vat10.db;

  // Create a Group of Taxes combining Eco Levy $5 + VAT 10%
  const groupTax = create(db, 'account.tax', {
    name: 'Eco + VAT Group',
    amount_type: 'group',
    type_tax_use: 'sale',
    children_tax_ids: [ecoTax.id, vat10.id],
  });
  db = groupTax.db;

  // Guard: group tax cannot include itself
  assert.throws(() => write(db, 'account.tax', groupTax.id, { children_tax_ids: [groupTax.id] }), /cannot include itself/);

  // Apply group tax via line onchange (public path) on qty=2, price_unit=100:
  // Untaxed base = 200; Eco Levy = 2 * 5 = 10 (affects base -> subsequent base = 210); VAT 10% = 210 * 10% = 21; Total tax = 31, Total = 231.
  const lineDef = models['account.move'].fields.invoice_line_ids;
  const lineWithGroup = lineDef.onchange({ product_id: 1, qty: 2, price_unit: 100, discount: 0, tax_id: groupTax.id }, 'tax_id', db, {});
  assert.deepEqual(amounts([lineWithGroup]), { untaxed: 200, tax: 31, total: 231 });

  const invGroup = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-01',
    invoice_line_ids: [lineWithGroup],
  });
  db = postMove(invGroup.db, invGroup.id);
  const postedGroupMove = read(db, 'account.move', invGroup.id);
  assert.ok(isBalanced(postedGroupMove.line_ids));
  assert.equal(postedGroupMove.amount_untaxed, 200);
  assert.equal(postedGroupMove.amount_tax, 31);
  assert.equal(postedGroupMove.amount_total, 231);
  // Group tax posts separate tax lines per child tax on their respective accounts
  const ecoLine = postedGroupMove.line_ids.find((l) => l.account_id === levyAccount);
  const vatLine = postedGroupMove.line_ids.find((l) => l.account_id === vatAccount);
  assert.equal(ecoLine.credit, 10);
  assert.equal(ecoLine.tax_base, 200);
  assert.equal(vatLine.credit, 21);
  assert.equal(vatLine.tax_base, 210);

  // Rule 1: Editing a tax's amount after an invoice is posted (or snapshotted on a draft) must not change the invoice total or its journal items
  const beforeLinesJson = JSON.stringify(postedGroupMove.line_ids);
  const draftSnapInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-01',
    invoice_line_ids: [lineWithGroup],
  });
  db = write(draftSnapInv.db, 'account.tax', ecoTax.id, { amount: 50 });
  db = write(db, 'account.tax', vat10.id, { amount: 25 });
  const afterTaxEditMove = read(db, 'account.move', invGroup.id);
  assert.equal(afterTaxEditMove.amount_untaxed, 200);
  assert.equal(afterTaxEditMove.amount_tax, 31);
  assert.equal(afterTaxEditMove.amount_total, 231);
  assert.equal(JSON.stringify(afterTaxEditMove.line_ids), beforeLinesJson);
  // Posting the draft whose line was already snapshotted before the tax edit also uses only the line snapshot
  db = postMove(db, draftSnapInv.id);
  const postedAfterEdit = read(db, 'account.move', draftSnapInv.id);
  assert.equal(postedAfterEdit.amount_untaxed, 200);
  assert.equal(postedAfterEdit.amount_tax, 31);
  assert.equal(postedAfterEdit.amount_total, 231);
  assert.equal(postedAfterEdit.line_ids.find((l) => l.account_id === levyAccount).credit, 10);
  assert.equal(postedAfterEdit.line_ids.find((l) => l.account_id === vatAccount).credit, 21);

  // Price-included compound taxes: 10% price-included (include_base_amount: true) + 5% price-included (is_base_affected: true)
  // On gross = 115.50: B0 = 100, Tax 1 = 10, Tax 2 (on 110) = 5.50, Total = 115.50
  const incl1 = create(db, 'account.tax', {
    name: 'Excise 10% Incl',
    sequence: 1,
    amount_type: 'percent',
    amount: 10,
    type_tax_use: 'sale',
    price_include: true,
    include_base_amount: true,
    account_id: levyAccount,
  });
  const incl2 = create(incl1.db, 'account.tax', {
    name: 'Sales Tax 5% Incl',
    sequence: 2,
    amount_type: 'percent',
    amount: 5,
    type_tax_use: 'sale',
    price_include: true,
    is_base_affected: true,
    account_id: vatAccount,
  });
  db = incl2.db;
  const compoundLine = lineDef.onchange({ product_id: 1, qty: 1, price_unit: 115.5, discount: 0, tax_ids: [incl1.id, incl2.id] }, 'tax_ids', db, {});
  assert.deepEqual(amounts([compoundLine]), { untaxed: 100, tax: 15.5, total: 115.5 });

  // Company rounding method: round_per_line vs round_globally
  // Two lines of 10.05 with 5% tax:
  // Per line: 10.05 * 5% = 0.5025 -> rounds to 0.50 per line -> sum of 2 lines = 1.00 tax (total 21.10).
  // Globally: (0.5025 + 0.5025) = 1.005 -> rounds globally to 1.01 tax (total 21.11).
  const tax5 = create(db, 'account.tax', { name: 'VAT 5%', amount_type: 'percent', amount: 5, type_tax_use: 'sale', account_id: vatAccount });
  db = tax5.db;
  const snap5 = taxSnapshot(read(db, 'account.tax', tax5.id), db);
  const twoLines = [
    { product_id: 1, qty: 1, price_unit: 10.05, discount: 0, ...snap5 },
    { product_id: 1, qty: 1, price_unit: 10.05, discount: 0, ...snap5 },
  ];

  // Round per line
  db = write(db, 'res.company', 1, { tax_calculation_rounding_method: 'round_per_line' });
  const invPerLine = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-04-02', invoice_line_ids: twoLines });
  db = postMove(invPerLine.db, invPerLine.id);
  const postedPerLine = read(db, 'account.move', invPerLine.id);
  assert.equal(postedPerLine.amount_untaxed, 20.1);
  assert.equal(postedPerLine.amount_tax, 1.0);
  assert.equal(postedPerLine.amount_total, 21.1);
  assert.equal(postedPerLine.line_ids.find((l) => l.account_id === vatAccount).credit, 1.0);

  // Round globally
  db = write(db, 'res.company', 1, { tax_calculation_rounding_method: 'round_globally' });
  const invGlobal = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-04-02', invoice_line_ids: twoLines });
  db = postMove(invGlobal.db, invGlobal.id);
  const postedGlobal = read(db, 'account.move', invGlobal.id);
  assert.equal(postedGlobal.amount_untaxed, 20.1);
  assert.equal(postedGlobal.amount_tax, 1.01);
  assert.equal(postedGlobal.amount_total, 21.11);
  assert.equal(postedGlobal.line_ids.find((l) => l.account_id === vatAccount).credit, 1.01);

  // Rule 4: Several small distinct tax groups under both rounding modes: computed total === posted receivable and amount_tax === sum(tax lines)
  const receivableAcc = accountId(db, '121000');
  const smallA = create(db, 'account.tax', { name: 'Small Tax A 5%', amount_type: 'percent', amount: 5, type_tax_use: 'sale', account_id: vatAccount });
  const smallB = create(smallA.db, 'account.tax', { name: 'Small Tax B 7%', amount_type: 'percent', amount: 7, type_tax_use: 'sale', account_id: levyAccount });
  const smallC = create(smallB.db, 'account.tax', { name: 'Small Tax C 3%', amount_type: 'percent', amount: 3, type_tax_use: 'sale', account_id: vatAccount });
  db = smallC.db;
  const snapA = taxSnapshot(read(db, 'account.tax', smallA.id), db);
  const snapB = taxSnapshot(read(db, 'account.tax', smallB.id), db);
  const snapC = taxSnapshot(read(db, 'account.tax', smallC.id), db);
  const multiGroupLines = [
    { product_id: 1, qty: 1, price_unit: 1.05, discount: 0, ...snapA }, // 0.0525
    { product_id: 1, qty: 1, price_unit: 1.05, discount: 0, ...snapA }, // 0.0525 -> Group A sum = 0.105 (per_line: 0.05+0.05=0.10, globally: 0.11)
    { product_id: 1, qty: 1, price_unit: 1.05, discount: 0, ...snapB }, // 0.0735
    { product_id: 1, qty: 1, price_unit: 1.05, discount: 0, ...snapB }, // 0.0735 -> Group B sum = 0.147 (per_line: 0.07+0.07=0.14, globally: 0.15)
    { product_id: 1, qty: 1, price_unit: 1.15, discount: 0, ...snapC }, // 0.0345
    { product_id: 1, qty: 1, price_unit: 1.15, discount: 0, ...snapC }, // 0.0345 -> Group C sum = 0.069 (per_line: 0.03+0.03=0.06, globally: 0.07)
  ];
  for (const mode of ['round_per_line', 'round_globally']) {
    db = write(db, 'res.company', 1, { tax_calculation_rounding_method: mode });
    const draftMulti = create(db, 'account.move', {
      move_type: 'out_invoice',
      partner_id: 1,
      invoice_date: '2026-04-03',
      invoice_line_ids: multiGroupLines,
    });
    const draftRec = read(draftMulti.db, 'account.move', draftMulti.id);
    const computedDraftTotal = draftRec.amount_total;
    const computedDraftTax = draftRec.amount_tax;
    db = postMove(draftMulti.db, draftMulti.id);
    const postedMulti = read(db, 'account.move', draftMulti.id);
    assert.ok(isBalanced(postedMulti.line_ids), `Balanced under ${mode}`);
    const receivableLine = postedMulti.line_ids.find((l) => l.account_id === receivableAcc);
    const taxLinesSum = Number(postedMulti.line_ids.filter((l) => l.tax_name && !l.tax_zero).reduce((s, l) => s + l.credit, 0).toFixed(2));
    assert.equal(postedMulti.amount_total, computedDraftTotal, `Draft vs posted total matches under ${mode}`);
    assert.equal(postedMulti.amount_total, receivableLine.debit, `Computed total === posted receivable under ${mode}`);
    assert.equal(postedMulti.amount_tax, computedDraftTax, `Draft vs posted tax matches under ${mode}`);
    assert.equal(postedMulti.amount_tax, taxLinesSum, `Computed amount_tax === posted tax lines sum under ${mode}`);
  }
});

test('Area 4 (Entry reversal): reverse with chosen date and journal, reverse-and-create, and accrual-style automatic reversal on a future date', () => {
  const base = seed();
  const miscId = journalId(base, 'MISC');
  const salId = journalId(base, 'SAL');
  const rentAcc = accountId(base, '630000');
  const bankAcc = accountId(base, '101401');

  // 4a. Reverse a posted journal entry with a chosen date, journal, and reason via the Reverse Entry button/wizard
  const entry1 = postEntry(base, {
    journal: 'MISC',
    date: '2026-03-31',
    ref: 'March accrual',
    lines: [
      { account_id: rentAcc, debit: 400, credit: 0, name: 'Accrued rent' },
      { account_id: bankAcc, debit: 0, credit: 400, name: 'Payable' },
    ],
  });
  const orig1 = read(entry1.db, 'account.move', entry1.id);
  const revBtn = button('account.move', 'Reverse Entry');
  assert.equal(revBtn.when(orig1, entry1.db), true);
  assert.ok(revBtn.wizard, 'Reverse Entry button exposes a wizard');

  const rev1 = revBtn.run(entry1.db, orig1, {
    date: '2026-04-01',
    journal_id: salId,
    mode: 'reverse',
    reason: 'April reversal',
  });
  const reversalMove = read(rev1.db, 'account.move', rev1.id);
  const updatedOrig1 = read(rev1.db, 'account.move', orig1.id);
  assert.equal(reversalMove.state, 'posted');
  assert.equal(reversalMove.journal_id, salId);
  assert.match(reversalMove.name, /^SAL\/2026\//);
  assert.equal(reversalMove.invoice_date, '2026-04-01');
  assert.equal(reversalMove.reversed_entry_id, orig1.id);
  assert.equal(updatedOrig1.reversal_move_id, reversalMove.id);
  assert.equal(reversalMove.ref, `Reversal of ${orig1.name}, April reversal`);
  assert.ok(isBalanced(reversalMove.line_ids));
  assert.equal(reversalMove.line_ids.find((l) => l.account_id === rentAcc).credit, 400);
  assert.equal(reversalMove.line_ids.find((l) => l.account_id === bankAcc).debit, 400);
  assert.equal(revBtn.when(updatedOrig1, rev1.db), false, 'Already-reversed entry cannot be reversed again');

  // 4b. Reverse-and-create ('modify'): reverses the original entry AND creates a new draft copy
  const entry2 = postEntry(rev1.db, {
    journal: 'MISC',
    date: '2026-04-15',
    ref: 'Reclass entry',
    lines: [
      { account_id: rentAcc, debit: 250, credit: 0, name: 'Rent line' },
      { account_id: bankAcc, debit: 0, credit: 250, name: 'Bank line' },
    ],
  });
  const orig2 = read(entry2.db, 'account.move', entry2.id);
  const modRes = reverseEntry(entry2.db, orig2, {
    date: '2026-04-20',
    journal_id: miscId,
    mode: 'modify',
    reason: 'Fix account',
  });
  const rev2 = read(modRes.db, 'account.move', modRes.reversal_id);
  const draft2 = read(modRes.db, 'account.move', modRes.id);
  assert.equal(rev2.state, 'posted');
  assert.equal(rev2.reversed_entry_id, orig2.id);
  assert.equal(read(modRes.db, 'account.move', orig2.id).reversal_move_id, rev2.id);
  assert.equal(draft2.state, 'draft');
  assert.equal(draft2.move_type, 'entry');
  assert.equal(draft2.invoice_date, '2026-04-20');
  assert.equal(draft2.line_ids.find((l) => l.account_id === rentAcc).debit, 250);
  assert.equal(modRes.go, `#/accounting/entries/${draft2.id}`);

  // 4c. Accrual-style automatic reversal on a future date when posting an entry with auto_reverse
  const badAccrual = create(modRes.db, 'account.move', {
    move_type: 'entry',
    journal_id: miscId,
    invoice_date: '2026-04-30',
    date: '2026-04-30',
    ref: 'Month-end accrual',
    auto_reverse: true,
    reverse_date: '2026-04-30', // not strictly after accounting date
    line_ids: [
      { account_id: rentAcc, debit: 600, credit: 0, name: 'Accrual' },
      { account_id: bankAcc, debit: 0, credit: 600, name: 'Accrual' },
    ],
  });
  assert.throws(() => postMove(badAccrual.db, badAccrual.id), /Reversal date must be after the accounting date/);

  const goodAccrual = write(badAccrual.db, 'account.move', badAccrual.id, {
    reverse_date: '2026-05-01',
    reverse_journal_id: salId,
  });
  const postedAccrualDb = postMove(goodAccrual, badAccrual.id);
  const postedAccrual = read(postedAccrualDb, 'account.move', badAccrual.id);
  assert.equal(postedAccrual.state, 'posted');
  assert.ok(postedAccrual.reversal_move_id, 'Posting an auto-reverse entry creates and links its future reversal entry');
  const autoReversal = read(postedAccrualDb, 'account.move', postedAccrual.reversal_move_id);
  assert.equal(autoReversal.state, 'posted');
  assert.equal(autoReversal.reversed_entry_id, postedAccrual.id);
  assert.equal(autoReversal.invoice_date, '2026-05-01');
  assert.equal(autoReversal.date, '2026-05-01');
  assert.equal(autoReversal.journal_id, salId);
  assert.ok(isBalanced(autoReversal.line_ids));
  assert.equal(autoReversal.line_ids.find((l) => l.account_id === rentAcc).credit, 600);
  assert.equal(autoReversal.line_ids.find((l) => l.account_id === bankAcc).debit, 600);
});
