import { evaluateStoredReport, matchesReportAccount } from './reportEngine.js';
import { reportRecordModels } from './reportRecords.js';
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
import { companyFilter } from './company.js';
import { reportAmountsVisible, reportReviewMode } from './reports.js';
import {
  findStatementReport,
  STANDARD_BALANCE_LINES,
  STANDARD_PNL_LINES,
  STATEMENT_REPORT_SPECS,
  statementReportGuard,
  syncInlineStatementLines,
} from './statementReports.js';
import { round } from '../money.js';

export {
  findStatementReport,
  reportReviewMode,
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

/** Validate an account.report create or write, enforcing formula integrity and statement report retention. */
function reportError(db, before, report) {
  if (!read(db, 'res.company', report.company_id)) return 'Select an existing report company';
  const statementErr = statementReportGuard(db, before, report);
  if (statementErr) return statementErr;
  try {
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

const HORIZONTAL_GROUP_RULES = {
  partner: { label: 'Partner', model: 'res.partner', fieldKey: 'partner_ids', idsLabel: 'Partners' },
  analytic: { label: 'Analytic Account', model: 'account.analytic.account', fieldKey: 'analytic_ids', idsLabel: 'Analytic Accounts' },
  journal: { label: 'Journal', model: 'account.journal', fieldKey: 'journal_ids', idsLabel: 'Journals' },
  company: { label: 'Company', model: 'res.company', fieldKey: 'company_ids', idsLabel: 'Companies' },
};
const HORIZONTAL_RULE_KEYS = Object.values(HORIZONTAL_GROUP_RULES).map((cfg) => cfg.fieldKey);
const parseLegacyRuleIds = (raw) => {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  if (!/^\d+(?:\s*,\s*\d+)*$/.test(text)) return null;
  const nums = [...new Set(text.split(',').map((id) => Number(id.trim())))];
  return nums.every((id) => Number.isSafeInteger(id) && id > 0) ? nums : null;
};
const idsFor = (rule) => {
  const cfg = HORIZONTAL_GROUP_RULES[rule?.field];
  const rel = cfg ? rule?.[cfg.fieldKey] : null;
  if (Array.isArray(rel) && rel.length) return [...new Set(rel.map(Number))];
  return parseLegacyRuleIds(rule?.ids) ?? [];
};
const emptyRuleArrays = () => Object.fromEntries(HORIZONTAL_RULE_KEYS.map((key) => [key, []]));
export function normalizeHorizontalGroupVals(vals) {
  if (!vals || !Array.isArray(vals.rule_ids)) return vals;
  return {
    ...vals,
    rule_ids: vals.rule_ids.map((rule) => {
      if (!rule || typeof rule !== 'object') return rule;
      const cfg = HORIZONTAL_GROUP_RULES[rule.field];
      if (!cfg) return rule;
      const raw = typeof rule.ids === 'string' ? rule.ids.trim() : '';
      const parsed = parseLegacyRuleIds(raw);
      if (parsed && parsed.length) {
        const existing = Array.isArray(rule[cfg.fieldKey]) ? rule[cfg.fieldKey] : [];
        const combined = [...new Set([...existing.map(Number), ...parsed])];
        return { ...rule, [cfg.fieldKey]: combined, ids: '' };
      }
      return rule;
    }),
  };
}
function groupError(db, before, group) {
  if (!read(db, 'res.company', group.company_id)) return 'Select an existing group company';
  if (!Array.isArray(group.rule_ids) || !group.rule_ids.length) return 'Add at least one horizontal group rule';
  for (const id of group.report_ids ?? []) {
    const report = read(db, 'account.report', id);
    if (!report || (report.company_id ?? 1) !== (group.company_id ?? 1)) return 'Reports must belong to the horizontal group company';
  }
  for (const rule of group.rule_ids) {
    const cfg = HORIZONTAL_GROUP_RULES[rule?.field];
    if (!cfg) return 'Select partner, analytic account, journal, or company';
    if (HORIZONTAL_RULE_KEYS.some((key) => key !== cfg.fieldKey && Array.isArray(rule[key]) && rule[key].length)) {
      return 'Rule IDs must match the selected grouping field';
    }
    const raw = String(rule.ids ?? '').trim();
    const parsedRaw = raw ? parseLegacyRuleIds(raw) : [];
    if (raw && !parsedRaw) return 'Rule IDs must be a comma-separated list of IDs';
    const relIds = rule[cfg.fieldKey];
    if (relIds != null && (!Array.isArray(relIds) || relIds.some((id) => !Number.isSafeInteger(id) || id < 1))) {
      return 'Rule IDs must identify records available to the group company';
    }
    if (idsFor(rule).some((id) => {
      const record = read(db, cfg.model, id);
      return !id || !record || (record.company_id && record.company_id !== (group.company_id ?? 1));
    })) return 'Rule IDs must identify records available to the group company';
  }
  // Archived records may keep the references they already had, but cannot gain new ones.
  const references = (rules) => {
    const counts = new Map();
    for (const rule of rules ?? []) {
      for (const id of idsFor(rule)) counts.set(`${rule.field}:${id}`, (counts.get(`${rule.field}:${id}`) ?? 0) + 1);
    }
    return counts;
  };
  const beforeRefs = references(before?.rule_ids);
  for (const [key, count] of references(group.rule_ids)) {
    const [field, id] = key.split(':');
    if (read(db, HORIZONTAL_GROUP_RULES[field].model, Number(id))?.active === false && count > (beforeRefs.get(key) ?? 0)) {
      return 'Rule IDs must identify records available to the group company';
    }
  }
  return null;
}

const matches = matchesReportAccount;

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

function allowedCompanyRecords(db) {
  const activeCompanies = (db.records?.['res.company'] ?? [])
    .filter((c) => c.active !== false)
    .map((c) => ({ ...c, company_id: c.id }));
  return companyFilter(db, activeCompanies);
}

/** One column per matched partner, analytic account, journal, or company of each horizontal group rule, plus the unmatched share. */
export function groupBuckets(db, group, items, { analyticAccountIds } = {}) {
  const cache = new WeakMap();
  const analytic = (item) => cache.get(item) ?? cache.set(item, analyticWeights(db, item, analyticAccountIds)).get(item);
  const allowedCompanyIds = new Set(allowedCompanyRecords(db).map((c) => c.id));
  return group.rule_ids.flatMap((rule, index) => {
    const cfg = HORIZONTAL_GROUP_RULES[rule.field];
    if (!cfg) return [];
    const rawDomain = idsFor(rule);
    const domain = rule.field === 'company' ? rawDomain.filter((id) => allowedCompanyIds.has(id)) : rawDomain;
    const used = new Set();
    for (const item of items) {
      if (rule.field === 'partner' && item.partner_id) used.add(item.partner_id);
      else if (rule.field === 'analytic') for (const id of analytic(item).keys()) used.add(id);
      else if (rule.field === 'journal' && item.journal_id) used.add(item.journal_id);
      else if (rule.field === 'company') {
        const cId = item.company_id ?? 1;
        if (allowedCompanyIds.has(cId)) used.add(cId);
      }
    }
    const ids = (domain.length ? domain : [...used])
      .filter((id) => read(db, cfg.model, id) && (rule.field !== 'company' || allowedCompanyIds.has(id)))
      .sort((a, b) => String(read(db, cfg.model, a).name).localeCompare(String(read(db, cfg.model, b).name)) || a - b);
    const fraction = (item, id) => {
      if (rule.field === 'partner') return Number(item.partner_id === id);
      if (rule.field === 'analytic') return analytic(item).get(id) ?? 0;
      if (rule.field === 'journal') return Number(item.journal_id === id);
      if (rule.field === 'company') return Number((item.company_id ?? 1) === id);
      return 0;
    };
    return [...ids.map((id) => ({ key: `${index}:${id}`, label: read(db, cfg.model, id).name, weight: (item) => fraction(item, id) })),
      { key: `${index}:other`, label: 'Others', weight: (item) => Math.max(0, 1 - ids.reduce((sum, id) => sum + fraction(item, id), 0)) }];
  });
}

function effectiveReportPeriod(report, period) {
  if (report.date_scope !== 'cumulative') return { ...period };
  return { ...period, from: '', to: period?.to || today() };
}

export function targetCompanyIds(db, report, group, options) {
  const allowedCompanies = allowedCompanyRecords(db);
  const allowedCompanyIds = new Set(allowedCompanies.map((c) => c.id));
  if (group) {
    const companyRules = (group.rule_ids ?? []).filter((r) => r.field === 'company');
    if (companyRules.length) {
      const explicit = companyRules.flatMap((r) => idsFor(r));
      const baseCompanies = Array.isArray(options?.companyIds) && options.companyIds.length
        ? options.companyIds.map(Number).filter((id) => allowedCompanyIds.has(id))
        : options?.companyId != null && allowedCompanyIds.has(Number(options.companyId))
          ? [Number(options.companyId)]
          : allowedCompanies.map((c) => c.id);
      // A rule naming companies stays restricted to them, even when none is allowed or selected any more.
      if (explicit.length) {
        const baseSet = new Set(baseCompanies);
        return [...new Set(explicit.filter((id) => baseSet.has(id)))];
      }
      return baseCompanies;
    }
    return [report.company_id];
  }
  if (Array.isArray(options?.companyIds) && options.companyIds.length) {
    return options.companyIds.map(Number).filter((id) => allowedCompanyIds.has(id));
  }
  if (options?.companyId != null) {
    const cId = Number(options.companyId);
    return allowedCompanyIds.has(cId) ? [cId] : [report.company_id];
  }
  return [report.company_id];
}

function resolveReportItems(db, report, period, companies, { analyticAccountIds, reviewMode } = {}) {
  const effective = effectiveReportPeriod(report, period);
  const modeFilter = reviewMode ? { reviewMode } : {};
  const raw = companies.flatMap((companyId) => journalItems(db, { ...effective, company_id: companyId, ...modeFilter }));
  const scoped = report.exclude_closing ? raw.filter((item) => !item.is_closing) : raw;
  if (!analyticAccountIds?.length) return scoped;
  return report.date_scope === 'cumulative'
    ? analyticMoveItems(scoped, analyticAccountIds, db)
    : filterByAnalytic(scoped, analyticAccountIds);
}

/** Sign with which each profitAndLoss detail group adds to net profit. */
const EARNINGS_DETAIL_SIGN = { revenue: 1, otherIncome: 1, cost: -1, expense: -1, otherExpense: -1 };

/** Accumulate each contributing account's raw (debit minus credit) balance, the convention of `accountRows`. */
function addEarningsAccounts(target, detail) {
  for (const [group, sign] of Object.entries(EARNINGS_DETAIL_SIGN)) {
    for (const row of detail[group]) {
      const entry = target.get(row.account.id) ?? { account: row.account, balance: 0 };
      target.set(row.account.id, { ...entry, balance: round(entry.balance - sign * row.balance) });
    }
  }
}

function computeEarningsSummary(db, report, period, weight, companies, { analyticAccountIds, reviewMode } = {}) {
  const effective = effectiveReportPeriod(report, period);
  const reportDate = effective.to || today();
  const includeClosing = !report.exclude_closing;
  const modeFilter = reviewMode ? { reviewMode } : {};
  let currentYear = 0;
  let priorYears = 0;
  const currentAccounts = new Map();
  const priorAccounts = new Map();
  for (const cId of companies) {
    const yearStart = fiscalYearStart(db, reportDate, cId);
    const currentFilter = { ...effective, company_id: cId, from: yearStart, to: reportDate, ...modeFilter };
    const priorFilter = { ...effective, company_id: cId, from: '', to: addDays(yearStart, -1), ...modeFilter };
    const current = profitAndLoss(db, currentFilter, { includeClosing, weight, analyticAccountIds });
    const prior = profitAndLoss(db, priorFilter, { includeClosing, weight, analyticAccountIds });
    currentYear = round(currentYear + current.net);
    priorYears = round(priorYears + prior.net);
    addEarningsAccounts(currentAccounts, current.detail);
    addEarningsAccounts(priorAccounts, prior.detail);
  }
  return {
    current_year: currentYear,
    prior_years: priorYears,
    accounts: { current_year: [...currentAccounts.values()], prior_years: [...priorAccounts.values()] },
  };
}

/** Collect signed balance and debit/credit factors for every account contributing to a report line. */
function collectAccountContributions(db, definitions, lineCode, state, factor = 1, dcFactor = 1) {
  const def = definitions.get(lineCode);
  const lineFactor = factor * (Number(def.sign) || 1);
  const contributions = [];
  if (def.parsed.terms) {
    for (const term of def.parsed.terms) {
      contributions.push(...collectAccountContributions(db, definitions, term.code, state, lineFactor * term.sign, dcFactor * term.sign));
    }
    return contributions;
  }
  if (def.parsed.earnings) {
    for (const row of state.earnings.accounts[def.parsed.earnings]) {
      contributions.push({
        account: row.account,
        amount: lineFactor * row.balance,
        dcFactor,
        dc: { debit: Math.max(0, row.balance), credit: Math.max(0, -row.balance) },
      });
    }
    return contributions;
  }
  if (!def.parsed.selectors) return contributions;
  for (const row of state.accountRows) {
    if (matches(db, row.account, def.parsed.selectors)) {
      contributions.push({ account: row.account, amount: lineFactor * row.balance, dcFactor });
    }
  }
  return contributions;
}

/**
 * Evaluate a configurable or seeded statement report using ledger.js canonical items, balances, and P&L earnings.
 * Options may pass companyIds (or companyId) and analyticAccountIds.
 */
export function configurableReportLegacy(db, report, period, group = null, options = {}) {
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
  const reviewMode = reportReviewMode(period, options);
  const items = resolveReportItems(db, report, period, companies, { analyticAccountIds: analyticIds, reviewMode });
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
      earnings: needEarnings ? computeEarningsSummary(db, report, period, weight, companies, { analyticAccountIds: analyticIds, reviewMode }) : null,
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
        if (column === 'balance') {
          const net = bucketState[stateIdx].earnings[parsed.earnings];
          raw = -net;
        } else {
          const accounts = bucketState[stateIdx].earnings.accounts[parsed.earnings] ?? [];
          raw = accounts.reduce((sum, row) => sum + (column === 'debit' ? Math.max(0, row.balance) : Math.max(0, -row.balance)), 0);
        }
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
      const dIdx = columns.indexOf('debit');
      const cIdx = columns.indexOf('credit');
      bucketState.forEach((state, stateIdx) => {
        const balIdx = stateIdx * columns.length;
        for (const { account, amount, dcFactor, dc: earningsDc } of collectAccountContributions(db, definitions, line.code, state)) {
          const entry = accountMap.get(account.id) ?? { account, values: new Array(totalCols).fill(0) };
          entry.values[balIdx] += amount;
          if (dIdx >= 0 || cIdx >= 0) {
            const dc = earningsDc ?? state.debitCreditByAccount.get(account.id);
            if (dc) {
              if (dIdx >= 0) entry.values[balIdx + dIdx] += dcFactor * dc.debit;
              if (cIdx >= 0) entry.values[balIdx + cIdx] += dcFactor * dc.credit;
            }
          }
          accountMap.set(account.id, entry);
        }
      });
      return [...accountMap.values()]
        .map((entry) => ({ ...entry, values: entry.values.map((v) => round(v)) }))
        .filter((entry) => options.includeZeroRows || reportAmountsVisible(entry.values, true))
        .sort((a, b) => String(a.account.code ?? '').localeCompare(String(b.account.code ?? '')));
    })();
    return { ...line, values, accountRows };
  });
  return { columns, buckets, rows };
}

