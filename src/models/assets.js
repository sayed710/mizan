// Fixed assets: depreciation boards and their posting.
import { read, write } from '../orm.js';
import { today } from './common.js';
import { accountId, journalId, postEntry } from './ledger.js';
import { postAnalytic } from './analyticplus.js';
import { cents } from '../money.js';

const DAY = 86400000;
const pad2 = (n) => String(n).padStart(2, '0');
const monthEnd = (y, m) => `${y}-${pad2(m)}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
const dayNumber = (iso) => Date.UTC(...iso.split('-').map((v, i) => Number(v) - (i === 1 ? 1 : 0))) / DAY;
const postedCents = (asset) => (asset.depreciation_ids ?? []).filter((l) => l.posted).reduce((s, l) => s + cents(l.amount), 0);

/** End date of period `i` counted from the acquisition period. */
function periodEnd(y, m, yearly, i) {
  if (yearly) return `${y + i}-12-31`;
  return monthEnd(y + Math.floor((m - 1 + i) / 12), ((m - 1 + i) % 12) + 1);
}

/** Share of the first period still ahead on the acquisition date (1 when prorata is off). */
function firstFraction(asset, y, m, yearly) {
  if (!asset.prorata) return 1;
  const start = yearly ? `${y}-01-01` : `${y}-${pad2(m)}-01`;
  const end = periodEnd(y, m, yearly, 0);
  const length = dayNumber(end) - dayNumber(start) + 1;
  return (dayNumber(end) - dayNumber(asset.acquisition_date) + 1) / length;
}

/** Depreciation lines dated at period ends; the last line absorbs rounding so the total equals the base. */
export function depreciationBoard(asset) {
  const n = Number(asset.method_number);
  const yearly = String(asset.method_period) === '12';
  const [y, m] = (asset.acquisition_date || today()).split('-').map(Number);
  const base = cents(asset.original_value) - cents(asset.salvage_value) - cents(asset.already_depreciated);
  const frac = firstFraction(asset, y, m, yearly);
  const periods = n + (frac < 1 ? 1 : 0);
  const rate = (Number(asset.method_progress_factor) || 0) / (yearly ? 1 : 12);
  const method = asset.method || 'linear';
  let remaining = base;
  let cumulated = cents(asset.already_depreciated);
  return Array.from({ length: periods }, (_, i) => {
    const elapsed = i === 0 ? 0 : frac + i - 1;
    const len = Math.min(i === 0 ? frac : 1, n - elapsed);
    const linear = method === 'linear' ? Math.round((base / n) * len) : Math.round((remaining * len) / (n - elapsed));
    const declining = Math.round(remaining * rate * len);
    const due = { linear, degressive: declining, degressive_then_linear: Math.max(declining, linear) }[method] ?? linear;
    const amount = i === periods - 1 ? remaining : Math.min(remaining, due);
    remaining -= amount;
    cumulated += amount;
    return { date: periodEnd(y, m, yearly, i), amount: amount / 100, cumulated: cumulated / 100, remaining: (cents(asset.original_value) - cumulated) / 100 };
  });
}

function validate(db, asset) {
  if (!(Number(asset.original_value) > 0)) throw new Error('The original value must be positive');
  if (!Number.isInteger(Number(asset.method_number)) || Number(asset.method_number) < 1) throw new Error('The duration must be at least 1 period');
  if (!(Number(asset.salvage_value || 0) < Number(asset.original_value))) throw new Error('The not depreciable value must be lower than the original value');
  if (!asset.acquisition_date) throw new Error('Set an acquisition date');

  const company = asset.company_id ?? 1;
  if (asset.company_id && !read(db, 'res.company', asset.company_id)) throw new Error('Asset company does not exist');

  const jId = asset.journal_id ?? journalId(db, 'MISC', company) ?? journalId(db, 'MISC');
  if (!jId) throw new Error('Asset journal not found');
  const j = read(db, 'account.journal', jId);
  if (!j) throw new Error('Asset journal not found');
  if (j.company_id && j.company_id !== company) throw new Error(`Journal ${j.name || j.code} belongs to another company`);

  for (const [field, code, label] of [
    ['account_asset_id', '151000', 'Asset'],
    ['account_depreciation_id', '152000', 'Depreciation'],
    ['account_depreciation_expense_id', '680000', 'Expense'],
  ]) {
    const id = asset[field] ?? accountId(db, code, company) ?? accountId(db, code);
    if (!id) continue;
    const acc = read(db, 'account.account', id);
    if (!acc) throw new Error('Asset account not found');
    if (acc.company_id && acc.company_id !== company) throw new Error(`${label} account ${acc.code || acc.name} belongs to another company`);
  }
}

function computeBoard(db, asset) {
  validate(db, asset);
  const depreciation_ids = depreciationBoard(asset).map((l) => ({ ...l, posted: false, move_id: null }));
  return write(db, 'account.asset', asset.id, { depreciation_ids });
}

/** Validate the asset, build its board and start depreciating. */
export function confirmAsset(db, asset) {
  return write(computeBoard(db, asset), 'account.asset', asset.id, { state: 'open' });
}

/** Post each unposted board line dated on or before `upTo`; the asset closes once all are posted. */
export function postDepreciation(db, asset, upTo = today()) {
  asset = read(db, 'account.asset', asset.id) ?? asset;
  if (asset.state !== 'open') return db;
  validate(db, asset);
  const company = asset.company_id ?? 1;
  const journal = asset.journal_id ?? journalId(db, 'MISC', company) ?? 'MISC';
  const expAcc = asset.account_depreciation_expense_id ?? asset.account_expense_id ?? '680000';
  const depAcc = asset.account_depreciation_id ?? '152000';
  const { db: next, lines } = (asset.depreciation_ids ?? []).reduce((acc, l) => {
    if (l.posted || l.date > upTo) return { ...acc, lines: [...acc.lines, l] };
    const { db: booked, id } = postEntry(acc.db, {
      journal, date: l.date, ref: `${asset.name} depreciation ${l.date}`,
      lines: [{ account: expAcc, debit: l.amount, analytic_distribution: asset.analytic_distribution }, { account: depAcc, credit: l.amount }],
      company,
    });
    return { db: postAnalytic(booked, id), lines: [...acc.lines, { ...l, posted: true, move_id: id }] };
  }, { db, lines: [] });
  return write(next, 'account.asset', asset.id, { depreciation_ids: lines, state: lines.every((l) => l.posted) ? 'close' : 'open' });
}

/** Post due depreciation, drop the rest of the board and book the sale or scrapping of the asset. */
export function disposeAsset(db, asset, { date, saleValue = 0, invoiceId = null, invoiceLine = 0 }) {
  asset = read(db, 'account.asset', asset.id) ?? asset;
  if (!['open', 'paused', 'close'].includes(asset.state) || asset.disposal_date) throw new Error('Only running or paused assets can be disposed');
  if (!date) throw new Error('Set a disposal date');
  if (!(Number(saleValue) >= 0)) throw new Error('The sale price cannot be negative');
  if ((asset.depreciation_ids ?? []).some((line) => line.posted && line.date > date)) throw new Error('Disposal date cannot precede posted depreciation');
  validate(db, asset);
  const depreciated = postDepreciation(db, asset, date);
  const current = read(depreciated, 'account.asset', asset.id);
  const kept = (current.depreciation_ids ?? []).filter((l) => l.posted);
  const original = cents(asset.original_value);
  const accumulated = postedCents(current) + cents(asset.already_depreciated);
  const sale = cents(saleValue);
  const invoice = invoiceId && read(depreciated, 'account.move', invoiceId);
  if (invoiceId && (invoice?.state !== 'posted' || invoice.move_type !== 'out_invoice' || (invoice.company_id ?? 1) !== (asset.company_id ?? 1))) throw new Error('Select a posted sale invoice in the asset company');
  const saleLine = invoice && (invoice.line_ids ?? []).find((line) => (line.invoice_sources ?? []).some((source) => source.index === Number(invoiceLine)));
  if (invoice && !saleLine) throw new Error('Sale invoice line not found');
  const loss = original - accumulated - sale;
  const company = asset.company_id ?? 1;
  const journal = asset.journal_id ?? journalId(depreciated, 'MISC', company) ?? 'MISC';
  const assetAcc = asset.account_asset_id ?? '151000';
  const depAcc = asset.account_depreciation_id ?? '152000';
  const lines = [
    { account: assetAcc, credit: original / 100 },
    accumulated > 0 && { account: depAcc, debit: accumulated / 100 },
    sale > 0 && { account: saleLine?.account_id ?? '101401', debit: sale / 100 },
    loss > 0 && { account: asset.account_loss_id ?? '690300', debit: loss / 100, analytic_distribution: asset.analytic_distribution },
    loss < 0 && { account: asset.account_gain_id ?? '450300', credit: -loss / 100, analytic_distribution: asset.analytic_distribution },
  ].filter(Boolean);
  const { db: booked, id } = postEntry(depreciated, { journal, date, ref: `${asset.name} disposal`, lines, company });
  return write(postAnalytic(booked, id), 'account.asset', asset.id, { depreciation_ids: kept, cancelled_depreciation_ids: (current.depreciation_ids ?? []).filter((l) => !l.posted).map((l) => ({ ...l, cancelled: true })), state: 'close', disposal_date: date, sale_value: sale / 100 });
}

export const assetModels = {
  'account.asset': {
    label: 'Assets',
    actions: { dispose: disposeAsset },
    fields: {
      name: { type: 'char', label: 'Asset Name', required: true },
      acquisition_date: { type: 'date', label: 'Acquisition Date' },
      original_value: { type: 'monetary', label: 'Original Value' },
      salvage_value: { type: 'monetary', label: 'Not Depreciable Value' },
      already_depreciated: { type: 'monetary', label: 'Depreciated at Import' },
      method: { type: 'selection', label: 'Method', options: [['linear', 'Straight Line'], ['degressive', 'Declining'], ['degressive_then_linear', 'Declining then Straight Line']] },
      method_number: { type: 'integer', label: 'Duration' },
      method_period: { type: 'selection', label: 'Period', options: [['1', 'Months'], ['12', 'Years']] },
      method_progress_factor: { type: 'float', label: 'Declining Factor' },
      prorata: { type: 'boolean', label: 'Prorata Temporis' },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Vendor' },
      model_id: { type: 'many2one', relation: 'account.asset.model', label: 'Depreciation Model' },
      account_asset_id: { type: 'many2one', relation: 'account.account', label: 'Fixed Asset Account' },
      account_depreciation_id: { type: 'many2one', relation: 'account.account', label: 'Depreciation Account' },
      account_expense_id: { type: 'many2one', relation: 'account.account', label: 'Model Expense Account (Fallback)' },
      journal_id: { type: 'many2one', relation: 'account.journal', label: 'Journal' },
      analytic_distribution: { type: 'distribution', label: 'Analytic Distribution' },
      bill_id: { type: 'many2one', relation: 'account.move', label: 'Bill' },
      bill_line: { type: 'integer', label: 'Bill Line', readonly: true },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['open', 'Running'], ['paused', 'Paused'], ['close', 'Closed'], ['cancel', 'Cancelled']] },
      book_value: { type: 'monetary', label: 'Book Value', readonly: true, compute: (r) => r.disposal_date ? 0 : (cents(r.original_value) - cents(r.already_depreciated) - postedCents(r)) / 100 },
      depreciation_ids: {
        type: 'one2many',
        label: 'Depreciation Board',
        fields: {
          date: { type: 'date', label: 'Date' },
          amount: { type: 'monetary', label: 'Depreciation' },
          cumulated: { type: 'monetary', label: 'Cumulative Depreciation' },
          remaining: { type: 'monetary', label: 'Book Value' },
          posted: { type: 'boolean', label: 'Posted' },
          move_id: { type: 'many2one', relation: 'account.move', label: 'Entry' },
        },
        newLine: () => ({ date: today(), amount: 0, cumulated: 0, remaining: 0, posted: false, move_id: null }),
      },
      cancelled_depreciation_ids: { type: 'one2many', label: 'Cancelled Depreciation', readonly: true, fields: {
        date: { type: 'date', label: 'Date' }, amount: { type: 'monetary', label: 'Depreciation' }, cumulated: { type: 'monetary', label: 'Cumulative Depreciation' }, remaining: { type: 'monetary', label: 'Book Value' }, posted: { type: 'boolean', label: 'Posted' }, move_id: { type: 'many2one', relation: 'account.move', label: 'Entry' }, cancelled: { type: 'boolean', label: 'Cancelled' },
      } },
      disposal_date: { type: 'date', label: 'Disposal Date' },
      sale_value: { type: 'monetary', label: 'Sale Price' },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company' },
      account_depreciation_expense_id: { type: 'many2one', relation: 'account.account', label: 'Depreciation Expense Account (Override)' },
      account_gain_id: { type: 'many2one', relation: 'account.account', label: 'Gain Account' },
      account_loss_id: { type: 'many2one', relation: 'account.account', label: 'Loss Account' },
    },
    defaults: () => ({ acquisition_date: today(), method: 'linear', method_number: 5, method_period: '12', method_progress_factor: 0.3, state: 'draft', depreciation_ids: [], company_id: 1 }),
    createDefaults: (db, vals) => {
      const model = vals?.model_id && read(db, 'account.asset.model', vals.model_id);
      if (!model) return {};
      return Object.fromEntries(['method', 'method_number', 'method_period', 'method_progress_factor', 'prorata', 'account_asset_id', 'account_depreciation_id', 'account_expense_id', 'journal_id', 'analytic_distribution'].filter((key) => model[key] !== undefined).map((key) => [key, model[key]]));
    },
    onchange: (r, key, db) => {
      if (key === 'model_id' && r.model_id) {
        const model = read(db, 'account.asset.model', r.model_id);
        if (model) {
          return {
            method: model.method ?? r.method,
            method_number: model.method_number ?? r.method_number,
            method_period: model.method_period ?? r.method_period,
            method_progress_factor: model.method_progress_factor ?? r.method_progress_factor,
            prorata: model.prorata !== undefined ? model.prorata : r.prorata,
            account_asset_id: model.account_asset_id ?? r.account_asset_id,
            account_depreciation_id: model.account_depreciation_id ?? r.account_depreciation_id,
            account_expense_id: model.account_expense_id ?? r.account_expense_id,
            journal_id: model.journal_id ?? r.journal_id,
            analytic_distribution: model.analytic_distribution ?? r.analytic_distribution,
          };
        }
      }
      return {};
    },
    groupBys: ['state', 'method'],
    filters: [[{ id: 'running', label: 'Running', fn: (r) => r.state === 'open' }, { id: 'closed', label: 'Closed', fn: (r) => r.state === 'close' }]],
    kanban: { title: 'name', lines: ['original_value', 'book_value', 'method'], badge: 'state' },
    list: ['acquisition_date', 'name', 'partner_id', 'model_id', 'original_value', 'book_value', 'method', 'state'],
    form: {
      statusbar: 'state',
      lockedWhen: (r) => ['close', 'cancel'].includes(r.state),
      buttons: [
        { label: 'Confirm', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: confirmAsset(db, r) }) },
        { label: 'Compute Depreciation', when: (r) => r.state === 'draft', run: (db, r) => ({ db: computeBoard(db, r) }) },
        { label: 'Post Depreciation', primary: true, when: (r) => r.state === 'open', run: (db, r) => ({ db: postDepreciation(db, read(db, 'account.asset', r.id)) }) },
        { label: 'Pause', when: (r) => r.state === 'open', vals: { state: 'paused' } },
        { label: 'Resume', primary: true, when: (r) => r.state === 'paused', vals: { state: 'open' } },
        { label: 'Sell or Dispose', when: (r) => ['open', 'paused', 'close'].includes(r.state) && !r.disposal_date,
          wizard: (db, r) => ({ title: 'Sell or Dispose', fields: [
            { name: 'date', type: 'date', label: 'Disposal Date', required: true, default: today() },
            { name: 'sale_value', type: 'monetary', label: 'Sale Price', required: true, default: 0 },
            { name: 'invoice_id', type: 'many2one', relation: 'account.move', label: 'Customer Invoice', domain: (invoice) => invoice.state === 'posted' && invoice.move_type === 'out_invoice' && (invoice.company_id ?? 1) === (r.company_id ?? 1) },
            { name: 'invoice_line', type: 'selection', label: 'Invoice Line', dependsOn: 'invoice_id', options: (currentDb, values) => (read(currentDb, 'account.move', values.invoice_id)?.invoice_line_ids ?? []).map((line, index) => [String(index), line.name || read(currentDb, 'product', line.product_id)?.name || `#${index + 1}`]) },
          ] }),
          run: (db, r, values = {}) => {
            if (values.invoice_id && (values.invoice_line == null || values.invoice_line === '')) throw new Error('Select a sale invoice line');
            if (values.sale_value != null && (!Number.isFinite(Number(values.sale_value)) || Number(values.sale_value) < 0)) throw new Error('The sale price cannot be negative');
            return { db: disposeAsset(db, r, { date: values.date ?? today(), saleValue: Number(values.sale_value ?? 0), invoiceId: values.invoice_id || null, invoiceLine: Number(values.invoice_line ?? 0) }) };
          } },
        { label: 'Cancel', when: (r) => r.state === 'draft', vals: { state: 'cancel' } },
      ],
      title: 'name',
      groups: [['model_id', 'original_value', 'salvage_value', 'already_depreciated', 'book_value', 'acquisition_date', 'partner_id', 'bill_id', 'company_id', 'journal_id', 'account_asset_id', 'account_depreciation_id', 'account_expense_id', 'account_depreciation_expense_id'], ['method', 'method_number', 'method_period', 'method_progress_factor', 'prorata', 'analytic_distribution', 'disposal_date', 'sale_value']],
      tabs: [{ label: 'Depreciation Board', fields: ['depreciation_ids', 'cancelled_depreciation_ids'] }],
      chatter: true,
    },
  },
};
