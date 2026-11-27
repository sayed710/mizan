import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { register } from 'node:module';
import { find, setupDom } from './test-support/dom.js';
import { create, messagesOf, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { addDays, today } from './models/common.js';
import { postMove } from './models/accounting.js';
import { applyDiff, diffDb } from './sync.js';
import { apps, findLeaf, models } from './models/index.js';
import {
  financeModels,
  followUpEmail,
  followUpLetter,
  followUpReportData,
  isFollowUpSmsDiff,
  isPartnerFollowUpPostponed,
  levelChannels,
  partnerFollowUp,
  partnerFollowUpStatus,
  postponeFollowUp,
  processFollowUps,
  unpostponeFollowUp,
} from './models/finance.js';
import { buildXlsx, readXlsx } from './xlsx.js';
import { sendFollowUp } from '../server/mail.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const textOf = (node) => (node?.nodeType === 3 ? node.nodeValue : (node?.childNodes ?? []).map(textOf).join(''));
const allFind = (node, pred) => [
  ...(pred(node) ? [node] : []),
  ...(node?.childNodes ?? []).flatMap((c) => allFind(c, pred)),
];

async function mountView(renderElement, initialDb, { fetchImpl = null } = {}) {
  const prevStorage = globalThis.localStorage;
  const prevFetch = globalThis.fetch;
  const prevSetInterval = globalThis.setInterval;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
  if (fetchImpl) {
    globalThis.fetch = fetchImpl;
    globalThis.setInterval = () => 0;
  }
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
  if (!fetchImpl) await commit(initialDb);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => root.render(renderElement(React)));
  return {
    React,
    host,
    getDb,
    commit,
    done: async () => {
      await React.act(async () => root.unmount());
      if (fetchImpl) {
        globalThis.fetch = () => Promise.reject(new Error('offline'));
        await initStore();
      }
      globalThis.localStorage = prevStorage;
      globalThis.fetch = prevFetch;
      globalThis.setInterval = prevSetInterval;
    },
  };
}

function makeOverdueInvoice(db, { partnerId, dueDate, amount = 100, companyId = 1 }) {
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: companyId,
    partner_id: partnerId,
    invoice_date: addDays(dueDate, -10),
    invoice_date_due: dueDate,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: amount, tax: 0 }],
  });
  return { db: postMove(inv.db, inv.id), id: inv.id };
}

function fakeSmtp() {
  const seen = [];
  const server = net.createServer((s) => {
    s.on('error', () => {});
    s.write('220 fake\r\n');
    let inData = false;
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      for (let i; (i = buf.indexOf('\r\n')) >= 0;) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; s.write('250 queued\r\n'); }
          else seen.push(line);
          continue;
        }
        seen.push(line);
        if (line.startsWith('EHLO')) s.write('250 fake\r\n');
        else if (line.startsWith('MAIL') || line.startsWith('RCPT')) s.write('250 ok\r\n');
        else if (line === 'DATA') { inData = true; s.write('354 go\r\n'); }
        else if (line === 'QUIT') { s.write('221 bye\r\n'); s.end(); }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    seen,
    cfg: { host: '127.0.0.1', port: server.address().port, from: 'erp@mizan.example' },
  })));
}

