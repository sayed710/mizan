import '../src/models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { diffDb } from '../src/sync.js';
import { create, postTracking, read, search, unlink, updateSettings } from '../src/orm.js';
import { models } from '../src/models/index.js';
import { createCompany } from '../src/models/company.js';
import { companyViewDb } from '../src/companyView.js';
import { logManualFollowUp, runFollowUps } from '../src/models/finance.js';
import { seed } from '../src/seed.js';
import { openStorage } from './storage.js';

const PASSWORD = 'audit-admin-pw';

async function startServer(prepare = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mizan-audit-'));
  prepare(join(dir, 'db.sqlite'));
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: '0', MIZAN_DB: join(dir, 'db.sqlite'), MIZAN_ADMIN_PASSWORD: PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const url = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (b) => { out += b; const m = /Mizan listening on (http:\/\/localhost:\d+)/.exec(out); if (m) resolve(m[1]); });
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
  // Wait for exit before removing the SQLite folder, including on Windows.
  return { url, stop: async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.send('shutdown'); await exited; }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } };
}

const client = (url) => {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(url + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-requested-with': 'mizan', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    cookie = res.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    return { status: res.status, body: await res.json() };
  };
};

test('upgraded legacy audit recovers trustworthy ownership and hides unknown deleted history from restricted admins', async () => {
  const { url, stop } = await startServer((path) => {
    const sql = new DatabaseSync(path);
    const base = seed();
    const branch = createCompany(base, { name: 'Legacy branch', currency_id: base.records['res.company'][0].currency_id });
    const live = create(branch.db, 'crm.lead', { name: 'Live legacy branch', company_id: branch.id });
    openStorage(sql).save(null, live.db);
    sql.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, model TEXT NOT NULL, res_id INTEGER NOT NULL, action TEXT NOT NULL, changes TEXT NOT NULL)');
    const add = sql.prepare('INSERT INTO audit_log (at, actor, model, res_id, action, changes) VALUES (?, ?, ?, ?, ?, ?)');
    const row = (id, action, changes) => add.run('2025-01-01T00:00:00Z', 'legacy', 'crm.lead', id, action, JSON.stringify(changes));
    row(9001, 'create', { company_id: [null, branch.id], name: [null, 'Recoverable foreign'] });
    row(9001, 'delete', { name: ['Recoverable foreign', null] });
    row(9002, 'delete', { name: ['Unknown foreign secret', null] });
    row(9003, 'create', { company_id: [null, 1], name: [null, 'Recoverable own'] });
    row(9003, 'delete', { name: ['Recoverable own', null] });
    row(9004, 'create', { company_id: [null, 1], name: [null, 'Ambiguous old history'] });
    row(9004, 'write', { company_id: [1, branch.id] });
    row(9004, 'delete', { name: ['Ambiguous old history', null] });
    row(live.id, 'write', { name: ['Previous name', 'Live legacy branch'] });
    sql.close();
  });
  try {
    const admin = client(url);
    assert.equal((await admin('POST', '/api/login', { login: 'admin', password: PASSWORD })).status, 200);
    assert.equal((await admin('POST', '/api/users', { login: 'legacy-restricted', password: 'legacy-password', isAdmin: true, companies: '1' })).status, 201);
    const restricted = client(url);
    assert.equal((await restricted('POST', '/api/login', { login: 'legacy-restricted', password: 'legacy-password' })).status, 200);
    const all = (await admin('GET', '/api/audit?model=crm.lead&limit=1000')).body;
    const limited = (await restricted('GET', '/api/audit?model=crm.lead&limit=1000')).body;
    assert.ok(all.some((row) => row.res_id === 9001 && row.action === 'delete' && row.company_id === 2));
    assert.ok(all.some((row) => row.res_id === 9002 && row.company_id === null));
    assert.ok(all.filter((row) => row.res_id === 9004).every((row) => row.company_id === null));
    assert.ok(all.some((row) => row.changes.name?.[1] === 'Live legacy branch' && row.company_id === 2));
    assert.ok(limited.some((row) => row.res_id === 9003 && row.action === 'delete' && row.company_id === 1));
    assert.ok(limited.every((row) => ![9001, 9002, 9004].includes(row.res_id)));
    assert.ok(!JSON.stringify(limited).includes('Live legacy branch'));
  } finally { await stop(); }
});

