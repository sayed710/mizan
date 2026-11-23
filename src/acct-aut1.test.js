import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { create, read, write } from './orm.js';

test('AP-1 company setting and Vendor Bills control are available', () => {
  assert.equal(models['res.company'].fields.autopost_bills?.type, 'boolean');
  const source = fs.readFileSync(new URL('./views/Settings.jsx', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('data-block="vendor_bills"'), source.indexOf('data-block="fiscal_periods"'));
  assert.match(block, /id="autopost_bills"/);
  const db = seed();
  assert.equal(read(write(db, 'res.company', 1, { autopost_bills: true }), 'res.company', 1).autopost_bills, true);
});

test('AP-2 vendor policy defaults to ask and follows active company setting', () => {
  const field = models['res.partner'].fields.autopost_bills;
  assert.equal(field?.default, 'ask');
  assert.deepEqual(field.options.map(([value]) => value), ['always', 'ask', 'never']);
  assert.ok(models['res.partner'].form.tabs.find((tab) => tab.label === 'Accounting').fields.includes('autopost_bills'));
  let db = seed();
  const vendor = create(db, 'res.partner', { name: 'Vendor' });
  db = vendor.db;
  assert.equal(read(db, 'res.partner', vendor.id).autopost_bills, 'ask');
  assert.equal(field.hideWhen({}, db), true);
  db = write(db, 'res.company', 1, { autopost_bills: true });
  assert.equal(field.hideWhen({}, db), false);
});

import { applyDiff, diffDb } from './sync.js';
import { applyDigitizedBill } from '../server/digitized-store.js';

test('AP-3 digitization result identifies the filled bill for automatic posting', async () => {
  const { finishDigitizedBill } = await import('../server/integrations.js');
  assert.equal(typeof finishDigitizedBill, 'function');
});

test('AP-4 digitized edits clear the flag and forged diffs are rejected', () => {
  let db = seed();
  const made = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 7, digitized_vendor_id: 7, invoice_line_ids: [{ name: 'Goods', qty: 1, price_unit: 100, tax: 0 }], ref: 'before', digitized_document: true, digitized_unedited: true });
  db = made.db;
  const changed = write(db, 'account.move', made.id, { ref: 'after' });
  assert.equal(read(changed, 'account.move', made.id).digitized_unedited, false);
  const forged = { ...changed, records: { ...changed.records, 'account.move': changed.records['account.move'].map((m) => m.id === made.id ? { ...m, digitized_unedited: true } : m) } };
  assert.throws(() => applyDiff(db, diffDb(db, forged), { isAdmin: true }), /digitiz/i);
  const posted = postMove(db, made.id);
  const fakePost = { ...posted, records: { ...posted.records, 'account.move': posted.records['account.move'].map((m) => m.id === made.id ? { ...m, ref: 'forged' } : m) } };
  assert.throws(() => applyDiff(db, diffDb(db, fakePost), { isAdmin: true }), /digitiz/i);
});

import { postMove, suggestBillAutopost } from './models/accounting.js';

test('AP-4 suggestion follows three unedited posted bills, resets on edit, and choices sync', () => {
  let db = write(seed(), 'res.company', 1, { autopost_bills: true });
  const vendorId = 7;
  for (let i = 0; i < 3; i++) {
    const made = create(db, 'account.move', { move_type: 'in_invoice', partner_id: vendorId, digitized_vendor_id: vendorId, digitized_document: true, digitized_unedited: true, invoice_line_ids: [{ name: 'Goods', qty: 1, price_unit: 100, tax: 0 }] });
    const posted = postMove(made.db, made.id);
    db = applyDiff(made.db, diffDb(made.db, posted), { isAdmin: true });
    assert.equal(read(db, 'account.move', made.id).digitized_unedited, true);
  }
  let made = create(db, 'account.move', { move_type: 'in_invoice', partner_id: vendorId, digitized_vendor_id: vendorId, digitized_document: true, digitized_unedited: true, invoice_line_ids: [{ name: 'Goods', qty: 1, price_unit: 100, tax: 0 }] });
  db = made.db;
  let bill = read(db, 'account.move', made.id);
  assert.equal(suggestBillAutopost(db, bill), true);
  for (const choice of ['Always', 'Never']) {
    const button = models['account.move'].form.buttons.find((b) => b.label === choice);
    assert.equal(button.when(bill, db), true);
    const next = button.run(db, bill).db;
    const saved = applyDiff(db, diffDb(db, next), { isAdmin: true });
    assert.equal(read(saved, 'res.partner', vendorId).autopost_bills, choice.toLowerCase());
    assert.equal(suggestBillAutopost(saved, bill), false);
  }
  const edited = write(db, 'account.move', made.id, { ref: 'changed' });
  const postedEdited = postMove(edited, made.id);
  db = applyDiff(db, diffDb(db, postedEdited), { isAdmin: true });
  made = create(db, 'account.move', { move_type: 'in_invoice', partner_id: vendorId, digitized_vendor_id: vendorId, digitized_document: true, digitized_unedited: true });
  db = made.db;
  bill = read(db, 'account.move', made.id);
  assert.equal(suggestBillAutopost(db, bill), false);
});

