import '../src/models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffDb } from '../src/sync.js';
import { create, write } from '../src/orm.js';
import { createCompany } from '../src/models/company.js';
import { startServer as spawnTestServer } from './test-server.js';

const PASSWORD = 'company-admin-pw';

async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), 'mizan-companies-'));
  try {
    const server = await spawnTestServer({
      env: { ...process.env, PORT: '0', MIZAN_DB: join(dir, 'db.sqlite'), MIZAN_ADMIN_PASSWORD: PASSWORD, MIZAN_AI: '1' },
    });
    return {
      url: server.url,
      stop: async () => {
        await server.stop();
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      },
    };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw err;
  }
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

test('category PATCH responses for company-limited users do not expose hidden company contact IDs in partner_ids', async () => {
  const { url, stop } = await startServer();
  try {
    const admin = client(url);
    await admin('POST', '/api/login', { login: 'admin', password: PASSWORD });
    const { body: db } = await admin('GET', '/api/db');
    const branch = createCompany(db, { name: 'Branch Two', currency_id: db.records['res.company'][0].currency_id });
    const mainPartner = db.records['res.company'][0].partner_id;
    const branchPartner = branch.db.records['res.company'].find((c) => c.id === branch.id).partner_id;
    const category = create(branch.db, 'res.partner.category', { name: 'Shared Tag', color: 1 });
    const taggedMain = write(category.db, 'res.partner', mainPartner, { tag_ids: [category.id] });
    const taggedBranch = write(taggedMain, 'res.partner', branchPartner, { tag_ids: [category.id] });
    assert.equal((await admin('POST', '/api/diff', diffDb(db, taggedBranch))).status, 200);

    assert.equal((await admin('POST', '/api/users', { login: 'c1user', name: 'Company 1 User', password: 'c1-password', companies: '1' })).status, 201);
    const c1User = client(url);
    await c1User('POST', '/api/login', { login: 'c1user', password: 'c1-password' });

    const { body: { key } } = await c1User('POST', '/api/keys', { name: 'c1key' });
    const rest = client(url, `Bearer ${key}`);

    const patchRes = await rest('PATCH', `/api/v1/res.partner.category/${category.id}`, { color: 4 });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.body.color, 4);

    assert.ok(patchRes.body.partner_ids.includes(mainPartner), 'visible partner must be present');
    assert.ok(!patchRes.body.partner_ids.includes(branchPartner), 'hidden branch contact must not be exposed in partner_ids');

    const getRes = await rest('GET', `/api/v1/res.partner.category/${category.id}`);
    assert.equal(getRes.status, 200);
    assert.ok(getRes.body.partner_ids.includes(mainPartner));
    assert.ok(!getRes.body.partner_ids.includes(branchPartner));
  } finally {
    await stop();
  }
});


test('bill upload rejects unauthorized companies and invalid partners before creating anything', async () => {
  const { url, stop } = await startServer();
  try {
    const admin = client(url);
    await admin('POST', '/api/login', { login: 'admin', password: PASSWORD });
    const { body: initial } = await admin('GET', '/api/db');
    const branch = createCompany(initial, { name: 'Upload branch', currency_id: initial.records['res.company'][0].currency_id });
    const foreign = create(branch.db, 'res.partner', { name: 'Foreign upload partner', company_id: branch.id });
    const inactive = create(foreign.db, 'res.partner', { name: 'Inactive upload partner', company_id: 1, active: false });
    assert.equal((await admin('POST', '/api/diff', diffDb(initial, inactive.db))).status, 200);
    assert.equal((await admin('POST', '/api/users', { login: 'uploadclerk', name: 'Upload clerk', password: 'clerk-password', companies: '1' })).status, 201);
    const clerk = client(url);
    await clerk('POST', '/api/login', { login: 'uploadclerk', password: 'clerk-password' });
    const { body: before } = await admin('GET', '/api/db');
    const file = { type: 'application/pdf', data: 'AA', name: 'bill.pdf' };
    const denied = await clerk('POST', '/api/integrations/digitize-new-bill', { company_id: branch.id, file });
    assert.equal(denied.status, 400);
    assert.match(denied.body.error, /No access to that company/);
    for (const partner_id of [foreign.id, inactive.id, 999999]) {
      const bad = await clerk('POST', '/api/integrations/digitize-new-bill', { company_id: 1, partner_id, file });
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /Select an active partner belonging to the bill company/);
    }
    // Missing company uses the user's current company, reaching document validation.
    const missing = await clerk('POST', '/api/integrations/digitize-new-bill', { file: { type: 'bad', data: 'AA' } });
    assert.match(missing.body.error, /Upload a PDF/);
    const { body: after } = await admin('GET', '/api/db');
    assert.deepEqual(after.records['account.move'], before.records['account.move']);
  } finally {
    await stop();
  }
});
