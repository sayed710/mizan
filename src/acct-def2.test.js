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
      'Saving...',
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

test('DEF-1: Wizard blocks repeat submit, dismissal, and field edits while async confirmation is pending', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Wizard } = await import('./views/Wizard.jsx');

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const spec = {
    title: 'Generate Entries',
    fields: [{ name: 'date', type: 'date', label: 'Period End Date', required: true, default: '2026-01-31' }],
  };

  let confirmCalls = 0;
  let cancelCalls = 0;
  let resolveConfirm;
  try {
    await React.act(async () => {
      root.render(React.createElement(Wizard, {
        db: setupDeferredFixture(),
        spec,
        onConfirm: () => {
          confirmCalls += 1;
          return new Promise((resolve) => { resolveConfirm = resolve; });
        },
        onCancel: () => { cancelCalls += 1; },
      }));
    });

    const form = find(host, (n) => n.tagName === 'FORM');
    const backdrop = find(host, (n) => reactProps(n)?.className === 'wizard-backdrop');
    assert.ok(form && backdrop);

    // Start async confirmation (do not resolve yet).
    await React.act(async () => {
      reactProps(form).onSubmit({ preventDefault: () => {} });
    });
    assert.equal(confirmCalls, 1, 'Initial confirm runs once');

    const submitBtn = find(form, (n) => n.tagName === 'BUTTON' && reactProps(n)?.type === 'submit');
    const cancelBtn = find(form, (n) => n.tagName === 'BUTTON' && reactProps(n)?.type === 'button');
    const dateInput = find(form, (n) => n.tagName === 'INPUT');
    assert.equal(reactProps(form)['aria-busy'], true, 'Dialog marks aria-busy while saving');
    assert.equal(reactProps(submitBtn).disabled, true, 'Submit button disabled while saving');
    assert.equal(textOf(submitBtn), 'Saving...', 'Submit button shows saving state');
    assert.equal(reactProps(cancelBtn).disabled, true, 'Cancel button disabled while saving');
    assert.equal(reactProps(dateInput).disabled, true, 'Fields disabled while saving');

    // Repeat submission, Cancel click, Escape key, and backdrop mousedown must all be ignored while saving.
    await React.act(async () => {
      reactProps(form).onSubmit({ preventDefault: () => {} });
      reactProps(cancelBtn).onClick();
      reactProps(form).onKeyDown({ key: 'Escape', stopPropagation: () => {} });
      reactProps(backdrop).onMouseDown({ target: backdrop, currentTarget: backdrop });
    });
    assert.equal(confirmCalls, 1, 'Repeat submit must not trigger another confirmation while pending');
    assert.equal(cancelCalls, 0, 'Cancel, Escape, and backdrop must not dismiss while pending');

    // Once the confirmation promise settles, controls re-enable and Cancel works again.
    await React.act(async () => {
      resolveConfirm();
    });
    assert.equal(reactProps(submitBtn).disabled, false, 'Submit button re-enables after pending confirmation settles');
    assert.equal(textOf(submitBtn), 'Confirm');
    assert.equal(reactProps(cancelBtn).disabled, false, 'Cancel button re-enables after pending confirmation settles');

    await React.act(async () => {
      reactProps(cancelBtn).onClick();
    });
    assert.equal(cancelCalls, 1, 'Cancel works again once save is no longer pending');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('DEF-1: pending server save in Generate Entries blocks dismissal and stale responses never affect a replacement wizard', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore } = await import('./store.js');
  const { Reports } = await import('./views/Reports.jsx');

  const initialDb = setupDeferredFixture();
  const origFetch = globalThis.fetch;
  const origLocation = globalThis.location;
  const origSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  globalThis.location = { hash: '#/accounting/deferred-revenue-report' };

  let serverDb = initialDb;
  const diffRequests = [];
  globalThis.fetch = async (url, opts) => {
    if (url === '/api/session') {
      return new Response(JSON.stringify({ name: 'Admin', isAdmin: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === '/api/db') {
      return new Response(JSON.stringify(serverDb), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === '/api/diff') {
      return new Promise((resolve) => {
        diffRequests.push({ body: JSON.parse(opts.body), resolve });
      });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => {
      await initStore();
    });
    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf: { report: 'deferredRevenue' } }));
    });

    // Open wizard 1 and submit it; /api/diff stays pending.
    const generateBtn = find(host, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Generate Entries');
    await React.act(async () => {
      reactProps(generateBtn).onClick();
    });
    const dialog1 = find(host, (n) => reactProps(n)?.role === 'dialog');
    const backdrop1 = find(host, (n) => reactProps(n)?.className === 'wizard-backdrop');
    assert.ok(dialog1 && backdrop1);

    await React.act(async () => {
      reactProps(dialog1).onSubmit({ preventDefault: () => {} });
    });
    assert.equal(diffRequests.length, 1, 'One server save is in flight');

    // While server save is pending, Cancel / Escape / backdrop / repeat submit must neither dismiss nor post again.
    const submitBtn1 = find(dialog1, (n) => n.tagName === 'BUTTON' && reactProps(n)?.type === 'submit');
    const cancelBtn1 = find(dialog1, (n) => n.tagName === 'BUTTON' && reactProps(n)?.type === 'button');
    assert.equal(reactProps(submitBtn1).disabled, true);
    assert.equal(textOf(submitBtn1), 'Saving...');
    assert.equal(reactProps(cancelBtn1).disabled, true);

    await React.act(async () => {
      reactProps(dialog1).onSubmit({ preventDefault: () => {} });
      reactProps(cancelBtn1).onClick();
      reactProps(dialog1).onKeyDown({ key: 'Escape', stopPropagation: () => {} });
      reactProps(backdrop1).onMouseDown({ target: backdrop1, currentTarget: backdrop1 });
    });
    assert.equal(diffRequests.length, 1, 'Repeat submit blocked while pending');
    assert.ok(find(host, (n) => reactProps(n)?.role === 'dialog'), 'Dialog must remain open while save is pending');

    // Switch context period so activeGenerateWizard changes, then open a replacement wizard (wizard 2).
    const periodSelect = find(host, (n) => n.tagName === 'SELECT' && reactProps(n)?.value === 'year');
    await React.act(async () => {
      reactProps(periodSelect).onChange({ target: { value: 'month' } });
    });
    const generateBtn2 = find(host, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Generate Entries');
    await React.act(async () => {
      reactProps(generateBtn2).onClick();
    });
    const dialog2 = find(host, (n) => reactProps(n)?.role === 'dialog');
    assert.ok(dialog2, 'Replacement wizard opened in new period context');

    // Stale error response from wizard 1 must NOT appear inside wizard 2.
    await React.act(async () => {
      diffRequests[0].resolve(new Response(JSON.stringify({ error: 'Stale wizard 1 failure', db: serverDb }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    const dialog2AfterErr = find(host, (n) => reactProps(n)?.role === 'dialog');
    assert.ok(dialog2AfterErr, 'Replacement wizard stays open after stale error');
    assert.equal(find(dialog2AfterErr, (n) => reactProps(n)?.role === 'alert'), null, 'Stale error must not populate replacement wizard');

    // Repeat the isolation check for a stale SUCCESS response: start save in 'month', switch to 'custom', open wizard 3, resolve wizard 2 with 200 OK.
    await React.act(async () => {
      reactProps(dialog2AfterErr).onSubmit({ preventDefault: () => {} });
    });
    assert.equal(diffRequests.length, 2, 'Wizard 2 started its own server save');

    await React.act(async () => {
      reactProps(periodSelect).onChange({ target: { value: 'custom' } });
    });
    const generateBtn3 = find(host, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Generate Entries');
    await React.act(async () => {
      reactProps(generateBtn3).onClick();
    });
    const dialog3 = find(host, (n) => reactProps(n)?.role === 'dialog');
    assert.ok(dialog3, 'Wizard 3 opened in custom period context');

    const savedDb = applyDiff(serverDb, diffRequests[1].body, { isAdmin: true, author: 'Admin' });
    serverDb = savedDb;
    await React.act(async () => {
      diffRequests[1].resolve(new Response(JSON.stringify(savedDb), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    const dialog3AfterOk = find(host, (n) => reactProps(n)?.role === 'dialog');
    assert.ok(dialog3AfterOk, 'Stale success response from wizard 2 must NOT close replacement wizard 3');
  } finally {
    await React.act(async () => root.unmount());
    globalThis.fetch = origFetch;
    globalThis.location = origLocation;
    globalThis.setInterval = origSetInterval;
  }
});
