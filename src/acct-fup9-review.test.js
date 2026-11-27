import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';
import { find, setupDom } from './test-support/dom.js';
import { create, messagesOf, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { addDays, today } from './models/common.js';
import { payMove, postMove } from './models/accounting.js';
import { applyDiff, diffDb } from './sync.js';
import { apps, findLeaf, leavesOf, models, writableModelsForApps } from './models/index.js';
import {
  isPartnerFollowUpPostponed,
  logManualFollowUp,
  partnerFollowUp,
  partnerFollowUpStatus,
  postponeFollowUp,
  processFollowUps,
  runFollowUps,
  unpostponeFollowUp,
} from './models/finance.js';
import { sendFollowUp } from '../server/mail.js';
import { createMailTransport } from '../server/mailTransport.js';
import { openStorage } from '../server/storage.js';
import { startServer } from '../server/test-server.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const textOf = (node) => (node?.nodeType === 3 ? node.nodeValue : (node?.childNodes ?? []).map(textOf).join(''));
const allFind = (node, pred) => [
  ...(pred(node) ? [node] : []),
  ...(node?.childNodes ?? []).flatMap((c) => allFind(c, pred)),
];

async function mountView(renderElement, initialDb, { fetchImpl = null, windowOpen = null } = {}) {
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
  const prevOpen = globalThis.window.open;
  if (windowOpen) globalThis.window.open = windowOpen;
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
      globalThis.window.open = prevOpen;
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

test('Finding 1: scheduled emails attach eligible overdue invoices matching manual sendFollowUp', async () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.followup.level': [], 'account.move': [] } };
  const lvlAttach = create(db, 'account.followup.level', {
    display_delay: 5,
    reminder_timing: 'after',
    send_email: true,
    join_invoices: true,
    message: 'Please attach invoices.',
  });
  const partner = create(lvlAttach.db, 'res.partner', {
    name: 'Attach Customer',
    email: 'attach@example.test',
    customer_rank: 1,
  });
  const due = addDays(today(), -15);
  const inv = makeOverdueInvoice(partner.db, { partnerId: partner.id, dueDate: due, amount: 225 });
  db = inv.db;

  const sentBySchedule = [];
  const transport = createMailTransport({
    smtp: { host: 'smtp.mock', port: 587, from: 'noreply@example.com' },
    send: async (_cfg, msg) => { sentBySchedule.push(msg); },
  });
  await runFollowUps(db, today(), transport);
  assert.equal(sentBySchedule.length, 1);
  assert.equal(sentBySchedule[0].attachments?.length, 1);
  assert.match(sentBySchedule[0].attachments[0].filename, /\.html$/);
  assert.match(sentBySchedule[0].attachments[0].content, new RegExp(read(db, 'account.move', inv.id).name));

  // Manual path produces the same attachment
  const sentByManual = [];
  await sendFollowUp(
    { host: 'smtp.mock', port: 587, from: 'noreply@example.com' },
    db,
    { name: 'Admin', isAdmin: true },
    { partnerId: partner.id, companyId: 1 },
    async (_cfg, msg) => { sentByManual.push(msg); },
  );
  assert.equal(sentByManual.length, 1);
  assert.deepEqual(sentBySchedule[0].attachments, sentByManual[0].attachments);

  // When join_invoices is false, scheduled run omits attachments
  const noAttachDb = write(db, 'account.followup.level', lvlAttach.id, { join_invoices: false });
  const sentNoAttach = [];
  const transportNoAttach = createMailTransport({
    smtp: { host: 'smtp.mock', port: 587, from: 'noreply@example.com' },
    send: async (_cfg, msg) => { sentNoAttach.push(msg); },
  });
  await runFollowUps(noAttachDb, today(), transportNoAttach);
  assert.equal(sentNoAttach.length, 1);
  assert.equal(sentNoAttach[0].attachments, undefined);
});

test('Finding 2: scheduled runs retain pending manual letter on email+letter and sms+letter levels', async () => {
  const at = today();
  const due = addDays(at, -20);

  // 2a. Email + Letter combined level
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.followup.level': [], 'account.move': [] } };
  const emailLetterLvl = create(db, 'account.followup.level', {
    display_delay: 5,
    reminder_timing: 'after',
    send_email: true,
    print_letter: true,
    message: 'Email and print.',
  });
  const pEmail = create(emailLetterLvl.db, 'res.partner', {
    name: 'Email Letter Customer',
    email: 'el@example.test',
    customer_rank: 1,
  });
  db = makeOverdueInvoice(pEmail.db, { partnerId: pEmail.id, dueDate: due, amount: 180 }).db;

  const emails = [];
  let afterRun = await runFollowUps(db, at, (m) => { emails.push(m); return { status: 'sent' }; });
  assert.equal(emails.length, 1);
  const lineAfter = partnerFollowUp(read(afterRun, 'res.partner', pEmail.id), 1);
  assert.equal(lineAfter.followup_pending_letter, true);
  assert.equal(lineAfter.followup_email_level_delay, 5);
  assert.equal(lineAfter.followup_level_delay, null, 'level does not advance until letter is printed');
  assert.equal(lineAfter.followup_channel, 'letter');
  assert.equal(lineAfter.followup_delivery_state, 'not_sent');
  assert.equal(partnerFollowUpStatus(afterRun, read(afterRun, 'res.partner', pEmail.id), 1, at), 'in_need_of_action');

  // Re-running scheduler same day and next day does not resend email
  afterRun = await runFollowUps(afterRun, at, (m) => { emails.push(m); return { status: 'sent' }; });
  afterRun = await runFollowUps(afterRun, addDays(at, 1), (m) => { emails.push(m); return { status: 'sent' }; });
  assert.equal(emails.length, 1);

  // Follow-up report exposes Pending Letter badge and manual print actions
  const { Reports } = await import('./views/Reports.jsx');
  const mounted = await mountView((React) => React.createElement(Reports, { leaf: { report: 'followups' } }), afterRun);
  try {
    assert.match(textOf(mounted.host), /Pending Letter/);
    assert.ok(find(mounted.host, (n) => n.tagName === 'A' && textOf(n).trim() === 'Print Letter'));
    assert.ok(find(mounted.host, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Mark letter as printed'));
  } finally {
    await mounted.done();
  }

  // Batch processing offers the pending letter without re-sending email
  const batchAfter = await processFollowUps(afterRun, [pEmail.id], {
    companyId: 1,
    at,
    deliverEmail: (m) => { emails.push(m); return { status: 'sent' }; },
  });
  assert.equal(emails.length, 1);
  assert.deepEqual(batchAfter.results[0].pendingManual, ['letter']);
  assert.deepEqual(batchAfter.results[0].actions, ['letter']);

  // Confirming the printed letter clears pending flag and completes the level
  const confirmed = logManualFollowUp(batchAfter.db, pEmail.id, at, { companyId: 1, channel: 'letter' });
  assert.equal(partnerFollowUp(read(confirmed, 'res.partner', pEmail.id), 1)?.followup_pending_letter, false);
  assert.equal(partnerFollowUp(read(confirmed, 'res.partner', pEmail.id), 1)?.followup_level_delay, 5);
  assert.equal(partnerFollowUpStatus(confirmed, read(confirmed, 'res.partner', pEmail.id), 1, at), 'with_overdue_invoices');

  // 2b. SMS + Letter combined level
  let smsDb = seed();
  smsDb = { ...smsDb, records: { ...db.records, 'account.followup.level': [], 'account.move': [], 'sms.campaign': [], 'sms.trace': [] } };
  const smsLetterLvl = create(smsDb, 'account.followup.level', {
    display_delay: 5,
    reminder_timing: 'after',
    send_email: false,
    send_sms: true,
    print_letter: true,
    sms_message: 'SMS and print.',
  });
  const pSms = create(smsLetterLvl.db, 'res.partner', {
    name: 'SMS Letter Customer',
    mobile: '+201001234567',
    customer_rank: 1,
  });
  smsDb = makeOverdueInvoice(pSms.db, { partnerId: pSms.id, dueDate: due, amount: 120 }).db;
  let afterSmsRun = await runFollowUps(smsDb, at);
  assert.equal(search(afterSmsRun, 'sms.trace').length, 1);
  const smsLine = partnerFollowUp(read(afterSmsRun, 'res.partner', pSms.id), 1);
  assert.equal(smsLine.followup_pending_letter, true);
  assert.equal(smsLine.followup_sms_level_delay, 5);
  assert.equal(smsLine.followup_level_delay, null);
  assert.equal(partnerFollowUpStatus(afterSmsRun, read(afterSmsRun, 'res.partner', pSms.id), 1, at), 'in_need_of_action');

  // Re-running scheduler and batch does not queue duplicate SMS and keeps pending letter
  afterSmsRun = await runFollowUps(afterSmsRun, addDays(at, 1));
  assert.equal(search(afterSmsRun, 'sms.trace').length, 1);
  const batchSms = await processFollowUps(afterSmsRun, [pSms.id], { companyId: 1, at });
  assert.equal(search(batchSms.db, 'sms.trace').length, 1);
  assert.deepEqual(batchSms.results[0].pendingManual, ['letter']);
});

test('Finding 3: past reports build postpone wizard from today and reject expired postponement dates', async () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.followup.level': [], 'account.move': [] } };
  db = create(db, 'account.followup.level', { display_delay: 5, reminder_timing: 'after', send_email: true }).db;
  const p = create(db, 'res.partner', { name: 'Historical Postpone Customer', email: 'hp@example.test', customer_rank: 1 });
  db = makeOverdueInvoice(p.db, { partnerId: p.id, dueDate: '2025-01-01', amount: 100 }).db;

  const { Reports } = await import('./views/Reports.jsx');
  const mounted = await mountView(
    (React) => React.createElement(Reports, { leaf: { report: 'followups' }, params: new URLSearchParams('to=2025-01-15') }),
    db,
  );
  try {
    const rowCb = find(mounted.host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox' && props(n)?.['aria-label'] === 'Historical Postpone Customer');
    await mounted.React.act(async () => props(rowCb).onChange({ target: { checked: true } }));
    const postponeBtn = find(mounted.host, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Postpone' && !n.parentNode?.className?.includes('no-export'));
    assert.ok(postponeBtn);
    await mounted.React.act(async () => props(postponeBtn).onClick());

    const dateInput = find(mounted.host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'w-date');
    assert.equal(props(dateInput).value, addDays(today(), 7), 'default postponement date is based on today, not 2025-01-15');

    // Trying to save an expired date (2025-01-25 > 2025-01-15, but <= today()) must fail
    await mounted.React.act(async () => props(dateInput).onChange({ target: { value: '2025-01-25' } }));
    const form = find(mounted.host, (n) => n.tagName === 'FORM');
    await mounted.React.act(async () => props(form).onSubmit({ preventDefault() {} }));
    assert.match(textOf(form), /Choose a future date to postpone the reminder/);
    assert.equal(read(mounted.getDb(), 'res.partner', p.id).followup_next_action_date, null);
  } finally {
    await mounted.done();
  }
});

test('Finding 4: FollowUpWizard records every selected channel independently without a second level transition', async () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.followup.level': [], 'account.move': [] } };
  const lvl = create(db, 'account.followup.level', {
    display_delay: 5,
    reminder_timing: 'after',
    send_email: true,
    send_sms: true,
    print_letter: true,
    message: 'Multi channel reminder.',
    sms_message: 'Multi SMS.',
  });
  const partner = create(lvl.db, 'res.partner', {
    name: 'All Channels Customer',
    email: 'all@example.test',
    phone: '+201001112233',
    customer_rank: 1,
  });
  const due = addDays(today(), -15);
  const inv = makeOverdueInvoice(partner.db, { partnerId: partner.id, dueDate: due, amount: 400 });
  db = inv.db;

  let serverDb = db;
  const apiCalls = [];
  const fakeWin = { location: { href: '' }, close() {} };
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
    if (path === '/api/mail/followup') {
      apiCalls.push(path);
      const body = JSON.parse(init.body);
      const out = await sendFollowUp({ host: '127.0.0.1', port: 25, from: 'a@b.c' }, serverDb, { name: 'Admin', isAdmin: true }, body, async () => {});
      serverDb = out.db;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/integrations/whatsapp') {
      apiCalls.push(path);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/diff') {
      serverDb = applyDiff(serverDb, JSON.parse(init.body), { isAdmin: true });
      return new Response(JSON.stringify(serverDb), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  let closed = false;
  const { FollowUpWizard } = await import('./views/FollowUpLetter.jsx');
  const mounted = await mountView(
    (React) => React.createElement(FollowUpWizard, { partnerId: partner.id, companyId: 1, onClose: () => { closed = true; } }),
    db,
    { fetchImpl: serverFetch, windowOpen: () => fakeWin },
  );
  try {
    const checks = allFind(mounted.host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox');
    // Email, Print, SMS are already checked from level; check WhatsApp too
    await mounted.React.act(async () => {
      props(checks[4]).onChange({ target: { checked: true } });
    });
    const sendBtn = find(mounted.host, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Send');
    await mounted.React.act(async () => props(sendBtn).onClick());
    assert.equal(closed, true, `wizard should close; alert=${textOf(find(mounted.host, (n) => props(n)?.role === 'alert'))}`);
    assert.deepEqual(apiCalls, ['/api/mail/followup', '/api/integrations/whatsapp']);
    assert.match(fakeWin.location.href, new RegExp(`#/print/followup/${partner.id}\\?company=1$`));

    const partnerMsgs = messagesOf(mounted.getDb(), 'res.partner', partner.id).map((m) => m.delivery_channel);
    for (const ch of ['email', 'whatsapp', 'sms', 'letter']) {
      assert.ok(partnerMsgs.includes(ch), `partner delivery note recorded for ${ch}`);
    }
    const invMsgs = messagesOf(mounted.getDb(), 'account.move', inv.id).map((m) => m.delivery_channel);
    for (const ch of ['email', 'whatsapp', 'sms', 'letter']) {
      assert.ok(invMsgs.includes(ch), `invoice delivery note recorded for ${ch}`);
    }
    assert.equal(search(mounted.getDb(), 'sms.trace').length, 1);
    assert.equal(partnerFollowUp(read(mounted.getDb(), 'res.partner', partner.id), 1)?.followup_level, lvl.id);
  } finally {
    await mounted.done();
  }
});

test('Finding 5: Accounting users can save mail and SMS templates linked to follow-up levels', () => {
  const acctApp = apps.find((a) => a.id === 'accounting');
  const leaves = leavesOf(acctApp);
  assert.equal(leaves.some((l) => l.model === 'mail.template' || l.model === 'sms.template'), false);
  const technical = apps.find((a) => a.id === 'settings').menus.find((m) => m.label === 'Technical');
  const email = technical.children.find((m) => m.label === 'Email');
  assert.deepEqual(email.children.find((m) => m.key === 'mail-templates'), { key: 'mail-templates', label: 'Email Templates', model: 'mail.template' });
  assert.deepEqual(technical.children.find((m) => m.key === 'sms-templates'), { key: 'sms-templates', label: 'SMS Templates', model: 'sms.template' });
  assert.equal(models['account.followup.level'].fields.mail_template_id.relation, 'mail.template');
  assert.equal(models['account.followup.level'].fields.sms_template_id.relation, 'sms.template');

  const acctWritable = writableModelsForApps(['accounting']);
  assert.equal(acctWritable.has('mail.template'), true);
  assert.equal(acctWritable.has('sms.template'), true);

  const base = seed();
  const mailTpl = create(base, 'mail.template', { name: 'Custom Email Tpl', subject: 'Hello {{ object.name }}', body: 'Pay soon' });
  const smsTpl = create(mailTpl.db, 'sms.template', { name: 'Custom SMS Tpl', body: 'SMS {{ object.name }}' });
  const lvl = create(smsTpl.db, 'account.followup.level', {
    display_delay: 12,
    reminder_timing: 'after',
    send_email: true,
    send_sms: true,
    mail_template_id: mailTpl.id,
    sms_template_id: smsTpl.id,
  });
  const saved = applyDiff(base, diffDb(base, lvl.db), { allowed: acctWritable, isAdmin: false, author: 'Accountant' });
  const savedLvl = read(saved, 'account.followup.level', lvl.id);
  assert.equal(savedLvl.mail_template_id, mailTpl.id);
  assert.equal(savedLvl.sms_template_id, smsTpl.id);
  assert.equal(models['account.followup.level'].fields.mail_template_id.domain(read(saved, 'mail.template', mailTpl.id)), true);
  assert.equal(models['account.followup.level'].fields.sms_template_id.domain(read(saved, 'sms.template', smsTpl.id)), true);
});

test('Finding 6: live follow-up actions ignore historical/future report dates on server and client', async () => {
  // 6a. Server /api/mail/followup ignores body.at
  const dir = mkdtempSync(join(tmpdir(), 'mizan-fup6-'));
  const dbPath = join(dir, 'db.sqlite');
  const sql = new DatabaseSync(dbPath);
  const smtp = await fakeSmtp();
  let server;
  try {
    let base = seed();
    base = { ...base, records: { ...base.records, 'account.followup.level': [], 'account.move': [] } };
    base = create(base, 'account.followup.level', { display_delay: 5, reminder_timing: 'after', send_email: true, message: 'Level 5' }).db;
    const lvl30 = create(base, 'account.followup.level', { display_delay: 30, reminder_timing: 'after', send_email: true, message: 'Level 30' });
    base = lvl30.db;

    const pPaid = create(base, 'res.partner', { name: 'Paid Today Customer', email: 'paid@example.test', customer_rank: 1 });
    const invPaid = makeOverdueInvoice(pPaid.db, { partnerId: pPaid.id, dueDate: '2025-01-01', amount: 100 });
    base = payMove(invPaid.db, invPaid.id, 100, '2025-02-01');

    const pLive = create(base, 'res.partner', { name: 'Live Overdue Customer', email: 'live@example.test', followup_reminder_type: 'manual', customer_rank: 1 });
    const liveDue = addDays(today(), -10); // 10 days overdue today -> Level 5, NOT Level 30 even if body.at is future
    base = makeOverdueInvoice(pLive.db, { partnerId: pLive.id, dueDate: liveDue, amount: 150 }).db;

    openStorage(sql).save(null, base);
    sql.close();

    server = await startServer({
      env: {
        ...process.env,
        PORT: '0',
        MIZAN_DB: dbPath,
        MIZAN_ADMIN_PASSWORD: 'fup6-admin-password',
        MIZAN_SMTP_HOST: smtp.cfg.host,
        MIZAN_SMTP_PORT: String(smtp.cfg.port),
        MIZAN_SMTP_FROM: smtp.cfg.from,
      },
    });
    let cookie = '';
    const api = async (method, path, body) => {
      const res = await fetch(server.url + path, {
        method,
        headers: { 'content-type': 'application/json', 'x-requested-with': 'mizan', cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      cookie = res.headers.get('set-cookie')?.split(';')[0] ?? cookie;
      return { status: res.status, body: await res.json() };
    };
    assert.equal((await api('POST', '/api/login', { login: 'admin', password: 'fup6-admin-password' })).status, 200);

    // Paid-today customer cannot be emailed by passing historical at='2025-01-20'
    const pastRes = await api('POST', '/api/mail/followup', { partnerId: pPaid.id, companyId: 1, at: '2025-01-20' });
    assert.ok(pastRes.status >= 400);
    assert.equal(smtp.seen.length, 0);

    // Live customer with future body.at still sends today's Level 5 and records today()
    const futureRes = await api('POST', '/api/mail/followup', { partnerId: pLive.id, companyId: 1, at: addDays(today(), 40) });
    assert.equal(futureRes.status, 200);
    const afterDb = (await api('GET', '/api/db')).body;
    const liveLine = partnerFollowUp(read(afterDb, 'res.partner', pLive.id), 1);
    assert.equal(liveLine.followup_date, today());
    assert.equal(liveLine.followup_level_delay, 5);
    assert.notEqual(liveLine.followup_level, lvl30.id);
  } finally {
    await server?.stop();
    smtp.server.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 6b. Client historical report (to=2025-01-20) passes today() to wizard, SMS, and batch actions
  let clientDb = seed();
  clientDb = { ...clientDb, records: { ...clientDb.records, 'account.followup.level': [], 'account.move': [] } };
  clientDb = create(clientDb, 'account.followup.level', {
    display_delay: 5,
    reminder_timing: 'after',
    send_email: false,
    send_sms: true,
    print_letter: true,
    sms_message: 'Live SMS',
  }).db;
  const p = create(clientDb, 'res.partner', {
    name: 'Historical Action Customer',
    mobile: '+201001234567',
    customer_rank: 1,
  });
  clientDb = makeOverdueInvoice(p.db, { partnerId: p.id, dueDate: '2025-01-01', amount: 100 }).db;

  const fakeWin = { location: { href: '' }, close() {} };
  const { Reports } = await import('./views/Reports.jsx');
  const mounted = await mountView(
    (React) => React.createElement(Reports, { leaf: { report: 'followups' }, params: new URLSearchParams('to=2025-01-20') }),
    clientDb,
    { windowOpen: () => fakeWin },
  );
  try {
    const sendBtn = find(mounted.host, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Send');
    await mounted.React.act(async () => props(sendBtn).onClick());
    const dialog = find(mounted.host, (n) => props(n)?.role === 'dialog' && props(n)?.['aria-label'] === 'Send Follow-up');
    assert.ok(dialog);
    const wizardSendBtn = find(dialog, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Send');
    await mounted.React.act(async () => props(wizardSendBtn).onClick());

    const trace = search(mounted.getDb(), 'sms.trace').find((t) => t.res_id === p.id);
    assert.equal(trace.date, today(), 'newly queued SMS must use today, not 2025-01-20');
    assert.equal(partnerFollowUp(read(mounted.getDb(), 'res.partner', p.id), 1)?.followup_date, today());
    assert.doesNotMatch(fakeWin.location.href, /at=2025-01-20/);
  } finally {
    await mounted.done();
  }
});

test('Finding 7: unpostponeFollowUp skips non-postponed partners and preserves automatic next-level schedules', () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.followup.level': [], 'account.move': [] } };
  db = create(db, 'account.followup.level', { display_delay: 5, reminder_timing: 'after', send_email: true }).db;
  db = create(db, 'account.followup.level', { display_delay: 25, reminder_timing: 'after', send_email: true }).db;

  const p = create(db, 'res.partner', { name: 'Scheduled Next Customer', email: 'sched@example.test', customer_rank: 1 });
  const due = addDays(today(), -10); // 10 days overdue -> hits 5-day level, schedules 25-day level for today+15
  db = makeOverdueInvoice(p.db, { partnerId: p.id, dueDate: due, amount: 200 }).db;
  db = logManualFollowUp(db, p.id, today(), { companyId: 1, channel: 'email' });

  const scheduledDate = partnerFollowUp(read(db, 'res.partner', p.id), 1)?.followup_next_action_date;
  assert.ok(scheduledDate && scheduledDate > today(), 'next-level reminder date is scheduled');
  assert.equal(isPartnerFollowUpPostponed(db, read(db, 'res.partner', p.id), 1), false, 'automatic schedule is not a manual postponement');

  const msgCountBefore = messagesOf(db, 'res.partner', p.id).length;
  const afterUnpostpone = unpostponeFollowUp(db, [p.id], { companyId: 1, at: today() });
  assert.equal(partnerFollowUp(read(afterUnpostpone, 'res.partner', p.id), 1)?.followup_next_action_date, scheduledDate);
  assert.equal(messagesOf(afterUnpostpone, 'res.partner', p.id).length, msgCountBefore);

  // Customers list action Unpostpone also preserves automatic schedule
  const customersLeaf = findLeaf(apps.find((a) => a.id === 'accounting'), 'customers');
  const listUnpostpone = customersLeaf.listActions.find((a) => a.label === 'Unpostpone');
  const afterList = listUnpostpone.run(db, [p.id]).db;
  assert.equal(partnerFollowUp(read(afterList, 'res.partner', p.id), 1)?.followup_next_action_date, scheduledDate);

  // Manual postponement IS cleared by unpostponeFollowUp
  const manualDate = addDays(today(), 30);
  const postponed = postponeFollowUp(db, [p.id], manualDate, { companyId: 1 });
  assert.equal(isPartnerFollowUpPostponed(postponed, read(postponed, 'res.partner', p.id), 1), true);
  const cleared = unpostponeFollowUp(postponed, [p.id], { companyId: 1, at: today() });
  assert.equal(partnerFollowUp(read(cleared, 'res.partner', p.id), 1)?.followup_next_action_date, null);
  assert.equal(isPartnerFollowUpPostponed(cleared, read(cleared, 'res.partner', p.id), 1), false);
});

test('Finding 8: FollowUpWizard runs email/whatsapp before SMS and skips already-committed channels on retry', async () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.followup.level': [], 'account.move': [] } };
  const lvl = create(db, 'account.followup.level', {
    display_delay: 5,
    reminder_timing: 'after',
    send_email: true,
    send_sms: true,
    print_letter: false,
    message: 'Retry test.',
    sms_message: 'Retry SMS.',
  });
  const partner = create(lvl.db, 'res.partner', {
    name: 'Retry Customer',
    email: 'retry@example.test',
    phone: '+201001112233',
    customer_rank: 1,
  });
  db = makeOverdueInvoice(partner.db, { partnerId: partner.id, dueDate: addDays(today(), -15), amount: 250 }).db;

  let serverDb = db;
  let mailCalls = 0;
  let waCalls = 0;
  let failWa = true;
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
    if (path === '/api/mail/followup') {
      mailCalls++;
      const out = await sendFollowUp({ host: '127.0.0.1', port: 25, from: 'a@b.c' }, serverDb, { name: 'Admin', isAdmin: true }, JSON.parse(init.body), async () => {});
      serverDb = out.db;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/integrations/whatsapp') {
      waCalls++;
      if (failWa) return new Response(JSON.stringify({ error: 'WhatsApp gateway down' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/diff') {
      serverDb = applyDiff(serverDb, JSON.parse(init.body), { isAdmin: true });
      return new Response(JSON.stringify(serverDb), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  let closed = false;
  const { FollowUpWizard } = await import('./views/FollowUpLetter.jsx');
  const mounted = await mountView(
    (React) => React.createElement(FollowUpWizard, { partnerId: partner.id, companyId: 1, onClose: () => { closed = true; } }),
    db,
    { fetchImpl: serverFetch },
  );
  try {
    const checks = allFind(mounted.host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox');
    // Email and SMS are checked; check WhatsApp too
    await mounted.React.act(async () => {
      props(checks[4]).onChange({ target: { checked: true } });
    });

    // Attempt 1: Email succeeds, WhatsApp fails -> SMS must NOT be queued yet!
    const sendBtn = find(mounted.host, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Send');
    await mounted.React.act(async () => props(sendBtn).onClick());
    assert.equal(closed, false);
    assert.equal(mailCalls, 1);
    assert.equal(waCalls, 1);
    assert.equal(search(mounted.getDb(), 'sms.trace').length, 0, 'SMS not queued when WhatsApp failed');
    const errText = textOf(find(mounted.host, (n) => props(n)?.role === 'alert'));
    assert.match(errText, /Succeeded: Email\. Error: WhatsApp gateway down/);

    // Attempt 2 (retry): Email must be skipped (mailCalls stays 1), WhatsApp and SMS succeed once
    failWa = false;
    await mounted.React.act(async () => props(sendBtn).onClick());
    assert.equal(closed, true, `wizard should close; alert=${textOf(find(mounted.host, (n) => props(n)?.role === 'alert'))}`);
    assert.equal(mailCalls, 1, 'already-committed Email is skipped on retry');
    assert.equal(waCalls, 2);
    assert.equal(search(mounted.getDb(), 'sms.trace').length, 1, 'SMS queued exactly once on retry');
  } finally {
    await mounted.done();
  }

  // 8b. When SMS succeeds and subsequent Print commit fails, retry skips SMS and does not double-text
  let diffCount = 0;
  let smsPrintClosed = false;
  let smsServerDb = db;
  const fakeWin = { location: { href: '' }, close() {} };
  const smsRetryFetch = async (url, init) => {
    const path = String(url);
    if (path === '/api/session') {
      return new Response(JSON.stringify({ name: 'Admin', isAdmin: true, integrations: {} }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (path === '/api/db') {
      return new Response(JSON.stringify(smsServerDb), { status: 200, headers: { 'Content-Type': 'application/json', etag: '"e2"' } });
    }
    if (path === '/api/diff') {
      diffCount++;
      if (diffCount === 2) {
        return new Response(JSON.stringify({ error: 'Temporary save error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
      smsServerDb = applyDiff(smsServerDb, JSON.parse(init.body), { isAdmin: true });
      return new Response(JSON.stringify(smsServerDb), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const mounted2 = await mountView(
    (React) => React.createElement(FollowUpWizard, { partnerId: partner.id, companyId: 1, onClose: () => { smsPrintClosed = true; } }),
    db,
    { fetchImpl: smsRetryFetch, windowOpen: () => fakeWin },
  );
  try {
    const checks = allFind(mounted2.host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox');
    // Uncheck Email, check Print (SMS is already checked)
    await mounted2.React.act(async () => {
      props(checks[0]).onChange({ target: { checked: false } });
      props(checks[1]).onChange({ target: { checked: true } });
    });
    const sendBtn = find(mounted2.host, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Send');
    await mounted2.React.act(async () => props(sendBtn).onClick());
    assert.equal(smsPrintClosed, false);
    assert.equal(search(smsServerDb, 'sms.trace').length, 1);
    assert.match(textOf(find(mounted2.host, (n) => props(n)?.role === 'alert')), /Succeeded: SMS\. Error: Temporary save error/);

    // Retry: SMS must NOT be queued a second time
    await mounted2.React.act(async () => props(sendBtn).onClick());
    assert.equal(smsPrintClosed, true);
    assert.equal(search(smsServerDb, 'sms.trace').length, 1, 'SMS not queued twice on Print retry');
  } finally {
    await mounted2.done();
  }
});
