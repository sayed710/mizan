import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

// The same minimal React DOM approach as formview-wizard.test.js, with real
// EventTargets so effect subscriptions and StrictMode cleanup are exercised.
function setupDom() {
  const makeEl = (tag = 'div') => {
    const node = Object.assign(new EventTarget(), {
      nodeType: 1, tagName: tag.toUpperCase(), nodeName: tag.toUpperCase(),
      childNodes: [], style: {}, options: [], ownerDocument: globalThis.document,
      appendChild(child) { this.childNodes.push(child); child.parentNode = this; return child; },
      removeChild(child) { this.childNodes.splice(this.childNodes.indexOf(child), 1); child.parentNode = null; return child; },
      insertBefore(child, before) { this.childNodes.splice(this.childNodes.indexOf(before), 0, child); child.parentNode = this; return child; },
      setAttribute(name, value) { this[name] = String(value); },
      removeAttribute(name) { delete this[name]; },
      contains(child) { return child === this || this.childNodes.some((c) => c.contains?.(child)); },
      closest(selector) {
        let cur = this;
        const targetTag = selector.toUpperCase();
        while (cur && cur.nodeType === 1) {
          if (cur.tagName === targetTag) return cur;
          cur = cur.parentNode;
        }
        return null;
      },
      dispatchEvent(event) {
        let cur = this;
        let canceled = false;
        Object.defineProperty(event, 'target', { value: this, configurable: true });
        while (cur) {
          Object.defineProperty(event, 'currentTarget', { value: cur, configurable: true });
          const ok = EventTarget.prototype.dispatchEvent.call(cur, event);
          if (!ok) canceled = true;
          if (!event.bubbles || event.cancelBubble) break;
          cur = cur.parentNode;
        }
        return !canceled;
      },
      focus() { document.activeElement = this; },
      querySelector(selector) { return find(this, (n) => selector === '[role=menuitem]' ? n.role === 'menuitem' : n['aria-expanded'] != null); },
      querySelectorAll() { return []; },
    });
    Object.defineProperty(node, 'textContent', {
      get() { return this.childNodes.map((c) => c.nodeType === 3 ? c.nodeValue : c.textContent).join(''); },
      set(value) { this.childNodes = value ? [{ nodeType: 3, nodeValue: String(value) }] : []; },
    });
    return node;
  };
  globalThis.window = Object.assign(new EventTarget(), { HTMLIFrameElement: class {}, scrollTo() {} });
  globalThis.document = Object.assign(new EventTarget(), {
    nodeType: 9, nodeName: '#document', visibilityState: 'hidden',
    documentElement: makeEl('html'), createElement: makeEl,
    createElementNS: (namespace, tag) => makeEl(tag),
    createTextNode: (text) => ({ nodeType: 3, nodeValue: text }),
    createComment: () => ({ nodeType: 8 }),
  });
  globalThis.location = { hash: '#/inventory/transfers' };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return makeEl('div');
}

function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.childNodes ?? []) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}

const props = (node) => node[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];


import { seed } from './seed.js';
import { create, write } from './orm.js';
import { postEntry } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { diffDb, applyDiff } from './sync.js';
import { apps, findLeaf } from './models/index.js';
import { sendCustomerStatement } from '../server/mail.js';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture() {
  const base = seed();
  const a = create(base, 'res.partner', { name: 'Alpha Statement', email: 'alpha@example.com' });
  const b = create(a.db, 'res.partner', { name: 'Beta Statement', email: 'beta@example.com' });
  let db = write(b.db, 'res.company', 1, { report_footer: 'Legal footer test' });
  db = postEntry(db, { journal: 'MISC', date: '2026-02-01', ref: 'ALPHA-ONLY', company: 1, lines: [{ account: '121000', partner_id: a.id, debit: 100 }, { account: '400000', credit: 100 }] }).db;
  db = postEntry(db, { journal: 'MISC', date: '2026-02-02', ref: 'BETA-ONLY', company: 1, lines: [{ account: '121000', partner_id: b.id, debit: 200 }, { account: '400000', credit: 200 }] }).db;
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: a.id, invoice_date: '2026-02-01', invoice_date_due: '2026-02-02', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 25, tax: 0 }] });
  db = postMove(invoice.db, invoice.id);
  return { db: applyDiff(base, diffDb(base, db), { author: 'Test', isAdmin: true }), a: a.id, b: b.id };
}

function all(node, predicate) {
  return [ ...(predicate(node) ? [node] : []), ...(node.childNodes ?? []).flatMap((child) => all(child, predicate)) ];
}

