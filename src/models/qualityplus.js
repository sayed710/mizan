import { create, read, write } from '../orm.js';
import { pad, today } from './common.js';

const testTypes = [['pass_fail', 'Pass - Fail'], ['measure', 'Measure'], ['instructions', 'Instructions'], ['picture', 'Picture']];
const operations = [['receipt', 'Receipts'], ['delivery', 'Deliveries'], ['manufacturing', 'Manufacturing']];
const frequencies = [['all', 'All'], ['random', 'Random'], ['periodic', 'Periodic']];
const results = [['none', 'To Do'], ['pass', 'Passed'], ['fail', 'Failed']];

/** A measured value passes when it is inside the point's inclusive tolerance range. */
export function evaluateMeasure(point, value) {
  if (typeof value === 'boolean' || value == null || String(value).trim() === '') return 'fail';
  const measure = Number(value);
  if (!Number.isFinite(measure)) return 'fail';
  const min = point?.tolerance_min ?? point?.norm_min;
  const max = point?.tolerance_max ?? point?.norm_max;
  const aboveMin = min == null || min === '' || (Number.isFinite(Number(min)) && measure >= Number(min));
  const belowMax = max == null || max === '' || (Number.isFinite(Number(max)) && measure <= Number(max));
  return aboveMin && belowMax ? 'pass' : 'fail';
}

const pointAppliesByFrequency = (point, picking) => {
  if (point.frequency === 'random') {
    return ((Number(picking.id) * 7919 + Number(point.id)) % 100) < (Number(point.frequency_pct) || 0);
  }
  return point.frequency === 'all' || point.frequency === 'periodic';
};

/** Return the control points matching a transfer type, its products and configured frequency. */
export function checksFor(db, picking) {
  const operation = picking.picking_type === 'incoming' ? 'receipt' : picking.picking_type === 'outgoing' ? 'delivery' : null;
  if (!operation) return [];
  const productIds = new Set((picking.move_ids ?? []).map((line) => line.product_id).filter((id) => id != null));
  if (!productIds.size) return [];
  return (db.records['quality.point'] ?? []).filter((point) =>
    point.active !== false && point.operation === operation
      && (point.product_id == null || productIds.has(point.product_id))
      && pointAppliesByFrequency(point, picking));
}

/** Create one pending check per applicable point and relevant product; repeated calls are safe. */
export function createChecks(db, picking) {
  return checksFor(db, picking).reduce((acc, point) => {
    const productIds = point.product_id == null
      ? [...new Set((picking.move_ids ?? []).map((line) => line.product_id).filter((id) => id != null))]
      : [point.product_id];
    return productIds.reduce((next, productId) => {
      const exists = (next.records['quality.check'] ?? []).some((check) =>
        check.picking_id === picking.id && check.point_id === point.id && check.product_id === productId);
      if (exists) return next;
      return create(next, 'quality.check', {
        point_id: point.id,
        picking_id: picking.id,
        product_id: productId,
        test_type: point.test_type,
        norm_min: point.tolerance_min,
        norm_max: point.tolerance_max,
        note: point.instructions ?? '',
        date: today(),
        result: 'none',
      }).db;
    }, acc);
  }, db);
}

/** Pending checks keep a transfer from validation; failed checks are reported for follow-up. */
export function canValidatePicking(db, picking) {
  const checks = (db.records['quality.check'] ?? []).filter((check) => check.picking_id === picking.id);
  const pending = checks.filter((check) => check.result === 'none').length;
  const failed = checks.filter((check) => check.result === 'fail').length;
  return { ok: pending === 0, pending, failed };
}

/** Create an alert linked to a failed check, returning the existing linked alert on retries. */
export function alertFromCheck(db, check) {
  if (check?.result !== 'fail') throw new Error('Only failed quality checks can create alerts');
  const existing = check.id == null ? null : (db.records['quality.alert'] ?? []).find((alert) => alert.check_id === check.id);
  if (existing) return { db, id: existing.id };
  const { db: next, id } = create(db, 'quality.alert', {
    name: `Quality alert: ${check.name ?? `QC/${pad(check.id ?? 0)}`}`,
    check_id: check.id ?? null,
    product_id: check.product_id ?? null,
    picking_id: check.picking_id ?? null,
    user_id: check.user_id ?? null,
    description: `Created from failed quality check ${check.name ?? ''}`.trim(),
  });
  return { db: next, id };
}

