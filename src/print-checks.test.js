import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const textOf = (node) => node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join('');

test('printing batch checks requires a posted linked payment and excludes reversed or unlinked checks', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js');
  const { create, read } = await import('./orm.js');
  const { models } = await import('./models/index.js');
  const { PrintDoc } = await import('./views/PrintDoc.jsx');
  await initStore();
  const action = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;
  const bill = (db) => {
    const draft = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 7, invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
    return { db: action(draft.db, 'account.move', draft.id, 'Confirm'), id: draft.id };
  };
  const first = bill(getDb());
  const second = bill(first.db);
  const batch = create(second.db, 'account.batch.payment', { batch_type: 'outbound', check_number_start: 7000, lines: [{ move_id: first.id, amount: 100 }, { move_id: second.id, amount: 100 }] });
  const posted = action(batch.db, 'account.batch.payment', batch.id, 'Validate');
  const [firstLine, secondLine] = read(posted, 'account.batch.payment', batch.id).lines;
  assert.equal(read(posted, 'account.payment', secondLine.payment_id).state, 'posted');
  await React.act(async () => commit(posted));
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.batch.payment', id: batch.id })));
    assert.match(textOf(host), /7000/);
    assert.match(textOf(host), /7001/);
    const reversed = action(posted, 'account.payment', firstLine.payment_id, 'Reverse');
    await React.act(async () => commit(reversed));
    assert.doesNotMatch(textOf(host), /7000/);
    assert.match(textOf(host), /7001/);
    // A unique same-invoice, same-amount payment still does not establish a missing payment link.
    const legacy = { ...reversed, records: { ...reversed.records, 'account.batch.payment': reversed.records['account.batch.payment'].map((b) => b.id === batch.id ? { ...b, lines: b.lines.map(({ payment_id, ...line }) => line.check_number === 7001 ? line : { ...line, payment_id }) } : b) } };
    await React.act(async () => commit(legacy));
    assert.doesNotMatch(textOf(host), /7000|7001/);
    assert.equal(read(legacy, 'account.payment', secondLine.payment_id).state, 'posted');
  } finally {
    await React.act(async () => root.unmount());
  }
});