test('company-owned partner reminders stay private in local views, server snapshots and audit', async () => {
  const { url, stop } = await startServer();
  try {
    const admin = client(url);
    await admin('POST', '/api/login', { login: 'admin', password: PASSWORD });
    const db = (await admin('GET', '/api/db')).body;
    const branch = createCompany(db, { name: 'Reminder branch', currency_id: db.records['res.company'][0].currency_id });
    const partner = db.records['res.partner'][0];
    const invoice = create(branch.db, 'account.move', { move_type: 'out_invoice', partner_id: partner.id, company_id: branch.id, invoice_date: '2020-01-01', invoice_date_due: '2020-01-02', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 123, tax: 0 }] });
    const posted = models['account.move'].form.buttons.find((b) => b.label === 'Confirm').run(invoice.db, read(invoice.db, 'account.move', invoice.id)).db;
    let saved = await admin('POST', '/api/diff', diffDb(db, posted));
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const base = saved.body;
    const invoiceName = read(base, 'account.move', invoice.id).name;
    const scoped = companyViewDb({ ...base, settings: { ...base.settings, current_company_id: branch.id, allowed_company_ids: [branch.id] } });
    const next = logManualFollowUp(base, partner.id, '2026-01-01', { scope: scoped });
    const note = next.messages.find((m) => m.body.includes(invoiceName) && m.body.includes('Payment reminder'));
    assert.equal(note.company_id, branch.id);
    assert.ok(!companyViewDb({ ...next, settings: { ...next.settings, allowed_company_ids: [1] } }).messages.some((m) => m.id === note.id));
    saved = await admin('POST', '/api/diff', diffDb(base, next));
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.messages.find((m) => m.id === note.id).company_id, branch.id);
    assert.equal((await admin('POST', '/api/users', { login: 'main-reminders', password: 'password-main', isAdmin: true, companies: '1' })).status, 201);
    assert.equal((await admin('POST', '/api/users', { login: 'branch-reminders', password: 'password-branch', isAdmin: true, companies: String(branch.id) })).status, 201);
    const main = client(url); const other = client(url);
    await main('POST', '/api/login', { login: 'main-reminders', password: 'password-main' });
    await other('POST', '/api/login', { login: 'branch-reminders', password: 'password-branch' });
    for (const path of ['/api/db', '/api/audit?model=mail.message']) {
      assert.ok(!JSON.stringify((await main('GET', path)).body).includes(invoiceName));
      assert.ok(JSON.stringify((await other('GET', path)).body).includes(invoiceName));
    }
    const scheduled = runFollowUps(base, '2026-01-01');
    const automatic = scheduled.messages.find((m) => m.body.includes(invoiceName) && m.body.includes('overdue'));
    assert.equal(automatic?.company_id, branch.id);
  } finally { await stop(); }
});

test('selected-company audit page finds older entries behind 501 foreign entries', async () => {
  const { url, stop } = await startServer();
  try {
    const admin = client(url);
    await admin('POST', '/api/login', { login: 'admin', password: PASSWORD });
    const db = (await admin('GET', '/api/db')).body;
    const branch = createCompany(db, { name: 'Branch', currency_id: db.records['res.company'][0].currency_id });
    const own = create(branch.db, 'account.move', { move_type: 'entry', company_id: 1, ref: 'Older visible entry' });
    let saved = await admin('POST', '/api/diff', diffDb(db, own.db));
    assert.equal(saved.status, 200, JSON.stringify(saved.body.error));
    let next = saved.body;
    for (let i = 0; i < 501; i++) next = create(next, 'account.move', { move_type: 'entry', company_id: branch.id, ref: `Foreign ${i}` }).db;
    saved = await admin('POST', '/api/diff', diffDb(saved.body, next));
    assert.equal(saved.status, 200, JSON.stringify(saved.body.error));
    const page = await admin('GET', '/api/audit?model=account.move&limit=500&selected=1');
    assert.equal(page.status, 200);
    assert.ok(page.body.some((row) => row.res_id === own.id && row.changes.ref?.[1] === 'Older visible entry'));
    assert.ok(page.body.every((row) => row.company_id === 1));
    const switched = { ...saved.body, settings: { ...saved.body.settings, current_company_id: branch.id, allowed_company_ids: [branch.id] } };
    assert.equal((await admin('POST', '/api/diff', diffDb(saved.body, switched))).status, 200);
    const branchPage = await admin('GET', '/api/audit?model=account.move&limit=500&selected=1');
    assert.equal(branchPage.body.length, 500);
    assert.ok(branchPage.body.every((row) => row.company_id === branch.id));
    const nextPage = await admin('GET', `/api/audit?model=account.move&limit=500&selected=1&before=${branchPage.body.at(-1).id}`);
    assert.equal(nextPage.body.length, 1);
    assert.equal(nextPage.body[0].company_id, branch.id);
  } finally { await stop(); }
});