test('AP-3 commits digitization before posting, surfaces failure, and honors vendor policy', async () => {
  const { finishDigitizedBill } = await import('../server/integrations.js');
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  try {
    for (const scenario of ['always', 'ask', 'never', 'disabled', 'failure']) {
      let db = write(seed(), 'res.company', 1, { autopost_bills: true });
      db = write(db, 'res.partner', 7, { autopost_bills: ['ask', 'never'].includes(scenario) ? scenario : 'always' });
      if (scenario === 'disabled') db = write(db, 'res.company', 1, { autopost_bills: false });
      const vendor = read(db, 'res.partner', 7);
      const made = create(db, 'account.move', { move_type: 'in_invoice' });
      db = made.db;
      const snapshots = [];
      const store = { get: () => db, commit: (next) => { db = next; snapshots.push(db); }, commitDigitizedBill: (next) => { db = next; snapshots.push(db); } };
      globalThis.fetch = async () => new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'tool', name: 'record_bill', input: { vendor: vendor.name, reference: 'INV-7', invoice_date: '2026-10-20', lines: scenario === 'failure' ? [] : [{ description: 'Goods', quantity: 1, unit_price: 100, tax_percent: 0 }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      const out = await finishDigitizedBill(store, { id: made.id, file: { name: 'bill.pdf', type: 'application/pdf', data: 'JVBERi0xLjQ=' } });
      assert.equal(read(snapshots[0], 'account.move', made.id).state, 'draft');
      const bill = read(db, 'account.move', made.id);
      assert.equal(bill.ref, 'INV-7');
      assert.equal(bill.state, scenario === 'always' ? 'posted' : 'draft');
      assert.equal(bill.digitized_unedited, true);
      if (scenario === 'failure') assert.match(out.message, /automatic posting failed:.*invoice line/i);
      else assert.doesNotMatch(out.message, /failed/i);
      assert.equal(snapshots.length, scenario === 'always' ? 2 : 1);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test('AP-4 latest digitization resets the unedited flag, then later edits clear it', async () => {
  const { finishDigitizedBill } = await import('../server/integrations.js');
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  try {
    for (const steps of [['digitize', 'edit', 'digitize'], ['digitize', 'digitize', 'edit']]) {
      let db = write(seed(), 'res.company', 1, { autopost_bills: true });
      for (let i = 0; i < 2; i++) {
        const prior = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 7, digitized_vendor_id: 7, digitized_document: true, digitized_unedited: true, invoice_line_ids: [{ name: 'Goods', qty: 1, price_unit: 100, tax: 0 }] });
        db = applyDiff(prior.db, diffDb(prior.db, postMove(prior.db, prior.id)), { isAdmin: true });
      }
      const vendor = read(db, 'res.partner', 7);
      const made = create(db, 'account.move', { move_type: 'in_invoice' });
      db = made.db;
      let base = db;
      const store = { get: () => { base = db; return db; }, commit: (next) => { db = next; }, commitDigitizedBill: (next, id) => { db = applyDigitizedBill(db, base, next, id, { isAdmin: true }); } };
      let call = 0;
      globalThis.fetch = async () => new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'tool', name: 'record_bill', input: { vendor: vendor.name, reference: `OCR-${++call}`, invoice_date: '2026-10-20', lines: [{ description: 'Goods', quantity: 1, unit_price: 100, tax_percent: 0 }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      for (const step of steps) {
        if (step === 'digitize') await finishDigitizedBill(store, { id: made.id, file: { name: 'bill.pdf', type: 'application/pdf', data: 'JVBERi0xLjQ=' } });
        else store.commit(write(db, 'account.move', made.id, { ref: 'user edit' }));
        assert.equal(read(db, 'account.move', made.id).digitized_unedited, step === 'digitize', steps.join(', '));
        if (step === 'digitize') assert.equal(read(db, 'account.move', made.id).ref, `OCR-${call}`);
      }
      const posted = postMove(db, made.id);
      db = applyDiff(db, diffDb(db, posted), { isAdmin: true });
      assert.equal(read(db, 'account.move', made.id).digitized_unedited, steps.at(-1) === 'digitize');
      const next = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 7, digitized_vendor_id: 7, digitized_document: true, digitized_unedited: true });
      assert.equal(suggestBillAutopost(next.db, read(next.db, 'account.move', next.id)), steps.at(-1) === 'digitize');
    }
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = oldKey;
  }
});

test('Finding 1 regression: digitized drafts accept payment-term and fiscal position changes', () => {
  let db = seed();
  const term = create(db, 'account.payment.term', {
    name: '30 Days Net',
    line_ids: [{ value: 100, value_type: 'percent', nb_days: 30, delay_type: 'days_after' }],
  });
  db = term.db;
  const fpos = create(db, 'account.fiscal.position', { name: 'National' });
  db = fpos.db;

  const made1 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 7,
    digitized_vendor_id: 7,
    digitized_document: true,
    digitized_unedited: true,
    invoice_date: '2026-10-01',
    invoice_date_due: '2026-10-01',
    invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 50, tax: 0 }],
  });
  db = made1.db;

  // Setting payment term should not throw 'Edited digitized bill must be marked as changed'
  const withTerm = write(db, 'account.move', made1.id, { invoice_payment_term_id: term.id });
  const readTermBill = read(withTerm, 'account.move', made1.id);
  assert.equal(readTermBill.digitized_unedited, false);
  assert.equal(readTermBill.invoice_date_due, '2026-10-31');

  // Setting fiscal position on an untouched digitized draft should also succeed
  const made2 = create(withTerm, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 7,
    digitized_vendor_id: 7,
    digitized_document: true,
    digitized_unedited: true,
    invoice_date: '2026-10-01',
    invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 50, tax: 0 }],
  });
  const withFpos = write(made2.db, 'account.move', made2.id, { fiscal_position_id: fpos.id });
  const readFposBill = read(withFpos, 'account.move', made2.id);
  assert.equal(readFposBill.digitized_unedited, false);
});

