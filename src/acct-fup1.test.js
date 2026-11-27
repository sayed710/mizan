import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { crmModels } from './models/crm.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
import { financeModels, runFollowUps, followUps, logManualFollowUp, partnerFollowUp } from './models/finance.js';
import { create, messagesOf, read, write } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { applyDiff, diffDb } from './sync.js';
import { changeFormValue } from './views/formDefaults.js';
import { saveFormRecord } from './views/formSave.js';
import { migrate } from './migrations.js';

function fixture(due = '2026-01-01') {
  const partner = create(seed(), 'res.partner', { name: 'Follow-up customer', email: 'followup@example.test' });
  const invoice = create(partner.db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: partner.id, invoice_date: '2025-12-01', invoice_date_due: due, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
  return { db: postMove(invoice.db, invoice.id), partner: partner.id, invoice: invoice.id };
}

test('partner Accounting tab exposes the Odoo 20 controls', () => {
  const partner = crmModels['res.partner'];
  assert.equal(partner.defaults().followup_reminder_type, 'automatic');
  assert.equal(financeModels['account.followup.level'].fields.automatic, undefined);
  const accounting = partner.form.tabs.find((tab) => tab.label === 'Accounting');
  for (const name of ['followup_reminder_type', 'followup_next_action_date', 'followup_responsible_id', 'last_reminder', 'followup_line_id']) assert.ok(accounting.fields.includes(name));
  assert.equal(typeof partner.fields.followup_next_action_date.compute, 'function');
  assert.equal(partner.fields.followup_next_action_date.editable, true);
  assert.equal(partner.fields.last_reminder.readonly, true);
  assert.equal(partner.fields.followup_line_id.readonly, true);
});

test('manual mode leaves customer on report and pauses sending and progress reset', () => {
  const f = fixture();
  let db = write(f.db, 'res.partner', f.partner, { followup_reminder_type: 'manual', followup_lines: [{ company_id: 1, followup_level_delay: 30, followup_oldest_date: '2025-01-01', followup_level: 2 }] });
  assert.ok(followUps(db, '2026-01-20').some((row) => row.partner_id === f.partner));
  const sent = [];
  db = runFollowUps(db, '2026-01-20', (message) => sent.push(message));
  assert.equal(sent.some((message) => message.to === 'followup@example.test'), false);
  assert.equal(partnerFollowUp(read(db, 'res.partner', f.partner), 1).followup_level_delay, 30);
});

test('next reminder postpones automatic action', () => {
  const f = fixture();
  const db = write(f.db, 'res.partner', f.partner, { followup_next_action_date: '2026-02-01' });
  const sent = [];
  runFollowUps(db, '2026-01-20', (message) => sent.push(message));
  assert.equal(sent.some((message) => message.to === 'followup@example.test'), false);
});

test('before level fires at the configured days before due', () => {
  const f = fixture('2026-02-01');
  const level = create(f.db, 'account.followup.level', { display_delay: 5, reminder_timing: 'before', send_email: true });
  assert.equal(read(level.db, 'account.followup.level', level.id).delay, -5);
  const early = [];
  runFollowUps(level.db, '2026-01-26', (message) => early.push(message));
  assert.equal(early.some((message) => message.to === 'followup@example.test'), false);
  const due = [];
  runFollowUps(level.db, '2026-01-27', (message) => due.push(message));
  assert.equal(due.some((message) => message.to === 'followup@example.test'), true);
});

test('sent reminders appear on customer and covered invoice chatter', () => {
  const f = fixture();
  const db = logManualFollowUp(f.db, f.partner, '2026-01-20', { channel: 'phone' });
  assert.ok(messagesOf(db, 'res.partner', f.partner).some((message) => /reminder/i.test(message.body)));
  assert.ok(messagesOf(db, 'account.move', f.invoice).some((message) => /reminder/i.test(message.body)));
});

test('company guard rejects forged foreign follow-up controls through diff', () => {
  const f = fixture();
  const forged = { ...f.db, records: { ...f.db.records, 'res.partner': f.db.records['res.partner'].map((p) => p.id === f.partner ? { ...p, followup_lines: [{ company_id: 2, followup_status: 'no_action_needed', followup_next_action_date: '2026-02-01' }] } : p) } };
  assert.throws(() => applyDiff(f.db, diffDb(f.db, forged), { companies: new Set([1]), isAdmin: false }), /No access to this company/);
});
test('automatic delivery logs only successful reminders on covered invoice chatter', () => {
  const f = fixture();
  const sent = runFollowUps(f.db, '2026-01-20', () => ({ status: 'sent' }));
  assert.ok(messagesOf(sent, 'account.move', f.invoice).some((message) => /reminder/i.test(message.body)));
  const failed = runFollowUps(f.db, '2026-01-20', () => ({ status: 'outbox_only', reason: 'No transport' }));
  assert.equal(messagesOf(failed, 'account.move', f.invoice).some((message) => /reminder/i.test(message.body)), false);
  const contact = read(sent, 'res.partner', f.partner);
  assert.equal(contact.last_reminder, '2026-01-20');
  assert.equal(contact.followup_line_id, partnerFollowUp(contact, 1).followup_last_level);
});

test('a manually adjusted next reminder can override a later scheduled date', () => {
  const f = fixture();
  const db = write(f.db, 'res.partner', f.partner, { followup_next_action_date: '2026-01-20', followup_lines: [{ company_id: 1, followup_next_action_date: '2026-02-01' }] });
  const sent = [];
  runFollowUps(db, '2026-01-20', (message) => sent.push(message));
  assert.equal(sent.some((message) => message.to === 'followup@example.test'), true);
});
test('partner controls round-trip through server and calculated reminder fields cannot be forged', () => {
  const f = fixture();
  const staged = write(f.db, 'res.partner', f.partner, { followup_reminder_type: 'manual', followup_next_action_date: '2026-03-01', last_reminder: '1999-01-01', followup_line_id: 999 });
  const saved = applyDiff(f.db, diffDb(f.db, staged), { isAdmin: true });
  const partner = read(saved, 'res.partner', f.partner);
  assert.equal(partner.followup_reminder_type, 'manual');
  assert.equal(partner.followup_next_action_date, '2026-03-01');
  assert.equal(partner.last_reminder, null);
  assert.equal(partner.followup_line_id, null);
});
test('only covered overdue invoices receive chatter entries', () => {
  const f = fixture();
  const second = create(f.db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: f.partner, invoice_date: '2025-12-01', invoice_date_due: '2026-01-02', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 50, tax: 0 }] });
  const db = postMove(second.db, second.id);
  const sent = runFollowUps(db, '2026-01-20', () => ({ status: 'sent' }));
  for (const id of [f.invoice, second.id]) assert.ok(messagesOf(sent, 'account.move', id).some((m) => /reminder/i.test(m.body)));
});

