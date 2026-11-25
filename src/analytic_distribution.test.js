import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { seed } from './seed.js';
import { search, create } from './orm.js';
import {
  distributionToRows,
  rowsToDistribution,
  distributionRowsError,
  planTotals,
} from './analytic_distribution.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const { DistributionInput, formatDistribution, FieldInput, display } = await import('./ui.jsx');

test('rows round-trip to the stored object in order', () => {
  const db = seed();
  const accounts = search(db, 'account.analytic.account');
  const office = accounts.find((a) => a.name === 'Office Projects');
  const cairo = accounts.find((a) => a.name === 'Cairo Branch');
  assert.ok(office && cairo, 'seed has analytic accounts');

  const dist1 = { [office.id]: 60, [cairo.id]: 40 };
  const rows1 = distributionToRows(dist1);
  assert.deepEqual(rows1, [
    { accountId: office.id, percent: 60 },
    { accountId: cairo.id, percent: 40 },
  ], 'rows are extracted in insertion order');

  const roundTripped1 = rowsToDistribution(rows1, db);
  assert.deepEqual(roundTripped1, dist1, 'round-trips to the original distribution object');
  assert.deepEqual(Object.keys(roundTripped1), [String(office.id), String(cairo.id)], 'key order is preserved');

  // Verify rows order matches the stored distribution
  const rowsCustom = [
    { accountId: office.id, percent: 35.5 },
    { accountId: cairo.id, percent: 64.5 },
  ];
  const roundTripped2 = rowsToDistribution(rowsCustom, db);
  assert.deepEqual(roundTripped2, { [office.id]: 35.5, [cairo.id]: 64.5 });
  const rowsExtracted = distributionToRows(roundTripped2);
  assert.deepEqual(rowsExtracted, rowsCustom);
});

test('plan totals per plan', () => {
  const db = seed();
  const accounts = search(db, 'account.analytic.account');
  const office = accounts.find((a) => a.name === 'Office Projects');
  const cairo = accounts.find((a) => a.name === 'Cairo Branch');

  // Office is plan:<Projects id>, Cairo is plan:<Regions id>
  const rows = [
    { accountId: office.id, percent: 60 },
    { accountId: cairo.id, percent: 40 },
  ];
  const totals = planTotals(rows, db);
  assert.equal(totals.length, 2);

  const officePlan = totals.find((p) => p.key === `plan:${office.plan_id}`);
  const cairoPlan = totals.find((p) => p.key === `plan:${cairo.plan_id}`);
  assert.ok(officePlan, 'has office plan');
  assert.ok(cairoPlan, 'has cairo plan');
  assert.equal(officePlan.total, 60);
  assert.equal(officePlan.over, false);
  assert.equal(cairoPlan.total, 40);
  assert.equal(cairoPlan.over, false);

  // Multiple accounts in explicit plan
  const planCreated = create(db, 'account.analytic.plan', { name: 'Engineering' });
  const engDb = planCreated.db;
  const engPlanId = planCreated.id;
  const accA = create(engDb, 'account.analytic.account', { name: 'Frontend', plan_id: engPlanId });
  const accB = create(accA.db, 'account.analytic.account', { name: 'Backend', plan_id: engPlanId });

  const engRows = [
    { accountId: accA.id, percent: 45 },
    { accountId: accB.id, percent: 35 },
  ];
  const engTotals = planTotals(engRows, accB.db);
  assert.equal(engTotals.length, 1);
  assert.equal(engTotals[0].key, `plan:${engPlanId}`);
  assert.equal(engTotals[0].account.plan_id, engPlanId);
  assert.equal(engTotals[0].total, 80);
  assert.equal(engTotals[0].over, false);
});

test('over-100% plan flagged with the canonical message', () => {
  const db = seed();
  const planCreated = create(db, 'account.analytic.plan', { name: 'Operations' });
  const opPlanId = planCreated.id;
  const acc1 = create(planCreated.db, 'account.analytic.account', { name: 'Site A', plan_id: opPlanId });
  const acc2 = create(acc1.db, 'account.analytic.account', { name: 'Site B', plan_id: opPlanId });
  const currentDb = acc2.db;

  const rows = [
    { accountId: acc1.id, percent: 60 },
    { accountId: acc2.id, percent: 50 },
  ];

  const totals = planTotals(rows, currentDb);
  assert.equal(totals.length, 1);
  assert.equal(totals[0].total, 110);
  assert.equal(totals[0].over, true);

  const error = distributionRowsError(rows, currentDb);
  assert.equal(error, 'Analytic distribution cannot exceed 100% per plan');

  const result = rowsToDistribution(rows, currentDb);
  assert.ok(Number.isNaN(result), 'over-100% returns NaN invalid marker');
});