/** Evaluate stored lines when present, retaining the inline format for legacy reports. */
export function configurableReport(db, report, period, group = null, options = {}) {
  const hasStored = (db.records['account.report.line'] ?? []).some((line) => line.report_id === report.id);
  if (!hasStored) return configurableReportLegacy(db, report, period, group, options);
  report = { ...report, company_id: report.company_id ?? currentCompanyId(db) };
  if (group && ((group.company_id ?? 1) !== report.company_id || !((group.report_ids ?? []).length ? group.report_ids.includes(report.id) : report.kind))) throw new Error('Horizontal group is not available for this report');
  const companies = targetCompanyIds(db, report, group, options);
  const reviewMode = reportReviewMode(period, options);
  const items = resolveReportItems(db, report, period, companies, { analyticAccountIds: options.analyticAccountIds, reviewMode });
  const columns = ['balance', ...(report.show_debit ? ['debit'] : []), ...(report.show_credit ? ['credit'] : [])];
  const buckets = group ? groupBuckets(db, group, items, { analyticAccountIds: options.analyticAccountIds }) : [{ key: 'all', label: '', weight: () => 1 }];
  const evalOptions = { companyIds: companies, analyticAccountIds: options.analyticAccountIds, reviewMode, deferHideIfZero: true, includeAccountBreakdown: true };
  const caches = buckets.map(() => new Map());
  const evaluated = buckets.map((bucket, index) => columns.map((column, colIdx) => evaluateStoredReport(db, report, period, { ...evalOptions, column, itemCache: caches[index], weight: group ? bucket.weight : null, skipValidation: index > 0 || colIdx > 0 })));
  const rawLines = evaluated[0]?.[0] ?? evaluateStoredReport(db, report, period, evalOptions);
  const lineIndex = evaluated.map((bucket) => bucket.map((result) => new Map(result.map((item) => [item.id, item]))));
  const rawById = new Map(rawLines.map((candidate) => [candidate.id, candidate]));
  const exprByLineId = new Map();
  for (const expr of db.records['account.report.expression'] ?? []) {
    if (expr.label === 'balance') exprByLineId.set(expr.report_line_id, expr);
  }
  const accountsById = new Map();
  for (const cache of caches) {
    for (const entry of cache.values()) {
      for (const accEntry of entry.byAccount?.values() ?? []) {
        if (accEntry.account) accountsById.set(accEntry.account.id, accEntry.account);
      }
    }
  }
  const rows = rawLines.map((line) => {
    const parent = line.parent_id != null ? rawById.get(line.parent_id) : null;
    const expression = exprByLineId.get(line.id);
    const aggregation = expression?.engine === 'aggregation' ? String(expression.formula) : '';
    const inverted = /^-\((.*)\)$/.exec(aggregation);
    const formula = (inverted ? inverted[1] : aggregation).replace(/\.balance\b/g, '');
    const lineResults = lineIndex.map((bucket) => bucket.map((byLine) => byLine.get(line.id)));
    const values = lineResults.flatMap((bucket) => bucket.map((item) => item?.expressions.balance ?? null));
    let accountRows = [];
    if (line.foldable) {
      const accIds = new Set();
      for (const bucket of lineResults) {
        for (const item of bucket) {
          const map = item?.accountExpressions?.balance;
          if (map) for (const accId of map.keys()) accIds.add(accId);
        }
      }
      accountRows = [...accIds]
        .map((accId) => {
          const account = accountsById.get(accId);
          if (!account) return null;
          return { account, values: lineResults.flatMap((bucket) => bucket.map((item) => item?.accountExpressions?.balance?.get(accId) ?? 0)) };
        })
        .filter((entry) => entry && (options.includeZeroRows || reportAmountsVisible(entry.values, true)))
        .sort((a, b) => String(a.account.code ?? '').localeCompare(String(b.account.code ?? '')));
    }
    return { ...line, parent_code: parent?.code ?? '', formula, sign: inverted ? -1 : 1, green_on_positive: expression?.green_on_positive, values, accountRows };
  });
  const storedCodes = new Set(rawLines.map((stored) => stored.code).filter(Boolean));
  const inlineRows = !report.kind && report.line_ids?.length ? configurableReportLegacy(db, report, period, group, options).rows.filter((line) => !storedCodes.has(line.code)) : [];
  const allRows = [...rows, ...inlineRows];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const byCode = new Map(allRows.filter((row) => row.code).map((row) => [row.code, row]));
  const childMap = new Map(allRows.map((row) => [row, []]));
  const roots = [];
  for (const row of allRows) {
    const parent = row.id != null
      ? (row.parent_id != null ? byId.get(row.parent_id) : null)
      : (row.parent_code ? byCode.get(row.parent_code) : null);
    if (parent && childMap.has(parent)) childMap.get(parent).push(row);
    else roots.push(row);
  }
  const bySeq = (a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0) || (a.id != null && b.id != null ? a.id - b.id : 0);
  const orderedRows = [];
  const visitHierarchy = (list, depth, seen = new Set()) => {
    for (const row of [...list].sort(bySeq)) {
      if (seen.has(row)) continue;
      seen.add(row);
      orderedRows.push({ ...row, depth });
      visitHierarchy(childMap.get(row) ?? [], depth + 1, seen);
    }
  };
  visitHierarchy(roots, 0);
  const result = { columns, buckets, rows: orderedRows };
  const hidden = new Set();
  const children = (line) => result.rows.filter((candidate) => (
    candidate.id != null ? line.id != null && candidate.parent_id === line.id : Boolean(line.code && candidate.parent_code === line.code)
  ));
  const isZero = (line) => line.values.every((value) => !value) && children(line).every(isZero);
  const hide = (line) => { hidden.add(line); children(line).forEach(hide); };
  if (!options.deferHideIfZero) for (const line of result.rows) if (line.hide_if_zero && isZero(line)) hide(line);
  return { ...result, rows: result.rows.filter((line) => !hidden.has(line)) };
}

