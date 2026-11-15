import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { find, setupDom } from './test-support/dom.js';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { accountId, journalItems, postEntry, reconciledJournalItems } from './models/ledger.js';
import { reconcileLedgerItems } from './models/glReconcile.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

function itemSelection(db, moveId, account) {
  const rows = journalItems(db).filter((l) => l.move_id === moveId && l.account_id === account);
  assert.equal(rows.length, 1, `Expected 1 journal item on move ${moveId} account ${account}, got ${rows.length}`);
  return { move_id: moveId, line_identity: rows[0].line_identity };
}

function residualOf(db, moveId, account) {
  return reconciledJournalItems(db, read(db, 'account.move', moveId)).find((l) => l.account_id === account).amount_residual;
}

function setupPair({ rounding = null, currencyName = null, debitAmt = 300, creditAmt = 40 } = {}) {
  let db = seed();
  let companyId = 1;
  if (rounding != null) {
    const curr = create(db, 'res.currency', {
      name: currencyName ?? `R${rounding}`,
      rounding,
      rate_ids: [{ date: '2026-01-01', rate: 1 }],
    });
    const company = createCompanyWithDefaultInvoiceJournals(curr.db, { name: `Co ${currencyName}`, currency_id: curr.id });
    db = company.db;
    companyId = company.id;
  }
  const ar = read(db, 'res.company', companyId)?.account_default_receivable_id ?? accountId(db, '121000', companyId);
  const rev = accountId(db, '400000', companyId)
    ?? (() => {
      const acc = create(db, 'account.account', { code: `4000${companyId}`, name: 'Rev', account_type: 'income', company_id: companyId });
      db = acc.db;
      return acc.id;
    })();
  const misc = search(db, 'account.journal').find((j) => j.type === 'general' && (!j.company_id || j.company_id === companyId));
  const partner = create(db, 'res.partner', { name: 'Q119G Partner', company_id: companyId });
  db = partner.db;
  const d = postEntry(db, {
    journal: misc.code,
    journal_id: misc.id,
    company: companyId,
    date: '2026-04-01',
    ref: 'DEBIT-300',
    lines: [{ account_id: ar, partner_id: partner.id, debit: debitAmt }, { account_id: rev, credit: debitAmt }],
  });
  const c = postEntry(d.db, {
    journal: misc.code,
    journal_id: misc.id,
    company: companyId,
    date: '2026-04-02',
    ref: 'CREDIT-40',
    lines: [{ account_id: ar, partner_id: partner.id, credit: creditAmt }, { account_id: rev, debit: creditAmt }],
  });
  return { db: c.db, companyId, ar, debitId: d.id, creditId: c.id };
}

test('explicit GL reconcile amount exceeding open balance is rejected before writing anything', () => {
  const { db, ar, debitId, creditId } = setupPair({ debitAmt: 300, creditAmt: 40 });
  const selections = [itemSelection(db, debitId, ar), itemSelection(db, creditId, ar)];

  // Amount 100 against residuals 300 / -40 -> throws, no partial row, no residual change.
  assert.throws(
    () => reconcileLedgerItems(db, selections, { date: '2026-04-02', amount: 100 }),
    /cannot exceed the open balance available to reconcile/i,
  );
  assert.equal((db.records['account.partial.reconcile'] ?? []).length, 0);
  assert.equal(residualOf(db, debitId, ar), 300);
  assert.equal(residualOf(db, creditId, ar), -40);

  // Amount 40.01 against 300 / -40 -> throws, no partial row, no residual change.
  assert.throws(
    () => reconcileLedgerItems(db, selections, { date: '2026-04-02', amount: 40.01 }),
    /cannot exceed the open balance available to reconcile/i,
  );
  assert.equal((db.records['account.partial.reconcile'] ?? []).length, 0);
  assert.equal(residualOf(db, debitId, ar), 300);
  assert.equal(residualOf(db, creditId, ar), -40);

  // Exact maximum 40 -> accepted, creates one 40 partial link.
  const exactDb = reconcileLedgerItems(db, selections, { date: '2026-04-02', amount: 40 });
  const exactLinks = exactDb.records['account.partial.reconcile'] ?? [];
  assert.equal(exactLinks.length, 1);
  assert.equal(exactLinks[0].amount, 40);
  assert.equal(residualOf(exactDb, debitId, ar), 260);
  assert.equal(residualOf(exactDb, creditId, ar), 0);

  // Partial 25 -> creates 25 link and leaves residuals 275 / -15; subsequent 16 against 15 throws.
  const partialDb = reconcileLedgerItems(db, selections, { date: '2026-04-02', amount: 25 });
  const partialLinks = partialDb.records['account.partial.reconcile'] ?? [];
  assert.equal(partialLinks.length, 1);
  assert.equal(partialLinks[0].amount, 25);
  assert.equal(residualOf(partialDb, debitId, ar), 275);
  assert.equal(residualOf(partialDb, creditId, ar), -15);

  assert.throws(
    () => reconcileLedgerItems(partialDb, [itemSelection(partialDb, debitId, ar), itemSelection(partialDb, creditId, ar)], { date: '2026-04-03', amount: 16 }),
    /cannot exceed the open balance available to reconcile/i,
  );
  assert.equal((partialDb.records['account.partial.reconcile'] ?? []).length, 1);
  assert.equal(residualOf(partialDb, debitId, ar), 275);
  assert.equal(residualOf(partialDb, creditId, ar), -15);
});

