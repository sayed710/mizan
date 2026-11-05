import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { payMove, postMove } from './models/accounting.js';
import { taxSnapshot } from './models/taxes.js';
import { migrate } from './migrations.js';
import { followUps, followUpCompanies, followUpText } from './models/finance.js';
import { postBatch, checkRegisterRows } from './models/payments.js';
import { dueDate } from './models/terms.js';
import { accountId } from './models/ledger.js';
import { models } from './models/index.js';
import { register } from 'node:module';
import { setupDom } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

test('inbound batch settles an eligible early payment discount', () => {
  let db = seed();
  const term = search(db, 'account.payment.term').find((item) => item.early_discount);
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 3, company_id: 1, invoice_date: '2026-01-01', invoice_payment_term_id: term.id, invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(invoice.db, invoice.id);
  const journal = search(db, 'account.journal').find((j) => j.default_for_payments && j.type === 'bank');
  const batch = create(db, 'account.batch.payment', { batch_type: 'inbound', company_id: 1, journal_id: journal.id, date: '2026-01-02', lines: [{ move_id: invoice.id, amount: 98 }] });
  db = postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id));
  assert.equal(read(db, 'account.move', invoice.id).amount_residual, 0);
  assert.ok(read(db, 'account.move', invoice.id).payments.some((payment) => payment.discount));
});

test('outbound check batch settles an eligible early payment discount and keeps its check number', () => {
  let db = seed();
  const term = search(db, 'account.payment.term').find((item) => item.early_discount);
  const bill = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 3, company_id: 1, invoice_date: '2026-01-01', invoice_payment_term_id: term.id, invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(bill.db, bill.id);
  const journal = search(db, 'account.journal').find((j) => j.default_for_payments && j.type === 'bank');
  const batch = create(db, 'account.batch.payment', { batch_type: 'outbound', company_id: 1, journal_id: journal.id, date: '2026-01-02', check_number_start: 500, lines: [{ move_id: bill.id, amount: 98 }] });
  db = postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id));
  assert.equal(read(db, 'account.move', bill.id).amount_residual, 0);
  assert.ok(read(db, 'account.move', bill.id).payments.some((payment) => payment.discount));
  assert.equal(read(db, 'account.batch.payment', batch.id).lines[0].check_number, 500);
});

test('batch groups existing posted payments and matches one bank transaction without duplicates', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { outstanding_receipts_account_id: accountId(db, '101402', 1) });
  const journal = search(db, 'account.journal').find((j) => j.default_for_payments && j.type === 'bank');
  const run = (state, model, id, label) => models[model].form.buttons.find((button) => button.label === label).run(state, read(state, model, id)).db;
  const ids = [];
  for (const amount of [40, 60]) {
    const payment = create(db, 'account.payment', { partner_id: 3, company_id: 1, journal_id: journal.id, payment_type: 'inbound', partner_type: 'customer', amount, date: '2026-01-02' });
    db = run(payment.db, 'account.payment', payment.id, 'Confirm');
    ids.push(payment.id);
  }
  const batch = create(db, 'account.batch.payment', { company_id: 1, journal_id: journal.id, batch_type: 'inbound', date: '2026-01-03', lines: ids.map((id) => ({ payment_id: id, amount: read(db, 'account.payment', id).amount })) });
  const count = search(batch.db, 'account.payment').length;
  db = postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id));
  assert.equal(search(db, 'account.payment').length, count);
  const duplicate = create(db, 'account.batch.payment', { company_id: 1, journal_id: journal.id, batch_type: 'inbound', date: '2026-01-03', lines: [{ payment_id: ids[0], amount: 40 }] });
  assert.throws(() => postBatch(duplicate.db, read(duplicate.db, 'account.batch.payment', duplicate.id)), /already in a batch/);
  const line = create(db, 'account.bank.statement.line', { company_id: 1, journal_id: journal.id, date: '2026-01-03', payment_ref: 'combined', amount: 100, batch_payment_id: batch.id });
  db = run(line.db, 'account.bank.statement.line', line.id, 'Match Payment');
  assert.equal(read(db, 'account.bank.statement.line', line.id).state, 'reconciled');
  assert.equal(search(db, 'account.payment').length, count);
});

test('follow-up totals and reminder text keep currencies separate', () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Mixed currency customer' });
  db = partner.db;
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  db = write(db, 'res.currency', eur.id, { rate_ids: [...(eur.rate_ids ?? []), { date: '2025-01-01', rate: 1, company_id: 1 }] });
  for (const currency_id of [null, eur.id]) {
    const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: partner.id, company_id: 1, currency_id, invoice_date: '2026-01-01', invoice_date_due: '2026-01-02', invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax: 0 }] });
    db = postMove(invoice.db, invoice.id);
  }
  const group = followUpCompanies(followUps(db, '2027-01-01').find((f) => f.partner_id === partner.id))[0];
  assert.equal(group.total, null);
  assert.deepEqual(new Set(group.totals.map((t) => t.currency.name)), new Set(['USD', 'EUR']));
  assert.match(followUpText(db, group), /Total:.*USD.*EUR|Total:.*EUR.*USD/);
});

