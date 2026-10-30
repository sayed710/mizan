import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apps, leavesOf, models } from './models/index.js';
import { create, read, search, unlink, write } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { journalAudit } from './models/journal_audit.js';
import { analyzeJournalChains, checkInalterability, computeMoveHash, secureEntries } from './models/hash_chain.js';
import { applyDiff, diffDb } from './sync.js';

test('public path: menus and views for secure entries, reports, and configuration models', () => {
  const accountingApp = apps.find((a) => a.id === 'accounting');
  assert.ok(accountingApp, 'accounting app exists');

  const leaves = leavesOf(accountingApp);

  // 1. Secure Entries wizard menu
  const secureEntriesLeaf = leaves.find((l) => l.key === 'secure-entries');
  assert.ok(secureEntriesLeaf, 'secure-entries menu exists');
  assert.equal(secureEntriesLeaf.model, 'account.secure.entries.wizard');
  assert.ok(models['account.secure.entries.wizard'], 'account.secure.entries.wizard model registered');
  assert.ok(models['account.secure.entries.wizard'].list, 'wizard has list view');
  assert.ok(models['account.secure.entries.wizard'].form, 'wizard has form view');

  // 2. Journal Audit and Inalterability reports
  const journalAuditLeaf = leaves.find((l) => l.key === 'journal-audit');
  assert.ok(journalAuditLeaf, 'journal-audit menu exists');
  assert.equal(journalAuditLeaf.type, 'report');
  assert.equal(journalAuditLeaf.report, 'journalAudit');

  const inalterabilityLeaf = leaves.find((l) => l.key === 'inalterability-check');
  assert.ok(inalterabilityLeaf, 'inalterability-check menu exists');
  assert.equal(inalterabilityLeaf.type, 'report');
  assert.equal(inalterabilityLeaf.report, 'inalterability');

  const reportsCode = readFileSync(new URL('./views/Reports.jsx', import.meta.url), 'utf8');
  assert.ok(reportsCode.includes("journalAudit: { title: 'Journal Audit'"), 'journalAudit registered in REPORTS');
  assert.ok(reportsCode.includes("inalterability: { title: 'Data Inalterability Check'"), 'inalterability registered in REPORTS');

  // 3. Configuration models
  const incotermLeaf = leaves.find((l) => l.key === 'incoterms');
  assert.ok(incotermLeaf, 'incoterms menu exists');
  assert.equal(incotermLeaf.model, 'account.incoterm');
  assert.ok(models['account.incoterm'], 'account.incoterm model registered');

  const taxUnitLeaf = leaves.find((l) => l.key === 'tax-units');
  assert.ok(taxUnitLeaf, 'tax-units menu exists');
  assert.equal(taxUnitLeaf.model, 'account.tax.unit');
  assert.ok(models['account.tax.unit'], 'account.tax.unit model registered');

  const tagLeaf = leaves.find((l) => l.key === 'account-tags');
  assert.ok(tagLeaf, 'account-tags menu exists');
  assert.equal(tagLeaf.model, 'account.account.tag');
  assert.ok(models['account.account.tag'], 'account.account.tag model registered');

  const depModelLeaf = leaves.find((l) => l.key === 'depreciation-models');
  assert.ok(depModelLeaf, 'depreciation-models menu exists');
  assert.equal(depModelLeaf.model, 'account.asset.model');
  assert.ok(models['account.asset.model'], 'account.asset.model model registered');
});

