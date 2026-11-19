import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write, formatTrackingChange } from './orm.js';
import { applyDiff, diffDb } from './sync.js';
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

test('invoice lines are matched by their declared line_id, never by position', () => {
  const { db, sales } = setup();
  const oldLines = [
    { line_id: 'a', account_id: sales, name: 'Desk', qty: 1, price_unit: 100 },
    { line_id: 'b', account_id: sales, name: 'Chair', qty: 2, price_unit: 50 },
  ];
  // Reordered: b first, a edited, new line c; position must not matter.
  const newLines = [
    { line_id: 'c', account_id: sales, name: 'Lamp', qty: 1, price_unit: 5 },
    { line_id: 'b', account_id: sales, name: 'Chair', qty: 2, price_unit: 50 },
    { line_id: 'a', account_id: sales, name: 'Desk', qty: 1, price_unit: 150 },
  ];
  const r = formatTrackingChange(db, 'account.move', 'invoice_line_ids', oldLines, newLines);
  assert.match(r.body, /added \(.*Lamp.*\)/);
  assert.match(r.body, /changed \[Desk\] Unit Price 100 → 150/);
  assert.ok(!r.body.includes('[Chair]'));
  assert.ok(!r.body.includes('[a]'));
  assert.ok(!r.body.includes('removed'));
  assert.notEqual(r.new_value, 'updated');
  const removed = formatTrackingChange(db, 'account.move', 'invoice_line_ids', oldLines, [oldLines[0]]);
  assert.match(removed.body, /removed \(.*Chair.*\)/);
  assert.deepEqual(formatTrackingChange(db, 'account.move', 'invoice_line_ids', oldLines, newLines), r);
});

test('account many2one change resolves display names', () => {
  const { db, cash, sales } = setup();
  const r = formatTrackingChange(db, 'account.move', 'invoice_line_ids',
    [{ line_id: 'a', account_id: cash, qty: 1 }], [{ line_id: 'a', account_id: sales, qty: 1 }]);
  assert.ok(r.body.includes(`${nameOf(db, cash)} → ${nameOf(db, sales)}`));
});

test('audit trail rows show line details and CSV exports them', () => {
  const { db, cash, sales } = setup();
  const oldLines = [{ line_id: 'a', account_id: sales, name: 'Desk', qty: 1, price_unit: 100 }];
  const newLines = [{ line_id: 'a', account_id: sales, name: 'Desk', qty: 1, price_unit: 200 }];
  const created = create(db, 'account.move', { move_type: 'entry', date: '2026-01-05', line_ids: [] });
  const log = [{ id: 'e1', model: 'account.move', res_id: created.id, action: 'write', actor: 'Admin', at: '2026-01-05T10:00:00Z', changes: { invoice_line_ids: [oldLines, newLines] } }];
  const rows = collectAuditTrailRows(created.db, created.db, null, log);
  assert.equal(rows.length, 1);
  assert.match(rows[0].body, /Unit Price 100 → 200/);
  assert.match(auditTrailToCsv(rows), /Unit Price 200/);
  void cash;
});

test('scalar tracking output is unchanged', () => {
  const { db } = setup();
  assert.equal(formatTrackingChange(db, 'account.move', 'ref', 'x', 'y').body, 'Reference: x → y');
  assert.equal(formatTrackingChange(db, 'account.move', 'line_ids', [], [{ foo: 1 }]).new_value, 'updated');
});

