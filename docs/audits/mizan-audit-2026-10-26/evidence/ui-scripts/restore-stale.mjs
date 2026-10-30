// Realistic case: a user restores yesterday's backup. Work done since then by everyone is reverted/deleted.
const W = process.argv[2];
const { seed } = await import(`${W}/src/seed.js`);
const { applyDiff, diffDb } = await import(`${W}/src/sync.js`);
const { create, write, search } = await import(`${W}/src/orm.js`);
const backup = JSON.parse(JSON.stringify(seed()));            // downloaded "yesterday"
let server = seed();
// today: other users create a lead, a sale order, and edit a partner
const step = (next) => { server = applyDiff(server, diffDb(server, next), { author: 'colleague', isAdmin: false }); };
step(create(server, 'crm.lead', { name: 'Big deal created today', partner_id: 1 }).db);
step(create(server, 'sale.order', { partner_id: 1, order_line: [] }).db);
const p = search(server, 'res.partner')[0];
step(write(server, 'res.partner', p.id, { phone: '+20 100 000 0000' }));
const before = { leads: search(server, 'crm.lead').length, so: search(server, 'sale.order').length, phone: search(server, 'res.partner')[0].phone };
// a non-admin clerk restores the old file from Settings (client computes diffDb(getDb(), file))
const after = applyDiff(server, diffDb(server, backup), { author: 'clerk', isAdmin: false });
console.log('before restore:', JSON.stringify(before));
console.log('after restore :', JSON.stringify({ leads: search(after, 'crm.lead').length, so: search(after, 'sale.order').length, phone: search(after, 'res.partner')[0].phone }));
