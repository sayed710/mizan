import { read } from '../orm.js';
import { journalItems } from './ledger.js';
import { distributionOfLine, normalizeDistribution } from './analyticplus.js';
import { currentCompany } from './company.js';
import { round } from '../money.js';

const codePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse an unambiguous selector or a sum of line codes. */
function parseFormula(formula) {
  const text = String(formula ?? '').trim();
  if (!text) throw new Error('A report line formula is required');
  if (/^(?:-?\d|tag:)/i.test(text)) {
    const selectors = text.split(',').map((part) => part.trim());
    if (selectors.some((part) => !/^-?\d[A-Za-z0-9_.]*$/.test(part) && !/^tag:[^,]+$/i.test(part))) throw new Error(`Malformed account selector: ${text}`);
    if (!selectors.some((part) => !part.startsWith('-'))) throw new Error('An account selector needs an included prefix or tag');
    return { selectors };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\s*[+-]\s*[A-Za-z_][A-Za-z0-9_]*)*$/.test(text)) throw new Error(`Malformed aggregation formula: ${text}`);
  const terms = text.match(/[+-]?\s*[A-Za-z_][A-Za-z0-9_]*/g).map((term) => ({ sign: term.trim().startsWith('-') ? -1 : 1, code: term.replace(/^[+\-\s]+/, '') }));
  return { terms };
}

function reportError(_db, _before, report) {
  try {
    if (!read(_db, 'res.company', report.company_id)) throw new Error('Select an existing report company');
    if (!Array.isArray(report.line_ids)) throw new Error('Report lines must be a list');
    const lines = new Map();
    for (const line of report.line_ids) {
      if (!String(line.name ?? '').trim() || !codePattern.test(line.code ?? '')) throw new Error('Each report line needs a name and a valid code');
      if (lines.has(line.code)) throw new Error(`Duplicate report line code: ${line.code}`);
      lines.set(line.code, { ...line, parsed: parseFormula(line.formula) });
    }
    for (const line of lines.values()) {
      if (line.parent_code && !lines.has(line.parent_code)) throw new Error(`Unknown parent code: ${line.parent_code}`);
      for (const term of line.parsed.terms ?? []) if (!lines.has(term.code)) throw new Error(`Unknown report line code: ${term.code}`);
    }
    const visit = (code, path, done, dependencies) => {
      if (path.has(code)) throw new Error(`Report line cycle involving ${code}`);
      if (done.has(code)) return;
      path.add(code);
      for (const next of dependencies(lines.get(code))) visit(next, path, done, dependencies);
      path.delete(code); done.add(code);
    };
    for (const dependencies of [(line) => (line.parsed.terms ?? []).map((term) => term.code), (line) => line.parent_code ? [line.parent_code] : []]) {
      const done = new Set();
      for (const code of lines.keys()) visit(code, new Set(), done, dependencies);
    }
    return null;
  } catch (error) { return error.message; }
}

const idsFor = (rule) => String(rule.ids ?? '').trim() ? [...new Set(String(rule.ids).split(',').map((id) => Number(id.trim())))] : [];
function groupError(db, _before, group) {
  if (!read(db, 'res.company', group.company_id)) return 'Select an existing group company';
  if (!Array.isArray(group.rule_ids) || !group.rule_ids.length) return 'Add at least one horizontal group rule';
  for (const id of group.report_ids ?? []) {
    const report = read(db, 'account.report', id);
    if (!report || (report.company_id ?? 1) !== (group.company_id ?? 1)) return 'Reports must belong to the horizontal group company';
  }
  for (const rule of group.rule_ids) {
    if (!['partner', 'analytic'].includes(rule.field)) return 'Select partner or analytic account';
    const raw = String(rule.ids ?? '').trim();
    if (raw && !/^\d+(?:\s*,\s*\d+)*$/.test(raw)) return 'Rule IDs must be a comma-separated list of IDs';
    const model = rule.field === 'partner' ? 'res.partner' : 'account.analytic.account';
    if (idsFor(rule).some((id) => { const record = read(db, model, id); return !id || !record || (record.company_id && record.company_id !== (group.company_id ?? 1)); })) return 'Rule IDs must identify records available to the group company';
  }
  return null;
}