test('company-restricted administrator receives only authorized audit history, including deleted records', async () => {
  const { url, stop } = await startServer();
  try {
    const admin = client(url);
    await admin('POST', '/api/login', { login: 'admin', password: PASSWORD });
    const db = (await admin('GET', '/api/db')).body;
    const branch = createCompany(db, { name: 'Branch', currency_id: db.records['res.company'][0].currency_id });
    const own = create(branch.db, 'crm.lead', { name: 'Own history', company_id: 1 });
    const foreign = create(own.db, 'crm.lead', { name: 'Foreign secret', company_id: branch.id });
    const saved = await admin('POST', '/api/diff', diffDb(db, foreign.db));
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const deleted = unlink(saved.body, 'crm.lead', [own.id, foreign.id]);
    assert.equal((await admin('POST', '/api/diff', diffDb(saved.body, deleted))).status, 200);
    assert.equal((await admin('POST', '/api/users', { login: 'restricted', password: 'restricted-password', isAdmin: true, companies: '1' })).status, 201);
    const restricted = client(url);
    assert.equal((await restricted('POST', '/api/login', { login: 'restricted', password: 'restricted-password' })).status, 200);
    const result = await restricted('GET', '/api/audit?model=crm.lead&limit=1000');
    assert.equal(result.status, 200);
    assert.ok(result.body.some((row) => row.res_id === own.id && row.action === 'delete'));
    assert.ok(result.body.every((row) => row.res_id !== foreign.id));
    assert.ok(!JSON.stringify(result.body).includes('Foreign secret'));
  } finally { await stop(); }
});

test('server stamps audit and chatter ownership from records and retains deletion history', async () => {
  const { url, stop } = await startServer();
  try {
    const admin = client(url);
    await admin('POST', '/api/login', { login: 'admin', password: PASSWORD });
    const db = (await admin('GET', '/api/db')).body;
    const created = create(db, 'account.move', { move_type: 'entry', company_id: 1 });
    let next = postTracking(created.db, 'account.move', created.id, 'History before deletion');
    next = { ...next, messages: next.messages.map((m) => m.body === 'History before deletion' ? { ...m, company_id: 2 } : m) };
    const saved = await admin('POST', '/api/diff', diffDb(db, next));
    assert.equal(saved.status, 200);
    assert.equal(saved.body.messages.find((m) => m.body === 'History before deletion').company_id, 1);
    const deleted = unlink(saved.body, 'account.move', [created.id]);
    assert.equal((await admin('POST', '/api/diff', diffDb(saved.body, deleted))).status, 200);
    const rows = (await admin('GET', `/api/audit?model=account.move&id=${created.id}`)).body;
    assert.ok(rows.some((row) => row.action === 'delete' && row.company_id === 1));
    assert.ok(rows.some((row) => row.action === 'create' && row.company_id === 1));
  } finally { await stop(); }
});

test('an edit through /api/diff is logged with the login, server time and old and new values; only admins read it', async () => {
  const { url, stop } = await startServer();
  try {
    const admin = client(url);
    assert.equal((await admin('POST', '/api/login', { login: 'admin', password: PASSWORD })).status, 200);
    const { body: db } = await admin('GET', '/api/db');
    const partner = db.records['res.partner'][0];
    const next = { ...db, records: { ...db.records, 'res.partner': db.records['res.partner'].map((p) => (p.id === partner.id ? { ...p, phone: '+20 100 000 0000' } : p)) } };
    const before = new Date().toISOString();
    assert.equal((await admin('POST', '/api/diff', diffDb(db, next))).status, 200);

    const { status, body: log } = await admin('GET', `/api/audit?model=res.partner&id=${partner.id}`);
    assert.equal(status, 200);
    assert.equal(log.length, 1);
    assert.equal(log[0].actor, 'admin');
    assert.equal(log[0].action, 'write');
    assert.deepEqual(log[0].changes, { phone: [partner.phone ?? null, '+20 100 000 0000'] });
    assert.ok(log[0].at >= before);
    assert.equal((await admin('GET', '/api/audit')).body.at(-1).action, 'seed');

    assert.equal((await admin('POST', '/api/users', { login: 'clerk', name: 'Clerk', password: 'clerk-password' })).status, 201);
    const clerk = client(url);
    assert.equal((await clerk('POST', '/api/login', { login: 'clerk', password: 'clerk-password' })).status, 200);
    assert.equal((await clerk('GET', '/api/audit')).status, 403);
  } finally {
    await stop();
  }
});