test('secure entries: hash chain computation, wizard analysis, sequence ordering, and lock date', () => {
  let db = seed();
  const companyId = 1;

  // Enable restrict_mode_hash_table on Customer Invoices journal
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  assert.ok(saleJournal, 'sale journal exists');
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].filter((m) => m.journal_id !== saleJournal.id) } };
  db = write(db, 'account.journal', saleJournal.id, { restrict_mode_hash_table: true });

  // Post 2 invoices
  const customer = search(db, 'res.partner')[0];
  const product = search(db, 'product')[0];

  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: customer.id,
    invoice_date: '2026-02-01',
    invoice_line_ids: [{ product_id: product.id, qty: 1, price_unit: 100 }],
  });
  db = postMove(inv1.db, inv1.id);

  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: customer.id,
    invoice_date: '2026-02-02',
    invoice_line_ids: [{ product_id: product.id, qty: 2, price_unit: 100 }],
  });
  db = postMove(inv2.db, inv2.id);

  // Create a draft invoice before hash date to test wizard warnings
  const draftInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    journal_id: saleJournal.id,
    partner_id: customer.id,
    invoice_date: '2026-02-01',
    invoice_line_ids: [{ product_id: product.id, qty: 1, price_unit: 50 }],
  });
  db = draftInv.db;

  // Analyze via wizard
  const analysis = analyzeJournalChains(db, { companyId, hashDate: '2026-02-15' });
  assert.ok(analysis.warnings.includes('draft entries found'), 'warns on draft entries');
  assert.ok(analysis.not_hashable_unlocked_move_ids.includes(draftInv.id), 'draft entry listed in not_hashable');
  assert.ok(analysis.move_to_hash_ids.includes(inv1.id), 'inv1 in move_to_hash_ids');
  assert.ok(analysis.move_to_hash_ids.includes(inv2.id), 'inv2 in move_to_hash_ids');

  // Remove draft to secure cleanly
  db = unlink(db, 'account.move', [draftInv.id]);

  // Secure entries up to 2026-02-15
  const securedDb = secureEntries(db, { companyId, hashDate: '2026-02-15' });

  const m1 = read(securedDb, 'account.move', inv1.id);
  const m2 = read(securedDb, 'account.move', inv2.id);

  assert.ok(m1.inalterable_hash, 'm1 has inalterable_hash');
  assert.equal(m1.secure_sequence_number, 1, 'm1 sequence number is 1');
  assert.ok(m2.inalterable_hash, 'm2 has inalterable_hash');
  assert.equal(m2.secure_sequence_number, 2, 'm2 sequence number is 2');

  // Verify hash chaining: m1 has no previous hash; m2 links to m1's hash
  const expectedHash1 = computeMoveHash(m1, '');
  assert.equal(m1.inalterable_hash, expectedHash1, 'm1 hash matches canonical SHA-256');

  const expectedHash2 = computeMoveHash(m2, m1.inalterable_hash);
  assert.equal(m2.inalterable_hash, expectedHash2, 'm2 hash chains from m1');

  // Verify hard lock date is updated
  const comp = read(securedDb, 'res.company', companyId);
  assert.equal(comp.hard_lock_date, '2026-02-02', 'company hard_lock_date updated');
});

test('secure entries immutability: write, reset to draft, unlink, and server diffs refused', () => {
  let db = seed();
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].filter((m) => m.journal_id !== saleJournal.id) } };
  db = write(db, 'account.journal', saleJournal.id, { restrict_mode_hash_table: true });

  const customer = search(db, 'res.partner')[0];
  const product = search(db, 'product')[0];

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: customer.id,
    invoice_date: '2026-02-01',
    invoice_line_ids: [{ product_id: product.id, qty: 1, price_unit: 100 }],
  });
  db = postMove(inv.db, inv.id);
  db = secureEntries(db, { companyId: 1, hashDate: '2026-02-15' });

  const securedMove = read(db, 'account.move', inv.id);
  assert.ok(securedMove.inalterable_hash);

  // 1. Refuse write to hashed fields (e.g. invoice_date, partner_id, line_ids)
  assert.throws(() => write(db, 'account.move', inv.id, { invoice_date: '2026-02-05' }), /secured|cannot be modified/i);
  assert.throws(() => write(db, 'account.move', inv.id, { partner_id: 2 }), /secured|cannot be modified/i);

  // 2. Refuse reset to draft
  assert.throws(() => write(db, 'account.move', inv.id, { state: 'draft' }), /secured|cannot be modified/i);

  // 3. Refuse unlink
  assert.throws(() => unlink(db, 'account.move', [inv.id]), /secured|cannot be deleted/i);

  // 4. Server diff (even for admin) refused
  const forgedDb = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].map((m) => (m.id === inv.id ? { ...m, invoice_date: '2026-02-10' } : m)),
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, forgedDb), { isAdmin: true }), /secured|cannot be modified/i);

  // Server delete refused even for admin
  assert.throws(() => applyDiff(db, { upserts: {}, deletes: { 'account.move': [inv.id] } }, { isAdmin: true }), /secured|cannot be deleted/i);
});

