import { register } from 'node:module';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, find } from './test-support/dom.js';
import { apps, leavesOf, models } from './models/index.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { postEntry } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { bookToAccount } from './models/bank.js';
import { analyzeJournalChains, checkInalterability, computeMoveHash, secureEntries } from './models/hash_chain.js';
import { applyDiff, diffDb } from './sync.js';
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
  db = { ...db, records: { ...db.records, 'account.move': [] } };
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

  const React = await import('react');
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
    assert.ok(formCtx.host.textContent.includes('Secure entries up to'));
    assert.ok(formCtx.host.textContent.includes('inclusive, to make them immutable'));
    const hashInput = find(formCtx.host, (n) => n.tagName === 'INPUT' && reactProps(n)?.id === 'f-hash_date');
    assert.equal(reactProps(hashInput)['aria-label'], 'Hash All Entries');
    assert.equal(reactProps(hashInput).placeholder, 'Not hashed');
    await React.act(async () => {
      reactProps(hashInput).onChange({ target: { value: '2026-01-31' } });
    });

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
  db = { ...db, records: { ...db.records, 'account.move': [] } };
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
      'There are numbered draft entries in the sequence being secured. Post or cancel them before securing.',
      'There are still draft entries before the selected date and numbered draft entries in the sequence being secured.',
      'Cannot secure entries while numbered draft entries precede entries to be secured',
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
    for (const tpl of [
      'Later prefixes in the same journal are also deferred until those earlier entries are reconciled: {prefixes}',
      'Later prefixes cannot be secured while earlier prefixes still have unsecured entries after the selected date: {prefixes}',
    ]) {
      const translated = t(tpl, { prefixes: 'BNK1/2026/' });
      assert.notEqual(translated, tpl.replace('{prefixes}', 'BNK1/2026/'));
      assert.ok(translated.includes('BNK1/2026/'));
    }
  } finally {
    globalThis.localStorage = previousStorage;
  }
});

test('confirming Secure Entries succeeds while the cannot-be-hashed warning is present and passes server sync', () => {
  let db = seed();
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  db = { ...db, records: { ...db.records, 'account.move': [] } };
  const accounts = search(db, 'account.account');
  const lines = [
    { account_id: accounts.find((a) => a.code === '600000').id, debit: 100, credit: 0 },
    { account_id: accounts.find((a) => a.code === '211000').id, debit: 0, credit: 100 },
  ];

  const m1 = create(db, 'account.move', { move_type: 'entry', state: 'posted', journal_id: saleJournal.id, invoice_date: '2026-01-05', name: 'INV/2026/0001', line_ids: lines });
  const m2Draft = create(m1.db, 'account.move', { move_type: 'entry', state: 'posted', journal_id: saleJournal.id, invoice_date: '2026-01-10', name: 'INV/2026/0002', line_ids: lines });
  const m2Hash = computeMoveHash(read(m2Draft.db, 'account.move', m2Draft.id), '', 3);
  db = {
    ...m2Draft.db,
    records: {
      ...m2Draft.db.records,
      'account.move': m2Draft.db.records['account.move'].map((m) => (
        m.id === m2Draft.id ? { ...m, inalterable_hash: m2Hash, secure_sequence_number: 1, inalterable_hash_version: 3 } : m
      )),
    },
  };
  db = write(db, 'account.journal', saleJournal.id, {
    restrict_mode_hash_table: true,
    secure_chain_heads: [{ company_id: 1, count: 1, last_sequence: 1, last_hash: m2Hash, last_move_id: m2Draft.id, last_move_name: 'INV/2026/0002' }],
  });
  const m3 = create(db, 'account.move', { move_type: 'entry', state: 'posted', journal_id: saleJournal.id, invoice_date: '2026-01-15', name: 'INV/2026/0003', line_ids: lines });
  db = m3.db;

  const analysis = analyzeJournalChains(db, { companyId: 1, hashDate: '2026-01-31' });
  assert.ok(analysis.warning_items.some((w) => w.key === 'account_not_hashable_unlocked_moves'), 'cannot-be-hashed warning shown');
  assert.deepEqual(analysis.move_to_hash_ids, [m3.id], 'only later entry m3 is offered');

  const wizModel = models['account.secure.entries.wizard'];
  const wiz = create(db, 'account.secure.entries.wizard', { company: 1, hash_date: '2026-01-31' });
  const secureBtn = wizModel.form.buttons.find((b) => b.label === 'Secure Entries');
  const res = secureBtn.run(wiz.db, read(wiz.db, 'account.secure.entries.wizard', wiz.id));

  assert.equal(read(res.db, 'account.move', m1.id).inalterable_hash ?? null, null, 'm1 remains unhashed');
  assert.equal(read(res.db, 'account.move', m3.id).secure_sequence_number, 2, 'm3 extends chain from m2');
  assert.equal(read(res.db, 'res.company', 1).hard_lock_date ?? null, null, 'wizard does not write hard_lock_date (Odoo account_secure_entries_wizard.py:241-250)');

  const synced = applyDiff(db, diffDb(db, res.db), { isAdmin: true });
  assert.equal(checkInalterability(synced, { journalId: saleJournal.id, companyId: 1 })[0].status, 'ok');
});