test('global locks block forged entries and tax submission until unlocked', async () => {
  const { url, stop } = await startServer();
  try {
    const admin = client(url);
    assert.equal((await admin('POST', '/api/login', { login: 'admin', password: PASSWORD })).status, 200);
    let db = (await admin('GET', '/api/db')).body;
    const type = search(db, 'account.return.type')[0];
    const ret = create(db, 'account.return', { name: 'HTTP VAT', type_id: type.id, company_id: 1, date_from: '2020-03-01', date_to: '2020-03-31' });
    const review = models['account.return'].form.buttons.find((b) => b.label === 'Review');
    const reviewed = review.run(ret.db, read(ret.db, 'account.return', ret.id)).db;
    const setup = updateSettings(reviewed, { lock_date: '2020-03-31' });
    const setupResponse = await admin('POST', '/api/diff', diffDb(db, setup));
    assert.equal(setupResponse.status, 200, JSON.stringify(setupResponse.body));
    db = setupResponse.body;
    const bank = search(db, 'account.account').find((a) => a.code === '101401');
    const payable = search(db, 'account.account').find((a) => a.code === '211000');
    const draft = create(db, 'account.move', { name: 'MISC/2020/99999', move_type: 'entry', date: '2020-03-31', invoice_date: '2020-03-31',
      ref: 'Tax Closing: HTTP VAT', line_ids: [{ account_id: bank.id, debit: 10, credit: 0 }, { account_id: payable.id, debit: 0, credit: 10 }] });
    const forged = { ...draft.db, records: { ...draft.db.records, 'account.move': draft.db.records['account.move'].map((m) => m.id === draft.id ? { ...m, state: 'posted' } : m) } };
    const rejected = await admin('POST', '/api/diff', diffDb(db, forged));
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /locked/i);
    const blocked = await admin('POST', '/api/button', { model: 'account.return', id: ret.id, label: 'Submit' });
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /locked/i);
    const unlocked = await admin('POST', '/api/diff', diffDb(db, updateSettings(db, { lock_date: null })));
    assert.equal(unlocked.status, 200);
    const submitted = await admin('POST', '/api/button', { model: 'account.return', id: ret.id, label: 'Submit' });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    const saved = (await admin('GET', '/api/db')).body;
    const result = read(saved, 'account.return', ret.id);
    assert.equal(result.state, 'submitted');
    assert.equal(read(saved, 'account.move', result.closing_move_ids[0]).state, 'posted');
    assert.equal(saved.settings.lock_date, null);
    assert.equal(saved.settings.tax_lock_date, '2020-03-31');
  } finally {
    await stop();
  }
});

test('chatter messages get the server time, not the one the client sent', async () => {
  const { url, stop } = await startServer();
  try {
    const admin = client(url);
    await admin('POST', '/api/login', { login: 'admin', password: PASSWORD });
    const { body: db } = await admin('GET', '/api/db');
    const partner = db.records['res.partner'][0];
    const msg = { id: 'm-backdated', model: 'res.partner', res_id: partner.id, body: 'hello', kind: 'note', author: 'Someone else', date: '2001-01-01T00:00:00.000Z' };
    const out = await admin('POST', '/api/diff', diffDb(db, { ...db, messages: [...db.messages, msg] }));
    const saved = out.body.messages.find((m) => m.id === 'm-backdated');
    assert.equal(saved.author, 'Admin');
    assert.ok(saved.date > '2026-01-01');
  } finally {
    await stop();
  }
});

test('account administration, settings edits and notes are logged without secrets; the log pages back with `before`', async () => {
  const { url, stop } = await startServer();
  try {
    const admin = client(url);
    await admin('POST', '/api/login', { login: 'admin', password: PASSWORD });
    await admin('POST', '/api/users', { login: 'clerk', name: 'Clerk', password: 'clerk-password-secret' });
    const key = (await admin('POST', '/api/keys', { name: 'ci' })).body.key;
    const { body: db } = await admin('GET', '/api/db');
    const partner = db.records['res.partner'][0];
    const edited = { ...db, settings: { ...db.settings, lock_date: '2026-01-31' }, messages: [...db.messages, { id: 'm-audit', model: 'res.partner', res_id: partner.id, body: 'call back', kind: 'note' }] };
    assert.equal((await admin('POST', '/api/diff', diffDb(db, edited))).status, 200);
    await admin('DELETE', `/api/keys?created=${(await admin('GET', '/api/keys')).body[0].created}`);

    const log = (await admin('GET', '/api/audit?limit=1000')).body;
    const has = (model, action) => log.some((e) => e.model === model && e.action === action);
    assert.ok(has('auth.user', 'create') && has('auth.api_key', 'create') && has('auth.api_key', 'delete'));
    assert.ok(has('settings', 'write') && has('mail.message', 'create'));
    assert.ok(!JSON.stringify(log).includes('clerk-password-secret') && !JSON.stringify(log).includes(key));
    assert.equal(log.find((e) => e.model === 'auth.user' && e.changes.login?.[1] === 'clerk').actor, 'admin');

    const first = (await admin('GET', '/api/audit?limit=2')).body;
    const next = (await admin('GET', `/api/audit?limit=2&before=${first.at(-1).id}`)).body;
    assert.ok(next.length && next.every((e) => e.id < first.at(-1).id));
    assert.equal((await admin('GET', '/api/audit?before=abc')).status, 400);
  } finally {
    await stop();
  }
});