test("editing the date on the form for one company does not change another company's line", () => {
  const f = fixture();
  let db = write(f.db, 'res.partner', f.partner, {
    followup_lines: [
      { company_id: 1, followup_next_action_date: '2026-02-01' },
      { company_id: 2, followup_next_action_date: '2026-03-01' },
    ],
  });
  let partner = read(db, 'res.partner', f.partner);
  assert.equal(partnerFollowUp(partner, 1)?.followup_next_action_date, '2026-02-01');
  assert.equal(partnerFollowUp(partner, 2)?.followup_next_action_date, '2026-03-01');
  assert.equal(partner.followup_next_action_date, '2026-02-01');

  // Edit on form for company 1
  const formChanges = changeFormValue('res.partner', partner, {}, 'followup_next_action_date', '2026-02-15', db);
  assert.ok(formChanges.followup_lines);
  const saved = saveFormRecord(db, 'res.partner', f.partner, formChanges);
  const updated = read(saved.db, 'res.partner', f.partner);

  assert.equal(partnerFollowUp(updated, 1)?.followup_next_action_date, '2026-02-15');
  assert.equal(updated.followup_next_action_date, '2026-02-15');
  assert.equal(partnerFollowUp(updated, 2)?.followup_next_action_date, '2026-03-01');
  const rawPartner = saved.db.records['res.partner'].find((p) => p.id === f.partner);
  assert.equal('followup_next_action_date' in rawPartner, false);

  // Switch to company 2 and edit on form
  const db2 = { ...saved.db, settings: { ...saved.db.settings, current_company_id: 2 } };
  const partnerInComp2 = read(db2, 'res.partner', f.partner);
  assert.equal(partnerInComp2.followup_next_action_date, '2026-03-01');
  const formChanges2 = changeFormValue('res.partner', partnerInComp2, {}, 'followup_next_action_date', '2026-04-01', db2);
  const saved2 = saveFormRecord(db2, 'res.partner', f.partner, formChanges2);
  const updated2 = read(saved2.db, 'res.partner', f.partner);

  assert.equal(partnerFollowUp(updated2, 2)?.followup_next_action_date, '2026-04-01');
  assert.equal(partnerFollowUp(updated2, 1)?.followup_next_action_date, '2026-02-15');
});

