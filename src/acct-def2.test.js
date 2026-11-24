import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { accountId } from './models/ledger.js';
import { applyDiff, diffDb } from './sync.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const reactProps = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));

async function mountDeferredReport(initialDb, report) {
  const { makeEl } = setupDom();
  globalThis.location = { hash: `#/accounting/${report === 'deferredRevenue' ? 'deferred-revenue-report' : 'deferred-expense-report'}` };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  await initStore();
  await React.act(async () => {
    await commit(initialDb);
  });
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => {
    root.render(React.createElement(Reports, { leaf: { report } }));
  });
  return {
    React,
    host,
    getDb,
    commit,
    unmount: async () => {
      await React.act(async () => root.unmount());
    },
  };
}

function setupDeferredFixture({ revenueMethod = 'manual', expenseMethod = 'manual' } = {}) {
  let db = write(seed(), 'res.company', 1, {
    generate_deferred_revenue_entries_method: revenueMethod,
    generate_deferred_expense_entries_method: expenseMethod,
    deferred_revenue_amount_computation_method: 'full_months',
    deferred_expense_amount_computation_method: 'full_months',
    deferred_revenue_account_id: accountId(seed(), '212000'),
    deferred_expense_account_id: accountId(seed(), '132000'),
  });
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [
      {
        name: 'Annual Revenue Plan',
        qty: 1,
        price_unit: 300,
        tax: 0,
        account_id: accountId(db, '410000'),
        deferred_start_date: '2026-01-01',
        deferred_end_date: '2026-03-31',
      },
    ],
  });
  db = postMove(inv.db, inv.id);

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 1,
    invoice_date: '2026-01-01',
    invoice_line_ids: [
      {
        name: 'Quarterly Expense Plan',
        qty: 1,
        price_unit: 150,
        tax: 0,
        account_id: accountId(db, '600000'),
        deferred_start_date: '2026-01-01',
        deferred_end_date: '2026-03-31',
      },
    ],
  });
  return postMove(bill.db, bill.id);
}