test('user creation is discoverable by its generated resource id', async () => {
  const { url, stop } = await startServer();
  try {
    const admin = client(url);
    await admin('POST', '/api/login', { login: 'admin', password: PASSWORD });
    await admin('POST', '/api/users', { login: 'new-clerk', password: 'clerk-password' });
    const users = (await admin('GET', '/api/users')).body;
    const id = users.find((u) => u.login === 'new-clerk').id;
    const entries = (await admin('GET', `/api/audit?model=auth.user&id=${id}`)).body;
    assert.equal(entries.filter((e) => e.action === 'create').length, 1);
  } finally { await stop(); }
});

test('deleting a nonexistent API key leaves audit history unchanged', async () => {
  const { url, stop } = await startServer();
  try {
    const admin = client(url);
    await admin('POST', '/api/login', { login: 'admin', password: PASSWORD });
    const before = (await admin('GET', '/api/audit')).body;
    assert.equal((await admin('DELETE', '/api/keys?created=123')).status, 200);
    assert.deepEqual((await admin('GET', '/api/audit')).body, before);
  } finally { await stop(); }
});

test('malformed audit record filters are rejected', async () => {
  const { url, stop } = await startServer();
  try {
    const admin = client(url);
    await admin('POST', '/api/login', { login: 'admin', password: PASSWORD });
    for (const id of ['abc', '', '-1', '1.5']) assert.equal((await admin('GET', `/api/audit?id=${id}`)).status, 400, id);
  } finally { await stop(); }
});

test('anonymous blog views change the counter without adding audit rows', async () => {
  const { url, stop } = await startServer();
  try {
    const admin = client(url);
    await admin('POST', '/api/login', { login: 'admin', password: PASSWORD });
    const { body: db } = await admin('GET', '/api/db');
    const blog = { id: 901, name: 'News' };
    const made = { id: 900, name: 'Hello', blog_id: 901, is_published: true, visits: 0, content: 'Body', published_date: '2026-01-01' };
    const saved = await admin('POST', '/api/diff', diffDb(db, { ...db, records: { ...db.records, 'blog.blog': [blog], 'blog.post': [made] } }));
    assert.equal(saved.status, 200, JSON.stringify(saved.body.error));
    const post = saved.body.records['blog.post'].find((p) => p.id === (saved.body.remapped?.['blog.post']?.[made.id] ?? made.id));
    const before = (await admin('GET', '/api/audit?limit=1000')).body.length;
    const anonymous = client(url);
    for (let i = 0; i < 3; i++) assert.equal((await anonymous('GET', `/api/public/blog/${post.id}`)).status, 200);
    assert.equal((await admin('GET', '/api/audit?limit=1000')).body.length, before);
    assert.equal((await admin('GET', '/api/db')).body.records['blog.post'].find((p) => p.id === post.id).visits, (post.visits ?? 0) + 1); // one visitor per hour
  } finally {
    await stop();
  }
});

