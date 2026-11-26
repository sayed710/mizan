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
    assert.deepEqual(inputs.map((node) => props(node).checked), [true, false, false, true]);
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

test('regression: excluded invoices and credit notes derive consistent letter and email balances', () => {
  const p = create(seed(), 'res.partner', { name: 'Bal Customer', email: 'bal@example.test' });
  let db = p.db;
  // Overdue invoice (100)
  const inv1 = create(db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: p.id, invoice_date: '2025-12-01', invoice_date_due: '2026-01-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(inv1.db, inv1.id);
  // Future invoice (50)
  const inv2 = create(db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: p.id, invoice_date: '2025-12-01', invoice_date_due: '2026-12-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 50, tax: 0 }] });
  db = postMove(inv2.db, inv2.id);
  // Excluded invoice (40)
  const inv3 = create(db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: p.id, invoice_date: '2025-12-01', invoice_date_due: '2026-01-01', exclude_from_followup: true, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 40, tax: 0 }] });
  db = postMove(inv3.db, inv3.id);
  // Credit note (-30)
  const cn = create(db, 'account.move', { move_type: 'out_refund', company_id: 1, partner_id: p.id, invoice_date: '2026-01-15', invoice_date_due: '2026-01-15', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 30, tax: 0 }] });
  db = postMove(cn.db, cn.id);

  const data = finance.followUpLetter(db, p.id, 1, '2026-03-01');
  assert.ok(!data.invoices.some((m) => m.id === inv3.id), 'Excluded invoice must not appear in letter');
  assert.ok(data.invoices.some((m) => m.id === cn.id), 'Credit note must appear in letter');
  assert.equal(data.overdue[0].amount, 70, 'Overdue total must net against open credit (100 - 30 = 70)');
  assert.equal(data.due[0].amount, 120, 'Total due must exclude excluded invoice and net credit (100 + 50 - 30 = 120)');
});

test('regression: blocked installments are not counted as overdue in letter', () => {
  const p = create(seed(), 'res.partner', { name: 'Blocked Customer', email: 'blocked@example.test' });
  let db = p.db;
  // Create invoice with 2 installments: 60 unblocked (due 2026-01-01), 40 blocked (due 2026-01-01)
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: p.id,
    invoice_date: '2025-12-01',
    invoice_date_due: '2026-01-01',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  // Mark one installment blocked in receivable lines
  const move = read(db, 'account.move', inv.id);
  const recLine = move.line_ids.find((l) => read(db, 'account.account', l.account_id)?.account_type === 'asset_receivable');
  const splitLines = [
    { ...recLine, id: recLine.id, debit: 60, amount_residual: 60, blocked: false, date_maturity: '2026-01-01' },
    { ...recLine, id: 99999, debit: 40, amount_residual: 40, blocked: true, date_maturity: '2026-01-01' },
  ];
  db = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].map((m) => m.id === inv.id ? { ...m, line_ids: [...m.line_ids.filter((l) => l.id !== recLine.id), ...splitLines] } : m),
    },
  };

  const data = finance.followUpLetter(db, p.id, 1, '2026-03-01');
  assert.equal(data.overdue[0].amount, 60, 'Blocked installment of 40 must not be included in overdue total');
  const invRow = data.invoices.find((m) => m.id === inv.id);
  assert.equal(invRow.overdueAmount, 60);
  assert.equal(invRow.amount_residual, 100);
  const details = finance.partnerReceivableLines(db, p.id, 1, '2026-03-01');
  assert.equal(details.total_due, data.due[0].amount);
  assert.equal(details.total_overdue, data.overdue[0].amount);
  assert.equal(details.lines.filter((line) => line.is_overdue).reduce((sum, line) => sum + line.residual_amount, 0), invRow.overdueAmount);
  assert.equal(details.lines.filter((line) => !line.is_overdue).reduce((sum, line) => sum + line.residual_amount, 0), 40);
});

