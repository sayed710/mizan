import { read } from '../orm.js';
import {
  ACCOUNT_TYPES,
  analyticDistributionForLines,
  analyticMoveItems,
  balances,
  filterByAnalytic,
  fiscalYearStart,
  journalItems,
  profitAndLoss,
  weighted,
} from './ledger.js';
import { addDays, today } from './common.js';
import { reportingBookedAmount } from './money.js';
import { distributionOfLine, normalizeDistribution } from './analyticplus.js';
import {
  findStatementReport,
  STANDARD_BALANCE_LINES,
  STANDARD_PNL_LINES,
  STATEMENT_REPORT_SPECS,
} from './statementReports.js';
import { round } from '../money.js';

export {
  findStatementReport,
  STANDARD_BALANCE_LINES,
  STANDARD_PNL_LINES,
  STATEMENT_REPORT_SPECS,
};

const codePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KNOWN_ACCOUNT_TYPES = new Set(ACCOUNT_TYPES.map(([code]) => code));
const currentCompanyId = (db) => db?.settings?.current_company_id ?? 1;

/** Parse an unambiguous selector, earnings expression, or linear combination of line codes. */
function parseFormula(formula) {
  const text = String(formula ?? '').trim();
  if (!text) throw new Error('A report line formula is required');
  if (/^earnings:/i.test(text)) {
    const earnings = text.slice(9).trim().toLowerCase();
    if (!['current_year', 'prior_years'].includes(earnings)) throw new Error(`Unknown earnings expression: ${text}`);
    return { earnings };
  }
  if (/^(?:-?\d|tag:|-?type:)/i.test(text)) {
    const selectors = text.split(',').map((part) => part.trim());
    for (const part of selectors) {
      if (/^-?type:/i.test(part)) {
        const type = part.replace(/^-?type:/i, '').trim();
        if (!KNOWN_ACCOUNT_TYPES.has(type)) throw new Error(`Unknown account type selector: ${part}`);
      } else if (!/^-?\d[A-Za-z0-9_.]*$/.test(part) && !/^tag:[^,]+$/i.test(part)) {
        throw new Error(`Malformed account selector: ${text}`);
      }
    }
    if (!selectors.some((part) => !part.startsWith('-'))) throw new Error('An account selector needs an included prefix, type or tag');
    return { selectors };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\s*[+-]\s*[A-Za-z_][A-Za-z0-9_]*)*$/.test(text)) throw new Error(`Malformed aggregation formula: ${text}`);
  const terms = text.match(/[+-]?\s*[A-Za-z_][A-Za-z0-9_]*/g).map((term) => ({ sign: term.trim().startsWith('-') ? -1 : 1, code: term.replace(/^[+\-\s]+/, '') }));
  return { terms };
}

