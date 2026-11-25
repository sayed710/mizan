// Fixed assets: depreciation boards and their posting.
import { create, postNote, read, search, write } from '../orm.js';
import { addDays, subtotal, today, validDate } from './common.js';
import { journalId, journalItemIdentity, postEntry, reconciledJournalItems, reversalLine } from './ledger.js';
import { postAnalytic } from './analyticplus.js';
import { cents } from '../money.js';
import { configuredAccount } from './configured-account.js';
import { currentCompany } from './company.js';
import { toCompany } from './currency.js';
import { t } from '../i18n.js';
import { assetDraftValues } from './accounting.js';

/** Depreciation settings of an asset without a model. */
export const ASSET_DEPRECIATION_DEFAULTS = {
  method: 'linear',
  method_mode: 'duration',
  method_rate: 0.2,
  method_number: 5,
  method_period: '12',
  method_progress_factor: 0.3,
  prorata: false,
  prorata_computation_type: 'none',
};

export const IMMUTABLE_ASSET_FIELDS = [
  'acquisition_date',
  'method',
  'method_progress_factor',
  'prorata',
  'prorata_computation_type',
  'prorata_date',
  'already_depreciated',
  'company_id',
  'account_asset_id',
  'account_depreciation_id',
  'account_depreciation_expense_id',
  'journal_id',
  'model_id',
];

export const CORE_ASSET_FIELDS = [
  ...IMMUTABLE_ASSET_FIELDS,
  'original_value',
  'salvage_value',
  'method_number',
  'method_period',
  'method_mode',
  'method_rate',
];

export const readonlyWhenNotDraft = (r) => Boolean(r?.state && r.state !== 'draft');

const DAY = 86400000;
const pad2 = (n) => String(n).padStart(2, '0');
const monthEnd = (y, m) => `${y}-${pad2(m)}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
const dayNumber = (iso) => Date.UTC(...iso.split('-').map((v, i) => Number(v) - (i === 1 ? 1 : 0))) / DAY;
const canResetAsset = (db, asset) => ['open', 'cancel'].includes(asset.state)
  && !(asset.depreciation_ids ?? []).some((line) => line.posted)
  && !(asset.revaluation_ids ?? []).some((entry) => entry.move_id)
  && !asset.origin_asset_id && !asset.parent_id && !asset.bill_id
  && (!db || !search(db, 'account.asset').some((child) => child.parent_id === asset.id || child.origin_asset_id === asset.id));

const postedCents = (asset) => (asset.depreciation_ids ?? []).filter((l) => l.posted).reduce((s, l) => s + cents(l.amount), 0);
const remainingDepreciableCents = (asset) => cents(asset.original_value)
  - cents(asset.salvage_value)
  - cents(asset.already_depreciated)
  - postedCents(asset);
const isDisposedAsset = (asset) => Boolean(asset?.disposal_date || asset?.disposal_move_id);
const hasDerivedAsset = (db, asset) => Boolean(db && search(db, 'account.asset').some((a) => a.origin_asset_id === asset.id));

/** Follow parent_id up to find the root ancestor asset ID. */
export function rootAssetId(db, assetOrId) {
  let curr = typeof assetOrId === 'object' && assetOrId !== null ? assetOrId : (read(db, 'account.asset', assetOrId) ?? null);
  const seen = new Set();
  while (curr && curr.parent_id && !seen.has(curr.id)) {
    seen.add(curr.id);
    const parent = read(db, 'account.asset', curr.parent_id);
    if (!parent) break;
    curr = parent;
  }
  return curr?.id ?? null;
}

/** Collect all undisposed gross-increase descendants of an asset in the hierarchy. */
export function assetDescendants(db, parentId) {
  const result = [];
  const queue = [parentId];
  const allAssets = db?.records?.['account.asset'] ?? [];
  const visited = new Set([parentId]);
  while (queue.length > 0) {
    const currentId = queue.shift();
    for (const child of allAssets) {
      if (child.parent_id === currentId && !visited.has(child.id)) {
        visited.add(child.id);
        queue.push(child.id);
        if (['open', 'paused', 'close'].includes(child.state) && !isDisposedAsset(child)) {
          result.push(child);
        }
      }
    }
  }
  return result;
}

export function pendingScheduleValid(asset, remaining) {
  const unposted = (asset.depreciation_ids ?? []).filter((line) => !line.posted);
  const unpostedTotal = unposted.reduce((sum, line) => sum + cents(line.amount), 0);
  if (remaining <= 0 || unposted.length === 0 || unpostedTotal !== remaining) return false;
  const posted = (asset.depreciation_ids ?? []).filter((line) => line.posted);
  const lastPostedDate = posted.length ? posted.at(-1).date : null;
  let prevDate = lastPostedDate;
  for (let i = 0; i < unposted.length; i++) {
    const line = unposted[i];
    if (!line.date || !validDate(line.date) || cents(line.amount) < 0 || line.move_id != null) {
      return false;
    }
    if (asset.acquisition_date && line.date < asset.acquisition_date) {
      return false;
    }
    if (prevDate != null) {
      if (line.date <= prevDate) return false;
    }
    prevDate = line.date;
  }
  return true;
}

function reopenAssetError(db, before, asset) {
  if (isDisposedAsset(before) || isDisposedAsset(asset) || hasDerivedAsset(db, before)) {
    return 'Cannot set a disposed or transferred asset to running';
  }
  if (!pendingScheduleValid(asset, remainingDepreciableCents(asset))) {
    return 'Closed asset has no remaining depreciation to run';
  }
  if (!isVerifiedReopenBoard(before, asset, db)) {
    return 'Reopening cannot alter the depreciation board';
  }
  return null;
}

/** True when a closed asset is neither disposed nor transferred and still has depreciable value to run. */
export function canSetAssetRunning(db, asset) {
  return Boolean(asset && asset.state === 'close' && !isDisposedAsset(asset) && !hasDerivedAsset(db, asset) && remainingDepreciableCents(asset) > 0);
}

// A cancellation must carry a complete, posted, line-for-line reversal for each linked entry.
function hasAssetReversal(db, moveId) {
  const source = read(db, 'account.move', moveId);
  if (!source || source.state !== 'posted') return false;
  const signature = (line, reverse = false) => JSON.stringify([
    line.account_id ?? line.account, cents(reverse ? line.credit : line.debit), cents(reverse ? line.debit : line.credit),
    line.partner_id ?? null, line.currency_id ?? null,
    Number(line.amount_currency || 0) * (reverse ? -1 : 1),
    JSON.stringify(Object.entries(line.analytic_distribution ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  ]);
  const expected = (source.line_ids ?? []).map((line) => signature(line, true)).sort();
  const reversals = search(db, 'account.move').filter((move) => move.state === 'posted' && move.reversed_entry_id === moveId);
  return reversals.length === 1 && reversals[0].move_type === 'entry'
    && (reversals[0].company_id ?? 1) === (source.company_id ?? 1)
    && (reversals[0].date ?? reversals[0].invoice_date) >= (source.date ?? source.invoice_date)
    && JSON.stringify((reversals[0].line_ids ?? []).map((line) => signature(line)).sort()) === JSON.stringify(expected);
}
const isActiveCompanyAccount = (account, company = 1) => Boolean(
  account && account.active !== false && !account.deprecated && (!account.company_id || account.company_id === company),
);
const isValidFixedAssetAccount = (account, company = 1) => Boolean(
  account && account.active !== false && (!account.company_id || account.company_id === company) && account.account_type === 'asset_fixed',
);

function requireAssetAccount(db, asset, field, label) {
  const company = asset.company_id ?? 1;
  const id = asset[field];
  if (!id) throw new Error(`Configure the ${label} account on asset ${asset.name}`);
  const acc = read(db, 'account.account', id);
  if (!acc || acc.active === false) throw new Error(`Configure the ${label} account on asset ${asset.name}`);
  if (acc.company_id && acc.company_id !== company) throw new Error(`${label} account ${acc.code || acc.name} belongs to another company`);
  return acc;
}

function sourceMoveJournalItems(db, moveId) {
  const move = moveId ? read(db, 'account.move', moveId) : null;
  if (!move || move.state !== 'posted') return { move: null, items: [] };
  const date = move.date ?? move.invoice_date;
  const company_id = move.company_id ?? 1;
  const items = reconciledJournalItems(db, move, { partialMatching: true }).map((line) => ({
    ...line,
    line_identity: journalItemIdentity(line),
    move_id: move.id,
    date,
    company_id,
  }));
  return { move, items };
}

function billLineIndicesForItem(move, line) {
  if (move?.move_type !== 'in_invoice' || !Array.isArray(line?.invoice_sources)) return new Set();
  return new Set(line.invoice_sources.map((s) => s.index).filter(Number.isInteger));
}

export function journalItemHasAsset(db, move, line, excludeAssetId = null) {
  if (!move || !line) return false;
  const moveId = line.move_id ?? move.id;
  const identity = line.line_identity ?? journalItemIdentity(line);
  const billIndices = billLineIndicesForItem(move, line);
  return (db.records['account.asset'] ?? []).some((other) => (
    other.id !== excludeAssetId
    && other.state !== 'cancel'
    && (
      (other.source_move_id === moveId && other.source_line_identity === identity)
      || (billIndices.size > 0 && other.bill_id === moveId && billIndices.has(other.bill_line))
    )
  ));
}

export function canCreateAssetFromJournalItem(db, line, move = null) {
  if (!line) return false;
  const sourceMove = move ?? (line.move_id ? read(db, 'account.move', line.move_id) : null);
  if (!sourceMove || sourceMove.state !== 'posted') return false;
  if (cents(line.debit) - cents(line.credit) <= 0) return false;
  if (!isValidFixedAssetAccount(read(db, 'account.account', line.account_id), sourceMove.company_id ?? 1)) return false;
  return !journalItemHasAsset(db, sourceMove, line);
}

export function assetAccountGuard(db, _before, asset) {
  for (const field of ['account_asset_id', 'account_depreciation_id', 'account_depreciation_expense_id']) {
    if (!asset[field]) continue;
    const account = read(db, 'account.account', asset[field]);
    if (!account || account.active === false || (account.company_id && account.company_id !== (asset.company_id ?? 1))) return 'Asset accounts must be active and belong to the asset company';
  }
  return null;
}

export function saleInvoiceLineInfo(invoice, invoiceLine) {
  if (!invoice || invoiceLine == null || invoiceLine === '') return null;
  const idx = Number(invoiceLine);
  if (!Number.isInteger(idx)) return null;
  const line = (invoice.line_ids ?? []).find((l) => (l.invoice_sources ?? []).some((s) => s.index === idx));
  if (!line) return null;
  const source = (line.invoice_sources ?? []).find((s) => s.index === idx);
  if (!source) return null;
  return { line, source, amount: cents(source.amount), accountId: line.account_id };
}

/** Shared sale-invoice rules for Sell or Dispose and the asset guard: returns { error, lineInfo }. */
export function saleInvoiceError(db, asset, { invoice, invoiceLine, date, saleValue }) {
  const company = asset?.company_id ?? 1;
  if (!invoice || invoice.state !== 'posted' || invoice.move_type !== 'out_invoice' || (invoice.company_id ?? 1) !== company) {
    return { error: 'Sale invoice must be a posted customer invoice in the asset company', lineInfo: null };
  }
  if (date && [invoice.date, invoice.invoice_date].some((d) => d && d > date)) {
    return { error: 'Disposal date cannot precede the sale invoice date', lineInfo: null };
  }
  const lineInfo = saleInvoiceLineInfo(invoice, invoiceLine);
  if (!lineInfo) return { error: 'Sale invoice line not found', lineInfo: null };
  if (saleValue == null || saleValue === '' || cents(saleValue) !== lineInfo.amount) {
    return { error: 'Sale price must match the invoice line amount', lineInfo };
  }
  const lineUsedElsewhere = (db.records['account.asset'] ?? []).some(
    (other) => other.id !== asset?.id && other.disposal_date && ((other.sale_invoice_id === invoice.id && other.sale_invoice_line === Number(invoiceLine)) || (other.sale_invoice_line_ids ?? []).some((line) => line.invoice_id === invoice.id && line.line_index === Number(invoiceLine))),
  );
  if (lineUsedElsewhere) return { error: 'Sale invoice line already used by another asset disposal', lineInfo };
  return { error: null, lineInfo };
}

/** Options for selecting posted invoice lines belonging to the asset company. */
export function assetSaleInvoiceLineOptions(db, asset, date) {
  return search(db, 'account.move').filter((invoice) => invoice.state === 'posted' && invoice.move_type === 'out_invoice' && (invoice.company_id ?? 1) === (asset.company_id ?? 1)).flatMap((invoice) => (invoice.invoice_line_ids ?? []).flatMap((line, index) => {
    const info = saleInvoiceLineInfo(invoice, index);
    if (!info || saleInvoiceError(db, asset, { invoice, invoiceLine: index, date, saleValue: info.amount / 100 }).error) return [];
    const label = line.name || (line.product_id && read(db, 'product', line.product_id)?.name) || `#${index + 1}`;
    return [{ key: `${invoice.id}:${index}`, invoice_id: invoice.id, line_index: index, label: `${invoice.name || invoice.ref || `#${invoice.id}`} · ${label} · ${(info.amount / 100).toFixed(2)}` }];
  }));
}