test('data inalterability report: detects tampering bypassing ORM', () => {
  let db = seed();
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].filter((m) => m.journal_id !== saleJournal.id) } };
  db = write(db, 'account.journal', saleJournal.id, { restrict_mode_hash_table: true });

  const customer = search(db, 'res.partner')[0];
  const product = search(db, 'product')[0];

  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: customer.id,
    invoice_date: '2026-02-01',
    invoice_line_ids: [{ product_id: product.id, qty: 1, price_unit: 100 }],
  });
  db = postMove(inv1.db, inv1.id);

  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: customer.id,
    invoice_date: '2026-02-02',
    invoice_line_ids: [{ product_id: product.id, qty: 2, price_unit: 100 }],
  });
  db = postMove(inv2.db, inv2.id);

  db = secureEntries(db, { companyId: 1, hashDate: '2026-02-15' });

  // Untampered report check
  const cleanReport = checkInalterability(db);
  const saleCheck = cleanReport.find((r) => r.journal_id === saleJournal.id);
  assert.ok(saleCheck, 'sale journal check exists');
  assert.equal(saleCheck.status, 'ok', 'status is ok on untampered data');
  assert.equal(saleCheck.first_move, read(db, 'account.move', inv1.id).name);
  assert.equal(saleCheck.last_move, read(db, 'account.move', inv2.id).name);

  // Directly tamper line amount in DB bypassing ORM
  const tamperedDb = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].map((m) => {
        if (m.id === inv1.id) {
          const lines = [...m.line_ids];
          lines[0] = { ...lines[0], debit: 999999 };
          return { ...m, line_ids: lines };
        }
        return m;
      }),
    },
  };

  // Re-run check on tampered DB
  const tamperedReport = checkInalterability(tamperedDb);
  const tamperedCheck = tamperedReport.find((r) => r.journal_id === saleJournal.id);
  assert.equal(tamperedCheck.status, 'corrupted', 'detects corrupted chain');
  assert.equal(tamperedCheck.corrupted_move.id, inv1.id, 'identifies first corrupted entry');
  assert.ok(tamperedCheck.message.includes(read(db, 'account.move', inv1.id).name), 'message names corrupted move');
});

test('journal audit report: lists posted items grouped by journal with totals and tax summary', () => {
  const db = seed();
  const rows = journalAudit(db, { from: '1900-01-01', to: '9999-12-31', companyId: 1 });
  assert.ok(rows.length);
  for (const row of rows) {
    assert.equal(row.debit, Math.round(row.items.reduce((sum, item) => sum + (Number(item.line.debit) || 0), 0) * 100) / 100);
    assert.equal(row.credit, Math.round(row.items.reduce((sum, item) => sum + (Number(item.line.credit) || 0), 0) * 100) / 100);
  }
  assert.ok(rows.some((row) => row.taxes.length));
  assert.deepEqual(journalAudit(db, { from: '1900-01-01', to: '1900-12-31', companyId: 1 }), []);
  assert.deepEqual(journalAudit(db, { companyId: 9999 }), []);
});

