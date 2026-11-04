import { seed, models, orm, btn, tryIt, serverSync, prompts, log } from './lib.mjs';
const { create, read, search, write } = orm;
const { generateCoupons } = await import('../src/models/loyalty.js');
let db = seed();
const g = create(db, 'loyalty.program', { name: 'Gift', program_type: 'gift_card', active: true, sale_ok: true, applies_on: 'current', rule_ids: [{ minimum_qty: 0, minimum_amount: 0 }], reward_ids: [{ reward_type: 'discount', discount: 1, discount_mode: 'per_point', discount_applicability: 'order', description: 'Gift card' }] });
db = generateCoupons(g.db, g.id, { count: 1, points: 100, codeFn: () => 'GIFT100' });
const run = (base) => {
  let r = create(base, 'sale.order', { partner_id: 3, order_line: [{ product_id: 6, qty: 4, price_unit: 45, tax: 0 }] }); let d = r.db;
  prompts.push('GIFT100');
  const ap = tryIt(() => btn(d, 'sale.order', r.id, 'Apply Coupon').db); if (!ap.ok) { log('apply error', ap.error); return; }
  return { d: ap.value, id: r.id, before: d };
};
const x = run(db);
log('client after Apply Coupon: loyalty_uses', JSON.stringify(read(x.d, 'sale.order', x.id).loyalty_uses), 'lines', JSON.stringify(read(x.d, 'sale.order', x.id).order_line.map((l) => [l.product_id, l.price_unit])));
const srv = serverSync(x.before, x.d);
log('server copy loyalty_uses', JSON.stringify(read(srv.db, 'sale.order', x.id).loyalty_uses), '| lost:', srv.lost.map((s) => s.split(':')[0]).join(','));
const card = (d) => search(d, 'loyalty.card').find((c) => c.code === 'GIFT100');
const cClient = btn(x.d, 'sale.order', x.id, 'Confirm').db;
const cServer = btn(srv.db, 'sale.order', x.id, 'Confirm').db; // user reloads (poll) then confirms
log('gift card points after Confirm: from client copy', card(cClient).points, card(cClient).state, '| after reload from server', card(cServer).points, card(cServer).state);
// reuse the same card on a second order after reload
prompts.push('GIFT100');
let r2 = create(cServer, 'sale.order', { partner_id: 5, order_line: [{ product_id: 6, qty: 4, price_unit: 45, tax: 0 }] });
const second = tryIt(() => btn(r2.db, 'sale.order', r2.id, 'Apply Coupon').db);
log('apply the same gift card to another order:', second.ok ? 'ACCEPTED discount line ' + read(second.value, 'sale.order', r2.id).order_line.at(-1).price_unit : second.error);
log('client reward line keys', Object.keys(read(x.d, 'sale.order', x.id).order_line.at(-1)).join(','), '| server', Object.keys(read(srv.db, 'sale.order', x.id).order_line.at(-1)).join(','));