export function validateAssetIntegrity(db, before, asset, vals) {
  const company = asset.company_id ?? 1;
  if (asset.asset_group_id) {
    const group = read(db, 'account.asset.group', asset.asset_group_id);
    if (!group || (group.company_id ?? 1) !== company) return 'Asset group must belong to the asset company';
  }
  if ((asset.activation_date || asset.activation_opening_move_id || asset.activation_value != null) && !asset.activation_move_id) return 'Invalid asset activation entries';
  if (asset.activation_move_id && !before?.activation_move_id && before?.state !== 'open') return 'Invalid asset activation state';
  if (before?.activation_move_id && (before.activation_move_id !== asset.activation_move_id || before.activation_opening_move_id !== asset.activation_opening_move_id || before.activation_date !== asset.activation_date || cents(before.activation_value) !== cents(asset.activation_value) || before.state !== asset.state)) return 'Asset activation cannot be changed';
  if (before?.parent_id && before.parent_id !== asset.parent_id) return 'Asset parent cannot be changed';
  if (before?.gross_increase_move_id && before.gross_increase_move_id !== asset.gross_increase_move_id) return 'Gross increase entry cannot be changed';
  if (before?.origin_asset_id && (before.origin_asset_id !== asset.origin_asset_id || before.transfer_move_id !== asset.transfer_move_id)) return 'Asset transfer cannot be changed';
  if (before?.source_move_id && (before.source_move_id !== asset.source_move_id || before.source_line_identity !== asset.source_line_identity)) return 'Asset source journal item cannot be changed';
  const sourceSetOrReactivated = Boolean(asset.source_move_id || asset.source_line_identity) && asset.state !== 'cancel'
    && (!before?.source_move_id || before.state === 'cancel' || (before.state === 'draft' && (asset.state !== 'draft' || ['original_value', 'account_asset_id', 'acquisition_date'].some((field) => asset[field] !== before[field]))));
  if (sourceSetOrReactivated) {
    if (!asset.source_move_id || !asset.source_line_identity) return 'Invalid asset source journal item';
    const { move, items } = sourceMoveJournalItems(db, asset.source_move_id);
    const matches = items.filter((line) => line.line_identity === asset.source_line_identity);
    const baseOrigCents = cents(asset.original_value) - (asset.revaluation_ids ?? []).reduce((sum, item) => sum + cents(item.amount), 0);
    if (!move || matches.length !== 1 || !isValidFixedAssetAccount(read(db, 'account.account', matches[0].account_id), company) || matches[0].company_id !== company || matches[0].account_id !== asset.account_asset_id || cents(matches[0].debit) - cents(matches[0].credit) <= 0 || cents(matches[0].debit) - cents(matches[0].credit) !== baseOrigCents || matches[0].date !== asset.acquisition_date) return 'Invalid asset source journal item';
    if (asset.state !== 'cancel' && journalItemHasAsset(db, move, matches[0], asset.id)) return 'Journal item already has an asset';
  }
  if (asset.parent_id) {
    const parent = read(db, 'account.asset', asset.parent_id);
    const move = read(db, 'account.move', asset.gross_increase_move_id);
    const original = cents(asset.original_value) - (asset.revaluation_ids ?? []).reduce((sum, item) => sum + cents(item.amount), 0);
    if (!parent || parent.id === asset.id || (parent.company_id ?? 1) !== company || !move || move.state !== 'posted' || move.move_type !== 'entry' || (move.company_id ?? 1) !== company || move.date !== asset.acquisition_date || !(move.line_ids ?? []).some((line) => line.account_id === asset.account_asset_id && cents(line.debit) - cents(line.credit) === original) || (db.records['account.asset'] ?? []).some((other) => other.id !== asset.id && other.gross_increase_move_id === move.id)) return 'Invalid gross increase parent or entry';
  }
  if (asset.origin_asset_id) {
    const origin = read(db, 'account.asset', asset.origin_asset_id);
    const amount = cents(asset.original_value) - (asset.revaluation_ids ?? []).reduce((sum, item) => sum + cents(item.amount), 0);
    const transfer = read(db, 'account.move', asset.transfer_move_id);
    const duplicate = (db.records['account.asset'] ?? []).some((other) => other.id !== asset.id && other.state !== 'cancel' && other.origin_asset_id === asset.origin_asset_id);
    if (duplicate) return 'Activation parent already has a child asset';
    if (!origin || origin.id === asset.id || (origin.company_id ?? 1) !== company || !isValidFixedAssetAccount(read(db, 'account.account', asset.account_asset_id), company) || amount !== cents(origin.original_value) - cents(origin.already_depreciated) - postedCents(origin) || asset.acquisition_date < origin.acquisition_date) return 'Invalid asset transfer';
    if (origin.account_asset_id !== asset.account_asset_id && (!transfer || transfer.state !== 'posted' || transfer.move_type !== 'entry' || (transfer.company_id ?? 1) !== company || transfer.date !== asset.acquisition_date || !(transfer.line_ids ?? []).some((line) => line.account_id === origin.account_asset_id && cents(line.credit) - cents(line.debit) === amount) || !(transfer.line_ids ?? []).some((line) => line.account_id === asset.account_asset_id && cents(line.debit) - cents(line.credit) === amount))) return 'Invalid asset transfer';
  }
  if (asset.activation_move_id) {
    const close = read(db, 'account.move', asset.activation_move_id);
    const opening = read(db, 'account.move', asset.activation_opening_move_id);
    const amount = cents(asset.activation_value);
    const accumulated = cents(asset.original_value) - amount;
    const has = (move, account, side, value) => (move?.line_ids ?? []).some((line) => line.account_id === account && cents(line[side]) === value);
    if (asset.state !== 'close' || amount <= 0 || amount !== cents(asset.original_value) - cents(asset.already_depreciated) - postedCents(asset) || !close || !opening || close.state !== 'posted' || opening.state !== 'posted' || !asset.activation_date || (asset.acquisition_date && asset.activation_date < asset.acquisition_date) || (asset.depreciation_ids ?? []).some((l) => l.posted && l.date > asset.activation_date) || (asset.revaluation_ids ?? []).some((r) => r.date > asset.activation_date) || close.date !== asset.activation_date || opening.date !== asset.activation_date || (close.company_id ?? 1) !== company || (opening.company_id ?? 1) !== company || !has(close, asset.account_asset_id, 'credit', cents(asset.original_value)) || !has(close, asset.account_asset_id, 'debit', amount) || (accumulated > 0 && !has(close, asset.account_depreciation_id, 'debit', accumulated)) || !has(opening, asset.account_asset_id, 'credit', amount)) return 'Invalid asset activation entries';
  }

  // Q4: Disposal field rules and move verification
  if (before?.disposal_date && (before.refund_disposal_move_id ?? null) !== (asset.refund_disposal_move_id ?? null)) return 'Disposal fields cannot be modified once set';
  if (asset.refund_disposal_move_id && !asset.disposal_date) return 'Disposal date is required when disposing of an asset';
  const hasDisposal = asset.disposal_date != null && asset.disposal_date !== '';
  const hasSale = asset.sale_value != null && asset.sale_value !== '';
  const hasDisposalMove = asset.disposal_move_id != null;
  const hasSaleInvoice = asset.sale_invoice_id != null;
  const hasSaleLine = asset.sale_invoice_line != null && asset.sale_invoice_line !== '';
  const hasSaleLines = (asset.sale_invoice_line_ids ?? []).length > 0;
  const hasAnyDisposal = hasDisposal || hasSale || hasDisposalMove || hasSaleInvoice || hasSaleLine || hasSaleLines;

  const beforeHasDisposal = before?.disposal_date != null && before.disposal_date !== '';
  const beforeHasSale = before?.sale_value != null && before.sale_value !== '';
  const beforeHasDisposalMove = before?.disposal_move_id != null;
  const beforeHasSaleInvoice = before?.sale_invoice_id != null;
  const beforeHasSaleLine = before?.sale_invoice_line != null && before.sale_invoice_line !== '';
  const beforeHadAnyDisposal = beforeHasDisposal || beforeHasSale || beforeHasDisposalMove || beforeHasSaleInvoice || beforeHasSaleLine || (before?.sale_invoice_line_ids ?? []).length > 0;

  if (beforeHadAnyDisposal) {
    // Legacy closed assets or already-disposed assets: disposal fields are immutable once set
    const sameDate = (asset.disposal_date || null) === (before.disposal_date || null);
    const sameSale = (asset.sale_value == null || asset.sale_value === '' ? null : cents(asset.sale_value)) === (before.sale_value == null || before.sale_value === '' ? null : cents(before.sale_value));
    const sameMove = (asset.disposal_move_id ?? null) === (before.disposal_move_id ?? null);
    const sameInvoice = (asset.sale_invoice_id ?? null) === (before.sale_invoice_id ?? null);
    const sameLine = (asset.sale_invoice_line == null || asset.sale_invoice_line === '' ? null : Number(asset.sale_invoice_line)) === (before.sale_invoice_line == null || before.sale_invoice_line === '' ? null : Number(before.sale_invoice_line));
    if (!sameDate || !sameSale || !sameMove || !sameInvoice || !sameLine || JSON.stringify(asset.sale_invoice_line_ids ?? []) !== JSON.stringify(before.sale_invoice_line_ids ?? [])) {
      return 'Disposal fields cannot be modified once set';
    }
  } else if (hasAnyDisposal) {
    // Disposal fields are being first set
    if (asset.state !== 'close' || !before?.state || before.state === 'draft') {
      return 'Disposal fields can only be set through Sell or Dispose';
    }
    if (!hasDisposal) {
      return 'Disposal date is required when disposing of an asset';
    }
    if (!asset.disposal_move_id) {
      return 'Disposal move is required when disposing of an asset';
    }
    const dispMove = read(db, 'account.move', asset.disposal_move_id);
    if (!dispMove || dispMove.state !== 'posted' || (dispMove.company_id ?? 1) !== company) {
      return 'Disposal move must be a posted entry in the asset company';
    }
    const origCents = cents(asset.original_value);
    const accumulated = postedCents(asset) + cents(asset.already_depreciated);
    const fixedCredit = (dispMove.line_ids ?? []).find(
      (l) => l.account_id === asset.account_asset_id && cents(l.credit) === origCents && (cents(l.debit) || 0) === 0,
    );
    if (!fixedCredit || asset.refund_disposal_move_id) {
      const refund = read(db, 'account.move', asset.refund_disposal_move_id);
      const bill = read(db, 'account.move', asset.bill_id);
      const source = bill?.invoice_line_ids?.[asset.bill_line];
      const refundAmount = (refund?.invoice_line_ids ?? []).filter((line) => source?.line_id && line.source_line_id === source.line_id)
        .reduce((sum, line) => sum + cents(toCompany(db, refund.currency_id, Math.abs(subtotal(line, db)), refund.invoice_date ?? refund.date, company)), 0);
      const fixedRefund = (refund?.line_ids ?? []).some((line) => line.account_id === asset.account_asset_id && cents(line.credit) >= origCents);
      const depDebit = (dispMove.line_ids ?? []).some((line) => line.account_id === asset.account_depreciation_id && cents(line.debit) === accumulated);
      const gainId = read(db, 'res.company', company)?.gain_account_id;
      const gainCredit = (dispMove.line_ids ?? []).some((line) => line.account_id === gainId && cents(line.credit) === accumulated);
      if (!refund || refund.state !== 'posted' || refund.move_type !== 'in_refund' || refund.reversed_entry_id !== asset.bill_id || (refund.company_id ?? 1) !== company || refundAmount < origCents || !fixedRefund || !depDebit || !gainCredit) {
        return 'Disposal move must credit the fixed asset account by the asset original value';
      }
    }
    const rootId = rootAssetId(db, asset);
    const moveUsedElsewhere = (db.records['account.asset'] ?? []).some(
      (a) => (a.id !== asset.id && rootAssetId(db, a) !== rootId && a.disposal_move_id === asset.disposal_move_id)
        || (a.depreciation_ids ?? []).some((l) => l.move_id === asset.disposal_move_id)
        || (a.revaluation_ids ?? []).some((r) => r.move_id === asset.disposal_move_id),
    );
    if (moveUsedElsewhere) {
      return 'Disposal move cannot be shared with another asset';
    }
    if (hasSaleLines) {
      if (hasSaleInvoice || hasSaleLine) return 'Disposal fields can only be set through Sell or Dispose';
      const seen = new Set();
      const accounts = new Map();
      let total = 0;
      for (const selected of asset.sale_invoice_line_ids) {
        const key = `${selected.invoice_id}:${selected.line_index}`;
        if (seen.has(key)) return 'Sale invoice line already used by another asset disposal';
        seen.add(key);
        const invoice = read(db, 'account.move', selected.invoice_id);
        const info = saleInvoiceLineInfo(invoice, selected.line_index);
        const { error } = saleInvoiceError(db, asset, { invoice, invoiceLine: selected.line_index, date: asset.disposal_date, saleValue: info?.amount / 100 });
        if (error) return error;
        total += info.amount;
        accounts.set(info.accountId, (accounts.get(info.accountId) ?? 0) + info.amount);
      }
      if (total !== cents(asset.sale_value)) return 'Sale price must match the invoice line amount';
      const linkedChildren = (db.records['account.asset'] ?? []).filter((a) => {
        if (a.id === asset.id || rootAssetId(db, a) !== rootId) return false;
        return a.disposal_move_id === asset.disposal_move_id;
      });
      const totalOrig = origCents + linkedChildren.reduce((sum, c) => sum + cents(c.original_value), 0);
      const totalAcc = accumulated + linkedChildren.reduce((sum, c) => sum + postedCents(c) + cents(c.already_depreciated), 0);
      const netLoss = totalOrig - totalAcc - cents(asset.sale_value);
      for (const [account, amount] of accounts) {
        let otherDebit = 0;
        if (asset.account_asset_id === account) otherDebit -= origCents;
        if (asset.account_depreciation_id === account) otherDebit += accumulated;
        for (const c of linkedChildren) {
          if (c.account_asset_id === account) otherDebit -= cents(c.original_value);
          if (c.account_depreciation_id === account) otherDebit += (postedCents(c) + cents(c.already_depreciated));
        }
        if (netLoss !== 0) {
          const lossLine = (dispMove.line_ids ?? []).find((l) => (
            netLoss > 0
              ? (cents(l.debit) === netLoss && (cents(l.credit) || 0) === 0)
              : (cents(l.credit) === -netLoss && (cents(l.debit) || 0) === 0)
          ) && l.account_id === account && l.account_id !== asset.account_asset_id && !linkedChildren.some((c) => c.account_asset_id === l.account_id));
          if (lossLine) otherDebit += netLoss;
        }
        const debit = (dispMove.line_ids ?? []).filter((line) => line.account_id === account).reduce((sum, line) => sum + cents(line.debit) - cents(line.credit), 0);
        if (debit - otherDebit !== amount) return 'Disposal move must book the sale on the sale invoice line account';
      }
    } else if (asset.sale_invoice_id != null) {
      const saleInv = read(db, 'account.move', asset.sale_invoice_id);
      const { error, lineInfo } = saleInvoiceError(db, asset, { invoice: saleInv, invoiceLine: asset.sale_invoice_line, date: asset.disposal_date, saleValue: asset.sale_value });
      if (error) return error;
      if (lineInfo.amount > 0) {
        const saleDebit = (dispMove.line_ids ?? []).find(
          (l) => l.account_id === lineInfo.accountId && cents(l.debit) === lineInfo.amount && (cents(l.credit) || 0) === 0,
        );
        if (!saleDebit) {
          return 'Disposal move must book the sale on the sale invoice line account';
        }
      }
    } else {
      if (asset.sale_invoice_line != null && asset.sale_invoice_line !== '') {
        return 'Sale invoice line must be empty without a sale invoice';
      }
      if (cents(asset.sale_value) > 0) {
        return 'Select the customer invoice for this sale';
      }
    }
  } else if (asset.state !== 'close' && (hasDisposal || hasSale)) {
    return 'Disposal fields can only be set through Sell or Dispose';
  }

  const afterLines = asset.depreciation_ids ?? [];

  // Non-draft asset checks
  if (before?.state && before.state !== 'draft') {
    // G1: Cannot reset confirmed asset to draft
    if (asset.state === 'draft' && (!canResetAsset(db, before) || (asset.depreciation_ids ?? []).some((line) => line.posted))) {
      return 'Cannot reset a confirmed asset to draft';
    }

    if (before.state === 'open' && asset.state === 'cancel' && (before.origin_asset_id || before.parent_id || search(db, 'account.asset').some((child) => child.parent_id === before.id || child.origin_asset_id === before.id) || ((before.depreciation_ids ?? []).some((line) => line.posted) || (before.revaluation_ids ?? []).some((entry) => entry.move_id)) && (asset.depreciation_ids ?? []).some((line) => !line.posted) || [...(before.depreciation_ids ?? []).filter((line) => line.posted).map((line) => line.move_id), ...(before.revaluation_ids ?? []).filter((entry) => entry.move_id).map((entry) => entry.move_id)].some((id) => !hasAssetReversal(db, id)))) {
      return 'Cannot cancel an asset with posted entries or linked assets';
    }

    if (before.state === 'close' && ['open', 'paused'].includes(asset.state)) {
      const reopenErr = reopenAssetError(db, before, asset);
      if (reopenErr) return reopenErr;
    }

    // G2: Immutable core fields
    for (const field of IMMUTABLE_ASSET_FIELDS) {
      if (field === 'already_depreciated') {
        if (cents(asset.already_depreciated) !== cents(before.already_depreciated)) {
          return 'Cannot modify core asset fields once confirmed';
        }
      } else if (field === 'prorata') {
        if (Boolean(asset.prorata) !== Boolean(before.prorata)) {
          return 'Cannot modify core asset fields once confirmed';
        }
      } else if (field === 'method_progress_factor') {
        if (Number(asset.method_progress_factor || 0) !== Number(before.method_progress_factor || 0)) {
          return 'Cannot modify core asset fields once confirmed';
        }
      } else if ((asset[field] ?? null) !== (before[field] ?? null)) {
        return 'Cannot modify core asset fields once confirmed';
      }
    }

    // Q1: Posted depreciation lines immutability on EVERY write
    const beforePosted = (before.depreciation_ids ?? []).filter((l) => l.posted);
    for (const bp of beforePosted) {
      const ap = afterLines.find((l) => l.date === bp.date);
      if (!ap) {
        return 'Posted depreciation lines cannot be modified';
      }
      if (cents(ap.amount) !== cents(bp.amount)) {
        return 'Posted depreciation lines cannot be modified';
      }
      if (ap.posted && ap.move_id === bp.move_id) {
        continue;
      }
      // Exception: reverseDepreciation moves line from posted -> unposted when move is reversed by a posted reversal
      if (!ap.posted && ap.move_id === null) {
        const hasReversal = (db.records['account.move'] ?? []).some(
          (m) => m.state === 'posted' && m.reversed_entry_id === bp.move_id,
        );
        if (hasReversal) {
          continue;
        }
      }
      return 'Posted depreciation lines cannot be modified';
    }

    // Q3: revaluation_ids prefix immutability and move verification
    const beforeRevals = before.revaluation_ids ?? [];
    const afterRevals = asset.revaluation_ids ?? [];
    if (afterRevals.length < beforeRevals.length) {
      return 'Existing value adjustments cannot be removed';
    }
    for (let i = 0; i < beforeRevals.length; i++) {
      const br = beforeRevals[i];
      const ar = afterRevals[i];
      if (!ar || ar.date !== br.date || cents(ar.amount) !== cents(br.amount) || ar.move_id !== br.move_id) {
        return 'Existing value adjustments cannot be modified';
      }
    }
    const newRevals = afterRevals.slice(beforeRevals.length);
    for (const r of newRevals) {
      const amtCents = cents(r.amount);
      if (amtCents !== 0) {
        if (!r.move_id) {
          return 'Value adjustment must reference a posted move in the asset company';
        }
        const move = read(db, 'account.move', r.move_id);
        if (!move || move.state !== 'posted' || (move.company_id ?? 1) !== company) {
          return 'Value adjustment must reference a posted move in the asset company';
        }
        const fixedAcc = asset.account_asset_id;
        if (amtCents > 0) {
          const hasDebit = (move.line_ids ?? []).some(
            (ml) => ml.account_id === fixedAcc && cents(ml.debit) === amtCents && (cents(ml.credit) || 0) === 0,
          );
          if (!hasDebit) {
            return 'Value adjustment move must book the adjustment amount on the fixed asset account';
          }
        } else {
          const hasCredit = (move.line_ids ?? []).some(
            (ml) => ml.account_id === fixedAcc && cents(ml.credit) === -amtCents && (cents(ml.debit) || 0) === 0,
          );
          if (!hasCredit) {
            return 'Value adjustment move must book the adjustment amount on the fixed asset account';
          }
        }
      }
    }
    const addedRevalCents = newRevals.reduce((s, r) => s + cents(r.amount), 0);
    const origDeltaCents = cents(asset.original_value) - cents(before.original_value);
    if (origDeltaCents !== addedRevalCents) {
      return 'Original value change must match recorded value adjustments';
    }

    // G3: Board totals consistency when original_value, salvage_value or method_number changed
    const origChanged = origDeltaCents !== 0;
    const salvageChanged = cents(asset.salvage_value) !== cents(before.salvage_value);
    const methodNumChanged = asset.method_number !== before.method_number;
    const methodPeriodChanged = asset.method_period !== before.method_period;
    const methodModeChanged = (asset.method_mode ?? 'duration') !== (before.method_mode ?? 'duration');
    const methodRateChanged = (asset.method_rate ?? null) !== (before.method_rate ?? null);
    if ((methodPeriodChanged || methodModeChanged || methodRateChanged) && JSON.stringify(afterLines.filter((l) => !l.posted)) === JSON.stringify((before.depreciation_ids ?? []).filter((l) => !l.posted))) {
      return 'Cannot modify core asset fields once confirmed';
    }
    if (origChanged || salvageChanged || methodNumChanged || methodPeriodChanged || methodModeChanged || methodRateChanged) {
      if (asset.method === 'no_depreciation') {
        if (afterLines.length > 0) {
          return 'Depreciation board is inconsistent with asset values';
        }
      } else {
        const boardCents = afterLines.filter((l) => !l.cancelled).reduce((s, l) => s + cents(l.amount), 0);
        const expectedCents = cents(asset.original_value) - cents(asset.salvage_value) - cents(asset.already_depreciated);
        if (boardCents !== expectedCents) {
          return 'Depreciation board is inconsistent with asset values';
        }
        if (methodNumChanged) {
          const nonCancelledCount = afterLines.filter((l) => !l.cancelled).length;
          const expectedCount = Math.ceil(Number(asset.method_number));
          if (nonCancelledCount !== expectedCount && nonCancelledCount !== expectedCount + 1) {
            return 'Depreciation board is inconsistent with asset duration';
          }
        }
      }
    }
  }

  // Q2: A line may become posted:true (newly, or appear already posted) only if its move_id references a posted move
  const beforePostedSet = new Set(
    (before?.depreciation_ids ?? [])
      .filter((l) => l.posted)
      .map((l) => `${l.date}:${cents(l.amount)}:${l.move_id}`),
  );
  const afterPosted = afterLines.filter((l) => l.posted);
  for (const ap of afterPosted) {
    const key = `${ap.date}:${cents(ap.amount)}:${ap.move_id}`;
    if (beforePostedSet.has(key)) {
      continue;
    }
    if (!ap.move_id) {
      return 'Depreciation move must be a posted entry debiting depreciation expense and crediting depreciation account';
    }
    const move = read(db, 'account.move', ap.move_id);
    if (!move || move.state !== 'posted' || (move.company_id ?? 1) !== company) {
      return 'Depreciation move must be a posted entry debiting depreciation expense and crediting depreciation account';
    }
    const lineCents = cents(ap.amount);
    if (lineCents < 0) {
      const additions = (asset.revaluation_ids ?? []).slice((before?.revaluation_ids ?? []).length);
      const refund = additions.map((entry) => read(db, 'account.move', entry.move_id)).find((entry) => entry?.state === 'posted' && entry.move_type === 'in_refund' && entry.reversed_entry_id === asset.bill_id);
      const excess = Math.max(0, postedCents(before ?? {}) + cents(before?.already_depreciated) - cents(asset.original_value));
      if (!refund || -lineCents !== excess) return 'Depreciation reversal must match the excess from a vendor refund';
    }
    const expLine = (move.line_ids ?? []).find(
      (ml) => ml.account_id === asset.account_depreciation_expense_id && (lineCents < 0 ? cents(ml.credit) === -lineCents && !cents(ml.debit) : cents(ml.debit) === lineCents && !cents(ml.credit)),
    );
    const depLine = (move.line_ids ?? []).find(
      (ml) => ml.account_id === asset.account_depreciation_id && (lineCents < 0 ? cents(ml.debit) === -lineCents && !cents(ml.credit) : cents(ml.credit) === lineCents && !cents(ml.debit)),
    );
    if (!expLine || !depLine) {
      return 'Depreciation move must be a posted entry debiting depreciation expense and crediting depreciation account';
    }
    if (afterLines.filter((l) => l.move_id === ap.move_id).length !== 1) {
      return 'Depreciation move cannot be shared between board lines';
    }
    const otherAssetShares = (db.records['account.asset'] ?? []).some(
      (a) => a.id !== asset.id && (a.depreciation_ids ?? []).some((l) => l.move_id === ap.move_id),
    );
    if (otherAssetShares) {
      return 'Depreciation move cannot be shared between board lines';
    }
  }

  if (asset.model_id) {
    const model = read(db, 'account.asset.model', asset.model_id);
    if (!model && (!before || asset.model_id !== before.model_id)) {
      return 'Select an existing depreciation model';
    }
    if (model?.company_id && model.company_id !== company) {
      return 'Depreciation model must belong to the asset company';
    }
  }

  // G5: bill_id and journal_id validation
  if (vals && 'bill_id' in vals && vals.bill_id !== (before?.bill_id ?? null) && vals.bill_id != null) {
    const bill = read(db, 'account.move', vals.bill_id);
    if (!bill || bill.state !== 'posted' || bill.move_type !== 'in_invoice' || (bill.company_id ?? 1) !== company) {
      return 'Select a posted vendor bill in the asset company';
    }
    if (asset.partner_id && bill.partner_id && bill.partner_id !== asset.partner_id) {
      return 'Select a posted vendor bill for the asset vendor';
    }
  }

  if (vals && 'journal_id' in vals && vals.journal_id !== (before?.journal_id ?? null) && vals.journal_id != null) {
    const j = read(db, 'account.journal', vals.journal_id);
    if (!j) return 'Asset journal not found';
    if (j.type !== 'general') return 'Asset journal must be a miscellaneous journal';
  }

  return null;
}

