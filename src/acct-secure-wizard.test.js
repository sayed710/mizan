import { register } from 'node:module';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, find } from './test-support/dom.js';
import { apps, leavesOf, models } from './models/index.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { postEntry } from './models/ledger.js';
import { bookToAccount } from './models/bank.js';
import { analyzeJournalChains } from './models/hash_chain.js';
import { createCompany } from './models/company.js';
import { invoiceJournalDefaults } from './test-support/accounting-company.js';

const reactProps = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const hasClass = (node, cls) => String(reactProps(node)?.className ?? '').split(/\s+/).includes(cls);
const allFind = (node, predicate, out = []) => {
  if (!node) return out;
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes ?? []) allFind(child, predicate, out);
  return out;
};

async function mountAppView(renderFn, db) {
  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (_, tag) => makeEl(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();
  await React.act(async () => store.commit(db));
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => root.render(React.createElement(React.StrictMode, null, renderFn(React))));
  return {
    host,
    done: async () => { await React.act(async () => root.unmount()); },
  };
}

test('Secure Entries wizard uses Odoo 20 field label, inline wording, placeholder, and footer button labels', () => {
  const wiz = models['account.secure.entries.wizard'];
  assert.equal(wiz.fields.hash_date.label, 'Hash All Entries');
  assert.equal(wiz.fields.hash_date.placeholder, 'Not hashed');
  assert.ok(wiz.fields.unreconciled_bank_statement_line_ids);
  assert.equal(wiz.fields.unreconciled_bank_statement_line_ids.relation, 'account.bank.statement.line');

  const buttons = wiz.form.buttons.map((b) => b.label);
  assert.deepEqual(buttons, ['Secure Entries', 'Cancel']);

  const db = seed();
  const emptyWiz = wiz.createDefaults(db, { company: 1, hash_date: '' });
  const secureBtn = wiz.form.buttons.find((b) => b.label === 'Secure Entries');
  assert.throws(() => secureBtn.run(db, { ...emptyWiz, hash_date: null }), /Set a date\. The moves will be secured up to including this date\./);
});

