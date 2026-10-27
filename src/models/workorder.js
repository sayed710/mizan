// Manufacturing operations, time tracking, capacity and overhead valuation.
import { create, read, search, write } from '../orm.js';
import { moreModels, explode } from './more.js';
import { accountId, postEntry } from './ledger.js';
import { capitalizeStock, costMethod } from './valuation.js';

const round = (n) => Math.round(n * 100) / 100;
const get = (db, model, id) => {
  const record = read(db, model, id);
  if (!record) throw new Error('Record not found');
  return record;
};
const orders = (db, id) => search(db, 'mrp.workorder').filter((w) => w.production_id === id).sort((a, b) => a.sequence - b.sequence || a.id - b.id);
const stamp = (at = new Date().toISOString()) => {
  if (!Number.isFinite(Date.parse(at))) throw new Error('Enter a valid time');
  return new Date(at).toISOString();
};
const losses = [['productive', 'Productive'], ['reduced', 'Reduced Speed'], ['unplanned', 'Unplanned Stop']];
const duration = (r) => (r.time_ids ?? []).reduce((s, l) => s + (Number(l.minutes) || 0), 0);
const open = (r) => (r.time_ids ?? []).some((l) => !l.date_end);

/** Generate sequential operations once, scaled to the manufacturing quantity. */
export function generateWorkorders(db, productionId) {
  const mo = get(db, 'mrp.production', productionId);
  if (orders(db, productionId).length) return db;
  if (['done', 'cancel'].includes(mo.state)) throw new Error('Cannot plan a closed manufacturing order');
  if (!Number.isFinite(Number(mo.product_qty)) || !(Number(mo.product_qty) > 0)) throw new Error('Manufacturing quantity must be positive');
  const { workorders } = explode(db, mo);
  return workorders.reduce((next, w, i) => {
    const wc = get(next, 'mrp.workcenter', w.workcenter_id);
    if (!Number.isFinite(w.duration_expected) || w.duration_expected < 0) throw new Error('Operation duration must be nonnegative');
    return create(next, 'mrp.workorder', { ...w, production_id: productionId, sequence: i + 1, state: i ? 'pending' : 'ready', blocked_reason: wc.blocked ? wc.blocked_reason || '' : '' }).db;
  }, db);
}

/** Open one employee time log on an available operation. */
export function startWorkorder(db, id, { employeeId, at } = {}) {
  const wo = get(db, 'mrp.workorder', id);
  if (!['ready', 'progress'].includes(wo.state)) throw new Error('Work order must be ready or in progress');
  if (get(db, 'mrp.workcenter', wo.workcenter_id).blocked) throw new Error('Work center is blocked');
  if (['done', 'cancel'].includes(get(db, 'mrp.production', wo.production_id).state)) throw new Error('Manufacturing order is closed');
  get(db, 'hr.employee', employeeId);
  if (search(db, 'mrp.workorder').some((w) => (w.time_ids ?? []).some((l) => l.employee_id === employeeId && !l.date_end))) throw new Error('Employee already has an open time log');
  const date = stamp(at);
  if ((wo.time_ids ?? []).some((l) => l.date_end && Date.parse(l.date_end) > Date.parse(date))) throw new Error('Start time precedes the last time log');
  return write(db, 'mrp.workorder', id, { state: 'progress', date_start: wo.date_start || date, time_ids: [...(wo.time_ids ?? []), { employee_id: employeeId, date_start: date, date_end: null, minutes: 0, loss: 'productive' }] });
}

const closeLogs = (wo, at, loss) => (wo.time_ids ?? []).map((l) => {
  if (l.date_end) return l;
  const minutes = (Date.parse(at) - Date.parse(l.date_start)) / 60000;
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error('End time must follow the start time');
  return { ...l, date_end: at, minutes, loss: loss ?? l.loss ?? 'productive' };
});

/** Close active logs and classify elapsed time, leaving the operation in progress. */
export function pauseWorkorder(db, id, { at, loss = 'productive' } = {}) {
  const wo = get(db, 'mrp.workorder', id);
  if (wo.state !== 'progress' || !open(wo)) throw new Error('No running time log to pause');
  if (!losses.some(([key]) => key === loss)) throw new Error('Choose a valid time loss');
  return write(db, 'mrp.workorder', id, { time_ids: closeLogs(wo, stamp(at), loss) });
}

