import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { create, read, write } from './orm.js';
import { models } from './models/index.js';
import { fieldReadonly } from './field-metadata.js';
import { setCompanies } from './models/company.js';
import { ruleMatches } from './models/reconcile.js';
import { defaultTaxRepartitionLines } from './models/taxes.js';
import { migrate } from './migrations.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const MODEL = 'account.reconcile.model';

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

async function mountView(renderElement, initialDb) {
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
  await initStore();
  await commit(initialDb);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => root.render(renderElement(React)));
  return {
    host,
    React,
    getDb,
    async done() {
      await React.act(async () => root.unmount());
      if (prevStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = prevStorage;
    },
  };
}

test('RCM-1: company_id is required, defaults to current company, enforces company guards over diff, and leaves legacy companyless records until resaved', async () => {
  const def = models[MODEL];
  assert.equal(def.fields.company_id.required, true);
  assert.equal(def.fields.company_id.copy, false);
  assert.equal(def.fields.company_id.multiCompanyOnly, true);
  assert.equal(fieldReadonly(def.fields.company_id, { company_id: 1 }, {}), true);
  assert.equal(fieldReadonly(def.fields.company_id, { company_id: null }, {}), false);
  assert.equal(fieldReadonly(def.fields.company_id, { company_id: null }, {}, { isNew: true }), true);

  let db = seed();
  const co2 = create(db, 'res.company', { name: 'Second Co', currency_id: 1 });
  db = co2.db;
  db = setCompanies(db, { current: co2.id, allowed: [1, co2.id] });

  assert.equal(def.fields.company_id.default(db), co2.id);

  // Default company on create and new-form defaults is the current company
  const created = create(db, MODEL, { name: 'Co2 Default Rule' });
  assert.equal(read(created.db, MODEL, created.id).company_id, co2.id);
  const { newDefaults } = await import('./views/formDefaults.js');
  const { menusFor } = await import('./models/index.js');
  const leaf = findLeafByKey(menusFor('accounting'), 'reconcile-models');
  assert.equal(newDefaults(db, MODEL, leaf, new URLSearchParams(), null).company_id, co2.id);

  // Saving without a company is rejected on create and through diffDb + applyDiff
  assert.throws(() => create(db, MODEL, { name: 'Missing Co', company_id: null }), /Company is required/);
  const forgedNoCo = {
    ...db,
    records: {
      ...db.records,
      [MODEL]: [...(db.records[MODEL] ?? []), {
        id: 9101,
        name: 'Forged Missing Co',
        sequence: 10,
        trigger: 'manual',
        rule_type: 'reco_model',
        line_ids: [],
      }],
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, forgedNoCo), { isAdmin: true }), /Company is required/);

  // Create company-1 and company-2 accounts, journals, taxes, and partners for cross-company guard checks
  const acc1 = create(db, 'account.account', { code: '600801', name: 'Co1 Exp', account_type: 'expense', company_id: 1 });
  const acc2 = create(acc1.db, 'account.account', { code: '600802', name: 'Co2 Exp', account_type: 'expense', company_id: co2.id });
  const taxAcc2 = create(acc2.db, 'account.account', { code: '251802', name: 'Co2 Tax Acc', account_type: 'liability_current', company_id: co2.id });
  const bankAcc2 = create(taxAcc2.db, 'account.account', { code: '101802', name: 'Co2 Bank Acc', account_type: 'asset_cash', company_id: co2.id });
  const suspAcc2 = create(bankAcc2.db, 'account.account', { code: '101803', name: 'Co2 Susp Acc', account_type: 'asset_current', company_id: co2.id });
  const journal2 = create(suspAcc2.db, 'account.journal', {
    name: 'Co2 Bank', code: 'B2R', type: 'bank', company_id: co2.id,
    default_account_id: bankAcc2.id, suspense_account_id: suspAcc2.id,
  });
  const tax2 = create(journal2.db, 'account.tax', {
    name: 'Co2 VAT', amount: 15, amount_type: 'percent', type_tax_use: 'sale', company_id: co2.id,
    ...defaultTaxRepartitionLines(taxAcc2.id),
  });
  const partner2 = create(tax2.db, 'res.partner', { name: 'Co2 Partner', company_id: co2.id });
  const baseRule = create(partner2.db, MODEL, {
    name: 'Co1 Valid Rule',
    company_id: 1,
    line_ids: [{ account_id: acc1.id, amount_type: 'percentage', amount_string: '100' }],
  });
  db = baseRule.db;

  const forgeRule = (patch) => ({
    ...db,
    records: {
      ...db.records,
      [MODEL]: db.records[MODEL].map((r) => (r.id === baseRule.id ? { ...r, ...patch } : r)),
    },
  });

  // Rejects line account from another company via diffDb + applyDiff
  assert.throws(
    () => applyDiff(db, diffDb(db, forgeRule({
      line_ids: [{ account_id: acc2.id, amount_type: 'percentage', amount_string: '100' }],
    })), { isAdmin: true }),
    /Reconciliation accounts must be active and belong to the model company/,
  );

  // Rejects match_journal_ids from another company via diffDb + applyDiff
  assert.throws(
    () => applyDiff(db, diffDb(db, forgeRule({
      match_journal_ids: [journal2.id],
    })), { isAdmin: true }),
    /Journals in the reconciliation model must belong to the model company/,
  );

  // Rejects line tax_ids from another company via diffDb + applyDiff
  assert.throws(
    () => applyDiff(db, diffDb(db, forgeRule({
      line_ids: [{ account_id: acc1.id, amount_type: 'percentage', amount_string: '100', tax_ids: [tax2.id] }],
    })), { isAdmin: true }),
    /Tax belongs to another company/,
  );

  // Rejects line partner_id from another company via diffDb + applyDiff
  assert.throws(
    () => applyDiff(db, diffDb(db, forgeRule({
      line_ids: [{ account_id: acc1.id, partner_id: partner2.id, amount_type: 'percentage', amount_string: '100' }],
    })), { isAdmin: true }),
    /Partner in counterpart item must belong to the model company/,
  );

  // Existing records without company: do not guess during migration, keep working for reads/matching, reject only when saved again
  const legacyDb = {
    ...db,
    schema_version: 39,
    records: {
      ...db.records,
      [MODEL]: [...(db.records[MODEL] ?? []), {
        id: 9200,
        name: 'Legacy No Company',
        rule_type: 'writeoff_button',
        active: true,
        match_label: 'contains',
        match_label_param: 'LEGACY',
        line_ids: [{ account_id: acc1.id, amount_type: 'percentage', amount: 100 }],
      }],
    },
  };
  const migrated = migrate(legacyDb, 72);
  const legacyRec = read(migrated, MODEL, 9200);
  assert.equal(legacyRec.company_id ?? null, null, 'migration does not guess a company for existing companyless records');
  assert.equal(ruleMatches(legacyRec, { payment_ref: 'LEGACY FEE', amount: -10 }), true);

  assert.throws(() => write(migrated, MODEL, 9200, { name: 'Resaved' }), /Company is required/);
  const forgedResave = {
    ...migrated,
    records: {
      ...migrated.records,
      [MODEL]: migrated.records[MODEL].map((r) => (r.id === 9200 ? { ...r, name: 'Resaved' } : r)),
    },
  };
  assert.throws(() => applyDiff(migrated, diffDb(migrated, forgedResave), { isAdmin: true }), /Company is required/);

  // One-time assignment succeeds via write and applyDiff, then company becomes immutable
  const assigned = write(migrated, MODEL, 9200, { company_id: 1 });
  assert.equal(read(assigned, MODEL, 9200).company_id, 1);
  assert.throws(() => write(assigned, MODEL, 9200, { company_id: co2.id }), /Company cannot be changed once assigned/);
  const forgedReassign = {
    ...assigned,
    records: {
      ...assigned.records,
      [MODEL]: assigned.records[MODEL].map((r) => (r.id === 9200 ? { ...r, company_id: co2.id } : r)),
    },
  };
  assert.throws(() => applyDiff(assigned, diffDb(assigned, forgedReassign), { isAdmin: true }), /Company cannot be changed once assigned/);

  const legacyForDiff = {
    ...migrated,
    records: {
      ...migrated.records,
      [MODEL]: migrated.records[MODEL].map((r) => (r.id === 9200 ? { ...r, company_id: 1, active: false } : r)),
    },
  };
  const syncedAssign = applyDiff(migrated, diffDb(migrated, legacyForDiff), { isAdmin: true });
  assert.equal(read(syncedAssign, MODEL, 9200).company_id, 1);
  assert.equal(read(syncedAssign, MODEL, 9200).active, false);

  // Arabic translations exist for every new validation message
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => 'ar' };
  try {
    const { t: tAr } = await import(`./i18n.js?rcm2=${Date.now()}`);
    for (const msg of [
      'Company is required',
      'Company cannot be changed once assigned',
      'Journals in the reconciliation model must belong to the model company',
      'Partner in counterpart item must belong to the model company',
      'Reconciliation accounts must be active and belong to the model company',
    ]) {
      assert.notEqual(tAr(msg), msg, `missing Arabic translation for ${msg}`);
    }
  } finally {
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
  }
});