test('1. Follow-up level configuration supports mail template, SMS template, Attach Invoices, Print Letter, and diff guards', async () => {
  const levelModel = financeModels['account.followup.level'];
  for (const fieldName of ['mail_template_id', 'sms_template_id', 'join_invoices', 'print_letter']) {
    assert.ok(levelModel.fields[fieldName], `${fieldName} declared on account.followup.level`);
  }
  assert.equal(levelModel.defaults().join_invoices, true);
  assert.equal(levelModel.defaults().print_letter, false);

  let db = seed();
  db = { ...db, records: { ...db.records, 'account.followup.level': [], 'account.move': [] } };

  const mailTpl = create(db, 'mail.template', {
    name: 'Gentle Email',
    model: 'res.partner',
    subject: 'Reminder for {{ object.name }}',
    body: 'Dear {{ object.name }}, please review your balance.',
  });
  const smsTpl = create(mailTpl.db, 'sms.template', {
    name: 'Gentle SMS',
    model: 'res.partner',
    body: 'Hi {{ object.name }}, your invoice is overdue.',
  });
  const invoiceTpl = create(smsTpl.db, 'mail.template', {
    name: 'Invoice Only Template',
    model: 'account.move',
    subject: 'Inv',
    body: 'Body',
  });
  const invoiceSmsTpl = create(invoiceTpl.db, 'sms.template', {
    name: 'Invoice SMS Template',
    model: 'account.move',
    body: 'SMS Body',
  });
  db = invoiceSmsTpl.db;

  // Diff-verifiable guard rejects templates whose model is not res.partner
  const badMailLvl = {
    ...db,
    seq: { ...db.seq, 'account.followup.level': 1 },
    records: {
      ...db.records,
      'account.followup.level': [{
        id: 1, display_delay: 5, reminder_timing: 'after', delay: 5,
        activity_default_responsible_type: 'followup',
        send_email: true, mail_template_id: invoiceTpl.id,
      }],
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, badMailLvl), { isAdmin: true }), /Content Template must apply to Contact/);

  const badSmsLvl = {
    ...db,
    seq: { ...db.seq, 'account.followup.level': 1 },
    records: {
      ...db.records,
      'account.followup.level': [{
        id: 1, display_delay: 5, reminder_timing: 'after', delay: 5,
        activity_default_responsible_type: 'followup',
        send_sms: true, sms_template_id: invoiceSmsTpl.id,
      }],
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, badSmsLvl), { isAdmin: true }), /SMS Template must apply to Contact/);

  // Create valid level with templates, print_letter, and join_invoices: true
  const lvl = create(db, 'account.followup.level', {
    display_delay: 10,
    reminder_timing: 'after',
    send_email: true,
    send_sms: true,
    print_letter: true,
    join_invoices: true,
    mail_template_id: mailTpl.id,
    sms_template_id: smsTpl.id,
  });
  const levelRec = read(lvl.db, 'account.followup.level', lvl.id);
  assert.deepEqual(levelChannels(levelRec), ['email', 'sms', 'letter']);

  const partner = create(lvl.db, 'res.partner', {
    name: 'Template Customer',
    email: 'tpl@example.test',
    mobile: '+201001234567',
    customer_rank: 1,
  });
  const inv = makeOverdueInvoice(partner.db, { partnerId: partner.id, dueDate: '2026-01-01', amount: 250 });
  db = inv.db;

  const letter = followUpLetter(db, partner.id, 1, '2026-01-20');
  assert.equal(letter.subject, 'Reminder for Template Customer');
  assert.equal(letter.message, 'Dear Template Customer, please review your balance.');

  const emailPayload = followUpEmail(db, letter.reminder, letter.level, read(db, 'res.partner', partner.id));
  assert.equal(emailPayload.subject, 'Reminder for Template Customer');
  assert.match(emailPayload.text, /Dear Template Customer, please review your balance\./);
  assert.equal(emailPayload.joinInvoices, true);
  assert.deepEqual(emailPayload.invoiceIds, [inv.id]);

  // Real SMTP attachment check via sendFollowUp (join_invoices: true vs false)
  const { server, seen, cfg } = await fakeSmtp();
  try {
    const sentWithAttach = await sendFollowUp(cfg, db, { name: 'Admin', isAdmin: true }, { partnerId: partner.id, companyId: 1, at: '2026-01-20' });
    assert.equal(sentWithAttach.status, 200);
    const rawMail = seen.join('\n');
    assert.match(rawMail, /Content-Type: multipart\/mixed/);
    assert.match(rawMail, /Content-Disposition: attachment; filename="[^"]*\.html"/);
  } finally {
    server.close();
  }

  // processFollowUps renders SMS template and isFollowUpSmsDiff accepts it for accounting user
  const batch = await processFollowUps(db, [partner.id], {
    companyId: 1,
    at: '2026-01-20',
    deliverEmail: () => ({ status: 'sent' }),
  });
  const smsCamp = search(batch.db, 'sms.campaign').find((c) => c.followup_sms);
  assert.equal(smsCamp.body, 'Hi Template Customer, your invoice is overdue.');
  assert.ok(batch.results[0].actions.includes('letter'));
  assert.equal(isFollowUpSmsDiff(diffDb(db, batch.db), db), true);
});