export function assetGuard(db, before, asset, _ctx, vals) {
  const accErr = assetAccountGuard(db, before, asset);
  if (accErr) return accErr;
  return validateAssetIntegrity(db, before, asset, vals);
}

/** End date of period `i` counted from the acquisition period. */
function periodEnd(y, m, yearly, i) {
  if (yearly) return `${y + i}-12-31`;
  return monthEnd(y + Math.floor((m - 1 + i) / 12), ((m - 1 + i) % 12) + 1);
}

export function assetProrataComputation(asset) {
  return asset?.prorata_computation_type ?? (asset?.prorata ? 'daily_computation' : 'none');
}

/** Default prorata start date for an acquisition date, period length ('1' or '12'), and computation type. */
export function defaultProrataDate(acquisitionDate, methodPeriod = '12', computation = 'none') {
  if (!acquisitionDate) return null;
  if (computation !== 'none') return acquisitionDate;
  const yearly = String(methodPeriod) === '12';
  return `${acquisitionDate.slice(0, yearly ? 4 : 7)}${yearly ? '-01-01' : '-01'}`;
}

export function addMonthsClamped(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const targetY = y + Math.floor((m - 1 + months) / 12);
  const targetM = ((m - 1 + months) % 12) + 1;
  const maxDay = Number(monthEnd(targetY, targetM).slice(-2));
  return `${targetY}-${pad2(targetM)}-${pad2(Math.min(d, maxDay))}`;
}

export function syncMethodRateAndDuration(r, key) {
  if ((key === 'method_number' || key === 'method_mode') && r.method_mode !== 'rate') {
    return { method_rate: Number(r.method_number) > 0 ? 1 / Number(r.method_number) : 0 };
  }
  if ((key === 'method_rate' || key === 'method_mode') && r.method_mode === 'rate') {
    return { method_number: Number(r.method_rate) > 0 ? 1 / Number(r.method_rate) : 0 };
  }
  return {};
}

/** Share of the first period still ahead on the acquisition date (1 when prorata is off). */
function firstFraction(asset, y, m, yearly, computation = assetProrataComputation(asset)) {
  if (computation === 'none') return 1;
  const date = asset.prorata_date || asset.acquisition_date;
  if (computation === 'constant_periods') {
    const [, month, day] = date.split('-').map(Number);
    const endDay = Number(periodEnd(y, m, false, 0).slice(-2));
    const monthFraction = (endDay - day + 1) / endDay;
    return yearly ? (12 - month + monthFraction) / 12 : monthFraction;
  }
  const start = yearly ? `${y}-01-01` : `${y}-${pad2(m)}-01`;
  const end = periodEnd(y, m, yearly, 0);
  const length = dayNumber(end) - dayNumber(start) + 1;
  return (dayNumber(end) - dayNumber(date) + 1) / length;
}

/** Depreciation lines dated at period ends; the last line absorbs rounding so the total equals the base. */
export function depreciationBoard(asset, { periods: overridePeriods = null, dates = null, startDate = null, remainingBase = null, initialCumulated = null } = {}) {
  if (asset.method === 'no_depreciation') return [];
  const n = overridePeriods != null ? Number(overridePeriods) : asset.method === 'linear' && asset.method_mode === 'rate' ? 1 / Number(asset.method_rate) : Number(asset.method_number);
  const yearly = String(asset.method_period) === '12';
  const anchor = dates?.length ? dates.at(-1) : startDate;
  const [y, m] = (anchor || asset.prorata_date || asset.acquisition_date || today()).split('-').map(Number);
  const base = remainingBase != null ? remainingBase : cents(asset.original_value) - cents(asset.salvage_value) - cents(asset.already_depreciated);
  const computation = assetProrataComputation(asset);
  const frac = overridePeriods != null ? 1 : firstFraction(asset, y, m, yearly, computation);
  const periods = Math.ceil(n + (frac < 1 ? 1 - frac : 0));
  const rate = (Number(asset.method_progress_factor) || 0) / (yearly ? 1 : 12);
  const method = asset.method || 'linear';
  let remaining = base;
  let cumulated = initialCumulated != null ? initialCumulated : cents(asset.already_depreciated);
  const dailyStart = asset.prorata_date || asset.acquisition_date;
  let dailyLength = 0;
  if (overridePeriods == null && asset.prorata_computation_type === 'daily_computation' && method === 'linear') {
    const end = addMonthsClamped(dailyStart, Math.round(n * (yearly ? 12 : 1)));
    dailyLength = dayNumber(end) - dayNumber(dailyStart);
  }
  return Array.from({ length: periods }, (_, i) => {
    const elapsed = i === 0 ? 0 : frac + i - 1;
    const len = Math.min(i === 0 ? frac : 1, n - elapsed);
    const linear = Math.round((base / n) * len);
    const remainingLinear = Math.round((remaining * len) / (n - elapsed));
    const declining = Math.round(remaining * rate * len);
    const offset = dates?.length ? i - dates.length + 1 : anchor ? i + 1 : i;
    const date = dates?.[i] ?? periodEnd(y, m, yearly, offset);
    const dailyDue = dailyLength ? Math.round(base * Math.min(dailyLength, dayNumber(date) - dayNumber(dailyStart) + 1) / dailyLength) - (base - remaining) : linear;
    const due = { linear: dailyDue, degressive: Math.max(declining, remainingLinear), degressive_then_linear: Math.max(declining, linear) }[method] ?? linear;
    const amount = i === periods - 1 ? remaining : Math.min(remaining, due);
    remaining -= amount;
    cumulated += amount;
    return { date, amount: amount / 100, cumulated: cumulated / 100, remaining: (cents(asset.original_value) - cumulated) / 100 };
  }).filter((line) => line.amount !== 0);
}