async function verifyStatementEndpoint() {
  const recipients = [];
  const smtp = net.createServer((socket) => {
    socket.write('220 ready\r\n');
    let buffer = '';
    let data = false;
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data) { if (line === '.') { data = false; socket.write('250 queued\r\n'); } }
        else if (line.startsWith('EHLO')) socket.write('250 ready\r\n');
        else if (line.startsWith('MAIL')) socket.write('250 ok\r\n');
        else if (line.startsWith('RCPT')) { recipients.push(line); socket.write('250 ok\r\n'); }
        else if (line === 'DATA') { data = true; socket.write('354 go\r\n'); }
        else if (line === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
      }
    });
  });
  await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'mizan-cst1-'));
  const password = 'statement-test-password';
  const child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: '0', MIZAN_DB: join(dir, 'test.sqlite'), MIZAN_ADMIN_PASSWORD: password, MIZAN_SMTP_HOST: '127.0.0.1', MIZAN_SMTP_PORT: String(smtp.address().port), MIZAN_SMTP_FROM: 'erp@example.com', MIZAN_SECURE_COOKIE: '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; const match = /Mizan listening on (http:\/\/localhost:\d+)/.exec(output); if (match) resolve(match[1]); });
      child.on('exit', (code) => reject(new Error(`server exited ${code}: ${output}`)));
    });
    const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' };
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers, body: JSON.stringify({ login: 'admin', password }) });
    assert.equal(login.status, 200);
    headers.Cookie = login.headers.get('set-cookie').split(';')[0];
    const snapshot = await (await fetch(`${origin}/api/db`, { headers })).json();
    const partner = snapshot.records['res.partner'].find((item) => item.email);
    assert.ok(partner);
    const payload = { partnerId: partner.id, companyId: 1, from: '2026-01-01', to: '2026-12-31' };
    const send = (value) => fetch(`${origin}/api/mail/statement`, { method: 'POST', headers, body: JSON.stringify(value) });
    assert.equal((await send(payload)).status, 200);
    assert.ok(recipients.includes(`RCPT TO:<${partner.email}>`));
    const count = recipients.length;
    assert.equal((await send({ ...payload, companyId: 999999 })).status, 502);
    assert.equal(recipients.length, count);
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.send('shutdown'); await exited; }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await new Promise((resolve) => smtp.close(resolve));
  }
}

test('CST-1 selected customers receive separate statements for printing and email', async () => {
  const container = setupDom();
  let printed = 0;
  window.print = () => { printed += 1; };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { Reports } = await import('./views/Reports.jsx');
  await initStore();
  const { db, a, b } = fixture();
  await commit(db);
  const customerLeaf = findLeaf(apps.find((app) => app.id === 'accounting'), 'customers');
  const action = customerLeaf.listActions.find((entry) => entry.label === 'Customer Statement');
  assert.equal(action.requiresSelection, true);
  const url = action.run(db, [a, b]).go;
  const params = new URLSearchParams(url.split('?')[1]);
  params.set('from', '2026-02-01'); params.set('to', '2026-02-28');
  const leaf = findLeaf(apps.find((app) => app.id === 'accounting'), 'customer-statement');
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf, params })));
    assert.ok(container.textContent.includes('ALPHA-ONLY'));
    assert.ok(container.textContent.includes('BETA-ONLY'));
    const print = find(container, (node) => node.tagName === 'BUTTON' && node.textContent === 'Print');
    await React.act(async () => props(print).onClick());
    assert.equal(printed, 1);
    const papers = all(container, (node) => node.tagName === 'ARTICLE');
    assert.equal(papers.length, 2);
    assert.ok(papers.every((paper) => paper.textContent.includes('Legal footer test')));
    assert.ok(papers[0].textContent.includes('Alpha Statement') && papers[0].textContent.includes('ALPHA-ONLY'));
    assert.ok(!papers[0].textContent.includes('BETA-ONLY'));
    assert.ok(papers[1].textContent.includes('Beta Statement') && papers[1].textContent.includes('BETA-ONLY'));
    assert.ok(!papers[1].textContent.includes('ALPHA-ONLY'));
  } finally { await React.act(async () => root.unmount()); }
  const delivered = [];
  for (const partnerId of [a, b]) await sendCustomerStatement({}, db, { partnerId, companyId: 1, from: '2026-02-01', to: '2026-02-28' }, async (_cfg, mail) => delivered.push(mail));
  assert.deepEqual(delivered.map((mail) => mail.to), ['alpha@example.com', 'beta@example.com']);
  assert.ok(delivered[0].text.includes('ALPHA-ONLY') && !delivered[0].text.includes('BETA-ONLY'));
  assert.ok(delivered[1].text.includes('BETA-ONLY') && !delivered[1].text.includes('ALPHA-ONLY'));
  await assert.rejects(sendCustomerStatement({}, db, { partnerId: a, companyId: 999, from: '2026-02-01', to: '2026-02-28' }, async () => assert.fail('must not send')), /company/);
  await verifyStatementEndpoint();
});

test('CST-2 aged receivable and partner ledger actions open the selected statement', async () => {
  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { Reports } = await import('./views/Reports.jsx');
  await initStore();
  const { db, a } = fixture();
  await commit(db);
  const app = apps.find((entry) => entry.id === 'accounting');
  const root = createRoot(container);
  try {
    for (const key of ['partner-ledger', 'aged-receivable']) {
      const leaf = findLeaf(app, key);
      await React.act(async () => root.render(React.createElement(Reports, { leaf, params: new URLSearchParams() })));
      const link = all(container, (node) => node.tagName === 'A' && node.textContent === 'Customer Statement').find((node) => String(node.href).includes(`partners=${a}`));
      assert.ok(link, `${key} exposes Alpha's statement`);
      const params = new URLSearchParams(link.href.split('?')[1]);
      assert.equal(params.get('company'), '1');
      assert.ok(params.has('from') && params.has('to'));
      if (key === 'aged-receivable') assert.equal(params.get('from'), '');
      const statement = findLeaf(app, 'customer-statement');
      await React.act(async () => root.render(React.createElement(Reports, { leaf: statement, params })));
      assert.ok(container.textContent.includes('Alpha Statement'));
      assert.ok(!container.textContent.includes('Beta Statement'));
    }
  } finally { await React.act(async () => root.unmount()); }
});
