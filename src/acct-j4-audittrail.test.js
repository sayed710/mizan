import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, write, formatTrackingChange } from './orm.js';
import { seed } from './seed.js';
import { accountId } from './models/ledger.js';
import { collectAuditTrailRows, auditTrailToCsv } from './models/auditTrail.js';

const setup = () => {
  const db = seed();
  const cash = accountId(db, '101501');
  const sales = accountId(db, '400000');
  return { db, cash, sales };
};
const nameOf = (db, id) => db.records['account.account'].find((a) => a.id === id).name;

test('line add, remove and change are described per line by stable line_id', () => {
  const { db, cash, sales } = setup();
  const oldLines = [
    { line_id: 'a', account_id: cash, name: 'Cash', debit: 100, credit: 0 },
    { line_id: 'b', account_id: sales, name: 'Sale', debit: 0, credit: 100 },
  ];
  // Reordered: b first, a edited, new line c; position must not matter.
  const newLines = [
    { line_id: 'c', account_id: cash, name: 'Fee', debit: 5, credit: 0 },
    { line_id: 'b', account_id: sales, name: 'Sale', debit: 0, credit: 100 },
    { line_id: 'a', account_id: cash, name: 'Cash', debit: 150, credit: 0 },
  ];
  const r = formatTrackingChange(db, 'account.move', 'line_ids', oldLines, newLines);
  assert.match(r.body, /added \(.*Fee.*\)/);
  assert.match(r.body, /changed \[Cash\] Debit 100 → 150/);
  assert.ok(!r.body.includes('[Sale]'));
  assert.ok(!r.body.includes('[a]'));
  assert.ok(!r.body.includes('removed'));
  assert.ok(r.body.includes(nameOf(db, cash)));
  assert.notEqual(r.new_value, 'updated');
  const removed = formatTrackingChange(db, 'account.move', 'line_ids', oldLines, [oldLines[0]]);
  assert.match(removed.body, /removed \(.*Sale.*\)/);
  assert.deepEqual(formatTrackingChange(db, 'account.move', 'line_ids', oldLines, newLines), r);
});

test('account many2one change resolves display names', () => {
  const { db, cash, sales } = setup();
  const r = formatTrackingChange(db, 'account.move', 'line_ids',
    [{ line_id: 'a', account_id: cash, debit: 1 }], [{ line_id: 'a', account_id: sales, debit: 1 }]);
  assert.ok(r.body.includes(`${nameOf(db, cash)} → ${nameOf(db, sales)}`));
});

test('audit trail rows show line details and CSV exports them', () => {
  const { db, cash, sales } = setup();
  const oldLines = [{ line_id: 'a', account_id: cash, name: 'Cash', debit: 100, credit: 0 }];
  const newLines = [{ line_id: 'a', account_id: cash, name: 'Cash', debit: 200, credit: 0 }];
  const created = create(db, 'account.move', { move_type: 'entry', date: '2026-01-05', line_ids: [] });
  const log = [{ id: 'e1', model: 'account.move', res_id: created.id, action: 'write', actor: 'Admin', at: '2026-01-05T10:00:00Z', changes: { line_ids: [oldLines, newLines] } }];
  const rows = collectAuditTrailRows(created.db, created.db, null, log);
  assert.equal(rows.length, 1);
  assert.match(rows[0].body, /Debit 100 → 200/);
  assert.ok(!rows[0].newValue.startsWith('['));
  assert.match(auditTrailToCsv(rows), /Debit 200/);
  void sales;
});

test('scalar tracking output is unchanged', () => {
  const { db } = setup();
  assert.equal(formatTrackingChange(db, 'account.move', 'ref', 'x', 'y').body, 'Reference: x → y');
  assert.equal(formatTrackingChange(db, 'account.move', 'line_ids', [], [{ foo: 1 }]).new_value, 'updated');
});

test('matching by line_identity and id works when line_id is absent', () => {
  const { db, cash, sales } = setup();
  const oldLines = [
    { line_identity: 'lid-1', account_id: cash, name: 'Deposit', debit: 50, credit: 0 },
    { id: 99, account_id: sales, name: 'Revenue', debit: 0, credit: 50 },
  ];
  const newLines = [
    { id: 99, account_id: sales, name: 'Revenue', debit: 0, credit: 75 },
    { line_identity: 'lid-1', account_id: cash, name: 'Deposit', debit: 75, credit: 0 },
  ];
  const r = formatTrackingChange(db, 'account.move', 'line_ids', oldLines, newLines);
  assert.match(r.body, /changed \[Revenue\] Credit 50 → 75/);
  assert.match(r.body, /changed \[Deposit\] Debit 50 → 75/);
  assert.ok(!r.body.includes('added'));
  assert.ok(!r.body.includes('removed'));
});

