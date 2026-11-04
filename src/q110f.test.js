import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { createCompany } from './models/company.js';
import { accountId } from './models/ledger.js';
import { payMove, postMove } from './models/accounting.js';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';

const run = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;

function invoice(db, company, amount) {
  const move = create(db, 'account.move', { company_id: company, move_type: 'out_invoice', partner_id: 3, invoice_date: '2025-01-01', invoice_line_ids: [{ qty: 1, price_unit: amount, tax: 0 }] });
  return { db: postMove(move.db, move.id), id: move.id };
}

test('journal-less inbound batch matches a statement in its payments company', () => {
  const base = seed();
  const branch = createCompany(base, { name: 'Branch', currency_id: base.settings.base_currency_id });
  let db = write(branch.db, 'res.company', branch.id, { outstanding_receipts_account_id: accountId(branch.db, '101402', branch.id) });
  const inv = invoice(db, branch.id, 100);
  const batch = create(inv.db, 'account.batch.payment', { batch_type: 'inbound', date: '2025-01-02', lines: [{ move_id: inv.id, amount: 100 }] });
  db = run(batch.db, 'account.batch.payment', batch.id, 'Validate');
  assert.equal(read(db, 'account.batch.payment', batch.id).journal_id, undefined);
  const statement = create(db, 'account.bank.statement.line', { company_id: branch.id, date: '2025-01-03', amount: 100, payment_ref: 'Branch receipt' });
  db = write(statement.db, 'account.bank.statement.line', statement.id, { batch_payment_id: batch.id });
  db = run(db, 'account.bank.statement.line', statement.id, 'Match Payment');
  assert.equal(read(db, 'account.bank.statement.line', statement.id).state, 'reconciled');
  assert.equal(read(db, 'account.move', read(db, 'account.bank.statement.line', statement.id).bank_move_id).company_id, branch.id);
  assert.throws(() => create(db, 'account.bank.statement.line', { company_id: 1, date: '2025-01-03', amount: 100, payment_ref: 'Wrong company', batch_payment_id: batch.id }), /another company/);
});

test('journal-less inbound batch rejects mixed-company invoices before posting', () => {
  const branch = createCompany(seed(), { name: 'Branch' });
  const first = invoice(branch.db, 1, 40);
  const second = invoice(first.db, branch.id, 60);
  const batch = create(second.db, 'account.batch.payment', { batch_type: 'inbound', date: '2025-01-02', lines: [{ move_id: first.id, amount: 40 }, { move_id: second.id, amount: 60 }] });
  assert.throws(() => run(batch.db, 'account.batch.payment', batch.id, 'Validate'), /same company/i);
  assert.equal(read(batch.db, 'account.batch.payment', batch.id).state, 'draft');
  assert.equal(read(batch.db, 'account.move', first.id).amount_residual, 40);
});

test('matching rejects an existing journal-less batch with payments from different companies', () => {
  const branch = createCompany(seed(), { name: 'Branch' });
  const first = invoice(branch.db, 1, 40);
  const second = invoice(first.db, branch.id, 60);
  const batches = [];
  let db = second.db;
  for (const [id, amount] of [[first.id, 40], [second.id, 60]]) {
    const batch = create(db, 'account.batch.payment', { batch_type: 'inbound', date: '2025-01-02', lines: [{ move_id: id, amount }] });
    db = run(batch.db, 'account.batch.payment', batch.id, 'Validate');
    batches.push(read(db, 'account.batch.payment', batch.id));
  }
  const statement = create(db, 'account.bank.statement.line', { company_id: 1, date: '2025-01-03', amount: 100, payment_ref: 'Mixed batch', batch_payment_id: batches[0].id });
  db = write(statement.db, 'account.batch.payment', batches[0].id, { lines: [...batches[0].lines, ...batches[1].lines] });
  assert.throws(() => write(db, 'account.bank.statement.line', statement.id, { batch_payment_id: batches[0].id }), /another company/);
  assert.throws(() => run(db, 'account.bank.statement.line', statement.id, 'Match Payment'), /another company/);
  assert.equal(read(db, 'account.bank.statement.line', statement.id).state, 'to_check');
});