/** Finish an operation and release its next waiting operation. */
export function finishWorkorder(db, id, { at, qty } = {}) {
  const wo = get(db, 'mrp.workorder', id);
  if (wo.state !== 'progress') throw new Error('Start the work order before finishing');
  const date = stamp(at);
  if ((wo.time_ids ?? []).some((l) => Date.parse(l.date_end || l.date_start) > Date.parse(date))) throw new Error('Finish time precedes a time log');
  const quantity = Number(qty ?? get(db, 'mrp.production', wo.production_id).product_qty);
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error('Produced quantity must be nonnegative');
  let next = write(db, 'mrp.workorder', id, { state: 'done', date_finished: date, qty_produced: quantity, time_ids: closeLogs(wo, date) });
  const following = orders(next, wo.production_id).find((w) => w.state !== 'done' && w.state !== 'cancel');
  if (following?.state === 'pending') next = write(next, 'mrp.workorder', following.id, { state: 'ready' });
  return next;
}

/** Block a center and expose its reason on unfinished operations. */
export function blockWorkcenter(db, workcenterId, reason) {
  get(db, 'mrp.workcenter', workcenterId);
  if (!reason?.trim()) throw new Error('Enter a blocking reason');
  const next = write(db, 'mrp.workcenter', workcenterId, { blocked: true, blocked_reason: reason.trim() });
  return search(next, 'mrp.workorder').filter((w) => w.workcenter_id === workcenterId && !['done', 'cancel'].includes(w.state))
    .reduce((acc, w) => write(acc, 'mrp.workorder', w.id, { blocked_reason: reason.trim() }), next);
}

/** Release a center and clear its operation blocking reasons. */
export function unblockWorkcenter(db, workcenterId) {
  get(db, 'mrp.workcenter', workcenterId);
  const next = write(db, 'mrp.workcenter', workcenterId, { blocked: false, blocked_reason: '' });
  return search(next, 'mrp.workorder').filter((w) => w.workcenter_id === workcenterId && w.blocked_reason)
    .reduce((acc, w) => write(acc, 'mrp.workorder', w.id, { blocked_reason: '' }), next);
}

/** Actual closed-log minutes valued at the center's hourly cost. */
export function workorderCost(db, id) {
  const wo = get(db, 'mrp.workorder', id);
  return round(duration(wo) / 60 * (Number(get(db, 'mrp.workcenter', wo.workcenter_id).costs_hour) || 0));
}

/** Component consumption (or planned BOM consumption) plus recorded operation cost. */
export function productionCost(db, productionId) {
  const mo = get(db, 'mrp.production', productionId);
  const moves = mo.move_raw?.length ? mo.move_raw : explode(db, mo).move_raw;
  const components = round(moves.reduce((s, m) => s + Number(m.consumed === '' ? m.to_consume : m.consumed ?? m.to_consume ?? 0) * (Number(read(db, 'product', m.product_id)?.cost) || 0), 0));
  const operations = round(orders(db, productionId).reduce((s, w) => s + workorderCost(db, w.id), 0));
  return { components, operations, total: round(components + operations) };
}

/** Capitalize completed operation costs once against stock valuation. */
export function postOperationCost(db, productionId) {
  const mo = get(db, 'mrp.production', productionId);
  if (mo.operation_cost_move_id) return db;
  if (orders(db, productionId).some((w) => !['done', 'cancel'].includes(w.state) || open(w))) throw new Error('Finish work orders before posting operation costs');
  const cost = productionCost(db, productionId).operations;
  if (!cost) return db;
  if (read(db, 'product', mo.product_id)?.valuation === 'manual_periodic') return db;
  // A standard-cost product is stocked at its standard: operation costs stay in expenses as part of the variance.
  if (costMethod(db, mo.product_id) === 'standard') return db;
  if (cost < 0 || !accountId(db, '110100') || !accountId(db, '600000')) throw new Error('Operation costs require stock valuation and expense accounts');
  const entry = postEntry(db, { journal: 'MISC', ref: `Operation costs ${mo.name}`, lines: [{ account: '110100', debit: cost }, { account: '600000', credit: cost }] });
  const next = mo.state === 'done' ? capitalizeStock(entry.db, mo.product_id, cost, { reference: `Operation costs ${mo.name}`, moveId: entry.id }) : entry.db;
  return write(next, 'mrp.production', productionId, { operation_cost_move_id: entry.id });
}

const period = ({ from, to }) => {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error('Choose a valid date range');
  return [start, end + 864e5];
};