test('incoterms: seeded 11 Incoterms 2020, order to invoice flow, and print layout', () => {
  let db = seed();

  // 1. Verify 11 seeded Incoterms 2020
  const incoterms = search(db, 'account.incoterm');
  assert.equal(incoterms.length, 11, '11 incoterms seeded');
  const codes = new Set(incoterms.map((i) => i.code));
  ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'].forEach((c) => {
    assert.ok(codes.has(c), `incoterm ${c} exists`);
  });

  const fob = incoterms.find((i) => i.code === 'FOB');
  assert.ok(fob.active, 'FOB is active');
  assert.equal(models['account.incoterm'].fields.display_name.compute(fob), 'FOB - Free On Board');

  // 2. Sales order to invoice flow
  const customer = search(db, 'res.partner')[0];
  const product = search(db, 'product')[0];

  const so = create(db, 'sale.order', {
    partner_id: customer.id,
    incoterm_id: fob.id,
    incoterm_location: 'Alexandria Port',
    order_line: [{ product_id: product.id, qty: 1, price_unit: 100 }],
  });
  db = so.db;

  // Confirm SO
  const confirmBtn = models['sale.order'].form.buttons.find((b) => b.label === 'Confirm');
  db = confirmBtn.run(db, read(db, 'sale.order', so.id)).db;

  // Create Invoice button
  const invoiceBtn = models['sale.order'].form.buttons.find((b) => b.label === 'Create Invoice');
  const invRes = invoiceBtn.run(db, read(db, 'sale.order', so.id));
  db = invRes.db;

  const invoiceId = Number(invRes.go.split('/').pop());
  const invoice = read(db, 'account.move', invoiceId);
  assert.equal(invoice.incoterm_id, fob.id, 'invoice copies incoterm_id from sale order');
  assert.equal(invoice.incoterm_location, 'Alexandria Port', 'invoice copies incoterm_location from sale order');

  // 3. Purchase order to bill flow
  const serviceProduct = search(db, 'product').find((p) => p.type === 'service') ?? product;
  const po = create(db, 'purchase.order', {
    partner_id: customer.id,
    incoterm_id: fob.id,
    incoterm_location: 'Shanghai Port',
    order_line: [{ product_id: serviceProduct.id, qty: 2, price_unit: 50 }],
  });
  db = po.db;

  // Confirm PO
  const poConfirm = models['purchase.order'].form.buttons.find((b) => b.label === 'Confirm Order');
  db = poConfirm.run(db, read(db, 'purchase.order', po.id)).db;

  // Create Bill
  const billBtn = models['purchase.order'].form.buttons.find((b) => b.label === 'Create Bill');
  const billRes = billBtn.run(db, read(db, 'purchase.order', po.id));
  db = billRes.db;

  const billId = Number(billRes.go.split('/').pop());
  const bill = read(db, 'account.move', billId);
  assert.equal(bill.incoterm_id, fob.id, 'bill copies incoterm_id from purchase order');
  assert.equal(bill.incoterm_location, 'Shanghai Port', 'bill copies incoterm_location from purchase order');

  // 4. Print layout includes incoterm fields
  const printDocCode = readFileSync(new URL('./views/PrintDoc.jsx', import.meta.url), 'utf8');
  assert.ok(printDocCode.includes("'incoterm_id'"), 'print layout info has incoterm_id');
  assert.ok(printDocCode.includes("'incoterm_location'"), 'print layout info has incoterm_location');
});

test('tax units: validation requires >= 2 companies and main company inclusion', () => {
  let db = seed();
  db = create(db, 'res.company', { name: 'Second company' }).db;
  const taxUnitModel = models['account.tax.unit'];
  assert.ok(taxUnitModel);

  // Less than 2 companies fails
  const err1 = taxUnitModel.guard(db, null, { name: 'Unit 1', company_ids: [1], main_company_id: 1 });
  assert.match(err1, /at least 2 companies/i);

  // Main company not in company_ids fails
  const err2 = taxUnitModel.guard(db, null, { name: 'Unit 2', company_ids: [1, 2], main_company_id: 3 });
  assert.match(err2, /main company must be one of the tax unit companies/i);

  // Valid tax unit passes
  const valid = taxUnitModel.guard(db, null, { name: 'Valid Unit', company_ids: [1, 2], main_company_id: 1 });
  assert.equal(valid, null);

  const created = create(db, 'account.tax.unit', { name: 'GCC Unit', company_ids: [1, 2], main_company_id: 1, country: 'Egypt', vat: 'EG123456789' });
  assert.ok(created.id);
  assert.equal(read(created.db, 'account.tax.unit', created.id).name, 'GCC Unit');
});

test('account tags: applicability accounts on account.account, applicability taxes on account.tax', () => {
  let db = seed();

  // Create tag for accounts
  const accTag = create(db, 'account.account.tag', { name: 'Operating', applicability: 'accounts', color: 1 });
  db = accTag.db;

  // Create tag for taxes
  const taxTag = create(db, 'account.account.tag', { name: 'VAT Standard', applicability: 'taxes', color: 2 });
  db = taxTag.db;

  // Assign to account
  const account = search(db, 'account.account')[0];
  db = write(db, 'account.account', account.id, { tag_ids: [accTag.id] });
  assert.deepEqual(read(db, 'account.account', account.id).tag_ids, [accTag.id]);

  // Assign to tax
  const tax = search(db, 'account.tax')[0];
  db = write(db, 'account.tax', tax.id, { tag_ids: [taxTag.id] });
  assert.deepEqual(read(db, 'account.tax', tax.id).tag_ids, [taxTag.id]);
});

