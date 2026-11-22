import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, messagesOf } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import * as finance from './models/finance.js';
import { sendFollowUp } from '../server/mail.js';

function fixture() {
  const p = create(seed(), 'res.partner', { name: 'Follow-up customer', email: 'followup@example.test' });
  let db = p.db;
  for (const [date, amount] of [['2026-01-01', 100], ['2026-12-01', 50]]) {
    const inv = create(db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: p.id, invoice_date: '2025-12-01', invoice_date_due: date, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: amount, tax: 0 }] });
    db = postMove(inv.db, inv.id);
  }
  return { db, partner: p.id };
}

test('letter includes open overdue and future invoices with separate totals', () => {
  const { db, partner } = fixture();
  const data = finance.followUpLetter(db, partner, 1, '2026-03-01');
  assert.equal(data.invoices.length, 2);
  assert.deepEqual(data.invoices.map((x) => x.overdue), [true, false]);
  assert.equal(data.due[0].amount, 150);
  assert.equal(data.overdue[0].amount, 100);
  assert.ok(data.level.message);
});

test('follow-up email includes letter table and records the manual reminder only after delivery', async () => {
  const { db, partner } = fixture();
  let message;
  const result = await sendFollowUp({}, db, { name: 'Admin', isAdmin: true }, { partnerId: partner, companyId: 1, at: '2026-03-01' }, async (_cfg, mail) => { message = mail; });
  assert.match(message.text, /Total Due/);
  assert.match(message.html, /<table/);
  assert.equal(finance.partnerFollowUp(read(result.db, 'res.partner', partner), 1).followup_date, '2026-03-01');
  assert.ok(messagesOf(result.db, 'res.partner', partner).length);
  await assert.rejects(sendFollowUp({}, db, { name: 'Admin', isAdmin: true }, { partnerId: partner, companyId: 1, at: '2026-03-01' }, async () => { throw new Error('SMTP failure'); }), /SMTP failure/);
});
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { crmModels } from './models/crm.js';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const textOf = (node) => node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join('');

test('wizard defaults and printable page show the customer and invoice totals', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting', origin: 'http://localhost', pathname: '/', search: '' };
  globalThis.window.print = () => {};
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  const { db, partner } = fixture();
  await React.act(async () => commit(db));
  const { FollowUpWizard, FollowUpLetter } = await import('./views/FollowUpLetter.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(FollowUpWizard, { partnerId: partner, companyId: 1, onClose: () => {} })));
    const inputs = [];
    const visit = (node) => { if (node.tagName === 'INPUT') inputs.push(node); for (const c of node.childNodes ?? []) visit(c); };
    visit(host);
    assert.deepEqual(inputs.map((node) => props(node).checked), [true, false]);
    assert.ok(find(host, (node) => node.tagName === 'BUTTON' && textOf(node) === 'Send'));
    await React.act(async () => root.render(React.createElement(FollowUpLetter, { partnerId: partner, companyId: 1 })));
    const text = textOf(host);
    assert.match(text, /Follow-up customer/);
    assert.match(text, /Total Due/);
    assert.match(text, /Total Overdue/);
    assert.ok(find(host, (node) => node.tagName === 'TABLE'));
    assert.ok(crmModels['res.partner'].form.buttons.some((button) => button.label === 'Send Follow-up'));
    let opened;
    globalThis.window.open = () => { opened = { location: {}, close() {} }; return opened; };
    let closed = false;
    await React.act(async () => root.render(React.createElement(FollowUpWizard, { partnerId: partner, companyId: 1, onClose: () => { closed = true; } })));
    const checks = [];
    const collect = (node) => { if (node.tagName === 'INPUT') checks.push(node); for (const child of node.childNodes ?? []) collect(child); };
    collect(host);
    await React.act(async () => { props(checks[0]).onChange({ target: { checked: false } }); props(checks[1]).onChange({ target: { checked: true } }); });
    const send = find(host, (node) => node.tagName === 'BUTTON' && textOf(node) === 'Send');
    await React.act(async () => props(send).onClick());
    assert.equal(closed, true);
    assert.match(opened.location.href, /#\/print\/followup\//);
    const { getDb } = await import('./store.js');
    assert.equal(finance.partnerFollowUp(read(getDb(), 'res.partner', partner), 1).followup_channel, 'letter');
  } finally { await React.act(async () => root.unmount()); }
});
