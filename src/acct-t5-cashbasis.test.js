import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { find, setupDom } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { createCompany } from './models/company.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { payMove, postMove } from './models/accounting.js';
import { defaultTaxRepartitionLines, taxSnapshot } from './models/taxes.js';
import { accountId } from './models/ledger.js';
import { reversePayment } from './models/pay.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

async function renderSettings(setupDb) {
  const { makeEl } = setupDom();
  const prevConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { Settings } = await import('./views/Settings.jsx');
  await initStore();
  const initialDb = setupDb ? setupDb(seed()) : seed();
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

test('Item 1: res.company has tax_cash_basis_journal_id field and validates journal', async () => {
  const base = seed();
  const coField = models['res.company'].fields.tax_cash_basis_journal_id;
  assert.ok(coField, 'res.company has tax_cash_basis_journal_id field');
  assert.equal(coField.type, 'many2one');
  assert.equal(coField.relation, 'account.journal');
  assert.equal(coField.label, 'Cash Basis Journal');

  // Create a second company and journals
  const c2Res = createCompany(base, { name: 'Company 2' });
  let db = c2Res.db;
  const c2Id = c2Res.id;

  const validGeneral1 = create(db, 'account.journal', { name: 'Cash Basis J1', code: 'CB1', type: 'general', company_id: 1 });
  db = validGeneral1.db;

  const validGeneral2 = create(db, 'account.journal', { name: 'Cash Basis J2', code: 'CB2', type: 'general', company_id: c2Id });
  db = validGeneral2.db;

  const saleJournal = create(db, 'account.journal', { name: 'Sale J1', code: 'SJ1', type: 'sale', company_id: 1, default_account_id: accountId(db, '400000') });
  db = saleJournal.db;

  const archivedGeneral = create(db, 'account.journal', { name: 'Archived General', code: 'ARC', type: 'general', company_id: 1, active: false });
  db = archivedGeneral.db;

  // 1. Cross-company journal rejected on write
  assert.throws(
    () => write(db, 'res.company', 1, { tax_cash_basis_journal_id: validGeneral2.id }),
    /Cash Basis Journal.*belonging to this company/i,
  );

  // Cross-company journal rejected via diffDb + applyDiff
  const crossCoAttempt = {
    ...db,
    records: {
      ...db.records,
      'res.company': db.records['res.company'].map((c) => (c.id === 1 ? { ...c, tax_cash_basis_journal_id: validGeneral2.id } : c)),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, crossCoAttempt), { isAdmin: true }),
    /Cash Basis Journal.*belonging to this company/i,
  );

  // Non-admin rejected via diffDb + applyDiff even for valid journal
  const validAttempt = {
    ...db,
    records: {
      ...db.records,
      'res.company': db.records['res.company'].map((c) => (c.id === 1 ? { ...c, tax_cash_basis_journal_id: validGeneral1.id } : c)),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, validAttempt), { isAdmin: false }),
    /Only administrators/i,
  );

  // 2. Non-general journal rejected
  assert.throws(
    () => write(db, 'res.company', 1, { tax_cash_basis_journal_id: saleJournal.id }),
    /Cash Basis Journal.*general journal/i,
  );

  // 3. Archived journal rejected
  assert.throws(
    () => write(db, 'res.company', 1, { tax_cash_basis_journal_id: archivedGeneral.id }),
    /Cash Basis Journal.*active/i,
  );

  // 4. Non-existent journal rejected
  assert.throws(
    () => write(db, 'res.company', 1, { tax_cash_basis_journal_id: 999999 }),
    /Cash Basis Journal/i,
  );

  // 5. Valid general journal belonging to company accepted
  const validDb = write(db, 'res.company', 1, { tax_cash_basis_journal_id: validGeneral1.id });
  assert.equal(read(validDb, 'res.company', 1).tax_cash_basis_journal_id, validGeneral1.id);

  // 6. Clearing tax_cash_basis_journal_id accepted
  const clearedDb = write(validDb, 'res.company', 1, { tax_cash_basis_journal_id: null });
  assert.equal(read(clearedDb, 'res.company', 1).tax_cash_basis_journal_id, null);
});