test('depreciation models: asset template and bill-to-asset automatic creation', () => {
  let db = seed();

  // Create depreciation model
  const fixedAccount = search(db, 'account.account').find((a) => a.account_type === 'asset_fixed');
  const depAccount = search(db, 'account.account').find((a) => a.code === '101401' || a.account_type === 'asset_non_current') ?? fixedAccount;
  const expAccount = search(db, 'account.account').find((a) => a.account_type === 'expense');
  const journal = search(db, 'account.journal')[0];

  const depModel = create(db, 'account.asset.model', {
    name: 'Computers 3Y Linear',
    method: 'linear',
    method_number: 3,
    method_period: '12',
    prorata: true,
    account_asset_id: fixedAccount.id,
    account_depreciation_id: depAccount.id,
    account_expense_id: expAccount.id,
    journal_id: journal.id,
  });
  db = depModel.db;

  // 1. Create asset directly from model
  const assetFromModel = create(db, 'account.asset', {
    name: 'Laptop Dell',
    model_id: depModel.id,
    original_value: 3000,
    acquisition_date: '2026-01-01',
  });
  db = assetFromModel.db;
  const loadedAsset = read(db, 'account.asset', assetFromModel.id);
  assert.equal(loadedAsset.model_id, depModel.id);

  // Test onchange on model_id
  const changed = models['account.asset'].onchange({ model_id: depModel.id }, 'model_id', db);
  assert.equal(changed.method, 'linear');
  assert.equal(changed.method_number, 3);
  assert.equal(changed.method_period, '12');
  assert.equal(changed.prorata, true);
  assert.equal(changed.account_depreciation_id, depAccount.id);
  assert.equal(changed.account_expense_id, expAccount.id);

  // 2. Set asset_model_id on fixed asset account
  db = write(db, 'account.account', fixedAccount.id, { asset_model_id: depModel.id });

  // 3. Post vendor bill with line on that account -> creates draft asset from model
  const vendor = search(db, 'res.partner').find((p) => p.tag_ids?.includes('Vendor')) ?? search(db, 'res.partner')[0];
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: vendor.id,
    invoice_date: '2026-03-01',
    invoice_line_ids: [{ name: 'Server Rack', account_id: fixedAccount.id, qty: 1, price_unit: 5000 }],
  });
  db = postMove(bill.db, bill.id);

  // Verify draft asset created from bill with model properties
  const createdAssets = search(db, 'account.asset').filter((a) => a.bill_id === bill.id);
  assert.equal(createdAssets.length, 1, 'draft asset created from bill line');
  const asset = createdAssets[0];
  assert.equal(asset.name, 'Server Rack');
  assert.equal(asset.original_value, 5000);
  assert.equal(asset.model_id, depModel.id);
  assert.equal(asset.method, 'linear');
  assert.equal(asset.method_number, 3);
  assert.equal(asset.method_period, '12');
  assert.equal(asset.prorata, true);
  assert.equal(asset.account_depreciation_id, depAccount.id);
  assert.equal(asset.account_expense_id, expAccount.id);
});

