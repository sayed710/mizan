import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { create, search, write } from './orm.js';
import { seed } from './seed.js';
import { createDigitizedBill } from '../server/integrations.js';
import { applyDigitizedBill } from '../server/digitized-store.js';

test('models dropdown uses the positioned navigation group', () => {
  const view = readFileSync(new URL('./views/BankReconcile.jsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./views.css', import.meta.url), 'utf8');
  assert.match(view, /className="nav-group actions-menu" ref=\{modelsMenuRef\}/);
  assert.match(css, /\.nav-group\s*\{\s*position:\s*relative/);
});

test('legacy model links still obey company membership when assigning a company', () => {
  const db = seed();
  const journal = search(db, 'account.journal').find((j) => j.company_id === 1 && j.type === 'bank');
  const partner = search(db, 'res.partner').find((p) => p.id);
  const legacy = create(db, 'account.reconcile.model', { name: 'Legacy', company_id: 1 });
  const base = { ...legacy.db, records: { ...legacy.db.records, 'account.reconcile.model': legacy.db.records['account.reconcile.model'].map((r) => r.id === legacy.id ? { ...r, company_id: null, match_journal_ids: [journal.id], match_partner_ids: [partner.id] } : r), 'res.partner': legacy.db.records['res.partner'].map((p) => p.id === partner.id ? { ...p, company_id: 1 } : p) } };
  assert.throws(() => write(base, 'account.reconcile.model', legacy.id, { company_id: 2 }), /Journals.*company/);
  const withoutJournal = { ...base, records: { ...base.records, 'account.reconcile.model': base.records['account.reconcile.model'].map((r) => r.id === legacy.id ? { ...r, match_journal_ids: [] } : r) } };
  assert.throws(() => write(withoutJournal, 'account.reconcile.model', legacy.id, { company_id: 2 }), /Partners.*company/);
});

test('new digitized bill is created atomically after reading against the latest database', async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  let db = seed();
  let base;
  const store = { get: () => { base = db; return db; }, commit: (next) => { db = next; }, commitDigitizedBill: (next, id) => { db = applyDigitizedBill(db, base, next, id, { isAdmin: true }); } };
  const original = search(db, 'account.move').length;
  try {
    await assert.rejects(createDigitizedBill(store, { company_id: 1, file: { type: 'bad', data: 'AA' } }), /Upload a PDF/);
    assert.equal(search(db, 'account.move').length, original);
    globalThis.fetch = async () => {
      const other = create(db, 'account.move', { move_type: 'in_invoice', ref: 'Other user' });
      db = other.db;
      return new Response(JSON.stringify({ content: [{ type: 'tool_use', input: { vendor: 'New Vendor', reference: 'OCR', invoice_date: '2026-10-20', lines: [] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await createDigitizedBill(store, { company_id: 1, file: { type: 'application/pdf', data: 'AA', name: 'bill.pdf' } });
    assert.equal(search(db, 'account.move').length, original + 2);
    assert.notEqual(search(db, 'account.move').find((m) => m.ref === 'Other user').digitized_document, true);
    assert.equal(search(db, 'account.move').find((m) => m.ref === 'OCR').digitized_document, true);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldKey;
  }
});