function matches(db, account, selectors) {
  if (!account) return false;
  const included = selectors.some((s) => s.toLowerCase().startsWith('tag:')
    ? (account.tag_ids ?? []).some((id) => read(db, 'account.account.tag', typeof id === 'object' ? id.id : id)?.name === s.slice(4).trim())
    : !s.startsWith('-') && String(account.code ?? '').startsWith(s));
  return included && !selectors.some((s) => s.startsWith('-') && String(account.code ?? '').startsWith(s.slice(1)));
}

/** Preserve the posted invoice source allocations when one journal item combines invoice lines. */
function analyticWeights(db, item) {
  const move = read(db, 'account.move', item.move_id);
  // Fallback distributions resolve against the document company.
  const lineContext = { ...move, company_id: move?.company_id ?? item.company_id ?? 1 };
  const sources = item.invoice_sources ?? [];
  const total = sources.reduce((sum, source) => sum + Math.abs(Number(source.amount) || 0), 0);
  const weights = new Map();
  const add = (line, share, ctxMove) => {
    for (const [id, percent] of Object.entries(normalizeDistribution(distributionOfLine(line, db, ctxMove), db))) {
      weights.set(Number(id), (weights.get(Number(id)) ?? 0) + share * percent / 100);
    }
  };
  if (total && sources.length) {
    for (const source of sources) {
      const line = move?.invoice_line_ids?.[source.index];
      if (line) add(line, Math.abs(Number(source.amount) || 0) / total, lineContext);
    }
  } else add(item, 1, lineContext);
  // Independent analytic plans can each allocate 100%; partition the item across their combined weights.
  const totalWeight = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  if (totalWeight > 1) for (const [id, weight] of weights) weights.set(id, weight / totalWeight);
  return weights;
}

/** Compute every column from the same posted journal items as the general ledger. */
export function configurableReport(db, report, period, group = null) {
  report = { ...report, company_id: report.company_id ?? currentCompany(db) };
  const error = reportError(db, null, report);
  if (error) throw new Error(error);
  if (group && ((group.company_id ?? 1) !== (report.company_id ?? 1) || !(group.report_ids ?? []).includes(report.id))) throw new Error('Horizontal group is not available for this report');
  const items = journalItems(db, { ...period, company_id: report.company_id });
  const analytic = group?.rule_ids.some((rule) => rule.field === 'analytic') ? new Map(items.map((item) => [item, analyticWeights(db, item)])) : null;
  const columns = ['balance', ...(report.show_debit ? ['debit'] : []), ...(report.show_credit ? ['credit'] : [])];
  const buckets = group ? group.rule_ids.flatMap((rule, index) => {
    const domain = idsFor(rule);
    const model = rule.field === 'partner' ? 'res.partner' : 'account.analytic.account';
    const used = new Set();
    for (const item of items) {
      if (rule.field === 'partner' && item.partner_id) used.add(item.partner_id);
      if (rule.field === 'analytic') for (const id of analytic.get(item).keys()) used.add(id);
    }
    const ids = (domain.length ? domain : [...used]).filter((id) => read(db, model, id)).sort((a, b) => String(read(db, model, a).name).localeCompare(String(read(db, model, b).name)) || a - b);
    const fraction = (item, id) => rule.field === 'partner' ? Number(item.partner_id === id) : analytic.get(item).get(id) ?? 0;
    return [...ids.map((id) => ({ key: `${index}:${id}`, label: read(db, model, id).name, weight: (item) => fraction(item, id) })),
      { key: `${index}:other`, label: 'Others', weight: (item) => Math.max(0, 1 - ids.reduce((sum, id) => sum + fraction(item, id), 0)) }];
  }) : [{ key: 'all', label: '', weight: () => 1 }];
  const definitions = new Map(report.line_ids.map((line) => [line.code, { ...line, parsed: parseFormula(line.formula) }]));
  const ordered = [];
  const appendChildren = (parent, depth) => {
    for (const line of [...definitions.values()].filter((item) => (item.parent_code || '') === parent).sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0))) {
      ordered.push({ ...line, depth });
      appendChildren(line.code, depth + 1);
    }
  };
  appendChildren('', 0);
  const rows = ordered.map((line) => {
    const memo = new Map();
    const evaluate = (code, bucket, column) => {
      const key = `${code}:${bucket.key}:${column}`;
      if (memo.has(key)) return memo.get(key);
      const parsed = definitions.get(code).parsed;
      const value = parsed.terms ? parsed.terms.reduce((sum, term) => sum + term.sign * evaluate(term.code, bucket, column), 0)
        : items.reduce((sum, item) => {
          if (!matches(db, read(db, 'account.account', item.account_id), parsed.selectors)) return sum;
          const debit = Number(item.debit) || 0; const credit = Number(item.credit) || 0;
          return sum + (column === 'debit' ? debit : column === 'credit' ? credit : debit - credit) * bucket.weight(item);
        }, 0);
      memo.set(key, value); return value;
    };
    return { ...line, values: buckets.flatMap((bucket) => columns.map((column) => round(evaluate(line.code, bucket, column)))) };
  });
  return { columns, buckets, rows };
}

