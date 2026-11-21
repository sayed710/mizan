import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { today } from './models/common.js';
import { accountId, balances, balanceSheet, journalItems, postEntry, profitAndLoss } from './models/ledger.js';
import { closeFiscalYear, reopenFiscalYear } from './models/closing.js';
import { trialBalance } from './models/reports.js';
import { applyDiff, diffDb } from './sync.js';
import { setupDom } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];

function findAll(node, predicate) {
  const result = [];
  const walk = (n) => {
    if (!n) return;
    if (predicate(n)) result.push(n);
    for (const child of n.childNodes ?? []) walk(child);
  };
  walk(node);
  return result;
}

const cleanBooks = (yr) => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };
  const fy = create(db, 'account.fiscal.year', {
    name: `FY ${yr}`,
    company_id: 1,
    date_from: `${yr}-01-01`,
    date_to: `${yr}-12-31`,
  });
  return fy;
};

test('FX-5: close -> reopen -> close links previous closing and reversal, leaves one effective closing entry, and keeps reports consistent', () => {
  const yr = 2024;
  const period = { from: `${yr}-01-01`, to: `${yr}-12-31` };
  let { db, id: yearId } = cleanBooks(yr);
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: `${yr}-06-15`,
    lines: [
      { account: '101401', debit: 750 },
      { account: '400000', credit: 1000 },
      { account: '600000', debit: 250 },
    ],
  }).db;

  // 1. First close
  const closed1 = closeFiscalYear(db, yearId);
  const fy1 = read(closed1, 'account.fiscal.year', yearId);
  const closing1 = read(closed1, 'account.move', fy1.closing_move_id);
  assert.equal(fy1.state, 'closed');
  assert.equal(fy1.opening_move_id, null);
  assert.equal(closing1.is_closing, true);
  assert.equal(closing1.closing_fiscal_year_id, yearId);

  // 2. Reopen: reversal links to previous closing and vice versa
  const reopened = reopenFiscalYear(closed1, yearId);
  const fyOpen = read(reopened, 'account.fiscal.year', yearId);
  const reversal1 = read(reopened, 'account.move', fyOpen.opening_move_id);
  const closing1AfterReopen = read(reopened, 'account.move', closing1.id);
  assert.equal(fyOpen.state, 'open');
  assert.equal(fyOpen.closing_move_id, closing1.id);
  assert.equal(reversal1.is_closing, true);
  assert.equal(reversal1.reversed_entry_id, closing1.id);
  assert.equal(closing1AfterReopen.reversal_move_id, reversal1.id);

  // Post additional revenue while reopened
  const updated = postEntry(reopened, {
    journal: 'MISC',
    company: 1,
    date: `${yr}-08-01`,
    lines: [
      { account: '101401', debit: 500 },
      { account: '400000', credit: 500 },
    ],
  }).db;

  // 3. Re-close
  const closed2 = closeFiscalYear(updated, yearId);
  const fy2 = read(closed2, 'account.fiscal.year', yearId);
  const closing2 = read(closed2, 'account.move', fy2.closing_move_id);
  const prevClosing = read(closed2, 'account.move', closing1.id);
  const prevReversal = read(closed2, 'account.move', reversal1.id);

  assert.equal(fy2.state, 'closed');
  assert.equal(fy2.opening_move_id, null);
  assert.notEqual(closing2.id, closing1.id);
  assert.equal(closing2.is_closing, true);
  assert.equal(closing2.closing_fiscal_year_id, yearId);
  assert.ok(!closing2.reversal_move_id);

  // Previous closing and its reversal remain linked to each other and excluded the same way
  assert.equal(prevClosing.is_closing, true);
  assert.equal(prevReversal.is_closing, true);
  assert.equal(prevClosing.reversal_move_id, prevReversal.id);
  assert.equal(prevReversal.reversed_entry_id, prevClosing.id);

  // Exactly one effective (unreversed) closing entry for the year
  const closingRelated = search(closed2, 'account.move').filter((m) => m.is_closing);
  assert.equal(closingRelated.length, 3);
  const effectiveClosings = closingRelated.filter((m) => !m.reversal_move_id && !m.reversed_entry_id);
  assert.deepEqual(effectiveClosings.map((m) => m.id), [closing2.id]);
  const pairedNet = balances(closed2, journalItems(closed2, period).filter((l) => [prevClosing.id, prevReversal.id].includes(l.move_id)));
  assert.ok(pairedNet.every((b) => b.balance === 0), 'Previous closing and its reversal cancel out to zero');

  // 4. Reports after close -> reopen -> close
  const pnl = profitAndLoss(closed2, period);
  assert.equal(pnl.revenue, 1500);
  assert.equal(pnl.expense, 250);
  assert.equal(pnl.net, 1250);
  assert.equal(profitAndLoss(closed2, period, { includeClosing: true }).net, 0);

  const bs = balanceSheet(closed2, `${yr}-12-31`);
  assert.equal(bs.earnings, 0);
  assert.equal(bs.equity.find((r) => r.account.code === '302000')?.balance, 1250);
  assert.equal(bs.totalAssets, bs.totalLiabilities + bs.totalEquity);

  const nextTb = trialBalance(closed2, { from: `${yr + 1}-01-01`, to: `${yr + 1}-12-31`, company_id: 1 });
  assert.equal(nextTb.rows.find((r) => r.account.code === '302000')?.initial, -1250);
  assert.equal(nextTb.rows.find((r) => r.account.code === '400000')?.initial ?? 0, 0);
});