test('unreconciled older-year prefix defers later-year prefix in same journal while allowing other journals to secure', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  db = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].filter((m) => m.journal_id !== bankJournal.id && m.journal_id !== saleJournal.id),
    },
  };
  db = write(db, 'account.journal', bankJournal.id, { restrict_mode_hash_table: true });
  db = write(db, 'account.journal', saleJournal.id, { restrict_mode_hash_table: true });

  const accounts = search(db, 'account.account');
  const lines = [
    { account_id: accounts.find((a) => a.code === '600000').id, debit: 100, credit: 0 },
    { account_id: accounts.find((a) => a.code === '211000').id, debit: 0, credit: 100 },
  ];

  // 2025 bank statement line (creates and posts its own 2025 bank entry to suspense)
  const stmt2025 = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id, date: '2025-12-20', payment_ref: 'Open 2025 line', amount: -100, company_id: 1,
  });
  const b2025Id = read(stmt2025.db, 'account.bank.statement.line', stmt2025.id).bank_move_id;
  assert.ok(b2025Id, '2025 statement line creates its bank entry');
  // 2026 bank entry (same journal, newer year prefix)
  const b2026 = create(stmt2025.db, 'account.move', {
    move_type: 'entry', state: 'posted', journal_id: bankJournal.id, date: '2026-01-10', invoice_date: '2026-01-10', name: 'BNK1/2026/0001', line_ids: lines,
  });
  // Eligible entry in sales journal
  const inv2026 = create(b2026.db, 'account.move', {
    move_type: 'entry', state: 'posted', journal_id: saleJournal.id, date: '2026-01-10', invoice_date: '2026-01-10', name: 'INV/2026/0001', line_ids: lines,
  });
  db = inv2026.db;

  const analysis = analyzeJournalChains(db, { companyId: 1, hashDate: '2026-01-31' });
  assert.ok(!analysis.move_to_hash_ids.includes(b2025Id), 'unreconciled 2025 entry excluded');
  assert.ok(!analysis.move_to_hash_ids.includes(b2026.id), 'later 2026 prefix in same journal deferred');
  assert.ok(analysis.move_to_hash_ids.includes(inv2026.id), 'other journal remains eligible');
  const dangerWarn = analysis.warning_items.find((w) => w.key === 'account_unreconciled_bank_statement_line_ids');
  assert.ok(dangerWarn?.message.includes('BNK1/2025/'), 'warns on unreconciled prefix');
  assert.ok(dangerWarn?.message.includes('BNK1/2026/'), 'explains deferred later prefix');

  const wizModel = models['account.secure.entries.wizard'];
  const wiz = create(db, 'account.secure.entries.wizard', { company: 1, hash_date: '2026-01-31' });
  const secureBtn = wizModel.form.buttons.find((b) => b.label === 'Secure Entries');
  const res = secureBtn.run(wiz.db, read(wiz.db, 'account.secure.entries.wizard', wiz.id));

  assert.ok(read(res.db, 'account.move', inv2026.id).inalterable_hash, 'sales entry secured');
  assert.equal(read(res.db, 'account.move', b2025Id).inalterable_hash ?? null, null, '2025 bank entry left unsecured');
  assert.equal(read(res.db, 'account.move', b2026.id).inalterable_hash ?? null, null, '2026 bank entry left unsecured');

  const synced = applyDiff(db, diffDb(db, res.db), { isAdmin: true });
  assert.equal(checkInalterability(synced, { journalId: saleJournal.id, companyId: 1 })[0].status, 'ok');
});