const company = { type: 'many2one', relation: 'res.company', label: 'Company', required: true };
export const configurableReportModels = {
  'account.report': {
    label: 'Accounting Reports',
    fields: {
      name: { type: 'char', label: 'Name', required: true }, company_id: company,
      sequence: { type: 'integer', label: 'Sequence' }, active: { type: 'boolean', label: 'Active' },
      show_debit: { type: 'boolean', label: 'Debit' }, show_credit: { type: 'boolean', label: 'Credit' },
      line_ids: { type: 'one2many', label: 'Report Lines', fields: {
        name: { type: 'char', label: 'Name' }, code: { type: 'char', label: 'Code' }, sequence: { type: 'integer', label: 'Sequence' },
        parent_code: { type: 'char', label: 'Parent Code' }, formula: { type: 'char', label: 'Formula' },
      }, newLine: () => ({ name: '', code: '', sequence: 10, parent_code: '', formula: '' }) },
    },
    defaults: () => ({ active: true, sequence: 10, show_debit: false, show_credit: false, line_ids: [] }),
    createDefaults: (db) => ({ company_id: currentCompany(db) }),
    guard: reportError, list: ['name', 'sequence', 'company_id'],
    form: { title: 'name', groups: [['sequence', 'company_id', 'active'], ['show_debit', 'show_credit']], tabs: [{ label: 'Report Lines', fields: ['line_ids'] }], buttons: [{ label: 'Open Report', run: (db, report) => ({ db, go: `#/accounting/configurable-report-view/${report.id}` }) }] },
  },
  'account.report.horizontal.group': {
    label: 'Horizontal Groups', fields: {
      name: { type: 'char', label: 'Name', required: true }, company_id: company,
      report_ids: { type: 'many2many', relation: 'account.report', label: 'Accounting Reports' },
      rule_ids: { type: 'one2many', label: 'Group Rules', fields: {
        field: { type: 'selection', label: 'Field', options: [['partner', 'Partner'], ['analytic', 'Analytic Account']] },
        ids: { type: 'char', label: 'IDs (comma-separated)' },
      }, newLine: () => ({ field: 'partner', ids: '' }) },
    }, defaults: () => ({ report_ids: [], rule_ids: [{ field: 'partner', ids: '' }] }), createDefaults: (db) => ({ company_id: currentCompany(db) }), guard: groupError,
    list: ['name', 'company_id'], form: { title: 'name', groups: [['company_id', 'report_ids']], tabs: [{ label: 'Group Rules', fields: ['rule_ids'] }] },
  },
};
