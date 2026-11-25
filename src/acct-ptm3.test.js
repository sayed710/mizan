import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, unlink, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { menusFor, models } from './models/index.js';
import { installments, formatTermPreview, termScheduleError } from './models/terms.js';

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

const paymentTermsLeaf = () => findLeafByKey(menusFor('accounting'), 'payment-terms');

async function mountView(renderElement, initialDb = seed(), lang = null) {
  const prevStorage = globalThis.localStorage;
  const mem = new Map(lang ? [['mizan-lang', lang]] : []);
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
      return el;
    };
    return el;
  };
  globalThis.document.createElementNS = (_, tag) => globalThis.document.createElement(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  await initStore();
  await commit(initialDb);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => root.render(renderElement(React)));
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

function syncAttempt(baseDb, nextTermVals, existingId = null) {
  const targetId = existingId ?? ((baseDb.seq['account.payment.term'] ?? 0) + 1);
  const baseTerm = existingId ? read(baseDb, 'account.payment.term', existingId) : null;
  const candidate = {
    ...(models['account.payment.term'].defaults?.(targetId) ?? {}),
    ...(baseTerm ?? {}),
    ...nextTermVals,
    id: targetId,
  };
  const nextDb = {
    ...baseDb,
    records: {
      ...baseDb.records,
      'account.payment.term': existingId
        ? baseDb.records['account.payment.term'].map((r) => (r.id === existingId ? candidate : r))
        : [...(baseDb.records['account.payment.term'] ?? []), candidate],
    },
    seq: existingId ? baseDb.seq : { ...baseDb.seq, 'account.payment.term': targetId },
  };
  return applyDiff(baseDb, diffDb(baseDb, nextDb), { isAdmin: true });
}