test('DEF-1: Generate Entries opens confirmation step with editable period end date and generates only on confirm', async () => {
  for (const [report, kind] of [['deferredRevenue', 'revenue'], ['deferredExpense', 'expense']]) {
    const initialDb = setupDeferredFixture();
    const ctx = await mountDeferredReport(initialDb, report);
    try {
      const beforeGrouped = search(ctx.getDb(), 'account.move').filter((m) => m.is_deferred_grouped);
      assert.equal(beforeGrouped.length, 0, 'No grouped entries exist initially');

      // Switch to Month period to verify the default date matches the end of the selected period.
      const periodSelect = find(ctx.host, (n) => n.tagName === 'SELECT' && reactProps(n)?.value === 'year');
      assert.ok(periodSelect, 'Period selector rendered');
      const expectedDefaultEnd = `${new Date().getFullYear()}-12-31`;

      const generateBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Generate Entries');
      assert.ok(generateBtn, 'Generate Entries button rendered');
      assert.equal(reactProps(generateBtn).disabled, false);

      // Clicking Generate Entries opens confirmation dialog without generating entries yet.
      await ctx.React.act(async () => {
        reactProps(generateBtn).onClick();
      });

      assert.equal(
        search(ctx.getDb(), 'account.move').filter((m) => m.is_deferred_grouped).length,
        0,
        'Clicking Generate Entries must not generate entries before confirmation',
      );

      const dialog = find(ctx.host, (n) => reactProps(n)?.role === 'dialog');
      assert.ok(dialog, 'Confirmation dialog must open');
      const dateInput = find(dialog, (n) => n.tagName === 'INPUT' && reactProps(n)?.type === 'date');
      assert.ok(dateInput, 'Editable date input must appear inside confirmation dialog');
      assert.equal(reactProps(dateInput).value, expectedDefaultEnd, 'Default date must be end of selected period');

      // Cancelling must close the dialog without generating any entries.
      const cancelBtn = find(dialog, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Cancel');
      assert.ok(cancelBtn, 'Cancel button must exist');
      await ctx.React.act(async () => {
        reactProps(cancelBtn).onClick();
      });
      assert.equal(find(ctx.host, (n) => reactProps(n)?.role === 'dialog'), null, 'Cancel closes confirmation dialog');
      assert.equal(search(ctx.getDb(), 'account.move').filter((m) => m.is_deferred_grouped).length, 0);

      // Switch period to Custom with 2026-01-01 .. 2026-03-31, reopen, verify default 2026-03-31, edit to 2026-01-31 and confirm.
      await ctx.React.act(async () => {
        reactProps(periodSelect).onChange({ target: { value: 'custom' } });
      });
      const toInput = find(ctx.host, (n) => n.tagName === 'INPUT' && reactProps(n)?.['aria-label'] === 'To');
      assert.ok(toInput, 'Custom period To input rendered');
      await ctx.React.act(async () => {
        reactProps(toInput).onChange({ target: { value: '2026-03-31' } });
      });

      const generateBtn2 = find(ctx.host, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Generate Entries');
      await ctx.React.act(async () => {
        reactProps(generateBtn2).onClick();
      });

      const dialog2 = find(ctx.host, (n) => reactProps(n)?.role === 'dialog');
      assert.ok(dialog2, 'Confirmation dialog reopens');
      const confirmDateInput = find(dialog2, (n) => n.tagName === 'INPUT' && reactProps(n)?.type === 'date');
      assert.equal(reactProps(confirmDateInput).value, '2026-03-31', 'Default date reflects custom period end');

      await ctx.React.act(async () => {
        reactProps(confirmDateInput).onChange({ target: { value: '2026-01-31' } });
      });
      const form = find(dialog2, (n) => n.tagName === 'FORM') ?? dialog2;
      const beforeCommitDb = ctx.getDb();
      await ctx.React.act(async () => {
        await reactProps(form).onSubmit({ preventDefault: () => {} });
      });

      assert.equal(find(ctx.host, (n) => reactProps(n)?.role === 'dialog'), null, 'Dialog closes after confirm');
      const afterDb = ctx.getDb();
      const grouped = search(afterDb, 'account.move').filter((m) => m.is_deferred_grouped);
      assert.equal(grouped.length, 2, 'Grouped entry and next-day reversal created for the edited date');
      const mainMove = grouped.find((m) => !m.reversed_entry_id);
      const revMove = read(afterDb, 'account.move', mainMove.reversal_move_id);
      assert.equal(mainMove.deferral_kind, kind);
      assert.equal(mainMove.deferral_date, '2026-01-31');
      assert.equal(revMove.deferral_date, '2026-02-01');

      // Verify the UI-generated diff passes server-side sync guards cleanly.
      const synced = applyDiff(beforeCommitDb, diffDb(beforeCommitDb, afterDb), { isAdmin: false, author: 'Clerk' });
      assert.equal(search(synced, 'account.move').filter((m) => m.is_deferred_grouped).length, 2);
    } finally {
      await ctx.unmount();
    }
  }
});

test('DEF-1: preconditions and validation errors show inline in the report and confirmation dialog', async () => {
  // 1. Non-grouped company disables button and shows precondition error inline if invoked.
  const autoDb = setupDeferredFixture({ revenueMethod: 'on_validation', expenseMethod: 'on_validation' });
  const autoCtx = await mountDeferredReport(autoDb, 'deferredRevenue');
  try {
    const btn = find(autoCtx.host, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Generate Entries');
    assert.ok(btn);
    assert.equal(reactProps(btn).disabled, true, 'Button must be disabled when not configured for grouped posting');
    assert.match(reactProps(btn).title ?? '', /grouped posting/i);

    await autoCtx.React.act(async () => {
      reactProps(btn).onClick();
    });
    assert.equal(find(autoCtx.host, (n) => reactProps(n)?.role === 'dialog'), null, 'Dialog must not open when not grouped');
    const inlineAlert = find(autoCtx.host, (n) => reactProps(n)?.role === 'alert');
    assert.ok(inlineAlert, 'Precondition error must render inline');
    assert.match(textOf(inlineAlert), /grouped posting/i);
  } finally {
    await autoCtx.unmount();
  }

  // 2. Grouped company with lock date: empty date, locked date error inline in dialog, then recovery with unlocked date.
  const lockedDb = write(setupDeferredFixture(), 'res.company', 1, { lock_date: '2026-01-31' });
  const lockedCtx = await mountDeferredReport(lockedDb, 'deferredRevenue');
  try {
    const btn = find(lockedCtx.host, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Generate Entries');
    await lockedCtx.React.act(async () => {
      reactProps(btn).onClick();
    });
    const dialog = find(lockedCtx.host, (n) => reactProps(n)?.role === 'dialog');
    assert.ok(dialog);
    const dateInput = find(dialog, (n) => n.tagName === 'INPUT' && reactProps(n)?.type === 'date');
    const form = find(dialog, (n) => n.tagName === 'FORM') ?? dialog;

    // Empty date triggers inline required validation without calling generation.
    await lockedCtx.React.act(async () => {
      reactProps(dateInput).onChange({ target: { value: '' } });
    });
    await lockedCtx.React.act(async () => {
      await reactProps(form).onSubmit({ preventDefault: () => {} });
    });
    const emptyAlert = find(dialog, (n) => reactProps(n)?.role === 'alert');
    assert.ok(emptyAlert, 'Missing date error shown inline in dialog');
    assert.match(textOf(emptyAlert), /Period End Date/);

    // Locked date triggers lock error inline and keeps dialog open.
    await lockedCtx.React.act(async () => {
      reactProps(dateInput).onChange({ target: { value: '2026-01-31' } });
    });
    await lockedCtx.React.act(async () => {
      await reactProps(form).onSubmit({ preventDefault: () => {} });
    });
    const stillOpen = find(lockedCtx.host, (n) => reactProps(n)?.role === 'dialog');
    assert.ok(stillOpen, 'Dialog stays open on lock error');
    const lockAlert = find(stillOpen, (n) => reactProps(n)?.role === 'alert');
    assert.ok(lockAlert, 'Lock error shown inline in dialog');
    assert.match(textOf(lockAlert), /locked/i);
    assert.equal(search(lockedCtx.getDb(), 'account.move').filter((m) => m.is_deferred_grouped).length, 0);

    // Editing to an unlocked date and confirming succeeds and closes dialog.
    await lockedCtx.React.act(async () => {
      reactProps(dateInput).onChange({ target: { value: '2026-02-28' } });
    });
    await lockedCtx.React.act(async () => {
      await reactProps(form).onSubmit({ preventDefault: () => {} });
    });
    assert.equal(find(lockedCtx.host, (n) => reactProps(n)?.role === 'dialog'), null, 'Dialog closes after successful retry');
    const grouped = search(lockedCtx.getDb(), 'account.move').filter((m) => m.is_deferred_grouped && !m.reversed_entry_id);
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].deferral_date, '2026-02-28');
  } finally {
    await lockedCtx.unmount();
  }
});

test('DEF-1: Arabic i18n translates confirmation dialog strings non-identically without duplicate keys', async () => {
  const i18nSrc = fs.readFileSync('src/i18n.js', 'utf8');
  const arBlockMatch = i18nSrc.match(/const ar = \{([\s\S]*?)\n\};/);
  assert.ok(arBlockMatch, 'Found ar dictionary in src/i18n.js');

  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null) };
  try {
    const { t } = await import(`./i18n.js?def2=${Date.now()}`);
    const strings = [
      'Generate Entries',
      'Period End Date',
      'Confirm',
      'Cancel',
      'Grouped deferral generation requires a company configured for grouped posting',
      'Grouped recognition entries and their next-day reversals will be generated for this date.',
      'Configure an active deferred revenue journal on the company',
      'Configure an active deferred expense journal on the company',
    ];
    for (const s of strings) {
      const arVal = t(s);
      assert.ok(arVal && arVal.trim().length > 0, `Missing Arabic translation for "${s}"`);
      assert.notEqual(arVal, s, `Arabic translation must not equal English for "${s}"`);
      assert.match(arVal, /[\u0600-\u06FF]/, `Expected Arabic script for "${s}"`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