test('matching foreign invoice payments clears each booked company-currency outstanding amount', () => {
  let db = seed();
  const outstanding = accountId(db, '101402');
  db = write(db, 'res.company', 1, { outstanding_receipts_account_id: outstanding });
  const fx = create(db, 'res.currency', { name: 'Test currency', rate_ids: [{ date: '2025-01-01', rate: 2 }, { date: '2025-01-03', rate: 4 }] });
  db = fx.db;
  const paymentIds = [];
  for (const [amount, date] of [[100, '2025-01-02'], [100, '2025-01-03']]) {
    const move = create(db, 'account.move', { company_id: 1, currency_id: fx.id, move_type: 'out_invoice', partner_id: 3, invoice_date: '2025-01-01', invoice_line_ids: [{ qty: 1, price_unit: amount, tax: 0 }] });
    db = postMove(move.db, move.id);
    db = payMove(db, move.id, amount, date);
    const paymentMove = read(db, 'account.move', move.id).payments.at(-1).move_id;
    const payment = search(db, 'account.payment').find((p) => p.move_id === paymentMove);
    assert.equal(payment.amount, 100);
    paymentIds.push(payment.id);
  }
  const statement = create(db, 'account.bank.statement.line', { company_id: 1, date: '2025-01-04', amount: 75, payment_ref: 'Foreign receipts', payment_ids: paymentIds });
  const wrong = create(statement.db, 'account.bank.statement.line', { company_id: 1, date: '2025-01-04', amount: 200, payment_ref: 'Wrong value', payment_ids: paymentIds });
  assert.throws(() => run(wrong.db, 'account.bank.statement.line', wrong.id, 'Match Payment'), /total the bank transaction amount/);
  db = run(statement.db, 'account.bank.statement.line', statement.id, 'Match Payment');
  const matched = read(db, 'account.bank.statement.line', statement.id);
  assert.equal(matched.state, 'reconciled');
  const entry = read(db, 'account.move', matched.bank_move_id);
  assert.deepEqual(entry.line_ids.filter((line) => line.account_id === outstanding).map((line) => line.credit).sort((a, b) => a - b), [25, 50]);
  assert.equal(entry.line_ids.reduce((sum, line) => sum + line.debit, 0), 75);
});

for (const selection of ['single-item list', 'multiple-item list', 'batch']) {
  test(`matching a ${selection} replaces a stale single payment selection`, () => {
    let db = seed();
    db = write(db, 'res.company', 1, { outstanding_receipts_account_id: accountId(db, '101402') });
    const oldInvoice = invoice(db, 1, 40);
    db = payMove(oldInvoice.db, oldInvoice.id, 40, '2025-01-02');
    const oldMove = read(db, 'account.move', oldInvoice.id).payments.at(-1).move_id;
    const oldPayment = search(db, 'account.payment').find((p) => p.move_id === oldMove);
    const batchLines = [];
    for (const amount of (selection === 'single-item list' ? [60] : [60, 40])) {
      const next = invoice(db, 1, amount);
      db = next.db;
      batchLines.push({ move_id: next.id, amount });
    }
    const batch = create(db, 'account.batch.payment', { batch_type: 'inbound', date: '2025-01-02', lines: batchLines });
    db = run(batch.db, 'account.batch.payment', batch.id, 'Validate');
    const selected = read(db, 'account.batch.payment', batch.id).lines.map((line) => line.payment_id);
    const statement = create(db, 'account.bank.statement.line', { date: '2025-01-03', amount: batchLines.reduce((sum, line) => sum + line.amount, 0), payment_ref: 'Receipt', payment_id: oldPayment.id });
    db = write(statement.db, 'account.bank.statement.line', statement.id, selection === 'batch' ? { batch_payment_id: batch.id } : { payment_ids: selected });
    db = run(db, 'account.bank.statement.line', statement.id, 'Match Payment');
    const matched = read(db, 'account.bank.statement.line', statement.id);
    assert.equal(matched.payment_id, selected.length === 1 ? selected[0] : null);
    assert.deepEqual(matched.payment_ids, selected);
    assert.throws(() => run(db, 'account.payment', selected[0], 'Reverse'), /reconciled bank transaction/);
    db = run(db, 'account.payment', oldPayment.id, 'Reverse');
    assert.equal(read(db, 'account.payment', oldPayment.id).state, 'reversed');
  });
}