test('removing the last row gives {}', () => {
  const db = seed();
  assert.deepEqual(rowsToDistribution([], db), {});
  assert.equal(distributionRowsError([], db), null);
  assert.deepEqual(planTotals([], db), []);
});

test('invalid rows produce the invalid marker', () => {
  const db = seed();
  const accounts = search(db, 'account.analytic.account');
  const office = accounts.find((a) => a.name === 'Office Projects');

  // Empty account
  assert.equal(distributionRowsError([{ accountId: '', percent: 50 }], db), 'Select a valid analytic account');
  assert.ok(Number.isNaN(rowsToDistribution([{ accountId: '', percent: 50 }], db)));

  assert.equal(distributionRowsError([{ accountId: null, percent: 50 }], db), 'Select a valid analytic account');
  assert.ok(Number.isNaN(rowsToDistribution([{ accountId: null, percent: 50 }], db)));

  // Negative percent
  assert.equal(distributionRowsError([{ accountId: office.id, percent: -10 }], db), 'Analytic percentages must be non-negative numbers');
  assert.ok(Number.isNaN(rowsToDistribution([{ accountId: office.id, percent: -10 }], db)));

  // Non-numeric percent
  assert.equal(distributionRowsError([{ accountId: office.id, percent: 'invalid' }], db), 'Analytic percentages must be non-negative numbers');
  assert.ok(Number.isNaN(rowsToDistribution([{ accountId: office.id, percent: 'invalid' }], db)));

  assert.equal(distributionRowsError([{ accountId: office.id, percent: NaN }], db), 'Analytic percentages must be non-negative numbers');
  assert.ok(Number.isNaN(rowsToDistribution([{ accountId: office.id, percent: NaN }], db)));

  // Duplicate accounts
  assert.equal(distributionRowsError([
    { accountId: office.id, percent: 50 },
    { accountId: office.id, percent: 30 },
  ], db), 'Select a valid analytic account');
  assert.ok(Number.isNaN(rowsToDistribution([
    { accountId: office.id, percent: 50 },
    { accountId: office.id, percent: 30 },
  ], db)));

  // Unknown account
  assert.equal(distributionRowsError([{ accountId: 999999, percent: 50 }], db), 'Analytic account not found');
  assert.ok(Number.isNaN(rowsToDistribution([{ accountId: 999999, percent: 50 }], db)));
});

test('canonical formatDistribution matches display() for readonly output', () => {
  const db = seed();
  const accounts = search(db, 'account.analytic.account');
  const office = accounts.find((a) => a.name === 'Office Projects');
  const cairo = accounts.find((a) => a.name === 'Cairo Branch');
  const field = { type: 'distribution', label: 'Analytic Distribution' };

  assert.equal(formatDistribution(db, null), '');
  assert.equal(formatDistribution(db, {}), '');
  assert.equal(formatDistribution(db, NaN), '');
  assert.equal(
    formatDistribution(db, { [office.id]: 60, [cairo.id]: 40 }),
    display(db, field, { [office.id]: 60, [cairo.id]: 40 }, office)
  );
  assert.equal(
    formatDistribution(db, { [office.id]: 60, [cairo.id]: 40 }),
    `${office.name} 60%, ${cairo.name} 40%`
  );
});