/** Counts checks in the inclusive date range; passRate is the percentage of resolved checks that passed. */
export function qualityStats(db, { from, to } = {}) {
  const checks = (db.records['quality.check'] ?? []).filter((check) =>
    (!from || (check.date != null && check.date >= from))
      && (!to || (check.date != null && check.date <= to)));
  const passed = checks.filter((check) => check.result === 'pass').length;
  const failed = checks.filter((check) => check.result === 'fail').length;
  const resolved = passed + failed;
  const openAlerts = (db.records['quality.alert'] ?? []).filter((alert) => alert.stage_id !== 'solved').length;
  return {
    checks: checks.length,
    passed,
    failed,
    passRate: resolved ? Math.round((passed / resolved) * 10000) / 100 : 0,
    openAlerts,
  };
}

function measureButton(db, check) {
  const initial = check.measure == null ? '' : String(check.measure);
  const input = globalThis.prompt?.('Measured value', initial);
  if (input == null || String(input).trim() === '') return { db };
  const value = Number(input);
  if (!Number.isFinite(value)) return { db };
  const point = read(db, 'quality.point', check.point_id);
  const tolerance = point ?? { tolerance_min: check.norm_min, tolerance_max: check.norm_max };
  const next = write(db, 'quality.check', check.id, {
    measure: value,
    result: evaluateMeasure(tolerance, value),
    date: today(),
  });
  return { db: next };
}

function validateMeasureButton(db, check) {
  const value = Number(check.measure);
  if (!Number.isFinite(value)) return { db };
  const point = read(db, 'quality.point', check.point_id);
  const tolerance = point ?? { tolerance_min: check.norm_min, tolerance_max: check.norm_max };
  return { db: write(db, 'quality.check', check.id, { result: evaluateMeasure(tolerance, value), date: today() }) };
}