/** Inclusive Monday-Friday capacity and planned minutes scheduled in the range. */
export function workcenterLoad(db, workcenterId, range) {
  const wc = get(db, 'mrp.workcenter', workcenterId);
  const [start, end] = period(range);
  let days = 0;
  for (let d = start; d < end; d += 864e5) if (![0, 6].includes(new Date(d).getUTCDay())) days++;
  const capacityMinutes = days * Number(wc.capacity ?? 1) * Number(wc.working_hours_per_day ?? 8) * 60 * Number(wc.time_efficiency ?? 100) / 100;
  const plannedMinutes = search(db, 'mrp.workorder').filter((w) => {
    const mo = get(db, 'mrp.production', w.production_id);
    const date = Date.parse(mo.date_start);
    return w.workcenter_id === workcenterId && w.state !== 'cancel' && mo.state !== 'cancel' && date >= start && date < end;
  }).reduce((s, w) => s + Number(w.duration_expected || 0), 0);
  return { plannedMinutes: round(plannedMinutes), capacityMinutes: round(capacityMinutes), load: capacityMinutes > 0 ? round(plannedMinutes / capacityMinutes * 100) : 0 };
}

/** Percent OEE from productive/recorded time, earned expected time and good output. */
export function oee(db, workcenterId, range) {
  get(db, 'mrp.workcenter', workcenterId);
  const [start, end] = period(range);
  let actual = 0;
  let productive = 0;
  let expected = 0;
  const productions = new Map();
  for (const wo of search(db, 'mrp.workorder').filter((w) => w.workcenter_id === workcenterId && w.state !== 'cancel')) {
    let elapsed = 0;
    for (const log of wo.time_ids ?? []) {
      if (!log.date_end) continue;
      const minutes = Math.max(0, Math.min(end, Date.parse(log.date_end)) - Math.max(start, Date.parse(log.date_start))) / 60000;
      actual += minutes;
      elapsed += minutes;
      if (log.loss === 'productive' || !log.loss) productive += minutes;
    }
    const mo = get(db, 'mrp.production', wo.production_id);
    expected += Number(wo.duration_expected || 0) * (Number(wo.qty_produced || 0) / (Number(mo.product_qty) || 1)) * (duration(wo) ? elapsed / duration(wo) : 0);
    const finished = Date.parse(wo.date_finished);
    if (wo.state === 'done' && finished >= start && finished < end) {
      const previous = productions.get(wo.production_id);
      if (!previous || wo.sequence > previous.sequence || (wo.sequence === previous.sequence && wo.id > previous.id)) productions.set(wo.production_id, wo);
    }
  }
  const scrap = search(db, 'stock.scrap').filter((s) => s.state === 'done' && productions.has(s.production_id) && Date.parse(s.date_done) >= start && Date.parse(s.date_done) < end)
    .filter((s) => s.product_id === read(db, 'mrp.production', s.production_id)?.product_id).reduce((s, r) => s + Number(r.scrap_qty || 0), 0);
  const availability = actual ? Math.min(100, productive / actual * 100) : 0;
  const performance = productive ? Math.min(100, expected / productive * 100) : 0;
  const good = [...productions.values()].reduce((s, wo) => s + Number(wo.qty_produced || 0), 0);
  const quality = good + scrap ? good / (good + scrap) * 100 : 100;
  return { availability: round(availability), performance: round(performance), quality: round(quality), oee: round(availability * performance * quality / 10000) };
}

const production = moreModels['mrp.production'];
const center = moreModels['mrp.workcenter'];
const relation = (relation, label) => ({ type: 'many2one', relation, label, required: true });
const number = (label) => ({ type: 'float', label });