test('unreconciled bank statement lines populate unreconciled_bank_statement_line_ids, exclude their prefix from securing, and allow later reconciliation', () => {
  let db = seed();
  const company2 = createCompany(db, { name: 'Other Co', ...invoiceJournalDefaults(db) });
  db = company2.db;

  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id ?? 1) === 1);
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].filter((m) => m.journal_id !== saleJournal.id && m.journal_id !== bankJournal.id) } };

  // Enable restrict_mode_hash_table on sale and bank journals
  db = write(db, 'account.journal', saleJournal.id, { restrict_mode_hash_table: true });
  db = write(db, 'account.journal', bankJournal.id, { restrict_mode_hash_table: true });

  // Posted entry on sales journal
  const invRes = postEntry(db, {
    journal: saleJournal.code,
    date: '2026-01-10',
    company: 1,
    lines: [{ account: '101401', debit: 100 }, { account: '400000', credit: 100 }],
  });
  db = invRes.db;

  // Unreconciled bank statement line before hash_date (partially booked via bookToAccount so bank_move_id exists and state is still to_check)
  const expAcc = search(db, 'account.account').find((a) => a.account_type === 'expense' && (a.company_id ?? 1) === 1);
  const stmtPartial = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: '2026-01-05',
    payment_ref: 'Partial fee',
    amount: -100,
    counterpart_account_id: expAcc.id,
    company_id: 1,
  });
  db = bookToAccount(stmtPartial.db, read(stmtPartial.db, 'account.bank.statement.line', stmtPartial.id), { amount: 40 }).db;

  // Another unreconciled unbooked line before hash_date
  const stmtUnbooked = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: '2026-01-08',
    payment_ref: 'Unbooked deposit',
    amount: 50,
    company_id: 1,
  });
  db = stmtUnbooked.db;

  // Reconciled line before hash_date (must NOT appear)
  const stmtReconciled = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: '2026-01-04',
    payment_ref: 'Already done',
    amount: -20,
    counterpart_account_id: expAcc.id,
    company_id: 1,
  });
  db = bookToAccount(stmtReconciled.db, read(stmtReconciled.db, 'account.bank.statement.line', stmtReconciled.id)).db;

  // Unreconciled line AFTER hash_date (must NOT appear)
  const stmtFuture = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: '2026-02-10',
    payment_ref: 'Future line',
    amount: 75,
    company_id: 1,
  });
  db = stmtFuture.db;

  // Unreconciled line in another company (must NOT appear)
  const otherBank = search(db, 'account.journal').find((j) => j.type === 'bank' && j.company_id === company2.id);
  if (otherBank) {
    db = write(db, 'account.journal', otherBank.id, { restrict_mode_hash_table: true });
    db = create(db, 'account.bank.statement.line', {
      journal_id: otherBank.id,
      date: '2026-01-05',
      payment_ref: 'Other co line',
      amount: 30,
      company_id: company2.id,
    }).db;
  }

  // Also add an unhashed posted move on bankJournal (created before restrict_mode was enabled) to verify it is excluded from securing
  const bnkUnrestrictedTemp = write(db, 'account.journal', bankJournal.id, { restrict_mode_hash_table: false });
  const unhashedBankMove = postEntry(bnkUnrestrictedTemp, {
    journal: bankJournal.code,
    date: '2026-01-06',
    company: 1,
    lines: [{ account: '101401', debit: 10 }, { account: '400000', credit: 10 }],
  });
  db = write(unhashedBankMove.db, 'account.journal', bankJournal.id, { restrict_mode_hash_table: true });

  const analysis = analyzeJournalChains(db, { companyId: 1, hashDate: '2026-01-31' });
  assert.ok(analysis.unreconciled_bank_statement_line_ids.includes(stmtPartial.id));
  assert.ok(analysis.unreconciled_bank_statement_line_ids.includes(stmtUnbooked.id));
  assert.ok(!analysis.unreconciled_bank_statement_line_ids.includes(stmtReconciled.id));
  assert.ok(!analysis.unreconciled_bank_statement_line_ids.includes(stmtFuture.id));
  assert.equal(analysis.unreconciled_bank_statement_line_ids.length, 2);

  // Sales invoice is in move_to_hash_ids, while the unhashed bank journal move is excluded
  assert.ok(analysis.move_to_hash_ids.includes(invRes.id));
  assert.ok(!analysis.move_to_hash_ids.includes(unhashedBankMove.id));

  // Danger warning item is present with Review Statements action
  const dangerWarn = analysis.warning_items.find((w) => w.key === 'account_unreconciled_bank_statement_line_ids');
  assert.ok(dangerWarn);
  assert.equal(dangerWarn.level, 'danger');
  assert.equal(dangerWarn.action_text, 'Review Statements');
  assert.match(dangerWarn.message, /There are still unreconciled bank transactions before the selected date/);
  assert.equal(dangerWarn.go, `#/accounting/bank?view=list&rel=id:${analysis.unreconciled_bank_statement_line_ids.join(',')}`);

  // Clicking Secure Entries secures the sales entry, leaves unhashedBankMove unsecured, and does not lock out reconciling the 2026-01-05 bank line
  const wizModel = models['account.secure.entries.wizard'];
  const wiz = create(db, 'account.secure.entries.wizard', { company: 1, hash_date: '2026-01-31' });
  const secureBtn = wizModel.form.buttons.find((b) => b.label === 'Secure Entries');
  const securedRes = secureBtn.run(wiz.db, read(wiz.db, 'account.secure.entries.wizard', wiz.id));
  assert.equal(securedRes.go, '#/accounting/entries');
  assert.ok(read(securedRes.db, 'account.move', invRes.id).inalterable_hash, 'sales entry secured');
  assert.equal(read(securedRes.db, 'account.move', unhashedBankMove.id).inalterable_hash ?? null, null, 'bank journal entry not secured');

  // Reconcile the partially reconciled statement line afterwards
  const finishedBank = bookToAccount(securedRes.db, read(securedRes.db, 'account.bank.statement.line', stmtPartial.id));
  assert.equal(read(finishedBank.db, 'account.bank.statement.line', stmtPartial.id).state, 'reconciled');
});

