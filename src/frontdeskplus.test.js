import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { checkIn, checkOut, checkOutAll, frontdeskPlusModels, onSite, planVisit, serveDrink, visitorReport } from './models/frontdeskplus.js';

const MODEL = 'frontdesk.visitor';
const at = (time, date = '2026-05-10') => `${date}T${time}:00Z`;
const setup = (values = {}) => create(seed(), 'frontdesk.station', { name: 'Reception', drink_offer: true, drink_ids: [{ name: 'Tea' }, { name: 'Water' }], ...values });
const plan = (db, stationId, generate = () => 'BADGE1') => planVisit(db, { name: 'Guest', hostId: 2, date: '2026-05-10', time: '23:00', stationId, email: 'guest@example.com', company: 'Guest Co' }, generate);

test('planning preserves input and retries badge collisions, including archived badges', () => {
  const station = setup();
  const snapshot = structuredClone(station.db);
  const first = plan(station.db, station.id);
  assert.deepEqual(station.db, snapshot);
  const r = read(first.db, MODEL, first.id);
  assert.deepEqual([r.stage_id, r.planned_date, r.planned_time, r.badge_code], ['planned', '2026-05-10', '23:00', 'BADGE1']);
  let calls = 0;
  const archived = write(first.db, MODEL, first.id, { active: false });
  const second = plan(archived, station.id, () => ++calls === 1 ? 'BADGE1' : 'BADGE2');
  assert.equal(read(second.db, MODEL, second.id).badge_code, 'BADGE2');
  assert.equal(calls, 2);
  assert.throws(() => plan(first.db, station.id), /unique badge/);
  assert.throws(() => write(second.db, MODEL, second.id, { badge_code: 'BADGE1' }), /unique/);
  assert.throws(() => planVisit(station.db, { name: 'Guest', date: '2026-02-30', time: '09:00' }), /valid date/);
  assert.throws(() => planVisit(station.db, { name: 'Guest', date: '2026-05-10', time: '24:00' }), /valid planned time/);
});

test('badge check-in reuses the visit and refuses unknown, used, canceled and wrong-station badges', () => {
  const station = setup();
  const planned = plan(station.db, station.id);
  const checked = checkIn(planned.db, { stationId: station.id, badgeCode: 'BADGE1' }, at('23:00'));
  assert.equal(checked.id, planned.id);
  assert.equal(search(checked.db, MODEL).length, search(planned.db, MODEL).length);
  assert.equal(read(checked.db, MODEL, checked.id).check_in, '23:00');
  assert.equal(read(planned.db, MODEL, planned.id).stage_id, 'planned');
  assert.throws(() => checkIn(planned.db, { badgeCode: 'UNKNOWN' }, at('23:00')), /Unknown/);
  assert.throws(() => checkIn(checked.db, { badgeCode: 'BADGE1' }, at('23:01')), /already used/);
  const closed = checkOut(checked.db, checked.id, at('23:30'));
  assert.throws(() => checkIn(closed, { badgeCode: 'BADGE1' }, at('23:40')), /already used/);
  const canceled = write(planned.db, MODEL, planned.id, { stage_id: 'canceled' });
  assert.throws(() => checkIn(canceled, { badgeCode: 'BADGE1' }, at('23:00')), /no longer planned/);
  const other = create(planned.db, 'frontdesk.station', { name: 'Other' });
  assert.throws(() => checkIn(other.db, { stationId: other.id, badgeCode: 'BADGE1' }, at('23:00')), /another station/);
});

test('walk-ins enforce station requirements, host validity, offered drinks and duplicate arrivals', () => {
  const station = setup({ ask_phone: 'required', ask_email: 'required', ask_company: 'required' });
  const input = { stationId: station.id, name: 'Walk In', hostId: 2 };
  assert.throws(() => checkIn(station.db, input, at('10:00')), /Phone is required/);
  assert.throws(() => checkIn(station.db, { ...input, phone: '123' }, at('10:00')), /Email is required/);
  assert.throws(() => checkIn(station.db, { ...input, phone: '123', email: 'visitor@example.com' }, at('10:00')), /Company is required/);
  const complete = { ...input, phone: '123', email: 'visitor@example.com', company: 'Company', drink: 0 };
  assert.throws(() => checkIn(station.db, { ...complete, hostId: 9999 }, at('10:00')), /Host not found/);
  assert.throws(() => checkIn(station.db, { ...complete, drink: 'Coffee' }, at('10:00')), /offered/);
  assert.throws(() => checkIn(station.db, { ...complete, stationId: 9999 }, at('10:00')), /Station not found/);
  assert.throws(() => checkIn(station.db, complete, 'invalid'), /ISO/);
  const checked = checkIn(station.db, complete, at('10:00'));
  assert.equal(read(checked.db, MODEL, checked.id).drink_id, 'Tea');
  assert.throws(() => checkIn(checked.db, { ...complete, name: ' walk in ' }, at('10:01')), /already checked in/);
  const served = serveDrink(checked.db, checked.id);
  assert.equal(read(served, MODEL, checked.id).drink_served, true);
  assert.equal(read(checked.db, MODEL, checked.id).drink_served, false);
  assert.throws(() => serveDrink(served, checked.id), /already been served/);
  assert.throws(() => serveDrink(checkOut(checked.db, checked.id, at('11:00')), checked.id), /checked-in/);
});

