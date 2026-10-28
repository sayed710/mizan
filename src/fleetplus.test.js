import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { contractsToRenew, fleetPlusModels, fuelEfficiency, renewContract, servicesDue, vehicleCosts } from './models/fleetplus.js';

const vehicle = (db, vals = {}) => create(db, 'fleet.vehicle', { name: 'Test van', ...vals });
const contract = (db, vehicleId, vals = {}) => create(db, 'fleet.contract', {
  name: 'Lease', vehicle_id: vehicleId, start_date: '2024-01-01', expiration_date: '2024-12-31',
  cost_generated: 310, cost_frequency: 'monthly', stage_id: 'open', ...vals,
});
const service = (db, vehicleId, vals = {}) => create(db, 'fleet.service', {
  name: 'Maintenance', vehicle_id: vehicleId, date: '2024-01-01', state: 'done', ...vals,
});
const fuel = (db, vehicleId, odometer, liters, vals = {}) => create(db, 'fleet.fuel.log', {
  vehicle_id: vehicleId, date: '2024-01-20', odometer, liters, price_per_liter: 2, ...vals,
});
const costs = (db, id, from = '2024-01-16', to = '2024-02-14') => vehicleCosts(db, id, { from, to });
const run = (db, id, label) => fleetPlusModels['fleet.service'].form.buttons.find((b) => b.label === label).run(db, read(db, 'fleet.service', id)).db;

test('fleet seed retains legacy service fields, costs and completed status', () => {
  const db = seed();
  assert.equal(search(db, 'fleet.vehicle').length, 2);
  const logs = search(db, 'fleet.service');
  assert.equal(logs.find((r) => r.name === 'Oil change').amount, 85);
  assert.equal(logs.find((r) => r.name === 'Fuel').service_type, 'fuel');
  assert.ok(logs.every((r) => r.stage_id === 'done'));
  assert.equal(costs(db, logs[0].vehicle_id, '2000-01-01', '2100-12-31').services, 145);
  assert.deepEqual(search(db, 'fleet.fuel.log'), []);
  assert.equal(fleetPlusModels['fleet.service'].kanban.groupBy, 'state');
  assert.deepEqual(fleetPlusModels['fleet.service'].pivot, { row: 'vehicle_id', col: 'service_type', measure: 'cost' });
});

test('vehicle costs prorate monthly and yearly contracts, exclude other vehicles and unfinished services', () => {
  const base = vehicle(seed());
  let db = service(base.db, base.id, { date: '2024-01-20', cost: 100 }).db;
  db = service(db, base.id, { date: '2024-01-20', cost: 999, state: 'cancelled' }).db;
  db = service(db, base.id, { date: '2024-01-20', cost: 999, state: 'running' }).db;
  db = service(db, base.id, { date: '2023-12-31', cost: 999 }).db;
  db = service(db, 1, { date: '2024-01-20', cost: 999 }).db;
  db = fuel(db, base.id, 1000, 10).db;
  db = fuel(db, base.id, 1100, 20, { date: '2024-02-14' }).db;
  db = contract(db, base.id).db;
  db = contract(db, base.id, { cost_frequency: 'yearly', cost_generated: 3720 }).db;
  db = contract(db, base.id, { cost_frequency: 'no', cost_generated: 999 }).db;
  db = contract(db, base.id, { start_date: '2024-03-01' }).db;
  db = contract(db, 1).db;
  const before = structuredClone(db);
  const report = costs(db, base.id);
  const recurring = 2 * (310 * 16 / 31 + 310 * 14 / 29);
  assert.equal(report.services, 100);
  assert.equal(report.fuel, 60);
  assert.ok(Math.abs(report.contracts - recurring) < 1e-9);
  assert.equal(report.total, report.services + report.fuel + report.contracts);
  assert.equal(report.km, 100);
  assert.equal(report.perKm, report.total / 100);
  assert.deepEqual(db, before);
});

test('contract cost clips both boundaries and closed historical contracts retain their expense', () => {
  const base = vehicle(seed());
  const db = contract(base.db, base.id, { start_date: '2024-01-20', expiration_date: '2024-01-25', stage_id: 'closed' }).db;
  assert.equal(costs(db, base.id, '2024-01-01', '2024-01-31').contracts, 60);
  assert.equal(costs(db, base.id, '2024-01-25', '2024-01-25').contracts, 10);
  assert.equal(costs(db, base.id, '2024-02-01', '2024-02-29').contracts, 0);
  assert.throws(() => costs(db, base.id, '2024-02-01', '2024-01-01'), /date range/);
  assert.throws(() => costs(db, base.id, '2024-02-30', '2024-03-01'), /date range/);
});

test('distance uses in-period odometer readings and returns null unit costs without distance', () => {
  const base = vehicle(seed());
  let db = base.db;
  for (const [date, value] of [['2023-12-31', 900], ['2024-01-01', 1000], ['2024-01-31', 1500], ['2024-02-01', 1600]]) {
    db = create(db, 'fleet.odometer', { vehicle_id: base.id, date, value }).db;
  }
  assert.equal(costs(db, base.id, '2024-01-01', '2024-01-31').km, 500);
  assert.equal(costs(db, base.id, '2024-01-01', '2024-01-01').perKm, null);
  assert.deepEqual(costs(db, base.id, '2025-01-01', '2025-01-31'), { services: 0, fuel: 0, contracts: 0, total: 0, perKm: null, km: 0 });
});