test('wizard renders Odoo warning levels in order (danger before warning) and Review Statements / Review Entries open matching filtered lists', async () => {
  let db = seed();
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].filter((m) => m.journal_id !== saleJournal.id && m.journal_id !== bankJournal.id) } };
  db = write(db, 'account.journal', saleJournal.id, { restrict_mode_hash_table: true });
  db = write(db, 'account.journal', bankJournal.id, { restrict_mode_hash_table: true });

  // Two posted entries on sales journal with a sequence gap (1 and 3)
  const accounts = search(db, 'account.account');
  const lines = [{ account_id: accounts.find((a) => a.code === '600000').id, debit: 100, credit: 0 }, { account_id: accounts.find((a) => a.code === '211000').id, debit: 0, credit: 100 }];
  const m1 = create(db, 'account.move', { move_type: 'entry', state: 'posted', journal_id: saleJournal.id, invoice_date: '2026-01-02', name: 'INV/2026/0001', line_ids: lines });
  const m3 = create(m1.db, 'account.move', { move_type: 'entry', state: 'posted', journal_id: saleJournal.id, invoice_date: '2026-01-03', name: 'INV/2026/0003', line_ids: lines });
  // One draft entry before hash_date
  const draft = create(m3.db, 'account.move', { move_type: 'entry', state: 'draft', journal_id: saleJournal.id, invoice_date: '2026-01-02', name: '/', line_ids: [] });
  // One unreconciled bank statement line before hash_date (plus an unrelated one in the future)
  const stmt1 = create(draft.db, 'account.bank.statement.line', { journal_id: bankJournal.id, date: '2026-01-02', payment_ref: 'Open Line 1', amount: 120 });
  const stmtOther = create(stmt1.db, 'account.bank.statement.line', { journal_id: bankJournal.id, date: '2026-03-01', payment_ref: 'Future Line Excluded', amount: 220 });
  db = stmtOther.db;

  const accountingApp = apps.find((a) => a.id === 'accounting');
  const wizLeaf = leavesOf(accountingApp).find((l) => l.key === 'secure-entries');
  const bankLeaf = leavesOf(accountingApp).find((l) => l.key === 'bank');
  const entriesLeaf = leavesOf(accountingApp).find((l) => l.key === 'entries');

  const { FormView } = await import('./views/FormView.jsx');
  const { ActionView } = await import('./views/ActionView.jsx');

  globalThis.location = { hash: '#/accounting/secure-entries/new' };
  const formCtx = await mountAppView(
    (React) => React.createElement(FormView, { leaf: wizLeaf, id: 'new', base: '#/accounting/secure-entries', params: new URLSearchParams() }),
    db,
  );
  let reviewStatementsHref;
  let reviewDraftsHref;
  let reviewGapHref;
  try {
    const alerts = allFind(formCtx.host, (n) => hasClass(n, 'alert'));
    assert.equal(alerts.length, 3, 'renders danger + draft warning + gap warning');
    assert.ok(hasClass(alerts[0], 'alert-danger'), 'danger warning appears first');
    assert.ok(hasClass(alerts[1], 'alert-warning'), 'draft warning has warning level');
    assert.ok(hasClass(alerts[2], 'alert-warning'), 'gap warning has warning level');

    const links = allFind(formCtx.host, (n) => n.tagName === 'A' && hasClass(n, 'alert-action'));
    assert.deepEqual(links.map((l) => l.textContent), ['Review Statements', 'Review Entries', 'Review Entries']);
    reviewStatementsHref = reactProps(links[0]).href;
    reviewDraftsHref = reactProps(links[1]).href;
    reviewGapHref = reactProps(links[2]).href;

    assert.ok(formCtx.host.textContent.includes('Secure entries up to'));
    assert.ok(formCtx.host.textContent.includes('inclusive, to make them immutable'));
    const hashInput = find(formCtx.host, (n) => n.tagName === 'INPUT' && reactProps(n)?.id === 'f-hash_date');
    assert.equal(reactProps(hashInput)['aria-label'], 'Hash All Entries');
    assert.equal(reactProps(hashInput).placeholder, 'Not hashed');
  } finally {
    await formCtx.done();
  }

  // Opening Review Statements renders only the matching unreconciled bank statement line
  globalThis.location = { hash: reviewStatementsHref };
  const bankParams = new URLSearchParams(reviewStatementsHref.split('?')[1]);
  const bankCtx = await mountAppView(
    (React) => React.createElement(ActionView, { leaf: bankLeaf, base: '#/accounting/bank', params: bankParams }),
    db,
  );
  try {
    assert.ok(bankCtx.host.textContent.includes('Open Line 1'));
    assert.ok(!bankCtx.host.textContent.includes('Future Line Excluded'));
  } finally {
    await bankCtx.done();
  }

  // Opening Review Entries (drafts) renders only the matching draft entry
  globalThis.location = { hash: reviewDraftsHref };
  const draftParams = new URLSearchParams(reviewDraftsHref.split('?')[1]);
  const draftCtx = await mountAppView(
    (React) => React.createElement(ActionView, { leaf: entriesLeaf, base: '#/accounting/entries', params: draftParams }),
    db,
  );
  try {
    const rows = allFind(find(draftCtx.host, (n) => n.tagName === 'TBODY'), (n) => n.tagName === 'TR');
    assert.equal(rows.length, 1);
  } finally {
    await draftCtx.done();
  }

  // Opening Review Entries (sequence gaps) renders the two entries in the gapped chain
  globalThis.location = { hash: reviewGapHref };
  const gapParams = new URLSearchParams(reviewGapHref.split('?')[1]);
  const gapCtx = await mountAppView(
    (React) => React.createElement(ActionView, { leaf: entriesLeaf, base: '#/accounting/entries', params: gapParams }),
    db,
  );
  try {
    assert.ok(gapCtx.host.textContent.includes('INV/2026/0001'));
    assert.ok(gapCtx.host.textContent.includes('INV/2026/0003'));
    const rows = allFind(find(gapCtx.host, (n) => n.tagName === 'TBODY'), (n) => n.tagName === 'TR');
    assert.equal(rows.length, 2);
  } finally {
    await gapCtx.done();
  }
});

