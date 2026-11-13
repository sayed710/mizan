import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor, models } from './models/index.js';
import { postAutoPostMoves, postMove } from './models/accounting.js';
import { applyPaymentCredit, postPayment, reverseEntry } from './models/pay.js';
import { bookBankMovement } from './models/bank.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const classOf = (node) => props(node)?.className ?? node?.className ?? '';
const hasClass = (node, cls) => typeof classOf(node) === 'string' && classOf(node).split(/\s+/).includes(cls);
const allFind = (root, pred, out = []) => {
  if (!root) return out;
  if (pred(root)) out.push(root);
  for (const child of root.childNodes ?? []) allFind(child, pred, out);
  return out;
};
const fieldLabelsOf = (container) => allFind(container, (n) => hasClass(n, 'field'))
  .map((f) => f.childNodes[0]?.textContent?.replaceAll('*', '').trim());
const headerButtonLabels = (host) => allFind(
  find(find(host, (n) => hasClass(n, 'form-header')), (n) => hasClass(n, 'row')),
  (n) => n.tagName === 'BUTTON',
).map((n) => n.textContent.trim());
const statusLabels = (host) => allFind(
  find(host, (n) => n.tagName === 'OL' && hasClass(n, 'statusbar')),
  (n) => n.tagName === 'LI',
).map((n) => n.textContent.trim());
const smartButtonsOf = (host) => allFind(
  find(host, (n) => hasClass(n, 'smart-buttons')),
  (n) => n.tagName === 'A' && hasClass(n, 'smart'),
).map((a) => ({
  href: props(a)?.href ?? '',
  text: a.textContent.trim(),
  label: find(a, (n) => n.tagName === 'SPAN')?.textContent?.trim() ?? '',
  val: find(a, (n) => n.tagName === 'B')?.textContent?.trim() ?? '',
}));

const leafFor = (sectionLabel, key) => {
  const top = menusFor('accounting').find((m) => m.label === sectionLabel);
  const direct = top.children.find((c) => c.key === key);
  if (direct) return direct;
  for (const child of top.children) {
    const nested = child.children?.find((c) => c.key === key);
    if (nested) return nested;
  }
  return null;
};

async function mountMoveForm({ leaf, id, db: initialDb }) {
  const prevStorage = globalThis.localStorage;
  const prevLocation = globalThis.location;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
  setupDom();
  globalThis.location = { hash: `#/accounting/${leaf.key}/${id}` };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { FormView } = await import('./views/FormView.jsx');
  await initStore();
  await commit(initialDb ?? seed());
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const params = new URLSearchParams('view=form');
  const render = async (renderId = id, renderLeaf = leaf) => {
    await React.act(async () => root.render(React.createElement(FormView, {
      leaf: renderLeaf,
      id: renderId,
      base: `#/accounting/${renderLeaf.key}`,
      params,
    })));
  };
  await render();
  return {
    React,
    host,
    render,
    commit,
    getDb,
    storage: mem,
    done: async () => {
      await React.act(async () => root.unmount());
      globalThis.localStorage = prevStorage;
      globalThis.location = prevLocation;
    },
  };
}

