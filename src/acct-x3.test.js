import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor, models } from './models/index.js';
import { addDays, today } from './models/common.js';
import { rateAt, toCompany, upsertCurrencyRates } from './models/currency.js';
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

async function mountForm(model, id, initialDb) {
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
      model,
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

test('FX-1: Rates tab is hidden on the active company currency and shown on foreign currencies including global base', async () => {
  let db = seed();
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const c2 = create(db, 'res.company', { name: 'Euro Co', currency_id: eur.id });
  db = {
    ...c2.db,
    settings: { ...c2.db.settings, current_company_id: c2.id, allowed_company_ids: [1, c2.id] },
  };

  const form = models['res.currency'].form;
  // Active company is Euro Co (EUR), while global base_currency_id is still USD.
  assert.equal(form.banner(read(db, 'res.currency', eur.id), db), "This is your company's currency.");
  assert.deepEqual(form.tabs(read(db, 'res.currency', eur.id), db), []);
  assert.equal(form.banner(read(db, 'res.currency', usd.id), db), null);
  assert.deepEqual(form.tabs(read(db, 'res.currency', usd.id), db).map((t) => t.label), ['Rates']);

  // Verify mounted FormView hides Rates on EUR (company currency) and shows Rates on USD (foreign to Euro Co).
  const eurForm = await mountForm('res.currency', eur.id, db);
  try {
    assert.ok(find(eurForm.host, (n) => hasClass(n, 'alert-info')));
    assert.equal(allFind(eurForm.host, (n) => props(n)?.role === 'tab').length, 0);
  } finally {
    await eurForm.done();
  }

  const usdForm = await mountForm('res.currency', usd.id, db);
  try {
    assert.equal(find(usdForm.host, (n) => hasClass(n, 'alert-info')), null);
    assert.ok(find(usdForm.host, (n) => props(n)?.role === 'tab' && n.textContent.trim() === 'Rates'));
  } finally {
    await usdForm.done();
  }
});

test('FX-2: company_rate and inverse_company_rate convert by the company currency rate in compute and onchange', async () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  db = write(db, 'res.currency', eur.id, {
    rate_ids: [{ date: addDays(today(), -10), rate: 0.8, company_id: null }],
  });
  const gbp = create(db, 'res.currency', {
    name: 'GBP',
    symbol: '£',
    rate_ids: [{ date: addDays(today(), -5), rate: 0.64, company_id: null }],
  });
  db = gbp.db;
  const euroCo = create(db, 'res.company', { name: 'Euro Co', currency_id: eur.id });
  db = {
    ...euroCo.db,
    settings: { ...euroCo.db.settings, current_company_id: euroCo.id, allowed_company_ids: [1, euroCo.id] },
  };
  db = write(db, 'res.currency', gbp.id, {
    rate_ids: [
      { date: addDays(today(), -5), rate: 0.64, company_id: null },
      { date: addDays(today(), -1), rate: 0.64, company_id: euroCo.id },
    ],
  });

  const rateSpec = models['res.currency'].fields.rate_ids;
  const gbpRec = read(db, 'res.currency', gbp.id);

  // Explicit company_id (Euro Co, EUR rate = 0.8) and shared company_id = null while active company is Euro Co.
  for (const line of gbpRec.rate_ids) {
    assert.equal(rateSpec.fields.company_rate.compute(line, db, gbpRec), 0.8);
    assert.equal(rateSpec.fields.inverse_company_rate.compute(line, db, gbpRec), 1.25);

    const byCompanyRate = rateSpec.onchange({ ...line, company_rate: 1.5 }, 'company_rate', db, gbpRec);
    assert.equal('company_rate' in byCompanyRate, false);
    assert.equal(byCompanyRate.rate, 1.2);
    assert.equal(rateSpec.fields.company_rate.compute(byCompanyRate, db, gbpRec), 1.5);
    assert.equal(rateSpec.fields.inverse_company_rate.compute(byCompanyRate, db, gbpRec), Number((1 / 1.5).toPrecision(12)));

    const byInverseRate = rateSpec.onchange({ ...line, inverse_company_rate: 2 }, 'inverse_company_rate', db, gbpRec);
    assert.equal('inverse_company_rate' in byInverseRate, false);
    assert.equal(byInverseRate.rate, 0.4);
    assert.equal(rateSpec.fields.company_rate.compute(byInverseRate, db, gbpRec), 0.5);
    assert.equal(rateSpec.fields.inverse_company_rate.compute(byInverseRate, db, gbpRec), 2);
  }

  // Company 1 (USD, base currency = 1) keeps 1:1 with base-relative rate.
  const usdLine = { date: addDays(today(), -5), rate: 0.64, company_id: 1 };
  assert.equal(rateSpec.fields.company_rate.compute(usdLine, db, gbpRec), 0.64);
  assert.equal(rateSpec.fields.inverse_company_rate.compute(usdLine, db, gbpRec), Number((1 / 0.64).toPrecision(12)));
  assert.equal(rateSpec.onchange({ ...usdLine, company_rate: 0.7 }, 'company_rate', db, gbpRec).rate, 0.7);
  assert.equal(rateSpec.onchange({ ...usdLine, inverse_company_rate: 2 }, 'inverse_company_rate', db, gbpRec).rate, 0.5);

  // End-to-end FormView edit on GBP while active company is Euro Co saves converted base-relative rate.
  const gbpForm = await mountForm('res.currency', gbp.id, db);
  try {
    const unitInput = find(gbpForm.host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Unit/Base 1');
    const baseInput = find(gbpForm.host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Base/Unit 1');
    assert.equal(props(unitInput).value, 0.8);
    assert.equal(props(baseInput).value, 1.25);

    await gbpForm.React.act(async () => {
      props(baseInput).onChange({ target: { value: '2' } });
    });
    const unitAfterBase = find(gbpForm.host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Unit/Base 1');
    assert.equal(props(unitAfterBase).value, 0.5);

    const saveBtn = find(gbpForm.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Save');
    await gbpForm.React.act(async () => {
      props(saveBtn).onClick();
    });
    const savedGbp = read(gbpForm.getDb(), 'res.currency', gbp.id);
    const newest = [...savedGbp.rate_ids].sort((a, b) => b.date.localeCompare(a.date))[0];
    assert.equal(newest.rate, 0.4);
  } finally {
    await gbpForm.done();
  }
});

test('Finding 1: historical rate lines use the company currency rate on line.date with no future fallback', async () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const dHist = addDays(today(), -60);
  const dLine = addDays(today(), -30);
  const dFuture = addDays(today(), 30);
  db = write(db, 'res.currency', eur.id, {
    rate_ids: [
      { date: dHist, rate: 0.8, company_id: null },
      { date: today(), rate: 0.9, company_id: null },
      { date: dFuture, rate: 1.2, company_id: null },
    ],
  });
  const euroCo = create(db, 'res.company', { name: 'Euro Co', currency_id: eur.id });
  db = {
    ...euroCo.db,
    settings: { ...euroCo.db.settings, current_company_id: euroCo.id, allowed_company_ids: [1, euroCo.id] },
  };
  const gbp = create(db, 'res.currency', {
    name: 'GBP',
    symbol: '£',
    rate_ids: [
      { date: dLine, rate: 0.64, company_id: euroCo.id },
      { date: today(), rate: 0.72, company_id: euroCo.id },
    ],
  });
  db = gbp.db;

  const rateSpec = models['res.currency'].fields.rate_ids;
  const gbpRec = read(db, 'res.currency', gbp.id);
  const histLine = gbpRec.rate_ids.find((l) => l.date === dLine);
  const currLine = gbpRec.rate_ids.find((l) => l.date === today());

  // Historical line uses dHist (0.8), today line uses today() (0.9).
  assert.equal(rateSpec.fields.company_rate.compute(histLine, db, gbpRec), 0.8);
  assert.equal(rateSpec.fields.inverse_company_rate.compute(histLine, db, gbpRec), 1.25);
  assert.equal(rateSpec.fields.company_rate.compute(currLine, db, gbpRec), 0.8);

  // Editing the historical line in FormView saves 1.5 * 0.8 = 1.2 (not 1.5 * 0.9 = 1.35).
  const gbpForm = await mountForm('res.currency', gbp.id, db);
  try {
    // Sorted newest-first: row 1 (index 2 in aria-label) is dLine.
    const histUnitInput = find(gbpForm.host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Unit/Base 2');
    assert.equal(props(histUnitInput).value, 0.8);
    await gbpForm.React.act(async () => {
      props(histUnitInput).onChange({ target: { value: '1.5' } });
    });
    const saveBtn = find(gbpForm.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Save');
    await gbpForm.React.act(async () => {
      props(saveBtn).onClick();
    });
    const nextDb = gbpForm.getDb();
    const savedHist = read(nextDb, 'res.currency', gbp.id).rate_ids.find((l) => l.date === dLine);
    assert.equal(savedHist.rate, 1.2);
    assert.equal(Number(rateAt(nextDb, gbp.id, dLine, euroCo.id).toPrecision(12)), 1.5);
  } finally {
    await gbpForm.done();
  }

  // A line dated before EUR's earliest rate must not borrow future rates (no '9999-12-31' fallback).
  const onlyFutureEur = write(db, 'res.currency', eur.id, {
    rate_ids: [{ date: dFuture, rate: 1.2, company_id: null }],
  });
  assert.equal(rateSpec.fields.company_rate.compute(histLine, onlyFutureEur, gbpRec), null);
});

test('Finding 2: missing company currency rate is not treated as 1, and non-base company currency can edit its base rate', async () => {
  let db = seed();
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  db = write(db, 'res.currency', eur.id, { rate_ids: [] });
  const euroCo = create(db, 'res.company', { name: 'Euro Co', currency_id: eur.id });
  db = {
    ...euroCo.db,
    settings: { ...euroCo.db.settings, current_company_id: euroCo.id, allowed_company_ids: [1, euroCo.id] },
  };
  const gbp = create(db, 'res.currency', {
    name: 'GBP',
    symbol: '£',
    rate_ids: [{ date: today(), rate: 0.64, company_id: euroCo.id }],
  });
  db = gbp.db;

  // Missing required rate on EUR must not fall back to 1 in the rate-line editor.
  const rateSpec = models['res.currency'].fields.rate_ids;
  const gbpRec = read(db, 'res.currency', gbp.id);
  const gbpLine = gbpRec.rate_ids[0];
  assert.equal(rateSpec.fields.company_rate.compute(gbpLine, db, gbpRec), null);
  assert.equal(rateSpec.fields.inverse_company_rate.compute(gbpLine, db, gbpRec), null);
  assert.equal(rateSpec.fields.company_rate.readonly(gbpLine, db), true);
  assert.equal(rateSpec.fields.inverse_company_rate.readonly(gbpLine, db), true);
  assert.equal(rateSpec.onchange({ ...gbpLine, company_rate: 1.5 }, 'company_rate', db).rate, 0.64);
  assert.equal(rateSpec.onchange({ ...gbpLine, inverse_company_rate: 2 }, 'inverse_company_rate', db).rate, 0.64);

  // EUR keeps hidden Rates tab, yet exposes Base Currency Rate so Euro Co can configure its missing rate.
  const eurForm = await mountForm('res.currency', eur.id, db);
  try {
    assert.equal(allFind(eurForm.host, (n) => props(n)?.role === 'tab').length, 0);
    const rateInput = find(eurForm.host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Base Currency Rate');
    const dateInput = find(eurForm.host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Base Rate Date');
    assert.ok(rateInput && dateInput, 'Base Currency Rate controls rendered for non-base company currency');
    assert.equal(props(rateInput).value, '');

    // Invalid rate (0) is rejected by guard on save.
    await eurForm.React.act(async () => {
      props(rateInput).onChange({ target: { value: '0' } });
    });
    let saveBtn = find(eurForm.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Save');
    await eurForm.React.act(async () => {
      props(saveBtn).onClick();
    });
    assert.ok(find(eurForm.host, (n) => props(n)?.role === 'alert')?.textContent.includes('strictly positive'));

    // Valid rate (0.8) saves into EUR.rate_ids and enables conversions + GBP company-relative rate editing.
    const rateInput2 = find(eurForm.host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Base Currency Rate');
    await eurForm.React.act(async () => {
      props(rateInput2).onChange({ target: { value: '0.8' } });
    });
    saveBtn = find(eurForm.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Save');
    await eurForm.React.act(async () => {
      props(saveBtn).onClick();
    });
    const nextDb = eurForm.getDb();
    const savedEur = read(nextDb, 'res.currency', eur.id);
    assert.equal(savedEur.rate_ids.length, 1);
    assert.equal(savedEur.rate_ids[0].rate, 0.8);
    assert.equal(rateAt(nextDb, usd.id, today(), euroCo.id), 1.25);
    assert.equal(toCompany(nextDb, usd.id, 100, today(), euroCo.id), 80);
    assert.equal(rateSpec.fields.company_rate.compute(gbpLine, nextDb, read(nextDb, 'res.currency', gbp.id)), 0.8);

    // Also supports editing a historical date via Base Rate Date.
    const dPast = addDays(today(), -20);
    const dateInput2 = find(eurForm.host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Base Rate Date');
    await eurForm.React.act(async () => {
      props(dateInput2).onChange({ target: { value: dPast } });
    });
    const rateInput3 = find(eurForm.host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Base Currency Rate');
    assert.equal(props(rateInput3).value, '');
    await eurForm.React.act(async () => {
      props(rateInput3).onChange({ target: { value: '0.75' } });
    });
    saveBtn = find(eurForm.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Save');
    await eurForm.React.act(async () => {
      props(saveBtn).onClick();
    });
    assert.equal(rateAt(eurForm.getDb(), usd.id, dPast, euroCo.id), 1 / 0.75);
  } finally {
    await eurForm.done();
  }
});

test('Finding 3: base currency Rates tab is visible but read-only and base rate_ids writes are guarded', async () => {
  let db = seed();
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const euroCo = create(db, 'res.company', { name: 'Euro Co', currency_id: eur.id });
  db = {
    ...euroCo.db,
    settings: { ...euroCo.db.settings, current_company_id: euroCo.id, allowed_company_ids: [1, euroCo.id] },
  };

  // UI: USD Rates tab is shown, read-only (no Add a line / Delete / row inputs), and explains base rate is fixed at 1.
  const usdForm = await mountForm('res.currency', usd.id, db);
  try {
    const rateTab = find(usdForm.host, (n) => props(n)?.role === 'tab' && n.textContent.trim() === 'Rates');
    assert.ok(rateTab);
    const panel = find(usdForm.host, (n) => props(n)?.role === 'tabpanel');
    assert.ok(panel.textContent.includes('The base currency rate is fixed at 1.'));
    assert.equal(find(panel, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Add a line'), null);
    assert.equal(find(panel, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Delete'), null);
    assert.equal(allFind(panel, (n) => n.tagName === 'INPUT').length, 0);
  } finally {
    await usdForm.done();
  }

  // Guard + diffDb/applyDiff: modifying rate_ids on base currency is rejected, while non-rate edits stay allowed.
  const forgedRates = {
    ...db,
    records: {
      ...db.records,
      'res.currency': db.records['res.currency'].map((c) => (
        c.id === usd.id ? { ...c, rate_ids: [...(c.rate_ids ?? []), { date: today(), rate: 2, company_id: euroCo.id }] } : c
      )),
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, forgedRates), { isAdmin: true }), /fixed at 1/i);
  assert.doesNotThrow(() => write(db, 'res.currency', usd.id, { symbol: 'US$' }));
});

test('Finding 4: array-form rate imports skip base-currency entries and import foreign rates without failing guard', () => {
  let db = seed();
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(usd && eur);
  const testDate = '2026-11-20';

  // Array containing base-currency entry (USD) and foreign-currency entry (EUR)
  const arrayRates = [
    { currency_id: usd.id, rate: 1.0, date: testDate },
    { currency_id: eur.id, rate: 0.95, date: testDate },
  ];

  // Under the bug, this throws "The base currency rate is fixed at 1 and cannot be modified"
  // When fixed, it skips the base-currency entry and writes the foreign rate
  assert.doesNotThrow(() => {
    db = upsertCurrencyRates(db, arrayRates, { date: testDate });
  });

  const usdAfter = read(db, 'res.currency', usd.id);
  const eurAfter = read(db, 'res.currency', eur.id);
  const usdRows = (usdAfter.rate_ids ?? []).filter((r) => r.date === testDate);
  const eurRows = (eurAfter.rate_ids ?? []).filter((r) => r.date === testDate);

  assert.equal(usdRows.length, 0, 'Base currency must not receive rate rows');
  assert.equal(eurRows.length, 1, 'Foreign currency rate must be imported');
  assert.equal(eurRows[0].rate, 0.95);
});