test('wizard detects non-hashable unlocked posted moves preceding last hashed move', () => {
  let db = seed();
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].filter((m) => m.journal_id !== saleJournal.id) } };
  const accounts = search(db, 'account.account');
  const lines = [{ account_id: accounts.find((a) => a.code === '600000').id, debit: 100, credit: 0 }, { account_id: accounts.find((a) => a.code === '211000').id, debit: 0, credit: 100 }];

  // Create move 1 (unhashed) and move 2 (already hashed) in restricted journal
  db = write(db, 'account.journal', saleJournal.id, { restrict_mode_hash_table: true });
  const m1 = create(db, 'account.move', { move_type: 'entry', state: 'posted', journal_id: saleJournal.id, invoice_date: '2026-01-05', name: 'INV/2026/0001', line_ids: lines });
  const m2 = create(m1.db, 'account.move', { move_type: 'entry', state: 'posted', journal_id: saleJournal.id, invoice_date: '2026-01-10', name: 'INV/2026/0002', inalterable_hash: 'h2', secure_sequence_number: 1, line_ids: lines });
  const analysis = analyzeJournalChains(m2.db, { companyId: 1, hashDate: '2026-01-31' });

  const warn = analysis.warning_items.find((w) => w.key === 'account_not_hashable_unlocked_moves');
  assert.ok(warn);
  assert.equal(warn.level, 'warning');
  assert.equal(warn.action_text, 'Review Entries');
  assert.equal(warn.go, `#/accounting/entries?view=list&rel=id:${m1.id}`);
  assert.ok(!analysis.move_to_hash_ids.includes(m1.id));
});

