import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor, models } from './models/index.js';
import { addDays, today } from './models/common.js';
import { rateAt, toCompany, upsertCurrencyRate } from './models/currency.js';
import { applyDiff, diffDb } from './sync.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const hasClass = (node, cls) => {
  const cn = props(node)?.className ?? node?.className ?? '';
  return typeof cn === 'string' && cn.split(/\s+/).includes(cls);
};
const allFind = (root, pred, out = []) => {
  if (!root) return out;
  if (pred(root)) out.push(root);
  for (const child of root.childNodes ?? []) allFind(child, pred, out);
  return out;
};
const findLeafByKey = (items, key) => {
  for (const item of items) {
    if (item.key === key) return item;
    if (item.children) {
      const found = findLeafByKey(item.children, key);
      if (found) return found;
    }
  }
  return null;
};

async function mountCurrencyForm(id, initialDb) {
  const prevStorage = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
  setupDom();
  const origCreate = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const el = origCreate(tag);
    el.insertBefore = (child, before) => {
      const idx = before ? el.childNodes.indexOf(before) : -1;
      if (idx >= 0) el.childNodes.splice(idx, 0, child);
      else el.childNodes.push(child);
      child.parentNode = el;
      if (child.tagName === 'OPTION') el.options.push(child);
      return child;
    };
    return el;
  };
  globalThis.document.createElementNS = (_, tag) => globalThis.document.createElement(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { FormView } = await import('./views/FormView.jsx');
  await initStore();
  await commit(initialDb);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => {
    root.render(React.createElement(FormView, {
      model: 'res.currency',
      id,
      leaf: findLeafByKey(menusFor('accounting'), 'currencies'),
      base: '#/accounting/currencies',
      params: new URLSearchParams(),
    }));
  });
  return {
    React,
    host,
    getDb,
    done: async () => {
      await React.act(async () => root.unmount());
      globalThis.localStorage = prevStorage;
    },
  };
}