test('company-restricted user receives only their own secure chain heads and cannot destroy foreign heads on write', async () => {
  let branchId;
  const journalId = 999;
  const { url, stop } = await startServer((path) => {
    const sql = new DatabaseSync(path);
    const base = seed();
    const branch = createCompany(base, { name: 'Chain Branch', currency_id: base.records['res.company'][0].currency_id });
    branchId = branch.id;
    const heads = [
      { company_id: 1, count: 5, last_sequence: 5, last_hash: 'hash-comp-1', last_move_id: 101, last_move_name: 'SEC/1/0005' },
      { company_id: branch.id, count: 2, last_sequence: 2, last_hash: 'hash-comp-2', last_move_id: 202, last_move_name: 'SEC/2/0002' },
    ];
    const journal = {
      id: journalId,
      name: 'Multi Company Secure Journal',
      code: 'MCS',
      type: 'general',
      restrict_mode_hash_table: true,
      secure_chain_heads: heads,
    };
    const db = {
      ...branch.db,
      records: {
        ...branch.db.records,
        'account.journal': [...branch.db.records['account.journal'], journal],
      },
    };
    openStorage(sql).save(null, db);
    sql.close();
  });
  try {
    const admin = client(url);
    await admin('POST', '/api/login', { login: 'admin', password: PASSWORD });

    // Create a restricted user limited to branch only
    assert.equal((await admin('POST', '/api/users', { login: 'chain-restricted', password: 'chain-password', isAdmin: true, companies: String(branchId) })).status, 201);
    const restricted = client(url);
    await restricted('POST', '/api/login', { login: 'chain-restricted', password: 'chain-password' });

    // 1. Snapshot for restricted user via /api/db has heads filtered to allowed companies
    const { body: restDb } = await restricted('GET', '/api/db');
    const restJournal = restDb.records['account.journal'].find((j) => j.id === journalId);
    assert.ok(restJournal, 'restricted user can read shared journal');
    assert.equal(restJournal.secure_chain_heads?.length, 1);
    assert.equal(restJournal.secure_chain_heads[0].company_id, branchId);
    assert.equal(restJournal.secure_chain_heads[0].last_hash, 'hash-comp-2');
    assert.ok(!JSON.stringify(restJournal.secure_chain_heads).includes('hash-comp-1'));

    // 2. Restricted user writes an update to the journal (e.g. changing journal name)
    const updatedJournal = { ...restJournal, name: 'Renamed MCS Journal' };
    const diff = diffDb(restDb, { ...restDb, records: { ...restDb.records, 'account.journal': restDb.records['account.journal'].map((j) => (j.id === journalId ? updatedJournal : j)) } });
    const writeRes = await restricted('POST', '/api/diff', diff);
    assert.equal(writeRes.status, 200, JSON.stringify(writeRes.body.error));

    // 3. Admin sees the update and BOTH chain heads preserved
    const { body: adminDb } = await admin('GET', '/api/db');
    const adminJournal = adminDb.records['account.journal'].find((j) => j.id === journalId);
    assert.equal(adminJournal.name, 'Renamed MCS Journal');
    assert.equal(adminJournal.secure_chain_heads?.length, 2);
    assert.ok(adminJournal.secure_chain_heads.some((h) => h.company_id === 1 && h.last_hash === 'hash-comp-1'));
    assert.ok(adminJournal.secure_chain_heads.some((h) => h.company_id === branchId && h.last_hash === 'hash-comp-2'));

    // 4. Restricted user attempting to write a foreign secure chain head is rejected
    const foreignHeadDiff = {
      upserts: { 'account.journal': [{ id: journalId, secure_chain_heads: [{ company_id: 1, count: 99, last_sequence: 99, last_hash: 'forged', last_move_id: 101, last_move_name: 'SEC/1/0099' }] }] },
      deletes: {},
    };
    const badHeadRes = await restricted('POST', '/api/diff', foreignHeadDiff);
    assert.equal(badHeadRes.status, 400);
    assert.match(badHeadRes.body.error, /No access to this company/);
  } finally {
    await stop();
  }
});

test('company-restricted user receives only their own partner followup_lines and cannot write foreign lines', async () => {
  let branchId;
  const partnerId = 988;
  const { url, stop } = await startServer((path) => {
    const sql = new DatabaseSync(path);
    const base = seed();
    const branch = createCompany(base, { name: 'Followup Branch', currency_id: base.records['res.company'][0].currency_id });
    branchId = branch.id;
    const lines = [
      { company_id: 1, followup_level_delay: 15, followup_date: '2026-01-01' },
      { company_id: branch.id, followup_level_delay: 30, followup_date: '2026-01-02' },
    ];
    const partner = {
      id: partnerId,
      name: 'Shared Multi-Company Customer',
      followup_lines: lines,
    };
    const invoices = [
      { id: 9881, name: 'INV-1', partner_id: partnerId, company_id: 1, move_type: 'out_invoice', state: 'posted', invoice_date_due: '2025-01-01', invoice_line_ids: [{ qty: 1, price_unit: 100 }] },
      { id: 9882, name: 'INV-2', partner_id: partnerId, company_id: branch.id, move_type: 'out_invoice', state: 'posted', invoice_date_due: '2025-01-01', invoice_line_ids: [{ qty: 1, price_unit: 200 }] },
    ];
    const db = {
      ...branch.db,
      records: {
        ...branch.db.records,
        'res.partner': [...branch.db.records['res.partner'], partner],
        'account.move': [...(branch.db.records['account.move'] ?? []), ...invoices],
      },
    };
    openStorage(sql).save(null, db);
    sql.close();
  });
  try {
    const admin = client(url);
    await admin('POST', '/api/login', { login: 'admin', password: PASSWORD });

    assert.equal((await admin('POST', '/api/users', { login: 'followup-restricted', password: 'followup-password', isAdmin: true, companies: String(branchId) })).status, 201);
    const restricted = client(url);
    await restricted('POST', '/api/login', { login: 'followup-restricted', password: 'followup-password' });

    // 1. Snapshot for restricted user via /api/db has followup_lines filtered to allowed company
    const { body: restDb } = await restricted('GET', '/api/db');
    const restPartner = restDb.records['res.partner'].find((p) => p.id === partnerId);
    assert.ok(restPartner, 'restricted user can read shared partner');
    assert.equal(restPartner.followup_lines?.length, 1);
    assert.equal(restPartner.followup_lines[0].company_id, branchId);
    assert.equal(restPartner.followup_lines[0].followup_level_delay, 30);
    assert.ok(!JSON.stringify(restPartner.followup_lines).includes('15'));

    // 2. Restricted user writes an update to partner (e.g. phone)
    const updatedPartner = { ...restPartner, phone: '+1234567890' };
    const diff = diffDb(restDb, { ...restDb, records: { ...restDb.records, 'res.partner': restDb.records['res.partner'].map((p) => (p.id === partnerId ? updatedPartner : p)) } });
    const writeRes = await restricted('POST', '/api/diff', diff);
    assert.equal(writeRes.status, 200, JSON.stringify(writeRes.body.error));

    // 3. Admin sees phone updated and BOTH followup_lines preserved
    const { body: adminDb } = await admin('GET', '/api/db');
    const adminPartner = adminDb.records['res.partner'].find((p) => p.id === partnerId);
    assert.equal(adminPartner.phone, '+1234567890');
    assert.equal(adminPartner.followup_lines?.length, 2);
    assert.ok(adminPartner.followup_lines.some((l) => l.company_id === 1));
    assert.ok(adminPartner.followup_lines.some((l) => l.company_id === branchId && l.followup_level_delay === 30));

    // 4. Restricted user attempting to write a foreign followup line is rejected
    const foreignLineDiff = {
      upserts: { 'res.partner': [{ id: partnerId, followup_lines: [{ company_id: 1, followup_level_delay: 99 }] }] },
      deletes: {},
    };
    const badLineRes = await restricted('POST', '/api/diff', foreignLineDiff);
    assert.equal(badLineRes.status, 400);
    assert.match(badLineRes.body.error, /No access to this company/);
  } finally {
    await stop();
  }
});

