import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seed } from './seed.js';
import { read, search, write } from './orm.js';
import { applyDiff, diffDb } from './sync.js';
import { createUploadedMoves, uploadMoves } from './views/uploadMoves.js';
import { finishDigitizedBill } from '../server/integrations.js';
import { applyDigitizedBill } from '../server/digitized-store.js';

const file = (name) => ({ name, type: 'application/pdf', size: 1, data: 'data:application/pdf;base64,AA==' });
const options = { moveType: 'in_invoice', companyId: 1 };

test('each uploaded bill is a draft in the purchase journal with a linked file and passes diff guards', () => {
  const db = seed();
  const result = createUploadedMoves(db, [file('one.pdf'), file('two.pdf')], options);
  const saved = applyDiff(db, diffDb(db, result.db), { isAdmin: true });
  const journal = read(db, 'res.company', 1).default_purchase_journal_id;
  assert.equal(result.ids.length, 2);
  for (const [i, id] of result.ids.entries()) {
    const move = read(saved, 'account.move', id);
    assert.equal(move.move_type, 'in_invoice'); assert.equal(move.state, 'draft'); assert.equal(move.journal_id, journal);
    const doc = search(saved, 'documents.document').find((d) => d.res_model === 'account.move' && d.res_id === id);
    assert.equal(doc.file.name, ['one.pdf', 'two.pdf'][i]);
  }
});

test('sales journal card creates an invoice in its journal', () => {
  const db = seed();
  const journal = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id ?? 1) === 1);
  const result = createUploadedMoves(db, [file('invoice.pdf')], { moveType: 'out_invoice', companyId: 1, journalId: journal.id });
  const invoice = read(result.db, 'account.move', result.ids[0]);
  assert.equal(invoice.journal_id, journal.id); assert.equal(invoice.move_type, 'out_invoice'); assert.equal(invoice.state, 'draft');
});

test('without AI several files create drafts and navigate to selected ids, without digitization', async () => {
  let db = seed(); let calls = 0;
  const result = await uploadMoves([file('a.pdf'), file('b.pdf')], options, { getDb: () => db, commit: async (next) => { db = next; return { ok: true }; }, ai: false, digitize: async () => { calls++; } });
  assert.equal(calls, 0); assert.equal(result.ids.length, 2);
  assert.equal(result.go, `#/accounting/bills?view=list&rel=id:${result.ids.join(',')}`);
  assert.ok(result.ids.every((id) => read(db, 'account.move', id).state === 'draft'));
});

test('AI fills uploaded bill without posting and single file navigates to form', async () => {
  let db = seed(); let base; const oldFetch = globalThis.fetch; const oldKey = process.env.ANTHROPIC_API_KEY;
  const vendor = search(db, 'res.partner')[0];
  db = write(write(db, 'res.company', 1, { autopost_bills: true }), 'res.partner', vendor.id, { autopost_bills: 'always' });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  globalThis.fetch = async () => new Response(JSON.stringify({ content: [{ type: 'tool_use', input: { vendor: vendor.name, lines: [] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const store = { get: () => { base = db; return db; }, commit: (next) => { db = next; }, commitDigitizedBill: (next, id) => { db = applyDigitizedBill(db, base, next, id, { isAdmin: true }); } };
  try {
    const result = await uploadMoves([file('a.pdf')], options, { getDb: () => db, commit: async (next) => { db = next; return { ok: true }; }, ai: true, digitize: (input) => finishDigitizedBill(store, input) });
    assert.deepEqual(result.errors, []); assert.equal(result.go, `#/accounting/bills/${result.ids[0]}`);
    assert.equal(read(db, 'account.move', result.ids[0]).state, 'draft'); assert.equal(read(db, 'account.move', result.ids[0]).digitized_document, true);
  } finally { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldKey; }
});

test('Arabic upload labels are present in UTF-8', () => {
  const source = readFileSync(new URL('./i18n.js', import.meta.url), 'utf8');
  assert.match(source, /'Upload': 'رفع'/); assert.match(source, /'Could not read file': 'تعذرت قراءة الملف'/);
});

test('remapped ids are used for digitization and navigation; invoices do not call digitization', async () => {
  let db = seed(); let calls = 0;
  const save = async (next) => { db = next; const id = next.seq['account.move']; return { ok: true, remapped: { 'account.move': { [id]: 999 } } }; };
  const bill = await uploadMoves([file('bill.pdf')], options, { getDb: () => db, commit: save, ai: true, digitize: async ({ id, draft_only }) => { calls++; assert.equal(id, 999); assert.equal(draft_only, true); } });
  assert.equal(bill.go, '#/accounting/bills/999');
  const invoice = await uploadMoves([file('invoice.pdf')], { moveType: 'out_invoice', companyId: 1 }, { getDb: () => db, commit: save, ai: true, digitize: async () => { calls++; } });
  assert.equal(invoice.go, '#/accounting/invoices/999'); assert.equal(calls, 1);
});