test('fuel efficiency sorts fills by mileage, excludes the first fill and weights consecutive distances', () => {
  const base = vehicle(seed());
  assert.equal(fuelEfficiency(base.db, base.id), null);
  let db = fuel(base.db, base.id, 1600, 40).db;
  assert.equal(fuelEfficiency(db, base.id), null);
  db = fuel(db, base.id, 1000, 99).db;
  db = fuel(db, base.id, 1200, 20).db;
  db = fuel(db, 1, 1800, 999).db;
  assert.equal(fuelEfficiency(db, base.id), 10);
  assert.equal(read(db, 'fleet.fuel.log', 1).amount, 80);
});

test('partial fuel fills count only between full tanks; invalid fuel input is rejected', () => {
  const base = vehicle(seed());
  let db = fuel(base.db, base.id, 1000, 50).db;
  db = fuel(db, base.id, 1100, 10, { full: false }).db;
  assert.equal(fuelEfficiency(db, base.id), null);
  db = fuel(db, base.id, 1300, 20).db;
  db = fuel(db, base.id, 1400, 50, { full: false }).db;
  assert.equal(fuelEfficiency(db, base.id), 10);
  assert.throws(() => fuel(db, base.id, -1, 10), /non-negative/);
  assert.throws(() => fuel(db, base.id, 1500, -1), /non-negative/);
});

test('renewal preserves terms and inclusive duration, closes the old record and is immutable', () => {
  const base = vehicle(seed());
  const old = contract(base.db, base.id, { start_date: '2024-02-01', expiration_date: '2024-02-29', vendor_id: 2, contract_type: 'insurance' });
  const before = structuredClone(old.db);
  const renewed = renewContract(old.db, read(old.db, 'fleet.contract', old.id));
  const next = read(renewed.db, 'fleet.contract', renewed.id);
  assert.equal(next.start_date, '2024-03-01');
  assert.equal(next.expiration_date, '2024-03-29');
  assert.equal(next.stage_id, 'futur');
  for (const key of ['vehicle_id', 'vendor_id', 'contract_type', 'cost_generated', 'cost_frequency']) {
    assert.equal(next[key], read(old.db, 'fleet.contract', old.id)[key]);
  }
  assert.equal(read(renewed.db, 'fleet.contract', old.id).stage_id, 'closed');
  assert.deepEqual(old.db, before);
  assert.throws(() => renewContract(renewed.db, { id: old.id }), /closed or renewed/);
  assert.throws(() => renewContract(old.db, { id: 99999 }), /existing contract/);
  const invalid = write(old.db, 'fleet.contract', old.id, { expiration_date: '2024-01-31' });
  assert.throws(() => renewContract(invalid, { id: old.id }), /date range/);
});

test('renewal reminders include both date boundaries, exclude past, distant and renewed contracts', () => {
  const base = vehicle(seed());
  let db = base.db;
  for (const [expiration_date, stage_id] of [['2024-06-01', 'open'], ['2024-07-01', 'expired'], ['2024-05-31', 'open'], ['2024-07-02', 'open'], ['2024-06-15', 'closed']]) {
    db = contract(db, base.id, { expiration_date, stage_id }).db;
  }
  assert.deepEqual(contractsToRenew(db, '2024-06-01').map((r) => r.expiration_date), ['2024-06-01', '2024-07-01']);
  assert.equal(contractsToRenew(db, '2024-06-01', 0).length, 1);
  const renewed = renewContract(db, contractsToRenew(db, '2024-06-01')[0]);
  assert.ok(!contractsToRenew(renewed.db, '2024-06-01').some((r) => r.id === 1));
  assert.throws(() => contractsToRenew(db, '2024-06-01', -1), /non-negative integer/);
  assert.throws(() => contractsToRenew(db, 'not a date'), /date range/);
});

test('services due uses the latest completed service and inclusive date or mileage thresholds', () => {
  const byDate = vehicle(seed(), { name: 'Date due' });
  const byKm = vehicle(byDate.db, { name: 'Mileage due', odometer: 2000 });
  const notDue = vehicle(byKm.db, { name: 'Not due', odometer: 1000 });
  let db = service(notDue.db, byDate.id, { next_due_date: '2024-06-01' }).db;
  db = service(db, byKm.id, { next_due_km: 2000 }).db;
  db = service(db, notDue.id, { next_due_date: '2024-01-01', next_due_km: 100 }).db;
  db = service(db, notDue.id, { date: '2024-02-01', next_due_date: '2024-06-02', next_due_km: 1001 }).db;
  db = service(db, byDate.id, { date: '2024-03-01', state: 'cancelled', next_due_date: '2025-01-01' }).db;
  assert.deepEqual(servicesDue(db, '2024-06-01').map((r) => r.name), ['Date due', 'Mileage due']);
  assert.deepEqual(servicesDue(db, '2024-05-31').map((r) => r.name), ['Mileage due']);
});

test('service buttons enforce transitions and synchronize legacy writable fields without mutating input', () => {
  const base = vehicle(seed());
  const log = service(base.db, base.id, { state: 'new', cost: 50 });
  const running = run(log.db, log.id, 'Start');
  assert.equal(read(log.db, 'fleet.service', log.id).state, 'new');
  assert.equal(read(running, 'fleet.service', log.id).stage_id, 'running');
  const done = run(running, log.id, 'Done');
  assert.equal(read(done, 'fleet.service', log.id).state, 'done');
  assert.throws(() => run(done, log.id, 'Cancel'), /status change/);
  assert.equal(read(run(log.db, log.id, 'Cancel'), 'fleet.service', log.id).state, 'cancelled');
  const changed = write(log.db, 'fleet.service', log.id, { amount: 75, stage_id: 'running' });
  assert.equal(read(changed, 'fleet.service', log.id).cost, 75);
  assert.equal(read(changed, 'fleet.service', log.id).state, 'running');
  assert.equal(read(write(changed, 'fleet.service', log.id, { cost: 80 }), 'fleet.service', log.id).amount, 80);
});