test('securing an entry dated after hash_date caps hard_lock_date and draft checks at hash_date', () => {
  let db = seed();
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  const generalJournal = search(db, 'account.journal').find((j) => j.type === 'general' && !j.restrict_mode_hash_table);
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].filter((m) => m.journal_id !== saleJournal.id) } };
  const accounts = search(db, 'account.account');
  const lines = [
    { account_id: accounts.find((a) => a.code === '600000').id, debit: 100, credit: 0 },
    { account_id: accounts.find((a) => a.code === '211000').id, debit: 0, credit: 100 },
  ];

  db = write(db, 'account.journal', saleJournal.id, { restrict_mode_hash_table: true });
  const m1 = create(db, 'account.move', { move_type: 'entry', state: 'posted', journal_id: saleJournal.id, invoice_date: '2026-01-20', name: 'INV/2026/0001', line_ids: lines });
  const m2 = create(m1.db, 'account.move', { move_type: 'entry', state: 'posted', journal_id: saleJournal.id, invoice_date: '2026-01-10', name: 'INV/2026/0002', line_ids: lines });
  // Draft dated between chosen hash_date (2026-01-10) and m1's date (2026-01-20)
  const draftMid = create(m2.db, 'account.move', {
    move_type: 'entry', state: 'draft', journal_id: generalJournal.id, date: '2026-01-15', invoice_date: '2026-01-15', line_ids: lines,
  });
  db = draftMid.db;

  const analysis = analyzeJournalChains(db, { companyId: 1, hashDate: '2026-01-10' });
  assert.ok(analysis.move_to_hash_ids.includes(m1.id) && analysis.move_to_hash_ids.includes(m2.id));
  assert.ok(!analysis.not_hashable_unlocked_move_ids.includes(draftMid.id), 'draft after hash_date is not blocking');

  const wizModel = models['account.secure.entries.wizard'];
  const wiz = create(db, 'account.secure.entries.wizard', { company: 1, hash_date: '2026-01-10' });
  const secureBtn = wizModel.form.buttons.find((b) => b.label === 'Secure Entries');
  const res = secureBtn.run(wiz.db, read(wiz.db, 'account.secure.entries.wizard', wiz.id));

  assert.ok(read(res.db, 'account.move', m1.id).inalterable_hash, 'm1 secured');
  assert.ok(read(res.db, 'account.move', m2.id).inalterable_hash, 'm2 secured');
  assert.equal(read(res.db, 'res.company', 1).hard_lock_date ?? null, null, 'wizard does not write hard_lock_date');

  const afterPost = postEntry(res.db, {
    journal: generalJournal.code, date: '2026-01-15', company: 1, lines: [{ account: '600000', debit: 50 }, { account: '211000', credit: 50 }],
  });
  assert.equal(read(afterPost.db, 'account.move', afterPost.id).state, 'posted', 'entries after chosen hash_date remain unlocked');
});

