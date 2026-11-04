import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { fiscalPositionFor } from './models/taxes.js';

test('invoice and bill use their selected journal default account', () => {
  let db = seed();
  for (const [type, journalType, code] of [['out_invoice', 'sale', '410000'], ['in_invoice', 'purchase', '610000']]) {
    const journal = search(db, 'account.journal').find(j => j.type === journalType);
    const account = search(db, 'account.account').find(a => a.code === code);
    db = write(db, 'account.journal', journal.id, { default_account_id: account.id });
    const move = create(db, 'account.move', { move_type: type, partner_id: 1, journal_id: journal.id, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: 10, tax: 0 }] });
    db = postMove(move.db, move.id);
    assert.ok(read(db, 'account.move', move.id).line_ids.some(l => l.account_id === account.id));
  }
});

test('automatic fiscal position can require a VAT number', () => {
  let db = seed();
  const vat = create(db, 'account.fiscal.position', { name: 'VAT', country: 'Testland', auto_apply: true, vat_required: true, sequence: 1 }); db = vat.db;
  const plain = create(db, 'account.fiscal.position', { name: 'No VAT requirement', country: 'Testland', auto_apply: true, sequence: 2 }); db = plain.db;
  const a = create(db, 'res.partner', { name: 'Registered', country: 'Testland', vat: '123' }); db = a.db;
  const b = create(db, 'res.partner', { name: 'Unregistered', country: 'Testland', vat: '  ' }); db = b.db;
  assert.equal(fiscalPositionFor(db, a.id), vat.id);
  assert.equal(fiscalPositionFor(db, b.id), plain.id);
});

test('two sales journals number independently', () => {
  let db = seed();
  const journal1 = search(db, 'account.journal').find(j => j.code === 'INV');
  const account = search(db, 'account.account').find(a => a.code === '400000');
  const createdJ2 = create(db, 'account.journal', { name: 'Second Sales Journal', code: 'SJ2', type: 'sale', company_id: 1, default_account_id: account.id });
  db = createdJ2.db;
  const journal2 = read(db, 'account.journal', createdJ2.id);

  const inv1 = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, journal_id: journal1.id, invoice_date: '2026-02-01', invoice_line_ids: [{ qty: 1, price_unit: 10, tax: 0 }] });
  db = postMove(inv1.db, inv1.id);
  const name1 = read(db, 'account.move', inv1.id).name;

  const inv2 = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, journal_id: journal2.id, invoice_date: '2026-02-01', invoice_line_ids: [{ qty: 1, price_unit: 20, tax: 0 }] });
  db = postMove(inv2.db, inv2.id);
  const name2 = read(db, 'account.move', inv2.id).name;

  const inv3 = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, journal_id: journal1.id, invoice_date: '2026-02-01', invoice_line_ids: [{ qty: 1, price_unit: 30, tax: 0 }] });
  db = postMove(inv3.db, inv3.id);
  const name3 = read(db, 'account.move', inv3.id).name;

  assert.match(name1, /^INV\/2026\/\d+$/);
  assert.equal(name2, 'SJ2/2026/00001');
  const num1 = Number(name1.slice(-5));
  const num3 = Number(name3.slice(-5));
  assert.equal(num3, num1 + 1);
});

test('posting an invoice line without an account raises an error if journal has no default account', () => {
  let db = seed();
  const j = create(db, 'account.journal', { name: 'No Default Sale', code: 'NDS', type: 'sale', company_id: 1, default_account_id: null });
  db = j.db;
  const move = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, journal_id: j.id, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: 10, tax: 0 }] });
  assert.throws(() => postMove(move.db, move.id), /no default account/i);
});