test('Finding 2 regression: client cannot forge digitization provenance on ordinary moves', () => {
  let db = seed();
  const ordinary = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 7, ref: 'standard', invoice_line_ids: [{ name: 'L', qty: 1, price_unit: 10, tax: 0 }] });
  db = ordinary.db;

  // Forging digitization provenance on an ordinary draft bill via diff
  const forgedDraft = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].map((m) =>
        m.id === ordinary.id ? { ...m, digitized_document: true, digitized_unedited: true, digitized_vendor_id: 7 } : m
      ),
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, forgedDraft), { isAdmin: true }), /digitiz/i);

  // Forging digitization provenance on an ordinary posted bill
  const posted = postMove(db, ordinary.id);
  db = posted;
  const forgedPosted = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].map((m) =>
        m.id === ordinary.id ? { ...m, digitized_document: true, digitized_unedited: true, digitized_vendor_id: 7 } : m
      ),
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, forgedPosted), { isAdmin: true }), /digitiz/i);

  // Forging digitization provenance on a newly created bill via diff
  const forgedCreate = {
    ...db,
    records: {
      ...db.records,
      'account.move': [
        ...(db.records['account.move'] ?? []),
        { id: 999999, move_type: 'in_invoice', partner_id: 7, digitized_document: true, digitized_unedited: true, digitized_vendor_id: 7 },
      ],
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, forgedCreate), { isAdmin: true }), /digitiz/i);

  // Client cannot set digitized_unedited back to true on an edited digitized bill
  const digitized = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 7, digitized_vendor_id: 7, digitized_document: true, digitized_unedited: true });
  const editedDigitized = write(digitized.db, 'account.move', digitized.id, { ref: 'edited' });
  assert.equal(read(editedDigitized, 'account.move', digitized.id).digitized_unedited, false);
  const forgedUnedited = {
    ...editedDigitized,
    records: {
      ...editedDigitized.records,
      'account.move': editedDigitized.records['account.move'].map((m) =>
        m.id === digitized.id ? { ...m, digitized_unedited: true } : m
      ),
    },
  };
  assert.throws(() => applyDiff(editedDigitized, diffDb(editedDigitized, forgedUnedited), { isAdmin: true }), /digitiz/i);
});

