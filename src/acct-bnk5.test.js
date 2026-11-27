import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { applyFilters, create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { eligibleBatches, matchPayment } from './models/bank.js';
import { accountId, isPaymentMatched } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { postBatch } from './models/payments.js';
import { autoReconcile, isWriteoffButtonModel, ruleMatches } from './models/reconcile.js';
import { runScheduledJobs } from './models/scheduler.js';
import { applyDiff, diffDb } from './sync.js';
import { find, setupDom } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

async function mountBankReconcile(initialDb) {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { BankReconcile } = await import('./views/BankReconcile.jsx');
  await initStore();
  await commit(initialDb);
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => root.render(React.createElement(BankReconcile)));
  return {
    React,
    host,
    getDb,
    done: async () => {
      await React.act(async () => root.unmount());
    },
  };
}

test('BNK5-1: workspace exposes Set Account, Sales/Purchases shortcuts, Batches matching, Upload bills, and ellipsis Manage Models', async () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const partners = search(db, 'res.partner');
  const partner = partners[0];

  // Create two posted customer invoices and an inbound posted batch payment covering both
  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    company_id: 1,
    invoice_date: '2026-07-01',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 120, tax: 0 }],
  });
  db = postMove(inv1.db, inv1.id);
  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    company_id: 1,
    invoice_date: '2026-07-02',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 80, tax: 0 }],
  });
  db = postMove(inv2.db, inv2.id);

  const inboundBatchRes = create(db, 'account.batch.payment', {
    name: 'BATCH/IN/001',
    batch_type: 'inbound',
    date: '2026-07-05',
    journal_id: bankJournal.id,
    lines: [
      { move_id: inv1.id, amount: 120 },
      { move_id: inv2.id, amount: 80 },
    ],
  });
  db = postBatch(inboundBatchRes.db, read(inboundBatchRes.db, 'account.batch.payment', inboundBatchRes.id));

  // Draft and outbound batches must be excluded from eligibleBatches for an inbound line
  const draftBatchRes = create(db, 'account.batch.payment', {
    name: 'BATCH/DRAFT/001',
    batch_type: 'inbound',
    date: '2026-07-05',
    journal_id: bankJournal.id,
    lines: [],
  });
  db = draftBatchRes.db;

  const billRes = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    company_id: 1,
    invoice_date: '2026-07-01',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 50, tax: 0 }],
  });
  db = postMove(billRes.db, billRes.id);
  const outboundBatchRes = create(db, 'account.batch.payment', {
    name: 'BATCH/OUT/001',
    batch_type: 'outbound',
    date: '2026-07-05',
    journal_id: bankJournal.id,
    lines: [{ move_id: billRes.id, amount: 50 }],
  });
  db = postBatch(outboundBatchRes.db, read(outboundBatchRes.db, 'account.batch.payment', outboundBatchRes.id));

  const lineRes = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    company_id: 1,
    partner_id: partner.id,
    date: '2026-07-06',
    payment_ref: 'Inbound batch 200',
    amount: 200,
    state: 'to_check',
  });
  db = lineRes.db;
  const stLine = read(db, 'account.bank.statement.line', lineRes.id);

  // Guard check via write and diffDb + applyDiff: unposted batch cannot be linked
  assert.throws(
    () => write(db, 'account.bank.statement.line', lineRes.id, { batch_payment_id: draftBatchRes.id }),
    /Select a posted batch payment/,
  );
  const forgedDraftBatchLine = {
    ...db,
    records: {
      ...db.records,
      'account.bank.statement.line': db.records['account.bank.statement.line'].map((l) => (
        l.id === lineRes.id ? { ...l, batch_payment_id: draftBatchRes.id } : l
      )),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, forgedDraftBatchLine), { isAdmin: true }),
    /Select a posted batch payment|The linked payment belongs to another company or does not exist/,
  );

  // eligibleBatches returns only the posted inbound batch
  const batches = eligibleBatches(db, stLine);
  assert.deepEqual(batches.map((b) => b.id), [inboundBatchRes.id]);

  const ctx = await mountBankReconcile(db);
  try {
    const buttonNamed = (name) => find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === name);
    const lineBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Inbound batch 200'));
    assert.ok(lineBtn, 'Statement line exists');
    await ctx.React.act(async () => props(lineBtn).onClick());

    // 1. Sales and Purchases shortcuts open matching customer/vendor documents
    const salesLink = find(ctx.host, (n) => n.tagName === 'A' && n.textContent.trim() === 'Sales');
    const purchasesLink = find(ctx.host, (n) => n.tagName === 'A' && n.textContent.trim() === 'Purchases');
    assert.ok(salesLink, 'Sales shortcut link exists');
    assert.ok(purchasesLink, 'Purchases shortcut link exists');
    assert.equal(props(salesLink).href, `#/accounting/invoices?view=list&filter=unpaid&rel=partner_id:${partner.id}`);
    assert.equal(props(purchasesLink).href, `#/accounting/bills?view=list&filter=unpaid&rel=partner_id:${partner.id}`);

    // 2. Ellipsis menu exposes Manage Models link to reconciliation models list
    const moreBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'More');
    assert.ok(moreBtn, 'Ellipsis More button exists');
    await ctx.React.act(async () => props(moreBtn).onClick());
    const manageModelsLink = find(ctx.host, (n) => n.tagName === 'A' && props(n)?.role === 'menuitem' && n.textContent.trim() === 'Manage Models');
    assert.ok(manageModelsLink, 'Manage Models menuitem exists');
    assert.equal(props(manageModelsLink).href, '#/accounting/reconcile-models');

    // 3. Set Account activates Manual Operation tab
    const setAccBtn = buttonNamed('Set Account');
    assert.ok(setAccBtn, 'Set Account button exists');
    await ctx.React.act(async () => props(setAccBtn).onClick());
    const manualTab = find(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'tab' && n.textContent.trim() === 'Manual Operation');
    assert.equal(props(manualTab)?.['aria-selected'], true, 'Set Account activates Manual Operation tab');

    // 4. Upload bills reports clear server/AI requirement in local mode
    const uploadBtn = buttonNamed('Upload bills');
    assert.ok(uploadBtn, 'Upload bills button exists');
    await ctx.React.act(async () => props(uploadBtn).onClick());
    const alertEl = find(ctx.host, (n) => props(n)?.role === 'alert');
    assert.ok(alertEl?.textContent?.includes('This needs the server with AI enabled'));

    // 5. Batches tab selects and matches the posted batch payment, persisting through diffDb + applyDiff
    const batchesBtn = buttonNamed('Batches');
    assert.ok(batchesBtn, 'Batches shortcut button exists');
    await ctx.React.act(async () => props(batchesBtn).onClick());
    const batchItemBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('BATCH/IN/001'));
    assert.ok(batchItemBtn, 'Batch payment item rendered in Batches tab');
    await ctx.React.act(async () => props(batchItemBtn).onClick());

    const validateBtn = buttonNamed('Validate');
    await ctx.React.act(async () => props(validateBtn).onClick());

    const afterDb = ctx.getDb();
    const syncedDb = applyDiff(db, diffDb(db, afterDb), { isAdmin: true });
    const reconciledLine = read(syncedDb, 'account.bank.statement.line', lineRes.id);
    assert.equal(reconciledLine.state, 'reconciled');
    assert.equal(reconciledLine.batch_payment_id, inboundBatchRes.id);
    const postedBatch = read(syncedDb, 'account.batch.payment', inboundBatchRes.id);
    for (const bl of postedBatch.lines) {
      assert.equal(isPaymentMatched(syncedDb, read(syncedDb, 'account.payment', bl.payment_id)), true);
    }
    // Direct matchPayment parity check
    assert.doesNotThrow(() => matchPayment(db, { ...stLine, batch_payment_id: inboundBatchRes.id }));
  } finally {
    await ctx.done();
  }
});