export function rebuildPendingBoard(asset) {
  const remaining = remainingDepreciableCents(asset);
  if (!(remaining > 0)) return [];
  const full = depreciationBoard(asset);
  const posted = (asset.depreciation_ids ?? []).filter((l) => l.posted);
  const k = posted.length;
  const yearly = String(asset.method_period) === '12';
  const [y, m] = (asset.prorata_date || asset.acquisition_date || today()).split('-').map(Number);
  if (k >= full.length) {
    const date = periodEnd(y, m, yearly, k);
    const cumulated = cents(asset.already_depreciated) + postedCents(asset) + remaining;
    return [{
      date,
      amount: remaining / 100,
      cumulated: cumulated / 100,
      remaining: (cents(asset.original_value) - cumulated) / 100,
      posted: false,
      move_id: null,
    }];
  }

  const remainingLines = full.slice(k);
  const computation = assetProrataComputation(asset);
  const frac = firstFraction(asset, y, m, yearly, computation);
  const n = asset.method === 'linear' && asset.method_mode === 'rate' ? 1 / Number(asset.method_rate) : Number(asset.method_number);
  const base = cents(asset.original_value) - cents(asset.salvage_value) - cents(asset.already_depreciated);
  const elapsedAtK = k === 0 ? 0 : frac + k - 1;
  const remainingDuration = Math.max(0.0001, n - elapsedAtK);
  const rate = (Number(asset.method_progress_factor) || 0) / (yearly ? 1 : 12);
  const method = asset.method || 'linear';
  const dailyStart = asset.prorata_date || asset.acquisition_date;
  let dailyLength = 0;
  if (asset.prorata_computation_type === 'daily_computation' && method === 'linear') {
    const end = addMonthsClamped(dailyStart, Math.round(n * (yearly ? 12 : 1)));
    dailyLength = dayNumber(end) - dayNumber(dailyStart);
  }

  let remValue = remaining;
  let cumulated = cents(asset.already_depreciated) + postedCents(asset);

  return remainingLines.map((line, idx) => {
    const i = k + idx;
    const elapsed = i === 0 ? 0 : frac + i - 1;
    const len = Math.min(i === 0 ? frac : 1, n - elapsed);
    const remDurAtIdx = Math.max(0.0001, n - elapsed);
    const linear = Math.round((remaining / remainingDuration) * len);
    const originalLinear = Math.round((base / n) * len);
    const remainingLinear = Math.round((remValue * len) / remDurAtIdx);
    const declining = Math.round(remValue * rate * len);
    const dailyDue = dailyLength
      ? Math.max(0, Math.round(base * Math.min(dailyLength, dayNumber(line.date) - dayNumber(dailyStart) + 1) / dailyLength) - (base - remValue))
      : linear;
    const due = {
      linear: dailyDue,
      degressive: Math.max(declining, remainingLinear),
      degressive_then_linear: Math.max(declining, originalLinear),
    }[method] ?? linear;
    const amount = idx === remainingLines.length - 1 ? remValue : Math.min(remValue, due);
    remValue -= amount;
    cumulated += amount;
    return {
      date: line.date,
      amount: amount / 100,
      cumulated: cumulated / 100,
      remaining: (cents(asset.original_value) - cumulated) / 100,
      posted: false,
      move_id: null,
    };
  }).filter((line) => line.amount !== 0);
}

export function reopenedDepreciationBoard(asset) {
  const remaining = remainingDepreciableCents(asset);
  if (pendingScheduleValid(asset, remaining)) {
    return asset.depreciation_ids ?? [];
  }
  const posted = (asset.depreciation_ids ?? []).filter((l) => l.posted);
  return [...posted, ...rebuildPendingBoard(asset)];
}

export function isVerifiedReopenBoard(before, asset, db = null) {
  if (!before) return false;
  const expected = reopenedDepreciationBoard(before);
  const actual = asset?.depreciation_ids ?? [];
  if (actual.length !== expected.length) return false;
  return actual.every((line, i) => {
    const exp = expected[i];
    if (line.date !== exp.date || cents(line.amount) !== cents(exp.amount)) return false;
    if (Boolean(line.posted) === Boolean(exp.posted) && (line.move_id ?? null) === (exp.move_id ?? null)) return true;
    if (exp.posted && !line.posted && line.move_id === null && exp.move_id) {
      return (db?.records?.['account.move'] ?? []).some((m) => m.state === 'posted' && m.reversed_entry_id === exp.move_id);
    }
    return false;
  });
}

function validate(db, asset) {
  if (!(Number(asset.original_value) > 0)) throw new Error('The original value must be positive');
  if (asset.method === 'linear' && asset.method_mode === 'rate' && !(Number(asset.method_rate) > 0 && Number(asset.method_rate) <= 1)) throw new Error('Rate must be greater than zero and at most one');
  if (asset.method !== 'no_depreciation' && (!Number.isFinite(Number(asset.method_number)) || Number(asset.method_number) <= 0)) throw new Error('The duration must be positive');
  if (!(Number(asset.salvage_value || 0) < Number(asset.original_value))) throw new Error('The not depreciable value must be lower than the original value');
  if (!Number.isFinite(Number(asset.already_depreciated ?? 0)) || Number(asset.already_depreciated ?? 0) < 0 || cents(asset.already_depreciated) > cents(asset.original_value) - cents(asset.salvage_value)) throw new Error('Depreciated at import must be between zero and the depreciable value');
  if (!asset.acquisition_date) throw new Error('Set an acquisition date');

  const company = asset.company_id ?? 1;
  if (asset.company_id && !read(db, 'res.company', asset.company_id)) throw new Error('Asset company does not exist');

  const jId = asset.journal_id ?? journalId(db, 'MISC', company) ?? journalId(db, 'MISC');
  if (!jId) throw new Error('Asset journal not found');
  const j = read(db, 'account.journal', jId);
  if (!j) throw new Error('Asset journal not found');
  if (j.company_id && j.company_id !== company) throw new Error(`Journal ${j.name || j.code} belongs to another company`);

  if (asset.state === 'draft') {
    if (j.type !== 'general') throw new Error('Asset journal must be a miscellaneous journal');

    if (asset.bill_id) {
      const bill = read(db, 'account.move', asset.bill_id);
      if (!bill || bill.state !== 'posted' || bill.move_type !== 'in_invoice' || (bill.company_id ?? 1) !== company) {
        throw new Error('Select a posted vendor bill in the asset company');
      }
      if (asset.partner_id && bill.partner_id && bill.partner_id !== asset.partner_id) {
        throw new Error('Select a posted vendor bill for the asset vendor');
      }
    }
  }

  for (const [field, label] of [
    ['account_asset_id', 'fixed asset'],
    ['account_depreciation_id', 'depreciation'],
    ['account_depreciation_expense_id', 'depreciation expense'],
  ]) {
    if (asset.method === 'no_depreciation' && field !== 'account_asset_id') continue;
    requireAssetAccount(db, asset, field, label);
  }
}

function computeBoard(db, asset) {
  validate(db, asset);
  const depreciation_ids = asset.method === 'no_depreciation' ? [] : depreciationBoard(asset).map((l) => ({ ...l, posted: false, move_id: null }));
  return write(db, 'account.asset', asset.id, { depreciation_ids });
}

/** Report values as of a cutoff, excluding subsequent recorded adjustments. */
export function depreciationReport(db, period, companyId = 'all', options = {}) {
  const { groupBy = null, includeDraft = false } = typeof options === 'string'
    ? { groupBy: options, includeDraft: false }
    : (options ?? {});
  const hasInPeriod = (a) => (a.depreciation_ids ?? []).some((l) => l.posted && (!period.from || l.date >= period.from) && l.date <= period.to);
  const rows = search(db, 'account.asset').filter((a) => (
    (companyId === 'all' || (a.company_id ?? 1) === Number(companyId))
    && a.state !== 'cancel'
    && (includeDraft || a.state !== 'draft')
    && (!a.acquisition_date || a.acquisition_date <= period.to)
    && (!a.disposal_date || a.disposal_date > period.to || hasInPeriod(a))
    && (!a.activation_date || a.activation_date > period.to || hasInPeriod(a))
  )).map((a) => {
    const activated = Boolean((a.activation_date && a.activation_date <= period.to) || search(db, 'account.asset').some((child) => child.origin_asset_id === a.id && child.acquisition_date <= period.to));
    const original = activated ? 0 : (cents(a.original_value) - (a.revaluation_ids ?? []).filter((r) => r.date > period.to).reduce((s, r) => s + cents(r.amount), 0)) / 100;
    const posted = (a.depreciation_ids ?? []).filter((l) => l.posted);
    const sum = (list) => list.reduce((s, l) => s + cents(l.amount), 0);
    const accumulated = activated ? 0 : (cents(a.already_depreciated) + sum(posted.filter((l) => l.date <= period.to))) / 100;
    const inPeriod = sum(posted.filter((l) => (!period.from || l.date >= period.from) && l.date <= period.to)) / 100;
    const book = ((a.disposal_date && a.disposal_date <= period.to) || activated) ? 0 : (cents(original) - cents(accumulated)) / 100;
    return { a, original, accumulated, inPeriod, book };
  });
  const totals = Object.fromEntries(['original', 'inPeriod', 'accumulated', 'book'].map((key) => [key, rows.reduce((s, row) => s + cents(row[key]), 0) / 100]));
  const grouped = new Map();
  if (groupBy === 'asset_group_id') for (const row of rows) {
    const id = row.a.asset_group_id ?? null;
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(row);
  }
  const groups = [...grouped].map(([id, items]) => ({ id, name: read(db, 'account.asset.group', id)?.name ?? '', rows: items, totals: Object.fromEntries(['original', 'inPeriod', 'accumulated', 'book'].map((key) => [key, items.reduce((sum, row) => sum + cents(row[key]), 0) / 100])) }));
  return { rows, totals, groups };
}

/** Validate the asset, build its board and start depreciating. */
export function confirmAsset(db, asset) {
  return write(computeBoard(db, asset), 'account.asset', asset.id, { state: 'open' });
}

/** Reopen a closed asset that still has depreciable value, rebuilding pending lines if none remain. */
export function setAssetRunning(db, asset) {
  asset = read(db, 'account.asset', asset.id) ?? asset;
  if (asset.state !== 'close') throw new Error('Only closed assets can be set to running');
  if (isDisposedAsset(asset) || hasDerivedAsset(db, asset)) throw new Error('Cannot set a disposed or transferred asset to running');
  const remaining = remainingDepreciableCents(asset);
  if (!(remaining > 0)) throw new Error('Closed asset has no remaining depreciation to run');
  if (pendingScheduleValid(asset, remaining)) {
    return write(db, 'account.asset', asset.id, { state: 'open' });
  }
  validate(db, asset);
  const posted = (asset.depreciation_ids ?? []).filter((line) => line.posted);
  const board = rebuildPendingBoard(asset);
  return write(db, 'account.asset', asset.id, { state: 'open', depreciation_ids: [...posted, ...board] });
}

/** Returns true if the asset has unposted depreciation lines dated on or before `upTo`. */
export function hasDueDepreciation(asset, upTo = today()) {
  return (asset?.depreciation_ids ?? []).some((l) => !l.posted && l.date <= upTo);
}

/** Post each unposted board line dated on or before `upTo`; the asset closes once all are posted. */
export function postDepreciation(db, asset, upTo = today()) {
  asset = read(db, 'account.asset', asset.id) ?? asset;
  if (asset.state !== 'open' || asset.method === 'no_depreciation') return db;
  validate(db, asset);
  const unposted = (asset.depreciation_ids ?? []).filter((l) => !l.posted);
  if (unposted.length === 0) {
    return write(db, 'account.asset', asset.id, { state: 'close' });
  }
  if (!hasDueDepreciation(asset, upTo)) return db;
  const company = asset.company_id ?? 1;
  const journal = asset.journal_id ?? journalId(db, 'MISC', company) ?? 'MISC';
  const expAcc = asset.account_depreciation_expense_id;
  const depAcc = asset.account_depreciation_id;
  const { db: next, lines } = (asset.depreciation_ids ?? []).reduce((acc, l) => {
    if (l.posted || l.date > upTo) return { ...acc, lines: [...acc.lines, l] };
    const { db: booked, id } = postEntry(acc.db, {
      journal, date: l.date, ref: `${asset.name} depreciation ${l.date}`,
      lines: [{ account: expAcc, debit: l.amount, analytic_distribution: asset.analytic_distribution }, { account: depAcc, credit: l.amount }],
      company,
      system_generated: true,
    });
    return { db: postAnalytic(booked, id), lines: [...acc.lines, { ...l, posted: true, move_id: id }] };
  }, { db, lines: [] });
  return write(next, 'account.asset', asset.id, { depreciation_ids: lines, state: lines.every((l) => l.posted) ? 'close' : 'open' });
}

/** Reverse linked posted entries and remove the remaining draft schedule on cancellation. */
export function cancelAsset(db, asset) {
  asset = read(db, 'account.asset', asset.id) ?? asset;
  if (asset.state !== 'open' || asset.origin_asset_id || asset.parent_id || search(db, 'account.asset').some((child) => child.parent_id === asset.id || child.origin_asset_id === asset.id)) throw new Error('Cannot cancel an asset with posted entries or linked assets');
  let next = db;
  const depreciationMoveIds = new Set((asset.depreciation_ids ?? []).filter((line) => line.posted).map((line) => line.move_id));
  const moveIds = [...new Set([...(asset.depreciation_ids ?? []).filter((line) => line.posted).map((line) => line.move_id), ...(asset.revaluation_ids ?? []).filter((entry) => entry.move_id).map((entry) => entry.move_id)])];
  for (const id of moveIds) {
    const move = read(next, 'account.move', id);
    if (hasAssetReversal(next, id)) continue;
    if (!move || move.state !== 'posted' || search(next, 'account.move').some((entry) => entry.state === 'posted' && entry.reversed_entry_id === id)) throw new Error('Cannot cancel an asset with posted entries or linked assets');
    const date = [today(), move.date ?? move.invoice_date].sort().at(-1);
    const reversal = postEntry(next, { journal: move.journal_id, date, company: move.company_id ?? 1, ref: `Reversal of ${move.name}`, archivedOriginIds: [id], lines: move.line_ids.map(reversalLine), system_generated: depreciationMoveIds.has(id) });
    next = postAnalytic(write(reversal.db, 'account.move', reversal.id, { reversed_entry_id: id }), reversal.id);
  }
  return write(next, 'account.asset', asset.id, { state: 'cancel', depreciation_ids: (asset.depreciation_ids ?? []).filter((line) => line.posted) });
}