test('CUR-1: Rates grid includes Odoo optional write_date and rate columns, timestamps updates, and validates through diffDb + applyDiff', async () => {
  const rateFields = models['res.currency'].fields.rate_ids.fields;
  assert.equal(rateFields.rate.optional, 'hide');
  assert.equal(rateFields.write_date.type, 'datetime');
  assert.equal(rateFields.write_date.label, 'Last Updated on');
  assert.equal(rateFields.write_date.readonly, true);
  assert.equal(rateFields.write_date.optional, 'hide');

  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const oldTs = '2026-01-10T09:30:00.000Z';
  const dOld = addDays(today(), -60);
  const dNew = addDays(today(), -1);
  db = {
    ...db,
    records: {
      ...db.records,
      'res.currency': db.records['res.currency'].map((c) => (c.id === eur.id ? {
        ...c,
        rate_ids: [
          { date: dOld, rate: 0.92, company_id: null, write_date: oldTs },
          { date: dNew, rate: 0.9, company_id: null, write_date: oldTs },
        ],
      } : c)),
    },
  };

  const ctx = await mountCurrencyForm(eur.id, db);
  try {
    const rateTable = find(ctx.host, (n) => hasClass(n, 'lines'));
    const headersBefore = allFind(rateTable, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th'))
      .map((th) => th.textContent.trim())
      .filter(Boolean);
    assert.deepEqual(headersBefore, ['Date', 'Base Currency', 'Unit/Base', 'Base/Unit']);

    const menuTrigger = find(rateTable, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Optional columns');
    await ctx.React.act(async () => {
      props(menuTrigger).onClick();
    });
    const menuItems = allFind(rateTable, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'menuitemcheckbox');
    assert.deepEqual(menuItems.map((b) => b.textContent.replace('✓', '').trim()), ['Technical Rate', 'Last Updated on']);
    const writeDateToggle = menuItems.find((b) => b.textContent.includes('Last Updated on'));
    assert.equal(props(writeDateToggle)['aria-checked'], false);

    await ctx.React.act(async () => {
      props(writeDateToggle).onClick();
    });
    const headersAfter = allFind(rateTable, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th'))
      .map((th) => th.textContent.trim())
      .filter(Boolean);
    assert.deepEqual(headersAfter, ['Date', 'Base Currency', 'Unit/Base', 'Base/Unit', 'Last Updated on']);

    // Rendered write_date cell is read-only and displays the formatted timestamp.
    const bodyRows = allFind(find(rateTable, (n) => n.tagName === 'TBODY'), (n) => n.tagName === 'TR')
      .filter((tr) => !tr.textContent.includes('Add a line'));
    const lastCell = allFind(bodyRows[0], (n) => n.tagName === 'TD').at(-2);
    assert.equal(find(lastCell, (n) => n.tagName === 'INPUT'), null);
    assert.ok(lastCell.textContent.includes('2026'));

    // Editing the newest row stamps write_date on save while keeping the untouched row's write_date.
    const unitInput = find(bodyRows[0], (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Unit/Base 1');
    await ctx.React.act(async () => {
      props(unitInput).onChange({ target: { value: '0.95' } });
    });
    const saveBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Save');
    await ctx.React.act(async () => {
      props(saveBtn).onClick();
    });
    const saved = read(ctx.getDb(), 'res.currency', eur.id);
    const updatedRow = saved.rate_ids.find((r) => r.date === dNew);
    const untouchedRow = saved.rate_ids.find((r) => r.date === dOld);
    assert.equal(updatedRow.rate, 0.95);
    assert.notEqual(updatedRow.write_date, oldTs);
    assert.ok(Date.parse(updatedRow.write_date) > Date.parse(oldTs));
    assert.equal(untouchedRow.write_date, oldTs);

    // Syncing via diffDb + applyDiff stamps an authoritative write_date on changed rows, preserves oldTs on untouched rows, and rejects malformed write_date and invalid rates.
    const synced = applyDiff(db, diffDb(db, ctx.getDb()), { isAdmin: true });
    const syncedRow = read(synced, 'res.currency', eur.id).rate_ids.find((r) => r.date === dNew);
    assert.notEqual(syncedRow.write_date, oldTs);
    assert.ok(Date.parse(syncedRow.write_date) >= Date.parse(updatedRow.write_date));
    assert.equal(read(synced, 'res.currency', eur.id).rate_ids.find((r) => r.date === dOld).write_date, oldTs);

    const forgedBadDate = {
      ...db,
      records: {
        ...db.records,
        'res.currency': db.records['res.currency'].map((c) => (c.id === eur.id
          ? { ...c, rate_ids: [{ date: dNew, rate: 0.9, company_id: null, write_date: 'not-a-datetime' }] }
          : c)),
      },
    };
    assert.throws(() => applyDiff(db, diffDb(db, forgedBadDate), { isAdmin: true }), /Invalid value for res\.currency\.rate_ids\[0\]\.write_date/);

    const forgedZeroRate = {
      ...db,
      records: {
        ...db.records,
        'res.currency': db.records['res.currency'].map((c) => (c.id === eur.id
          ? { ...c, rate_ids: [{ date: dNew, rate: 0, company_id: null, write_date: updatedRow.write_date }] }
          : c)),
      },
    };
    assert.throws(() => applyDiff(db, diffDb(db, forgedZeroRate), { isAdmin: true }), /strictly positive/);
  } finally {
    await ctx.done();
  }
});

test('CUR-2: Currency form has no chatter (Odoo res.currency is not a mail.thread) and keeps the base rate controls', async () => {
  const def = models['res.currency'];
  assert.equal(def.form.chatter, undefined);

  let db = seed();
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const euroCo = create(db, 'res.company', { name: 'Euro Co', currency_id: eur.id });
  db = {
    ...euroCo.db,
    settings: { ...euroCo.db.settings, current_company_id: euroCo.id, allowed_company_ids: [1, euroCo.id] },
  };

  // Neither form has a chatter; Euro Co's own currency keeps the Base Currency Rate controls,
  // its only way to enter a rate while the Rates tab is hidden.
  for (const id of [usd.id, eur.id]) {
    const ctx = await mountCurrencyForm(id, db);
    try {
      assert.equal(find(ctx.host, (n) => hasClass(n, 'chatter')), null);
      const baseRate = find(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Base Currency Rate');
      assert.equal(Boolean(baseRate), id === eur.id);
    } finally {
      await ctx.done();
    }
  }

  // Underlying behaviour remains intact: base currency rate_ids cannot be forged via diffDb + applyDiff, and upsertCurrencyRate drives cross-company conversion.
  const forgedUsd = {
    ...db,
    records: {
      ...db.records,
      'res.currency': db.records['res.currency'].map((c) => (c.id === usd.id
        ? { ...c, rate_ids: [...(c.rate_ids ?? []), { date: today(), rate: 2, company_id: euroCo.id }] }
        : c)),
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, forgedUsd), { isAdmin: true }), /fixed at 1/i);

  const updatedDb = upsertCurrencyRate(db, eur.id, { date: today(), rate: 0.8, companyId: euroCo.id });
  assert.equal(rateAt(updatedDb, usd.id, today(), euroCo.id), 1.25);
  assert.equal(toCompany(updatedDb, usd.id, 100, today(), euroCo.id), 80);
});

test('CUR-1 regression: server and ORM own rate write_date on create, write, and applyDiff (never trusting forged or missing timestamps)', () => {
  const forgedPast = '2001-01-01T00:00:00.000Z';
  const forgedFuture = '2099-12-31T23:59:59.000Z';
  const storedTs = '2026-01-10T09:30:00.000Z';
  const d1 = addDays(today(), -30);
  const d2 = addDays(today(), -10);
  const d3 = addDays(today(), -2);

  let db = seed();
  const accountant = { author: 'Accountant', isAdmin: false, allowed: new Set(['res.currency']) };

  // 1. Direct ORM create discards supplied write_date and stamps current time.
  const startCreate = Date.now();
  const created = create(db, 'res.currency', {
    name: 'TST',
    symbol: 'T',
    rounding: 0.01,
    rate_ids: [{ date: d1, rate: 1.5, company_id: null, write_date: forgedFuture }],
  });
  const createdRow = read(created.db, 'res.currency', created.id).rate_ids[0];
  assert.notEqual(createdRow.write_date, forgedFuture);
  assert.ok(Date.parse(createdRow.write_date) >= startCreate - 1000);

  // 2. applyDiff create discards supplied write_date and stamps server time.
  const syncCreatedDiff = diffDb(db, {
    ...db,
    records: {
      ...db.records,
      'res.currency': [
        ...db.records['res.currency'],
        { id: 9901, name: 'SYN', symbol: 'S', rounding: 0.01, position: 'before', active: true, rate_ids: [{ date: d1, rate: 2.25, company_id: null, write_date: forgedPast }] },
      ],
    },
  });
  const syncCreated = applyDiff(db, syncCreatedDiff, accountant);
  const syncCreatedRow = syncCreated.records['res.currency'].find((c) => c.name === 'SYN').rate_ids[0];
  assert.notEqual(syncCreatedRow.write_date, forgedPast);
  assert.ok(Date.parse(syncCreatedRow.write_date) >= startCreate - 1000);

  // Seed EUR with: d1 (storedTs), d2 (no write_date, legacy), d3 (company-specific, storedTs).
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const branch = create(db, 'res.company', { name: 'Branch Co', currency_id: eur.id });
  db = {
    ...branch.db,
    records: {
      ...branch.db.records,
      'res.currency': branch.db.records['res.currency'].map((c) => (c.id === eur.id ? {
        ...c,
        rate_ids: [
          { date: d1, rate: 0.92, company_id: null, write_date: storedTs },
          { date: d2, rate: 0.91, company_id: null },
          { date: d3, rate: 0.89, company_id: branch.id, write_date: storedTs },
        ],
      } : c)),
    },
  };

  // 3. Direct ORM write:
  // - unchanged row with omitted or forged write_date restores storedTs
  // - unchanged legacy row without stored write_date strips forged write_date
  // - modified and newly added rows ignore forged write_date and stamp now
  const d4 = today();
  const writtenDb = write(db, 'res.currency', eur.id, {
    rate_ids: [
      { date: d1, rate: 0.92, company_id: null }, // omitted write_date
      { date: d2, rate: 0.91, company_id: null, write_date: forgedFuture }, // legacy row + forged ts
      { date: d3, rate: 0.88, company_id: branch.id, write_date: forgedPast }, // modified rate + forged ts
      { date: d4, rate: 0.87, company_id: null, write_date: forgedFuture }, // new row + forged ts
    ],
  });
  const writtenRates = read(writtenDb, 'res.currency', eur.id).rate_ids;
  assert.equal(writtenRates.find((r) => r.date === d1).write_date, storedTs);
  assert.equal(Object.hasOwn(writtenRates.find((r) => r.date === d2), 'write_date'), false);
  assert.notEqual(writtenRates.find((r) => r.date === d3).write_date, forgedPast);
  assert.ok(Date.parse(writtenRates.find((r) => r.date === d3).write_date) > Date.parse(storedTs));
  assert.notEqual(writtenRates.find((r) => r.date === d4).write_date, forgedFuture);
  assert.ok(Date.parse(writtenRates.find((r) => r.date === d4).write_date) > Date.parse(storedTs));

  // 4. applyDiff update with forged/missing timestamps as non-admin accountant:
  const currentEur = db.records['res.currency'].find((c) => c.id === eur.id);
  const forgedDiff = {
    upserts: {
      'res.currency': [{
        ...currentEur,
        rate_ids: [
          { date: d1, rate: 0.92, company_id: null, write_date: forgedPast }, // unchanged with forged ts
          { date: d2, rate: 0.91, company_id: null, write_date: forgedFuture }, // legacy unchanged with forged ts
          { date: d3, rate: 0.85, company_id: branch.id, write_date: forgedPast }, // changed rate with forged ts
          { date: d4, rate: 0.84, company_id: null, write_date: forgedFuture }, // new row with forged ts
        ],
      }],
    },
    deletes: {},
  };
  const syncedDb = applyDiff(db, forgedDiff, accountant);
  const syncedRates = read(syncedDb, 'res.currency', eur.id).rate_ids;
  assert.equal(syncedRates.find((r) => r.date === d1).write_date, storedTs);
  assert.equal(Object.hasOwn(syncedRates.find((r) => r.date === d2), 'write_date'), false);
  assert.notEqual(syncedRates.find((r) => r.date === d3).write_date, forgedPast);
  assert.ok(Date.parse(syncedRates.find((r) => r.date === d3).write_date) > Date.parse(storedTs));
  assert.notEqual(syncedRates.find((r) => r.date === d4).write_date, forgedFuture);
  assert.ok(Date.parse(syncedRates.find((r) => r.date === d4).write_date) > Date.parse(storedTs));

  // Also test omitting write_date on unchanged rows via applyDiff restores storedTs.
  const omittedDiff = {
    upserts: {
      'res.currency': [{
        ...currentEur,
        rate_ids: [
          { date: d1, rate: 0.92, company_id: null },
          { date: d2, rate: 0.91, company_id: null },
          { date: d3, rate: 0.89, company_id: branch.id },
          { date: d4, rate: 0.86, company_id: null, write_date: forgedPast },
        ],
      }],
    },
    deletes: {},
  };
  const omittedSynced = applyDiff(db, omittedDiff, accountant);
  const omittedRates = read(omittedSynced, 'res.currency', eur.id).rate_ids;
  assert.equal(omittedRates.find((r) => r.date === d1).write_date, storedTs);
  assert.equal(omittedRates.find((r) => r.date === d3).write_date, storedTs);
  assert.notEqual(omittedRates.find((r) => r.date === d4).write_date, forgedPast);
  assert.ok(Date.parse(omittedRates.find((r) => r.date === d4).write_date) > Date.parse(storedTs));
});

test('CUR-2 regression: direct base_rate write without rate_ids generates rate row and stamps write_date', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const euroCo = create(db, 'res.company', { name: 'Euro Co', currency_id: eur.id });
  const oldTs = '2026-01-10T09:30:00.000Z';
  const dOld = addDays(today(), -60);
  db = {
    ...euroCo.db,
    settings: { ...euroCo.db.settings, current_company_id: euroCo.id, allowed_company_ids: [1, euroCo.id] },
    records: {
      ...euroCo.db.records,
      'res.currency': euroCo.db.records['res.currency'].map((c) => (c.id === eur.id ? {
        ...c,
        rate_ids: [{ date: dOld, rate: 0.92, company_id: euroCo.id, write_date: oldTs }],
      } : c)),
    },
  };

  // Direct write of base_rate without explicit rate_ids on non-base company currency.
  const afterBaseRate = write(db, 'res.currency', eur.id, { base_rate: 0.8 });
  const rawEur = afterBaseRate.records['res.currency'].find((c) => c.id === eur.id);
  assert.equal(Object.hasOwn(rawEur, 'base_rate'), false);
  assert.equal(Object.hasOwn(rawEur, 'base_rate_date'), false);
  const todayRow = rawEur.rate_ids.find((r) => r.date === today() && r.company_id === euroCo.id);
  assert.ok(todayRow, 'base_rate write generates today rate row');
  assert.equal(todayRow.rate, 0.8);
  assert.ok(todayRow.write_date && Date.parse(todayRow.write_date) > Date.parse(oldTs), 'generated rate row has new write_date');
  assert.equal(rawEur.rate_ids.find((r) => r.date === dOld).write_date, oldTs, 'untouched rate row keeps stored write_date');

  // Direct write with explicit base_rate_date + base_rate without rate_ids also generates and stamps the dated row.
  const customDate = addDays(today(), -5);
  const afterDated = write(afterBaseRate, 'res.currency', eur.id, { base_rate_date: customDate, base_rate: 0.75 });
  const datedRow = read(afterDated, 'res.currency', eur.id).rate_ids.find((r) => r.date === customDate && r.company_id === euroCo.id);
  assert.ok(datedRow);
  assert.equal(datedRow.rate, 0.75);
  assert.ok(datedRow.write_date && Date.parse(datedRow.write_date) > Date.parse(oldTs));

  // Syncing the direct base_rate write via diffDb + applyDiff keeps the generated row and authoritative write_date.
  const synced = applyDiff(db, diffDb(db, afterDated), { author: 'Accountant', isAdmin: false, allowed: new Set(['res.currency']) });
  const syncedRow = read(synced, 'res.currency', eur.id).rate_ids.find((r) => r.date === customDate && r.company_id === euroCo.id);
  assert.equal(syncedRow.rate, 0.75);
  assert.ok(syncedRow.write_date && Date.parse(syncedRow.write_date) >= Date.parse(datedRow.write_date));

  // Invalid base_rate without rate_ids is rejected by guard.
  assert.throws(() => write(db, 'res.currency', eur.id, { base_rate: 0 }), /strictly positive/);
});