test('PTM-1: payment term save guard enforces Odoo _check_lines and _check_percent rules via direct writes and diffDb/applyDiff, with view translation', async () => {
  const db = seed();

  // 1. Percent lines must be within 0..100 (direct + sync)
  for (const badPct of [-5, 105]) {
    const vals = { name: `Bad pct ${badPct}`, line_ids: [{ value_type: 'percent', value: badPct, nb_days: 0, delay_type: 'days_after' }] };
    assert.throws(() => create(db, 'account.payment.term', vals), /between 0 and 100/);
    assert.throws(() => syncAttempt(db, vals), /between 0 and 100/);
  }

  // 2. Without a balance line, percent lines must exist and sum to 100 (direct + sync)
  for (const badLines of [
    [{ value_type: 'fixed', value: 100, nb_days: 0, delay_type: 'days_after' }],
    [
      { value_type: 'percent', value: 40, nb_days: 0, delay_type: 'days_after' },
      { value_type: 'percent', value: 50, nb_days: 30, delay_type: 'days_after' },
    ],
    [
      { value_type: 'percent', value: 60, nb_days: 0, delay_type: 'days_after' },
      { value_type: 'percent', value: 60, nb_days: 30, delay_type: 'days_after' },
    ],
  ]) {
    const vals = { name: 'Bad sum', line_ids: badLines };
    assert.throws(() => create(db, 'account.payment.term', vals), /sum of the percent must be 100%/);
    assert.throws(() => syncAttempt(db, vals), /sum of the percent must be 100%/);
  }

  // Valid terms without balance: 33.33 + 33.33 + 33.34 and fixed + 100% remainder
  const split3 = create(db, 'account.payment.term', {
    name: 'Thirds',
    line_ids: [
      { value_type: 'percent', value: 33.33, nb_days: 0, delay_type: 'days_after' },
      { value_type: 'percent', value: 33.33, nb_days: 30, delay_type: 'days_after' },
      { value_type: 'percent', value: 33.34, nb_days: 60, delay_type: 'days_after' },
    ],
  });
  assert.ok(read(applyDiff(db, diffDb(db, split3.db), { isAdmin: true }), 'account.payment.term', split3.id));

  const fixedPlus100 = syncAttempt(db, {
    name: 'Deposit 100 + Balance %',
    line_ids: [
      { value_type: 'fixed', value: 100, nb_days: 0, delay_type: 'days_after' },
      { value_type: 'percent', value: 100, nb_days: 30, delay_type: 'days_after' },
    ],
  });
  assert.ok(fixedPlus100.records['account.payment.term'].some((t) => t.name === 'Deposit 100 + Balance %'));

  // 3. Respect existing value_type=balance semantics (valid when last and percent <= 100, invalid if not last or > 100)
  const balTerm = create(db, 'account.payment.term', {
    name: '30% + Balance',
    line_ids: [
      { value_type: 'percent', value: 30, nb_days: 0, delay_type: 'days_after' },
      { value_type: 'balance', value: 0, nb_days: 30, delay_type: 'days_after' },
    ],
  });
  assert.ok(read(applyDiff(db, diffDb(db, balTerm.db), { isAdmin: true }), 'account.payment.term', balTerm.id));
  assert.throws(
    () => syncAttempt(db, {
      name: 'Balance first',
      line_ids: [
        { value_type: 'balance', value: 0, nb_days: 0, delay_type: 'days_after' },
        { value_type: 'percent', value: 30, nb_days: 30, delay_type: 'days_after' },
      ],
    }),
    /balance due term must be the last one/i,
  );

  // 4. Early discount: only allowed with a single 100% line, and discount_percent > 0 & discount_days > 0
  for (const badDiscountLines of [
    [
      { value_type: 'percent', value: 50, nb_days: 0, delay_type: 'days_after' },
      { value_type: 'percent', value: 50, nb_days: 30, delay_type: 'days_after' },
    ],
    [
      { value_type: 'percent', value: 30, nb_days: 0, delay_type: 'days_after' },
      { value_type: 'balance', value: 0, nb_days: 30, delay_type: 'days_after' },
    ],
    [{ value_type: 'balance', value: 0, nb_days: 30, delay_type: 'days_after' }],
  ]) {
    const vals = { name: 'Bad Early Lines', early_discount: true, discount_percent: 2, discount_days: 10, discount_tax_computation: 'included', line_ids: badDiscountLines };
    assert.throws(() => create(db, 'account.payment.term', vals), /single 100% line/);
    assert.throws(() => syncAttempt(db, vals), /single 100% line/);
  }

  for (const [discount_percent, discount_days, pattern] of [
    [0, 10, /Early Payment Discount must be strictly positive/],
    [-2, 10, /Early Payment Discount must be strictly positive/],
    [2, 0, /Early Payment Discount days must be strictly positive/],
    [2, -5, /Early Payment Discount days must be strictly positive/],
  ]) {
    const vals = {
      name: 'Bad Discount Values',
      early_discount: true,
      discount_percent,
      discount_days,
      discount_tax_computation: 'included',
      line_ids: [{ value_type: 'percent', value: 100, nb_days: 30, delay_type: 'days_after' }],
    };
    assert.throws(() => create(db, 'account.payment.term', vals), pattern);
    assert.throws(() => syncAttempt(db, vals), pattern);
  }

  // Editing an existing term via write & diffDb/applyDiff also enforces the guard
  const t30 = search(db, 'account.payment.term').find((t) => t.name === '30 Days');
  assert.throws(() => write(db, 'account.payment.term', t30.id, { early_discount: true }), /Early Payment Discount must be strictly positive/);
  assert.throws(() => syncAttempt(db, { early_discount: true, discount_tax_computation: 'included' }, t30.id), /Early Payment Discount must be strictly positive/);

  // 5. Arabic translations exist for all new error strings and FormView renders translated error via t()
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {}, clear: () => {} };
  try {
    const { t } = await import(`./i18n.js?ptm3-ar=${Date.now()}`);
    for (const msg of [
      'Percentages on the Payment Terms lines must be between 0 and 100.',
      'The Payment Term must have at least one percent line and the sum of the percent must be 100%.',
      'The Early Payment Discount functionality can only be used with payment terms using a single 100% line.',
      'The Early Payment Discount must be strictly positive.',
      'The Early Payment Discount days must be strictly positive.',
      "Uh-oh! Those payment terms are quite popular and can't be deleted since there are still some records referencing them. How about archiving them instead?",
    ]) {
      assert.notEqual(t(msg), msg, `Missing Arabic translation for "${msg}"`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }

  // FormView displays English error in default locale and translated error in Arabic
  const { FormView } = await import('./views/FormView.jsx');
  const formCtx = await mountView(
    (React) => React.createElement(FormView, {
      leaf: paymentTermsLeaf(),
      id: t30.id,
      base: '#/accounting/payment-terms',
      params: new URLSearchParams('view=form'),
    }),
    db,
  );
  try {
    const earlyCheckbox = find(formCtx.host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-early_discount');
    await formCtx.React.act(async () => props(earlyCheckbox).onChange({ target: { checked: true } }));
    const saveBtn = allFind(formCtx.host, (n) => n.tagName === 'BUTTON').find((b) => b.textContent.trim() === 'Save');
    await formCtx.React.act(async () => props(saveBtn).onClick());
    const alertDiv = find(formCtx.host, (n) => hasClass(n, 'alert') && props(n)?.role === 'alert');
    assert.equal(alertDiv?.textContent?.trim(), 'The Early Payment Discount must be strictly positive.');
  } finally {
    await formCtx.done();
  }
});

test('PTM-2: delete protection blocks unlinking terms referenced by account.move via unlink and diffDb/applyDiff while allowing archiving and unreferenced deletes', () => {
  let db = seed();
  const refTerm = create(db, 'account.payment.term', {
    name: 'Referenced Term',
    line_ids: [{ value_type: 'percent', value: 100, nb_days: 30, delay_type: 'days_after' }],
  });
  db = refTerm.db;
  const freeTerm = create(db, 'account.payment.term', {
    name: 'Unreferenced Term',
    line_ids: [{ value_type: 'percent', value: 100, nb_days: 45, delay_type: 'days_after' }],
  });
  db = freeTerm.db;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-01',
    invoice_payment_term_id: refTerm.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = inv.db;

  // Deleting referenced term is blocked both directly and via diffDb + applyDiff
  assert.throws(
    () => unlink(db, 'account.payment.term', [refTerm.id]),
    /payment terms are quite popular and can't be deleted/,
  );
  const forgedDeleteRef = {
    ...db,
    records: {
      ...db.records,
      'account.payment.term': db.records['account.payment.term'].filter((t) => t.id !== refTerm.id),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, forgedDeleteRef), { isAdmin: true }),
    /payment terms are quite popular and can't be deleted/,
  );

  // Archiving a referenced term stays allowed (direct write + diffDb/applyDiff)
  const archivedDb = write(db, 'account.payment.term', refTerm.id, { active: false });
  const syncedArchive = applyDiff(db, diffDb(db, archivedDb), { isAdmin: true });
  assert.equal(read(syncedArchive, 'account.payment.term', refTerm.id).active, false);

  // Deleting an unreferenced term succeeds (direct unlink + diffDb/applyDiff)
  const deletedFreeDirect = unlink(db, 'account.payment.term', [freeTerm.id]);
  assert.equal(read(deletedFreeDirect, 'account.payment.term', freeTerm.id), undefined);
  const syncedDeleteFree = applyDiff(db, diffDb(db, deletedFreeDirect), { isAdmin: true });
  assert.equal(read(syncedDeleteFree, 'account.payment.term', freeTerm.id), undefined);
});

test('PTM-3: search Archived filter and kanban card note display match Odoo 20', async () => {
  const def = models['account.payment.term'];
  assert.deepEqual(def.kanban, { title: 'name', lines: ['note'] });
  assert.deepEqual(def.searchFields, ['name']);

  let db = seed();
  const activeTerm = create(db, 'account.payment.term', {
    name: 'Kanban Note Term',
    note: 'Pay within 14 days for standard terms',
    early_discount: true,
    discount_percent: 2,
    discount_days: 7,
    line_ids: [{ value_type: 'percent', value: 100, nb_days: 14, delay_type: 'days_after' }],
  });
  db = activeTerm.db;
  const archivedTerm = create(db, 'account.payment.term', {
    name: 'Archived Kanban Term',
    note: 'Legacy archived description',
    active: false,
    line_ids: [{ value_type: 'percent', value: 100, nb_days: 60, delay_type: 'days_after' }],
  });
  db = archivedTerm.db;

  const { ActionView } = await import('./views/ActionView.jsx');
  const ctx = await mountView(
    (React) => React.createElement(ActionView, {
      leaf: paymentTermsLeaf(),
      base: '#/accounting/payment-terms',
      params: new URLSearchParams('view=kanban'),
    }),
    db,
  );
  try {
    const cards = () => allFind(ctx.host, (n) => n.tagName === 'ARTICLE' && hasClass(n, 'card'));
    const activeCard = cards().find((c) => c.textContent.includes('Kanban Note Term'));
    assert.ok(activeCard, 'kanban renders active payment term card');
    const activeLines = allFind(activeCard, (n) => hasClass(n, 'card-line')).map((n) => n.textContent.trim());
    assert.deepEqual(activeLines, ['Pay within 14 days for standard terms']);
    assert.equal(cards().some((c) => c.textContent.includes('Archived Kanban Term')), false, 'archived term hidden by default in kanban');

    const toggleSearch = find(ctx.host, (n) => n.tagName === 'BUTTON' && hasClass(n, 'search-toggle'));
    await ctx.React.act(async () => props(toggleSearch).onClick());
    const archivedBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Archived');
    assert.ok(archivedBtn, 'search panel exposes Archived filter');
    await ctx.React.act(async () => props(archivedBtn).onClick());

    const archivedCard = cards().find((c) => c.textContent.includes('Archived Kanban Term'));
    assert.ok(archivedCard, 'Archived filter reveals archived term in kanban');
    const archivedLines = allFind(archivedCard, (n) => hasClass(n, 'card-line')).map((n) => n.textContent.trim());
    assert.deepEqual(archivedLines, ['Legacy archived description']);
  } finally {
    await ctx.done();
  }
});

test('PTM-4: residual percentage line identity is consistent between schedule validation and due-date allocation', () => {
  // Invalid schedule: 300 fixed due now, 90% due in 30 days, 10% stored first but due in 60 days.
  // In due-date order, the 10% line is residual; requested non-residual is 300 + 900 = 1200 > 1000.
  const invalidTerm = {
    line_ids: [
      { value_type: 'percent', value: 10, nb_days: 60, delay_type: 'days_after' },
      { value_type: 'fixed', value: 300, nb_days: 0, delay_type: 'days_after' },
      { value_type: 'percent', value: 90, nb_days: 30, delay_type: 'days_after' },
    ],
  };
  assert.equal(termScheduleError(invalidTerm, 1000, null, '2026-01-01'), 'Payment terms must allocate 100% of the total');
  assert.throws(
    () => installments(invalidTerm, 1000, '2026-01-01'),
    /Payment terms must allocate 100% of the total/,
  );

  // Valid schedule: 300 fixed due now, 10% due in 30 days, 90% stored first but due in 60 days.
  // In due-date order, the 90% line is residual; requested non-residual is 300 + 100 = 400 <= 1000.
  const validTerm = {
    line_ids: [
      { value_type: 'percent', value: 90, nb_days: 60, delay_type: 'days_after' },
      { value_type: 'fixed', value: 300, nb_days: 0, delay_type: 'days_after' },
      { value_type: 'percent', value: 10, nb_days: 30, delay_type: 'days_after' },
    ],
  };
  assert.equal(termScheduleError(validTerm, 1000, null, '2026-01-01'), null);
  const schedule = installments(validTerm, 1000, '2026-01-01');
  assert.deepEqual(schedule, [
    { date: '2026-01-01', amount: 300 },
    { date: '2026-01-31', amount: 100 },
    { date: '2026-03-02', amount: 600 },
  ]);

  // Preview must pass example_date to termScheduleError so month-length-sensitive lines sort identically to installments.
  const dateSensitiveTerm = {
    example_amount: 1000,
    example_date: '2026-02-10',
    line_ids: [
      { value_type: 'fixed', value: 300, nb_days: 0, delay_type: 'days_after' },
      { value_type: 'percent', value: 90, nb_days: 5, delay_type: 'days_end_of_month' }, // Feb 28 + 5 = Mar 5 -> last in Feb, residual
      { value_type: 'percent', value: 10, nb_days: 22, delay_type: 'days_after' }, // Feb 10 + 22 = Mar 4 -> earlier in Feb
    ],
  };
  assert.match(formatTermPreview(dateSensitiveTerm), /Installment of 600\.00 due on 2026-03-05/);
});

test('PTM-5: sync diff removing an invoice reference and deleting its term in the same batch succeeds', () => {
  const base = seed();
  const term = create(base, 'account.payment.term', {
    name: 'Term To Delete With Move',
    line_ids: [{ value_type: 'percent', value: 100, nb_days: 15, delay_type: 'days_after' }],
  });
  const inv = create(term.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });

  // Batch delete invoice and term in same sync diff (term first in delete map)
  const synced1 = applyDiff(inv.db, {
    deletes: {
      'account.payment.term': [term.id],
      'account.move': [inv.id],
    },
  }, { isAdmin: true });
  assert.equal(read(synced1, 'account.payment.term', term.id), undefined);
  assert.equal(read(synced1, 'account.move', inv.id), undefined);

  // Batch delete invoice and term in same sync diff (move first in delete map)
  const synced2 = applyDiff(inv.db, {
    deletes: {
      'account.move': [inv.id],
      'account.payment.term': [term.id],
    },
  }, { isAdmin: true });
  assert.equal(read(synced2, 'account.payment.term', term.id), undefined);
  assert.equal(read(synced2, 'account.move', inv.id), undefined);

  // Reassign invoice in upserts and delete term in deletes in same diff
  const synced3 = applyDiff(inv.db, {
    upserts: {
      'account.move': [{ ...read(inv.db, 'account.move', inv.id), invoice_payment_term_id: null }],
    },
    deletes: {
      'account.payment.term': [term.id],
    },
  }, { isAdmin: true });
  assert.equal(read(synced3, 'account.payment.term', term.id), undefined);
  assert.equal(read(synced3, 'account.move', inv.id).invoice_payment_term_id, null);

  // Still rejects deleting term when invoice reference is not removed
  assert.throws(
    () => applyDiff(inv.db, { deletes: { 'account.payment.term': [term.id] } }, { isAdmin: true }),
    /payment terms are quite popular and can't be deleted/,
  );
  assert.throws(
    () => unlink(inv.db, 'account.payment.term', [term.id]),
    /payment terms are quite popular and can't be deleted/,
  );
});

