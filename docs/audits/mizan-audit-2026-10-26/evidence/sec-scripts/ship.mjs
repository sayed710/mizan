// No network: fetch is stubbed; URLs are IP literals so dns.lookup resolves locally.
const W = process.argv[2];
const { modelsForApps } = await import(W + '/src/models/index.js');
const { seed } = await import(W + '/src/seed.js');
const { applyDiff } = await import(W + '/src/sync.js');
const { quoteShipping, assertPublicUrl } = await import(W + '/server/integrations.js');
const sales = modelsForApps(['sales']);
console.log('sales user may write delivery.carrier:', sales.has('delivery.carrier'), '| marketplace.connector:', sales.has('marketplace.connector'));
let db = seed();
const order = db.records['sale.order'][0]; const carrier = db.records['delivery.carrier'][0];
db = applyDiff(db, { upserts: { 'delivery.carrier': [{ ...carrier, delivery_type: 'api', api_url: 'https://203.0.113.10/rates' }], 'sale.order': [{ ...order, carrier_id: carrier.id }] } }, { author: 'mallory', isAdmin: false, allowed: sales });
console.log('non-admin set carrier api_url ->', db.records['delivery.carrier'].find(c => c.id === carrier.id).api_url);
let captured;
globalThis.fetch = async (url, init) => { captured = { url: String(url), auth: init.headers.Authorization }; return new Response(JSON.stringify({ price: 1 }), { status: 200 }); };
await quoteShipping({ MIZAN_SHIPPING_TOKEN: 'sk_live_SECRET123' }, db, { id: order.id });
console.log('outbound request captured:', JSON.stringify(captured));
for (const u of ['https://127.0.0.1/', 'https://100.64.0.1/', 'https://198.18.0.1/', 'https://224.0.0.1/', 'https://255.255.255.255/', 'https://[::1]/', 'http://203.0.113.10/']) {
  try { await assertPublicUrl(u); console.log('ALLOWED', u); } catch (e) { console.log('BLOCKED', u, '-', e.message.slice(0, 60)); }
}
