import { REPORT_DATE_SCOPES, REPORT_ENGINES, validateReportExpressions } from './reportEngine.js';

const label = (type, text, extra = {}) => ({ type, label: text, ...extra });
const related = (model, field, id, db) => (db.records?.[model] ?? []).filter((record) => record[field] === id);

function lineGuard(db, before, line) {
  const report = (db.records['account.report'] ?? []).find((item) => item.id === line.report_id);
  if (!report) return 'Select an existing report';
  if ((line.company_id ?? 1) !== (report.company_id ?? 1)) return 'Report line company must match the report';
  const siblings = related('account.report.line', 'report_id', line.report_id, db).filter((item) => item.id !== line.id);
  if (line.code && siblings.some((item) => item.code === line.code)) return `Duplicate report line code: ${line.code}`;
  let parent = line.parent_id;
  const visited = new Set([line.id]);
  while (parent) {
    if (visited.has(parent)) return 'Report line parent cycle';
    visited.add(parent);
    const row = siblings.find((item) => item.id === parent);
    if (!row) return 'Parent line must belong to the same report';
    parent = row.parent_id;
  }
  return null;
}

function expressionGuard(db, before, expression) {
  const line = (db.records['account.report.line'] ?? []).find((item) => item.id === expression.report_line_id);
  if (!line) return 'Select an existing report line';
  if ((expression.company_id ?? 1) !== (line.company_id ?? 1)) return 'Expression company must match the report line';
  const lines = related('account.report.line', 'report_id', line.report_id, db);
  const ids = new Set(lines.map((item) => item.id));
  const expressions = (db.records['account.report.expression'] ?? []).filter((item) => ids.has(item.report_line_id) && item.id !== expression.id);
  return validateReportExpressions(lines, [...expressions, expression]);
}

export const reportRecordModels = {
  'account.report.line': {
    label: 'Accounting Report Lines',
    fields: {
      report_id: label('many2one', 'Report', { relation: 'account.report', required: true }),
      parent_id: label('many2one', 'Parent Line', { relation: 'account.report.line' }),
      children_ids: label('one2many', 'Child Lines', {
        relation: 'account.report.line',
        fields: {
          name: label('char', 'Name'),
          code: label('char', 'Code'),
          sequence: label('integer', 'Sequence'),
        },
        compute: (line, db) => related('account.report.line', 'parent_id', line.id, db),
      }),
      sequence: label('integer', 'Sequence'), name: label('char', 'Name', { required: true }), code: label('char', 'Code'),
      hierarchy_level: label('integer', 'Level'), strong: label('boolean', 'Emphasized'), foldable: label('boolean', 'Foldable'), hide_if_zero: label('boolean', 'Hide if Zero'),
      print_on_new_page: label('boolean', 'Print on New Page'), groupby: label('char', 'Group By'),
      expression_ids: label('one2many', 'Expressions', {
        relation: 'account.report.expression',
        fields: {
          label: label('char', 'Label'),
          engine: label('selection', 'Computation Engine', { options: REPORT_ENGINES.map((value) => [value, value]) }),
          formula: label('text', 'Formula'),
          subformula: label('char', 'Subformula'),
          date_scope: label('selection', 'Date Scope', { options: REPORT_DATE_SCOPES.map((value) => [value, value]) }),
        },
        compute: (line, db) => related('account.report.expression', 'report_line_id', line.id, db),
      }),
    },
    defaults: () => ({ sequence: 10, hierarchy_level: 0, foldable: false, hide_if_zero: false, print_on_new_page: false }),
    guard: lineGuard,
    list: ['name', 'code', 'report_id', 'sequence'],
    form: { title: 'name', groups: [['report_id', 'parent_id', 'sequence'], ['code', 'hierarchy_level', 'groupby'], ['foldable', 'hide_if_zero', 'print_on_new_page']], tabs: [{ label: 'Expressions', fields: ['expression_ids'] }] },
  },
  'account.report.expression': {
    label: 'Accounting Report Expressions',
    fields: {
      report_line_id: label('many2one', 'Report Line', { relation: 'account.report.line', required: true }),
      label: label('char', 'Label', { required: true }),
      engine: label('selection', 'Computation Engine', { required: true, options: REPORT_ENGINES.map((value) => [value, value]) }),
      formula: label('text', 'Formula', { required: true }), subformula: label('char', 'Subformula'),
      date_scope: label('selection', 'Date Scope', { required: true, options: REPORT_DATE_SCOPES.map((value) => [value, value]) }),
      carryover_target: label('char', 'Carry Over To'), green_on_positive: label('boolean', 'Is Growth Good when Positive'),
      blank_if_zero: label('boolean', 'Blank if Zero'), figure_type: label('selection', 'Figure Type', { options: [['monetary', 'Monetary'], ['percentage', 'Percentage'], ['integer', 'Integer'], ['float', 'Float'], ['string', 'String']] }),
    },
    defaults: () => ({ date_scope: 'strict_range', green_on_positive: true, blank_if_zero: false }),
    guard: expressionGuard,
    list: ['label', 'report_line_id', 'engine', 'formula'],
    form: { title: 'label', groups: [['report_line_id', 'label', 'engine'], ['formula', 'subformula', 'date_scope'], ['figure_type', 'green_on_positive', 'blank_if_zero', 'carryover_target']] },
  },
};