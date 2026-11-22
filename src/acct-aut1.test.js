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
  assert.throws(() => applyDiff(db, diffDb(db, forged), { isAdmin: true }), /digitized/i);
  const posted = postMove(db, made.id);
  const fakePost = { ...posted, records: { ...posted.records, 'account.move': posted.records['account.move'].map((m) => m.id === made.id ? { ...m, ref: 'forged' } : m) } };
  assert.throws(() => applyDiff(db, diffDb(db, fakePost), { isAdmin: true }), /digitized/i);
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
  db = applyDiff(db, diffDb(db, edited), { isAdmin: true });
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
      const store = { get: () => db, commit: (next) => { db = applyDiff(db, diffDb(db, next), { isAdmin: true }); snapshots.push(db); } };
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
      const store = { get: () => db, commit: (next) => { db = applyDiff(db, diffDb(db, next), { isAdmin: true }); } };
      let call = 0;
      globalThis.fetch = async () => new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'tool', name: 'record_bill', input: { vendor: vendor.name, reference: `OCR-${++call}`, invoice_date: '2026-10-20', lines: [{ description: 'Goods', quantity: 1, unit_price: 100, tax_percent: 0 }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      for (const step of steps) {
        if (step === 'digitize') await finishDigitizedBill(store, { id: made.id, file: { name: 'bill.pdf', type: 'application/pdf', data: 'JVBERi0xLjQ=' } });
        else store.commit(write(db, 'account.move', made.id, { ref: 'user edit' }));
        assert.equal(read(db, 'account.move', made.id).digitized_unedited, step === 'digitize', steps.join(', '));
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