test('cash basis releases use invoice identity and migration links them only through the recording payment', () => {
  let db = seed();
  const tax = search(db, 'account.tax').find((t) => t.name === 'VAT 14% (Cash Basis)' && t.type_tax_use === 'sale');
  const invoice = () => {
    const made = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-03-01', invoice_line_ids: [{ qty: 1, price_unit: 1000, ...taxSnapshot(tax) }] });
    db = postMove(made.db, made.id);
    return made.id;
  };
  const first = invoice();
  const second = invoice();
  const name = read(db, 'account.move', first).name;
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => m.id === second ? { ...m, name } : m) } };
  db = payMove(db, first, 570, '2026-03-05');
  const release = read(db, 'account.move', first).payments.at(-1).cash_basis_move_id;
  assert.equal(read(db, 'account.move', release).cash_basis_origin_move_id, first);
  db = payMove(db, second, 1140, '2026-03-06');
  const secondRelease = read(db, 'account.move', second).payments.at(-1).cash_basis_move_id;
  const taxLine = read(db, 'account.move', secondRelease).line_ids.find((l) => l.tax_id === tax.id);
  assert.equal(taxLine.credit, 140);
  // Legacy data: both releases lost their origin; only the first is still recorded on its invoice payment.
  const legacy = { ...db, schema_version: 24, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => {
    if (m.id === release || m.id === secondRelease) return { ...m, cash_basis_origin_move_id: null };
    if (m.id === second) return { ...m, payments: m.payments.map((p) => ({ ...p, cash_basis_move_id: null })) };
    return m;
  }) } };
  const migrated = migrate(legacy);
  assert.equal(read(migrated, 'account.move', release).cash_basis_origin_move_id, first);
  assert.equal(read(migrated, 'account.move', secondRelease).cash_basis_origin_move_id, null);
  assert.ok(migrated.messages.some((m) => m.model === 'account.move' && m.res_id === secondRelease && m.body === 'Cash-basis origin invoice could not be determined; review this entry.'));
  assert.ok(!migrated.messages.some((m) => m.model === 'account.move' && m.res_id === release && m.body === 'Cash-basis origin invoice could not be determined; review this entry.'));
  assert.equal(migrate(migrated), migrated);
});

test('reprint check opens only the selected replacement while batch prints both', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js');
  const { PrintDoc } = await import('./views/PrintDoc.jsx');
  await initStore();
  const makeBill = (db) => {
    const draft = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 7, invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
    return { db: postMove(draft.db, draft.id), id: draft.id };
  };
  const first = makeBill(getDb());
  const second = makeBill(first.db);
  const batch = create(second.db, 'account.batch.payment', { batch_type: 'outbound', check_number_start: 7000, lines: [{ move_id: first.id, amount: 100 }, { move_id: second.id, amount: 100 }] });
  const posted = postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id));
  const lines = read(posted, 'account.batch.payment', batch.id).lines;
  const action = models['account.payment'].form.buttons.find((b) => b.label === 'Reprint Check');
  const result = action.run(posted, read(posted, 'account.payment', lines[0].payment_id));
  assert.equal(result.go, `#/print/account.payment/${lines[0].payment_id}`);
  await React.act(async () => commit(result.db));
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const text = (node) => node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(text).join('');
  try {
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.payment', id: lines[0].payment_id })));
    assert.match(text(host), /7002/);
    assert.doesNotMatch(text(host), /7001/);
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.batch.payment', id: batch.id })));
    assert.match(text(host), /7002/);
    assert.match(text(host), /7001/);
  } finally { await React.act(async () => root.unmount()); }
});

test('payment term due date is the latest maturity regardless of line order', () => {
  assert.equal(dueDate({ line_ids: [{ nb_days: 60 }, { nb_days: 30 }] }, '2025-01-01'), '2025-03-02');
});

test('reversed individual checks remain in the register with their void history', () => {
  const db = seed();
  const payment = { id: 9999, state: 'reversed', payment_type: 'outbound', check_number: 42, amount: 20, date: '2025-01-01', voided_check_numbers: [{ check_number: 41 }] };
  const rows = checkRegisterRows(db, [], [payment]);
  assert.deepEqual(rows.map((r) => [r.checkNumber, r.state]), [[41, 'Voided'], [42, 'Reversed']]);
});

test('batch rejects invoice currency different from fixed journal currency before posting', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const made = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 3, company_id: 1, invoice_date: '2026-01-01', invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(made.db, made.id);
  const j = create(db, 'account.journal', { name: 'Foreign bank', code: 'FBK', type: 'bank', company_id: 1, currency_id: eur.id, default_account_id: accountId(db, '101501', 1) });
  const b = create(j.db, 'account.batch.payment', { batch_type: 'inbound', company_id: 1, journal_id: j.id, date: '2026-01-02', lines: [{ move_id: made.id, amount: 100 }] });
  assert.throws(() => postBatch(b.db, read(b.db, 'account.batch.payment', b.id)), /currency must match/i);
  assert.equal(read(b.db, 'account.batch.payment', b.id).state, 'draft');
});