function reportError(db, _before, report) {
  try {
    if (!read(db, 'res.company', report.company_id)) throw new Error('Select an existing report company');
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
  const matchOne = (raw) => {
    const lower = raw.toLowerCase();
    if (lower.startsWith('tag:')) {
      const target = raw.slice(4).trim();
      return (account.tag_ids ?? []).some((id) => read(db, 'account.account.tag', typeof id === 'object' ? id.id : id)?.name === target);
    }
    if (lower.startsWith('type:')) return account.account_type === raw.slice(5).trim();
    return String(account.code ?? '').startsWith(raw);
  };
  return selectors.some((s) => !s.startsWith('-') && matchOne(s))
    && !selectors.some((s) => s.startsWith('-') && matchOne(s.slice(1)));
}

/** Preserve the posted invoice source allocations when one journal item combines invoice lines. */
function analyticWeights(db, item, analyticAccountIds) {
  const move = read(db, 'account.move', item.move_id);
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
  if (!weights.size && move) {
    for (const [id, percent] of Object.entries(analyticDistributionForLines(move.line_ids ?? [], analyticAccountIds))) {
      weights.set(Number(id), percent / 100);
    }
  }
  const selected = analyticAccountIds?.length ? new Set(analyticAccountIds.map(Number)) : null;
  if (selected) {
    const selectedTotal = [...weights].reduce((sum, [id, weight]) => sum + (selected.has(id) ? weight : 0), 0);
    if (!selectedTotal) return new Map();
    return new Map([...weights].filter(([id]) => selected.has(id)).map(([id, weight]) => [id, weight / selectedTotal]));
  }
  return weights;
}

/** One column per matched partner or analytic account of each horizontal group rule, plus the unmatched share. */
export function groupBuckets(db, group, items, { analyticAccountIds } = {}) {
  const cache = new WeakMap();
  const analytic = (item) => cache.get(item) ?? cache.set(item, analyticWeights(db, item, analyticAccountIds)).get(item);
  return group.rule_ids.flatMap((rule, index) => {
    const domain = idsFor(rule);
    const model = rule.field === 'partner' ? 'res.partner' : 'account.analytic.account';
    const used = new Set();
    for (const item of items) {
      if (rule.field === 'partner' && item.partner_id) used.add(item.partner_id);
      if (rule.field === 'analytic') for (const id of analytic(item).keys()) used.add(id);
    }
    const ids = (domain.length ? domain : [...used]).filter((id) => read(db, model, id)).sort((a, b) => String(read(db, model, a).name).localeCompare(String(read(db, model, b).name)) || a - b);
    const fraction = (item, id) => rule.field === 'partner' ? Number(item.partner_id === id) : analytic(item).get(id) ?? 0;
    return [...ids.map((id) => ({ key: `${index}:${id}`, label: read(db, model, id).name, weight: (item) => fraction(item, id) })),
      { key: `${index}:other`, label: 'Others', weight: (item) => Math.max(0, 1 - ids.reduce((sum, id) => sum + fraction(item, id), 0)) }];
  });
}

function effectiveReportPeriod(report, period) {
  if (report.date_scope !== 'cumulative') return { ...period };
  return { ...period, from: '', to: period?.to || today() };
}

function targetCompanyIds(db, report, group, options) {
  if (group) return [report.company_id];
  if (Array.isArray(options?.companyIds) && options.companyIds.length) return options.companyIds.map(Number);
  if (options?.companyId != null) return [Number(options.companyId)];
  return [report.company_id];
}

function resolveReportItems(db, report, period, companies, { analyticAccountIds } = {}) {
  const effective = effectiveReportPeriod(report, period);
  const raw = companies.flatMap((companyId) => journalItems(db, { ...effective, company_id: companyId }));
  const scoped = report.exclude_closing ? raw.filter((item) => !item.is_closing) : raw;
  if (!analyticAccountIds?.length) return scoped;
  return report.date_scope === 'cumulative'
    ? analyticMoveItems(scoped, analyticAccountIds)
    : filterByAnalytic(scoped, analyticAccountIds);
}

function computeEarningsSummary(db, report, period, weight, companies, { analyticAccountIds } = {}) {
  const effective = effectiveReportPeriod(report, period);
  const reportDate = effective.to || today();
  let currentYear = 0;
  let priorYears = 0;
  for (const cId of companies) {
    const yearStart = fiscalYearStart(db, reportDate, cId);
    const currentFilter = { ...effective, company_id: cId, from: yearStart, to: reportDate };
    const priorFilter = { ...effective, company_id: cId, from: '', to: addDays(yearStart, -1) };
    currentYear = round(currentYear + profitAndLoss(db, currentFilter, { includeClosing: true, weight, analyticAccountIds }).net);
    priorYears = round(priorYears + profitAndLoss(db, priorFilter, { includeClosing: true, weight, analyticAccountIds }).net);
  }
  return { current_year: currentYear, prior_years: priorYears };
}

function collectAccountContributions(db, definitions, lineCode, accountRows, factor = 1) {
  const def = definitions.get(lineCode);
  const lineFactor = factor * (Number(def.sign) || 1);
  const contributions = [];
  if (def.parsed.terms) {
    for (const term of def.parsed.terms) {
      contributions.push(...collectAccountContributions(db, definitions, term.code, accountRows, lineFactor * term.sign));
    }
    return contributions;
  }
  if (!def.parsed.selectors) return contributions;
  for (const row of accountRows) {
    if (matches(db, row.account, def.parsed.selectors)) {
      contributions.push({ account: row.account, amount: lineFactor * row.balance });
    }
  }
  return contributions;
}

/**
 * Evaluate a configurable or seeded statement report using ledger.js canonical items, balances, and P&L earnings.
 * Options may pass companyIds (or companyId) and analyticAccountIds.
 */
export function configurableReport(db, report, period, group = null, options = {}) {
  report = { ...report, company_id: report.company_id ?? currentCompanyId(db) };
  const error = reportError(db, null, report);
  if (error) throw new Error(error);
  if (group) {
    const matchesReport = (group.report_ids ?? []).length === 0 ? Boolean(report.kind) : (group.report_ids ?? []).includes(report.id);
    if ((group.company_id ?? 1) !== (report.company_id ?? 1) || !matchesReport) {
      throw new Error('Horizontal group is not available for this report');
    }
  }
  const companies = targetCompanyIds(db, report, group, options);
  const analyticIds = options?.analyticAccountIds;
  const items = resolveReportItems(db, report, period, companies, { analyticAccountIds: analyticIds });
  const columns = ['balance', ...(report.show_debit ? ['debit'] : []), ...(report.show_credit ? ['credit'] : [])];
  const buckets = group ? groupBuckets(db, group, items, { analyticAccountIds: analyticIds }) : [{ key: 'all', label: '', weight: () => 1 }];
  const needEarnings = report.line_ids.some((l) => /^earnings:/i.test(String(l.formula ?? '').trim()));
  const bucketState = buckets.map((bucket) => {
    const weight = group ? bucket.weight : null;
    const weightedItems = weighted(items, weight);
    const debitCreditByAccount = new Map();
    if (report.show_debit || report.show_credit) {
      for (const item of weightedItems) {
        const entry = debitCreditByAccount.get(item.account_id) ?? { debit: 0, credit: 0 };
        entry.debit += reportingBookedAmount(db, item, Number(item.debit) || 0);
        entry.credit += reportingBookedAmount(db, item, Number(item.credit) || 0);
        debitCreditByAccount.set(item.account_id, entry);
      }
    }
    return {
      bucket,
      accountRows: balances(db, weightedItems),
      debitCreditByAccount,
      earnings: needEarnings ? computeEarningsSummary(db, report, period, weight, companies, { analyticAccountIds: analyticIds }) : null,
    };
  });
  const definitions = new Map(report.line_ids.map((line) => [line.code, { ...line, sign: Number(line.sign) || 1, parsed: parseFormula(line.formula) }]));
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
    const evaluate = (code, stateIdx, column) => {
      const key = `${code}:${stateIdx}:${column}`;
      if (memo.has(key)) return memo.get(key);
      const def = definitions.get(code);
      const parsed = def.parsed;
      let raw;
      if (parsed.terms) {
        raw = parsed.terms.reduce((sum, term) => sum + term.sign * evaluate(term.code, stateIdx, column), 0);
      } else if (parsed.earnings) {
        const net = bucketState[stateIdx].earnings[parsed.earnings];
        raw = column === 'debit' ? (net < 0 ? -net : 0) : column === 'credit' ? (net > 0 ? net : 0) : -net;
      } else {
        raw = bucketState[stateIdx].accountRows
          .filter((row) => matches(db, row.account, parsed.selectors))
          .reduce((sum, row) => {
            if (column === 'balance') return sum + row.balance;
            const dc = bucketState[stateIdx].debitCreditByAccount.get(row.account.id);
            return sum + (column === 'debit' ? (dc?.debit ?? 0) : (dc?.credit ?? 0));
          }, 0);
      }
      const value = column === 'balance' ? def.sign * raw : raw;
      memo.set(key, value);
      return value;
    };
    const values = buckets.flatMap((_bucket, stateIdx) => columns.map((column) => round(evaluate(line.code, stateIdx, column))));
    const accountRows = (() => {
      if (!line.foldable) return [];
      const accountMap = new Map();
      const totalCols = buckets.length * columns.length;
      bucketState.forEach((state, stateIdx) => {
        const balIdx = stateIdx * columns.length;
        for (const { account, amount } of collectAccountContributions(db, definitions, line.code, state.accountRows)) {
          const entry = accountMap.get(account.id) ?? { account, values: new Array(totalCols).fill(0) };
          entry.values[balIdx] = round(entry.values[balIdx] + amount);
          if (columns.includes('debit') || columns.includes('credit')) {
            const dc = state.debitCreditByAccount.get(account.id);
            if (dc) {
              const dIdx = columns.indexOf('debit');
              const cIdx = columns.indexOf('credit');
              if (dIdx >= 0) entry.values[balIdx + dIdx] = round(dc.debit);
              if (cIdx >= 0) entry.values[balIdx + cIdx] = round(dc.credit);
            }
          }
          accountMap.set(account.id, entry);
        }
      });
      return [...accountMap.values()]
        .filter((entry) => entry.values.some((v) => v !== 0))
        .sort((a, b) => String(a.account.code ?? '').localeCompare(String(b.account.code ?? '')));
    })();
    return { ...line, values, accountRows };
  });
  return { columns, buckets, rows };
}

