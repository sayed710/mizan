import { register } from 'node:module';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { changeFormValue, newDefaults } from './views/formDefaults.js';

const run = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id));

function setup() {
  let db = seed();
  const [firstIncoterm, secondIncoterm, thirdIncoterm] = db.records['account.incoterm'];
  db = write(db, 'res.company', 1, { use_invoice_terms: true, invoice_terms: 'Company one terms', incoterm_id: firstIncoterm.id });
  const second = create(db, 'res.company', {
    name: 'Second company',
    currency_id: read(db, 'res.company', 1).currency_id,
    use_invoice_terms: true,
    invoice_terms: 'Company two terms',
    incoterm_id: secondIncoterm.id,
  });
  return { db: second.db, companyId: second.id, incoterm1: firstIncoterm.id, incoterm2: secondIncoterm.id, incoterm3: thirdIncoterm.id };
}

function invoice(db, vals) {
  const result = create(db, 'account.move', vals);
  return read(result.db, 'account.move', result.id);
}

test('default terms follow invoice company and respect document type and explicit narration', () => {
  const { db, companyId } = setup();
  assert.equal(invoice(db, { move_type: 'out_invoice', company_id: companyId }).narration, 'Company two terms');
  assert.equal(invoice(db, { move_type: 'out_refund', company_id: 1 }).narration, 'Company one terms');
  assert.equal(invoice(db, { move_type: 'out_invoice', company_id: companyId, narration: '' }).narration, '');
  assert.equal(invoice(db, { move_type: 'in_invoice', company_id: companyId }).narration, undefined);
  assert.equal(invoice({ ...db, settings: { ...db.settings, current_company_id: companyId } }, { move_type: 'out_invoice' }).narration, 'Company two terms');
  const disabled = write(db, 'res.company', companyId, { use_invoice_terms: false });
  assert.equal(invoice(disabled, { move_type: 'out_invoice', company_id: companyId }).narration, undefined);
  const changed = models['account.move'].onchange({ move_type: 'out_invoice', company_id: companyId, narration: 'Company one terms' }, 'company_id', db, { previous: { company_id: 1 } });
  assert.equal(changed.narration, 'Company two terms');
  assert.equal(models['account.move'].onchange({ move_type: 'out_invoice', company_id: companyId, narration: 'Custom' }, 'company_id', db, { previous: { company_id: 1 } }).narration, undefined);

  // Form defaults with active company 2 and no explicit company_id
  const defs = newDefaults({ ...db, settings: { ...db.settings, current_company_id: companyId } }, 'account.move', { defaults: {} }, new URLSearchParams(), null);
  assert.equal(defs.narration, 'Company two terms');
});

test('default incoterm follows invoice company and respects explicit selection', () => {
  const { db, companyId, incoterm1, incoterm2, incoterm3 } = setup();
  assert.equal(invoice(db, { move_type: 'out_invoice', company_id: companyId }).incoterm_id, incoterm2);
  assert.equal(invoice(db, { move_type: 'out_invoice', company_id: 1 }).incoterm_id, incoterm1);
  assert.equal(invoice(db, { move_type: 'out_invoice', company_id: companyId, incoterm_id: incoterm3 }).incoterm_id, incoterm3);
  assert.equal(invoice(db, { move_type: 'in_invoice', company_id: companyId }).incoterm_id, undefined);
  assert.equal(invoice({ ...db, settings: { ...db.settings, current_company_id: companyId } }, { move_type: 'out_invoice' }).incoterm_id, incoterm2);
  const changed = models['account.move'].onchange({ move_type: 'out_invoice', company_id: companyId, incoterm_id: incoterm1 }, 'company_id', db, { previous: { company_id: 1 } });
  assert.equal(changed.incoterm_id, incoterm2);
  assert.equal(models['account.move'].onchange({ move_type: 'out_invoice', company_id: companyId, incoterm_id: incoterm3 }, 'company_id', db, { previous: { company_id: 1 } }).incoterm_id, undefined);

  // Form defaults with active company 2 and no explicit company_id
  const defs = newDefaults({ ...db, settings: { ...db.settings, current_company_id: companyId } }, 'account.move', { defaults: {} }, new URLSearchParams(), null);
  assert.equal(defs.incoterm_id, incoterm2);
});