test('invoice_line_ids tracks quantity, price, taxes and labels', () => {
  const { db, sales } = setup();
  const tax = db.records['account.tax'][0];
  const oldLines = [
    { line_id: 'invl-1', account_id: sales, name: 'Widget', qty: 2, price_unit: 100, tax_id: tax.id, tax_ids: [tax.id] },
  ];
  const newLines = [
    { line_id: 'invl-1', account_id: sales, name: 'Super Widget', qty: 3, price_unit: 120, tax_id: tax.id, tax_ids: [tax.id] },
  ];
  const r = formatTrackingChange(db, 'account.move', 'invoice_line_ids', oldLines, newLines);
  assert.match(r.body, /changed \[Widget\]/);
  assert.match(r.body, /Label Widget → Super Widget/);
  assert.match(r.body, /Quantity 2 → 3/);
  assert.match(r.body, /Price 100 → 120/);
  // Unchanged tax fields should not appear
  assert.ok(!r.body.includes('Tax'));
});

test('deterministic formatting: line order in input does not affect output', () => {
  const { db, cash, sales } = setup();
  const oldLines = [
    { line_id: 'l1', account_id: cash, name: 'A', debit: 10, credit: 0 },
    { line_id: 'l2', account_id: sales, name: 'B', debit: 0, credit: 10 },
    { line_id: 'l3', account_id: cash, name: 'C', debit: 20, credit: 0 },
  ];
  const newOrder1 = [
    { line_id: 'l3', account_id: cash, name: 'C', debit: 25, credit: 0 },
    { line_id: 'l1', account_id: cash, name: 'A', debit: 15, credit: 0 },
    { line_id: 'l4', account_id: sales, name: 'D', debit: 0, credit: 30 },
  ];
  const newOrder2 = [
    { line_id: 'l4', account_id: sales, name: 'D', debit: 0, credit: 30 },
    { line_id: 'l1', account_id: cash, name: 'A', debit: 15, credit: 0 },
    { line_id: 'l3', account_id: cash, name: 'C', debit: 25, credit: 0 },
  ];
  const r1 = formatTrackingChange(db, 'account.move', 'line_ids', oldLines, newOrder1);
  const r2 = formatTrackingChange(db, 'account.move', 'line_ids', oldLines, newOrder2);
  assert.deepEqual(r1, r2);
  assert.ok(r1.body.indexOf('added') < r1.body.indexOf('removed'));
  assert.ok(r1.body.indexOf('removed') < r1.body.indexOf('changed'));
});

test('anonymous lines match by signature and leftovers show as added/removed', () => {
  const { db, cash, sales } = setup();
  const oldLines = [
    { account_id: cash, name: 'Common', debit: 10, credit: 0 },
    { account_id: sales, name: 'Old Unique', debit: 0, credit: 10 },
  ];
  const newLines = [
    { account_id: sales, name: 'New Unique', debit: 0, credit: 20 },
    { account_id: cash, name: 'Common', debit: 10, credit: 0 },
  ];
  const r = formatTrackingChange(db, 'account.move', 'line_ids', oldLines, newLines);
  assert.match(r.body, /added \(.*New Unique.*\)/);
  assert.match(r.body, /removed \(.*Old Unique.*\)/);
  assert.ok(!r.body.includes('Common'));
});

test('local write with company audit_trail generates structured tracking message in audit trail', () => {
  const { db: seededDb, cash } = setup();
  let db = write(seededDb, 'res.company', 1, { audit_trail: true });
  const inv = create(db, 'account.move', {
    move_type: 'entry',
    company_id: 1,
    date: '2026-02-01',
    line_ids: [{ line_id: 'item-1', account_id: cash, name: 'Item 1', debit: 50, credit: 0 }],
  });
  db = inv.db;
  const updated = write(db, 'account.move', inv.id, {
    line_ids: [
      { line_id: 'item-1', account_id: cash, name: 'Item 1', debit: 150, credit: 0 },
      { line_id: 'item-2', account_id: cash, name: 'Item 2', debit: 25, credit: 0 },
    ],
  });
  const rows = collectAuditTrailRows(updated, updated, null, null);
  const moveRows = rows.filter((r) => r.res_id === inv.id && r.field === 'Journal Items');
  assert.equal(moveRows.length, 1);
  assert.match(moveRows[0].body, /changed \[Item 1\] Debit 50 → 150/);
  assert.match(moveRows[0].body, /added \(.*Item 2.*\)/);
  assert.match(moveRows[0].newValue, /Debit 150/);
  const csv = auditTrailToCsv(rows);
  assert.match(csv, /Debit 50 → 150/);
});