/** Pause only after all depreciation due before the pause has been posted. */
export function pauseAsset(db, asset, date = today(), note = '') {
  asset = read(db, 'account.asset', asset.id) ?? asset;
  if (asset.state !== 'open') throw new Error('Only running assets can be paused');
  if ((asset.depreciation_ids ?? []).some((line) => !line.posted && line.date < date)) throw new Error('Post overdue depreciation before pausing the asset');
  const next = write(db, 'account.asset', asset.id, { state: 'paused', pause_date: date });
  return note?.trim() ? postNote(next, 'account.asset', asset.id, note.trim()) : next;
}

/** Shift remaining periods by the paused days and recompute their residual amounts. */
export function resumeAsset(db, asset, date = today(), note = '') {
  asset = read(db, 'account.asset', asset.id) ?? asset;
  if (asset.state !== 'paused') throw new Error('Only a paused asset can be resumed');
  // Paused before pause dates were recorded: no pause period is known, so the board resumes unshifted, as it then did.
  if (!asset.pause_date) {
    const next = write(db, 'account.asset', asset.id, { state: 'open' });
    return note?.trim() ? postNote(next, 'account.asset', asset.id, note.trim()) : next;
  }
  if (date < asset.pause_date) throw new Error('Resume date cannot precede the pause date');
  const days = dayNumber(date) - dayNumber(asset.pause_date);
  const posted = (asset.depreciation_ids ?? []).filter((line) => line.posted);
  const pending = (asset.depreciation_ids ?? []).filter((line) => !line.posted);
  const accumulated = cents(asset.already_depreciated) + postedCents(asset);
  const dates = pending.map((line) => addDays(line.date, days));
  const board = pending.length ? depreciationBoard(asset, { periods: pending.length, dates, remainingBase: cents(asset.original_value) - cents(asset.salvage_value) - accumulated, initialCumulated: accumulated }).map((line) => ({ ...line, posted: false, move_id: null })) : [];
  const next = write(db, 'account.asset', asset.id, { state: 'open', pause_date: null, depreciation_ids: [...posted, ...board] });
  return note?.trim() ? postNote(next, 'account.asset', asset.id, note.trim()) : next;
}

/** Post due depreciation, drop the rest of the board and book the sale or scrapping of the asset. */
export function disposeAsset(db, asset, { date, saleValue, invoiceId = null, invoiceLine = 0, invoiceLines = [], lossAccountId = null, gainAccountId = null, note = '' }) {
  asset = read(db, 'account.asset', asset.id) ?? asset;
  if (!['open', 'paused', 'close'].includes(asset.state) || asset.disposal_date || asset.activation_date) throw new Error('Only running or paused assets can be disposed');
  if (!date) throw new Error('Set a disposal date');
  if (saleValue != null && !(Number(saleValue) >= 0)) throw new Error('The sale price cannot be negative');
  if (Number(saleValue) > 0 && !invoiceId && !invoiceLines.length) throw new Error('Select the customer invoice for this sale');
  if ((asset.depreciation_ids ?? []).some((line) => line.posted && line.date > date)) throw new Error('Disposal date cannot precede posted depreciation');
  if (asset.state !== 'open' && (asset.depreciation_ids ?? []).some((line) => !line.posted && line.date <= date)) throw new Error('Post due depreciation before disposing of the asset');
  const children = assetDescendants(db, asset.id);
  for (const child of children) {
    if ((child.depreciation_ids ?? []).some((line) => line.posted && line.date > date)) throw new Error('Disposal date cannot precede posted depreciation');
    if (child.state !== 'open' && (child.depreciation_ids ?? []).some((line) => !line.posted && line.date <= date)) throw new Error('Post due depreciation before disposing of the asset');
  }
  validate(db, asset);
  if (invoiceId && invoiceLines.length) throw new Error('Select a sale invoice line');
  const seen = new Set();
  const selectedLines = invoiceLines.map((selected) => {
    const key = `${selected.invoice_id}:${selected.line_index}`;
    if (seen.has(key)) throw new Error('Sale invoice line already used by another asset disposal');
    seen.add(key);
    const selectedInvoice = read(db, 'account.move', selected.invoice_id);
    const info = saleInvoiceLineInfo(selectedInvoice, selected.line_index);
    const { error } = saleInvoiceError(db, asset, { invoice: selectedInvoice, invoiceLine: selected.line_index, date, saleValue: info?.amount / 100 });
    if (error) throw new Error(error);
    return info;
  });
  const invoice = invoiceId && read(db, 'account.move', invoiceId);
  const lineInfo = invoice && saleInvoiceLineInfo(invoice, invoiceLine);
  const effectiveSaleValue = saleValue == null || saleValue === '' ? (lineInfo ? lineInfo.amount / 100 : undefined) : saleValue;
  const { error: saleError } = invoiceId ? saleInvoiceError(db, asset, { invoice, invoiceLine, date, saleValue: effectiveSaleValue }) : { error: null, lineInfo: null };
  if (saleError) throw new Error(saleError);
  const sale = selectedLines.length ? selectedLines.reduce((sum, line) => sum + line.amount, 0) : invoice ? lineInfo.amount : cents(saleValue ?? 0);
  if (selectedLines.length && saleValue != null && cents(saleValue) !== sale) throw new Error('Sale price must match the invoice line amount');
  if (sale < 0) throw new Error('The sale price cannot be negative');
  let depreciated = postDepreciation(db, asset, date);
  for (const child of children) {
    depreciated = postDepreciation(depreciated, read(depreciated, 'account.asset', child.id), date);
  }
  const current = read(depreciated, 'account.asset', asset.id);
  const currentChildren = children.map((c) => read(depreciated, 'account.asset', c.id));
  const kept = (current.depreciation_ids ?? []).filter((l) => l.posted);
  const original = cents(asset.original_value);
  const accumulated = postedCents(current) + cents(asset.already_depreciated);
  const totalOriginal = original + currentChildren.reduce((sum, c) => sum + cents(c.original_value), 0);
  const totalAccumulated = accumulated + currentChildren.reduce((sum, c) => sum + postedCents(c) + cents(c.already_depreciated), 0);
  const loss = totalOriginal - totalAccumulated - sale;
  const company = asset.company_id ?? 1;
  // Immutable db: resolving the disposal account after the depreciation catch-up persists nothing on failure.
  const companyRecord = read(db, 'res.company', company);
  const disposalAccount = loss > 0 ? (lossAccountId ?? companyRecord?.loss_account_id) : loss < 0 ? (gainAccountId ?? companyRecord?.gain_account_id) : null;
  const disposalRecord = disposalAccount && read(db, 'account.account', disposalAccount);
  if (loss && (!disposalRecord || disposalRecord.active === false || (disposalRecord.company_id && disposalRecord.company_id !== company))) throw new Error(`Configure the disposal ${loss > 0 ? 'loss' : 'gain'} account on company ${companyRecord?.name ?? company}`);
  const journal = asset.journal_id ?? journalId(depreciated, 'MISC', company) ?? 'MISC';
  const assetAcc = asset.account_asset_id;
  const depAcc = asset.account_depreciation_id;
  const lines = [
    { account: assetAcc, credit: original / 100 },
    accumulated > 0 && { account: depAcc, debit: accumulated / 100 },
    ...currentChildren.flatMap((c) => {
      const cOrig = cents(c.original_value);
      const cAcc = postedCents(c) + cents(c.already_depreciated);
      return [
        { account: c.account_asset_id, credit: cOrig / 100 },
        cAcc > 0 && { account: c.account_depreciation_id, debit: cAcc / 100 },
      ].filter(Boolean);
    }),
    sale > 0 && lineInfo && { account: lineInfo.accountId, debit: sale / 100 },
    ...selectedLines.filter((line) => line.amount !== 0).map((line) => ({ account: line.accountId, ...(line.amount > 0 ? { debit: line.amount / 100 } : { credit: -line.amount / 100 }) })),
    loss > 0 && { account: disposalAccount, debit: loss / 100, analytic_distribution: asset.analytic_distribution },
    loss < 0 && { account: disposalAccount, credit: -loss / 100, analytic_distribution: asset.analytic_distribution },
  ].filter(Boolean);
  const { db: booked, id } = postEntry(depreciated, { journal, date, ref: `${asset.name} disposal`, lines, company });
  let result = postAnalytic(booked, id);
  for (const c of currentChildren) {
    const cKept = (c.depreciation_ids ?? []).filter((l) => l.posted);
    result = write(result, 'account.asset', c.id, {
      depreciation_ids: cKept,
      cancelled_depreciation_ids: (c.depreciation_ids ?? []).filter((l) => !l.posted).map((l) => ({ ...l, cancelled: true })),
      state: 'close',
      disposal_date: date,
      disposal_move_id: id,
    });
    if (note?.trim()) result = postNote(result, 'account.asset', c.id, note.trim());
  }
  result = write(result, 'account.asset', asset.id, {
    depreciation_ids: kept,
    cancelled_depreciation_ids: (current.depreciation_ids ?? []).filter((l) => !l.posted).map((l) => ({ ...l, cancelled: true })),
    state: 'close',
    disposal_date: date,
    sale_value: sale / 100,
    sale_invoice_id: invoice?.id ?? null,
    sale_invoice_line: invoice ? Number(invoiceLine) : null,
    ...(invoiceLines.length ? { sale_invoice_line_ids: invoiceLines } : {}),
    disposal_move_id: id,
  });
  return note?.trim() ? postNote(result, 'account.asset', asset.id, note.trim()) : result;
}

/** Modify a running or paused asset: apply value increase or decrease (impairment/revaluation), post adjusting entry, and recompute remaining board. */
export function modifyAsset(db, asset, { date = today(), value_change = 0, valueChange = value_change, accountId = null, increaseAccountId = null, depreciationAccountId = null, expenseAccountId = null, methodNumber = null, methodPeriod = null, methodMode = null, methodRate = null, salvageValue = null } = {}) {
  asset = read(db, 'account.asset', asset.id) ?? asset;
  if (!['open', 'paused'].includes(asset.state) || asset.disposal_date) throw new Error('Only running or paused assets can be modified');
  if (!date) throw new Error('Set a modification date');
  if (!validDate(date)) throw new Error('Set a valid modification date');
  if (asset.acquisition_date && date < asset.acquisition_date) throw new Error('Modification date cannot precede acquisition date');
  if ((asset.depreciation_ids ?? []).some((line) => line.posted && line.date > date)) throw new Error('Modification date cannot precede posted depreciation');
  if ((asset.revaluation_ids ?? []).some((entry) => entry.date > date)) throw new Error('Modification date cannot precede an existing revaluation');

  if (Number(valueChange) < 0 && !accountId && !expenseAccountId && !asset.account_depreciation_expense_id) throw new Error(`Configure the loss or expense account on asset ${asset.name}`);
  validate(db, asset);
  let nextDb = asset.method === 'no_depreciation' ? db : postDepreciation(db, asset, date);
  asset = read(nextDb, 'account.asset', asset.id) ?? asset;
  if ((asset.depreciation_ids ?? []).some((line) => !line.posted && line.date <= date)) throw new Error('Post due depreciation before modifying the asset');

  if (methodPeriod != null && String(methodPeriod) !== String(asset.method_period) && methodNumber == null) throw new Error('Enter a remaining duration when changing the period');
  const delta = cents(valueChange || 0);
  if (delta > 0 && asset.method !== 'no_depreciation' && ((salvageValue != null && cents(salvageValue) !== cents(asset.salvage_value)) || methodNumber != null || (methodPeriod != null && String(methodPeriod) !== String(asset.method_period)) || (methodMode != null && methodMode !== (asset.method_mode ?? 'duration')) || (methodRate != null && Number(methodRate) !== Number(asset.method_rate)))) throw new Error('Change depreciation settings separately from a gross increase');
  if ((delta <= 0 || asset.method === 'no_depreciation') && ((depreciationAccountId && depreciationAccountId !== asset.account_depreciation_id) || (delta === 0 && expenseAccountId && expenseAccountId !== asset.account_depreciation_expense_id))) throw new Error('Change depreciation accounts only on a gross increase');
  const currentOriginal = cents(asset.original_value);
  const newOriginal = currentOriginal + delta;
  if (!(newOriginal > 0)) throw new Error('The original value must remain positive');

  const currentSalvage = salvageValue != null ? cents(salvageValue) : cents(asset.salvage_value || 0);
  if (!(currentSalvage < newOriginal)) throw new Error('The not depreciable value must be lower than the original value');

  const postedLines = (asset.depreciation_ids ?? []).filter((l) => l.posted);
  const postedAmount = postedCents(asset) + cents(asset.already_depreciated);
  if (newOriginal < postedAmount + currentSalvage) throw new Error('The new value cannot be lower than the already depreciated amount');

  const company = asset.company_id ?? 1;
  const journal = asset.journal_id ?? journalId(nextDb, 'MISC', company) ?? 'MISC';
  const assetAcc = delta > 0 && increaseAccountId ? configuredAccount(nextDb, increaseAccountId, company, 'fixed asset', asset.name || 'the asset') : asset.account_asset_id;
  const childDepAcc = delta > 0 && asset.method !== 'no_depreciation'
    ? (depreciationAccountId ? configuredAccount(nextDb, depreciationAccountId, company, 'depreciation', asset.name || 'the asset') : asset.account_depreciation_id)
    : asset.account_depreciation_id;
  const childExpAcc = delta > 0 && asset.method !== 'no_depreciation'
    ? (expenseAccountId ? configuredAccount(nextDb, expenseAccountId, company, 'depreciation expense', asset.name || 'the asset') : asset.account_depreciation_expense_id)
    : asset.account_depreciation_expense_id;

  let adjustmentMoveId = null;
  if (delta !== 0) {
    if (!assetAcc) throw new Error('Configure the fixed asset account on the asset before modifying its value');
    let counterpartAcc;
    if (delta > 0) {
      if (!accountId) throw new Error('Select a counterpart account for the asset value increase');
      counterpartAcc = accountId;
    } else {
      counterpartAcc = accountId ?? expenseAccountId ?? asset.account_depreciation_expense_id;
      if (!counterpartAcc) throw new Error('Configure a loss or expense account on the asset (or select a counterpart account) for the impairment');
    }
    // A selected counterpart must be active and belong to the asset company, like the asset's own accounts (Qodo 39).
    counterpartAcc = configuredAccount(nextDb, counterpartAcc, company, 'counterpart', asset.name || 'the asset');
    const lines = delta > 0
      ? [
          { account: assetAcc, debit: delta / 100 },
          { account: counterpartAcc, credit: delta / 100, analytic_distribution: asset.analytic_distribution },
        ]
      : [
          { account: counterpartAcc, debit: -delta / 100, analytic_distribution: asset.analytic_distribution },
          { account: assetAcc, credit: -delta / 100 },
        ];
    const { db: booked, id: moveId } = postEntry(nextDb, { journal, date, ref: `${asset.name} value adjustment`, lines, company });
    nextDb = postAnalytic(booked, moveId);
    adjustmentMoveId = moveId;
  }

  if (delta > 0 && asset.method !== 'no_depreciation') {
    const remaining = (asset.depreciation_ids ?? []).filter((line) => !line.posted);
    const duration = methodNumber != null ? Number(methodNumber) : remaining.length;
    if (duration < 1) throw new Error('Remaining duration must be at least 1 period');
    const computation = asset.prorata_computation_type ?? assetProrataComputation(asset);
    const childProrataDate = defaultProrataDate(date, methodPeriod ?? asset.method_period, computation);
    const child = create(nextDb, 'account.asset', {
      name: asset.name, parent_id: asset.id, gross_increase_move_id: adjustmentMoveId, acquisition_date: date, original_value: delta / 100,
      salvage_value: 0, already_depreciated: 0, state: 'draft', depreciation_ids: [],
      company_id: company, journal_id: read(nextDb, 'account.journal', asset.journal_id)?.type === 'general' ? asset.journal_id : journalId(nextDb, 'MISC', company), account_asset_id: assetAcc,
      account_depreciation_id: childDepAcc, account_depreciation_expense_id: childExpAcc,
      method: asset.method, method_number: duration, method_period: methodPeriod ?? asset.method_period, method_mode: methodMode ?? asset.method_mode, method_rate: methodRate ?? asset.method_rate,
      method_progress_factor: asset.method_progress_factor, prorata: asset.prorata,
      prorata_computation_type: computation,
      prorata_date: childProrataDate,
      analytic_distribution: asset.analytic_distribution,
    });
    return confirmAsset(child.db, read(child.db, 'account.asset', child.id));
  }

  const unpostedLines = (asset.depreciation_ids ?? []).filter((l) => !l.posted);
  const remainingPeriods = methodNumber != null ? Number(methodNumber) : unpostedLines.length;
  if (asset.method !== 'no_depreciation' && remainingPeriods < 1 && newOriginal > postedAmount + currentSalvage) throw new Error('Remaining duration must be at least 1 period');

  const lastDate = postedLines.length ? postedLines.at(-1).date : null;
  const newUnpostedLines = asset.method !== 'no_depreciation' && remainingPeriods > 0
    ? depreciationBoard(
        { ...asset, method_period: methodPeriod ?? asset.method_period, method_mode: methodMode ?? asset.method_mode, method_rate: methodRate ?? asset.method_rate, original_value: newOriginal / 100, salvage_value: currentSalvage / 100 },
        {
          periods: remainingPeriods,
          dates: methodPeriod && methodPeriod !== asset.method_period ? null : unpostedLines.map((l) => l.date),
          startDate: lastDate,
          remainingBase: newOriginal - currentSalvage - postedAmount,
          initialCumulated: postedAmount,
        },
      ).map((l) => ({ ...l, posted: false, move_id: null }))
    : [];

  const updatedDepreciationIds = [...postedLines, ...newUnpostedLines];
  return write(nextDb, 'account.asset', asset.id, {
    original_value: newOriginal / 100,
    revaluation_ids: delta ? [...(asset.revaluation_ids ?? []), { date, amount: delta / 100, move_id: adjustmentMoveId }] : (asset.revaluation_ids ?? []),
    salvage_value: currentSalvage / 100,
    ...(asset.method !== 'no_depreciation' && methodNumber != null ? { method_number: postedLines.length + remainingPeriods } : {}),
    ...(methodPeriod != null ? { method_period: methodPeriod } : {}),
    ...(methodMode != null ? { method_mode: methodMode } : {}),
    ...(methodRate != null ? { method_rate: methodRate } : {}),
    depreciation_ids: updatedDepreciationIds,
    state: asset.method !== 'no_depreciation' && (newOriginal === postedAmount + currentSalvage || (updatedDepreciationIds.length && updatedDepreciationIds.every((l) => l.posted))) ? 'close' : asset.state,
  });
}