test('PTM-6: legacy payment terms violating new validation rules can be archived and renamed without re-triggering line validation', () => {
  let db = seed();
  const legacyTerm = {
    id: (db.seq['account.payment.term'] ?? 0) + 1,
    name: 'Invalid Legacy Term',
    active: true,
    display_on_invoice: true,
    early_discount: true,
    discount_percent: 2,
    discount_days: 0, // Invalid: days <= 0
    line_ids: [{ value_type: 'balance', nb_days: 30, delay_type: 'days_after' }], // Invalid: early_discount on balance line
  };
  db = {
    ...db,
    records: {
      ...db.records,
      'account.payment.term': [...(db.records['account.payment.term'] ?? []), legacyTerm],
    },
    seq: { ...db.seq, 'account.payment.term': legacyTerm.id },
  };

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-01',
    invoice_payment_term_id: legacyTerm.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = inv.db;

  // Deletion is blocked because invoice references it
  assert.throws(
    () => unlink(db, 'account.payment.term', [legacyTerm.id]),
    /Uh-oh! Those payment terms are quite popular and can't be deleted since there are still some records referencing them\. How about archiving them instead\?/,
  );

  // Archiving the legacy invalid term succeeds
  const archived = write(db, 'account.payment.term', legacyTerm.id, { active: false });
  assert.equal(read(archived, 'account.payment.term', legacyTerm.id).active, false);

  // Renaming the legacy invalid term succeeds
  const renamed = write(db, 'account.payment.term', legacyTerm.id, { name: 'Archived Legacy Term' });
  assert.equal(read(renamed, 'account.payment.term', legacyTerm.id).name, 'Archived Legacy Term');

  // But modifying its configuration enforces the validation rules
  assert.throws(
    () => write(db, 'account.payment.term', legacyTerm.id, { discount_days: 10 }),
    /The Early Payment Discount functionality can only be used with payment terms using a single 100% line./,
  );
  assert.throws(
    () => write(db, 'account.payment.term', legacyTerm.id, {
      line_ids: [{ value_type: 'percent', value: 80, nb_days: 30, delay_type: 'days_after' }],
    }),
    /The Payment Term must have at least one percent line and the sum of the percent must be 100%./,
  );
});