/** Compute period comparison columns, variances, and merged account drilldown rows for a configurable report. */
export function compareConfigurableReport(db, report, periods, baseFilter = {}, group = null, options = {}) {
  const effectivePeriods = periods?.length ? periods : [{ from: baseFilter.from ?? '', to: baseFilter.to ?? '', label: 'Balance' }];
  if (group || effectivePeriods.length === 1) {
    const period = { ...baseFilter, ...effectivePeriods[0] };
    const single = configurableReport(db, report, period, group, options);
    const headers = single.buckets.flatMap((bucket) => single.columns.map((column) => {
      const colTitle = column === 'balance' ? 'Balance' : column === 'debit' ? 'Debit' : 'Credit';
      if (!bucket.label) return single.columns.length === 1 && effectivePeriods[0].label ? effectivePeriods[0].label : colTitle;
      return single.columns.length === 1 ? bucket.label : `${bucket.label} - ${colTitle}`;
    }));
    return { ...single, headers, showVariance: false, rows: single.rows.map((r) => ({ ...r, variance: null, accountRows: r.accountRows.map((a) => ({ ...a, variance: null })) })) };
  }
  const results = effectivePeriods.map((p) => configurableReport(db, report, { ...baseFilter, from: p.from, to: p.to }, null, options));
  const varianceOf = (vals) => {
    const previous = vals.at(-2);
    if (previous == null) return null;
    const amount = round(vals.at(-1) - previous);
    return { amount, pct: !previous ? null : round(amount / Math.abs(previous) * 100) };
  };
  const rows = results[0].rows.map((baseRow, idx) => {
    const values = results.map((res) => res.rows[idx].values[0]);
    const accountMap = new Map();
    results.forEach((res, pIdx) => {
      for (const acc of res.rows[idx].accountRows ?? []) {
        const entry = accountMap.get(acc.account.id) ?? { account: acc.account, values: new Array(effectivePeriods.length).fill(0) };
        entry.values[pIdx] = acc.values[0];
        accountMap.set(acc.account.id, entry);
      }
    });
    const accountRows = [...accountMap.values()]
      .sort((a, b) => String(a.account.code ?? '').localeCompare(String(b.account.code ?? '')))
      .map((entry) => ({ ...entry, variance: varianceOf(entry.values) }));
    return { ...baseRow, values, variance: varianceOf(values), accountRows };
  });
  return { columns: ['balance'], buckets: results[0].buckets, headers: effectivePeriods.map((p) => p.label), showVariance: true, rows };
}