export function createAssetsFromJournalItems(db, selections) {
  if (!selections.length) throw new Error('Select at least one journal item');
  const seen = new Set();
  const moveCache = new Map();
  return selections.reduce((next, selection) => {
    const key = JSON.stringify([selection.move_id, selection.line_identity]);
    if (seen.has(key)) throw new Error('Journal item selected more than once');
    seen.add(key);
    if (!moveCache.has(selection.move_id)) {
      moveCache.set(selection.move_id, sourceMoveJournalItems(next, selection.move_id));
    }
    const { move, items } = moveCache.get(selection.move_id);
    const matches = items.filter((line) => line.line_identity === selection.line_identity);
    if (!move || matches.length !== 1) throw new Error('Selected journal item is missing or ambiguous');
    const line = matches[0];
    const balanceCents = cents(line.debit) - cents(line.credit);
    if (!(balanceCents > 0)) throw new Error('Only debit journal items with a positive balance can create assets');
    if (!isValidFixedAssetAccount(read(next, 'account.account', line.account_id), move.company_id ?? 1)) throw new Error('Select a valid fixed asset account');
    if (journalItemHasAsset(next, move, line)) throw new Error('Journal item already has an asset');
    return create(next, 'account.asset', { ...assetDraftValues(next, move, line, { amount: balanceCents / 100, accountId: line.account_id, date: line.date }), source_move_id: line.move_id, source_line_identity: line.line_identity }).db;
  }, db);

}
/** Transfer the remaining book value into a new asset. */
export function activateDepreciation(db, asset, { date = today(), newAccountAssetId, note = '' } = {}) {
  asset = read(db, 'account.asset', asset.id) ?? asset;
  if (asset.state !== 'open' || asset.disposal_date) throw new Error('Only running assets can activate depreciation');
  if (!date) throw new Error('Set an activation date');
  if (asset.acquisition_date && date < asset.acquisition_date) throw new Error('Invalid activation date');
  if ((asset.depreciation_ids ?? []).some((line) => line.posted && line.date > date)) throw new Error('Modification date cannot precede posted depreciation');
  if ((asset.revaluation_ids ?? []).some((entry) => entry.date > date)) throw new Error('Activation date cannot precede an existing revaluation');
  const company = asset.company_id ?? 1;
  if (!isValidFixedAssetAccount(read(db, 'account.account', newAccountAssetId), company)) throw new Error('Select a valid fixed asset account');
  const target = configuredAccount(db, newAccountAssetId, company, 'fixed asset', asset.name || 'the asset');
  let next = postDepreciation(db, asset, date);
  asset = read(next, 'account.asset', asset.id);
  const value = cents(asset.original_value) - cents(asset.already_depreciated) - postedCents(asset);
  if (value <= 0) throw new Error('The asset book value must be positive');
  if (cents(asset.already_depreciated) + postedCents(asset) > 0) requireAssetAccount(next, asset, 'account_depreciation_id', 'depreciation');
  if (cents(asset.salvage_value) >= value) throw new Error('The not depreciable value must be lower than the transferred value');
  let transferMoveId = null;
  if (target !== asset.account_asset_id) {
    const entry = postEntry(next, { journal: asset.journal_id ?? journalId(next, 'MISC', company), date, ref: `${asset.name} transfer`, company, lines: [
      { account: target, debit: value / 100 }, { account: asset.account_asset_id, credit: value / 100 },
    ] });
    next = entry.db;
    transferMoveId = entry.id;
  }
  const remaining = (asset.depreciation_ids ?? []).filter((line) => !line.posted);
  const targetAccount = read(next, 'account.account', target);
  const targetModel = targetAccount?.asset_model_id && read(next, 'account.asset.model', targetAccount.asset_model_id);
  const child = create(next, 'account.asset', {
    name: asset.name, origin_asset_id: asset.id, transfer_move_id: transferMoveId, acquisition_date: date, original_value: value / 100,
    salvage_value: asset.salvage_value ?? 0, already_depreciated: 0, state: 'draft', depreciation_ids: [],
    company_id: company, journal_id: targetModel?.journal_id ?? asset.journal_id, account_asset_id: target,
    model_id: targetModel?.id ?? null,
    account_depreciation_id: targetModel?.account_depreciation_id ?? asset.account_depreciation_id, account_depreciation_expense_id: targetModel?.account_depreciation_expense_id ?? asset.account_depreciation_expense_id,
    method: targetModel?.method ?? asset.method, method_number: targetModel?.method_number ?? (remaining.length || asset.method_number), method_period: targetModel?.method_period ?? asset.method_period,
    method_progress_factor: targetModel?.method_progress_factor ?? asset.method_progress_factor, prorata: targetModel?.prorata ?? asset.prorata, analytic_distribution: asset.analytic_distribution,
  });
  next = write(child.db, 'account.asset', asset.id, { state: 'close', depreciation_ids: (asset.depreciation_ids ?? []).filter((line) => line.posted), cancelled_depreciation_ids: [...(asset.cancelled_depreciation_ids ?? []), ...remaining.map((line) => ({ ...line, cancelled: true }))] });
  next = confirmAsset(next, read(next, 'account.asset', child.id));
  return note?.trim() ? postNote(next, 'account.asset', asset.id, note.trim()) : next;
}

function cancelRefundedAsset(db, asset) {
  const unposted = (asset.depreciation_ids ?? []).filter((l) => !l.posted);
  return write(db, 'account.asset', asset.id, {
    state: 'cancel', depreciation_ids: [],
    cancelled_depreciation_ids: [...(asset.cancelled_depreciation_ids ?? []), ...unposted.map((l) => ({ ...l, cancelled: true }))],
  });
}

function disposeRefundedAsset(db, asset, refundMove) {
  const date = refundMove.invoice_date ?? refundMove.date ?? today();
  if ((asset.depreciation_ids ?? []).some((line) => line.posted && line.date > date)) throw new Error('Disposal date cannot precede posted depreciation');
  validate(db, asset);
  // A paused board does not accrue during its pause. Running boards catch up as normal.
  const depreciated = asset.state === 'open' ? postDepreciation(db, asset, date) : db;
  const current = read(depreciated, 'account.asset', asset.id);
  const accumulated = postedCents(current) + cents(current.already_depreciated);
  if (!accumulated) return cancelRefundedAsset(depreciated, current);
  const company = current.company_id ?? 1;
  const companyRecord = read(depreciated, 'res.company', company);
  const gain = configuredAccount(depreciated, companyRecord?.gain_account_id, company, 'gain', current.name || 'the asset');
  const journal = current.journal_id ?? journalId(depreciated, 'MISC', company) ?? 'MISC';
  // The refund already credited the gross asset account; clear only accumulated depreciation.
  const { db: booked, id } = postEntry(depreciated, { journal, date, ref: `${current.name} refund disposal`, company, lines: [
    { account: current.account_depreciation_id, debit: accumulated / 100 },
    { account: gain, credit: accumulated / 100, analytic_distribution: current.analytic_distribution },
  ] });
  return write(postAnalytic(booked, id), 'account.asset', current.id, {
    depreciation_ids: (current.depreciation_ids ?? []).filter((line) => line.posted),
    cancelled_depreciation_ids: [...(current.cancelled_depreciation_ids ?? []), ...(current.depreciation_ids ?? []).filter((line) => !line.posted).map((line) => ({ ...line, cancelled: true }))],
    state: 'close', disposal_date: date, sale_value: 0, disposal_move_id: id, refund_disposal_move_id: refundMove.id,
  });
}

function reduceRefundedAsset(db, asset, refundMove, refundAmount) {
  const newOriginal = (cents(asset.original_value) - cents(refundAmount)) / 100;
  if (asset.state === 'draft') {
    db = write(db, 'account.asset', asset.id, {
      original_value: newOriginal,
      depreciation_ids: asset.depreciation_ids?.length
        ? depreciationBoard({ ...asset, original_value: newOriginal }).map((l) => ({ ...l, posted: false, move_id: null }))
        : [],
    });
  } else {
    const postedLines = (asset.depreciation_ids ?? []).filter((l) => l.posted);
    const postedAmount = postedCents(asset) + cents(asset.already_depreciated);
    const unpostedLines = (asset.depreciation_ids ?? []).filter((l) => !l.posted);
    const currentSalvage = cents(asset.salvage_value || 0);

    if (cents(newOriginal) <= postedAmount + currentSalvage) {
      const excess = Math.max(0, postedAmount - cents(newOriginal));
      let adjustment = null;
      if (excess) {
        const company = asset.company_id ?? 1;
        const journal = asset.journal_id ?? journalId(db, 'MISC', company) ?? 'MISC';
        const expense = configuredAccount(db, asset.account_depreciation_expense_id, company, 'depreciation expense', asset.name || 'the asset');
        const date = refundMove.invoice_date ?? refundMove.date ?? today();
        if (postedLines.some((line) => line.date > date)) throw new Error('Modification date cannot precede posted depreciation');
        const booked = postEntry(db, { journal, date, ref: `${asset.name} refund depreciation adjustment`, company, lines: [
          { account: asset.account_depreciation_id, debit: excess / 100 },
          { account: expense, credit: excess / 100, analytic_distribution: asset.analytic_distribution },
        ] });
        db = postAnalytic(booked.db, booked.id);
        adjustment = { date, amount: -excess / 100, posted: true, move_id: booked.id };
      }
      db = write(db, 'account.asset', asset.id, {
        original_value: newOriginal,
        salvage_value: Math.max(0, Math.min(currentSalvage, cents(newOriginal) - postedAmount + excess)) / 100,
        revaluation_ids: [...(asset.revaluation_ids ?? []), { date: refundMove.date || refundMove.invoice_date || today(), amount: -refundAmount, move_id: refundMove.id }],
        state: 'close',
        depreciation_ids: adjustment ? [...postedLines, adjustment] : postedLines,
        cancelled_depreciation_ids: [
          ...(asset.cancelled_depreciation_ids ?? []),
          ...unpostedLines.map((l) => ({ ...l, cancelled: true })),
        ],
      });
    } else {
      const remainingPeriods = unpostedLines.length;
      const lastDate = postedLines.length ? postedLines.at(-1).date : null;
      const newUnpostedLines = remainingPeriods > 0
        ? depreciationBoard(
            { ...asset, original_value: newOriginal, salvage_value: currentSalvage / 100 },
            {
              periods: remainingPeriods,
              dates: unpostedLines.map((l) => l.date),
              startDate: lastDate,
              remainingBase: cents(newOriginal) - currentSalvage - postedAmount,
              initialCumulated: postedAmount,
            },
          ).map((l) => ({ ...l, posted: false, move_id: null }))
        : [];
      db = write(db, 'account.asset', asset.id, {
        original_value: newOriginal,
        revaluation_ids: [...(asset.revaluation_ids ?? []), { date: refundMove.date || refundMove.invoice_date || today(), amount: -refundAmount, move_id: refundMove.id }],
        depreciation_ids: [...postedLines, ...newUnpostedLines],
      });
    }
  }
  return db;
}