test('RCM-2: company_id is shown in form and list only in multi-company, readonly on form, and form shows validation error when resaving companyless record', async () => {
  const { menusFor } = await import('./models/index.js');
  const { ActionView } = await import('./views/ActionView.jsx');
  const { FormView } = await import('./views/FormView.jsx');
  const leaf = findLeafByKey(menusFor('accounting'), 'reconcile-models');
  const def = models[MODEL];

  assert.deepEqual(def.list, ['sequence', 'name', 'trigger', 'match_journal_ids', 'company_id']);
  const formGroupFields = def.form.groups({ rule_type: 'reco_model' })[0];
  assert.ok(formGroupFields.includes('company_id'));

  const base = seed();
  const rule = create(base, MODEL, { name: 'UI Rule', company_id: 1 });
  const singleDb = rule.db;

  // Single-company list hides Company column
  const singleList = await mountView(
    (React) => React.createElement(ActionView, { leaf, base: '#/accounting/reconcile-models', params: new URLSearchParams() }),
    singleDb,
  );
  try {
    const table = find(singleList.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    const headers = allFind(table, (n) => n.tagName === 'TH').map((th) => th.textContent.replace(/[▲▼⋯]/g, '').trim()).filter(Boolean);
    assert.deepEqual(headers, ['Name', 'Trigger']);
    assert.equal(headers.includes('Company'), false, 'Company column hidden in single-company list');
  } finally {
    await singleList.done();
  }

  // Single-company form hides Company field
  const singleForm = await mountView(
    (React) => React.createElement(FormView, { leaf, id: String(rule.id), base: '#/accounting/reconcile-models', params: new URLSearchParams('view=list') }),
    singleDb,
  );
  try {
    assert.equal(fieldLabelsOf(singleForm.host).includes('Company'), false, 'Company field hidden in single-company form');
  } finally {
    await singleForm.done();
  }

  // Multi-company list shows Company column and form shows readonly Company field
  const multiDb = create(singleDb, 'res.company', { name: 'Branch Co', currency_id: 1 }).db;
  const multiList = await mountView(
    (React) => React.createElement(ActionView, { leaf, base: '#/accounting/reconcile-models', params: new URLSearchParams() }),
    multiDb,
  );
  try {
    const table = find(multiList.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    const headers = allFind(table, (n) => n.tagName === 'TH').map((th) => th.textContent.replace(/[▲▼⋯]/g, '').trim()).filter(Boolean);
    assert.deepEqual(headers, ['Name', 'Trigger', 'Company']);
  } finally {
    await multiList.done();
  }

  const multiForm = await mountView(
    (React) => React.createElement(FormView, { leaf, id: String(rule.id), base: '#/accounting/reconcile-models', params: new URLSearchParams('view=list') }),
    multiDb,
  );
  try {
    assert.ok(fieldLabelsOf(multiForm.host).includes('Company'), 'Company field shown in multi-company form');
    const companyField = allFind(multiForm.host, (n) => hasClass(n, 'field')).find((n) => n.childNodes[0]?.textContent?.replaceAll('*', '').trim() === 'Company');
    assert.ok(find(companyField, (n) => hasClass(n, 'readonly')), 'Company field is readonly on form');
    assert.equal(find(companyField, (n) => n.tagName === 'SELECT'), null);
  } finally {
    await multiForm.done();
  }

  // Legacy companyless record shows validation error on form only when saved again
  const legacyDb = {
    ...multiDb,
    records: {
      ...multiDb.records,
      [MODEL]: [...(multiDb.records[MODEL] ?? []), {
        id: 9300,
        name: 'Legacy UI Rule',
        sequence: 10,
        trigger: 'manual',
        rule_type: 'reco_model',
        active: true,
        line_ids: [],
      }],
    },
  };
  const legacyForm = await mountView(
    (React) => React.createElement(FormView, { leaf, id: '9300', base: '#/accounting/reconcile-models', params: new URLSearchParams('view=list') }),
    legacyDb,
  );
  try {
    assert.equal(find(legacyForm.host, (n) => hasClass(n, 'alert')), null, 'no error before saving');
    const automateBtn = find(legacyForm.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Automate');
    assert.ok(automateBtn);
    await legacyForm.React.act(async () => {
      props(automateBtn).onClick();
    });
    const alertBox = find(legacyForm.host, (n) => hasClass(n, 'alert'));
    assert.ok(alertBox?.textContent.includes('Company is required'), 'shows validation error when resaving companyless record');

    // Legacy companyless rule exposes an editable Company select, keeps it editable until saved, then locks it
    const companySelect = find(legacyForm.host, (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-company_id');
    assert.ok(companySelect, 'legacy companyless rule shows editable Company select');
    await legacyForm.React.act(async () => {
      props(companySelect).onChange({ target: { value: '1' } });
    });
    assert.ok(
      find(legacyForm.host, (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-company_id'),
      'Company select remains editable before Save so user can adjust choice',
    );
    const saveBtn = find(legacyForm.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Save');
    assert.ok(saveBtn);
    await legacyForm.React.act(async () => {
      props(saveBtn).onClick();
    });
    assert.equal(find(legacyForm.host, (n) => hasClass(n, 'alert')), null);
    assert.equal(read(legacyForm.getDb(), MODEL, 9300).company_id, 1);
    assert.equal(find(legacyForm.host, (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-company_id'), null, 'Company select becomes readonly after assignment');

    // User can now edit and disable the rule
    const nameInput = find(legacyForm.host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-name');
    const activeInput = find(legacyForm.host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-active');
    await legacyForm.React.act(async () => {
      props(nameInput).onChange({ target: { value: 'Legacy Fixed Rule' } });
      props(activeInput).onChange({ target: { checked: false } });
    });
    const saveEditBtn = find(legacyForm.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Save');
    await legacyForm.React.act(async () => {
      props(saveEditBtn).onClick();
    });
    const updated = read(legacyForm.getDb(), MODEL, 9300);
    assert.equal(updated.name, 'Legacy Fixed Rule');
    assert.equal(updated.active, false);
    assert.equal(updated.company_id, 1);
  } finally {
    await legacyForm.done();
  }
});

test('RCM-3: single-company form reveals editable Company field only for companyless legacy rules, allows one-time assignment, and then hides/locks it', async () => {
  const { menusFor } = await import('./models/index.js');
  const { FormView } = await import('./views/FormView.jsx');
  const leaf = findLeafByKey(menusFor('accounting'), 'reconcile-models');

  const base = seed();
  const migrated = migrate({
    ...base,
    schema_version: 39,
    records: {
      ...base.records,
      [MODEL]: [...(base.records[MODEL] ?? []), {
        id: 9400,
        name: 'Single Co Legacy Rule',
        sequence: 10,
        trigger: 'manual',
        rule_type: 'reco_model',
        active: true,
        line_ids: [],
      }],
    },
  }, 72);
  assert.equal(read(migrated, MODEL, 9400).company_id ?? null, null, 'migration still does not guess company');

  // New form in single-company still hides Company (defaults to current company)
  const newForm = await mountView(
    (React) => React.createElement(FormView, { leaf, id: 'new', base: '#/accounting/reconcile-models', params: new URLSearchParams('view=list') }),
    migrated,
  );
  try {
    assert.equal(fieldLabelsOf(newForm.host).includes('Company'), false, 'new single-company form hides Company');
  } finally {
    await newForm.done();
  }

  const singleLegacyForm = await mountView(
    (React) => React.createElement(FormView, { leaf, id: '9400', base: '#/accounting/reconcile-models', params: new URLSearchParams('view=list') }),
    migrated,
  );
  try {
    assert.ok(fieldLabelsOf(singleLegacyForm.host).includes('Company'), 'single-company form reveals Company when missing on legacy rule');
    const companySelect = find(singleLegacyForm.host, (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-company_id');
    assert.ok(companySelect, 'Company field is editable in single-company form for legacy rule');

    // Actions -> Archive without company surfaces validation error on form instead of throwing
    const actionsBtn = find(singleLegacyForm.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Actions');
    await singleLegacyForm.React.act(async () => {
      props(actionsBtn).onClick();
    });
    const archiveBtn = find(singleLegacyForm.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Archive');
    await singleLegacyForm.React.act(async () => {
      props(archiveBtn).onClick();
    });
    assert.ok(find(singleLegacyForm.host, (n) => hasClass(n, 'alert'))?.textContent.includes('Company is required'));

    // Assign company and save -> Company hides again in single-company DB and rule can be disabled
    await singleLegacyForm.React.act(async () => {
      props(companySelect).onChange({ target: { value: '1' } });
    });
    assert.ok(fieldLabelsOf(singleLegacyForm.host).includes('Company'), 'stays visible until saved');
    const saveBtn = find(singleLegacyForm.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Save');
    await singleLegacyForm.React.act(async () => {
      props(saveBtn).onClick();
    });
    assert.equal(read(singleLegacyForm.getDb(), MODEL, 9400).company_id, 1);
    assert.equal(fieldLabelsOf(singleLegacyForm.host).includes('Company'), false, 'Company hides again after assignment in single-company DB');

    // Disable rule via Actions -> Archive after company assignment
    const actionsBtn2 = find(singleLegacyForm.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Actions');
    await singleLegacyForm.React.act(async () => {
      props(actionsBtn2).onClick();
    });
    const archiveBtn2 = find(singleLegacyForm.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Archive');
    await singleLegacyForm.React.act(async () => {
      props(archiveBtn2).onClick();
    });
    assert.equal(read(singleLegacyForm.getDb(), MODEL, 9400).active, false);
  } finally {
    await singleLegacyForm.done();
  }
});