test('non-admin cannot change invoice terms or incoterm defaults on res.company', () => {
  const { db } = setup();
  const nonAdmin = { isAdmin: false };
  for (const field of ['use_invoice_terms', 'invoice_terms', 'incoterm_id']) {
    const edited = write(db, 'res.company', 1, { [field]: field === 'use_invoice_terms' ? false : field === 'invoice_terms' ? 'Hacked' : null });
    assert.throws(
      () => applyDiff(db, diffDb(db, edited), nonAdmin),
      /Only administrators can change lock dates or the audit trail or other company accounting settings/
    );
  }
  const adminEdited = write(db, 'res.company', 1, { invoice_terms: 'Admin updated' });
  const applied = applyDiff(db, diffDb(db, adminEdited), { isAdmin: true });
  assert.equal(read(applied, 'res.company', 1).invoice_terms, 'Admin updated');
});

test('blank terms swap when untouched invoice switches company', () => {
  let db = seed();
  const [inc1, inc2] = db.records['account.incoterm'];
  db = write(db, 'res.company', 1, { use_invoice_terms: true, invoice_terms: null, incoterm_id: inc1.id });
  const second = create(db, 'res.company', { name: 'Second company', currency_id: read(db, 'res.company', 1).currency_id, use_invoice_terms: true, invoice_terms: 'Populated terms', incoterm_id: inc2.id });
  db = second.db;
  const changed = models['account.move'].onchange(
    { move_type: 'out_invoice', company_id: second.id, narration: '' },
    'company_id',
    db,
    { previous: { company_id: 1 } }
  );
  assert.equal(changed.narration, 'Populated terms');
});

test('sales order invoicing inherits company default incoterm when unset and respects selected order incoterm', () => {
  const { db, incoterm1, incoterm3 } = setup();
  const partner = db.records['res.partner'][0];
  const product = db.records.product[0];
  const orderRes = create(db, 'sale.order', {
    partner_id: partner.id,
    order_line: [{ product_id: product.id, qty: 1, price_unit: 100 }],
  });
  let orderDb = orderRes.db;
  orderDb = run(orderDb, 'sale.order', orderRes.id, 'Confirm').db;
  const invoiced = run(orderDb, 'sale.order', orderRes.id, 'Create Invoice');
  const invId = Number(invoiced.go.split('/').pop());
  const createdInv = read(invoiced.db, 'account.move', invId);
  assert.equal(createdInv.incoterm_id, incoterm1);

  const orderWithIncoterm = create(orderDb, 'sale.order', {
    partner_id: partner.id,
    incoterm_id: incoterm3,
    order_line: [{ product_id: product.id, qty: 1, price_unit: 100 }],
  });
  orderDb = orderWithIncoterm.db;
  orderDb = run(orderDb, 'sale.order', orderWithIncoterm.id, 'Confirm').db;
  const invoicedWith = run(orderDb, 'sale.order', orderWithIncoterm.id, 'Create Invoice');
  const invIdWith = Number(invoicedWith.go.split('/').pop());
  const createdInvWith = read(invoicedWith.db, 'account.move', invIdWith);
  assert.equal(createdInvWith.incoterm_id, incoterm3);
});