/** Adjust assets only when the refund identifies their original bill line. */
export function adjustAssetsForCreditNote(db, refundMove, originalBillMove = (refundMove?.reversed_entry_id ? read(db, 'account.move', refundMove.reversed_entry_id) : null)) {
  if (!refundMove || refundMove.move_type !== 'in_refund' || !refundMove.reversed_entry_id || !originalBillMove) return db;
  const billLines = originalBillMove.invoice_line_ids ?? [];
  const assets = search(db, 'account.asset').filter((a) => a.bill_id === originalBillMove.id && a.state !== 'cancel' && !(a.state === 'close' && a.disposal_date));
  let nextDb = db;
  for (const asset of assets) {
    const billLine = billLines[asset.bill_line];
    if (billLine?.line_id == null) continue;
    const lines = (refundMove.invoice_line_ids ?? []).filter((l) => l.source_line_id != null && String(l.source_line_id) === String(billLine.line_id));
    const amount = lines.reduce((sum, l) => sum + toCompany(nextDb, refundMove.currency_id, Math.abs(subtotal(l, nextDb)), refundMove.invoice_date ?? refundMove.date, refundMove.company_id ?? 1), 0);
    if (!(amount > 0)) continue;
    if (search(nextDb, 'account.asset').some((child) => child.origin_asset_id === asset.id && child.state !== 'cancel')) throw new Error('Cannot refund a transferred asset until its transfer is adjusted');
    if (amount < Number(asset.original_value)) nextDb = reduceRefundedAsset(nextDb, asset, refundMove, amount);
    else if (asset.state === 'draft' || (!(asset.depreciation_ids ?? []).some((l) => l.posted) && !cents(asset.already_depreciated))) nextDb = cancelRefundedAsset(nextDb, asset);
    else nextDb = disposeRefundedAsset(nextDb, asset, refundMove);
  }
  return nextDb;
}