test('Item 2: Settings shows tax_cash_basis_journal_id in Taxes section', async () => {
  const { validateCompanySettingWrite } = await import('./views/Settings.jsx');

  const ctx = await renderSettings((base) => {
    const customJ = create(base, 'account.journal', { name: 'Tax Cash Basis Ops', code: 'TCB', type: 'general', company_id: 1 });
    return customJ.db;
  });

  try {
    const taxesBlock = find(ctx.host, (n) => props(n)?.['data-block'] === 'taxes');
    assert.ok(taxesBlock, 'Taxes block rendered');

    // Setting row exists in Taxes section
    const cbSettingRow = find(taxesBlock, (n) => props(n)?.['data-setting'] === 'tax_cash_basis_journal_id');
    assert.ok(cbSettingRow, 'tax_cash_basis_journal_id SettingRow rendered in Taxes section');

    const label = find(cbSettingRow, (n) => n.tagName === 'LABEL');
    assert.equal(label?.textContent, 'Cash Basis Journal');

    const select = ctx.control('tax_cash_basis_journal_id');
    assert.ok(select, '#tax_cash_basis_journal_id control exists');

    // Select custom journal and write
    const customJournal = search(ctx.getDb(), 'account.journal').find((j) => j.code === 'TCB');
    assert.ok(customJournal);

    await ctx.React.act(async () => {
      props(select).onChange({ target: { value: String(customJournal.id) } });
    });

    const updatedCo = read(ctx.getDb(), 'res.company', 1);
    assert.equal(updatedCo.tax_cash_basis_journal_id, customJournal.id);

    // validateCompanySettingWrite validates tax_cash_basis_journal_id
    const err = validateCompanySettingWrite(ctx.getDb(), updatedCo, { tax_cash_basis_journal_id: 999999 });
    assert.match(err, /Select an active general journal belonging to this company/i);
  } finally {
    await ctx.cleanup();
  }
});

test('Item 3: Cash basis releases post into tax_cash_basis_journal_id', () => {
  let db = seed();
  const customJournal = create(db, 'account.journal', {
    name: 'Custom Cash Basis',
    code: 'CBTAX',
    type: 'general',
    company_id: 1,
  });
  db = customJournal.db;

  // Set tax_cash_basis_journal_id on company 1
  db = write(db, 'res.company', 1, { tax_cash_basis_journal_id: customJournal.id });

  const taxAcc = accountId(db, '251000');
  const cashTax = create(db, 'account.tax', {
    name: 'Test Cash Basis Tax 10%',
    type_tax_use: 'sale',
    amount: 10,
    amount_type: 'percent',
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: accountId(db, '251100'),
    ...defaultTaxRepartitionLines(taxAcc),
  });
  db = cashTax.db;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', cashTax.id)) }],
  });
  db = postMove(inv.db, inv.id);

  // Pay invoice: 100 + 10 = 110
  db = payMove(db, inv.id, 110, '2026-06-02');

  const relMove = search(db, 'account.move').find((m) => m.cash_basis_origin_move_id === inv.id);
  assert.ok(relMove, 'Cash basis release entry generated');
  assert.equal(relMove.journal_id, customJournal.id, 'Release entry posted into tax_cash_basis_journal_id');
});

test('Item 4: When tax_cash_basis_journal_id is not set, default misc journal is resolved without code MISC', () => {
  let db = seed();

  // Company 1 has no tax_cash_basis_journal_id set
  assert.equal(read(db, 'res.company', 1).tax_cash_basis_journal_id, undefined);

  // Rename the default general journal code from MISC to GENOPS to verify it never picks by code
  const defGeneralId = read(db, 'res.company', 1).default_general_journal_id;
  assert.ok(defGeneralId, 'Default general journal exists');
  db = write(db, 'account.journal', defGeneralId, { code: 'GENOPS' });

  const taxAcc = accountId(db, '251000');
  const cashTax = create(db, 'account.tax', {
    name: 'Default Cash Basis Tax 10%',
    type_tax_use: 'sale',
    amount: 10,
    amount_type: 'percent',
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: accountId(db, '251100'),
    ...defaultTaxRepartitionLines(taxAcc),
  });
  db = cashTax.db;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-06-10',
    invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', cashTax.id)) }],
  });
  db = postMove(inv.db, inv.id);

  // Pay invoice
  db = payMove(db, inv.id, 110, '2026-06-11');

  const relMove = search(db, 'account.move').find((m) => m.cash_basis_origin_move_id === inv.id);
  assert.ok(relMove, 'Cash basis release entry generated');
  assert.equal(relMove.journal_id, defGeneralId, 'Release entry posted into resolved default general journal');
});