test('PTM-7: term preview and draft invoice PrintDoc validate schedule against selected date when due-date order flips around month-end', async () => {
  let db = seed();
  // Two valid terms whose residual percent line flips between early-month and late-month invoice dates:
  // - Term A is valid when days_end_of_month <= days_after(+15) (late month), invalid on 2026-11-01 (early month).
  // - Term B is valid when days_after(+15) <= days_end_of_month (early month), invalid on 2026-11-25 (late month).
  const cases = [
    {
      name: 'Flip Early Invalid',
      selectedDate: '2026-11-01',
      lines: [
        { value_type: 'fixed', value: 300, nb_days: 0, delay_type: 'days_after' },
        { value_type: 'percent', value: 10, nb_days: 0, delay_type: 'days_end_of_month' },
        { value_type: 'percent', value: 90, nb_days: 15, delay_type: 'days_after' },
      ],
    },
    {
      name: 'Flip Late Invalid',
      selectedDate: '2026-11-25',
      lines: [
        { value_type: 'fixed', value: 300, nb_days: 0, delay_type: 'days_after' },
        { value_type: 'percent', value: 10, nb_days: 15, delay_type: 'days_after' },
        { value_type: 'percent', value: 90, nb_days: 0, delay_type: 'days_end_of_month' },
      ],
    },
  ];

  const { PrintDoc } = await import('./views/PrintDoc.jsx');
  for (const c of cases) {
    const termRes = create(db, 'account.payment.term', {
      name: c.name,
      display_on_invoice: true,
      line_ids: c.lines,
    });
    db = termRes.db;
    const term = read(db, 'account.payment.term', termRes.id);

    // formatTermPreview must return the explicit validation message rather than throwing when example_date flips order.
    assert.equal(
      formatTermPreview({ ...term, example_amount: 1000, example_date: c.selectedDate }),
      'Payment terms must allocate 100% of the total',
    );

    const invRes = create(db, 'account.move', {
      move_type: 'out_invoice',
      partner_id: 1,
      invoice_date: c.selectedDate,
      invoice_payment_term_id: term.id,
      invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 1000, tax: 0 }],
    });
    db = invRes.db;

    // Draft PrintDoc must render cleanly without throwing and omit the invalid installment table.
    const ctx = await mountView(
      (React) => React.createElement(PrintDoc, { model: 'account.move', id: invRes.id }),
      db,
    );
    try {
      const tables = allFind(ctx.host, (n) => n.tagName === 'TABLE');
      assert.equal(tables.some((tbl) => tbl.textContent.includes('Due Date')), false);
    } finally {
      await ctx.done();
    }
  }
});