export const assetModels = {
  'account.asset.group': {
    label: 'Asset Groups',
    guard: (db, before, group) => before && before.company_id !== group.company_id && (db.records['account.asset'] ?? []).some((asset) => asset.asset_group_id === group.id && (asset.company_id ?? 1) !== (group.company_id ?? 1)) ? 'Asset group must belong to the asset company' : null,
    fields: { name: { type: 'char', label: 'Name', required: true }, company_id: { type: 'many2one', relation: 'res.company', label: 'Company', required: true } },
    list: ['name', 'company_id'],
    form: { title: 'name', groups: [['name', 'company_id']] },
  },
  'account.asset': {
    label: 'Assets',
    guardLast: true,
    actions: { dispose: disposeAsset, modify: modifyAsset, activate: activateDepreciation, adjustForCreditNote: adjustAssetsForCreditNote },
    fields: {
      name: { type: 'char', label: 'Asset Name', required: true },
      parent_id: { type: 'many2one', relation: 'account.asset', label: 'Parent Asset', readonly: true },
      gross_increase_move_id: { type: 'many2one', relation: 'account.move', label: 'Gross Increase Entry', readonly: true, hidden: true },
      origin_asset_id: { type: 'many2one', relation: 'account.asset', label: 'Original Asset', readonly: true },
      transfer_move_id: { type: 'many2one', relation: 'account.move', label: 'Transfer Entry', readonly: true, hidden: true },
      children_ids: { type: 'one2many', label: 'Gross Increases', readonly: true, fields: { name: { type: 'char', label: 'Asset Name' }, original_value: { type: 'monetary', label: 'Original Value' } }, compute: (r, db) => (db?.records['account.asset'] ?? []).filter((a) => a.parent_id === r.id).map((a) => a.id) },
      derived_asset_ids: { type: 'one2many', label: 'Active Asset', readonly: true, fields: { name: { type: 'char', label: 'Asset Name' }, original_value: { type: 'monetary', label: 'Original Value' } }, compute: (r, db) => (db?.records['account.asset'] ?? []).filter((a) => a.origin_asset_id === r.id).map((a) => a.id) },
      gross_increase_value: { type: 'monetary', label: 'Gross Increase', readonly: true, compute: (r, db) => (db?.records['account.asset'] ?? []).filter((a) => a.parent_id === r.id).reduce((sum, a) => sum + Number(a.original_value || 0), 0) },
      gross_increase_count: { type: 'integer', label: 'Gross Increases', readonly: true, compute: (r, db) => (db?.records['account.asset'] ?? []).filter((a) => a.parent_id === r.id).length },
      acquisition_date: { type: 'date', label: 'Acquisition Date', readonly: readonlyWhenNotDraft },
      original_value: { type: 'monetary', label: 'Original Value', readonly: readonlyWhenNotDraft },
      salvage_value: { type: 'monetary', label: 'Not Depreciable Value', readonly: readonlyWhenNotDraft },
      already_depreciated: { type: 'monetary', label: 'Depreciated at Import', readonly: readonlyWhenNotDraft },
      method: { type: 'selection', label: 'Method', options: [['linear', 'Straight Line'], ['degressive', 'Declining'], ['degressive_then_linear', 'Declining then Straight Line'], ['no_depreciation', 'No Depreciation']], readonly: (r) => Boolean(r?.model_id) || readonlyWhenNotDraft(r) },
      method_mode: { type: 'selection', label: 'Based On', options: [['duration', 'Duration'], ['rate', 'Rate']], readonly: readonlyWhenNotDraft },
      method_rate: { type: 'float', label: 'Rate', readonly: readonlyWhenNotDraft },
      method_number: { type: 'float', label: 'Duration', readonly: readonlyWhenNotDraft },
      method_period: { type: 'selection', label: 'Period', options: [['1', 'Months'], ['12', 'Years']], readonly: readonlyWhenNotDraft },
      method_progress_factor: { type: 'float', label: 'Declining Factor', readonly: readonlyWhenNotDraft },
      prorata: { type: 'boolean', label: 'Prorata Temporis', readonly: readonlyWhenNotDraft },
      prorata_computation_type: { type: 'selection', label: 'Computation', options: [['none', 'No Prorata'], ['constant_periods', 'Constant Periods'], ['daily_computation', 'Based on days per period']], readonly: readonlyWhenNotDraft },
      prorata_date: { type: 'date', label: 'Prorata Date', readonly: readonlyWhenNotDraft },
      activation_move_id: { type: 'many2one', relation: 'account.move', label: 'Closing Entry', readonly: true },
      activation_opening_move_id: { type: 'many2one', relation: 'account.move', label: 'Opening Entry', readonly: true },
      activation_date: { type: 'date', label: 'Activation Date', readonly: true },
      activation_value: { type: 'monetary', label: 'Transferred Value', readonly: true },
      source_move_id: { type: 'many2one', relation: 'account.move', label: 'Source Entry', readonly: true },
      source_line_identity: { type: 'char', label: 'Source Line', readonly: true },
      asset_group_id: { type: 'many2one', relation: 'account.asset.group', label: 'Asset Group', domain: (g, r) => (g.company_id ?? 1) === (r?.company_id ?? 1) },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Vendor' },
      model_id: {
        type: 'many2one',
        relation: 'account.asset.model',
        label: 'Depreciation Model',
        domain: (m, r) => !m.company_id || m.company_id === (r?.company_id ?? 1),
        readonly: readonlyWhenNotDraft,
      },
      account_asset_id: { type: 'many2one', relation: 'account.account', label: 'Fixed Asset Account', readonly: readonlyWhenNotDraft },
      account_depreciation_id: { type: 'many2one', relation: 'account.account', label: 'Depreciation Account', readonly: readonlyWhenNotDraft },
      account_expense_id: { type: 'many2one', relation: 'account.account', label: 'Legacy Expense Account', readonly: true, compute: (r) => r.account_depreciation_expense_id ?? null },
      journal_id: {
        type: 'many2one',
        relation: 'account.journal',
        label: 'Journal',
        domain: (j, r) => j.type === 'general' && (!j.company_id || j.company_id === (r?.company_id ?? 1)),
        readonly: readonlyWhenNotDraft,
      },
      analytic_distribution: { type: 'distribution', label: 'Analytic Distribution' },
      bill_id: {
        type: 'many2one',
        relation: 'account.move',
        label: 'Bill',
        domain: (bill, r) => bill.state === 'posted'
          && bill.move_type === 'in_invoice'
          && (bill.company_id ?? 1) === (r?.company_id ?? 1)
          && (!r?.partner_id || bill.partner_id === r.partner_id),
      },
      bill_line: { type: 'integer', label: 'Bill Line', readonly: true },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['open', 'Running'], ['paused', 'Paused'], ['close', 'Closed'], ['cancel', 'Cancelled']], badge: { draft: 'info', open: 'success', paused: 'warning', close: 'muted', cancel: 'muted' } },
      book_value: { type: 'monetary', label: 'Book Value', readonly: true, compute: (r, db) => r.disposal_date || (db && (db.records['account.asset'] ?? []).some((a) => a.origin_asset_id === r.id)) ? 0 : (cents(r.original_value) - cents(r.already_depreciated) - postedCents(r)) / 100 },
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
      revaluation_ids: { type: 'one2many', label: 'Value Adjustments', readonly: true, fields: {
        date: { type: 'date', label: 'Date' }, amount: { type: 'monetary', label: 'Value Change' }, move_id: { type: 'many2one', relation: 'account.move', label: 'Entry' },
      } },
      pause_date: { type: 'date', label: 'Pause Date', readonly: true },
      disposal_date: { type: 'date', label: 'Disposal Date', readonly: true, hideWhen: (r) => !r?.disposal_date },
      sale_value: { type: 'monetary', label: 'Sale Price', readonly: true, hideWhen: (r) => r?.sale_value == null || r?.sale_value === '' },
      sale_invoice_id: { type: 'many2one', relation: 'account.move', label: 'Sale Invoice', readonly: true },
      sale_invoice_line: { type: 'integer', label: 'Sale Invoice Line', readonly: true },
      sale_invoice_line_ids: { type: 'one2many', label: 'Invoice Lines', readonly: true, fields: { invoice_id: { type: 'many2one', relation: 'account.move', label: 'Customer Invoice' }, line_index: { type: 'integer', label: 'Invoice Line' } } },
      disposal_move_id: { type: 'many2one', relation: 'account.move', label: 'Disposal Entry', readonly: true },
      refund_disposal_move_id: { type: 'many2one', relation: 'account.move', label: 'Refund', readonly: true, hidden: true },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company', readonly: readonlyWhenNotDraft },
      account_depreciation_expense_id: { type: 'many2one', relation: 'account.account', label: 'Depreciation Expense Account (Override)', readonly: readonlyWhenNotDraft },
    },
    defaults: () => ({
      acquisition_date: today(),
      ...ASSET_DEPRECIATION_DEFAULTS,
      state: 'draft',
      depreciation_ids: [],
    }),
    guard: assetGuard,
    createDefaults: (db, vals) => {
      const company = vals?.company_id ?? (db ? currentCompany(db) : 1);
      const rawModel = vals?.model_id && read(db, 'account.asset.model', vals.model_id);
      const model = rawModel && (!rawModel.company_id || rawModel.company_id === company) ? rawModel : null;
      const parent = vals?.parent_id && db ? read(db, 'account.asset', vals.parent_id) : null;
      const rawJournal = model?.journal_id ? read(db, 'account.journal', model.journal_id) : null;
      const modelJournal = rawJournal?.type === 'general' && (!rawJournal.company_id || rawJournal.company_id === company) ? model.journal_id : null;
      const modelDefaults = model ? Object.fromEntries(['method', 'method_number', 'method_period', 'method_progress_factor', 'method_mode', 'method_rate', 'prorata', 'prorata_computation_type', 'prorata_date', 'account_asset_id', 'account_depreciation_id', 'account_depreciation_expense_id', 'analytic_distribution'].filter((key) => model[key] !== undefined).map((key) => [key, model[key]])) : {};
      if (modelJournal) modelDefaults.journal_id = modelJournal;
      const defaultJournal = !vals?.journal_id && !modelDefaults.journal_id ? (journalId(db, 'MISC', company) ?? null) : null;
      const computation = vals?.prorata_computation_type
        ? vals.prorata_computation_type
        : parent
          ? assetProrataComputation(parent)
          : vals?.prorata !== undefined
            ? (vals.prorata ? 'daily_computation' : 'none')
            : assetProrataComputation(modelDefaults);
      const acquisition = vals?.acquisition_date || today();
      const period = vals?.method_period ?? modelDefaults.method_period ?? parent?.method_period ?? '12';
      const defaultDate = defaultProrataDate(acquisition, period, computation);
      const modelDate = model && computation === assetProrataComputation(model) ? modelDefaults.prorata_date : null;
      return {
        company_id: company,
        ...(defaultJournal ? { journal_id: defaultJournal } : {}),
        ...modelDefaults,
        prorata_computation_type: computation,
        prorata: vals?.prorata ?? (computation !== 'none'),
        prorata_date: vals?.prorata_date || (vals?.parent_id ? defaultDate : (modelDate || defaultDate)),
      };
    },
    onchange: (r, key, db) => {
      if (['acquisition_date', 'prorata_computation_type', 'method_period'].includes(key) && r.acquisition_date) {
        const computation = assetProrataComputation(r);
        return {
          prorata_date: defaultProrataDate(r.acquisition_date, r.method_period ?? '12', computation),
          prorata: computation !== 'none',
        };
      }
      if (['method_number', 'method_rate', 'method_mode'].includes(key) && (!r.state || r.state === 'draft')) {
        return syncMethodRateAndDuration(r, key);
      }
      if (key === 'company_id') {
        const company = r.company_id ?? 1;
        const currentJournal = r.journal_id ? read(db, 'account.journal', r.journal_id) : null;
        if (!currentJournal || (currentJournal.company_id && currentJournal.company_id !== company)) {
          return { journal_id: journalId(db, 'MISC', company) ?? null };
        }
      }
      if (key === 'model_id' && r.model_id) {
        const model = read(db, 'account.asset.model', r.model_id);
        if (model) {
          const company = r.company_id ?? (db ? currentCompany(db) : 1);
          const rawJournal = model.journal_id ? read(db, 'account.journal', model.journal_id) : null;
          const modelJournal = rawJournal?.type === 'general' && (!rawJournal.company_id || rawJournal.company_id === company) ? model.journal_id : undefined;
          const computation = assetProrataComputation(model);
          const period = model.method_period ?? r.method_period ?? '12';
          const methodNumber = model.method_number ?? r.method_number;
          const prorataDate = model.prorata_date || (r.acquisition_date ? defaultProrataDate(r.acquisition_date, period, computation) : r.prorata_date);
          return {
            method: model.method ?? r.method,
            method_number: methodNumber,
            method_period: period,
            method_progress_factor: model.method_progress_factor ?? r.method_progress_factor,
            method_mode: model.method_mode ?? (model.method_number !== undefined ? 'duration' : r.method_mode),
            method_rate: model.method_rate ?? (Number(methodNumber) > 0 ? 1 / Number(methodNumber) : r.method_rate),
            prorata_computation_type: computation,
            prorata_date: prorataDate,
            prorata: computation !== 'none',
            account_asset_id: model.account_asset_id ?? r.account_asset_id,
            account_depreciation_id: model.account_depreciation_id ?? r.account_depreciation_id,
            account_depreciation_expense_id: model.account_depreciation_expense_id ?? r.account_depreciation_expense_id,
            account_expense_id: model.account_depreciation_expense_id ?? r.account_depreciation_expense_id,
            ...(modelJournal !== undefined ? { journal_id: modelJournal } : {}),
            analytic_distribution: model.analytic_distribution ?? r.analytic_distribution,
          };
        }
      }
      return {};
    },
    groupBys: ['state', 'method', 'asset_group_id'],
    filters: [[{ id: 'has_asset_group', label: 'Asset Group', fn: (r) => Boolean(r.asset_group_id) }], [{ id: 'running', label: 'Running', fn: (r) => r.state === 'open' }, { id: 'closed', label: 'Closed', fn: (r) => r.state === 'close' }]],
    kanban: { title: 'name', lines: ['original_value', 'book_value', 'method'], badge: 'state' },
    list: ['acquisition_date', 'name', 'partner_id', 'model_id', 'original_value', 'book_value', 'method', 'state'],
    listDecoration: (r) => (r.state === 'draft' ? 'info' : ['close', 'cancel'].includes(r.state) ? 'muted' : null),
    form: {
      statusbar: 'state',
      smart: [
        { label: 'Gross Increases', model: 'account.asset', field: 'parent_id', target: 'accounting/assets', when: (r, db) => search(db, 'account.asset').some((a) => a.parent_id === r.id) },
        { label: 'Original Asset', model: 'account.asset', field: 'id', key: 'origin_asset_id', target: 'accounting/assets', when: (r) => !!r.origin_asset_id },
        { label: 'Active Asset', model: 'account.asset', field: 'origin_asset_id', target: 'accounting/assets', when: (r, db) => search(db, 'account.asset').some((a) => a.origin_asset_id === r.id) },
        { label: 'Parent Asset', model: 'account.asset', field: 'id', key: 'parent_id', target: 'accounting/assets', when: (r) => !!r.parent_id },
      ],
      lockedWhen: (r) => ['close', 'cancel'].includes(r.state),
      buttons: [
        { label: 'Confirm', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: confirmAsset(db, r) }) },
        { label: 'Compute Depreciation', when: (r) => r.state === 'draft', run: (db, r) => ({ db: computeBoard(db, r) }) },
        { label: 'Post Depreciation', primary: true, when: (r) => r.state === 'open', run: (db, r) => {
          const asset = read(db, 'account.asset', r.id) ?? r;
          const unposted = (asset.depreciation_ids ?? []).filter((l) => !l.posted);
          if (unposted.length > 0 && !hasDueDepreciation(asset, today())) {
            return { db, message: t('No depreciation is due yet.') };
          }
          return { db: postDepreciation(db, asset) };
        } },
        { label: 'Set to Draft', when: (r, db) => canResetAsset(db, r), vals: { state: 'draft' } },
        { label: 'Pause', when: (r) => r.state === 'open', wizard: () => ({ title: 'Pause', fields: [{ name: 'date', type: 'date', label: 'Date', required: true, default: today() }, { name: 'note', type: 'text', label: 'Note' }] }), run: (db, r, values = {}) => ({ db: pauseAsset(db, r, values.date ?? today(), values.note) }) },
        { label: 'Resume', primary: true, when: (r) => r.state === 'paused', wizard: () => ({ title: 'Resume', fields: [{ name: 'date', type: 'date', label: 'Date', required: true, default: today() }, { name: 'note', type: 'text', label: 'Note' }] }), run: (db, r, values = {}) => ({ db: resumeAsset(db, r, values.date ?? today(), values.note) }) },
        { label: 'Modify Depreciation', when: (r) => ['open', 'paused'].includes(r.state) && !r.disposal_date,
          wizard: (db, r = {}) => ({ title: 'Modify Depreciation', fields: [
            { name: 'modify_action', type: 'selection', label: 'Action', required: true, default: 'modify', options: [['dispose', 'Dispose'], ['sell', 'Sell'], ['modify', 'Re-evaluate'], ['pause', 'Pause'], ['activate_depreciation', 'Activate Depreciation']] },
            { name: 'date', type: 'date', label: 'Date', required: true, default: today() },
            { name: 'name', type: 'text', label: 'Note' },
            { name: 'value_residual', type: 'monetary', label: 'Depreciable Amount', default: (cents(r?.original_value || 0) - cents(r?.already_depreciated || 0) - postedCents(r) - cents(r?.salvage_value || 0)) / 100, invisible: (v) => v.modify_action !== 'modify' },
            { name: 'salvage_value', type: 'monetary', label: 'Not Depreciable Value', default: r?.salvage_value ?? 0, invisible: (v) => v.modify_action !== 'modify' },
            { name: 'method_mode', type: 'selection', label: 'Computation', default: r?.method_mode ?? 'duration', options: [['duration', 'By Duration'], ['rate', 'By Rate']], invisible: (v) => v.modify_action !== 'modify' },
            { name: 'method_number', type: 'float', label: 'Remaining Duration', invisible: (v) => v.modify_action !== 'modify' || v.method_mode === 'rate' },
            { name: 'method_period', type: 'selection', label: 'Period', default: r?.method_period, options: [['1', 'Months'], ['12', 'Years']], invisible: (v) => v.modify_action !== 'modify' },
            { name: 'method_rate', type: 'float', label: 'Depreciation Rate', default: r?.method_mode === 'rate' ? r?.method_rate : null, invisible: (v) => v.modify_action !== 'modify' || v.method_mode !== 'rate' },
            { name: 'account_asset_id', type: 'many2one', relation: 'account.account', label: 'Gross Increase Account', default: r?.account_asset_id ?? null, invisible: (v) => v.modify_action !== 'modify', domain: (account) => isActiveCompanyAccount(account, r?.company_id ?? 1) && ['asset_fixed', 'asset_non_current'].includes(account.account_type) },
            { name: 'account_depreciation_id', type: 'many2one', relation: 'account.account', label: 'Accumulated Depreciation', default: r?.account_depreciation_id ?? null, invisible: (v) => v.modify_action !== 'modify', domain: (account) => isActiveCompanyAccount(account, r?.company_id ?? 1) },
            { name: 'account_depreciation_expense_id', type: 'many2one', relation: 'account.account', label: 'Depreciation Expense', default: r?.account_depreciation_expense_id ?? null, invisible: (v) => v.modify_action !== 'modify', domain: (account) => isActiveCompanyAccount(account, r?.company_id ?? 1) },
            { name: 'account_asset_counterpart_id', type: 'many2one', relation: 'account.account', label: 'Asset Counterpart Account', invisible: (v) => v.modify_action !== 'modify', domain: (account) => isActiveCompanyAccount(account, r?.company_id ?? 1) },
            { name: 'new_account_asset_id', type: 'many2one', relation: 'account.account', label: 'New Fixed Asset Account', required: (v) => v.modify_action === 'activate_depreciation', invisible: (v) => v.modify_action !== 'activate_depreciation', domain: (account) => isValidFixedAssetAccount(account, r.company_id ?? 1) },
            { name: 'gain_account_id', type: 'many2one', relation: 'account.account', label: 'Gain Account', default: db && r ? read(db, 'res.company', r.company_id ?? 1)?.gain_account_id : null, invisible: (v) => !['sell', 'dispose'].includes(v.modify_action) },
            { name: 'loss_account_id', type: 'many2one', relation: 'account.account', label: 'Loss Account', default: db && r ? read(db, 'res.company', r.company_id ?? 1)?.loss_account_id : null, invisible: (v) => !['sell', 'dispose'].includes(v.modify_action) },
            { name: 'invoice_line_ids', type: 'many2many', picker: 'asset_invoice_lines', label: 'Invoice Lines', required: (v) => v.modify_action === 'sell', invisible: (v) => v.modify_action !== 'sell', options: (currentDb, values) => assetSaleInvoiceLineOptions(currentDb, r, values.date) },
          ], onchange: (values, key) => {
            if (key === 'method_mode' && values.method_mode === 'rate' && (values.method_rate == null || values.method_rate === '')) {
              return { method_rate: Number(values.method_number) > 0 ? 1 / Number(values.method_number) : r?.method_rate ?? null };
            }
            return {};
          } }),
          run: (db, r, values = {}) => {
            const date = values.date ?? today();
            if (values.modify_action === 'pause') return { db: pauseAsset(db, r, date, values.name) };
            if (values.modify_action === 'activate_depreciation') return { db: activateDepreciation(db, r, { date, newAccountAssetId: values.new_account_asset_id, note: values.name }) };
            if (['sell', 'dispose'].includes(values.modify_action)) {
              const selections = values.modify_action === 'sell' ? (values.invoice_line_ids ?? []) : [];
              if (!Array.isArray(selections) || (values.modify_action === 'sell' && !selections.length)) throw new Error('Select a sale invoice line');
              const allowed = new Map(assetSaleInvoiceLineOptions(db, r, date).map((option) => [option.key, option]));
              const invoiceLines = selections.map((key) => {
                const option = allowed.get(key);
                if (!option) throw new Error('Sale invoice line not found');
                return { invoice_id: option.invoice_id, line_index: option.line_index };
              });
              return { db: disposeAsset(db, r, { date, invoiceLines, gainAccountId: values.gain_account_id || null, lossAccountId: values.loss_account_id || null, note: values.name }) };
            }
            const depreciatedDb = postDepreciation(db, r, date);
            const currentAsset = read(depreciatedDb, 'account.asset', r.id);
            const currentBookCents = cents(r.original_value) - cents(r.already_depreciated) - postedCents(r);
            const currentSalvageCents = cents(r.salvage_value || 0);
            const currentResidualCents = currentBookCents - currentSalvageCents;
            const salvageProvided = values.salvage_value != null && values.salvage_value !== '';
            const newSalvageCents = salvageProvided ? cents(values.salvage_value) : currentSalvageCents;
            const residualProvided = values.value_residual != null && values.value_residual !== '';
            const newResidualCents = residualProvided ? cents(values.value_residual) : currentResidualCents;
            const delta = residualProvided || salvageProvided ? (newResidualCents + newSalvageCents - currentBookCents) / 100 : 0;
            if (delta > 0 && r.method !== 'no_depreciation' && !values.account_asset_id) throw new Error('Select a gross increase account');
            const assetMode = r.method_mode ?? 'duration';
            const selectedMode = values.method_mode ?? assetMode;
            const modeChanged = selectedMode !== assetMode;
            const rateInput = values.method_rate == null || values.method_rate === '' ? null : Number(values.method_rate);
            const rateChanged = selectedMode === 'rate' && (modeChanged || (rateInput != null && rateInput !== Number(r.method_rate)));
            const numberInput = values.method_number == null || values.method_number === '' ? null : Number(values.method_number);
            const duration = selectedMode === 'rate' ? (rateChanged ? (rateInput ? 1 / rateInput : 0) : null) : numberInput;
            if (r.method !== 'no_depreciation' && duration != null && (!Number.isFinite(duration) || duration < 1)) throw new Error('The duration must be at least 1 period');
            const periodChanged = values.method_period != null && String(values.method_period) !== String(r.method_period);
            const salvageChanged = salvageProvided && newSalvageCents !== currentSalvageCents;
            let next = modifyAsset(depreciatedDb, currentAsset, {
              date,
              valueChange: delta,
              accountId: values.account_asset_counterpart_id || null,
              increaseAccountId: values.account_asset_id || null,
              depreciationAccountId: values.account_depreciation_id || null,
              expenseAccountId: values.account_depreciation_expense_id || null,
              methodNumber: duration,
              methodPeriod: periodChanged ? values.method_period : null,
              methodMode: modeChanged ? selectedMode : null,
              methodRate: selectedMode === 'rate' ? (rateChanged ? rateInput : null) : (duration ? 1 / duration : null),
              salvageValue: salvageChanged ? Number(values.salvage_value) : null,
            });
            if (values.name?.trim()) next = postNote(next, 'account.asset', r.id, values.name.trim());
            return { db: next };
          } },
        { label: 'Sell or Dispose', when: (r) => ['open', 'paused', 'close'].includes(r.state) && !r.disposal_date,
          wizard: (db, r) => ({ title: 'Sell or Dispose', fields: [
            { name: 'date', type: 'date', label: 'Disposal Date', required: true, default: today() },
            { name: 'sale_value', type: 'monetary', label: 'Sale Price' },
            { name: 'loss_account_id', type: 'many2one', relation: 'account.account', label: 'Loss Account', default: read(db, 'res.company', r.company_id ?? 1)?.loss_account_id },
            { name: 'gain_account_id', type: 'many2one', relation: 'account.account', label: 'Gain Account', default: read(db, 'res.company', r.company_id ?? 1)?.gain_account_id },
            { name: 'note', type: 'text', label: 'Note' },
            { name: 'invoice_id', type: 'many2one', relation: 'account.move', label: 'Customer Invoice', domain: (invoice) => invoice.state === 'posted' && invoice.move_type === 'out_invoice' && (invoice.company_id ?? 1) === (r.company_id ?? 1) },
            { name: 'invoice_line', type: 'selection', label: 'Invoice Line', dependsOn: 'invoice_id', options: (currentDb, values) => (read(currentDb, 'account.move', values.invoice_id)?.invoice_line_ids ?? []).map((line, index) => [String(index), line.name || read(currentDb, 'product', line.product_id)?.name || `#${index + 1}`]) },
          ], onchange: (values, key, currentDb) => {
            if (!['invoice_id', 'invoice_line'].includes(key)) return {};
            const invoice = values.invoice_id && read(currentDb, 'account.move', values.invoice_id);
            const index = key === 'invoice_id' && invoice?.invoice_line_ids?.length ? '0' : values.invoice_line;
            const source = index == null || index === '' ? null : (invoice?.line_ids ?? []).flatMap((line) => line.invoice_sources ?? []).find((item) => item.index === Number(index));
            return { ...(key === 'invoice_id' ? { invoice_line: index } : {}), sale_value: source?.amount ?? null };
          } }),
          run: (db, r, values = {}) => {
            if (values.invoice_id && (values.invoice_line == null || values.invoice_line === '')) throw new Error('Select a sale invoice line');
            if (values.sale_value != null && values.sale_value !== '' && (!Number.isFinite(Number(values.sale_value)) || Number(values.sale_value) < 0)) throw new Error('The sale price cannot be negative');
            return { db: disposeAsset(db, r, { date: values.date ?? today(), saleValue: values.sale_value == null || values.sale_value === '' ? undefined : Number(values.sale_value), invoiceId: values.invoice_id || null, invoiceLine: Number(values.invoice_line ?? 0), lossAccountId: values.loss_account_id || null, gainAccountId: values.gain_account_id || null, note: values.note }) };
          } },
        { label: 'Cancel Asset', when: (r) => r.state === 'open', run: (db, r) => ({ db: cancelAsset(db, r) }) },
        { label: 'Set to Running', when: (r, db) => canSetAssetRunning(db, r), run: (db, r) => ({ db: setAssetRunning(db, r) }) },
        { label: 'Cancel', when: (r) => r.state === 'draft', vals: { state: 'cancel' } },
      ],
      title: 'name',
      groups: [['parent_id', 'source_move_id', 'asset_group_id', 'model_id', 'original_value', 'salvage_value', 'already_depreciated', 'book_value', 'acquisition_date', 'partner_id', 'bill_id', 'company_id', 'journal_id', 'account_asset_id', 'account_depreciation_id', 'account_depreciation_expense_id'], ['method', 'method_mode', 'method_rate', 'method_number', 'method_period', 'method_progress_factor', 'prorata_computation_type', 'prorata_date', 'analytic_distribution', 'disposal_date', 'sale_value']],
      tabs: [
        { label: 'Depreciation Board', fields: ['depreciation_ids', 'cancelled_depreciation_ids'] },
        { label: 'Value Adjustments', fields: ['revaluation_ids'], when: (r) => (r?.revaluation_ids ?? []).length > 0 },
      ],
      chatter: true,
    },
  },
};