test('DistributionInput renders closed button with formatted text or muted placeholder', () => {
  const db = seed();
  const accounts = search(db, 'account.analytic.account');
  const office = accounts.find((a) => a.name === 'Office Projects');
  const cairo = accounts.find((a) => a.name === 'Cairo Branch');
  const field = { type: 'distribution', label: 'Analytic Distribution' };

  // Empty value renders placeholder
  const emptyHtml = renderToStaticMarkup(
    React.createElement(DistributionInput, {
      db,
      field,
      value: {},
      onChange: () => {},
      placeholder: 'Choose analytic...',
    })
  );
  assert.ok(emptyHtml.includes('distribution-trigger'), 'has trigger button');
  assert.ok(emptyHtml.includes('Choose analytic...'), 'displays custom placeholder');
  assert.ok(emptyHtml.includes('muted'), 'placeholder is muted');

  // Populated value renders formatted tag text
  const populatedHtml = renderToStaticMarkup(
    React.createElement(DistributionInput, {
      db,
      field,
      value: { [office.id]: 60, [cairo.id]: 40 },
      onChange: () => {},
    })
  );
  assert.ok(populatedHtml.includes(`${office.name} 60%, ${cairo.name} 40%`), 'displays formatted distribution');
  assert.ok(populatedHtml.includes('aria-haspopup="dialog"'), 'accessible popup attribute');
  assert.ok(populatedHtml.includes('aria-expanded="false"'), 'closed state marked false');
});

test('FieldInput renders DistributionInput for distribution field type', () => {
  const db = seed();
  const accounts = search(db, 'account.analytic.account');
  const office = accounts.find((a) => a.name === 'Office Projects');
  const field = { type: 'distribution', label: 'Analytic' };

  const html = renderToStaticMarkup(
    React.createElement(FieldInput, {
      db,
      field,
      fieldName: 'analytic_distribution',
      value: { [office.id]: 100 },
      onChange: () => {},
    })
  );
  assert.ok(html.includes('distribution-widget'), 'renders distribution widget');
  assert.ok(html.includes(`${office.name} 100%`), 'shows account percentage');
});


test('a new row defaults to what is left of its own plan, not of every plan', async () => {
  const { remainingInPlan } = await import('./analytic_distribution.js');
  const db = seed();
  const accounts = search(db, 'account.analytic.account');
  const office = accounts.find((a) => a.name === 'Office Projects');
  const cairo = accounts.find((a) => a.name === 'Cairo Branch');
  assert.notEqual(office.plan_id, cairo.plan_id, 'fixture accounts sit in different plans');
  const full = [{ accountId: office.id, percent: 100 }];
  assert.equal(remainingInPlan(full, cairo, db), 100, 'another plan is still empty');
  assert.equal(remainingInPlan([{ accountId: office.id, percent: 70 }], office, db), 30);
  assert.equal(remainingInPlan([{ accountId: office.id, percent: 120 }], office, db), 0);
});

test('a line with only a legacy analytic account shows and edits it as its 100% distribution', () => {
  const db = seed();
  const office = search(db, 'account.analytic.account').find((a) => a.name === 'Office Projects');
  const field = { type: 'distribution', label: 'Analytic' };
  const line = { analytic_account_id: office.id };
  assert.equal(display(db, field, undefined, line), `${office.name} 100%`);
  const html = renderToStaticMarkup(React.createElement(FieldInput, { db, field, value: undefined, record: line, onChange: () => {}, label: 'Analytic 1' }));
  assert.ok(html.includes(`${office.name} 100%`), 'the widget shows the legacy account');
  assert.ok(html.includes(`aria-label="Analytic 1: ${office.name} 100%"`), 'the accessible name carries the tags');
  const distributed = { analytic_account_id: office.id, analytic_distribution: {} };
  assert.equal(display(db, field, distributed.analytic_distribution, distributed), '', 'an explicit distribution wins over the legacy account');
});

