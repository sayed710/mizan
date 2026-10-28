import { read, write } from '../orm.js';
import { addDays, today } from './common.js';
import { rateAt } from './currency.js';
import { ACCOUNT_TYPES } from './ledger.js';

const round = (n) => Math.round(n * 100) / 100 || 0;
const pnl = (type) => type?.startsWith('income') || type?.startsWith('expense');
const validDate = (date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
  && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
const codes = (line) => String(line.source_codes ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const companyField = { type: 'many2one', relation: 'res.company', label: 'Company', required: true };
const resultFields = {
  group_code: { type: 'char', label: 'Group Code' }, name: { type: 'char', label: 'Account' },
  by_company: { type: 'text', label: 'By Company' },
  eliminations: { type: 'monetary', label: 'Eliminations' }, total: { type: 'monetary', label: 'Total' },
};

function chartGuard(db, before, chart) {
  if (!read(db, 'res.currency', chart.currency_id)) return 'Select an existing group currency';
  const companies = new Set();
  for (const row of chart.company_ids ?? []) {
    const company = read(db, 'res.company', row.company_id);
    if (!company || !read(db, 'res.currency', company.currency_id)) return 'Select companies with an existing currency';
    if (companies.has(company.id)) return 'Include each company only once';
    companies.add(company.id);
    if (!['full', 'proportional', 'equity'].includes(row.method ?? 'full')) return 'Select a consolidation method';
    if (!Number.isFinite(Number(row.ownership ?? 100)) || Number(row.ownership ?? 100) < 0 || Number(row.ownership ?? 100) > 100) return 'Ownership must be between 0 and 100 percent';
  }
  const mapped = new Set();
  const groupCodes = new Set();
  for (const row of chart.account_ids ?? []) {
    if (!row.code?.trim() || groupCodes.has(row.code) || row.code.startsWith('EQUITY:')) return 'Enter unique group account codes outside the EQUITY: namespace';
    groupCodes.add(row.code);
    if (!ACCOUNT_TYPES.some(([type]) => type === row.account_type)) return 'Select a valid group account type';
    for (const code of codes(row)) {
      if (mapped.has(code)) return `Map source account ${code} only once`;
      mapped.add(code);
    }
  }
  return null;
}

function periodGuard(db, before, period) {
  if (before?.state === 'closed') return 'Closed consolidation periods cannot be changed or reopened';
  if (!['draft', 'closed'].includes(period.state)) return 'Select a valid consolidation status';
  if (!validDate(period.date_from) || !validDate(period.date_to) || period.date_from > period.date_to) return 'Enter a valid consolidation date range';
  const chart = read(db, 'consolidation.chart', period.chart_id);
  if (!chart) return 'Select an existing consolidation chart';
  const seen = new Set();
  for (const row of period.rate_ids ?? []) {
    if (!(chart.company_ids ?? []).some((c) => c.company_id === row.company_id) || seen.has(row.company_id)) return 'Enter one rate per included company';
    seen.add(row.company_id);
    if (![row.rate_avg, row.rate_closing].every((n) => Number.isFinite(Number(n)) && Number(n) > 0)) return 'Exchange rates must be positive numbers';
  }
  return null;
}

/** Default group-currency multipliers, averaged daily and at the closing date. */
export function periodRates(db, period) {
  const chart = read(db, 'consolidation.chart', period.chart_id);
  if (!chart || !validDate(period.date_from) || !validDate(period.date_to) || period.date_from > period.date_to) return [];
  return (chart.company_ids ?? []).map(({ company_id }) => {
    const company = read(db, 'res.company', company_id);
    if (!company) throw new Error('Select an existing company');
    const convert = (date) => rateAt(db, chart.currency_id, date) / rateAt(db, company.currency_id, date);
    let sum = 0;
    let days = 0;
    for (let date = period.date_from; date <= period.date_to; date = addDays(date, 1)) { sum += convert(date); days++; }
    return { company_id, rate_avg: sum / days, rate_closing: convert(period.date_to) };
  });
}

function getPeriod(db, id) {
  const period = read(db, 'consolidation.period', id);
  if (!period) throw new Error('Consolidation period not found');
  return period;
}

/** Consolidate posted company balances; closed periods return their immutable snapshot. */
export function consolidate(db, periodId) {
  const period = getPeriod(db, periodId);
  if (period.state === 'closed') return structuredClone({ lines: period.lines ?? [], unmapped: period.unmapped ?? [] });
  const chart = read(db, 'consolidation.chart', period.chart_id);
  const error = periodGuard(db, null, period) || (chart && chartGuard(db, chart, chart));
  if (error) throw new Error(error);
  if (!chart.company_ids?.length) throw new Error('Include at least one company');
  const rates = periodRates(db, period).map((r) => (period.rate_ids ?? []).find((x) => x.company_id === r.company_id) ?? r);
  const lines = (chart.account_ids ?? []).map((a) => ({ group_code: a.code, name: a.name, by_company: {}, eliminations: 0, total: 0 }));
  const mapping = new Map((chart.account_ids ?? []).flatMap((a, i) => codes(a).map((code) => [code, lines[i]])));
  const partners = new Map(chart.company_ids.map((c) => [read(db, 'res.company', c.company_id).partner_id, c]));
  const unmapped = new Set();
  let fxElimination = 0;
  // Group lines the method adds itself; the EQUITY: namespace is reserved for them.
  const systemLine = (code, name) => {
    let line = lines.find((l) => l.group_code === code);
    if (!line) lines.push(line = { group_code: code, name, by_company: {}, eliminations: 0, total: 0 });
    return line;
  };
  const add = (line, companyId, amount) => { if (amount) line.by_company[companyId] = (line.by_company[companyId] ?? 0) + amount; };
  for (const member of chart.company_ids) {
    const company = read(db, 'res.company', member.company_id);
    const rate = rates.find((r) => r.company_id === company.id);
    const share = Number(member.ownership ?? 100) / 100;
    const factor = member.method === 'full' || !member.method ? 1 : share;
    // Equity and earlier results keep the rate of the day they were booked (historical rate).
    const historical = (date) => rateAt(db, chart.currency_id, date) / rateAt(db, company.currency_id, date);
    const balances = new Map();
    // Translated totals: net assets at the closing rate, equity and earlier results historical, the period's result at the average rate.
    const sums = { assets: 0, equity: 0, retained: 0, result: 0 };
    const pending = [];
    for (const move of db.records['account.move'] ?? []) {
      const date = move.invoice_date ?? move.date;
      if ((move.company_id ?? 1) !== company.id || move.state !== 'posted' || !date || date > period.date_to) continue;
      for (const item of move.line_ids ?? []) {
        const account = read(db, 'account.account', item.account_id);
        if (!account) continue;
        const balance = (Number(item.debit) || 0) - (Number(item.credit) || 0);
        if (!balance) continue;
        const earlier = pnl(account.account_type) && date < period.date_from;
        const kind = earlier ? 'retained' : pnl(account.account_type) ? 'result' : account.account_type === 'equity' ? 'equity' : 'assets';
        const amount = balance * (kind === 'result' ? Number(rate.rate_avg) : kind === 'assets' ? Number(rate.rate_closing) : historical(date)) * factor;
        sums[kind] += amount;
        if (member.method === 'equity') continue;
        if (earlier) continue;
        balances.set(account.code, (balances.get(account.code) ?? 0) + balance);
        const line = mapping.get(account.code);
        if (!line) continue;
        pending.push([line, kind, amount]);
        const other = partners.get(item.partner_id ?? move.partner_id);
        if (other && other.company_id !== company.id && other.method !== 'equity'
          && (pnl(account.account_type) || ['asset_receivable', 'liability_payable'].includes(account.account_type))) {
          line.eliminations -= amount;
          // Both sides of a pair match at the rate of the day they were booked; what closing/average rates add on top is
          // a translation difference, not a mismatch, and is carried to its own line below.
          fxElimination += amount - balance * historical(date) * factor;
        }
      }
    }
    // The translation difference closes the company's translated trial balance (local books always balance).
    const cta = -(sums.assets + sums.equity + sums.retained + sums.result);
    if (member.method === 'equity') {
      const investment = sums.assets;
      add(systemLine(`EQUITY:${company.id}`, `Investment in ${company.name}`), company.id, investment);
      add(systemLine(`EQUITY:${company.id}:RESULT`, `Share of result of ${company.name}`), company.id, sums.result);
      add(systemLine(`EQUITY:${company.id}:RESERVE`, `Share of reserves of ${company.name}`), company.id, -(investment + sums.result));
      continue;
    }
    // Full consolidation below 100%: the minority's share of equity and result goes to non-controlling interest.
    const parentShare = member.method === 'full' || !member.method ? share : 1;
    for (const [line, kind, amount] of pending) add(line, company.id, kind === 'equity' ? amount * parentShare : amount);
    add(systemLine('EQUITY:RE', 'Retained Earnings (prior periods)'), company.id, sums.retained * parentShare);
    add(systemLine('EQUITY:CTA', 'Translation Difference'), company.id, cta * parentShare);
    if (parentShare < 1) {
      add(systemLine('EQUITY:NCI', 'Non-controlling Interest'), company.id, (1 - parentShare) * (sums.equity + sums.retained + cta + sums.result));
      add(systemLine('EQUITY:NCI_RESULT', 'Result attributable to Non-controlling Interest'), company.id, -(1 - parentShare) * sums.result);
    }
    for (const [code, balance] of balances) if (round(balance) && !mapping.has(code)) unmapped.add(code);
  }
  if (round(fxElimination)) systemLine('EQUITY:ELIM_FX', 'Translation Difference on Eliminations').eliminations += fxElimination;
  const rounded = lines.map((line) => {
    const by_company = Object.fromEntries(Object.entries(line.by_company).map(([id, amount]) => [id, round(amount)]));
    const eliminations = round(line.eliminations);
    return { ...line, by_company, eliminations, total: round(Object.values(by_company).reduce((s, a) => s + a, 0) + eliminations) };
  });
  // Lines are rounded one by one: when the unrounded balances offset, the cents lost to rounding go to their own line
  // so the stored report adds up exactly. A real imbalance is left alone and still blocks closing.
  const exact = lines.reduce((s, l) => s + Object.values(l.by_company).reduce((t, a) => t + a, 0) + l.eliminations, 0);
  const drift = round(rounded.reduce((s, l) => s + l.total, 0));
  if (Math.abs(exact) < 0.005 && drift) rounded.push({ group_code: 'EQUITY:ROUNDING', name: 'Rounding Difference', by_company: {}, eliminations: -drift, total: -drift });
  return { lines: rounded, unmapped: [...unmapped].sort() };
}

/** Store a fresh draft report and its effective rates through the ORM. */
export function consolidatePeriod(db, periodId) {
  const period = getPeriod(db, periodId);
  if (period.state === 'closed') throw new Error('This consolidation period is already closed');
  const result = consolidate(db, periodId);
  const rate_ids = periodRates(db, period).map((r) => (period.rate_ids ?? []).find((x) => x.company_id === r.company_id) ?? r);
  return write(db, 'consolidation.period', periodId, { ...result, rate_ids });
}

/** Recompute, store and permanently close a consolidation snapshot. */
export function closePeriod(db, periodId) {
  const stored = consolidatePeriod(db, periodId);
  const { lines, unmapped } = read(stored, 'consolidation.period', periodId);
  if (unmapped?.length) throw new Error(`Map these accounts before closing: ${unmapped.join(', ')}`);
  const off = round((lines ?? []).reduce((s, l) => s + l.total, 0));
  if (off) throw new Error(`The consolidated balances do not add up (difference ${off}); check eliminations and mappings`);
  return write(stored, 'consolidation.period', periodId, { state: 'closed' });
}

export const consolidationModels = {
  'consolidation.chart': {
    label: 'Consolidations',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      currency_id: { type: 'many2one', relation: 'res.currency', label: 'Group Currency', required: true },
      company_ids: {
        type: 'one2many', label: 'Companies',
        fields: { company_id: companyField, ownership: { type: 'float', label: 'Ownership (%)' }, method: { type: 'selection', label: 'Method', options: [['full', 'Full'], ['proportional', 'Proportional'], ['equity', 'Equity']] } },
        newLine: () => ({ ownership: 100, method: 'full' }),
      },
      account_ids: {
        type: 'one2many', label: 'Group Accounts',
        fields: { code: { type: 'char', label: 'Code' }, name: { type: 'char', label: 'Name' }, account_type: { type: 'selection', label: 'Type', options: ACCOUNT_TYPES }, source_codes: { type: 'char', label: 'Source Codes (comma-separated)' } },
        newLine: () => ({ code: '', name: '', account_type: 'asset_current', source_codes: '' }),
      },
    },
    defaults: () => ({ company_ids: [], account_ids: [] }),
    guard: chartGuard,
    list: ['name', 'currency_id'],
    kanban: { title: 'name', lines: ['currency_id'] },
    form: { title: 'name', groups: [['currency_id']], tabs: [{ label: 'Companies', fields: ['company_ids'] }, { label: 'Account Mapping', fields: ['account_ids'] }], chatter: true },
  },
  'consolidation.period': {
    label: 'Consolidation Periods',
    fields: {
      name: { type: 'char', label: 'Name' },
      chart_id: { type: 'many2one', relation: 'consolidation.chart', label: 'Consolidation', required: true },
      date_from: { type: 'date', label: 'Start Date', required: true },
      date_to: { type: 'date', label: 'End Date', required: true },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['closed', 'Closed']] },
      rate_ids: {
        type: 'one2many', label: 'Translation Rates',
        fields: { company_id: companyField, rate_avg: { type: 'float', label: 'Average Rate' }, rate_closing: { type: 'float', label: 'Closing Rate' } },
        newLine: () => ({ rate_avg: 1, rate_closing: 1 }),
      },
      lines: {
        type: 'one2many', label: 'Stored Balances', readonly: true, fields: resultFields,
      },
      display_lines: {
        type: 'one2many', label: 'Consolidated Balances', readonly: true, fields: resultFields,
        compute: (r) => (r.lines ?? []).map((line) => ({ ...line, by_company: JSON.stringify(line.by_company ?? {}) })),
      },
      unmapped: { type: 'tags', label: 'Unmapped Accounts', readonly: true },
    },
    defaults: () => ({ state: 'draft', date_from: `${today().slice(0, 4)}-01-01`, date_to: today(), rate_ids: [], lines: [], unmapped: [] }),
    guard: periodGuard,
    protectDelete: (db, r) => r.state === 'closed' ? 'Keep closed consolidation periods for the audit trail' : null,
    onchange: (r, field, db) => ['chart_id', 'date_from', 'date_to'].includes(field) ? { rate_ids: periodRates(db, r) } : {},
    list: ['name', 'chart_id', 'date_from', 'date_to', 'state'],
    kanban: { title: 'name', lines: ['chart_id', 'date_from', 'date_to'], badge: 'state' },
    form: {
      title: 'name', statusbar: 'state', lockedWhen: (r) => r.state === 'closed', groups: [['chart_id'], ['date_from', 'date_to']],
      tabs: [{ label: 'Translation Rates', fields: ['rate_ids'] }, { label: 'Consolidated Balances', readonly: true, fields: ['display_lines', 'unmapped'] }],
      buttons: [
        { label: 'Consolidate', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: consolidatePeriod(db, r.id) }) },
        { label: 'Close Period', when: (r) => r.state === 'draft', run: (db, r) => ({ db: closePeriod(db, r.id) }) },
      ], chatter: true,
    },
  },
};