test('FX-5 guards: diffDb + applyDiff accepts linked close/reopen/close and rejects unlinked or cleared opening_move_id', () => {
  const yr = 2025;
  let { db, id: yearId } = cleanBooks(yr);
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: `${yr}-05-01`,
    lines: [{ account: '101401', debit: 400 }, { account: '400000', credit: 400 }],
  }).db;

  const sync = (base, next) => applyDiff(base, diffDb(base, next), { isAdmin: false });
  const c1 = sync(db, closeFiscalYear(db, yearId));
  const r1 = sync(c1, reopenFiscalYear(c1, yearId));
  const c2 = sync(r1, closeFiscalYear(r1, yearId));
  const r2 = sync(c2, reopenFiscalYear(c2, yearId));
  const fyR2 = read(r2, 'account.fiscal.year', yearId);
  const c2Move = read(r2, 'account.move', fyR2.closing_move_id);
  const r2Move = read(r2, 'account.move', fyR2.opening_move_id);
  assert.equal(c2Move.reversal_move_id, r2Move.id);
  assert.equal(r2Move.reversed_entry_id, c2Move.id);

  // Forged reopening without reversed_entry_id / reversal_move_id link must be rejected by yearGuard via diffDb + applyDiff
  const c1Fy = read(c1, 'account.fiscal.year', yearId);
  const c1Move = read(c1, 'account.move', c1Fy.closing_move_id);
  const c1Open = {
    ...c1,
    records: {
      ...c1.records,
      'account.fiscal.year': c1.records['account.fiscal.year'].map((y) => (
        y.id === yearId ? { ...y, state: 'open' } : y
      )),
    },
  };
  const forgedEntry = postEntry(c1Open, {
    journal: 'MISC',
    company: 1,
    date: `${yr}-12-31`,
    ref: `Reopen fiscal year: ${c1Fy.name}`,
    lines: c1Move.line_ids.map((l) => ({ account_id: l.account_id, debit: l.credit, credit: l.debit })),
    system_generated: true,
  });
  const forgedDb = {
    ...forgedEntry.db,
    records: {
      ...forgedEntry.db.records,
      'account.fiscal.year': forgedEntry.db.records['account.fiscal.year'].map((y) => (
        y.id === yearId ? { ...y, state: 'open', opening_move_id: forgedEntry.id } : y
      )),
      'account.move': forgedEntry.db.records['account.move'].map((m) => (
        m.id === forgedEntry.id ? { ...m, is_closing: true } : m
      )),
    },
  };
  assert.throws(() => sync(c1, forgedDb), /made by reopening this fiscal year/);

  // Clearing opening_move_id while keeping year open must be rejected by yearGuard via diffDb + applyDiff
  const clearedOpeningDb = {
    ...r1,
    records: {
      ...r1.records,
      'account.fiscal.year': r1.records['account.fiscal.year'].map((y) => (
        y.id === yearId ? { ...y, opening_move_id: null } : y
      )),
    },
  };
  assert.throws(() => sync(r1, clearedOpeningDb), /reopening entry/);
});