test('wizard-to-posting regression: confirmation is blocked while drafts exist on or before secured date, showing drafts with links to prevent stranding', async () => {
  const { FieldInput } = await import('./ui.jsx');
  let db = seed();
  const companyId = 1;

  // 1. Enable restrict_mode_hash_table on sales journal
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].filter((m) => m.journal_id !== saleJournal.id) } };
  db = write(db, 'account.journal', saleJournal.id, { restrict_mode_hash_table: true });

  const customer = search(db, 'res.partner')[0];
  const product = search(db, 'product')[0];

  // Post an invoice dated 2026-02-10
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    journal_id: saleJournal.id,
    partner_id: customer.id,
    invoice_date: '2026-02-10',
    invoice_line_ids: [{ product_id: product.id, qty: 1, price_unit: 100 }],
  });
  db = postMove(inv.db, inv.id);

  // Create a draft invoice dated 2026-02-05 (before the secured date)
  const draftInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    journal_id: saleJournal.id,
    partner_id: customer.id,
    invoice_date: '2026-02-05',
    invoice_line_ids: [{ product_id: product.id, qty: 1, price_unit: 50 }],
  });
  db = draftInv.db;

  // Analyze via wizard for 2026-02-15
  const wizModel = models['account.secure.entries.wizard'];
  const wizRecord = wizModel.createDefaults(db, { company: companyId, hash_date: '2026-02-15' });

  // Draft invoice is detected in not_hashable_unlocked_move_ids
  assert.ok(wizRecord.not_hashable_unlocked_move_ids.includes(draftInv.id));

  // The Confirm button must be BLOCKED while draft entries exist
  const confirmBtn = (wizModel.form?.buttons ?? []).find((b) => b.label === 'Confirm');
  assert.ok(confirmBtn, 'Confirm button exists');
  assert.equal(confirmBtn.when?.(wizRecord, db), false, 'confirmation is blocked (when returns false)');
  assert.throws(() => confirmBtn.run(db, wizRecord), /not available/i, 'run throws if called with draft entries present');
  assert.throws(() => secureEntries(db, { companyId, hashDate: '2026-02-15' }), /draft/i, 'secureEntries directly blocks with draft entries');

  // Drafts in wizard are shown with a link
  const draftField = wizModel.fields.not_hashable_unlocked_move_ids;
  const rendered = FieldInput({ db, field: draftField, value: wizRecord.not_hashable_unlocked_move_ids, readonly: true });
  const findLinks = (node) => {
    if (!node || typeof node !== 'object') return [];
    const links = [];
    if (node.type === 'a') links.push(node.props);
    const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children];
    for (const child of children) links.push(...findLinks(child));
    return links;
  };
  const links = findLinks(rendered);
  assert.ok(links.length > 0, 'draft entries rendered with link');
  assert.ok(links.some((l) => l.href === `#/open/account.move/${draftInv.id}`), 'link points to draft move');

  // If entries were secured prematurely, the company hard lock would advance to 2026-02-10,
  // stranding the draft invoice so it could never be posted!
  const prematurelyLockedDb = write(db, 'res.company', companyId, { hard_lock_date: '2026-02-10' });
  assert.throws(() => postMove(prematurelyLockedDb, draftInv.id), /locked/i, 'draft dated 2026-02-05 is stranded by hard lock 2026-02-10');

  // Resolution: User follows the link, posts the draft entry
  db = postMove(db, draftInv.id);

  // Now analysis shows no draft entries
  const unblockedWiz = wizModel.createDefaults(db, { company: companyId, hash_date: '2026-02-15' });
  assert.equal(unblockedWiz.not_hashable_unlocked_move_ids.length, 0);
  assert.equal(confirmBtn.when?.(unblockedWiz, db), true, 'confirmation is now unblocked');

  // Confirming secures both entries safely
  const result = confirmBtn.run(db, unblockedWiz);
  assert.ok(result.db, 'securing succeeded');
  const m1 = read(result.db, 'account.move', draftInv.id);
  const m2 = read(result.db, 'account.move', inv.id);
  assert.ok(m1.inalterable_hash, 'draft (now posted) is secured');
  assert.ok(m2.inalterable_hash, 'original entry is secured');
  assert.equal(read(result.db, 'res.company', companyId).hard_lock_date, '2026-02-10');
});