test('explicit GL reconcile amount respects zero-decimal currency rounding (rounding 1)', () => {
  const { db, ar, debitId, creditId } = setupPair({ rounding: 1, currencyName: 'JPYG', debitAmt: 300, creditAmt: 40 });
  const selections = [itemSelection(db, debitId, ar), itemSelection(db, creditId, ar)];

  assert.throws(
    () => reconcileLedgerItems(db, selections, { date: '2026-04-02', amount: 41 }),
    /cannot exceed the open balance available to reconcile/i,
  );
  assert.equal((db.records['account.partial.reconcile'] ?? []).length, 0);

  const partialDb = reconcileLedgerItems(db, selections, { date: '2026-04-02', amount: 25 });
  assert.equal((partialDb.records['account.partial.reconcile'] ?? []).length, 1);
  assert.equal(residualOf(partialDb, debitId, ar), 275);
  assert.equal(residualOf(partialDb, creditId, ar), -15);

  assert.throws(
    () => reconcileLedgerItems(partialDb, [itemSelection(partialDb, debitId, ar), itemSelection(partialDb, creditId, ar)], { date: '2026-04-03', amount: 16 }),
    /cannot exceed the open balance available to reconcile/i,
  );

  const exactDb = reconcileLedgerItems(partialDb, [itemSelection(partialDb, debitId, ar), itemSelection(partialDb, creditId, ar)], { date: '2026-04-03', amount: 15 });
  assert.equal((exactDb.records['account.partial.reconcile'] ?? []).length, 2);
  assert.equal(residualOf(exactDb, debitId, ar), 260);
  assert.equal(residualOf(exactDb, creditId, ar), 0);
});

test('exceeded GL reconcile amount error has Arabic translation and surfaces in JournalItems UI', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  try {
    const { t } = await import('./i18n.js?q119g-ar-test');
    const msg = 'The applied amount cannot exceed the open balance available to reconcile';
    assert.notEqual(t(msg), msg);
  } finally {
    globalThis.localStorage = prevStorage;
  }

  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { JournalItems } = await import('./views/JournalItems.jsx');
  await initStore();

  const { db, ar, debitId, creditId } = setupPair({ debitAmt: 300, creditAmt: 40 });
  const arName = read(db, 'account.account', ar).name;
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const selectRow = async (moveId) => {
    const row = find(host, (n) => n.tagName === 'TR' && n.textContent.includes(arName) && find(n, (a) => a.tagName === 'A' && props(a)?.href === `#/accounting/entries/${moveId}`));
    assert.ok(row, `Row for move ${moveId} must exist`);
    const cb = find(row, (k) => k.tagName === 'INPUT' && props(k)?.type === 'checkbox');
    await React.act(async () => props(cb).onChange({ target: { checked: true } }));
  };

  try {
    await React.act(async () => {
      await commit(db);
      root.render(React.createElement(JournalItems, { leaf: { reviewMode: 'unreconciled' } }));
    });
    await selectRow(debitId);
    await selectRow(creditId);
    await React.act(async () => props(find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Reconcile')).onClick());
    const dateInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date' && !props(n)?.['aria-label']);
    await React.act(async () => props(dateInput).onChange({ target: { value: '2026-04-02' } }));
    const amtInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'number');
    await React.act(async () => props(amtInput).onChange({ target: { value: '100' } }));
    await React.act(async () => props(find(host, (n) => n.tagName === 'FORM')).onSubmit({ preventDefault() {} }));

    const alertEl = find(host, (n) => n.tagName === 'P' && props(n)?.role === 'alert');
    assert.ok(alertEl, 'Error alert must be shown in JournalItems form');
    assert.match(alertEl.textContent, /cannot exceed the open balance available to reconcile/i);
    assert.equal((getDb().records['account.partial.reconcile'] ?? []).length, 0);
    assert.equal(residualOf(getDb(), debitId, ar), 300);
    assert.equal(residualOf(getDb(), creditId, ar), -40);
  } finally {
    await React.act(async () => root.unmount());
  }
});