test('FX-6: Trial Balance excludes closing entries in the period while preserving prior-year closing in opening balances and keeping journalItems intact', () => {
  const yr = 2024;
  let { db, id: yearId } = cleanBooks(yr);
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: `${yr}-06-15`,
    lines: [{ account: '101401', debit: 750 }, { account: '400000', credit: 750 }],
  }).db;
  const closed = closeFiscalYear(db, yearId);

  const tb = trialBalance(closed, { from: `${yr}-01-01`, to: `${yr}-12-31`, company_id: 1 });
  const revRow = tb.rows.find((r) => r.account.code === '400000');
  assert.ok(revRow, 'Revenue row is present in Trial Balance');
  assert.equal(revRow.initial, 0);
  assert.equal(revRow.debit, 0);
  assert.equal(revRow.credit, 750);
  assert.equal(revRow.end, -750);
  assert.equal(tb.rows.find((r) => r.account.code === '302000'), undefined, 'Closing transfer to Retained Earnings is excluded from period TB');
  assert.equal(tb.totals.debit, 750);
  assert.equal(tb.totals.credit, 750);
  assert.equal(tb.totals.end, 0);

  // Next year Trial Balance still carries prior-year closing into initial balances
  const nextTb = trialBalance(closed, { from: `${yr + 1}-01-01`, to: `${yr + 1}-12-31`, company_id: 1 });
  assert.equal(nextTb.rows.find((r) => r.account.code === '302000')?.initial, -750);
  assert.equal(nextTb.rows.find((r) => r.account.code === '400000'), undefined);

  // Other callers of journalItems without includeClosing: false still receive closing lines
  const defaultItems = journalItems(closed, { from: `${yr}-01-01`, to: `${yr}-12-31`, company_id: 1 });
  assert.ok(defaultItems.some((l) => l.is_closing), 'Default journalItems retains closing lines for balanceSheet/JournalItems/closing');
  assert.equal(balanceSheet(closed, `${yr}-12-31`).equity.find((r) => r.account.code === '302000')?.balance, 750);
});

test('FX-6: General Ledger report excludes is_closing lines in the period', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { Reports } = await import('./views/Reports.jsx');
  const { money } = await import('./ui.jsx');
  await initStore();

  const yr = Number(today().slice(0, 4));
  let { db, id: yearId } = cleanBooks(yr);
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: `${yr}-06-15`,
    lines: [{ account: '101401', debit: 750 }, { account: '400000', credit: 750 }],
  }).db;
  const closed = closeFiscalYear(db, yearId);

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => commit(closed));
    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf: { label: 'General Ledger', report: 'ledger' } }));
    });

    const sectionRows = findAll(host, (n) => n.tagName === 'TR' && n.className?.includes('rep-section'));
    const revSection = sectionRows.find((tr) => tr.textContent.includes('400000'));
    assert.ok(revSection, 'Revenue account row exists in General Ledger');
    const cells = findAll(revSection, (n) => n.tagName === 'TD').map((td) => td.textContent);
    assert.equal(cells[1], money(0), 'GL revenue debit excludes closing entry');
    assert.equal(cells[2], money(750), 'GL revenue credit shows actual 750');
    assert.equal(cells[3], money(-750), 'GL revenue end balance shows -750');
    assert.ok(!sectionRows.some((tr) => tr.textContent.includes('302000')), 'GL excludes year-end closing entry row on 302000');

    // Expanding the revenue row shows only the real entry, not the closing entry
    await React.act(async () => {
      props(revSection)?.onClick?.();
    });
    const detailRows = findAll(host, (n) => n.tagName === 'TR' && n.className?.includes('rep-detail'));
    assert.ok(!detailRows.some((tr) => tr.textContent.includes('Fiscal closing')), 'Closing entry line is excluded from GL details');
    assert.equal(accountId(closed, '400000') > 0, true);
  } finally {
    await React.act(async () => root.unmount());
  }
});
