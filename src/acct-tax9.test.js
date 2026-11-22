import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { taxModels, taxSnapshot } from './models/taxes.js';
import { readFileSync } from 'node:fs';


test('tax advanced options expose invoice label, text description and legal notes', () => {
  const def = taxModels['account.tax'];
  assert.equal(def.fields.invoice_label.type, 'char');
  assert.equal(def.fields.description.type, 'text');
  assert.equal(def.fields.invoice_legal_notes.type, 'text');
  const advanced = def.form.tabs.find((tab) => tab.label === 'Advanced Options');
  const fields = advanced.groups.flatMap((group) => Array.isArray(group) ? group : group.fields);
  for (const field of ['invoice_label', 'description', 'invoice_legal_notes']) assert.ok(fields.includes(field));
  assert.ok(!def.form.groups({}).flat().includes('description'));
});

test('printed customer invoices show distinct tax legal notes and exclude descriptions', async () => {
  const { register } = await import('node:module');
  register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
  const { setupDom } = await import('./test-support/dom.js');
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { PrintDoc } = await import('./views/PrintDoc.jsx');
  await initStore();
  let db = seed();
  const first = create(db, 'account.tax', { name: 'Internal VAT', amount: 10, type_tax_use: 'sale', invoice_label: 'Invoice VAT', description: 'PRIVATE DESCRIPTION', invoice_legal_notes: 'Shared legal note' });
  const second = create(first.db, 'account.tax', { name: 'Other VAT', amount: 5, type_tax_use: 'sale', invoice_legal_notes: 'Shared legal note' });
  db = second.db;
  const lines = [first.id, second.id].map((id) => ({ product_id: 1, qty: 1, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', id)) }));
  lines.push({ display_type: 'line_section', name: 'Section', ...taxSnapshot({ id: 900, invoice_legal_notes: 'Display-only note' }) });
  const inv = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_line_ids: lines });
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const textOf = (node) => node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join('');
  try {
    await React.act(async () => commit(inv.db));
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.move', id: inv.id })));
    const text = textOf(host);
    assert.equal(text.split('Shared legal note').length - 1, 1);
    assert.ok(text.includes('Invoice VAT'));
    assert.ok(!text.includes('PRIVATE DESCRIPTION'));
    assert.ok(!text.includes('Display-only note'));
    const changed = write(inv.db, 'account.tax', first.id, { invoice_legal_notes: 'Changed note' });
    const cleared = write(changed, 'account.tax', second.id, { invoice_legal_notes: '' });
    await React.act(async () => commit(cleared));
    assert.ok(textOf(host).includes('Shared legal note'));
    assert.ok(!textOf(host).includes('Changed note'));
  } finally { await React.act(async () => root.unmount()); }
  assert.ok(readFileSync(new URL('./views/PrintDoc.jsx', import.meta.url), 'utf8').includes('invoice_legal_notes'));
});

test('group tax snapshots retain component legal notes after membership and notes change', () => {
  const child = { id: 91, amount: 5, invoice_legal_notes: 'Original component note' };
  const snapshot = taxSnapshot({ id: 92, amount_type: 'group', children_taxes: [child], invoice_legal_notes: 'Group note' });
  child.invoice_legal_notes = 'Changed component note';
  assert.equal(snapshot.tax_breakdown[0].invoice_legal_notes, 'Original component note');
  assert.equal(snapshot.invoice_legal_notes, 'Group note');
});