const company = { type: 'many2one', relation: 'res.company', label: 'Company', required: true };
export const configurableReportModels = {
  'account.report': {
    label: 'Accounting Reports',
    fields: {
      name: { type: 'char', label: 'Name', required: true }, company_id: company,
      kind: { type: 'selection', label: 'Report Kind', options: [['', 'Custom'], ['pnl', 'Profit and Loss'], ['balance', 'Balance Sheet']] },
      date_scope: { type: 'selection', label: 'Date Scope', options: [['range', 'Period Range'], ['cumulative', 'As of Date']] },
      exclude_closing: { type: 'boolean', label: 'Exclude Closing Entries' },
      sequence: { type: 'integer', label: 'Sequence' }, active: { type: 'boolean', label: 'Active' },
      show_debit: { type: 'boolean', label: 'Debit' }, show_credit: { type: 'boolean', label: 'Credit' },
      line_ids: { type: 'one2many', label: 'Report Lines', fields: {
        name: { type: 'char', label: 'Name' }, code: { type: 'char', label: 'Code' }, sequence: { type: 'integer', label: 'Sequence' },
        parent_code: { type: 'char', label: 'Parent Code' }, formula: { type: 'char', label: 'Formula' },
        sign: { type: 'integer', label: 'Sign' }, foldable: { type: 'boolean', label: 'Foldable' }, strong: { type: 'boolean', label: 'Emphasized' },
      }, newLine: () => ({ name: '', code: '', sequence: 10, parent_code: '', formula: '', sign: 1, foldable: false, strong: false }) },
    },
    defaults: () => ({ active: true, kind: '', date_scope: 'range', exclude_closing: false, sequence: 10, show_debit: false, show_credit: false, line_ids: [] }),
    createDefaults: (db) => ({ company_id: currentCompanyId(db) }),
    guard: reportError, list: ['name', 'sequence', 'company_id'],
    form: { title: 'name', groups: [['sequence', 'company_id', 'active'], ['kind', 'date_scope', 'exclude_closing'], ['show_debit', 'show_credit']], tabs: [{ label: 'Report Lines', fields: ['line_ids'] }], buttons: [{ label: 'Open Report', run: (db, report) => ({ db, go: `#/accounting/configurable-report-view/${report.id}` }) }] },
  },
  'account.report.horizontal.group': {
    label: 'Horizontal Groups', fields: {
      name: { type: 'char', label: 'Name', required: true }, company_id: company,
      report_ids: { type: 'many2many', relation: 'account.report', label: 'Accounting Reports' },
      rule_ids: { type: 'one2many', label: 'Group Rules', fields: {
        field: { type: 'selection', label: 'Field', options: [['partner', 'Partner'], ['analytic', 'Analytic Account']] },
        ids: { type: 'char', label: 'IDs (comma-separated)' },
      }, newLine: () => ({ field: 'partner', ids: '' }) },
    }, defaults: () => ({ report_ids: [], rule_ids: [{ field: 'partner', ids: '' }] }), createDefaults: (db) => ({ company_id: currentCompanyId(db) }), guard: groupError,
    list: ['name', 'company_id'], form: { title: 'name', groups: [['company_id', 'report_ids']], tabs: [{ label: 'Group Rules', fields: ['rule_ids'] }] },
  },
};