test('unreconciled bank lines in unrestricted journals warn and leave hard_lock_date unchanged', () => {
  let db = seed();
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  db = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].filter((m) => m.journal_id !== saleJournal.id && m.journal_id !== bankJournal.id),
    },
  };
  db = write(db, 'account.journal', saleJournal.id, { restrict_mode_hash_table: true });
  db = write(db, 'account.journal', bankJournal.id, { restrict_mode_hash_table: false });

  const accounts = search(db, 'account.account');
  const lines = [
    { account_id: accounts.find((a) => a.code === '600000').id, debit: 100, credit: 0 },
    { account_id: accounts.find((a) => a.code === '211000').id, debit: 0, credit: 100 },
  ];
  const generalJournal = search(db, 'account.journal').find((j) => j.type === 'general' && !j.restrict_mode_hash_table);
  const clean = create(db, 'account.move', { move_type: 'entry', state: 'posted', journal_id: generalJournal.id, invoice_date: '2026-01-10', name: 'MISC/2026/9001', line_ids: lines });
  const inv = create(clean.db, 'account.move', { move_type: 'entry', state: 'posted', journal_id: saleJournal.id, invoice_date: '2026-01-10', name: 'INV/2026/0001', line_ids: lines });
  const expAcc = accounts.find((a) => a.account_type === 'expense' && (a.company_id ?? 1) === 1);
  // Both an unbooked and a partially-booked unreconciled statement line on the UNRESTRICTED bank journal
  const stmtUnbooked = create(inv.db, 'account.bank.statement.line', {
    journal_id: bankJournal.id, date: '2026-01-05', payment_ref: 'Unrestricted unbooked', amount: 50, company_id: 1,
  });
  const stmtPartial = create(stmtUnbooked.db, 'account.bank.statement.line', {
    journal_id: bankJournal.id, date: '2026-01-06', payment_ref: 'Unrestricted partial', amount: -100, counterpart_account_id: expAcc.id, company_id: 1,
  });
  db = bookToAccount(stmtPartial.db, read(stmtPartial.db, 'account.bank.statement.line', stmtPartial.id), { amount: 40 }).db;

  const analysis = analyzeJournalChains(db, { companyId: 1, hashDate: '2026-01-31' });
  assert.ok(analysis.unreconciled_bank_statement_line_ids.includes(stmtPartial.id), 'unreconciled unrestricted bank chain is reported');
  assert.ok(analysis.warning_items.some((w) => w.key === 'account_unreconciled_bank_statement_line_ids' && w.level === 'danger'), 'danger warning emitted');
  const bankMove = read(db, 'account.bank.statement.line', stmtPartial.id).bank_move_id;
  assert.ok(bankMove, 'partially booked line has a posted move');
  assert.ok(!analysis.move_to_hash_ids.includes(bankMove), 'unreconciled chain is excluded');

  const wizModel = models['account.secure.entries.wizard'];
  const wiz = create(db, 'account.secure.entries.wizard', { company: 1, hash_date: '2026-01-31' });
  const secureBtn = wizModel.form.buttons.find((b) => b.label === 'Secure Entries');
  const res = secureBtn.run(wiz.db, read(wiz.db, 'account.secure.entries.wizard', wiz.id));

  assert.ok(read(res.db, 'account.move', inv.id).inalterable_hash, 'sales entry secured');
  assert.ok(read(res.db, 'account.move', clean.id).inalterable_hash, 'eligible unrestricted entry secured');
  const synced = applyDiff(wiz.db, diffDb(wiz.db, res.db), { isAdmin: true });
  assert.ok(read(synced, 'account.move', clean.id).inalterable_hash, 'unrestricted hash survives server validation');
  // Odoo's action_secure_entries only hashes moves (account_secure_entries_wizard.py:241-250) and never writes hard_lock_date,
  // so unreconciled lines cannot "skip" it. Setting the hard lock is a separate write guarded by company.py:634-640, 681-686.
  assert.equal(read(res.db, 'res.company', 1).hard_lock_date ?? null, null, 'wizard leaves hard_lock_date unchanged');
  assert.throws(() => write(res.db, 'res.company', 1, { hard_lock_date: '2026-01-10' }), /unreconciled bank transactions/, 'hard lock validation still refuses unreconciled lines');
});