test('migration skips secured moves so version-2 hash chains stay valid while migrating unsecured invoices and displaying derived allocation', async () => {
  const { read, write } = await import('./orm.js');
  const { postMove } = await import('./models/accounting.js');
  const { checkInalterability, computeMoveHash, secureEntries } = await import('./models/hash_chain.js');
  const { migrate } = await import('./migrations.js');
  const { applyDiff, diffDb } = await import('./sync.js');

  let db = seed();
  const office = search(db, 'account.analytic.account').find((a) => a.name === 'Office Projects');
  const partner = search(db, 'res.partner')[0];
  const product = search(db, 'product')[0];
  const { accountId } = await import('./models/ledger.js');
  const journalRes = create(db, 'account.journal', {
    name: 'Secure Sales',
    code: 'SECS',
    type: 'sale',
    company_id: 1,
    default_account_id: accountId(db, '400000'),
    invoice_sequence_prefix: 'SECS/',
    invoice_sequence_next_number: 1,
    restrict_mode_hash_table: false,
  });
  db = journalRes.db;
  const journalId = journalRes.id;

  // Create and post an invoice, then simulate a pre-distribution legacy line before version-2 securing.
  const securedDraft = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    journal_id: journalId,
    company_id: 1,
    date: '2026-01-10',
    invoice_date: '2026-01-10',
    invoice_line_ids: [{ product_id: product.id, name: 'Legacy Line', qty: 1, price_unit: 200, tax: 0, analytic_account_id: office.id }],
  });
  db = postMove(securedDraft.db, securedDraft.id);
  db = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].map((m) => (m.id === securedDraft.id ? {
        ...m,
        invoice_line_ids: m.invoice_line_ids.map(({ analytic_distribution: _drop, ...line }) => ({ ...line, analytic_account_id: office.id })),
      } : m)),
    },
  };
  db = write(db, 'account.journal', journalId, { restrict_mode_hash_table: true });
  const legacyMove = read(db, 'account.move', securedDraft.id);
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => m.id === legacyMove.id ? { ...m, inalterable_hash: computeMoveHash(m, '', 2), secure_sequence_number: 1, inalterable_hash_version: 2 } : m) } };
  db = secureEntries(db, { companyId: 1, hashDate: '2026-01-31' });
  const securedBefore = read(db, 'account.move', securedDraft.id);
  assert.equal(securedBefore.inalterable_hash_version, 2);
  assert.equal(Object.hasOwn(securedBefore.invoice_line_ids[0], 'analytic_distribution'), false);

  // Also add an unsecured draft invoice with a legacy analytic account.
  const draftRes = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    journal_id: journalId,
    company_id: 1,
    date: '2026-02-05',
    invoice_date: '2026-02-05',
    invoice_line_ids: [{ product_id: product.id, name: 'Draft Legacy', qty: 1, price_unit: 100, tax: 0, analytic_account_id: office.id }],
  });
  db = draftRes.db;
  db = {
    ...db,
    schema_version: 57,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].map((m) => (m.id === draftRes.id ? {
        ...m,
        invoice_line_ids: m.invoice_line_ids.map(({ analytic_distribution: _drop, ...line }) => ({ ...line, analytic_account_id: office.id })),
      } : m)),
    },
  };

  const migrated = migrate(db);
  assert.equal(migrated.schema_version, 79);
  assert.equal(migrate(migrated), migrated, 'migration is idempotent');

  // Unsecured invoice is migrated to 100% distribution.
  const migratedDraft = read(migrated, 'account.move', draftRes.id);
  assert.deepEqual(migratedDraft.invoice_line_ids[0].analytic_distribution, { [office.id]: 100 });

  // Secured invoice's hashed payload is untouched and its chain stays valid.
  const migratedSecured = read(migrated, 'account.move', securedDraft.id);
  assert.equal(Object.hasOwn(migratedSecured.invoice_line_ids[0], 'analytic_distribution'), false);
  assert.equal(migratedSecured.invoice_line_ids[0].analytic_account_id, office.id);
  const chainReport = checkInalterability(migrated, { journalId });
  assert.equal(chainReport.length, 1);
  assert.equal(chainReport[0].status, 'ok');
  assert.equal(chainReport[0].corrupted_move, null);

  // Extending the secured journal's chain after migration succeeds, including through diffDb + applyDiff.
  const nextPosted = postMove(write(migrated, 'account.move', draftRes.id, { state: 'draft' }), draftRes.id);
  const extended = secureEntries(nextPosted, { companyId: 1, hashDate: '2026-02-28' });
  const synced = applyDiff(nextPosted, diffDb(nextPosted, extended), { isAdmin: true });
  assert.equal(read(synced, 'account.move', draftRes.id).secure_sequence_number, 2);
  assert.equal(checkInalterability(synced, { journalId })[0].status, 'ok');

  // The skipped secured invoice line still shows its derived allocation in the editor.
  const field = { type: 'distribution', label: 'Analytic' };
  const securedLine = migratedSecured.invoice_line_ids[0];
  assert.equal(display(migrated, field, securedLine.analytic_distribution, securedLine), `${office.name} 100%`);
  const readonlyHtml = renderToStaticMarkup(React.createElement(FieldInput, {
    db: migrated, field, value: securedLine.analytic_distribution, record: securedLine, readonly: true, onChange: () => {}, label: 'Analytic 1',
  }));
  assert.ok(readonlyHtml.includes(`${office.name} 100%`));
});
