const W = process.argv[2];
await import(W + '/src/models/index.js');
const { seed } = await import(W + '/src/seed.js');
const { applyDiff } = await import(W + '/src/sync.js');
let db = seed();
const c1 = db.records['res.company'][0];
// admin adds company 2 and a confidential lead in company 2
db = applyDiff(db, { upserts: { 'res.partner': [{ id: 60, name: 'Subsidiary B', is_company: true }], 'res.company': [{ ...c1, id: 2, name: 'Subsidiary B', company_id: 2, partner_id: 60 }], 'crm.lead': [{ ...db.records['crm.lead'][0], id: 50, name: 'B-only secret deal', company_id: 2 }] }, seq: { 'res.company': 2, 'crm.lead': 50, 'res.partner': 60 }, settings: { ...db.settings, current_company_id: 1, allowed_company_ids: [1] } }, { author: 'Admin', isAdmin: true });
console.log('admin settings', db.settings.current_company_id, JSON.stringify(db.settings.allowed_company_ids));
// non-admin (no app restriction) flips the GLOBAL company selection to company 2 only
const next = applyDiff(db, { settings: { current_company_id: 2, allowed_company_ids: [2] } }, { author: 'staff', isAdmin: false, allowed: null });
console.log('after non-admin diff, global settings:', next.settings.current_company_id, JSON.stringify(next.settings.allowed_company_ids));
// what visibleDb returns for an unrestricted non-admin: index.js:146-148 returns db unchanged when allowed is null
console.log('company-2 lead present in the db sent to any user:', !!next.records['crm.lead'].find(l => l.id === 50 && l.company_id === 2));
// non-admin writes a record straight into company 2 by setting company_id
const n2 = applyDiff(db, { upserts: { 'crm.lead': [{ ...db.records['crm.lead'][1], company_id: 2 }] } }, { author: 'staff', isAdmin: false, allowed: null });
console.log('non-admin moved lead', db.records['crm.lead'][1].id, 'to company', n2.records['crm.lead'].find(l => l.id === db.records['crm.lead'][1].id).company_id);