test('BNK5-2: BankReconcile Auto-Reconcile runs automated models only on visible lines while scheduler/direct autoReconcile handles all lines', async () => {
  let db = seed();
  const bank1 = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const bank2Acc = create(db, 'account.account', { code: '101490', name: 'Bank 2 Cash', account_type: 'asset_cash', company_id: 1 });
  const bank2 = create(bank2Acc.db, 'account.journal', {
    name: 'Bank 2',
    code: 'BNK2',
    type: 'bank',
    company_id: 1,
    default_account_id: bank2Acc.id,
    suspense_account_id: bank1.suspense_account_id,
  });
  db = bank2.db;

  const feeAcc = accountId(db, '600000', 1);
  const autoRule = create(db, 'account.reconcile.model', {
    name: 'Auto Monthly Fee',
    trigger: 'auto_reconcile',
    match_label: 'contains',
    match_label_param: 'AUTO-FEE',
    line_ids: [{ account_id: feeAcc, amount_type: 'percentage', amount_string: '100', label: 'Bank Fee' }],
  });
  const manualRule = create(autoRule.db, 'account.reconcile.model', {
    name: 'Manual Fee',
    trigger: 'manual',
    match_label: 'contains',
    match_label_param: 'MANUAL-FEE',
    line_ids: [{ account_id: feeAcc, amount_type: 'percentage', amount_string: '100', label: 'Manual Fee' }],
  });
  db = manualRule.db;

  const lVisibleAuto = create(db, 'account.bank.statement.line', {
    journal_id: bank1.id, company_id: 1, date: '2026-08-01', payment_ref: 'AUTO-FEE BNK1', amount: -25, state: 'to_check',
  });
  const lVisibleManual = create(lVisibleAuto.db, 'account.bank.statement.line', {
    journal_id: bank1.id, company_id: 1, date: '2026-08-01', payment_ref: 'MANUAL-FEE BNK1', amount: -15, state: 'to_check',
  });
  const lHiddenAuto = create(lVisibleManual.db, 'account.bank.statement.line', {
    journal_id: bank2.id, company_id: 1, date: '2026-08-01', payment_ref: 'AUTO-FEE BNK2', amount: -30, state: 'to_check',
  });
  db = lHiddenAuto.db;

  const ctx = await mountBankReconcile(db);
  try {
    // Filter workspace to bank1 only
    const journalSelect = find(ctx.host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Journal');
    await ctx.React.act(async () => props(journalSelect).onChange({ target: { value: String(bank1.id) } }));

    const autoBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Auto-Reconcile');
    assert.ok(autoBtn, 'Auto-Reconcile button exists in BankReconcile');
    await ctx.React.act(async () => props(autoBtn).onClick());

    const afterUi = ctx.getDb();
    const syncedUi = applyDiff(db, diffDb(db, afterUi), { isAdmin: true });
    assert.equal(read(syncedUi, 'account.bank.statement.line', lVisibleAuto.id).state, 'reconciled', 'Visible automated line is reconciled');
    assert.equal(read(syncedUi, 'account.bank.statement.line', lVisibleManual.id).state, 'to_check', 'Manual-only line stays open');
    assert.equal(read(syncedUi, 'account.bank.statement.line', lHiddenAuto.id).state, 'to_check', 'Hidden journal line is untouched by filtered Auto-Reconcile');

    // Calling scheduler / autoReconcile(db) still reconciles the remaining journal's automated line
    const afterScheduled = runScheduledJobs(syncedUi, '2026-08-02');
    assert.equal(read(afterScheduled, 'account.bank.statement.line', lHiddenAuto.id).state, 'reconciled');
    assert.equal(read(autoReconcile(syncedUi), 'account.bank.statement.line', lHiddenAuto.id).state, 'reconciled');
  } finally {
    await ctx.done();
  }
});

test('BNK5-3: filter and status labels match Odoo Not Matched / Matched with stable filter ids and Arabic translations', async () => {
  const lineDef = models['account.bank.statement.line'];
  const stmtDef = models['account.bank.statement'];

  assert.deepEqual(lineDef.fields.state.options, [['to_check', 'Not Matched'], ['reconciled', 'Matched']]);
  assert.deepEqual(stmtDef.fields.line_ids.fields.state.options, [['to_check', 'Not Matched'], ['reconciled', 'Matched']]);

  const statusFilters = lineDef.filters[0];
  assert.deepEqual(statusFilters.map((f) => [f.id, f.label]), [['open', 'Not Matched'], ['done', 'Matched']]);

  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const feeAcc = accountId(db, '600000', 1);
  const stmt = create(db, 'account.bank.statement', {
    name: 'STMT/BNK5/01',
    journal_id: bank.id,
    date: '2026-08-10',
    balance_start: 0,
    balance_end_real: -10,
  });
  const openLine = create(stmt.db, 'account.bank.statement.line', {
    statement_id: stmt.id, journal_id: bank.id, company_id: 1, date: '2026-08-10', payment_ref: 'Open Line', amount: 20, state: 'to_check',
  });
  const doneRule = create(openLine.db, 'account.reconcile.model', {
    name: 'Done Fee', trigger: 'auto_reconcile', match_label: 'contains', match_label_param: 'Closed Line',
    line_ids: [{ account_id: feeAcc, amount_type: 'percentage', amount_string: '100' }],
  });
  const doneLine = create(doneRule.db, 'account.bank.statement.line', {
    statement_id: stmt.id, journal_id: bank.id, company_id: 1, date: '2026-08-10', payment_ref: 'Closed Line', amount: -30, state: 'to_check',
  });
  db = autoReconcile(doneLine.db, { lineIds: [doneLine.id] });

  const both = [read(db, 'account.bank.statement.line', openLine.id), read(db, 'account.bank.statement.line', doneLine.id)];
  assert.deepEqual(applyFilters('account.bank.statement.line', both, ['open'], db).map((l) => l.id), [openLine.id]);
  assert.deepEqual(applyFilters('account.bank.statement.line', both, ['done'], db).map((l) => l.id), [doneLine.id]);

  // Statement CSV export in BankReconcile prints Not Matched / Matched
  const ctx = await mountBankReconcile(db);
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let exported;
  URL.createObjectURL = (blob) => { exported = blob; return 'blob:bnk5'; };
  URL.revokeObjectURL = () => {};
  try {
    const stmtSelect = find(ctx.host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Statement');
    await ctx.React.act(async () => props(stmtSelect).onChange({ target: { value: String(stmt.id) } }));
    const exportBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Export Statement');
    await ctx.React.act(async () => props(exportBtn).onClick());
    const csv = await exported.text();
    assert.match(csv, /Not Matched/);
    assert.match(csv, /Matched/);
    assert.doesNotMatch(csv, /To Reconcile/);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    await ctx.done();
  }

  // Arabic i18n checks (all new labels/messages distinct from English)
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {} };
  try {
    const { t: tAr } = await import(`./i18n.js?bnk5=${Date.now()}`);
    for (const phrase of [
      'More', 'Set Account', 'Batches', 'Upload bills', 'Manage Models', 'Auto-Reconcile',
      'Not Matched', 'Matched', 'Select a batch payment to match',
      'No unmatched batch payments match this transaction.',
      'Journals in the reconciliation model must be bank, cash, or credit journals',
      'Partners in the reconciliation model must belong to the model company',
    ]) {
      const translated = tAr(phrase);
      assert.ok(translated && translated !== phrase, `Missing Arabic translation for ${phrase}`);
    }
    const arPlural = tAr('{n} payment(s)', { n: 2 });
    assert.ok(arPlural && !arPlural.includes('payment(s)'), 'Plural payment label translated');
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

test('BNK5-4: reconciliation model guards match_journal_ids, match_partner_ids, and counterpart line counts via diffDb + applyDiff', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id ?? 1) === 1);
  const feeAcc = accountId(db, '600000', 1);
  const co2 = create(db, 'res.company', { name: 'Company 2', currency_id: 1 });
  const foreignPartner = create(co2.db, 'res.partner', { name: 'Co2 Partner', company_id: co2.id });
  const archivedPartner = create(foreignPartner.db, 'res.partner', { name: 'Archived Partner', company_id: 1, active: false });
  db = archivedPartner.db;

  const baseRule = create(db, 'account.reconcile.model', {
    name: 'Valid Bank Rule',
    company_id: 1,
    match_journal_ids: [bank.id],
    line_ids: [{ account_id: feeAcc, amount_type: 'percentage', amount_string: '100' }],
  });
  db = baseRule.db;
  const saved = read(db, 'account.reconcile.model', baseRule.id);
  assert.equal(isWriteoffButtonModel(saved), true);
  assert.equal(ruleMatches(saved, { journal_id: bank.id, company_id: 1, amount: -10 }), true);
  assert.equal(ruleMatches(saved, { journal_id: bank.id + 999, company_id: 1, amount: -10 }), false);

  // Mapping-only (0 counterpart account lines) is excluded from quick-action writeoff buttons
  const noAccountRule = create(db, 'account.reconcile.model', {
    name: 'No Account Lines',
    company_id: 1,
    line_ids: [{ partner_id: 3 }],
  });
  assert.equal(isWriteoffButtonModel(read(noAccountRule.db, 'account.reconcile.model', noAccountRule.id)), false);

  // Non-liquidity journal in match_journal_ids rejected on create and via diffDb + applyDiff
  assert.throws(
    () => create(db, 'account.reconcile.model', { name: 'Sale Journal Rule', company_id: 1, match_journal_ids: [saleJournal.id] }),
    /bank, cash, or credit journals/,
  );
  const forgedSaleJournal = {
    ...db,
    records: {
      ...db.records,
      'account.reconcile.model': db.records['account.reconcile.model'].map((r) => (r.id === baseRule.id ? { ...r, match_journal_ids: [saleJournal.id] } : r)),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, forgedSaleJournal), { isAdmin: true }),
    /bank, cash, or credit journals/,
  );

  // Foreign or archived partner in match_partner_ids rejected by domain and via diffDb + applyDiff
  const partnerDomain = models['account.reconcile.model'].fields.match_partner_ids.domain;
  assert.equal(partnerDomain(read(db, 'res.partner', foreignPartner.id), { company_id: 1 }), false);
  assert.equal(partnerDomain(read(db, 'res.partner', archivedPartner.id), { company_id: 1 }), false);
  for (const badPartnerId of [foreignPartner.id, archivedPartner.id]) {
    const forgedPartner = {
      ...db,
      records: {
        ...db.records,
        'account.reconcile.model': db.records['account.reconcile.model'].map((r) => (r.id === baseRule.id ? { ...r, match_partner_ids: [badPartnerId] } : r)),
      },
    };
    assert.throws(
      () => applyDiff(db, diffDb(db, forgedPartner), { isAdmin: true }),
      /Partners in the reconciliation model must belong to the model company/,
    );
  }

  // (a) Archiving a linked partner and a linked journal, then renaming the model, succeeds via diffDb + applyDiff
  const linkedPartner = create(db, 'res.partner', { name: 'Linked Active Partner', company_id: 1 });
  const linkedRule = create(linkedPartner.db, 'account.reconcile.model', {
    name: 'Linked Model',
    company_id: 1,
    match_journal_ids: [bank.id],
    match_partner_ids: [linkedPartner.id],
    line_ids: [{ account_id: feeAcc, amount_type: 'percentage', amount_string: '100' }],
  });
  const draftArchivedLinks = {
    ...linkedRule.db,
    records: {
      ...linkedRule.db.records,
      'res.partner': linkedRule.db.records['res.partner'].map((p) => (p.id === linkedPartner.id ? { ...p, active: false } : p)),
      'account.journal': linkedRule.db.records['account.journal'].map((j) => (j.id === bank.id ? { ...j, active: false } : j)),
    },
  };
  const archivedLinksDb = applyDiff(linkedRule.db, diffDb(linkedRule.db, draftArchivedLinks), { isAdmin: true });
  const renamedModelDb = {
    ...archivedLinksDb,
    records: {
      ...archivedLinksDb.records,
      'account.reconcile.model': archivedLinksDb.records['account.reconcile.model'].map((r) => (
        r.id === linkedRule.id ? { ...r, name: 'Linked Model Renamed' } : r
      )),
    },
  };
  const syncedRename = applyDiff(archivedLinksDb, diffDb(archivedLinksDb, renamedModelDb), { isAdmin: true });
  assert.equal(read(syncedRename, 'account.reconcile.model', linkedRule.id).name, 'Linked Model Renamed');

  // (b) Adding a new archived partner or a non-liquidity journal alongside existing archived links is still rejected via diffDb + applyDiff
  const addArchivedPartnerDb = {
    ...syncedRename,
    records: {
      ...syncedRename.records,
      'account.reconcile.model': syncedRename.records['account.reconcile.model'].map((r) => (
        r.id === linkedRule.id ? { ...r, match_partner_ids: [linkedPartner.id, archivedPartner.id] } : r
      )),
    },
  };
  assert.throws(
    () => applyDiff(syncedRename, diffDb(syncedRename, addArchivedPartnerDb), { isAdmin: true }),
    /Partners in the reconciliation model must belong to the model company/,
  );
  const addNonLiquidityJournalDb = {
    ...syncedRename,
    records: {
      ...syncedRename.records,
      'account.reconcile.model': syncedRename.records['account.reconcile.model'].map((r) => (
        r.id === linkedRule.id ? { ...r, match_journal_ids: [bank.id, saleJournal.id] } : r
      )),
    },
  };
  assert.throws(
    () => applyDiff(syncedRename, diffDb(syncedRename, addNonLiquidityJournalDb), { isAdmin: true }),
    /bank, cash, or credit journals/,
  );
});