test('the scheduler honours the per-company next reminder date', () => {
  const base = seed();
  const branch = createCompanyWithDefaultInvoiceJournals(base, { name: 'Branch Two', currency_id: base.records['res.company'][0].currency_id });
  const partner = create(branch.db, 'res.partner', { name: 'Multi-company partner', email: 'multi@example.test' });
  const inv1 = create(partner.db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: partner.id, invoice_date: '2025-12-01', invoice_date_due: '2026-01-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
  const dbWithInv1 = postMove(inv1.db, inv1.id);
  const inv2 = create(dbWithInv1, 'account.move', { move_type: 'out_invoice', company_id: branch.id, partner_id: partner.id, invoice_date: '2025-12-01', invoice_date_due: '2026-01-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
  const dbWithInvs = postMove(inv2.db, inv2.id);

  // Company 1 scheduled for 2026-02-01; Branch scheduled for 2026-01-15
  let db = write(dbWithInvs, 'res.partner', partner.id, {
    followup_lines: [
      { company_id: 1, followup_next_action_date: '2026-02-01' },
      { company_id: branch.id, followup_next_action_date: '2026-01-15' },
    ],
  });

  // At 2026-01-20: Company 1 is postponed, Branch is due
  const sentAt20 = [];
  const dbAfter20 = runFollowUps(db, '2026-01-20', (message) => { sentAt20.push(message); return { status: 'sent' }; });
  assert.equal(sentAt20.length, 1);
  const pAfter20 = read(dbAfter20, 'res.partner', partner.id);
  assert.equal(partnerFollowUp(pAfter20, branch.id)?.followup_date, '2026-01-20');
  assert.equal(partnerFollowUp(pAfter20, 1)?.followup_date ?? null, null);

  // At 2026-02-01: Company 1 is now due and sends its reminder
  const sentAtFeb1 = [];
  const dbAfterFeb1 = runFollowUps(dbAfter20, '2026-02-01', (message) => { sentAtFeb1.push(message); return { status: 'sent' }; });
  assert.ok(sentAtFeb1.length > 0);
  const pAfterFeb1 = read(dbAfterFeb1, 'res.partner', partner.id);
  assert.equal(partnerFollowUp(pAfterFeb1, 1)?.followup_date, '2026-02-01');
});

test('migration moves stored partner-level followup_next_action_date to the current company line', () => {
  const f = fixture();
  const legacyDb = {
    ...f.db,
    schema_version: 62,
    records: {
      ...f.db.records,
      'res.partner': f.db.records['res.partner'].map((p) => p.id === f.partner ? { ...p, followup_next_action_date: '2026-02-10' } : p),
    },
  };
  const migrated = migrate(legacyDb);
  assert.equal(migrated.schema_version, 82);
  const rawPartner = migrated.records['res.partner'].find((p) => p.id === f.partner);
  assert.equal('followup_next_action_date' in rawPartner, false);
  const compLine = partnerFollowUp(rawPartner, 1);
  assert.equal(compLine?.followup_next_action_date, '2026-02-10');
  const readPartner = read(migrated, 'res.partner', f.partner);
  assert.equal(readPartner.followup_next_action_date, '2026-02-10');
});

test('migration retains existing company next reminder date when partner has a conflicting legacy date', () => {
  const f = fixture();
  const legacyDb = {
    ...f.db,
    schema_version: 62,
    records: {
      ...f.db.records,
      'res.partner': f.db.records['res.partner'].map((p) => p.id === f.partner ? {
        ...p,
        followup_next_action_date: '2026-02-10',
        followup_lines: [{ company_id: 1, followup_next_action_date: '2026-03-01' }],
      } : p),
    },
  };
  const migrated = migrate(legacyDb);
  assert.equal(migrated.schema_version, 82);
  const rawPartner = migrated.records['res.partner'].find((p) => p.id === f.partner);
  assert.equal('followup_next_action_date' in rawPartner, false);
  const compLine = partnerFollowUp(rawPartner, 1);
  assert.equal(compLine?.followup_next_action_date, '2026-03-01');
  const readPartner = read(migrated, 'res.partner', f.partner);
  assert.equal(readPartner.followup_next_action_date, '2026-03-01');
});

test('migration backfills automatic reminder type for partners where absent and preserves explicit manual', () => {
  const base = seed();
  const legacyDb = {
    ...base,
    schema_version: 62,
    records: {
      ...base.records,
      'res.partner': [
        { id: 901, name: 'Legacy partner without reminder type' },
        { id: 902, name: 'Explicit manual partner', followup_reminder_type: 'manual' },
        { id: 903, name: 'Explicit automatic partner', followup_reminder_type: 'automatic' },
      ],
    },
  };
  const migrated = migrate(legacyDb);
  assert.equal(migrated.schema_version, 82);
  const p1 = migrated.records['res.partner'].find((p) => p.id === 901);
  const p2 = migrated.records['res.partner'].find((p) => p.id === 902);
  const p3 = migrated.records['res.partner'].find((p) => p.id === 903);
  assert.equal(p1.followup_reminder_type, 'automatic');
  assert.equal(p2.followup_reminder_type, 'manual');
  assert.equal(p3.followup_reminder_type, 'automatic');
});

test('manual-mode customer without email renders Confirm Sent and logs phone or letter follow-up', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  await initStore();
  const base = getDb();
  const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
  const textOf = (node) => (node?.nodeType === 3 ? node.nodeValue : (node?.childNodes ?? []).map(textOf).join(''));

  const due = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const pPhone = { id: 8001, name: 'Manual Customer Phone', phone: '+1234567890', email: '', followup_reminder_type: 'manual', followup_lines: [] };
  const pLetter = { id: 8002, name: 'Manual Customer Letter', phone: '', email: '', followup_reminder_type: 'manual', followup_lines: [] };
  const inv1 = { id: 8101, name: 'INV-PHONE', company_id: 1, partner_id: pPhone.id, state: 'posted', move_type: 'out_invoice', invoice_date_due: due(10), amount_residual: 100, invoice_line_ids: [{ qty: 1, price_unit: 100 }] };
  const inv2 = { id: 8102, name: 'INV-LETTER', company_id: 1, partner_id: pLetter.id, state: 'posted', move_type: 'out_invoice', invoice_date_due: due(10), amount_residual: 100, invoice_line_ids: [{ qty: 1, price_unit: 100 }] };

  const db = {
    ...base,
    settings: { ...base.settings, current_company_id: 1, allowed_company_ids: [1] },
    records: {
      ...base.records,
      'res.partner': [pPhone, pLetter],
      'account.move': [inv1, inv2],
      'account.followup.level': [{ id: 1, name: 'First Reminder', delay: 0, send_email: true }],
    },
  };
  await React.act(async () => commit(db));

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'followups' } })));
    const mailLink = find(host, (n) => n.tagName === 'A' && props(n)?.href?.startsWith('mailto:'));
    assert.equal(mailLink, null, 'no mail link rendered without email');

    const buttons = [];
    const collectButtons = (node) => {
      if (node.tagName === 'BUTTON' && textOf(node).trim() === 'Confirm Sent') buttons.push(node);
      for (const child of node.childNodes ?? []) collectButtons(child);
    };
    collectButtons(host);
    assert.equal(buttons.length, 2, 'Confirm Sent rendered for both manual customers without email');

    // Click first button (phone customer)
    await React.act(async () => props(buttons[0]).onClick());
    let saved = getDb();
    let prog1 = partnerFollowUp(read(saved, 'res.partner', pPhone.id), 1);
    assert.equal(prog1?.followup_channel, 'phone');
    assert.equal(prog1?.followup_delivery_state, 'sent');
    assert.ok(messagesOf(saved, 'res.partner', pPhone.id).some((m) => /sent by phone/i.test(m.body)));

    // Click second button (letter customer)
    await React.act(async () => props(buttons[1]).onClick());
    saved = getDb();
    let prog2 = partnerFollowUp(read(saved, 'res.partner', pLetter.id), 1);
    assert.equal(prog2?.followup_channel, 'letter');
    assert.equal(prog2?.followup_delivery_state, 'sent');
    assert.ok(messagesOf(saved, 'res.partner', pLetter.id).some((m) => /sent by letter/i.test(m.body)));
  } finally {
    await React.act(async () => root.unmount());
  }
});