test('2. FollowUpWizard offers Email, Print, SMS, Attach Invoices (no By post) and WhatsApp only when integrated', async () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.followup.level': [], 'account.move': [] } };
  const lvl = create(db, 'account.followup.level', {
    display_delay: 5,
    reminder_timing: 'after',
    send_email: true,
    send_sms: true,
    print_letter: false,
    join_invoices: true,
    message: 'Please settle.',
    sms_message: 'SMS settle.',
  });
  const partner = create(lvl.db, 'res.partner', {
    name: 'Wizard Customer',
    email: 'wiz@example.test',
    mobile: '+201001112233',
    customer_rank: 1,
  });
  const due = addDays(today(), -15);
  db = makeOverdueInvoice(partner.db, { partnerId: partner.id, dueDate: due, amount: 300 }).db;

  const { FollowUpWizard } = await import('./views/FollowUpLetter.jsx');

  // 2a. Local / no WhatsApp integration: offers Email, Print, SMS, Attach Invoices; NO By post, NO WhatsApp
  const localMount = await mountView(
    (React) => React.createElement(FollowUpWizard, { partnerId: partner.id, companyId: 1, onClose: () => {} }),
    db,
  );
  try {
    const labels = allFind(localMount.host, (n) => n.tagName === 'LABEL').map((l) => textOf(l).trim());
    assert.deepEqual(labels, ['Email', 'Print', 'SMS', 'Attach Invoices']);
    assert.equal(labels.includes('By post'), false);
    assert.equal(labels.includes('WhatsApp'), false);
  } finally {
    await localMount.done();
  }

  // 2b. Server mode with WhatsApp integration enabled: offers WhatsApp and calls /api/integrations/whatsapp
  const calls = [];
  let serverDb = db;
  const serverFetch = async (url, init) => {
    const path = String(url);
    if (path === '/api/session') {
      return new Response(JSON.stringify({ name: 'Admin', isAdmin: true, integrations: { smtp: true, whatsapp: true } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (path === '/api/db') {
      return new Response(JSON.stringify(serverDb), { status: 200, headers: { 'Content-Type': 'application/json', etag: '"e1"' } });
    }
    if (path === '/api/integrations/whatsapp') {
      calls.push({ path, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, message: 'WhatsApp message sent' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (path === '/api/diff') {
      const diff = JSON.parse(init.body);
      serverDb = applyDiff(serverDb, diff, { isAdmin: true });
      return new Response(JSON.stringify(serverDb), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  let closed = false;
  const waMount = await mountView(
    (React) => React.createElement(FollowUpWizard, { partnerId: partner.id, companyId: 1, onClose: () => { closed = true; } }),
    db,
    { fetchImpl: serverFetch },
  );
  try {
    const labels = allFind(waMount.host, (n) => n.tagName === 'LABEL').map((l) => textOf(l).trim());
    assert.deepEqual(labels, ['Email', 'Print', 'SMS', 'Attach Invoices', 'WhatsApp']);
    const checks = allFind(waMount.host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox');
    // Uncheck Email & SMS, check WhatsApp only
    await waMount.React.act(async () => {
      props(checks[0]).onChange({ target: { checked: false } });
      props(checks[2]).onChange({ target: { checked: false } });
      props(checks[4]).onChange({ target: { checked: true } });
    });
    const prevAlert = globalThis.alert;
    globalThis.alert = () => {};
    try {
      const sendBtn = find(waMount.host, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Send');
      await waMount.React.act(async () => props(sendBtn).onClick());
    } finally {
      globalThis.alert = prevAlert;
    }
    assert.equal(closed, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/api/integrations/whatsapp');
    assert.equal(calls[0].body.model, 'res.partner');
    assert.equal(calls[0].body.id, partner.id);
    assert.match(calls[0].body.text, /Please settle\./);
    assert.equal(partnerFollowUp(read(waMount.getDb(), 'res.partner', partner.id), 1)?.followup_channel, 'whatsapp');
  } finally {
    await waMount.done();
  }
});

test('3. Postpone and Unpostpone actions manage partner state, chatter, list/form actions, and report UI', async () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.followup.level': [], 'account.move': [] } };
  db = create(db, 'account.followup.level', { display_delay: 5, reminder_timing: 'after', send_email: true }).db;

  const p = create(db, 'res.partner', { name: 'Unpostpone Customer', email: 'unp@example.test', customer_rank: 1 });
  const due = addDays(today(), -15);
  db = makeOverdueInvoice(p.db, { partnerId: p.id, dueDate: due }).db;

  const futureDate = addDays(today(), 14);
  db = postponeFollowUp(db, [p.id], futureDate, { companyId: 1 });
  assert.equal(isPartnerFollowUpPostponed(db, read(db, 'res.partner', p.id), 1), true);
  assert.equal(partnerFollowUpStatus(db, read(db, 'res.partner', p.id), 1), 'with_overdue_invoices');

  // Partner form exposes Unpostpone when postponed and Postpone when unpostponed
  const partnerFormButtons = models['res.partner'].form.buttons;
  const postponeBtnSpec = partnerFormButtons.find((b) => b.label === 'Postpone');
  const unpostponeBtnSpec = partnerFormButtons.find((b) => b.label === 'Unpostpone');
  assert.ok(postponeBtnSpec);
  assert.ok(unpostponeBtnSpec);
  const acctUser = { apps: ['accounting'], isAdmin: false };
  assert.equal(unpostponeBtnSpec.when(read(db, 'res.partner', p.id), db, acctUser), true);
  assert.equal(postponeBtnSpec.when(read(db, 'res.partner', p.id), db, acctUser), false);

  // Customers listAction Unpostpone clears postponement and passes diffDb + applyDiff
  const customersLeaf = findLeaf(apps.find((a) => a.id === 'accounting'), 'customers');
  const listUnpostpone = customersLeaf.listActions.find((a) => a.label === 'Unpostpone');
  assert.ok(listUnpostpone);
  const clearedByList = listUnpostpone.run(db, [p.id]).db;
  const synced = applyDiff(db, diffDb(db, clearedByList), { isAdmin: true });
  const clearedPartner = read(synced, 'res.partner', p.id);
  assert.equal(clearedPartner.followup_next_action_date, null);
  assert.equal(isPartnerFollowUpPostponed(synced, clearedPartner, 1), false);
  assert.equal(partnerFollowUpStatus(synced, clearedPartner, 1), 'in_need_of_action');
  assert.ok(messagesOf(synced, 'res.partner', p.id).some((m) => /Follow-up unpostponed/.test(m.body)));

  // Reports UI row Unpostpone button clears postponement
  const postponedAgain = postponeFollowUp(synced, [p.id], futureDate, { companyId: 1 });
  const { Reports } = await import('./views/Reports.jsx');
  const mounted = await mountView((React) => React.createElement(Reports, { leaf: { report: 'followups' } }), postponedAgain);
  try {
    assert.ok(textOf(mounted.host).includes(`Postponed (${futureDate})`));
    const rowUnpostpone = allFind(mounted.host, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Unpostpone')
      .find((btn) => btn.parentNode?.tagName === 'SPAN');
    assert.ok(rowUnpostpone, 'row Unpostpone button rendered');
    await mounted.React.act(async () => props(rowUnpostpone).onClick());
    assert.equal(isPartnerFollowUpPostponed(mounted.getDb(), read(mounted.getDb(), 'res.partner', p.id), 1), false);
    assert.doesNotMatch(textOf(mounted.host), new RegExp(`Postponed \\(${futureDate}\\)`));
  } finally {
    await mounted.done();
  }

  // Calling unpostponeFollowUp on non-postponed partner is a safe no-op without duplicate chatter
  const noOp = unpostponeFollowUp(synced, [p.id], { companyId: 1 });
  assert.equal(messagesOf(noOp, 'res.partner', p.id).length, messagesOf(synced, 'res.partner', p.id).length);
});

test('4. Follow-up report honours As of Date instead of always today', async () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.followup.level': [], 'account.move': [] } };
  db = create(db, 'account.followup.level', { display_delay: 5, reminder_timing: 'after', send_email: true }).db;
  db = create(db, 'account.followup.level', { display_delay: 30, reminder_timing: 'after', send_email: true }).db;

  const p = create(db, 'res.partner', { name: 'AsOf Date Customer', email: 'asof@example.test', customer_rank: 1 });
  // Invoice due 2026-01-10 ($200), second invoice dated 2026-02-01 due 2026-02-15 ($150)
  const inv1 = create(p.db, 'account.move', {
    move_type: 'out_invoice', company_id: 1, partner_id: p.id,
    invoice_date: '2026-01-01', invoice_date_due: '2026-01-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 200, tax: 0 }],
  });
  const inv2 = create(postMove(inv1.db, inv1.id), 'account.move', {
    move_type: 'out_invoice', company_id: 1, partner_id: p.id,
    invoice_date: '2026-02-01', invoice_date_due: '2026-02-15',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 150, tax: 0 }],
  });
  db = postMove(inv2.db, inv2.id);

  const { Reports } = await import('./views/Reports.jsx');
  const mounted = await mountView(
    (React) => React.createElement(Reports, { leaf: { report: 'followups' }, params: new URLSearchParams('to=2026-01-20') }),
    db,
  );
  try {
    const asOfInput = find(mounted.host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'As of');
    assert.ok(asOfInput, 'As of Date input is rendered on followups report');
    assert.equal(props(asOfInput).value, '2026-01-20');

    // At 2026-01-20: only inv1 ($200) exists and is 10 days overdue -> 5 days after level
    const janText = textOf(mounted.host);
    assert.match(janText, /AsOf Date Customer/);
    assert.match(janText, /5 days after/);
    assert.match(janText, /200\.00/);
    assert.doesNotMatch(janText, /350\.00/);

    // Change As of Date to 2026-02-25: both invoices ($350) are overdue and oldest is 46 days overdue -> 30 days after level
    await mounted.React.act(async () => props(asOfInput).onChange({ target: { value: '2026-02-25' } }));
    const febText = textOf(mounted.host);
    assert.match(febText, /30 days after/);
    assert.match(febText, /350\.00/);
  } finally {
    await mounted.done();
  }
});

test('5. Follow-up report Print (PDF) and XLSX export include company header and level/status summary', async () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.followup.level': [], 'account.move': [] } };
  db = write(db, 'res.company', 1, { street: '100 Tahrir Sq', city: 'Cairo', vat: 'EG-TAX-99' });
  db = create(db, 'account.followup.level', { display_delay: 5, reminder_timing: 'after', send_email: true }).db;
  db = create(db, 'account.followup.level', { display_delay: 30, reminder_timing: 'after', send_email: true }).db;

  const p1 = create(db, 'res.partner', { name: 'Export Alpha', email: 'a@example.test', customer_rank: 1 });
  const p2 = create(p1.db, 'res.partner', { name: 'Export Beta', email: 'b@example.test', customer_rank: 1 });
  db = makeOverdueInvoice(p2.db, { partnerId: p1.id, dueDate: '2026-01-20', amount: 120 }).db; // 11 days @ Jan 31 -> 5 days after
  db = makeOverdueInvoice(db, { partnerId: p2.id, dueDate: '2025-12-20', amount: 280 }).db; // 42 days @ Jan 31 -> 30 days after
  db = postponeFollowUp(db, [p2.id], '2026-02-20', { companyId: 1, at: '2026-01-31' });

  // Pure data & XLSX export check
  const summaryData = followUpReportData(db, [1], 'all', '2026-01-31');
  assert.equal(summaryData.totalCount, 2);
  assert.equal(summaryData.statusSummary.find((s) => s.key === 'in_need_of_action')?.count, 1);
  assert.equal(summaryData.statusSummary.find((s) => s.key === 'postponed')?.count, 1);
  assert.equal(summaryData.levelSummary.length, 2);

  const { Reports, followUpReportExportRows } = await import('./views/Reports.jsx');
  const exportSpec = followUpReportExportRows(db, db, { allowed: [1], statusFilter: 'all', at: '2026-01-31' });
  const xlsxBytes = buildXlsx(exportSpec.rows, {
    sheetName: 'Follow-up Reports',
    headerRowCount: exportSpec.headerRowCount,
    columnTypes: exportSpec.columnTypes,
  });
  const parsed = readXlsx(xlsxBytes);
  const flat = parsed.rows.flat().map(String);
  assert.ok(flat.some((v) => v.includes('Nile Furniture') || v.includes(read(db, 'res.company', 1).name)), 'company header present in XLSX');
  assert.ok(flat.some((v) => v.includes('EG-TAX-99')), 'company Tax ID in XLSX header');
  assert.ok(flat.includes('Follow-up Reports'));
  assert.ok(flat.includes('2026-01-31'));
  assert.ok(flat.includes('Export Alpha'));
  assert.ok(flat.includes('Export Beta'));
  assert.ok(flat.includes('Follow-up Status Summary'));
  assert.ok(flat.includes('Follow-up Level Summary'));
  assert.ok(flat.includes('5 days after'));
  assert.ok(flat.includes('30 days after'));
  const totalRow = parsed.rows.find((r) => r[0] === 'Total');
  assert.ok(totalRow, 'Grand Total row present in XLSX');
  assert.equal(totalRow[4], 400);
  assert.equal(totalRow[5], 400);

  // Print / PDF view check
  const prevPrint = globalThis.window?.print;
  if (globalThis.window) globalThis.window.print = () => {};
  const mounted = await mountView(
    (React) => React.createElement(Reports, { leaf: { report: 'followups' }, params: new URLSearchParams('to=2026-01-31') }),
    db,
  );
  try {
    globalThis.window.print = () => {};
    const printBtn = find(mounted.host, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Print');
    assert.ok(printBtn);
    await mounted.React.act(async () => props(printBtn).onClick());

    const printHead = find(mounted.host, (n) => props(n)?.className === 'paper-head');
    assert.ok(printHead, 'Company header rendered in Follow-up print view');
    assert.match(textOf(printHead), /EG-TAX-99/);
    const printedText = textOf(mounted.host);
    assert.match(printedText, /As of Date: 2026-01-31/);
    assert.match(printedText, /Follow-up Status Summary/);
    assert.match(printedText, /Follow-up Level Summary/);
    // Interactive action buttons are suppressed while printing
    assert.equal(allFind(mounted.host, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Unpostpone').length, 0);
  } finally {
    if (globalThis.window) globalThis.window.print = prevPrint;
    await mounted.done();
  }
});