test('identities the line schema does not declare are ignored, so journal items match by value', () => {
  const { db, cash, sales } = setup();
  // The server drops undeclared fields, so client and server must describe journal items the same way.
  const oldLines = [
    { line_identity: 'lid-1', account_id: cash, name: 'Deposit', debit: 50, credit: 0 },
    { id: 99, account_id: sales, name: 'Revenue', debit: 0, credit: 50 },
  ];
  const newLines = [
    { id: 99, account_id: sales, name: 'Revenue', debit: 0, credit: 50 },
    { line_identity: 'other', account_id: cash, name: 'Deposit', debit: 75, credit: 0 },
  ];
  const r = formatTrackingChange(db, 'account.move', 'line_ids', oldLines, newLines);
  const { line_identity: _a, ...plainOld } = oldLines[0];
  const { line_identity: _b, ...plainNew } = newLines[1];
  assert.deepEqual(r, formatTrackingChange(db, 'account.move', 'line_ids', [plainOld, oldLines[1]], [newLines[0], plainNew]));
  assert.match(r.body, /removed \(.*Debit 50.*\)/);
  assert.match(r.body, /added \(.*Debit 75.*\)/);
  assert.ok(!r.body.includes('Revenue'));
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
    { line_id: 'l1', account_id: cash, name: 'A', qty: 10 },
    { line_id: 'l2', account_id: sales, name: 'B', qty: 10 },
    { line_id: 'l3', account_id: cash, name: 'C', qty: 20 },
  ];
  const newOrder1 = [
    { line_id: 'l3', account_id: cash, name: 'C', qty: 25 },
    { line_id: 'l1', account_id: cash, name: 'A', qty: 15 },
    { line_id: 'l4', account_id: sales, name: 'D', qty: 30 },
  ];
  const newOrder2 = [
    { line_id: 'l4', account_id: sales, name: 'D', qty: 30 },
    { line_id: 'l1', account_id: cash, name: 'A', qty: 15 },
    { line_id: 'l3', account_id: cash, name: 'C', qty: 25 },
  ];
  const r1 = formatTrackingChange(db, 'account.move', 'invoice_line_ids', oldLines, newOrder1);
  const r2 = formatTrackingChange(db, 'account.move', 'invoice_line_ids', oldLines, newOrder2);
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
  // Journal items have no declared identity, so an edited item reads as removed and added.
  assert.match(moveRows[0].body, /removed \(.*Item 1.*Debit 50.*\)/);
  assert.match(moveRows[0].body, /added \(.*Item 1.*Debit 150.*\)/);
  assert.match(moveRows[0].body, /added \(.*Item 2.*\)/);
  assert.match(moveRows[0].newValue, /Debit 150/);
  assert.match(auditTrailToCsv(rows), /Debit 150/);
});

test('cleared taxes and fields outside the old display list are described', () => {
  const { db, sales } = setup();
  const tax = db.records['account.tax'][0];
  const cleared = formatTrackingChange(db, 'account.move', 'invoice_line_ids',
    [{ line_id: 'a', account_id: sales, name: 'Desk', tax_ids: [tax.id] }], [{ line_id: 'a', account_id: sales, name: 'Desk', tax_ids: [] }]);
  assert.match(cleared.body, new RegExp(`Taxes ${tax.name} → —`));
  const partner = db.records['res.partner'][0];
  const moved = formatTrackingChange(db, 'account.move', 'line_ids',
    [{ account_id: sales, name: 'X', debit: 5, credit: 0 }], [{ account_id: sales, name: 'X', debit: 5, credit: 0, partner_id: partner.id }]);
  assert.ok(moved.body.includes(`Partner ${partner.name}`));
});

test('a synced journal item edit keeps its audit field and old/new values, even with client-only line ids', () => {
  const { db: base, cash, sales } = setup();
  const db = write(base, 'res.company', 1, { audit_trail: true });
  const move = create(db, 'account.move', { move_type: 'entry', company_id: 1, date: '2026-02-01', line_ids: [{ account_id: cash, name: 'A', debit: 50, credit: 0 }, { account_id: sales, name: 'A', debit: 0, credit: 50 }] });
  const server = applyDiff(db, diffDb(db, move.db), { isAdmin: true });
  const stored = read(server, 'account.move', move.id);
  const edited = write(server, 'account.move', move.id, { line_ids: stored.line_ids.map((l, i) => ({ ...l, line_id: `client-${i}`, debit: l.debit ? 80 : 0, credit: l.credit ? 80 : 0 })) });
  const after = applyDiff(server, diffDb(server, edited), { isAdmin: true });
  const msg = (after.messages ?? []).filter((m) => m.model === 'account.move' && m.res_id === move.id && m.field === 'line_ids').at(-1);
  assert.ok(msg, 'the tracking message keeps its field');
  assert.match(msg.old_value, /Debit 50/);
  assert.match(msg.new_value, /Debit 80/);
});