test('later-dated numbered draft preceding newly secured entries blocks wizard and secureEntries until resolved, while keeping selected-date cap for unrelated drafts and hard lock', () => {
  let db = seed();
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  const generalJournal = search(db, 'account.journal').find((j) => j.type === 'general' && !j.restrict_mode_hash_table);
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].filter((m) => m.journal_id !== saleJournal.id) } };
  const accounts = search(db, 'account.account');
  const lines = [
    { account_id: accounts.find((a) => a.code === '600000').id, debit: 100, credit: 0 },
    { account_id: accounts.find((a) => a.code === '211000').id, debit: 0, credit: 100 },
  ];

  // Enable restrict_mode_hash_table only after posting and resetting a later-dated entry (retained number)
  const m1 = create(db, 'account.move', { move_type: 'entry', state: 'posted', journal_id: saleJournal.id, date: '2026-01-20', invoice_date: '2026-01-20', name: 'INV/2026/0001', line_ids: lines });
  const m2 = create(m1.db, 'account.move', { move_type: 'entry', state: 'posted', journal_id: saleJournal.id, date: '2026-01-18', invoice_date: '2026-01-18', name: 'INV/2026/0002', line_ids: lines });
  const m3 = create(m2.db, 'account.move', { move_type: 'entry', state: 'posted', journal_id: saleJournal.id, date: '2026-01-10', invoice_date: '2026-01-10', name: 'INV/2026/0003', line_ids: lines });
  const m4 = create(m3.db, 'account.move', { move_type: 'entry', state: 'posted', journal_id: saleJournal.id, date: '2026-01-22', invoice_date: '2026-01-22', name: 'INV/2026/0004', line_ids: lines });
  db = m4.db;

  const resetBtn = models['account.move'].form.buttons.find((b) => b.label === 'Reset to Draft');
  db = resetBtn.run(db, read(db, 'account.move', m2.id)).db;
  db = resetBtn.run(db, read(db, 'account.move', m4.id)).db;
  db = write(db, 'account.journal', saleJournal.id, { restrict_mode_hash_table: true });

  // Unrelated later-dated drafts: unnumbered in same journal + draft in unrestricted journal
  const draftUnnumbered = create(db, 'account.move', { move_type: 'entry', state: 'draft', journal_id: saleJournal.id, date: '2026-01-25', invoice_date: '2026-01-25', name: '/', line_ids: lines });
  const draftUnrestricted = create(draftUnnumbered.db, 'account.move', { move_type: 'entry', state: 'draft', journal_id: generalJournal.id, date: '2026-01-15', invoice_date: '2026-01-15', name: '/', line_ids: lines });
  db = draftUnrestricted.db;

  // Analyzing with hashDate=2026-01-10: m1 (2026-01-20) and m3 (2026-01-10) are in move_to_hash_ids,
  // and later-dated retained draft m2 (INV/2026/0002) MUST block while unrelated drafts do NOT.
  const analysis = analyzeJournalChains(db, { companyId: 1, hashDate: '2026-01-10' });
  assert.ok(analysis.move_to_hash_ids.includes(m1.id) && analysis.move_to_hash_ids.includes(m3.id));
  assert.ok(analysis.not_hashable_unlocked_move_ids.includes(m2.id), 'later-dated numbered draft before last secured entry is detected');
  assert.ok(!analysis.not_hashable_unlocked_move_ids.includes(m4.id), 'numbered draft sorting after last secured entry is not blocking');
  assert.ok(!analysis.not_hashable_unlocked_move_ids.includes(draftUnnumbered.id), 'unnumbered later-dated draft is not blocking');
  assert.ok(!analysis.not_hashable_unlocked_move_ids.includes(draftUnrestricted.id), 'unrestricted later-dated draft is not blocking');
  const draftWarn = analysis.warning_items.find((w) => w.key === 'account_unhashed_draft_entries');
  assert.ok(draftWarn && draftWarn.go.includes(String(m2.id)), 'wizard warning surfaces conflicting draft');

  const wizModel = models['account.secure.entries.wizard'];
  const wiz = create(db, 'account.secure.entries.wizard', { company: 1, hash_date: '2026-01-10' });
  const wizRec = read(wiz.db, 'account.secure.entries.wizard', wiz.id);
  const secureBtn = wizModel.form.buttons.find((b) => b.label === 'Secure Entries');
  assert.equal(secureBtn.when(wizRec, wiz.db), false, 'wizard confirmation prevented');
  assert.throws(() => secureBtn.run(wiz.db, wizRec), /not available/i);
  assert.throws(() => secureEntries(db, { companyId: 1, hashDate: '2026-01-10', moveIds: [m1.id, m3.id] }), /draft/i, 'direct secureEntries blocks on conflicting later-dated draft');

  // Direct secureEntries without moveIds when earlier posted entries are all <= hashDate also blocks on m2
  let directDb = resetBtn.run(db, read(db, 'account.move', m1.id)).db;
  directDb = write(directDb, 'account.move', m1.id, { date: '2026-01-05', invoice_date: '2026-01-05' });
  directDb = postMove(directDb, m1.id);
  assert.throws(() => secureEntries(directDb, { companyId: 1, hashDate: '2026-01-10' }), /draft/i, 'direct secureEntries without moveIds also blocks on conflicting later-dated draft');

  // Resolve conflict by reposting m2; confirmation succeeds and hard_lock_date stays capped at 2026-01-10
  db = postMove(db, m2.id);
  const resolvedAnalysis = analyzeJournalChains(db, { companyId: 1, hashDate: '2026-01-10' });
  assert.deepEqual(resolvedAnalysis.not_hashable_unlocked_move_ids, []);
  const wiz2 = create(db, 'account.secure.entries.wizard', { company: 1, hash_date: '2026-01-10' });
  const wiz2Rec = read(wiz2.db, 'account.secure.entries.wizard', wiz2.id);
  assert.equal(secureBtn.when(wiz2Rec, wiz2.db), true, 'confirmation unblocked after reposting conflicting draft');
  const securedRes = secureBtn.run(wiz2.db, wiz2Rec);

  assert.ok(read(securedRes.db, 'account.move', m1.id).inalterable_hash, 'm1 secured');
  assert.ok(read(securedRes.db, 'account.move', m2.id).inalterable_hash, 'm2 secured');
  assert.ok(read(securedRes.db, 'account.move', m3.id).inalterable_hash, 'm3 secured');
  assert.equal(read(securedRes.db, 'res.company', 1).hard_lock_date ?? null, null, 'wizard does not write hard_lock_date');

  // Unrelated later-dated drafts (including m4 after INV/2026/0003) can still be posted normally
  const afterM4 = postMove(securedRes.db, m4.id);
  assert.equal(read(afterM4, 'account.move', m4.id).state, 'posted');
  const afterUnrestricted = postMove(afterM4, draftUnrestricted.id);
  assert.equal(read(afterUnrestricted, 'account.move', draftUnrestricted.id).state, 'posted');
});

