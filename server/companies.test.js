import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffDb } from '../src/sync.js';
import { create } from '../src/orm.js';
import { createCompany } from '../src/models/company.js';

const PASSWORD = 'company-admin-pw';

async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), 'mizan-companies-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: '0', MIZAN_DB: join(dir, 'db.sqlite'), MIZAN_ADMIN_PASSWORD: PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const url = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (b) => { out += b; const m = /Mizan listening on (http:\/\/localhost:\d+)/.exec(out); if (m) resolve(m[1]); });
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
  return { url, stop: async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.send('shutdown'); await exited; }
    rmSync(dir, { recursive: true, force: true });
  } };
}

const client = (url, auth) => {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(url + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-requested-with': 'mizan', cookie, ...(auth ? { authorization: auth } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    cookie = res.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    return { status: res.status, body: await res.json().catch(() => null) };
  };
};

test('a user limited to one company neither sees nor edits the other, and switches companies on their own', async () => {
  const { url, stop } = await startServer();
  try {
    const admin = client(url);
    await admin('POST', '/api/login', { login: 'admin', password: PASSWORD });
    const { body: db } = await admin('GET', '/api/db');
    const branch = createCompany(db, { name: 'Branch', currency_id: db.records['res.company'][0].currency_id });
    const lead = create(branch.db, 'crm.lead', { name: 'Branch secret', company_id: branch.id });
    assert.equal((await admin('POST', '/api/diff', diffDb(db, lead.db))).status, 200);
    assert.equal((await admin('POST', '/api/users', { login: 'clerk', name: 'Clerk', password: 'clerk-password', companies: '1' })).status, 201);

    const clerk = client(url);
    await clerk('POST', '/api/login', { login: 'clerk', password: 'clerk-password' });
    const { body: seen } = await clerk('GET', '/api/db');
    assert.ok(!seen.records['crm.lead'].some((l) => l.id === lead.id));
    assert.deepEqual(seen.records['res.company'].map((c) => c.id), [1]);
    assert.deepEqual([seen.settings.current_company_id, seen.settings.allowed_company_ids], [1, [1]]);

    // Writing to the hidden record by id is refused, as is selecting the other company.
    const planted = { ...seen, records: { ...seen.records, 'crm.lead': [...seen.records['crm.lead'], { ...lead.db.records['crm.lead'].find((l) => l.id === lead.id), name: 'Overwritten' }] } };
    assert.match((await clerk('POST', '/api/diff', diffDb(seen, planted))).body.error, /No access to this company/);
    const switched = { ...seen, settings: { ...seen.settings, current_company_id: branch.id, allowed_company_ids: [branch.id] } };
    assert.match((await clerk('POST', '/api/diff', diffDb(seen, switched))).body.error, /No access to that company/);

    // The admin's switch is theirs alone.
    const { body: adminDb } = await admin('GET', '/api/db');
    const adminSwitch = { ...adminDb, settings: { ...adminDb.settings, current_company_id: branch.id, allowed_company_ids: [branch.id] } };
    assert.equal((await admin('POST', '/api/diff', diffDb(adminDb, adminSwitch))).body.settings.current_company_id, branch.id);
    assert.equal((await clerk('GET', '/api/db')).body.settings.current_company_id, 1);

    // The REST API applies the same limit.
    const { body: { key } } = await clerk('POST', '/api/keys', { name: 'test' });
    const rest = client(url, `Bearer ${key}`);
    assert.equal((await rest('GET', `/api/v1/crm.lead/${lead.id}`)).status, 404);
    assert.ok(!(await rest('GET', '/api/v1/crm.lead?limit=500')).body.records.some((l) => l.id === lead.id));
  } finally {
    await stop();
  }
});

test('limited users get their own company identity, no group reports, no foreign contacts or portal links, and bad grants are refused', async () => {
  const { url, stop } = await startServer();
  try {
    const admin = client(url);
    await admin('POST', '/api/login', { login: 'admin', password: PASSWORD });
    const { body: db } = await admin('GET', '/api/db');
    const branch = createCompany(db, { name: 'Branch', currency_id: db.records['res.company'][0].currency_id, vat: 'BRANCH-VAT' });
    const order = create(branch.db, 'sale.order', { partner_id: 1, company_id: 1 });
    assert.equal((await admin('POST', '/api/diff', { ...diffDb(db, order.db), settings: { company_vat: 'GROUP-VAT', company_iban: 'GROUP-IBAN' } })).status, 200);

    for (const companies of ['abc', '0', '1,x']) {
      const bad = await admin('POST', '/api/users', { login: `bad${companies.length}`, name: 'Bad', password: 'clerk-password', companies });
      assert.equal(bad.status, 400, companies);
    }
    assert.equal((await admin('POST', '/api/users', { login: 'branchclerk', name: 'B', password: 'clerk-password', companies: String(branch.id) })).status, 201);
    const clerk = client(url);
    await clerk('POST', '/api/login', { login: 'branchclerk', password: 'clerk-password' });
    const { body: seen } = await clerk('GET', '/api/db');
    assert.equal(seen.settings.company_vat, 'BRANCH-VAT');
    assert.ok(!JSON.stringify(seen.settings).includes('GROUP-IBAN') && !JSON.stringify(seen.settings).includes('GROUP-VAT'));
    assert.ok(!seen.records['sale.order']?.some((o) => o.id === order.id));
    const mainContact = db.records['res.company'][0].partner_id;
    assert.ok(!seen.records['res.partner'].some((p) => p.id === mainContact), 'the main company contact is hidden');
    assert.equal((await clerk('GET', `/api/portal-link/sale.order/${order.id}`)).status, 404);
    assert.equal((await admin('GET', `/api/portal-link/sale.order/${order.id}`)).status, 200);

    // REST: a record created without company_id lands in the key owner's company.
    const { body: { key } } = await clerk('POST', '/api/keys', { name: 'rest' });
    const rest = client(url, `Bearer ${key}`);
    const made = await rest('POST', '/api/v1/crm.lead', { name: 'From REST' });
    assert.equal(made.status, 201);
    assert.equal(made.body.company_id, branch.id);
  } finally {
    await stop();
  }
});

test('a rejected change does not keep the company switch that came with it', async () => {
  const { url, stop } = await startServer();
  try {
    const admin = client(url);
    await admin('POST', '/api/login', { login: 'admin', password: PASSWORD });
    const { body: db } = await admin('GET', '/api/db');
    const branch = createCompany(db, { name: 'Branch', currency_id: db.records['res.company'][0].currency_id });
    assert.equal((await admin('POST', '/api/diff', diffDb(db, branch.db))).status, 200);
    assert.equal((await admin('POST', '/api/users', { login: 'both', name: 'Both', password: 'clerk-password', companies: `1,${branch.id}` })).status, 201);
    const user = client(url);
    await user('POST', '/api/login', { login: 'both', password: 'clerk-password' });
    const { body: seen } = await user('GET', '/api/db');
    const bad = { upserts: { 'crm.lead': [{ id: 1, name: 'x', stage_id: 'not-a-stage' }] }, deletes: {}, messages: [], removedMessages: [], settings: { current_company_id: branch.id, allowed_company_ids: [branch.id] } };
    assert.equal((await user('POST', '/api/diff', bad)).status, 400);
    assert.equal((await user('GET', '/api/db')).body.settings.current_company_id, seen.settings.current_company_id);
  } finally {
    await stop();
  }
});
