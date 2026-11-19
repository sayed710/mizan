import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const { create, read, search, write } = await import('./orm.js');
const { seed } = await import('./seed.js');
const { models } = await import('./models/index.js');
const { createCompany } = await import('./models/company.js');
const { fiscalYearStart, balanceSheet, postEntry } = await import('./models/ledger.js');
const { applyDiff, diffDb } = await import('./sync.js');
const { find, setupDom } = await import('./test-support/dom.js');

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

async function renderSettingsView(initialDb) {
  const { makeEl } = setupDom();
  const prevConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { Settings } = await import('./views/Settings.jsx');
  await initStore();
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => {
    await commit(initialDb);
    root.render(React.createElement(Settings));
  });
  return {
    React,
    host,
    getDb,
    commit,
    control: (id) => find(host, (n) => props(n)?.id === id),
    cleanup: async () => {
      await React.act(async () => root.unmount());
      globalThis.confirm = prevConfirm;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Company field definition and defaults
// ---------------------------------------------------------------------------

test('fiscalyear_last_day and fiscalyear_last_month are defined on res.company with default 31 December', () => {
  const fields = models['res.company'].fields;
  assert.ok(fields.fiscalyear_last_day, 'res.company must have fiscalyear_last_day field');
  assert.ok(fields.fiscalyear_last_month, 'res.company must have fiscalyear_last_month field');

  const defaults = models['res.company'].defaults?.() ?? {};
  assert.equal(defaults.fiscalyear_last_day, 31, 'fiscalyear_last_day default must be 31');
  assert.equal(Number(defaults.fiscalyear_last_month), 12, 'fiscalyear_last_month default must be 12 (December)');
});

// ---------------------------------------------------------------------------
// 2. Company validation rules for fiscal year end
// ---------------------------------------------------------------------------

test('Validation: fiscalyear_last_month must be 1-12 and day valid for that month; 29 Feb is rejected', () => {
  let db = seed();
  const compId = 1;

  // Invalid months
  assert.throws(() => write(db, 'res.company', compId, { fiscalyear_last_month: 0 }), /fiscal year end month/i);
  assert.throws(() => write(db, 'res.company', compId, { fiscalyear_last_month: 13 }), /fiscal year end month/i);
  assert.throws(() => write(db, 'res.company', compId, { fiscalyear_last_month: 'invalid' }), /fiscal year end month/i);

  // Invalid days
  assert.throws(() => write(db, 'res.company', compId, { fiscalyear_last_day: 0, fiscalyear_last_month: 12 }), /fiscal year end day/i);
  assert.throws(() => write(db, 'res.company', compId, { fiscalyear_last_day: 32, fiscalyear_last_month: 12 }), /fiscal year end day/i);

  // April has 30 days - 31 April must be rejected
  assert.throws(() => write(db, 'res.company', compId, { fiscalyear_last_day: 31, fiscalyear_last_month: 4 }), /fiscal year end day/i);

  // 29 February is explicitly not allowed
  assert.throws(() => write(db, 'res.company', compId, { fiscalyear_last_day: 29, fiscalyear_last_month: 2 }), /fiscal year end day/i);
  assert.throws(() => write(db, 'res.company', compId, { fiscalyear_last_day: 30, fiscalyear_last_month: 2 }), /fiscal year end day/i);

  // Valid combinations succeed
  const validMar = write(db, 'res.company', compId, { fiscalyear_last_day: 31, fiscalyear_last_month: 3 });
  assert.equal(read(validMar, 'res.company', compId).fiscalyear_last_day, 31);
  assert.equal(Number(read(validMar, 'res.company', compId).fiscalyear_last_month), 3);

  const validFeb = write(db, 'res.company', compId, { fiscalyear_last_day: 28, fiscalyear_last_month: 2 });
  assert.equal(read(validFeb, 'res.company', compId).fiscalyear_last_day, 28);
  assert.equal(Number(read(validFeb, 'res.company', compId).fiscalyear_last_month), 2);

  const validApr = write(db, 'res.company', compId, { fiscalyear_last_day: 30, fiscalyear_last_month: 4 });
  assert.equal(read(validApr, 'res.company', compId).fiscalyear_last_day, 30);
  assert.equal(Number(read(validApr, 'res.company', compId).fiscalyear_last_month), 4);
});

// ---------------------------------------------------------------------------
// 3. Server-side diff guard: only admin can modify, invalid values rejected
// ---------------------------------------------------------------------------

test('Only administrators can change fiscalyear settings via diffDb + applyDiff', () => {
  let db = seed();
  const compId = 1;
  const next = write(db, 'res.company', compId, { fiscalyear_last_day: 31, fiscalyear_last_month: 3 });
  const diff = diffDb(db, next);

  assert.throws(
    () => applyDiff(db, diff, { isAdmin: false }),
    /Only administrators can change/i,
  );

  const applied = applyDiff(db, diff, { isAdmin: true });
  assert.equal(read(applied, 'res.company', compId).fiscalyear_last_day, 31);
  assert.equal(Number(read(applied, 'res.company', compId).fiscalyear_last_month), 3);
});

// ---------------------------------------------------------------------------
// 4. fiscalYearStart calculation: March 31 company vs default company
// ---------------------------------------------------------------------------

test('fiscalYearStart: company with year end 31 March gives 2026-04-01 for 2026-11-19 and 2025-04-01 for 2026-02-10', () => {
  let db = seed();
  const comp = createCompany(db, {
    name: 'March End Company',
    fiscalyear_last_day: 31,
    fiscalyear_last_month: 3,
  });
  db = comp.db;
  const marchCompId = comp.id;

  // Company with 31 March year end
  assert.equal(fiscalYearStart(db, '2026-11-19', marchCompId), '2026-04-01');
  assert.equal(fiscalYearStart(db, '2026-02-10', marchCompId), '2025-04-01');

  // Default company (31 December) keeps 1 January
  assert.equal(fiscalYearStart(db, '2026-11-19', 1), '2026-01-01');
  assert.equal(fiscalYearStart(db, '2026-02-10', 1), '2026-01-01');
});

// ---------------------------------------------------------------------------
// 5. Configured account.fiscal.year still wins and repeats
// ---------------------------------------------------------------------------

test('fiscalYearStart: configured account.fiscal.year wins and repeat rule stays', () => {
  let db = seed();
  const comp = createCompany(db, {
    name: 'Configured FY Company',
    fiscalyear_last_day: 31,
    fiscalyear_last_month: 3,
  });
  db = comp.db;
  const cId = comp.id;

  // Configure a specific fiscal year: 2026-07-01 to 2027-06-30
  const fy = create(db, 'account.fiscal.year', {
    name: 'FY 2026-2027',
    company_id: cId,
    date_from: '2026-07-01',
    date_to: '2027-06-30',
  });
  db = fy.db;

  // Inside the configured year: returns date_from of that configured year
  assert.equal(fiscalYearStart(db, '2026-11-19', cId), '2026-07-01');

  // After the last configured year: repeat rule applies (repeats yearly from last date_from)
  assert.equal(fiscalYearStart(db, '2028-01-15', cId), '2027-07-01');
});

// ---------------------------------------------------------------------------
// 6. Balance sheet current-year earnings split at fiscal year start
// ---------------------------------------------------------------------------

test('Balance sheet current-year earnings split at fiscal year start for March 31 company', () => {
  let db = seed();
  const comp = createCompany(db, {
    name: 'BS March End Co',
    fiscalyear_last_day: 31,
    fiscalyear_last_month: 3,
  });
  db = comp.db;
  const cId = comp.id;

  const revAccount = search(db, 'account.account').find((a) => a.code === '400000');
  const bnkAccount = search(db, 'account.account').find((a) => a.code === '101401');
  const genJournal = search(db, 'account.journal').find((j) => j.type === 'general' && (!j.company_id || j.company_id === cId));

  // Revenue posted 2026-02-15 (belongs to FY 2025-04-01 -> 2026-03-31)
  const entry1 = postEntry(db, {
    journal_id: genJournal.id, company: cId, date: '2026-02-15', ref: 'Old FY Revenue',
    lines: [
      { account_id: bnkAccount.id, debit: 1000 },
      { account_id: revAccount.id, credit: 1000 },
    ],
  });
  db = entry1.db;

  // Revenue posted 2026-05-10 (belongs to FY 2026-04-01 -> 2027-03-31)
  const entry2 = postEntry(db, {
    journal_id: genJournal.id, company: cId, date: '2026-05-10', ref: 'New FY Revenue',
    lines: [
      { account_id: bnkAccount.id, debit: 500 },
      { account_id: revAccount.id, credit: 500 },
    ],
  });
  db = entry2.db;

  // Balance sheet as of 2026-11-19:
  // For the March 31 company, fiscal year start is 2026-04-01.
  // Current-year earnings must be 500 (from 2026-05-10), and prior earnings 1000 (from 2026-02-15) folded into retained earnings.
  const bs = balanceSheet(db, { to: '2026-11-19', company_id: cId });
  assert.equal(bs.earnings, 500, 'Current-year earnings should be 500 (since 2026-04-01)');

  const retainedAccount = read(db, 'res.company', cId).current_year_earnings_account_id;
  const equityLine = bs.equity.find((r) => r.account.id === retainedAccount);
  assert.ok(equityLine, 'Retained earnings account should exist in equity');
  assert.equal(equityLine.balance, 1000, 'Prior earnings (1000) should be folded into retained earnings');
});

// ---------------------------------------------------------------------------
// 7. Settings UI: Renders Fiscal Year End in fiscal periods and writes res.company
// ---------------------------------------------------------------------------

test('Settings renders Fiscal Year End under Fiscal Periods and writes to res.company', async () => {
  let db = seed();
  const ctx = await renderSettingsView(db);
  try {
    const row = find(ctx.host, (n) => props(n)?.['data-setting'] === 'fiscal_year_end' || props(n)?.['data-setting'] === 'fiscalyear_last_day');
    assert.ok(row, 'Fiscal Year End row must render in Settings');
    const label = find(row, (n) => n.tagName === 'LABEL');
    assert.equal(label?.textContent, 'Fiscal Year End');

    const dayControl = ctx.control('fiscalyear_last_day');
    const monthControl = ctx.control('fiscalyear_last_month');
    assert.ok(dayControl, 'fiscalyear_last_day control must render');
    assert.ok(monthControl, 'fiscalyear_last_month control must render');

    // Change to 31 March
    await ctx.React.act(async () => {
      props(dayControl)?.onChange?.({ target: { value: '31' } });
      props(monthControl)?.onChange?.({ target: { value: '3' } });
    });

    const updatedComp = read(ctx.getDb(), 'res.company', 1);
    assert.equal(updatedComp.fiscalyear_last_day, 31);
    assert.equal(Number(updatedComp.fiscalyear_last_month), 3);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 8. Arabic translations
// ---------------------------------------------------------------------------

test('Arabic translations for fiscal year end in i18n.js', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {}, clear: () => {} };
  try {
    const { t } = await import(`./i18n.js?lang=ar-fy-${Date.now()}`);
    assert.equal(t('Fiscal Year End'), 'نهاية السنة المالية');
    assert.equal(t('January'), 'يناير');
    assert.equal(t('December'), 'ديسمبر');
    assert.equal(t('Fiscal year end month must be between 1 and 12'), 'يجب أن يكون شهر نهاية السنة المالية بين 1 و 12');
    assert.equal(t('Fiscal year end day is invalid for the selected month'), 'يوم نهاية السنة المالية غير صالح للشهر المحدد');
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