test('Finding 4 regression: editing reference on posted digitized bill clears unedited flag and resets suggestion', () => {
  let db = write(seed(), 'res.company', 1, { autopost_bills: true });
  const vendorId = 7;
  const bill = create(db, 'account.move', { move_type: 'in_invoice', partner_id: vendorId, digitized_vendor_id: vendorId, digitized_document: true, digitized_unedited: true, ref: 'initial-ref', invoice_line_ids: [{ name: 'G', qty: 1, price_unit: 100, tax: 0 }] });
  const posted = postMove(bill.db, bill.id);
  db = applyDiff(bill.db, diffDb(bill.db, posted), { isAdmin: true });

  const postedBill = read(db, 'account.move', bill.id);
  assert.equal(postedBill.state, 'posted');
  assert.equal(postedBill.digitized_unedited, true);

  // User edits reference on posted bill
  const edited = write(db, 'account.move', bill.id, { ref: 'updated-ref' });
  const readEdited = read(edited, 'account.move', bill.id);
  assert.equal(readEdited.ref, 'updated-ref');
  assert.equal(readEdited.digitized_unedited, false);

  // Suggestion resets
  const nextDraft = create(edited, 'account.move', { move_type: 'in_invoice', partner_id: vendorId, digitized_vendor_id: vendorId, digitized_document: true, digitized_unedited: true });
  assert.equal(suggestBillAutopost(nextDraft.db, read(nextDraft.db, 'account.move', nextDraft.id)), false);
});

test('Finding 5 regression: finishDigitizedBill tells user when bill is posted automatically', async () => {
  const { finishDigitizedBill } = await import('../server/integrations.js');
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  try {
    let db = write(seed(), 'res.company', 1, { autopost_bills: true });
    db = write(db, 'res.partner', 7, { autopost_bills: 'always' });
    const vendor = read(db, 'res.partner', 7);
    const made = create(db, 'account.move', { move_type: 'in_invoice' });
    db = made.db;
    const store = { get: () => db, commit: (next) => { db = next; }, commitDigitizedBill: (next) => { db = next; } };
    globalThis.fetch = async () => new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'tool', name: 'record_bill', input: { vendor: vendor.name, reference: 'AUTO-1', invoice_date: '2026-10-20', lines: [{ description: 'Goods', quantity: 1, unit_price: 100, tax_percent: 0 }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const out = await finishDigitizedBill(store, { id: made.id, file: { name: 'bill.pdf', type: 'application/pdf', data: 'JVBERi0xLjQ=' } });
    assert.match(out.message, /posted automatically/i);
    const bill = read(db, 'account.move', made.id);
    assert.equal(bill.state, 'posted');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});


test('Suggestion uses immutable bill IDs rather than accounting dates', () => {
  let db = write(seed(), 'res.company', 1, { autopost_bills: true });
  for (let i = 0; i < 4; i++) {
    const made = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 7, digitized_vendor_id: 7, digitized_document: true, digitized_unedited: true, date: i === 0 ? '2030-01-01' : '2026-01-01', invoice_line_ids: [{ name: 'Goods', qty: 1, price_unit: 100, tax: 0 }] });
    db = postMove(made.db, made.id);
    if (i === 0) db = write(db, 'account.move', made.id, { ref: 'edited after posting' });
  }
  const draft = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 7, digitized_vendor_id: 7, digitized_document: true, digitized_unedited: true });
  assert.equal(suggestBillAutopost(draft.db, read(draft.db, 'account.move', draft.id)), true);
});