test('regression: customer with future next-action date can send and log manual follow-up', async () => {
  const { db: baseDb, partner } = fixture();
  // Set future next action date
  let db = finance.applyFollowUpReminder ? baseDb : baseDb;
  const p = read(db, 'res.partner', partner);
  const updatedP = finance.updatePartnerFollowUp(p, 1, { followup_next_action_date: '2026-12-31' });
  db = { ...db, records: { ...db.records, 'res.partner': db.records['res.partner'].map((x) => x.id === partner ? updatedP : x) } };

  // followUpLetter succeeds
  const letter = finance.followUpLetter(db, partner, 1, '2026-03-01');
  assert.ok(letter);

  // logManualFollowUp should succeed and not throw 'This customer has no overdue invoices'
  assert.doesNotThrow(() => {
    finance.logManualFollowUp(db, partner, '2026-03-01', { companyId: 1, channel: 'letter' });
  });

  // sendFollowUp should also succeed
  await assert.doesNotReject(sendFollowUp({}, db, { name: 'Admin', isAdmin: true }, { partnerId: partner, companyId: 1, at: '2026-03-01' }, async () => {}));
});

test('regression: partner form button has accounting app and hides for crm-only users', () => {
  const btn = crmModels['res.partner'].form.buttons.find((b) => b.label === 'Send Follow-up');
  assert.ok(btn, 'Send Follow-up button exists');
  assert.equal(btn.app, 'accounting', 'Button must declare accounting app requirement');
  const { db } = fixture();
  const crmUser = { apps: ['crm'] };
  assert.equal(btn.when?.({}, db, crmUser) ?? btn.visible?.({}, db, crmUser), false, 'Button should not be available/visible to crm-only user');
});

test('regression: wizard validates follow-up level before print-only commit and leaves reminder unchanged', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting', origin: 'http://localhost', pathname: '/', search: '' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  const { db: seededDb, partner } = fixture();
  // Clear all follow-up levels so no level applies
  const db = { ...seededDb, records: { ...seededDb.records, 'account.followup.level': [] } };
  await React.act(async () => commit(db));

  const { FollowUpWizard } = await import('./views/FollowUpLetter.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    let closed = false;
    await React.act(async () => root.render(React.createElement(FollowUpWizard, { partnerId: partner, companyId: 1, onClose: () => { closed = true; } })));
    const checks = [];
    const collect = (node) => { if (node.tagName === 'INPUT') checks.push(node); for (const child of node.childNodes ?? []) collect(child); };
    collect(host);
    // Uncheck email, check print
    await React.act(async () => { props(checks[0]).onChange({ target: { checked: false } }); props(checks[1]).onChange({ target: { checked: true } }); });
    const send = find(host, (node) => node.tagName === 'BUTTON' && textOf(node) === 'Send');
    await React.act(async () => props(send).onClick());

    assert.equal(closed, false, 'Wizard must stay open on error');
    assert.match(textOf(host), /No follow-up level applies to this customer/);
    const { getDb } = await import('./store.js');
    assert.equal(finance.partnerFollowUp(read(getDb(), 'res.partner', partner), 1), null, 'Reminder must remain unlogged');
  } finally { await React.act(async () => root.unmount()); }
});