export const qualityPlusModels = {
  'quality.point': {
    label: 'Control Points',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      product_id: { type: 'many2one', relation: 'product', label: 'Product' },
      operation: { type: 'selection', label: 'Operation', options: operations },
      test_type: { type: 'selection', label: 'Test Type', options: testTypes },
      norm: { type: 'float', label: 'Norm' },
      tolerance_min: { type: 'float', label: 'Min Tolerance' },
      tolerance_max: { type: 'float', label: 'Max Tolerance' },
      unit: { type: 'char', label: 'Unit' },
      instructions: { type: 'text', label: 'Instructions' },
      frequency: { type: 'selection', label: 'Frequency', options: frequencies },
      frequency_pct: { type: 'integer', label: 'Frequency (%)' },
    },
    kanban: { title: 'name', lines: ['operation', 'test_type'] },
    list: ['name', 'product_id', 'operation', 'test_type', 'frequency'],
    defaults: (id) => ({ name: `CP/${pad(id)}`, operation: 'receipt', test_type: 'pass_fail', norm: 0, frequency: 'all', frequency_pct: 0 }),
    groupBys: ['operation', 'test_type', 'frequency'],
    form: {
      title: 'name',
      groups: [['name', 'product_id', 'operation', 'test_type'], ['norm', 'tolerance_min', 'tolerance_max', 'unit', 'frequency', 'frequency_pct']],
      tabs: [{ label: 'Instructions', fields: ['instructions'] }],
      chatter: true,
    },
  },
  'quality.check': {
    label: 'Quality Checks',
    fields: {
      name: { type: 'char', label: 'Reference', readonly: true },
      point_id: { type: 'many2one', relation: 'quality.point', label: 'Control Point' },
      picking_id: { type: 'many2one', relation: 'stock.picking', label: 'Transfer' },
      production_id: { type: 'many2one', relation: 'mrp.production', label: 'Manufacturing Order' },
      product_id: { type: 'many2one', relation: 'product', label: 'Product', required: true },
      test_type: { type: 'selection', label: 'Type', options: testTypes },
      measure: { type: 'float', label: 'Measure' },
      norm_min: { type: 'float', label: 'Min Tolerance' },
      norm_max: { type: 'float', label: 'Max Tolerance' },
      user_id: { type: 'many2one', relation: 'hr.employee', label: 'Responsible' },
      user: { type: 'char', label: 'User' },
      result: { type: 'selection', label: 'Status', tracking: true, options: results },
      note: { type: 'text', label: 'Instructions' },
      picture: { type: 'binary', label: 'Picture' },
      date: { type: 'date', label: 'Date' },
    },
    kanban: { groupBy: 'result', title: 'name', lines: ['product_id', 'test_type'] },
    list: ['name', 'product_id', 'picking_id', 'test_type', 'measure', 'user_id', 'result'],
    defaults: (id) => ({ name: `QC/${pad(id)}`, test_type: 'pass_fail', result: 'none', date: today() }),
    groupBys: ['product_id', 'result'],
    form: {
      statusbar: 'result',
      title: 'name',
      groups: [['point_id', 'product_id', 'picking_id', 'production_id'], ['test_type', 'measure', 'norm_min', 'norm_max', 'result', 'date', 'user_id', 'user']],
      chatter: true,
      buttons: [
        { label: 'Pass', primary: true, when: (record) => record.result === 'none', vals: { result: 'pass' } },
        { label: 'Fail', when: (record) => record.result === 'none', vals: { result: 'fail' } },
        { label: 'Measure', primary: true, when: (record) => record.result === 'none' && record.test_type === 'measure', run: measureButton },
        // Preserve the earlier button label for existing saved views and seed workflows.
        { label: 'Validate Measure', when: (record) => record.result === 'none' && record.test_type === 'measure', run: validateMeasureButton },
        {
          label: 'Create Alert',
          when: (record) => record.result === 'fail',
          run: (db, record) => {
            const alert = alertFromCheck(db, record);
            return { ...alert, go: `#/quality/alerts/${alert.id}` };
          },
        },
      ],
      tabs: [{ label: 'Instructions', fields: ['note', 'picture'] }],
    },
  },
  'quality.alert': {
    label: 'Quality Alerts',
    fields: {
      name: { type: 'char', label: 'Title', required: true },
      check_id: { type: 'many2one', relation: 'quality.check', label: 'Quality Check' },
      product_id: { type: 'many2one', relation: 'product', label: 'Product' },
      picking_id: { type: 'many2one', relation: 'stock.picking', label: 'Transfer' },
      user_id: { type: 'many2one', relation: 'hr.employee', label: 'Responsible' },
      priority: { type: 'priority', label: 'Priority' },
      description: { type: 'text', label: 'Description' },
      root_cause: { type: 'char', label: 'Root Cause' },
      corrective_action: { type: 'text', label: 'Corrective Action' },
      preventive_action: { type: 'text', label: 'Preventive Action' },
      stage_id: { type: 'selection', label: 'Stage', tracking: true, options: [['new', 'New'], ['confirmed', 'Confirmed'], ['action', 'Action Proposed'], ['solved', 'Solved']] },
    },
    kanban: { groupBy: 'stage_id', title: 'name', lines: ['product_id', 'user_id'] },
    list: ['name', 'product_id', 'check_id', 'user_id', 'stage_id'],
    defaults: () => ({ priority: 0, stage_id: 'new' }),
    groupBys: ['stage_id', 'product_id'],
    form: {
      statusbar: 'stage_id',
      statusbarClickable: true,
      title: 'name',
      groups: [['name', 'check_id', 'product_id', 'picking_id', 'user_id', 'priority'], ['root_cause', 'corrective_action', 'preventive_action']],
      chatter: true,
      tabs: [{ label: 'Description', fields: ['description'] }],
    },
  },
};