test('manual journal entry form (Accounting > Accounting > Journal Entries): main groups, tabs, columns, warning and table totals', async () => {
  const leaf = leafFor('Accounting', 'entries');
  assert.ok(leaf, 'Journal Entries leaf exists under Accounting > Accounting');

  let db = seed();
  const c2 = create(db, 'res.company', { name: 'Second Branch' });
  db = c2.db;
  const c2Journal = create(db, 'account.journal', { name: 'Other Company Journal', code: 'OCJ', type: 'general', company_id: c2.id });
  db = c2Journal.db;
  const saleJournal = search(db, 'account.journal').find((j) => (j.company_id ?? 1) === 1 && j.type === 'sale');
  const bankJournal = search(db, 'account.journal').find((j) => (j.company_id ?? 1) === 1 && j.type === 'bank');
  const miscJournal = search(db, 'account.journal').find((j) => (j.company_id ?? 1) === 1 && j.type === 'general');
  const expAcc = search(db, 'account.account').find((a) => (a.company_id ?? 1) === 1 && a.account_type === 'expense');
  const arAcc = search(db, 'account.account').find((a) => (a.company_id ?? 1) === 1 && a.account_type === 'asset_receivable');

  const ctx = await mountMoveForm({ leaf, id: 'new', db });
  try {
    const groups = allFind(ctx.host, (n) => n.tagName === 'DIV' && hasClass(n, 'group'));
    assert.equal(groups.length, 2, 'main sheet has left and right groups');
    assert.deepEqual(fieldLabelsOf(groups[0]), ['Reference']);
    assert.deepEqual(fieldLabelsOf(groups[1]), ['Accounting Date', 'Journal']);

    // New entry shows only Post button (Cancel Entry requires an id), and Draft / Posted statusbar (no Cancelled).
    assert.deepEqual(headerButtonLabels(ctx.host), ['Post']);
    assert.deepEqual(statusLabels(ctx.host), ['Draft', 'Posted']);

    // Journal dropdown lists own-company journals (including sale/bank/general) and excludes other-company journal.
    const jSelect = find(groups[1], (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-journal_id');
    const jOptionNames = allFind(jSelect, (n) => n.tagName === 'OPTION').map((o) => o.textContent.trim());
    assert.ok(jOptionNames.includes(miscJournal.name));
    assert.ok(jOptionNames.includes(saleJournal.name));
    assert.ok(jOptionNames.includes(bankJournal.name));
    assert.ok(!jOptionNames.includes('Other Company Journal'));

    // Notebook tabs: Journal Items and Other Info.
    const tabLabels = allFind(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'tab').map((n) => n.textContent.trim());
    assert.deepEqual(tabLabels, ['Journal Items', 'Other Info']);

    // Journal Items columns: Account, Partner, Label, Due Date, Taxes, Debit, Credit; optional Tax Grids and Discount Date hidden.
    const ths = () => allFind(ctx.host, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th')).map((n) => n.textContent.trim());
    assert.deepEqual(ths(), ['Account', 'Partner', 'Label', 'Due Date', 'Taxes', 'Debit', 'Credit']);

    const optToggle = find(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Optional columns');
    assert.ok(optToggle, 'optional columns menu present on Journal Items lines');
    await ctx.React.act(async () => props(optToggle).onClick());
    const optItems = allFind(ctx.host, (n) => props(n)?.role === 'menuitemcheckbox');
    assert.deepEqual(optItems.map((n) => n.textContent.trim()), ['Currency', 'Amount in Currency', 'Tax Grids', 'Discount Date']);
    assert.deepEqual(optItems.map((n) => props(n)?.['aria-checked']), [false, false, false, false]);
    await ctx.React.act(async () => props(optItems[2]).onClick());
    assert.deepEqual(ths(), ['Account', 'Partner', 'Label', 'Due Date', 'Taxes', 'Debit', 'Credit', 'Tax Grids']);

    // Journal Items editable in draft.
    assert.ok(find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Add a line')));

    // Unbalanced saved draft shows visible warning, footer totals, tfoot totals, and refuses Post.
    const unbal = create(ctx.getDb(), 'account.move', {
      move_type: 'entry',
      journal_id: miscJournal.id,
      date: '2026-04-01',
      ref: 'UNBAL-1',
      line_ids: [
        { account_id: expAcc.id, name: 'Dr only', debit: 120, credit: 0 },
        { account_id: arAcc.id, name: 'Short Cr', debit: 0, credit: 90 },
      ],
    });
    await ctx.commit(unbal.db);
    await ctx.render(unbal.id);

    const warn = find(ctx.host, (n) => hasClass(n, 'alert-warning'));
    assert.ok(warn && warn.textContent.includes('not balanced'), 'visible warning shown when entry is unbalanced');

    const tfootTexts = allFind(find(ctx.host, (n) => n.tagName === 'TFOOT'), (n) => n.tagName === 'TD').map((td) => td.textContent.trim());
    assert.ok(tfootTexts.some((txt) => txt.includes('120')));
    assert.ok(tfootTexts.some((txt) => txt.includes('90')));

    assert.equal(find(ctx.host, (n) => n.tagName === 'DL' && hasClass(n, 'totals')), null, 'totals appear once, under the Journal Items table, as in Odoo');

    const postBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Post');
    await ctx.React.act(async () => props(postBtn).onClick());
    const errAlert = find(ctx.host, (n) => hasClass(n, 'alert') && !hasClass(n, 'alert-warning'));
    assert.ok(errAlert, 'posting an unbalanced entry is refused');
    assert.equal(read(ctx.getDb(), 'account.move', unbal.id).state, 'draft');
  } finally {
    await ctx.done();
  }
});

test('header buttons per state, Lock hashing, Reset to Draft locks, Reverse Entry wizard, Cancel Entry and Other Info fields', async () => {
  const leaf = leafFor('Accounting', 'entries');
  let db = seed();
  const restrictedJ = create(db, 'account.journal', {
    name: 'Restricted General',
    code: 'RGEN',
    type: 'general',
    company_id: 1,
    restrict_mode_hash_table: true,
  });
  db = restrictedJ.db;
  const miscJ = search(db, 'account.journal').find((j) => (j.company_id ?? 1) === 1 && j.type === 'general' && !j.restrict_mode_hash_table);
  const expAcc = search(db, 'account.account').find((a) => (a.company_id ?? 1) === 1 && a.account_type === 'expense');
  const arAcc = search(db, 'account.account').find((a) => (a.company_id ?? 1) === 1 && a.account_type === 'asset_receivable');
  const partner = search(db, 'res.partner')[0];

  // Saved balanced draft in restricted journal.
  const m1 = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: restrictedJ.id,
    date: '2026-04-05',
    invoice_date: '2026-04-05',
    ref: 'JE-HASH',
    auto_post: 'at_date',
    auto_post_until: '2026-12-31',
    line_ids: [
      { account_id: expAcc.id, partner_id: partner.id, name: 'Rent', debit: 200, credit: 0 },
      { account_id: arAcc.id, partner_id: partner.id, name: 'Accrual', debit: 0, credit: 200 },
    ],
  });
  db = m1.db;

  // Normal draft entry for Cancel Entry and Reverse/Reset flows.
  const m2 = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: miscJ.id,
    date: '2026-04-06',
    invoice_date: '2026-04-06',
    ref: 'JE-FLOW',
    line_ids: [
      { account_id: expAcc.id, name: 'Fee', debit: 75, credit: 0 },
      { account_id: arAcc.id, name: 'AP/AR', debit: 0, credit: 75 },
    ],
  });
  db = m2.db;

  const ctx = await mountMoveForm({ leaf, id: m1.id, db });
  try {
    // Draft with id: Post + Cancel Entry.
    assert.deepEqual(headerButtonLabels(ctx.host), ['Post', 'Cancel Entry']);
    assert.deepEqual(statusLabels(ctx.host), ['Draft', 'Posted']);
    assert.equal(find(ctx.host, (n) => hasClass(n, 'alert-warning')), null);

    // Check Other Info tab on m1: auto_post options and auto_post_until hidden for 'at_date', shown for monthly/quarterly/yearly.
    const openOtherInfo = async () => {
      const tab = find(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'tab' && n.textContent.trim() === 'Other Info');
      await ctx.React.act(async () => props(tab).onClick());
    };
    await openOtherInfo();
    const otherPanel = () => find(ctx.host, (n) => props(n)?.role === 'tabpanel');
    const autoPostSel = find(otherPanel(), (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-auto_post');
    const autoPostOpts = allFind(autoPostSel, (n) => n.tagName === 'OPTION')
      .map((o) => [props(o)?.value, o.textContent.trim()])
      .filter(([v]) => v !== '');
    assert.deepEqual(autoPostOpts, [
      ['no', 'No'],
      ['at_date', 'At Date'],
      ['monthly', 'Monthly'],
      ['quarterly', 'Quarterly'],
      ['yearly', 'Yearly'],
    ]);
    assert.deepEqual(fieldLabelsOf(otherPanel()), ['Auto-post', 'Reverse Automatically', 'Fiscal Position', 'Currency', 'Terms and Conditions']);

    // Switching Auto-post to monthly reveals Auto-post until, and hides it again for quarterly -> at_date -> monthly order.
    await ctx.React.act(async () => props(autoPostSel).onChange({ target: { value: 'monthly' } }));
    assert.ok(fieldLabelsOf(otherPanel()).includes('Auto-post until'));
    await ctx.React.act(async () => props(autoPostSel).onChange({ target: { value: 'quarterly' } }));
    assert.ok(fieldLabelsOf(otherPanel()).includes('Auto-post until'));
    await ctx.React.act(async () => props(autoPostSel).onChange({ target: { value: 'yearly' } }));
    assert.ok(fieldLabelsOf(otherPanel()).includes('Auto-post until'));
    await ctx.React.act(async () => props(autoPostSel).onChange({ target: { value: 'no' } }));
    assert.ok(!fieldLabelsOf(otherPanel()).includes('Auto-post until'));
    const noBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Discard');
    await ctx.React.act(async () => props(noBtn).onClick());

    // Post m1: state becomes posted, Journal Items becomes readonly, buttons become Reverse Entry, Reset to Draft, Lock.
    await ctx.React.act(async () => props(find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Post')).onClick());
    assert.equal(read(ctx.getDb(), 'account.move', m1.id).state, 'posted');
    assert.deepEqual(headerButtonLabels(ctx.host), ['Reverse Entry', 'Reset to Draft', 'Lock']);

    const jiTab = find(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'tab' && n.textContent.trim() === 'Journal Items');
    await ctx.React.act(async () => props(jiTab).onClick());
    assert.equal(find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Add a line')), null, 'posted Journal Items are readonly');

    // Click Lock -> secureEntries hashes m1 -> Lock and Reset to Draft disappear.
    await ctx.React.act(async () => props(find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Lock')).onClick());
    const hashed = read(ctx.getDb(), 'account.move', m1.id);
    assert.ok(hashed.inalterable_hash, 'Lock button computes inalterable_hash via secureEntries');
    assert.deepEqual(headerButtonLabels(ctx.host), ['Reverse Entry']);

    // Reverse Entry button opens reversal wizard and creates a reversal entry.
    await ctx.React.act(async () => props(find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Reverse Entry')).onClick());
    const wizardForm = find(ctx.host, (n) => n.tagName === 'FORM' && hasClass(n, 'wizard'));
    assert.ok(wizardForm && wizardForm.textContent.includes('Reverse Entry'), 'Reverse Entry opens reversal wizard');
    await ctx.React.act(async () => props(wizardForm).onSubmit({ preventDefault: () => {} }));
    const revEntry = search(ctx.getDb(), 'account.move').find((m) => m.reversed_entry_id === m1.id);
    assert.ok(revEntry, 'reversal wizard created reversal entry');

    // Open the reversal entry: Other Info shows Reversal of (readonly), and Reversed Entry smart button is present.
    await ctx.render(revEntry.id);
    await openOtherInfo();
    assert.ok(fieldLabelsOf(otherPanel()).includes('Reversal of'));
    assert.equal(find(otherPanel(), (n) => props(n)?.id === 'f-reversed_entry_id'), null, 'Reversal of is readonly');
    assert.ok(smartButtonsOf(ctx.host).some((b) => b.label === 'Reversed Entry' && b.href === `#/accounting/entries/${m1.id}`));

    // On m2: test Post -> Reset to Draft -> Lock date hiding Reset to Draft -> Cancel Entry & Cancelled statusbar.
    await ctx.render(m2.id);
    assert.deepEqual(headerButtonLabels(ctx.host), ['Post', 'Cancel Entry']);
    await ctx.React.act(async () => props(find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Post')).onClick());
    assert.deepEqual(headerButtonLabels(ctx.host), ['Reverse Entry', 'Reset to Draft']);

    // Reset to Draft succeeds when period is unlocked, then Cancel Entry sets Cancelled statusbar.
    await ctx.React.act(async () => props(find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Reset to Draft')).onClick());
    assert.equal(read(ctx.getDb(), 'account.move', m2.id).state, 'draft');
    await ctx.React.act(async () => props(find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Cancel Entry')).onClick());
    assert.equal(read(ctx.getDb(), 'account.move', m2.id).state, 'cancel');
    assert.deepEqual(statusLabels(ctx.host), ['Draft', 'Posted', 'Cancelled']);
    assert.deepEqual(headerButtonLabels(ctx.host), ['Reset to Draft']);

    // Re-open m2 -> Reset to Draft -> Post -> lock fiscal period: Reset to Draft must disappear.
    await ctx.React.act(async () => props(find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Reset to Draft')).onClick());
    await ctx.React.act(async () => props(find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Post')).onClick());
    await ctx.React.act(async () => ctx.commit(write(ctx.getDb(), 'res.company', 1, { hard_lock_date: '2026-04-30' })));
    await ctx.render(m2.id);
    assert.deepEqual(headerButtonLabels(ctx.host), ['Reverse Entry']);
  } finally {
    await ctx.done();
  }
});

test('smart buttons cover Reversal Entries, Payments, Reconciled items, Adjusting Entries, Deferrals, Tax Return and Bank transaction when applicable', async () => {
  const leaf = leafFor('Accounting', 'entries');
  let db = seed();
  const miscJ = search(db, 'account.journal').find((j) => (j.company_id ?? 1) === 1 && j.type === 'general');
  const bankJ = search(db, 'account.journal').find((j) => (j.company_id ?? 1) === 1 && j.type === 'bank');
  const expAcc = search(db, 'account.account').find((a) => (a.company_id ?? 1) === 1 && a.account_type === 'expense');
  const arAcc = search(db, 'account.account').find((a) => (a.company_id ?? 1) === 1 && a.account_type === 'asset_receivable');
  const apAcc = search(db, 'account.account').find((a) => (a.company_id ?? 1) === 1 && a.account_type === 'liability_payable');
  const partner = search(db, 'res.partner')[0];

  // 1) Plain entry has NO smart buttons.
  const plain = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: miscJ.id,
    date: '2026-04-02',
    line_ids: [
      { account_id: expAcc.id, name: 'Plain Dr', debit: 50, credit: 0 },
      { account_id: arAcc.id, name: 'Plain Cr', debit: 0, credit: 50 },
    ],
  });
  db = postMove(plain.db, plain.id);

  // 2) Posted entry with Reversal Entries, Adjusting Entries, and 2 Deferrals.
  const srcEntry = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: miscJ.id,
    date: '2026-04-03',
    line_ids: [
      { account_id: expAcc.id, name: 'Src Dr', debit: 300, credit: 0 },
      { account_id: apAcc.id, name: 'Src Cr', debit: 0, credit: 300 },
    ],
  });
  db = postMove(srcEntry.db, srcEntry.id);
  db = reverseEntry(db, read(db, 'account.move', srcEntry.id), { date: '2026-04-04', mode: 'reverse', reason: 'Fix' }).db;
  const adj = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: miscJ.id,
    date: '2026-04-04',
    deferred_adjustment_of_id: srcEntry.id,
    line_ids: [
      { account_id: expAcc.id, name: 'Adj Dr', debit: 100, credit: 0 },
      { account_id: apAcc.id, name: 'Adj Cr', debit: 0, credit: 100 },
    ],
  });
  db = postMove(adj.db, adj.id);
  const def1 = create(db, 'account.deferral', {
    name: 'Def 1',
    deferral_type: 'expense',
    source_move_id: srcEntry.id,
    total_amount: 100,
    start_date: '2026-04-01',
    end_date: '2026-06-30',
    recognition_account_id: expAcc.id,
    deferred_account_id: arAcc.id,
    board: [],
  });
  db = def1.db;
  const def2 = create(db, 'account.deferral', {
    name: 'Def 2',
    deferral_type: 'expense',
    total_amount: 200,
    start_date: '2026-04-01',
    end_date: '2026-06-30',
    recognition_account_id: expAcc.id,
    deferred_account_id: arAcc.id,
    board: [{ move_id: srcEntry.id }],
  });
  db = def2.db;
  db = create(db, 'account.deferral', {
    name: 'Def Other',
    deferral_type: 'expense',
    source_move_id: 999999,
    total_amount: 50,
    start_date: '2026-04-01',
    end_date: '2026-06-30',
    recognition_account_id: expAcc.id,
    deferred_account_id: arAcc.id,
    board: [],
  }).db;

  // Verify ActionView parseRel + actionRecords filter account.deferral by move_id:srcEntry.id cleanly (2 linked, excluding Def Other).
  const { actionRecords, parseRel } = await import('./views/ActionView.jsx');
  const defRel = parseRel(db, 'account.deferral', `move_id:${srcEntry.id}`);
  assert.equal(actionRecords(db, { model: 'account.deferral' }, defRel).length, 2);

  // 3) Posted payment creates a posted entry with Payments smart button.
  const pay = create(db, 'account.payment', {
    name: '/',
    state: 'draft',
    payment_type: 'inbound',
    partner_type: 'customer',
    partner_id: partner.id,
    amount: 150,
    date: '2026-04-05',
    journal_id: bankJ.id,
  });
  db = postPayment(pay.db, read(pay.db, 'account.payment', pay.id));
  const payRec = read(db, 'account.payment', pay.id);

  // 4) Posted invoice reconciled with payRec.move_id -> Reconciled items smart button + JournalItems filter.
  const saleJ = search(db, 'account.journal').find((j) => (j.company_id ?? 1) === 1 && j.type === 'sale');
  const incAcc = search(db, 'account.account').find((a) => (a.company_id ?? 1) === 1 && a.account_type === 'income');
  const recInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    journal_id: saleJ.id,
    invoice_date: '2026-04-06',
    date: '2026-04-06',
    ref: 'REC-INV',
    invoice_line_ids: [{ name: 'Consulting', account_id: incAcc.id, qty: 1, price_unit: 150, tax: 0, tax_ids: [] }],
  });
  db = postMove(recInv.db, recInv.id);
  db = applyPaymentCredit(db, payRec.id, recInv.id, '2026-04-08');

  // 5) Closing entry of a Tax Return -> Tax Return smart button.
  const taxClose = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: miscJ.id,
    date: '2026-04-09',
    line_ids: [
      { account_id: expAcc.id, name: 'Tax close Dr', debit: 45, credit: 0 },
      { account_id: apAcc.id, name: 'Tax close Cr', debit: 0, credit: 45 },
    ],
  });
  const vatType = search(taxClose.db, 'account.return.type').find((tp) => (tp.company_id ?? 1) === 1 && tp.category === 'account_return')
    ?? search(taxClose.db, 'account.return.type')[0];
  const taxRet = create(taxClose.db, 'account.return', {
    name: 'VAT Q2',
    type_id: vatType.id,
    date_from: '2026-04-01',
    date_to: '2026-06-30',
    closing_move_ids: [taxClose.id],
    state: 'new',
  });
  db = postMove(write(taxRet.db, 'account.move', taxClose.id, { tax_return_id: taxRet.id }), taxClose.id);

  // 6) Bank statement line entry -> Bank transaction smart button.
  const stLine = create(db, 'account.bank.statement.line', {
    date: '2026-04-10',
    payment_ref: 'BANK-STMT-1',
    amount: 250,
    journal_id: bankJ.id,
  });
  const bookedBank = bookBankMovement(
    stLine.db,
    read(stLine.db, 'account.bank.statement.line', stLine.id),
    1,
    { date: '2026-04-10', openAmount: 250 },
  );
  db = bookedBank.db;

  const ctx = await mountMoveForm({ leaf, id: plain.id, db });
  try {
    assert.deepEqual(smartButtonsOf(ctx.host), [], 'plain manual entry has no smart buttons');

    await ctx.render(srcEntry.id);
    const srcSmart = smartButtonsOf(ctx.host);
    assert.ok(srcSmart.some((b) => b.label === 'Reversal Entries' && b.val === '1' && b.href === `#/accounting/entries?view=list&rel=reversed_entry_id:${srcEntry.id}`));
    assert.ok(srcSmart.some((b) => b.label === 'Adjusting Entries' && b.val === '1' && b.href === `#/accounting/entries?view=list&rel=deferred_adjustment_of_id:${srcEntry.id}`));
    assert.ok(srcSmart.some((b) => b.label === 'Deferrals' && b.val === '2' && b.href === `#/accounting/deferrals?view=list&rel=move_id:${srcEntry.id}`));

    await ctx.render(payRec.move_id);
    const paySmart = smartButtonsOf(ctx.host);
    assert.ok(paySmart.some((b) => b.label === 'Payments' && b.val === '1' && b.href === `#/accounting/payments/${payRec.id}`));
    assert.ok(paySmart.some((b) => b.label === 'Reconciled items' && b.href === `#/accounting/journal-items?reconciled_of=${payRec.move_id}`));

    await ctx.render(taxClose.id);
    assert.ok(smartButtonsOf(ctx.host).some((b) => b.label === 'Tax Return' && b.href === `#/accounting/tax-returns/${taxRet.id}`));

    await ctx.render(bookedBank.bankMoveId);
    assert.ok(smartButtonsOf(ctx.host).some((b) => b.label === 'Bank transaction' && b.href === `#/accounting/bank/${stLine.id}`));
    assert.ok(!headerButtonLabels(ctx.host).includes('Reset to Draft'), 'bank transaction entry cannot be Reset to Draft directly');
  } finally {
    await ctx.done();
  }

  // Verify JournalItems renders the matched set when ?reconciled_of=<payRec.move_id> is active.
  setupDom();
  const prevLoc = globalThis.location;
  globalThis.location = { hash: `#/accounting/journal-items?reconciled_of=${payRec.move_id}` };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { JournalItems } = await import('./views/JournalItems.jsx');
  await initStore();
  await commit(db);
  const jiHost = globalThis.document.createElement('div');
  jiHost.ownerDocument = globalThis.document;
  const jiRoot = createRoot(jiHost);
  try {
    await React.act(async () => jiRoot.render(React.createElement(JournalItems, { leaf: {} })));
    const rowsText = allFind(find(jiHost, (n) => n.tagName === 'TBODY'), (n) => n.tagName === 'TR').map((tr) => tr.textContent);
    const payMoveName = read(db, 'account.move', payRec.move_id).name;
    const invMoveName = read(db, 'account.move', recInv.id).name;
    assert.ok(rowsText.some((txt) => txt.includes(payMoveName)));
    assert.ok(rowsText.some((txt) => txt.includes(invMoveName)));
    assert.ok(!rowsText.some((txt) => txt.includes('Plain Dr')));
  } finally {
    await React.act(async () => jiRoot.unmount());
    globalThis.location = prevLoc;
  }
});

test('auto_post scheduler handles at_date, monthly, quarterly and yearly without double posting in the same period', () => {
  let db = seed();
  const miscJ = search(db, 'account.journal').find((j) => (j.company_id ?? 1) === 1 && j.type === 'general');
  const expAcc = search(db, 'account.account').find((a) => (a.company_id ?? 1) === 1 && a.account_type === 'expense');
  const apAcc = search(db, 'account.account').find((a) => (a.company_id ?? 1) === 1 && a.account_type === 'liability_payable');
  const lines = [
    { account_id: expAcc.id, name: 'Auto Dr', debit: 60, credit: 0 },
    { account_id: apAcc.id, name: 'Auto Cr', debit: 0, credit: 60 },
  ];

  // Auto-post choices match Odoo 20 specification.
  assert.deepEqual(models['account.move'].fields.auto_post.options, [
    ['no', 'No'],
    ['at_date', 'At Date'],
    ['monthly', 'Monthly'],
    ['quarterly', 'Quarterly'],
    ['yearly', 'Yearly'],
  ]);

  const mAt = create(db, 'account.move', { move_type: 'entry', journal_id: miscJ.id, date: '2026-04-01', auto_post: 'at_date', ref: 'AUTO-ONCE', line_ids: lines });
  db = mAt.db;
  const mMonthly = create(db, 'account.move', { move_type: 'entry', journal_id: miscJ.id, date: '2026-04-01', auto_post: 'monthly', auto_post_until: '2026-05-15', ref: 'AUTO-M', line_ids: lines });
  db = mMonthly.db;
  const mQuarterly = create(db, 'account.move', { move_type: 'entry', journal_id: miscJ.id, date: '2026-04-01', auto_post: 'quarterly', auto_post_until: '2026-09-01', ref: 'AUTO-Q', line_ids: lines });
  db = mQuarterly.db;
  const mYearly = create(db, 'account.move', { move_type: 'entry', journal_id: miscJ.id, date: '2026-04-01', auto_post: 'yearly', auto_post_until: '2027-06-01', ref: 'AUTO-Y', line_ids: lines });
  db = mYearly.db;

  db = postAutoPostMoves(db, '2026-04-01');
  // Re-running scheduler on the same day must be idempotent and never create a duplicate draft or double-post.
  const countBefore = search(db, 'account.move').length;
  db = postAutoPostMoves(db, '2026-04-01');
  assert.equal(search(db, 'account.move').length, countBefore);

  assert.equal(read(db, 'account.move', mAt.id).state, 'posted');
  assert.equal(read(db, 'account.move', mMonthly.id).state, 'posted');
  assert.equal(read(db, 'account.move', mQuarterly.id).state, 'posted');
  assert.equal(read(db, 'account.move', mYearly.id).state, 'posted');

  const series = (originId) => search(db, 'account.move').filter((m) => (m.auto_post_origin_id ?? m.id) === originId).map((m) => [m.date, m.state]);
  assert.deepEqual(series(mAt.id), [['2026-04-01', 'posted']]);
  assert.deepEqual(series(mMonthly.id), [['2026-04-01', 'posted'], ['2026-05-01', 'draft']]);
  assert.deepEqual(series(mQuarterly.id), [['2026-04-01', 'posted'], ['2026-07-01', 'draft']]);
  assert.deepEqual(series(mYearly.id), [['2026-04-01', 'posted'], ['2027-04-01', 'draft']]);
});

test('invoices/bills keep their form untouched and Arabic i18n covers every new entry label', async () => {
  const newLabels = [
    'Post',
    'Reverse Entry',
    'Cancel Entry',
    'Reset to Draft',
    'Lock',
    'Draft',
    'Posted',
    'Cancelled',
    'Reversal Entries',
    'Reversed Entry',
    'Payments',
    'Reconciled items',
    'Adjusting Entries',
    'Deferrals',
    'Tax Return',
    'Bank transaction',
    'Reference',
    'Accounting Date',
    'Journal',
    'Journal Items',
    'Account',
    'Partner',
    'Label',
    'Due Date',
    'Taxes',
    'Debit',
    'Credit',
    'Tax Grids',
    'Discount Date',
    'Other Info',
    'Auto-post',
    'No',
    'At Date',
    'Monthly',
    'Quarterly',
    'Yearly',
    'Auto-post until',
    'Reversal of',
    'Fiscal Position',
    'Terms and Conditions',
    'Journal entry is not balanced: total debit must equal total credit.',
  ];
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null) };
  let tAr;
  try {
    ({ t: tAr } = await import(`./i18n.js?ar=${Date.now()}`));
  } finally {
    globalThis.localStorage = prevStorage;
  }
  for (const label of newLabels) {
    const tr = tAr(label);
    assert.ok(tr && tr !== label, `Missing Arabic translation for: ${label}`);
  }

  // Verify customer invoice and vendor bill keep Confirm / Cancel / Repeat Until and their tabs.
  const invLeaf = leafFor('Customers', 'invoices');
  const billLeaf = leafFor('Vendors', 'bills');
  const db = seed();
  const invCtx = await mountMoveForm({ leaf: invLeaf, id: 'new', db });
  try {
    assert.deepEqual(headerButtonLabels(invCtx.host), ['Confirm', 'Cancel']);
    assert.deepEqual(smartButtonsOf(invCtx.host), []);
    const invTabs = allFind(invCtx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'tab').map((n) => n.textContent.trim());
    assert.deepEqual(invTabs, ['Invoice Lines', 'Journal Items', 'Payments', 'Other Info']);
  } finally {
    await invCtx.done();
  }

  const billCtx = await mountMoveForm({ leaf: billLeaf, id: 'new', db });
  try {
    assert.deepEqual(headerButtonLabels(billCtx.host), ['Confirm', 'Digitize Document', 'Cancel']);
    const groups = allFind(billCtx.host, (n) => n.tagName === 'DIV' && hasClass(n, 'group'));
    assert.deepEqual(fieldLabelsOf(groups[0]), ['Vendor']);
  } finally {
    await billCtx.done();
  }
});

test('Lock secures only the entry journal up to that entry and leaves the company lock date alone', async () => {
  const { secureEntries } = await import('./models/hash_chain.js');
  let db = seed();
  const journals = search(db, 'account.journal');
  const misc = journals.find((j) => j.type === 'general' && (j.company_id ?? 1) === 1);
  const sale = journals.find((j) => j.type === 'sale' && (j.company_id ?? 1) === 1);
  for (const j of [misc, sale]) db = write(db, 'account.journal', j.id, { restrict_mode_hash_table: true });
  const accounts = search(db, 'account.account').filter((a) => (a.company_id ?? 1) === 1);
  const [acc1, acc2] = [accounts.find((a) => a.account_type === 'expense'), accounts.find((a) => a.account_type === 'asset_current')];
  const entry = (date) => {
    const res = create(db, 'account.move', { move_type: 'entry', journal_id: misc.id, date, line_ids: [{ account_id: acc1.id, debit: 10, credit: 0 }, { account_id: acc2.id, debit: 0, credit: 10 }] });
    db = postMove(res.db, res.id);
    return res.id;
  };
  const first = entry('2026-03-01');
  const second = entry('2026-03-02');
  const inv = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 5, invoice_date: '2026-02-01', invoice_line_ids: [{ qty: 1, price_unit: 50, tax: 0 }] });
  db = postMove(inv.db, inv.id);
  const before = read(db, 'res.company', 1).hard_lock_date ?? null;

  const locked = secureEntries(db, { throughMoveId: first });
  assert.ok(read(locked, 'account.move', first).inalterable_hash);
  assert.ok(!read(locked, 'account.move', second).inalterable_hash, 'later entries of the journal stay open');
  assert.ok(!read(locked, 'account.move', inv.id).inalterable_hash, 'other journals are untouched');
  assert.equal(read(locked, 'res.company', 1).hard_lock_date ?? null, before);
});

test('manual entries keep automatic reversal and foreign currency inputs', () => {
  const def = models['account.move'];
  const otherInfo = (r) => def.form.tabs(r).find((tab) => tab.label === 'Other Info').groups.flat().map((g) => (typeof g === 'string' ? g : g.field));
  assert.ok(otherInfo({ move_type: 'entry' }).includes('auto_reverse'));
  assert.ok(otherInfo({ move_type: 'entry' }).includes('currency_id'));
  assert.ok(!otherInfo({ move_type: 'entry' }).includes('reverse_date'));
  assert.ok(otherInfo({ move_type: 'entry', auto_reverse: true }).includes('reverse_date'));
  assert.ok(otherInfo({ move_type: 'entry', auto_reverse: true }).includes('reverse_journal_id'));
  const cols = Object.fromEntries(def.fields.line_ids.columnsFor({ move_type: 'entry' }));
  assert.equal(cols.currency_id.optional, 'hide');
  assert.equal(cols.amount_currency.optional, 'hide');
});