test('regression: concurrent edit during sendFollowUp preserves partner progression, next-action date, and activity', async () => {
  const { db, partner } = fixture();
  const { recordSent } = await import('../server/mail.js');
  const { write: ormWrite } = await import('./orm.js');

  let currentDb = db;
  // During deliver, partner phone is edited concurrently
  const deliverWithConcurrentEdit = async () => {
    currentDb = ormWrite(currentDb, 'res.partner', partner, { phone: '123-456-7890' });
  };

  const result = await sendFollowUp({}, db, { name: 'Admin', isAdmin: true }, { partnerId: partner, companyId: 1, at: '2026-03-01' }, deliverWithConcurrentEdit);
  assert.ok(result.reconcile, 'sendFollowUp must return a reconcile function for conflict resolution');

  // recordSent with the concurrent edit on currentDb
  const stored = recordSent(currentDb, db, result.db, { author: 'Admin', isAdmin: true }, result.reconcile);
  const updatedPartner = read(stored.db, 'res.partner', partner);

  assert.equal(updatedPartner.phone, '123-456-7890', 'Concurrent phone edit must be preserved');
  const line = finance.partnerFollowUp(updatedPartner, 1);
  assert.ok(line, 'Partner follow-up line must be recorded');
  assert.equal(line.followup_date, '2026-03-01', 'Follow-up date must be preserved');
  assert.equal(line.followup_channel, 'email');
});


test('upcoming reminder with credit has no overdue totals', () => {
  const p = create(seed(), 'res.partner', { name: 'Upcoming customer' });
  const level = create(p.db, 'account.followup.level', { display_delay: 5, reminder_timing: 'before' });
  const inv = create(level.db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: p.id, invoice_date: '2026-01-01', invoice_date_due: '2026-02-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
  let db = postMove(inv.db, inv.id);
  const credit = create(db, 'account.move', { move_type: 'out_refund', company_id: 1, partner_id: p.id, invoice_date: '2026-01-15', invoice_date_due: '2026-01-15', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 30, tax: 0 }] });
  db = postMove(credit.db, credit.id);
  const letter = finance.followUpLetter(db, p.id, 1, '2026-01-27');
  const details = finance.partnerReceivableLines(db, p.id, 1, '2026-01-27');
  assert.equal(letter.reminder.upcoming, true);
  assert.deepEqual(letter.overdue, []);
  assert.deepEqual(details.overdue, []);
  assert.equal(details.total_overdue, 0);
  assert.equal(details.total_due, 70);
  assert.equal(letter.due[0].amount, details.total_due);
});

test('future-dated invoices do not appear in partner balances or letters', () => {
  const { db: initial, partner } = fixture();
  const future = create(initial, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: partner, invoice_date: '2026-04-01', invoice_date_due: '2026-04-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 75, tax: 0 }] });
  const db = postMove(future.db, future.id);
  const letter = finance.followUpLetter(db, partner, 1, '2026-03-01');
  const details = finance.partnerReceivableLines(db, partner, 1, '2026-03-01');
  assert.ok(!letter.invoices.some((row) => row.id === future.id));
  assert.ok(!details.lines.some((row) => row.move_id === future.id));
  assert.equal(details.total_due, 150);
  assert.equal(details.total_due, letter.due[0].amount);
  assert.equal(details.total_overdue, letter.overdue[0].amount);
});

test('manual confirmation ignores a second click while saving', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  await initStore();
  const { db, partner } = fixture();
  await React.act(async () => commit(db));
  const { FollowUpBatchResultModal } = await import('./views/FollowUpLetter.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const report = { summary: { processed: 1, skipped: 0, failed: 0 }, results: [{ partnerId: partner, companyId: 1, partnerName: 'Customer', status: 'processed', actions: ['letter'], pendingManual: ['letter'] }] };
  try {
    await React.act(async () => root.render(React.createElement(FollowUpBatchResultModal, { report, onClose: () => {} })));
    const button = find(host, node => node.tagName === 'BUTTON' && textOf(node) === 'Mark letter as printed');
    const before = getDb().messages.length;
    const expected = finance.logManualFollowUp(getDb(), partner, (await import('./models/common.js')).today(), { companyId: 1, channel: 'letter', ignoreNextActionDate: true }).messages.length - before;
    await React.act(async () => { const click = props(button).onClick; const first = click(); const second = click(); await Promise.all([first, second]); });
    assert.equal(getDb().messages.length - before, expected);
  } finally { await React.act(async () => root.unmount()); }
});
