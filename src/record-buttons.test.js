import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { create, read, search, write } from './orm.js';
import { recordAnalyses } from './models/analysis.js';
import { parseSplit } from './models/posplus.js';
import { valuationReport } from './models/valuation.js';

// MOD-007: functions that were only reachable from tests now have a form button.
const button = (model, label) => {
  const b = models[model].form.buttons.find((x) => x.label === label);
  assert.ok(b, `${model} has a "${label}" button`);
  return b;
};

test('fleet contracts can be renewed from the form', () => {
  const db = seed();
  const made = create(db, 'fleet.contract', { name: 'Lease', vehicle_id: search(db, 'fleet.vehicle')[0].id, start_date: '2026-01-01', expiration_date: '2026-12-31', stage_id: 'open' });
  const renew = button('fleet.contract', 'Renew');
  const rec = read(made.db, 'fleet.contract', made.id);
  assert.ok(renew.when(rec));
  const out = renew.run(made.db, rec);
  assert.equal(read(out.db, 'fleet.contract', made.id).stage_id, 'closed');
  assert.match(out.go, /^#\/open\/fleet\.contract\/\d+$/);
});

test('event registrations can be invoiced from the event form, once', () => {
  const ev = create(seed(), 'event.event', { name: 'Expo', date_begin: '2027-04-01', ticket_ids: [{ name: 'VIP', price: 100, seats_max: 0 }] });
  const reg = create(ev.db, 'event.registration', { event_id: ev.id, name: 'Sara', partner_id: 3, ticket: 'VIP' });
  const b = button('event.event', 'Invoice Registrations');
  const event = read(reg.db, 'event.event', ev.id);
  assert.ok(b.when(event));
  const out = b.run(reg.db, event);
  assert.ok(read(out.db, 'event.registration', reg.id).invoice_id);
  assert.throws(() => b.run(out.db, event), /already invoiced/);
});

test('a draft purchase order takes the vendor pricelist price', () => {
  const db0 = seed();
  const po = search(db0, 'purchase.order').find((p) => p.state === 'draft');
  const line = po.order_line[0];
  const info = create(db0, 'product.supplierinfo', { partner_id: po.partner_id, product_id: line.product_id, price: 7.25, min_qty: 0 });
  const b = button('purchase.order', 'Apply Vendor Prices');
  assert.ok(b.when(po));
  assert.equal(b.when({ ...po, state: 'purchase' }), false);
  const out = b.run(info.db, read(info.db, 'purchase.order', po.id));
  assert.equal(read(out.db, 'purchase.order', po.id).order_line[0].price_unit, 7.25);
});

test('expense sheets re-invoice once posted, and front desk can check everyone out', () => {
  const reinvoice = button('hr.expense.sheet', 'Re-invoice to Sales Orders');
  assert.ok(reinvoice.when({ state: 'post' }));
  assert.equal(reinvoice.when({ state: 'draft' }), false);
  const db = seed();
  assert.ok(button('frontdesk.station', 'Check Out All Visitors').run(db, {}).db.records);
});

// MOD-007 (4/4): buttons that ask for their input before running.
const press = (db, model, id, label, answers = []) => button(model, label).run(db, read(db, model, id), answers);

test('restaurant tables open, take tips, move, split and merge from the forms', () => {
  const config = create(seed(), 'pos.config', { name: 'Bistro', module_restaurant: true });
  const floor = create(config.db, 'restaurant.floor', { name: 'Main', config_id: config.id, table_ids: [{ name: 'T1', seats: 4 }, { name: 'T2', seats: 2 }, { name: 'T3', seats: 2 }] });
  const opened = press(floor.db, 'restaurant.floor', floor.id, 'Open Table', ['T1', 3]);
  const orderId = Number(opened.go.split('/').at(-1));
  let db = create(opened.db, 'pos.order', { config_id: config.id, table_id: `${floor.id}:T2`, state: 'draft' }).db;
  const other = search(db, 'pos.order').find((o) => o.table_id === `${floor.id}:T2`).id;
  db = (withLines(db, orderId));
  db = press(db, 'pos.order', orderId, 'Add Tip', [5]).db;
  assert.equal(read(db, 'pos.order', orderId).tip_amount, 5);
  assert.throws(() => press(db, 'pos.order', orderId, 'Transfer Table', ['T2']), /already has a draft order/);
  db = press(db, 'pos.order', orderId, 'Transfer Table', ['T3']).db;
  assert.equal(read(db, 'pos.order', orderId).table_id, `${floor.id}:T3`);
  const split = press(db, 'pos.order', orderId, 'Split Bill', ['1x1']);
  const splitId = Number(split.go.split('/').at(-1));
  assert.equal(read(split.db, 'pos.order', splitId).lines[0].qty, 1);
  assert.equal(read(split.db, 'pos.order', orderId).lines[0].qty, 1);
  const merged = press(split.db, 'pos.order', other, 'Merge Into Table', ['T3']);
  assert.equal(read(merged.db, 'pos.order', other).state, 'cancel');
  assert.equal(searchStatus(merged.db, floor.id).find((t) => t.table === 'T3').orderId > 0, true);
});

function withLines(db, orderId) {
  const order = read(db, 'pos.order', orderId);
  return write(db, 'pos.order', orderId, { lines: [{ product_id: 1, name: 'Desk', qty: 2, price_unit: 10, tax: 0, discount: 0 }, { product_id: 2, name: 'Chair', qty: 1, price_unit: 5, tax: 0, discount: 0 }], customer_count: order.customer_count });
}
const searchStatus = (db, floorId) => recordAnalyses['restaurant.floor'][0].run(db, read(db, 'restaurant.floor', floorId));

test('split bill input reads line numbers and quantities', () => {
  assert.deepEqual(parseSplit('1x2, 3'), [{ index: 0, qty: 2 }, { index: 2, qty: 1 }]);
});

test('products can be revalued and stock valuation follows the layers', () => {
  const db = seed();
  const p = search(db, 'product').find((x) => x.type === 'goods' && x.qty_available > 0);
  const out = press(db, 'product', p.id, 'Revalue', [Number(p.cost) + 10]);
  assert.equal(read(out.db, 'product', p.id).cost, Number(p.cost) + 10);
  assert.equal(valuationReport(out.db)[p.id].value, Math.round(p.qty_available * (Number(p.cost) + 10) * 100) / 100);
});

test('the lunch Order button refuses an order the wallet cannot pay', () => {
  const db = seed();
  const made = create(db, 'lunch.order', { product_id: 1, employee_id: 1, quantity: 100 });
  assert.throws(() => press(made.db, 'lunch.order', made.id, 'Order'), /not have enough money|does not deliver|close at/);
});

test('stations plan visits with a badge for a named host', () => {
  const station = create(seed(), 'frontdesk.station', { name: 'Lobby' });
  const host = search(station.db, 'hr.employee')[0];
  const out = press(station.db, 'frontdesk.station', station.id, 'Plan Visit', ['Laila', host.name.toUpperCase(), '2027-01-05', '10:30']);
  const visitor = read(out.db, 'frontdesk.visitor', Number(out.go.split('/').at(-1)));
  assert.deepEqual([visitor.stage_id, visitor.host_id, visitor.planned_time], ['planned', host.id, '10:30']);
  assert.ok(visitor.badge_code);
  assert.throws(() => press(station.db, 'frontdesk.station', station.id, 'Plan Visit', ['Laila', 'Nobody', '2027-01-05', '10:30']), /No employee/);
});

test('planning shifts auto-plan and publish their week', () => {
  const made = create(seed(), 'planning.slot', { name: 'Open shift', start: '2027-03-03', allocated_hours: 8, state: 'draft' });
  const planned = press(made.db, 'planning.slot', made.id, 'Auto Plan Week').db;
  assert.ok(read(planned, 'planning.slot', made.id).employee_id);
  const published = press(planned, 'planning.slot', made.id, 'Publish Week').db;
  assert.equal(read(published, 'planning.slot', made.id).state, 'published');
});

test('project updates made in the form are published with a task summary', () => {
  const made = create(seed(), 'project.update', { project_id: 1, name: 'Week 1', status: 'at_risk', progress: 40 });
  const out = press(made.db, 'project.update', made.id, 'Publish').db;
  assert.match(read(out, 'project.update', made.id).summary, /tasks/);
  assert.equal(read(out, 'project.project', 1).last_update_status, 'at_risk');
});

test('rentals hold a deposit that can be partly withheld for damage', () => {
  const db = seed();
  const rental = search(db, 'sale.rental').find((r) => ['reserved', 'picked'].includes(r.state));
  const held = press(db, 'sale.rental', rental.id, 'Hold Deposit', [200]);
  const depositId = Number(held.go.split('/').at(-1));
  const out = press(held.db, 'rental.deposit', depositId, 'Withhold for Damage', [50, 'Scratched']).db;
  assert.deepEqual([read(out, 'rental.deposit', depositId).state, read(out, 'rental.deposit', depositId).withheld_amount], ['withheld', 50]);
});

test('referral rewards are redeemed for a named employee, never beyond their points', () => {
  const reward = create(seed(), 'hr.referral.reward', { name: 'Mug', cost: 10, quantity: 2 });
  const name = search(reward.db, 'hr.employee')[0].name;
  assert.throws(() => press(reward.db, 'hr.referral.reward', reward.id, 'Redeem', [name]), /Insufficient referral points/);
  assert.throws(() => press(reward.db, 'hr.referral.reward', reward.id, 'Redeem', ['Nobody']), /No employee/);
});

test('warehouses create an internal resupply from another warehouse', () => {
  const second = create(seed(), 'stock.warehouse', { name: 'Alex Depot', code: 'ALX' });
  const product = search(second.db, 'product').find((p) => p.type === 'goods');
  const before = search(second.db, 'stock.picking').length;
  const out = press(second.db, 'stock.warehouse', second.id, 'Resupply From Warehouse', ['wh', product.name, 3]).db;
  const picking = search(out, 'stock.picking').at(-1);
  assert.equal(search(out, 'stock.picking').length, before + 1);
  assert.deepEqual([picking.picking_type, picking.move_ids[0].qty], ['internal', 3]);
});

test('signature templates create a request with one signer per role', () => {
  const tpl = create(seed(), 'sign.template', { name: 'NDA', item_ids: [{ type: 'signature', role: 'customer', page: 1, required: true }] });
  const partner = search(tpl.db, 'res.partner')[0];
  const b = button('sign.template', 'Request Signature');
  assert.equal(b.ask[0].default(read(tpl.db, 'sign.template', tpl.id)), 'customer=');
  const out = press(tpl.db, 'sign.template', tpl.id, 'Request Signature', [`customer=${partner.name}`]);
  const request = read(out.db, 'sign.request', Number(out.go.split('/').at(-1)));
  assert.deepEqual(request.signer_ids.map((s) => [s.role, s.partner_id]), [['customer', partner.id]]);
});

test('fiscal years revalue foreign balances from the form (nothing to do leaves the books unchanged)', () => {
  const year = create(seed(), 'account.fiscal.year', { name: 'FY 2031', date_from: '2031-01-01', date_to: '2031-12-31' });
  assert.equal(press(year.db, 'account.fiscal.year', year.id, 'Revalue Foreign Currency', ['2031-06-30']).db, year.db);
  assert.throws(() => press(year.db, 'account.fiscal.year', year.id, 'Revalue Foreign Currency', ['2030-12-31']), /inside this open fiscal year/);
  assert.throws(() => press(year.db, 'account.fiscal.year', year.id, 'Revalue Foreign Currency', ['2032-01-01']), /inside this open fiscal year/);
  assert.throws(() => press(year.db, 'account.fiscal.year', year.id, 'Revalue Foreign Currency', ['2031-02-30']), /valid date/);
});

// MOD-007 (5/5): manual entry where the outside channel is simulated, and links to the public pages.
test('shares and published jobs give their public links', () => {
  const share = create(seed(), 'documents.share', { name: 'Board pack' });
  const token = read(share.db, 'documents.share', share.id).token;
  assert.equal(press(share.db, 'documents.share', share.id, 'Share Link').message, `/share/${token}`);
  const job = search(share.db, 'hr.job').find((j) => j.is_published);
  const employee = search(share.db, 'hr.employee')[0];
  assert.match(press(share.db, 'hr.job', job.id, 'Referral Link', [employee.name]).message, new RegExp(`^/#/shop/jobs\\?job=${job.id}&ref=`));
});

test('engagement on a live post is recorded by account and never lowers a counter', () => {
  const db = seed();
  const post = search(db, 'social.post').find((p) => p.stage_id === 'posted' && p.live_post_ids?.length);
  const account = read(db, 'social.account', post.live_post_ids[0].account_id);
  const out = press(db, 'social.post', post.id, 'Record Engagement', [account.name, 500, 1, 20, 50]).db;
  const live = read(out, 'social.post', post.id).live_post_ids[0];
  assert.deepEqual([live.likes, live.comments, live.shares, live.clicks], [500, post.live_post_ids[0].comments, 20, 50]);
  assert.throws(() => press(db, 'social.post', post.id, 'Record Engagement', ['Nobody', 1, 1, 1, 1]), /not live on that account/);
});

test('email opens on a processed marketing activity are recorded by activity number', () => {
  const campaign = create(seed(), 'marketing.campaign', { name: 'Welcome', steps: [{ name: 'Hello', activity_type: 'email' }, { name: 'Follow up', activity_type: 'email', parent: 0, trigger: 'mail_open' }] });
  const participant = create(campaign.db, 'marketing.participant', { campaign_id: campaign.id, name: 'Lina', email: 'lina@example.com', traces: [{ step: 0, state: 'processed' }] });
  const out = press(participant.db, 'marketing.participant', participant.id, 'Record Email Event', [1, 'open']).db;
  assert.deepEqual(read(out, 'marketing.participant', participant.id).traces[0].events, ['open']);
  assert.throws(() => press(participant.db, 'marketing.participant', participant.id, 'Record Email Event', [2, 'open']), /not been sent/);
  assert.throws(() => press(participant.db, 'marketing.participant', participant.id, 'Record Email Event', [1, 'bounce']), /open, click or reply/);
});