test('host notifications are immutable chatter notes on the host and visit, not external sends', () => {
  const station = setup({ notify_host: 'both' });
  const checked = checkIn(station.db, { stationId: station.id, name: 'Guest', hostId: 2 }, at('10:00'));
  const host = read(checked.db, 'hr.employee', 2);
  const notes = checked.db.messages.filter((m) => m.kind === 'note' && m.body.includes('Guest has checked in'));
  assert.equal(notes.length, 2);
  assert.ok(notes.some((m) => m.model === 'hr.employee' && m.res_id === host.id && m.body.includes(host.work_email) && m.body.includes('both')));
  assert.ok(notes.some((m) => m.model === MODEL && m.res_id === checked.id));
  assert.equal(read(checked.db, MODEL, checked.id).host_notified, true);
  const unhosted = checkIn(station.db, { stationId: station.id, name: 'Unhosted' }, at('10:00'));
  assert.equal(read(unhosted.db, MODEL, unhosted.id).host_notified, false);
  assert.equal(unhosted.db.messages.filter((m) => m.kind === 'note').length, station.db.messages.filter((m) => m.kind === 'note').length);
});

test('checkout computes overnight hours and rejects invalid transitions and earlier departures', () => {
  const station = setup();
  const checked = checkIn(station.db, { stationId: station.id, name: 'Night Guest' }, at('23:30'));
  assert.throws(() => checkOut(checked.db, checked.id, at('23:29')), /precede/);
  const closed = checkOut(checked.db, checked.id, at('01:00', '2026-05-11'));
  const r = read(closed, MODEL, checked.id);
  assert.deepEqual([r.stage_id, r.check_out, r.check_out_date, r.duration], ['checked_out', '01:00', '2026-05-11', 1.5]);
  assert.equal(frontdeskPlusModels[MODEL].fields.duration.compute(r), 1.5);
  assert.equal(read(checked.db, MODEL, checked.id).duration, 0);
  assert.throws(() => checkOut(closed, checked.id, at('02:00', '2026-05-11')), /not checked in/);
  assert.throws(() => checkOut(closed, 99999, at('02:00')), /Visitor not found/);
});

test('on-site evacuation list joins hosts, excludes future arrivals; checkout-all only closes those present', () => {
  const station = setup();
  const first = checkIn(station.db, { stationId: station.id, name: 'First', hostId: 2 }, at('10:00'));
  const second = checkIn(first.db, { stationId: station.id, name: 'Second' }, at('11:00'));
  const future = checkIn(second.db, { stationId: station.id, name: 'Future' }, at('10:00', '2026-05-11'));
  const planned = plan(future.db, station.id);
  const rows = onSite(planned.db, at('23:59'));
  assert.deepEqual(rows.map((r) => r.id), [first.id, second.id]);
  assert.equal(rows[0].host.name, read(planned.db, 'hr.employee', 2).name);
  assert.equal(rows[1].host, null);
  const closed = checkOutAll(planned.db, at('23:59'));
  assert.equal(read(closed, MODEL, first.id).stage_id, 'checked_out');
  assert.equal(read(closed, MODEL, second.id).stage_id, 'checked_out');
  assert.equal(read(closed, MODEL, future.id).stage_id, 'checked_in');
  assert.equal(read(closed, MODEL, planned.id).stage_id, 'planned');
  assert.deepEqual(onSite(closed, at('23:59')), []);
  assert.deepEqual(checkOutAll(closed, at('23:59')), closed);
});

test('report counts actual arrivals inclusively by date and host, averaging completed visits only', () => {
  const station = setup();
  const first = checkIn(station.db, { stationId: station.id, name: 'First', hostId: 2 }, at('10:00'));
  const closed = checkOut(first.db, first.id, at('12:00'));
  const second = checkIn(closed, { stationId: station.id, name: 'Second', hostId: 2 }, at('23:30'));
  const overnight = checkOut(second.db, second.id, at('00:30', '2026-05-11'));
  const open = checkIn(overnight, { stationId: station.id, name: 'Open' }, at('10:00', '2026-05-11'));
  const planned = plan(open.db, station.id);
  const report = visitorReport(planned.db, { from: '2026-05-10', to: '2026-05-11' });
  assert.deepEqual([report.count, report.average_duration], [3, 1.5]);
  assert.deepEqual(report.perDay, [{ date: '2026-05-10', count: 2, average_duration: 1.5 }, { date: '2026-05-11', count: 1, average_duration: 0 }]);
  assert.deepEqual(report.perHost.map((r) => [r.host_id, r.count, r.average_duration]), [[2, 2, 1.5], [null, 1, 0]]);
  assert.equal(visitorReport(planned.db, { from: '2026-05-11', to: '2026-05-11' }).count, 1);
  assert.equal(visitorReport(planned.db, { from: '2025-01-01', to: '2025-01-02' }).average_duration, 0);
  assert.throws(() => visitorReport(planned.db, { from: '2026-05-11', to: '2026-05-10' }), /end date/);
});

test('seed and legacy visitor fields survive; forms expose station settings and visitor actions', () => {
  const db = seed();
  const visitor = search(db, MODEL).find((r) => r.name === 'Ali Mansour');
  assert.equal(visitor.stage_id, 'planned');
  assert.equal(visitor.host_id, 2);
  const model = frontdeskPlusModels[MODEL];
  assert.equal(model.kanban.groupBy, 'stage_id');
  assert.deepEqual(model.form.buttons.map((b) => b.label), ['Check In', 'Check Out', 'Drink Served', 'Cancel']);
  assert.equal(model.filters[0][0].fn({ stage_id: 'checked_in' }), true);
  assert.equal(frontdeskPlusModels['frontdesk.station'].form.tabs[0].fields[0], 'drink_ids');
  const checked = model.form.buttons[0].run(db, visitor).db;
  assert.equal(read(checked, MODEL, visitor.id).stage_id, 'checked_in');
  assert.throws(() => model.form.buttons[0].run(checked, visitor), /already used|not available/);
  const canceled = model.form.buttons[3].run(db, visitor).db;
  assert.equal(read(canceled, MODEL, visitor.id).stage_id, 'canceled');
});
