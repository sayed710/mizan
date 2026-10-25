import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, search, write } from '../src/orm.js';
import { seed } from '../src/seed.js';
import { demoPaymentsAllowed, publicCart, publicOrder, publicOrderStatus, publicSite } from './api.js';

// Demo payments are a test-only provider: enabled and allowed explicitly where a test needs them.
const withDemo = (db) => write(db, 'payment.provider', search(db, 'payment.provider').find((p) => p.code === 'demo').id, { state: 'enabled' });

const visitor = { name: 'Hala Adel', email: 'hala@example.com', phone: '+20 100', street: '1 Nile St', city: 'Cairo', zip: '11511', country: 'Egypt' };
const checkout = (db, extra = {}) => publicOrder(db, { ...visitor, lines: [{ product_id: 1, qty: 2, price_unit: 1 }], carrier_id: 1, provider_code: 'wire', ...extra });
const lastOrder = (db) => search(db, 'sale.order').at(-1);

test('publicSite exposes categories, published carriers, enabled providers and shop product data', () => {
  const site = publicSite(seed());
  assert.deepEqual(site.categories.map((c) => c.name), ['Desks', 'Chairs']);
  assert.deepEqual(site.carriers.map((c) => c.name), ['Standard Delivery', 'Freight by weight']);
  assert.deepEqual(site.providers.map((p) => p.code), ['wire', 'cod']);
  assert.deepEqual(Object.keys(site.providers[0]).sort(), ['code', 'name', 'pending_msg']);
  const desk = site.products.find((p) => p.id === 2);
  assert.equal(desk.ribbon, 'new');
  assert.deepEqual(desk.public_categ_ids, [{ category_id: 1 }]);
  assert.ok(site.products.some((p) => p.variant_of === 2));
  assert.ok(!site.products.some((p) => p.name === 'Shipping'));
  assert.ok(!('cost' in desk));
});

test('the server ignores client prices and adds the delivery line', () => {
  const out = checkout(seed());
  assert.equal(out.status, 201);
  const order = lastOrder(out.db);
  assert.equal(order.name, out.body.order);
  assert.equal(order.order_line[0].price_unit, 210);
  assert.equal(order.order_line.length, 2);
  assert.deepEqual([order.order_line[1].product_id, order.order_line[1].price_unit], [13, 25]);
  assert.equal(order.amount_total, 507.3);
  assert.equal(order.carrier_id, 1);
  const partner = read(out.db, 'res.partner', order.partner_id);
  assert.deepEqual([partner.street, partner.city, partner.zip, partner.country], ['1 Nile St', 'Cairo', '11511', 'Egypt']);
  assert.equal(publicCart(seed(), { lines: [{ product_id: 1, qty: 2, price_unit: 1 }], carrier_id: 1 }).body.total, 507.3);
});

test('wire payment leaves a sent quotation with the provider noted', () => {
  const out = checkout(seed());
  const order = lastOrder(out.db);
  assert.deepEqual([order.state, order.payment_provider, order.payment_state], ['sent', 'wire', 'pending']);
  assert.equal(order.source, 'website');
});

test('the demo provider is off by default and never allowed in production', () => {
  assert.equal(checkout(withDemo(seed()), { provider_code: 'demo' }).status, 400);
  assert.equal(demoPaymentsAllowed({ MIZAN_DEMO_PAYMENTS: '1', NODE_ENV: 'production' }), false);
  assert.equal(demoPaymentsAllowed({}), false);
});

test('demo payment confirms the order and records it as paid', () => {
  process.env.MIZAN_DEMO_PAYMENTS = '1';
  const out = checkout(withDemo(seed()), { provider_code: 'demo' });
  delete process.env.MIZAN_DEMO_PAYMENTS;
  const order = lastOrder(out.db);
  assert.deepEqual([order.state, order.payment_state], ['sale', 'paid']);
  assert.ok(search(out.db, 'stock.picking').some((p) => p.sale_id === order.id), 'confirmation creates the delivery');
});

test('order status needs the right token; only a token hash is stored', () => {
  const out = checkout(seed());
  const order = lastOrder(out.db);
  assert.ok(out.body.access_token.length >= 32);
  assert.notEqual(order.access_token_hash, out.body.access_token);
  assert.ok(!JSON.stringify(out.db).includes(out.body.access_token));
  const ok = publicOrderStatus(out.db, new URLSearchParams({ order: order.name, token: out.body.access_token }));
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.state, ok.body.total, ok.body.lines.length], ['sent', 507.3, 2]);
  const wrong = publicOrderStatus(out.db, new URLSearchParams({ order: order.name, token: 'x'.repeat(32) }));
  assert.equal(wrong.status, 404);
  assert.equal(wrong.denied, true);
  assert.equal(publicOrderStatus(out.db, new URLSearchParams({ order: order.name })).status, 404);
});

test('unpublished products, unknown carriers or providers and bad quantities are refused', () => {
  const db = write(seed(), 'product', 1, { is_published: false });
  assert.match(checkout(db).body.error, /not available online/);
  assert.equal(checkout(db).status, 400);
  assert.match(checkout(seed(), { lines: [{ product_id: 2, qty: 1 }] }).body.error, /not available online/, 'a template with variants is bought through a variant');
  assert.match(checkout(seed(), { carrier_id: 3 }).body.error, /delivery method/, 'API carriers are not published');
  assert.match(checkout(seed(), { provider_code: 'paypal' }).body.error, /payment method/);
  assert.match(checkout(seed(), { lines: [{ product_id: 1, qty: 0 }] }).body.error, /quantity/);
  const disabled = write(seed(), 'payment.provider', 3, { state: 'disabled' });
  assert.equal(checkout(disabled, { provider_code: 'demo' }).status, 400);
});

test('a selectable pricelist applies, a non-selectable one is ignored; a known email gets its own contact to merge', () => {
  const promo = checkout(seed(), { pricelist: 2 });
  assert.equal(lastOrder(promo.db).order_line[0].price_unit, 199.5);
  const wholesale = checkout(seed(), { pricelist: 1, lines: [{ product_id: 4, qty: 10 }] });
  assert.equal(lastOrder(wholesale.db).order_line[0].price_unit, 35);
  const known = checkout(seed(), { email: 'SARA.H@mail.example', street: 'Elsewhere' });
  const order = lastOrder(known.db);
  assert.notEqual(order.partner_id, 3);
  assert.ok(read(known.db, 'res.partner', order.partner_id).tag_ids.includes('To Merge'));
  assert.equal(read(known.db, 'res.partner', 3).street, undefined);
});

test('goods beyond the stock on hand and archived products are refused', () => {
  const db = seed();
  const stock = read(db, 'product', 1).qty_available;
  assert.match(checkout(db, { lines: [{ product_id: 1, qty: stock + 1 }] }).body.error, /in stock/);
  const archived = write(db, 'product', 1, { active: false });
  assert.match(checkout(archived).body.error, /not available online/);
});