test('wizard-to-posting regression with the draft in an unrestricted journal', async () => {
  const { FieldInput } = await import('./ui.jsx');
  let db = seed();
  const companyId = 1;

  // 1. Enable restrict_mode_hash_table on sales journal
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].filter((m) => m.journal_id !== saleJournal.id) } };
  db = write(db, 'account.journal', saleJournal.id, { restrict_mode_hash_table: true });

  const generalJournal = search(db, 'account.journal').find((j) => j.type === 'general' && !j.restrict_mode_hash_table);
  assert.ok(generalJournal, 'unrestricted general journal exists');
  const accounts = search(db, 'account.account');

  const customer = search(db, 'res.partner')[0];
  const product = search(db, 'product')[0];

  // Post an invoice dated 2026-02-10 in restricted sales journal
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    journal_id: saleJournal.id,
    partner_id: customer.id,
    invoice_date: '2026-02-10',
    invoice_line_ids: [{ product_id: product.id, qty: 1, price_unit: 100 }],
  });
  db = postMove(inv.db, inv.id);

  // Create a draft entry in UNRESTRICTED general journal dated 2026-02-05 (on or before proposed lock date 2026-02-10)
  const draftEarly = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: generalJournal.id,
    date: '2026-02-05',
    invoice_date: '2026-02-05',
    line_ids: [
      { name: 'Debit', account_id: accounts[0].id, debit: 50, credit: 0 },
      { name: 'Credit', account_id: accounts[1].id, debit: 0, credit: 50 },
    ],
  });
  db = draftEarly.db;

  // Create another draft entry in UNRESTRICTED general journal dated 2026-02-15 (after proposed lock date 2026-02-10)
  const draftLater = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: generalJournal.id,
    date: '2026-02-15',
    invoice_date: '2026-02-15',
    line_ids: [
      { name: 'Debit', account_id: accounts[0].id, debit: 30, credit: 0 },
      { name: 'Credit', account_id: accounts[1].id, debit: 0, credit: 30 },
    ],
  });
  db = draftLater.db;

  // Analyze via wizard for 2026-02-20
  const wizModel = models['account.secure.entries.wizard'];
  const wizRecord = wizModel.createDefaults(db, { company: companyId, hash_date: '2026-02-20' });

  // Draft in unrestricted journal dated 2026-02-05 must be detected and listed in not_hashable_unlocked_move_ids
  assert.ok(wizRecord.not_hashable_unlocked_move_ids.includes(draftEarly.id), 'draft in unrestricted journal is listed');
  // Draft dated 2026-02-15 is after proposed hard-lock date (2026-02-10), so it is not listed
  assert.ok(!wizRecord.not_hashable_unlocked_move_ids.includes(draftLater.id), 'draft after proposed lock date is not listed');

  // Confirmation must be BLOCKED while draft entries exist on or before proposed lock date
  const confirmBtn = (wizModel.form?.buttons ?? []).find((b) => b.label === 'Confirm');
  assert.ok(confirmBtn, 'Confirm button exists');
  assert.equal(confirmBtn.when?.(wizRecord, db), false, 'confirmation is blocked');
  assert.throws(() => confirmBtn.run(db, wizRecord), /not available/i, 'confirm run throws with draft present in unrestricted journal');
  assert.throws(() => secureEntries(db, { companyId, hashDate: '2026-02-20' }), /draft/i, 'secureEntries directly blocks with draft in unrestricted journal');

  // Draft in unrestricted journal is shown with link in wizard
  const draftField = wizModel.fields.not_hashable_unlocked_move_ids;
  const rendered = FieldInput({ db, field: draftField, value: wizRecord.not_hashable_unlocked_move_ids, readonly: true });
  const findLinks = (node) => {
    if (!node || typeof node !== 'object') return [];
    const links = [];
    if (node.type === 'a') links.push(node.props);
    const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children];
    for (const child of children) links.push(...findLinks(child));
    return links;
  };
  const links = findLinks(rendered);
  assert.ok(links.length > 0, 'draft entries rendered with link');
  assert.ok(links.some((l) => l.href === `#/open/account.move/${draftEarly.id}`), 'link points to draft move in unrestricted journal');

  // Resolution: User resolves the Feb 5 draft by posting it
  db = postMove(db, draftEarly.id);

  // Now analysis shows no blocking draft entries
  const unblockedWiz = wizModel.createDefaults(db, { company: companyId, hash_date: '2026-02-20' });
  assert.equal(unblockedWiz.not_hashable_unlocked_move_ids.length, 0, 'no blocking drafts remain');
  assert.equal(confirmBtn.when?.(unblockedWiz, db), true, 'confirmation is now unblocked');

  // Confirming secures entries and sets company hard lock date to 2026-02-10
  const result = confirmBtn.run(db, unblockedWiz);
  assert.ok(result.db, 'securing succeeded');
  assert.equal(read(result.db, 'res.company', companyId).hard_lock_date, '2026-02-10');

  // Draft dated 2026-02-15 in unrestricted journal was not stranded and can still be posted
  const finalDb = postMove(result.db, draftLater.id);
  assert.equal(read(finalDb, 'account.move', draftLater.id).state, 'posted', 'Feb 15 draft in unrestricted journal posted successfully');
});