test('wizard secures a posted move resolved to an unrestricted default journal', () => {
  let db = seed();
  const journal = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id ?? 1) === 1);
  db = write(db, 'account.journal', journal.id, { restrict_mode_hash_table: false });
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.bank.statement.line': [] } };
  const draft = create(db, 'account.move', { company_id: 1, journal_id: journal.id, partner_id: 1, move_type: 'out_invoice', invoice_date: '2026-01-10', invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100 }] });
  const posted = postMove(draft.db, draft.id);
  const move = { db: { ...posted, records: { ...posted.records, 'account.move': posted.records['account.move'].map((m) => m.id === draft.id ? { ...m, journal_id: null } : m) } }, id: draft.id };
  const analysis = analyzeJournalChains(move.db, { companyId: 1, hashDate: '2026-01-31' });
  assert.ok(analysis.move_to_hash_ids.includes(move.id));
  const result = secureEntries(move.db, { companyId: 1, hashDate: '2026-01-31', moveIds: analysis.move_to_hash_ids });
  assert.ok(read(result, 'account.move', move.id).inalterable_hash);
});

test('securing a period scopes shifted invoices by accounting date', () => {
  let db = seed();
  const journal = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id ?? 1) === 1);
  db = write(db, 'account.journal', journal.id, { restrict_mode_hash_table: true });
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.bank.statement.line': [] } };
  const move = { db: { ...db, records: { ...db.records, 'account.move': [{ id: 90001, company_id: 1, journal_id: journal.id, move_type: 'out_invoice', state: 'posted', name: 'INV/2026/00001', date: '2026-02-01', invoice_date: '2026-01-15', line_ids: [] }] } }, id: 90001 };
  const analysis = analyzeJournalChains(move.db, { companyId: 1, hashDate: '2026-01-31' });
  assert.ok(!analysis.move_to_hash_ids.includes(move.id));
  assert.equal(analysis.max_hash_date, '2026-02-01');
  const result = secureEntries(move.db, { companyId: 1, hashDate: '2026-01-31', moveIds: analysis.move_to_hash_ids });
  assert.ok(!read(result, 'account.move', move.id).inalterable_hash);
  const direct = secureEntries(move.db, { companyId: 1, hashDate: '2026-01-31' });
  assert.ok(!read(direct, 'account.move', move.id).inalterable_hash);
});