test('wizard warns when securing an entry also secures earlier-numbered entries dated after hash_date', () => {
  let db = seed();
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].filter((m) => m.journal_id !== saleJournal.id) } };
  const accounts = search(db, 'account.account');
  const lines = [{ account_id: accounts.find((a) => a.code === '600000').id, debit: 100, credit: 0 }, { account_id: accounts.find((a) => a.code === '211000').id, debit: 0, credit: 100 }];

  db = write(db, 'account.journal', saleJournal.id, { restrict_mode_hash_table: true });
  const m1 = create(db, 'account.move', { move_type: 'entry', state: 'posted', journal_id: saleJournal.id, invoice_date: '2026-01-20', name: 'INV/2026/0001', line_ids: lines });
  const m2 = create(m1.db, 'account.move', { move_type: 'entry', state: 'posted', journal_id: saleJournal.id, invoice_date: '2026-01-10', name: 'INV/2026/0002', line_ids: lines });

  const analysis = analyzeJournalChains(m2.db, { companyId: 1, hashDate: '2026-01-10' });
  assert.ok(analysis.move_to_hash_ids.includes(m1.id), 'earlier-numbered post-date move included in move_to_hash_ids');
  assert.ok(analysis.move_to_hash_ids.includes(m2.id), 'in-date move included in move_to_hash_ids');
  const warn = analysis.warning_items.find((w) => w.key === 'account_move_to_secure_after_selected_date');
  assert.ok(warn, 'after-selected-date warning emitted');
  assert.equal(warn.level, 'warning');
  assert.equal(warn.action_text, 'Review Entries');
  assert.equal(warn.go, `#/accounting/entries?view=list&rel=id:${m1.id}`);

  const wizModel = models['account.secure.entries.wizard'];
  const wiz = create(m2.db, 'account.secure.entries.wizard', { company: 1, hash_date: '2026-01-10' });
  const secureBtn = wizModel.form.buttons.find((b) => b.label === 'Secure Entries');
  const res = secureBtn.run(wiz.db, read(wiz.db, 'account.secure.entries.wizard', wiz.id));
  assert.ok(read(res.db, 'account.move', m1.id).inalterable_hash, 'm1 secured');
  assert.ok(read(res.db, 'account.move', m2.id).inalterable_hash, 'm2 secured');
});

test('wizard hides warnings when hash_date is empty and throws Set a date on Secure Entries even with drafts', () => {
  let db = seed();
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  db = write(db, 'account.journal', saleJournal.id, { restrict_mode_hash_table: true });
  db = create(db, 'account.move', { move_type: 'entry', state: 'draft', journal_id: saleJournal.id, invoice_date: '2026-01-05', name: '/', line_ids: [] }).db;

  const wizModel = models['account.secure.entries.wizard'];
  const emptyWiz = wizModel.createDefaults(db, { company: 1, hash_date: '' });
  assert.deepEqual(wizModel.form.warnings(emptyWiz, db), []);
  const secureBtn = wizModel.form.buttons.find((b) => b.label === 'Secure Entries');
  assert.equal(secureBtn.when(emptyWiz, db), true);
  assert.throws(() => secureBtn.run(db, emptyWiz), /Set a date\. The moves will be secured up to including this date\./);
});

test('Arabic translations exist for all new Secure Entries wizard strings', async () => {
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {}, clear: () => {} };
  try {
    const { t } = await import('./i18n.js?lang=ar-secure-wizard');
    for (const s of [
      'Hash All Entries',
      'Not hashed',
      'inclusive, to make them immutable',
      'Unreconciled Bank Transactions',
      'Review Statements',
      'Review Entries',
      'There are still draft entries before the selected date.',
      'There are entries that cannot be hashed. They can be protected by the Hard Lock Date.',
      'Securing these entries will create at least one gap in the sequence.',
      'Securing these entries will also secure entries after the selected date.',
      'Set a date. The moves will be secured up to including this date.',
    ]) {
      assert.notEqual(t(s), s, `missing Arabic translation for "${s}"`);
    }
    const parameterized = t('There are still unreconciled bank transactions before the selected date. The entries from journal prefixes containing them will not be secured: {prefixes}', { prefixes: 'BNK1' });
    assert.notEqual(parameterized, 'There are still unreconciled bank transactions before the selected date. The entries from journal prefixes containing them will not be secured: BNK1');
    assert.ok(parameterized.includes('BNK1'));
  } finally {
    globalThis.localStorage = previousStorage;
  }
});