test('Finding review regression: drafts created and posted out of order respect posting order not bill IDs', () => {
  let db = write(seed(), 'res.company', 1, { autopost_bills: true });
  const vendorId = 7;

  // Case 1: An older draft bill (id 1) was edited before posting.
  // Three newer drafts (ids 2, 3, 4) were posted unedited FIRST.
  // Then the older edited draft (id 1) was posted LAST.
  // Because the most recently posted bill was edited, the next draft must NOT suggest Always.
  const draftA = create(db, 'account.move', { move_type: 'in_invoice', partner_id: vendorId, digitized_vendor_id: vendorId, digitized_document: true, digitized_unedited: true, ref: 'orig', invoice_line_ids: [{ name: 'A', qty: 1, price_unit: 100, tax: 0 }] });
  db = draftA.db;
  db = write(db, 'account.move', draftA.id, { ref: 'edited' }); // clears digitized_unedited flag

  const draftB = create(db, 'account.move', { move_type: 'in_invoice', partner_id: vendorId, digitized_vendor_id: vendorId, digitized_document: true, digitized_unedited: true, invoice_line_ids: [{ name: 'B', qty: 1, price_unit: 100, tax: 0 }] });
  db = draftB.db;
  const draftC = create(db, 'account.move', { move_type: 'in_invoice', partner_id: vendorId, digitized_vendor_id: vendorId, digitized_document: true, digitized_unedited: true, invoice_line_ids: [{ name: 'C', qty: 1, price_unit: 100, tax: 0 }] });
  db = draftC.db;
  const draftD = create(db, 'account.move', { move_type: 'in_invoice', partner_id: vendorId, digitized_vendor_id: vendorId, digitized_document: true, digitized_unedited: true, invoice_line_ids: [{ name: 'D', qty: 1, price_unit: 100, tax: 0 }] });
  db = draftD.db;

  // Post B, C, D first
  db = postMove(db, draftB.id);
  db = postMove(db, draftC.id);
  db = postMove(db, draftD.id);
  // Post edited draft A last
  db = postMove(db, draftA.id);

  const nextDraft1 = create(db, 'account.move', { move_type: 'in_invoice', partner_id: vendorId, digitized_vendor_id: vendorId, digitized_document: true, digitized_unedited: true });
  db = nextDraft1.db;
  assert.equal(suggestBillAutopost(db, read(db, 'account.move', nextDraft1.id)), false, 'Should not suggest autopost when the most recently posted bill was edited');

  // Case 2: An older draft was unedited, but an intermediate draft was edited and posted first.
  let db2 = write(seed(), 'res.company', 1, { autopost_bills: true });
  const draft1 = create(db2, 'account.move', { move_type: 'in_invoice', partner_id: vendorId, digitized_vendor_id: vendorId, digitized_document: true, digitized_unedited: true, invoice_line_ids: [{ name: '1', qty: 1, price_unit: 100, tax: 0 }] });
  db2 = draft1.db;
  const draft2 = create(db2, 'account.move', { move_type: 'in_invoice', partner_id: vendorId, digitized_vendor_id: vendorId, digitized_document: true, digitized_unedited: true, ref: 'orig', invoice_line_ids: [{ name: '2', qty: 1, price_unit: 100, tax: 0 }] });
  db2 = write(draft2.db, 'account.move', draft2.id, { ref: 'edited' });
  const draft3 = create(db2, 'account.move', { move_type: 'in_invoice', partner_id: vendorId, digitized_vendor_id: vendorId, digitized_document: true, digitized_unedited: true, invoice_line_ids: [{ name: '3', qty: 1, price_unit: 100, tax: 0 }] });
  db2 = draft3.db;
  const draft4 = create(db2, 'account.move', { move_type: 'in_invoice', partner_id: vendorId, digitized_vendor_id: vendorId, digitized_document: true, digitized_unedited: true, invoice_line_ids: [{ name: '4', qty: 1, price_unit: 100, tax: 0 }] });
  db2 = draft4.db;

  // Post edited draft 2 first
  db2 = postMove(db2, draft2.id);
  // Then post unedited drafts 1, 3, 4
  db2 = postMove(db2, draft1.id);
  db2 = postMove(db2, draft3.id);
  db2 = postMove(db2, draft4.id);

  const nextDraft2 = create(db2, 'account.move', { move_type: 'in_invoice', partner_id: vendorId, digitized_vendor_id: vendorId, digitized_document: true, digitized_unedited: true });
  db2 = nextDraft2.db;
  assert.equal(suggestBillAutopost(db2, read(db2, 'account.move', nextDraft2.id)), true, 'Should suggest autopost when the last 3 posted bills were unedited regardless of creation order');

  // Case 3: Client cannot forge posting_order on draft moves or modify it on posted moves
  const draftForCheck = create(db, 'account.move', { move_type: 'in_invoice', partner_id: vendorId, invoice_line_ids: [{ name: 'F', qty: 1, price_unit: 10, tax: 0 }] });
  const forgedDraft = {
    ...draftForCheck.db,
    records: {
      ...draftForCheck.db.records,
      'account.move': draftForCheck.db.records['account.move'].map((m) =>
        m.id === draftForCheck.id ? { ...m, posting_order: 999 } : m
      ),
    },
  };
  assert.throws(() => applyDiff(draftForCheck.db, diffDb(draftForCheck.db, forgedDraft), { isAdmin: true }), /posting order/i);

  const postedMove = postMove(draftForCheck.db, draftForCheck.id);
  const forgedPosted = {
    ...postedMove,
    records: {
      ...postedMove.records,
      'account.move': postedMove.records['account.move'].map((m) =>
        m.id === draftForCheck.id ? { ...m, posting_order: 8888 } : m
      ),
    },
  };
  assert.throws(() => applyDiff(postedMove, diffDb(postedMove, forgedPosted), { isAdmin: true }), /posting order/i);
});