/** Compute period comparison columns, variances, and merged account drilldown rows for a configurable report. */
export function compareConfigurableReport(db, report, periods, baseFilter = {}, group = null, options = {}) {
  const filterRows = (rows) => {
    if (!options.hideZeroLines) return rows;
    const rowById = new Map(rows.filter((r) => r.id != null).map((r) => [r.id, r]));
    const rowByCode = new Map(rows.filter((r) => r.code).map((r) => [r.code, r]));
    const visibleRows = new Set();
    for (const row of rows) {
      if (row.strong || reportAmountsVisible(row.values, true)) {
        visibleRows.add(row);
        let current = row;
        while (current) {
          const parentRow = current.id != null && current.parent_id != null
            ? rowById.get(current.parent_id)
            : (current.parent_code ? rowByCode.get(current.parent_code) : null);
          if (!parentRow || visibleRows.has(parentRow)) break;
          visibleRows.add(parentRow);
          current = parentRow;
        }
      }
    }
    return rows.filter((row) => visibleRows.has(row))
      .map((row) => ({ ...row, accountRows: row.accountRows.filter((account) => reportAmountsVisible(account.values, true)) }));
  };
  const effectivePeriods = periods?.length ? periods : [{ from: baseFilter.from ?? '', to: baseFilter.to ?? '', label: 'Balance' }];
  if (group || effectivePeriods.length === 1) {
    const period = { ...baseFilter, ...effectivePeriods[0] };
    const single = configurableReport(db, report, period, group, options);
    const headers = single.buckets.flatMap((bucket) => single.columns.map((column) => {
      const colTitle = column === 'balance' ? 'Balance' : column === 'debit' ? 'Debit' : 'Credit';
      if (!bucket.label) return single.columns.length === 1 && effectivePeriods[0].label ? effectivePeriods[0].label : colTitle;
      return single.columns.length === 1 ? bucket.label : `${bucket.label} - ${colTitle}`;
    }));
    return { ...single, headers, showVariance: false, rows: filterRows(single.rows.map((r) => ({ ...r, variance: null, accountRows: r.accountRows.map((a) => ({ ...a, variance: null })) }))) };
  }
  const results = effectivePeriods.map((p) => configurableReport(db, report, { ...baseFilter, from: p.from, to: p.to }, null, { ...options, deferHideIfZero: true }));
  const varianceOf = (vals) => {
    const previous = vals.at(-2);
    if (previous == null || vals.at(-1) == null) return null;
    const amount = round(vals.at(-1) - previous);
    return { amount, pct: !previous ? null : round(amount / Math.abs(previous) * 100) };
  };
  const allRows = new Map(results.flatMap((res) => res.rows).map((row) => [row.id ?? row.code, row]));
  const rows = [...allRows.values()].map((baseRow) => {
    const matching = results.map((res) => res.rows.find((row) => (row.id ?? row.code) === (baseRow.id ?? baseRow.code)));
    const values = matching.map((row) => row ? row.values[0] : 0);
    const accountMap = new Map();
    results.forEach((_res, pIdx) => {
      for (const acc of matching[pIdx]?.accountRows ?? []) {
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
  const hidden = new Set();
  const children = (line) => rows.filter((candidate) => (
    candidate.id != null ? line.id != null && candidate.parent_id === line.id : Boolean(line.code && candidate.parent_code === line.code)
  ));
  const isZero = (line) => line.values.every((value) => !value) && children(line).every(isZero);
  const hide = (line) => { hidden.add(line); children(line).forEach(hide); };
  for (const line of rows) if (line.hide_if_zero && isZero(line)) hide(line);
  return { columns: ['balance'], buckets: results[0].buckets, headers: effectivePeriods.map((p) => p.label), showVariance: true, rows: filterRows(rows.filter((row) => !hidden.has(row))) };
}

/** Stable key identifying a report line even when a stored line has no code. */
export const reportLineKey = (line) => line.code || `line:${line.id}`;

/** Whether a computed report line can be unfolded into its contributing account rows. */
export const isExpandableLine = (line) => Boolean(line.foldable && line.accountRows.length);

/** Journal Items route scoped to one account: the only drill-down filter the Journal Items view reads from its URL. */
export const accountJournalItemsHref = (accountId, options = {}) => {
  const params = new URLSearchParams();
  if (accountId != null) params.set('account', String(accountId));
  for (const [key, value] of Object.entries(options)) if (value != null && value !== '') params.set(key, String(value));
  return `#/accounting/journal-items?${params}`;
};

export function reportAccountHierarchy(db, accounts) {
  const groups = new Map((db.records['account.group'] ?? []).map((group) => [group.id, group]));
  const nodes = new Map();
  const roots = [];
  const ensureGroup = (id, seen = new Set()) => {
    const group = groups.get(id);
    if (!group || seen.has(id)) return null;
    if (nodes.has(id)) return nodes.get(id);
    seen.add(id);
    const node = { group, children: [], values: [] };
    nodes.set(id, node);
    const parent = ensureGroup(group.parent_id, seen);
    (parent ? parent.children : roots).push(node);
    return node;
  };
  for (const account of accounts) {
    const parent = ensureGroup(account.account.group_id);
    (parent ? parent.children : roots).push(account);
  }
  const sum = (node) => {
    if (!node.group) return node.values;
    for (const child of node.children) {
      sum(child).forEach((value, index) => { node.values[index] = (node.values[index] ?? 0) + (value ?? 0); });
    }
    return node.values;
  };
  roots.forEach(sum);
  return roots;
}

const company = { type: 'many2one', relation: 'res.company', label: 'Company', required: true };
export const configurableReportModels = {
  ...reportRecordModels,
  'account.report': {
    label: 'Accounting Reports',
    fields: {
      name: { type: 'char', label: 'Name', required: true }, company_id: company,
      kind: { type: 'selection', label: 'Report Kind', options: [['', 'Custom'], ['pnl', 'Profit and Loss'], ['balance', 'Balance Sheet']] },
      date_scope: { type: 'selection', label: 'Date Scope', options: [['range', 'Period Range'], ['cumulative', 'As of Date']] },
      default_opening_date_filter: { type: 'selection', label: 'Default Opening Date Filter', options: [['this_year', 'This Year'], ['this_quarter', 'This Quarter'], ['this_month', 'This Month'], ['today', 'Today'], ['previous_month', 'Last Month'], ['previous_quarter', 'Last Quarter'], ['previous_year', 'Last Year']] },
      filter_date_range: { type: 'boolean', label: 'Date Range' },
      filter_unfold_all: { type: 'boolean', label: 'Unfold All' },
      filter_hide_0_lines: { type: 'selection', label: 'Hide lines at 0', options: [['by_default', 'By Default'], ['optional', 'Optional'], ['never', 'Never']] },
      filter_period_comparison: { type: 'boolean', label: 'Period Comparison' },
      filter_growth_comparison: { type: 'boolean', label: 'Growth Comparison' },
      filter_line_comparison: { type: 'boolean', label: 'Line Comparison' },
      filter_hierarchy: { type: 'selection', label: 'Account Parents', options: [['by_default', 'By Default'], ['optional', 'Optional'], ['never', 'Never']] },
      exclude_closing: { type: 'boolean', label: 'Exclude Closing Entries' },
      sequence: { type: 'integer', label: 'Sequence' }, active: { type: 'boolean', label: 'Active' },
      show_debit: { type: 'boolean', label: 'Debit' }, show_credit: { type: 'boolean', label: 'Credit' },
      stored_line_ids: { type: 'one2many', label: 'Accounting Report Lines', relation: 'account.report.line', openRelated: true, fields: { name: { type: 'char', label: 'Name' }, code: { type: 'char', label: 'Code' } }, compute: (report, db) => (db.records['account.report.line'] ?? []).filter((line) => line.report_id === report.id) },
      line_ids: { type: 'one2many', label: 'Report Lines', fields: {
        name: { type: 'char', label: 'Name' }, code: { type: 'char', label: 'Code' }, sequence: { type: 'integer', label: 'Sequence' },
        green_on_positive: { type: 'boolean', label: 'Is Growth Good when Positive' }, parent_code: { type: 'char', label: 'Parent Code' }, formula: { type: 'char', label: 'Formula' },
        sign: { type: 'integer', label: 'Sign' }, foldable: { type: 'boolean', label: 'Foldable' }, strong: { type: 'boolean', label: 'Emphasized' },
      }, newLine: () => ({ name: '', code: '', sequence: 10, parent_code: '', formula: '', sign: 1, foldable: false, strong: false }) },
    },
    defaults: () => ({ active: true, kind: '', date_scope: 'range', default_opening_date_filter: 'this_year', filter_date_range: true, filter_unfold_all: true, filter_hide_0_lines: 'optional', filter_period_comparison: true, filter_growth_comparison: true, filter_line_comparison: true, filter_hierarchy: 'optional', exclude_closing: false, sequence: 10, show_debit: false, show_credit: false, line_ids: [] }),
    createDefaults: (db) => ({ company_id: currentCompanyId(db) }),
    guard: reportError,
    onWrite: (db, after, before) => syncInlineStatementLines(db, before, after),
    protectDelete: (db, report) => statementReportGuard(db, report),
    onUnlink: (db, report) => {
      const err = statementReportGuard(db, report);
      if (err) throw new Error(err);
      const ids = new Set((db.records['account.report.line'] ?? []).filter((line) => line.report_id === report.id).map((line) => line.id));
      return { ...db, records: { ...db.records,
        'account.report.line': (db.records['account.report.line'] ?? []).filter((line) => !ids.has(line.id)),
        'account.report.expression': (db.records['account.report.expression'] ?? []).filter((expr) => !ids.has(expr.report_line_id)),
      } };
    },
    list: ['name', 'sequence', 'company_id'],
    form: { title: 'name', groups: [['sequence', 'company_id', 'active'], ['kind', 'date_scope', 'exclude_closing'], ['show_debit', 'show_credit'], ['default_opening_date_filter', 'filter_date_range', 'filter_unfold_all', 'filter_hide_0_lines', 'filter_period_comparison', 'filter_growth_comparison', 'filter_line_comparison', 'filter_hierarchy']], tabs: [{ label: 'Report Lines', fields: ['line_ids'] }, { label: 'Accounting Report Lines', fields: ['stored_line_ids'] }], buttons: [{ label: 'Open Report', run: (db, report) => ({ db, go: `#/accounting/configurable-report-view/${report.id}` }) }] },
  },
  'account.report.horizontal.group': {
    label: 'Horizontal Groups', fields: {
      name: { type: 'char', label: 'Name', required: true }, company_id: company,
      report_ids: { type: 'many2many', relation: 'account.report', label: 'Accounting Reports' },
      rule_ids: {
        type: 'one2many',
        label: 'Group Rules',
        fields: {
          field: { type: 'selection', label: 'Field', options: Object.entries(HORIZONTAL_GROUP_RULES).map(([k, cfg]) => [k, cfg.label]) },
          partner_ids: { type: 'many2many', relation: 'res.partner', label: 'Partners', hideWhen: (r) => r.field !== 'partner', domain: (rec, rule) => !rec.company_id || rec.company_id === (rule.company_id ?? 1) },
          analytic_ids: { type: 'many2many', relation: 'account.analytic.account', label: 'Analytic Accounts', hideWhen: (r) => r.field !== 'analytic', domain: (rec, rule) => !rec.company_id || rec.company_id === (rule.company_id ?? 1) },
          journal_ids: { type: 'many2many', relation: 'account.journal', label: 'Journals', hideWhen: (r) => r.field !== 'journal', domain: (rec, rule) => !rec.company_id || rec.company_id === (rule.company_id ?? 1) },
          company_ids: { type: 'many2many', relation: 'res.company', label: 'Companies', hideWhen: (r) => r.field !== 'company' },
          ids: { type: 'char', label: 'IDs (comma-separated)', hidden: true },
        },
        onchange: (line, key) => (key === 'field' ? { ...line, ...emptyRuleArrays(), ids: '' } : line),
        newLine: () => ({ field: 'partner', ...emptyRuleArrays() }),
      },
    },
    defaults: () => ({ report_ids: [], rule_ids: [{ field: 'partner', ...emptyRuleArrays() }] }),
    createDefaults: (db) => ({ company_id: currentCompanyId(db) }),
    prepareCreate: (db, vals) => ({ db, vals: normalizeHorizontalGroupVals(vals) }),
    prepareWrite: (db, vals) => ({ db, vals: normalizeHorizontalGroupVals(vals) }),
    guard: groupError,
    list: ['name', 'company_id'],
    form: { title: 'name', groups: [['company_id', 'report_ids']], tabs: [{ label: 'Group Rules', fields: ['rule_ids'] }] },
  },
};