test('unbooked payment matching validates against the full statement amount', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { outstanding_receipts_account_id: accountId(db, '101402') });
  const paymentIds = [];
  for (const amount of [60, 100]) {
    const next = invoice(db, 1, amount);
    db = payMove(next.db, next.id, amount, '2025-01-02');
    const moveId = read(db, 'account.move', next.id).payments.at(-1).move_id;
    paymentIds.push(search(db, 'account.payment').find((payment) => payment.move_id === moveId).id);
  }
  const partial = create(db, 'account.bank.statement.line', { date: '2025-01-03', amount: 100, open_amount: 60, payment_ref: 'Partial payment', payment_id: paymentIds[0] });
  const before = JSON.stringify(partial.db);
  assert.throws(() => run(partial.db, 'account.bank.statement.line', partial.id, 'Match Payment'), /selected payments must total the bank transaction amount/);
  assert.equal(JSON.stringify(partial.db), before);
  const full = create(partial.db, 'account.bank.statement.line', { date: '2025-01-03', amount: 100, open_amount: 60, payment_ref: 'Full payment', payment_id: paymentIds[1] });
  db = run(full.db, 'account.bank.statement.line', full.id, 'Match Payment');
  const matched = read(db, 'account.bank.statement.line', full.id);
  assert.equal(matched.state, 'reconciled');
  assert.equal(matched.open_amount, 0);
  assert.equal(read(db, 'account.move', matched.bank_move_id).line_ids.reduce((sum, line) => sum + line.debit, 0), 100);
});

test('customer statement selects an allowed company independently of the active company', async () => {
  register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js');
  await initStore();
  const branch = createCompany(getDb(), { name: 'Allowed branch', currency_id: getDb().records['res.company'][0].currency_id });
  const other = createCompany(branch.db, { name: 'Restricted branch' });
  const first = invoice(other.db, 1, 120);
  const second = invoice(first.db, branch.id, 240);
  const db = { ...second.db, settings: { ...second.db.settings, current_company_id: 1, allowed_company_ids: [1, branch.id] } };
  await React.act(async () => commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
  const text = (node) => node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(text).join('');
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'customerStatement' } })));
    const company = find(host, (node) => node.tagName === 'SELECT' && props(node)?.['aria-label'] === 'Company');
    assert.ok(company, 'company selector is available');
    assert.equal(String(props(company).value), '1');
    assert.doesNotMatch(text(company), /Restricted branch|All Companies/);
    const period = find(host, (node) => node.tagName === 'SELECT' && props(node)?.value === 'year');
    await React.act(async () => props(period).onChange({ target: { value: 'all' } }));
    const customer = find(host, (node) => node.tagName === 'SELECT' && props(node)?.['aria-label'] === 'Customer');
    await React.act(async () => props(customer).onChange({ target: { value: '3' } }));
    assert.match(text(host), /120\.00/);
    assert.doesNotMatch(text(host), /240\.00/);
    await React.act(async () => props(company).onChange({ target: { value: String(branch.id) } }));
    assert.match(text(host), /240\.00/);
    assert.doesNotMatch(text(host), /120\.00/);
    assert.equal(getDb().settings.current_company_id, 1);
  } finally { await React.act(async () => root.unmount()); }
});

for (const selection of ['payment list', 'batch']) {
  test(`matching rejects a duplicate payment in a ${selection} before booking`, () => {
    let db = seed();
    db = write(db, 'res.company', 1, { outstanding_receipts_account_id: accountId(db, '101402') });
    const move = invoice(db, 1, 50);
    const batch = create(move.db, 'account.batch.payment', { batch_type: 'inbound', date: '2025-01-02', lines: [{ move_id: move.id, amount: 50 }] });
    db = run(batch.db, 'account.batch.payment', batch.id, 'Validate');
    const posted = read(db, 'account.batch.payment', batch.id);
    const paymentId = posted.lines[0].payment_id;
    if (selection === 'batch') db = write(db, 'account.batch.payment', batch.id, { lines: [posted.lines[0], { ...posted.lines[0] }] });
    const statement = create(db, 'account.bank.statement.line', { date: '2025-01-03', amount: 100, payment_ref: 'Duplicate receipt', ...(selection === 'batch' ? { batch_payment_id: batch.id } : { payment_ids: [paymentId, paymentId] }) });
    const before = JSON.stringify(statement.db);
    assert.throws(() => run(statement.db, 'account.bank.statement.line', statement.id, 'Match Payment'), /payment can only be selected once/i);
    assert.equal(JSON.stringify(statement.db), before);
    assert.equal(read(statement.db, 'account.bank.statement.line', statement.id).state, 'to_check');
    assert.equal(read(statement.db, 'account.payment', paymentId).state, 'posted');
  });
}