export const workorderModels = {
  'mrp.workorder': {
    label: 'Work Orders',
    fields: {
      name: { type: 'char', label: 'Operation', required: true },
      production_id: relation('mrp.production', 'Manufacturing Order'),
      workcenter_id: relation('mrp.workcenter', 'Work Center'),
      sequence: { type: 'integer', label: 'Sequence' },
      duration_expected: number('Expected Duration (min)'),
      duration: { ...number('Actual Duration (min)'), compute: duration },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['pending', 'Waiting for another WO'], ['ready', 'Ready'], ['progress', 'In Progress'], ['done', 'Done'], ['cancel', 'Cancelled']] },
      date_start: { type: 'date', label: 'Started on' },
      date_finished: { type: 'date', label: 'Finished on' },
      employee_id: { type: 'many2one', relation: 'hr.employee', label: 'Operator' },
      qty_produced: number('Quantity Produced'),
      blocked_reason: { type: 'char', label: 'Blocked Reason' },
      time_ids: {
        type: 'one2many', label: 'Time Tracking', readonly: true,
        fields: { employee_id: relation('hr.employee', 'Employee'), date_start: { type: 'date', label: 'Start' }, date_end: { type: 'date', label: 'End' }, minutes: number('Minutes'), loss: { type: 'selection', label: 'Time Type', options: losses } },
        newLine: () => ({ employee_id: null, minutes: 0, loss: 'productive' }),
      },
    },
    defaults: () => ({ state: 'pending', sequence: 1, duration_expected: 0, qty_produced: 0, time_ids: [] }),
    groupBys: ['workcenter_id', 'state', 'production_id'],
    views: ['list', 'kanban', 'gantt'],
    gantt: { start: 'date_start', stop: 'date_finished', row: 'workcenter_id', color: 'state' },
    list: ['sequence', 'name', 'production_id', 'workcenter_id', 'duration_expected', 'duration', 'state'],
    kanban: { title: 'name', lines: ['production_id', 'workcenter_id', 'duration_expected'], badge: 'state' },
    form: {
      title: 'name', statusbar: 'state', lockedWhen: (r) => ['done', 'cancel'].includes(r.state),
      buttons: [
        { label: 'Start', primary: true, when: (r) => ['ready', 'progress'].includes(r.state) && !open(r), run: (db, r) => ({ db: startWorkorder(db, r.id, { employeeId: r.employee_id }) }) },
        { label: 'Pause', when: (r) => r.state === 'progress' && open(r), run: (db, r) => ({ db: pauseWorkorder(db, r.id) }) },
        { label: 'Done', when: (r) => r.state === 'progress', run: (db, r) => ({ db: finishWorkorder(db, r.id, { qty: Number(r.qty_produced) > 0 ? r.qty_produced : undefined }) }) },
        { label: 'Block', when: (r) => !['done', 'cancel'].includes(r.state), run: (db, r) => ({ db: blockWorkcenter(db, r.workcenter_id, r.blocked_reason) }) },
      ],
      groups: [['production_id', 'workcenter_id', 'employee_id', 'sequence'], ['duration_expected', 'duration', 'qty_produced', 'blocked_reason', 'date_start', 'date_finished']],
      tabs: [{ label: 'Time Tracking', fields: ['time_ids'] }], chatter: true,
    },
  },
  'mrp.workcenter': {
    ...center,
    fields: { ...center.fields, oee_target: number('OEE Target (%)'), blocked: { type: 'boolean', label: 'Blocked' }, blocked_reason: { type: 'char', label: 'Blocked Reason' }, working_hours_per_day: number('Working Hours per Day') },
    defaults: () => ({ ...center.defaults(), working_hours_per_day: 8, oee_target: 85, blocked: false }),
    form: { ...center.form, groups: [...center.form.groups, ['working_hours_per_day', 'oee_target', 'blocked', 'blocked_reason']], buttons: [
      { label: 'Block', when: (r) => !r.blocked, run: (db, r) => ({ db: blockWorkcenter(db, r.id, r.blocked_reason) }) },
      { label: 'Unblock', when: (r) => r.blocked, run: (db, r) => ({ db: unblockWorkcenter(db, r.id) }) },
    ] },
  },
  'mrp.production': {
    ...production,
    form: { ...production.form,
      smart: [...(production.form.smart ?? []), { label: 'Work Orders', model: 'mrp.workorder', field: 'production_id', target: 'manufacturing/workorders' }],
      // Produce waits for the work orders, then books their labour cost.
      buttons: [...production.form.buttons.map((b) => (b.label !== 'Produce' ? b : { ...b, run: (db, r) => {
        const open = search(db, 'mrp.workorder').filter((w) => w.production_id === r.id && !['done', 'cancel'].includes(w.state));
        if (open.length) throw new Error(`Finish the work orders first: ${open.map((w) => w.name).join(', ')}`);
        const out = b.run(db, r);
        return { ...out, db: postOperationCost(out.db, r.id) };
      } })), { label: 'Plan Work Orders', when: (r) => !['done', 'cancel'].includes(r.state), run: (db, r) => ({ db: generateWorkorders(db, r.id) }) }],
    },
  },
};