function cashBasisInvoice(db, date) {
  const taxAcc = accountId(db, '251000');
  const tax = create(db, 'account.tax', {
    name: `Cash Basis Tax ${date}`, type_tax_use: 'sale', amount: 10, amount_type: 'percent', tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: accountId(db, '251100'), ...defaultTaxRepartitionLines(taxAcc),
  });
  const inv = create(tax.db, 'account.move', {
    move_type: 'out_invoice', partner_id: 1, invoice_date: date,
    invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(read(tax.db, 'account.tax', tax.id)) }],
  });
  return { db: postMove(inv.db, inv.id), invoiceId: inv.id };
}

test('reversing a cash basis payment posts the reversal into the release journal', () => {
  const journal = create(seed(), 'account.journal', { name: 'Cash Basis Ops', code: 'CBOPS', type: 'general', company_id: 1 });
  let db = write(journal.db, 'res.company', 1, { tax_cash_basis_journal_id: journal.id });
  const { db: posted, invoiceId } = cashBasisInvoice(db, '2026-06-01');
  db = payMove(posted, invoiceId, 110, '2026-06-02');
  const payment = search(db, 'account.payment').find((p) => p.invoice_id === invoiceId && p.state === 'posted');
  db = reversePayment(db, payment, '2026-06-05');
  const releases = search(db, 'account.move').filter((m) => m.cash_basis_origin_move_id === invoiceId);
  assert.equal(releases.length, 2, 'release and its reversal');
  assert.ok(releases.every((m) => m.journal_id === journal.id));
});

test('a journal used as a cash basis journal cannot be archived, retyped or moved to another company', () => {
  const journal = create(seed(), 'account.journal', { name: 'Cash Basis Ops', code: 'CBOPS', type: 'general', company_id: 1 });
  const db = write(journal.db, 'res.company', 1, { tax_cash_basis_journal_id: journal.id });
  const other = createCompany(db, { name: 'Company 2' });
  for (const change of [{ active: false }, { type: 'sale' }, { company_id: other.id }]) {
    const attempt = { ...other.db, records: { ...other.db.records, 'account.journal': other.db.records['account.journal'].map((j) => (j.id === journal.id ? { ...j, ...change } : j)) } };
    assert.throws(() => applyDiff(other.db, diffDb(other.db, attempt), { isAdmin: true }), /Clear the Cash Basis Journal/);
  }
  const cleared = write(db, 'res.company', 1, { tax_cash_basis_journal_id: null });
  assert.equal(read(write(cleared, 'account.journal', journal.id, { active: false }), 'account.journal', journal.id).active, false);
});

test('a company without a cash basis or default general journal keeps posting releases', () => {
  const extra = create(seed(), 'account.journal', { name: 'Second General', code: 'GEN2', type: 'general', company_id: 1 });
  let db = write(extra.db, 'res.company', 1, { default_general_journal_id: null });
  const { db: posted, invoiceId } = cashBasisInvoice(db, '2026-06-10');
  db = payMove(posted, invoiceId, 110, '2026-06-11');
  assert.ok(search(db, 'account.move').some((m) => m.cash_basis_origin_move_id === invoiceId), 'release posted');
});

test('a shared cash basis journal cannot be assigned to one of the companies that use it', () => {
  const other = createCompany(seed(), { name: 'Company 2' });
  const shared = create(other.db, 'account.journal', { name: 'Shared Cash Basis', code: 'SCB', type: 'general', company_id: null });
  let db = write(shared.db, 'res.company', 1, { tax_cash_basis_journal_id: shared.id });
  db = write(db, 'res.company', other.id, { tax_cash_basis_journal_id: shared.id });
  for (const companyId of [1, other.id]) {
    const attempt = { ...db, records: { ...db.records, 'account.journal': db.records['account.journal'].map((j) => (j.id === shared.id ? { ...j, company_id: companyId } : j)) } };
    assert.throws(() => applyDiff(db, diffDb(db, attempt), { isAdmin: true }), /Clear the Cash Basis Journal/);
  }
});