test('explicit form edit matching default is preserved on company change', () => {
  const { db, companyId, incoterm1, incoterm2 } = setup();
  const initial = newDefaults(db, 'account.move', { defaults: {} }, new URLSearchParams(), null);

  // User explicitly edits narration to the same text as company 1 default
  const editedFields = new Set(['narration']);
  const change1 = changeFormValue('account.move', initial, {}, 'narration', 'Company one terms', db, undefined, editedFields);
  assert.equal(change1.narration, 'Company one terms');

  // Now company is changed to Company 2; narration must not be replaced
  const change2 = changeFormValue('account.move', initial, change1, 'company_id', companyId, db, undefined, editedFields);
  assert.equal(change2.narration, 'Company one terms');

  // User explicitly edits incoterm_id to the same ID as company 1 default
  const editedIncoterm = new Set(['incoterm_id']);
  const change3 = changeFormValue('account.move', initial, {}, 'incoterm_id', incoterm1, db, undefined, editedIncoterm);
  const change4 = changeFormValue('account.move', initial, change3, 'company_id', companyId, db, undefined, editedIncoterm);
  assert.equal(change4.incoterm_id, incoterm1);

  // Untouched defaults DO swap
  const untouched = changeFormValue('account.move', initial, {}, 'company_id', companyId, db, undefined, new Set());
  assert.equal(untouched.narration, 'Company two terms');
  assert.equal(untouched.incoterm_id, incoterm2);
});

test('company guard rejects nonexistent or archived incoterm IDs', () => {
  const { db } = setup();
  const archived = create(db, 'account.incoterm', { code: 'ARC', name: 'Archived Incoterm', active: false });
  assert.throws(
    () => write(archived.db, 'res.company', 1, { incoterm_id: 99999 }),
    /Select an active incoterm/
  );
  assert.throws(
    () => write(archived.db, 'res.company', 1, { incoterm_id: archived.id }),
    /Select an active incoterm/
  );
  const badEdit = {
    ...archived.db,
    records: {
      ...archived.db.records,
      'res.company': archived.db.records['res.company'].map((c) => (c.id === 1 ? { ...c, incoterm_id: archived.id } : c)),
    },
  };
  assert.throws(
    () => applyDiff(archived.db, diffDb(archived.db, badEdit), { isAdmin: true }),
    /Select an active incoterm/
  );
});

test('archived incoterm allows unrelated company edits but rejects new assignment', () => {
  const { db, incoterm1 } = setup();
  assert.equal(read(db, 'res.company', 1).incoterm_id, incoterm1);

  // Archive company 1's currently selected default incoterm
  const archivedDb = write(db, 'account.incoterm', incoterm1, { active: false });
  assert.equal(read(archivedDb, 'account.incoterm', incoterm1).active, false);

  // Updating an unrelated company field must succeed via write and diffDb/applyDiff
  const updatedDb = write(archivedDb, 'res.company', 1, { name: 'Renamed Company 1' });
  assert.equal(read(updatedDb, 'res.company', 1).name, 'Renamed Company 1');
  assert.equal(read(updatedDb, 'res.company', 1).incoterm_id, incoterm1);

  const diffDbApplied = applyDiff(archivedDb, diffDb(archivedDb, updatedDb), { isAdmin: true });
  assert.equal(read(diffDbApplied, 'res.company', 1).name, 'Renamed Company 1');

  // But assigning an archived incoterm as a new or changed default is still rejected
  const anotherArchived = create(archivedDb, 'account.incoterm', { code: 'ARC2', name: 'Archived Incoterm 2', active: false });
  assert.throws(
    () => write(anotherArchived.db, 'res.company', 1, { incoterm_id: anotherArchived.id }),
    /Select an active incoterm/
  );
  const diffBad = {
    ...anotherArchived.db,
    records: {
      ...anotherArchived.db.records,
      'res.company': anotherArchived.db.records['res.company'].map((c) => (c.id === 1 ? { ...c, incoterm_id: anotherArchived.id } : c)),
    },
  };
  assert.throws(
    () => applyDiff(anotherArchived.db, diffDb(anotherArchived.db, diffBad), { isAdmin: true }),
    /Select an active incoterm/
  );

  // Assigning archived incoterm to a company with no prior incoterm is also rejected
  const noIncotermCompany = create(archivedDb, 'res.company', { name: 'Third company', currency_id: read(archivedDb, 'res.company', 1).currency_id });
  assert.throws(
    () => write(noIncotermCompany.db, 'res.company', noIncotermCompany.id, { incoterm_id: incoterm1 }),
    /Select an active incoterm/
  );
});
