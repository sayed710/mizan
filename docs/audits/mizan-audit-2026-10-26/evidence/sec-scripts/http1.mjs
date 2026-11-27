const P = process.argv[2]; const B = `http://127.0.0.1:${P}`;
const H = { 'x-requested-with': 'mizan', 'content-type': 'application/json' };
const j = async (method, path, body, cookie, extra = {}) => { const r = await fetch(B + path, { method, headers: { ...H, ...(cookie ? { cookie } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }); let t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { s: r.status, d, h: r.headers }; };
const login = async (l, p) => { const r = await j('POST', '/api/login', { login: l, password: p }); return { s: r.s, cookie: r.h.get('set-cookie')?.split(';')[0], raw: r.h.get('set-cookie') }; };
const admin = await login('admin', 'Adm1nPass!x');
console.log('admin login', admin.s, 'Set-Cookie:', admin.raw);
console.log('create clerk(contacts)', (await j('POST', '/api/users', { login: 'clerk', password: 'clerkpass1', apps: 'contacts' }, admin.cookie)).s);
console.log('create staff(no apps)', (await j('POST', '/api/users', { login: 'staff', password: 'staffpass1' }, admin.cookie)).s);
console.log('create stock(inventory)', (await j('POST', '/api/users', { login: 'stock', password: 'stockpass1', apps: 'inventory' }, admin.cookie)).s);
const clerk = await login('clerk', 'clerkpass1'); const staff = await login('staff', 'staffpass1'); const stock = await login('stock', 'stockpass1');
const cdb = (await j('GET', '/api/db', null, clerk.cookie)).d;
console.log('clerk /api/db models', Object.keys(cdb.records).length, 'has hr.employee', !!cdb.records['hr.employee']);
const e = cdb.records['hr.employee'][1]; console.log('clerk sees employee', e.name, 'wage', e.wage, 'bank', e.bank_account, 'pin', e.pin, 'passport', e.passport_id, 'private_address', e.private_address);
const sdb = (await j('GET', '/api/db', null, staff.cookie)).d;
console.log('staff(no apps, non-admin) /api/db models', Object.keys(sdb.records).length, 'records', Object.values(sdb.records).reduce((s, r) => s + r.length, 0), 'settings keys', Object.keys(sdb.settings).join(','));
// clerk modifies employee bank account via /api/diff
const up = await j('POST', '/api/diff', { upserts: { 'hr.employee': [{ ...e, bank_account: 'EG00ATTACKER', wage: 1 }] }, deletes: {}, messages: [], removedMessages: [], seq: {}, settings: null }, clerk.cookie);
console.log('clerk diff hr.employee', up.s, 'stored bank', (await j('GET', '/api/db', null, admin.cookie)).d.records['hr.employee'].find(x => x.id === e.id).bank_account);
// stock user forges posted invoice
const fake = { id: 777, name: 'INV/2026/77777', move_type: 'out_invoice', state: 'posted', partner_id: 4, invoice_date: '2026-10-20', journal_id: 1, invoice_line_ids: [{ product_id: 2, qty: 1, price_unit: 1000000, tax: 0 }], line_ids: [{ account_id: 3, partner_id: 4, name: 'x', debit: 1000000, credit: 0 }], amount_paid: 0 };
const f = await j('POST', '/api/diff', { upserts: { 'account.move': [fake] }, deletes: {}, messages: [], removedMessages: [], seq: { 'account.move': 777 }, settings: null }, stock.cookie);
const m = (await j('GET', '/api/db', null, admin.cookie)).d.records['account.move'].find(x => x.id === 777);
console.log('stock-user forged posted invoice', f.s, m && `${m.name} ${m.state} debit=${m.line_ids[0].debit} credit=${m.line_ids.reduce((s,l)=>s+l.credit,0)}`);
// API key + /api/v1 mass assignment by staff
const key = (await j('POST', '/api/keys', { name: 't' }, staff.cookie)).d.key;
const api = async (method, path, body) => { const r = await fetch(B + path, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, d: await r.json() }; };
const v1 = await api('POST', '/api/v1/account.move', { move_type: 'out_invoice', state: 'posted', name: 'INV/2026/88888', partner_id: 4, amount_paid: 123, invoice_line_ids: [{ product_id: 2, qty: 1, price_unit: 5, tax: 0 }] });
console.log('/api/v1 POST posted move by non-admin', v1.s, v1.d.name, v1.d.state, 'amount_paid', v1.d.amount_paid, 'payment_state', v1.d.payment_state);
const v1p = await api('PATCH', '/api/v1/account.move/2', { amount_paid: 0, invoice_line_ids: [{ product_id: 2, qty: 1, price_unit: 1, tax: 0 }] });
console.log('/api/v1 PATCH posted INV/2026/00001', v1p.s, 'total', v1p.d.amount_total, 'residual', v1p.d.amount_residual);
console.log('/api/v1 GET res.users?', (await api('GET', '/api/v1/res.users')).s, '| GET hr.employee/1 wage', (await api('GET', '/api/v1/hr.employee/1')).d.wage);
// staff (non-admin) changes global company selection setting?
const set = await j('POST', '/api/diff', { upserts: {}, deletes: {}, messages: [], removedMessages: [], seq: {}, settings: { current_company_id: 1, allowed_company_ids: [1], favorites: { 'crm.lead': [{ name: 'evil', search: { terms: ['x'] } }] } } }, staff.cookie);
console.log('staff settings change', set.s, 'admin now sees favorites', JSON.stringify((await j('GET', '/api/db', null, admin.cookie)).d.settings.favorites));
// logout invalidation
await j('POST', '/api/logout', {}, clerk.cookie);
console.log('clerk after logout /api/db', (await j('GET', '/api/db', null, clerk.cookie)).s);