test('audit log scopes nested per-company arrays in old and new values for company-restricted admin', async () => {
  let branchId;
  const partnerId = 988;
  const journalId = 999;
  const { url, stop } = await startServer((path) => {
    const sql = new DatabaseSync(path);
    const base = seed();
    const branch = createCompany(base, { name: 'Audit Scope Branch', currency_id: base.records['res.company'][0].currency_id });
    branchId = branch.id;
    const partner = {
      id: partnerId,
      name: 'Shared Partner Audit Scope',
      followup_lines: [
        { company_id: 1, followup_level_delay: 15, followup_date: '2026-01-01' },
        { company_id: branch.id, followup_level_delay: 30, followup_date: '2026-01-02' },
      ],
    };
    const journal = {
      id: journalId,
      name: 'Shared Journal Audit Scope',
      code: 'SAS',
      type: 'general',
      restrict_mode_hash_table: true,
      secure_chain_heads: [
        { company_id: 1, count: 5, last_sequence: 5, last_hash: 'h-1-old', last_move_id: 101, last_move_name: 'SEC/1/0005' },
        { company_id: branch.id, count: 2, last_sequence: 2, last_hash: 'h-branch-old', last_move_id: 202, last_move_name: 'SEC/2/0002' },
      ],
    };
    const db = {
      ...branch.db,
      records: {
        ...branch.db.records,
        'res.partner': [...branch.db.records['res.partner'], partner],
        'account.journal': [...branch.db.records['account.journal'], journal],
      },
    };
    openStorage(sql).save(null, db);

    // Historical audit rows with full entries across both companies, logged as company 1
    sql.exec('CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, model TEXT NOT NULL, res_id INTEGER NOT NULL, action TEXT NOT NULL, changes TEXT NOT NULL, company_id INTEGER)');
    const add = sql.prepare('INSERT INTO audit_log (at, actor, model, res_id, action, changes, company_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    add.run('2026-01-01T00:00:00Z', 'admin', 'res.partner', partnerId, 'write', JSON.stringify({
      followup_lines: [
        [{ company_id: 1, followup_level_delay: 15, followup_date: '2026-01-01' }, { company_id: branch.id, followup_level_delay: 30, followup_date: '2026-01-02' }],
        [{ company_id: 1, followup_level_delay: 30, followup_date: '2026-01-10' }, { company_id: branch.id, followup_level_delay: 45, followup_date: '2026-01-12' }],
      ],
    }), 1);
    add.run('2026-01-01T00:00:00Z', 'admin', 'account.journal', journalId, 'write', JSON.stringify({
      secure_chain_heads: [
        [{ company_id: 1, count: 5, last_hash: 'h-1-old' }, { company_id: branch.id, count: 2, last_hash: 'h-branch-old' }],
        [{ company_id: 1, count: 6, last_hash: 'h-1-new' }, { company_id: branch.id, count: 3, last_hash: 'h-branch-new' }],
      ],
    }), 1);
    sql.close();
  });
  try {
    const admin = client(url);
    await admin('POST', '/api/login', { login: 'admin', password: PASSWORD });

    // Create admin user restricted to company 1
    assert.equal((await admin('POST', '/api/users', { login: 'admin-comp1', password: 'password-comp1', isAdmin: true, companies: '1' })).status, 201);
    const restricted = client(url);
    await restricted('POST', '/api/login', { login: 'admin-comp1', password: 'password-comp1' });

    // 1. Company-1-restricted admin queries audit for shared partner: foreign company entries in followup_lines are filtered
    const pAudit = await restricted('GET', `/api/audit?model=res.partner&id=${partnerId}`);
    assert.equal(pAudit.status, 200);
    assert.ok(pAudit.body.length >= 1);
    for (const entry of pAudit.body) {
      const [oldLines, newLines] = entry.changes.followup_lines;
      assert.ok((oldLines ?? []).every((l) => l.company_id === 1), 'old lines scoped to company 1');
      assert.ok((newLines ?? []).every((l) => l.company_id === 1), 'new lines scoped to company 1');
    }
    const pEntry = pAudit.body.find((e) => e.actor === 'admin');
    assert.ok(pEntry);
    const [oldLines, newLines] = pEntry.changes.followup_lines;
    assert.equal(oldLines.length, 1);
    assert.equal(oldLines[0].company_id, 1);
    assert.equal(oldLines[0].followup_level_delay, 15);
    assert.equal(newLines.length, 1);
    assert.equal(newLines[0].company_id, 1);
    assert.equal(newLines[0].followup_level_delay, 30);

    // 2. Company-1-restricted admin queries audit for shared journal: foreign company entries in secure_chain_heads are filtered
    const jAudit = await restricted('GET', `/api/audit?model=account.journal&id=${journalId}`);
    assert.equal(jAudit.status, 200);
    assert.ok(jAudit.body.length >= 1);
    const jEntry = jAudit.body[0];
    const [oldHeads, newHeads] = jEntry.changes.secure_chain_heads;
    assert.equal(oldHeads.length, 1);
    assert.equal(oldHeads[0].company_id, 1);
    assert.equal(oldHeads[0].last_hash, 'h-1-old');
    assert.equal(newHeads.length, 1);
    assert.equal(newHeads[0].company_id, 1);
    assert.equal(newHeads[0].last_hash, 'h-1-new');
    assert.ok(!JSON.stringify(jEntry.changes).includes('h-branch'));

    // 3. Unrestricted admin queries audit and sees full nested arrays for all companies
    const adminPAudit = await admin('GET', `/api/audit?model=res.partner&id=${partnerId}`);
    assert.equal(adminPAudit.status, 200);
    const adminPEntry = adminPAudit.body[0];
    assert.equal(adminPEntry.changes.followup_lines[0].length, 2);
    assert.ok(adminPEntry.changes.followup_lines[0].some((l) => l.company_id === branchId));

    const adminJAudit = await admin('GET', `/api/audit?model=account.journal&id=${journalId}`);
    assert.equal(adminJAudit.status, 200);
    const adminJEntry = adminJAudit.body[0];
    assert.equal(adminJEntry.changes.secure_chain_heads[0].length, 2);
    assert.ok(adminJEntry.changes.secure_chain_heads[0].some((h) => h.company_id === branchId));

    // New audit rows produced by real writes must be scoped just like historical rows.
    const snapshot = (await admin('GET', '/api/db')).body;
    const changed = await admin('POST', '/api/diff', { upserts: {
      'res.partner': [{ ...snapshot.records['res.partner'].find((p) => p.id === partnerId), followup_lines: [
        { company_id: 1, followup_level_delay: 60 }, { company_id: branchId, followup_level_delay: 90 },
      ] }],
    }, deletes: {} });
    assert.equal(changed.status, 200, JSON.stringify(changed.body.error));
    for (const [model, id, field] of [['res.partner', partnerId, 'followup_lines']]) {
      const restrictedRows = (await restricted('GET', `/api/audit?model=${model}&id=${id}`)).body;
      const fullRows = (await admin('GET', `/api/audit?model=${model}&id=${id}`)).body;
      const live = restrictedRows.find((row) => row.id === fullRows[0].id);
      assert.ok(live, `live ${model} row visible`);
      for (const side of live.changes[field]) assert.deepEqual(side.map((line) => line.company_id), [1]);
      for (const side of fullRows[0].changes[field]) assert.deepEqual(side.map((line) => line.company_id), [1, branchId]);
    }
  } finally {
    await stop();
  }
});
