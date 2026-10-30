import { seed, models, orm, btn, tryIt, serverSync, ledger, ledgerDelta, newIds, prompts, log, applyDiff, diffDb } from './lib.mjs';
const { create, read, search, write } = orm;
const co = await import('../src/models/company.js');
const { viewRecords, companyViewDb } = await import('../src/companyView.js');
const { profitAndLoss } = await import('../src/models/ledger.js');
let db = seed();
// company 2 (buyer) with the inter-company rule; company 1 = seller (Mizan Demo Co, partner 8)
let r = co.createCompany(db, { name: 'Branch B', currency_id: read(db, 'res.company', 1).currency_id, intercompany_rule: 'sale_purchase' }); db = r.db; const C2 = r.id; const C2p = read(db, 'res.company', C2).partner_id;
log('company 2', C2, 'partner', C2p, 'record company_id', read(db, 'res.company', C2).company_id);
// switch the (global) selection to company 2 and create documents the way the UI does
db = co.setCompanies(db, { current: C2, allowed: [C2] });
log('settings after switch', JSON.stringify({ current: db.settings.current_company_id, allowed: db.settings.allowed_company_ids }));
log('form defaults for a new SO while in company 2 (FormView calls defaults(id) without db):', JSON.stringify(models['sale.order'].defaults(99).company_id));
r = create(db, 'sale.order', { partner_id: 3, order_line: [{ product_id: 1, qty: 1, price_unit: 210, tax: 0 }] });
log('orm.create(sale.order) while current company = 2 -> company_id', read(r.db, 'sale.order', r.id).company_id);
// a company-2 SO (company set explicitly) and its generated documents
r = create(db, 'sale.order', { company_id: C2, partner_id: 3, order_line: [{ product_id: 1, qty: 2, price_unit: 210, tax: 0 }] }); db = r.db; const so2 = r.id;
db = btn(db, 'sale.order', so2, 'Confirm').db;
const pk = search(db, 'stock.picking').find((p) => p.sale_id === so2);
db = btn(db, 'stock.picking', pk.id, 'Validate').db;
let b = db; db = btn(db, 'sale.order', so2, 'Create Invoice').db; const inv = newIds(b, db, 'account.move').find((id) => read(db, 'account.move', id).move_type === 'out_invoice');
b = db; db = btn(db, 'account.move', inv, 'Confirm').db;
prompts.push('420'); b = db; db = btn(db, 'account.move', inv, 'Register Payment').db;
const pay = search(db, 'account.payment').find((p) => p.invoice_id === inv);
const entries = search(db, 'account.move').filter((m) => m.move_type === 'entry' && (m.ref ?? '').match(new RegExp(`${pk.name}|${read(db, 'account.move', inv).name}`)));
log('company-2 SO', so2, 'company', read(db, 'sale.order', so2).company_id, '-> picking', pk.company_id, '| invoice', read(db, 'account.move', inv).company_id, '| payment', pay?.company_id, '| entries', JSON.stringify(entries.map((m) => [m.ref, m.company_id])), '| valuation layer', search(db, 'stock.valuation.layer').at(-1).company_id);
// list isolation: what does company 2 see?
const vis = viewRecords(db, 'account.move').map((m) => m.id);
log('company-2 list of account.move includes its own invoice?', vis.includes(inv), '| count visible', vis.length, 'of', db.records['account.move'].length);
log('P&L (Reports page uses raw useDb): income all companies', profitAndLoss(db, { from: '2026-01-01', to: '2026-12-31' }).income ?? JSON.stringify(profitAndLoss(db, { from: '2026-01-01', to: '2026-12-31' })).slice(0, 120));
log('P&L through companyViewDb (company 2 only)', JSON.stringify(profitAndLoss(companyViewDb(db), { from: '2026-01-01', to: '2026-12-31' })).slice(0, 160));
// shared stock: company 2 delivery consumed the single product quantity
log('product.qty_available is one shared figure (product is SHARED_MODELS):', orm.SHARED_MODELS.has('product'));
// server: is /api/db filtered by company? (server/index.js visibleDb filters only by app allow-list)
// settings selection is global and writable by non-admins
db = co.setCompanies(db, { current: 1, allowed: [1] });
const forged = applyDiff(db, { upserts: {}, deletes: {}, messages: [], removedMessages: [], seq: db.seq, settings: { ...db.settings, current_company_id: C2, allowed_company_ids: [1, C2] } }, { isAdmin: false, allowed: new Set(['sale.order']) });
log('non-admin (restricted to sale.order) changes the GLOBAL company selection:', JSON.stringify({ current: forged.settings.current_company_id, allowed: forged.settings.allowed_company_ids }));
// cross-company record: company-1 user writes a company-2 SO / moves a company-1 invoice to company 2
const mv = tryIt(() => applyDiff(db, { upserts: { 'account.move': [{ ...read(db, 'account.move', 1), company_id: C2 }] }, deletes: {}, messages: [], removedMessages: [], seq: db.seq, settings: null }, { isAdmin: false }));
log('non-admin re-assigns a posted invoice to another company:', mv.ok ? 'ACCEPTED' : mv.error);
// ---- inter-company rule via the sale.order Confirm button ----
db = co.setCompanies(db, { current: 1, allowed: [1] });
r = create(db, 'sale.order', { partner_id: C2p, order_line: [models['sale.order'].fields.order_line.onchange({ product_id: 1, qty: 3 }, 'product_id', db, {})].map((l) => ({ ...l, qty: 3 })) }); db = r.db; const ic = r.id;
log('IC SO line tax', JSON.stringify(read(db, 'sale.order', ic).order_line.map((l) => [l.tax_id, l.tax_name, l.tax_account_id && read(db, 'account.account', l.tax_account_id)?.code])));
b = db; db = btn(db, 'sale.order', ic, 'Confirm').db;
const po = search(db, 'purchase.order').find((p) => p.auto_sale_id === ic);
log('IC Confirm: PO', po ? `${po.name} company ${po.company_id} partner ${po.partner_id} state ${po.state} lines ${JSON.stringify(po.order_line.map((l) => [l.product_id, l.qty, l.price_unit, l.tax_id, l.tax_name]))}` : 'none', '| SO auto_purchase_id', read(db, 'sale.order', ic).auto_purchase_id);
log('IC Confirm twice (run):', search(btn(db, 'sale.order', ic, 'Confirm', { force: true }).db, 'purchase.order').filter((p) => p.auto_sale_id === ic).length, 'POs;', search(btn(db, 'sale.order', ic, 'Confirm', { force: true }).db, 'stock.picking').filter((p) => p.sale_id === ic).length, 'pickings');
// buyer side: confirm PO, receive, bill -> which tax account?
db = btn(db, 'purchase.order', po.id, 'Confirm Order').db;
const rc = search(db, 'stock.picking').find((p) => p.purchase_id === po.id);
log('IC PO receipt company', rc?.company_id, '(PO company', po.company_id + ')');
db = btn(db, 'stock.picking', rc.id, 'Validate').db;
b = db; db = btn(db, 'purchase.order', po.id, 'Create Bill').db; const bill = newIds(b, db, 'account.move').find((id) => read(db, 'account.move', id).move_type === 'in_invoice');
log('IC bill company', read(db, 'account.move', bill).company_id);
b = db; db = btn(db, 'account.move', bill, 'Confirm').db;
log('IC bill journal items', JSON.stringify(read(db, 'account.move', bill).line_ids.map((l) => [read(db, 'account.account', l.account_id).code, l.debit, l.credit])));
// SO cancelled / changed after the PO was drafted
const cancelled = btn(db, 'sale.order', ic, 'Cancel', { force: true }).db;
log('after cancelling the IC SO, PO state', read(cancelled, 'purchase.order', po.id).state);
// misconfigured rule swallowed
const noPartner = write(db, 'res.company', 1, { partner_id: null });
r = create(noPartner, 'sale.order', { partner_id: C2p, order_line: [{ product_id: 6, qty: 1, price_unit: 45, tax: 0 }] });
const sw = tryIt(() => btn(r.db, 'sale.order', r.id, 'Confirm').db);
log('IC rule error when seller has no contact:', sw.ok ? `swallowed; SO state ${read(sw.value, 'sale.order', r.id).state}, PO created: ${search(sw.value, 'purchase.order').some((p) => p.auto_sale_id === r.id)}` : sw.error);
