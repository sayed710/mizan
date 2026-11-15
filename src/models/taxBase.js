// Line-level deduplication for taxable bases across posted invoices, credit notes, POS orders, and cash-basis releases.
import { companyRoundingMethod } from './common.js';
import { allocateJournalSources } from './ledger.js';
import { computeLineTaxes, isSectionOrNote, taxLabel } from './taxes.js';
import { currencyUnits, documentCurrency, findCompanyCurrencyRecord, round } from '../money.js';

const INVOICE_TYPES = ['out_invoice', 'out_refund', 'in_invoice', 'in_refund'];
const taxKey = (ref) => (ref.tax_id != null ? `id:${ref.tax_id}` : `name:${ref.tax_name || ''}`);
const sumTaxBases = (items) => items.reduce((s, item) => round(s + taxItemBase(item)), 0);
const taxRefMatchesItem = (ref, item) => ((ref.tax_id != null || item.tax_id != null)
  ? (ref.tax_id ?? null) === (item.tax_id ?? null)
  : (ref.tax_name || '') === (item.tax_name || ''));

/** Return the signed company-currency base carried by a single tax journal item (matching taxesByTax). */
export function taxItemBase(item) {
  return item.invoiceBase ?? (
    item.tax_base_signed
      ? (Number(item.tax_base) || 0)
      : (item.tax ? Math.sign(item.tax) : 1) * (Number(item.tax_base) || 0)
  );
}

/** Allocate a tax key's posted base across its carrying document lines proportionally to their weights. */
function allocateTaxShares(postedBase, lineEntries, ownCurrency) {
  const shares = new Map();
  if (currencyUnits(postedBase, ownCurrency) === 0) {
    for (const entry of lineEntries) shares.set(entry.idx, 0);
    return shares;
  }
  const totalWeight = lineEntries.reduce((sum, entry) => sum + entry.weight, 0);
  if (Math.abs(totalWeight) < 1e-9) {
    lineEntries.forEach((entry, i) => shares.set(entry.idx, i === 0 ? postedBase : 0));
    return shares;
  }
  const sources = lineEntries.map((entry) => ({ index: entry.idx, amount: entry.weight }));
  for (const share of allocateJournalSources(postedBase, sources, postedBase / totalWeight, ownCurrency)) {
    shares.set(share.index, share.amount);
  }
  return shares;
}

/** Extract matching tax references for one document line. */
function lineTaxRefs(line, computed, cashBasis) {
  if (computed.taxes.length) {
    return computed.taxes
      .filter((t) => Boolean(t.tax_cash_basis) === cashBasis)
      .map((t) => ({ tax_id: t.tax_id ?? null, tax_name: taxLabel(t), isUntaxedBase: Math.abs((t.base ?? computed.untaxed) - computed.untaxed) < 1e-9 }));
  }
  return Boolean(line.tax_cash_basis) === cashBasis
    ? [{ tax_id: line.tax_id ?? null, tax_name: line.tax_name || taxLabel(line), isUntaxedBase: true }]
    : [];
}

/** Deduplicate taxable bases across structural lines of an invoice, refund, POS order, or cash-basis release. */
function moveMatchedBase(db, doc, moveItems, { cashBasis, accruedLineKeys }) {
  const side = ['out_refund', 'in_refund'].includes(doc.move_type) ? 'refund' : 'invoice';
  const docCurrency = documentCurrency(db, doc);
  const roundingMethod = companyRoundingMethod(db, doc.company_id);
  const unmatchedItems = new Set(moveItems);
  const matchedLines = [];
  const byTax = new Map();

  for (const [idx, line] of (doc.invoice_line_ids ?? []).entries()) {
    if (isSectionOrNote(line)) continue;
    const computed = computeLineTaxes(line, { currency: docCurrency, roundingMethod, side });
    let repKey = null;
    let firstKey = null;
    const seenKeys = new Set();
    for (const ref of lineTaxRefs(line, computed, cashBasis)) {
      const matched = moveItems.filter((item) => taxRefMatchesItem(ref, item));
      if (!matched.length) continue;
      const key = taxKey(ref);
      firstKey ??= key;
      if (repKey === null && ref.isUntaxedBase) repKey = key;
      const slot = byTax.get(key) ?? { entries: [], items: matched, isUntaxed: true };
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        slot.entries.push({ idx, weight: computed.untaxed });
      }
      slot.isUntaxed = slot.isUntaxed && ref.isUntaxedBase;
      byTax.set(key, slot);
      for (const item of matched) unmatchedItems.delete(item);
    }
    if (firstKey !== null) matchedLines.push({ idx, weight: computed.untaxed, repKey: repKey ?? firstKey });
  }

  if (!cashBasis) {
    for (const entry of matchedLines) accruedLineKeys.add(`${doc.id}:${entry.idx}`);
  }
  const activeLines = cashBasis ? matchedLines.filter((entry) => !accruedLineKeys.has(`${doc.id}:${entry.idx}`)) : matchedLines;
  const unmatchedSum = sumTaxBases([...unmatchedItems]);
  if (!activeLines.length) return unmatchedSum;

  if (matchedLines.every((entry) => entry.weight === 0)) {
    const docRep = [...byTax.values()].find((slot) => slot.isUntaxed) ?? byTax.values().next().value;
    return round(sumTaxBases(docRep.items) + unmatchedSum);
  }

  const ownCurrency = findCompanyCurrencyRecord(db, doc.company_id);
  const sharesByTax = new Map([...byTax].map(([key, slot]) => [key, allocateTaxShares(sumTaxBases(slot.items), slot.entries, ownCurrency)]));
  return activeLines.reduce((sum, e) => round(sum + (sharesByTax.get(e.repKey)?.get(e.idx) ?? 0)), unmatchedSum);
}

/**
 * Compute the deduplicated taxable base across posted tax journal items matching `matchItem`.
 * Multi-tax document lines count once instead of once per attached tax.
 */
export function deduplicatedTaxBase(db, items, matchItem = null) {
  const matching = matchItem ? items.filter(matchItem) : items;
  if (!matching.length) return 0;

  const moves = new Map((db.records['account.move'] ?? []).map((m) => [m.id, m]));
  const posOrdersByMove = new Map(
    (db.records['pos.order'] ?? [])
      .filter((o) => o.active !== false)
      .flatMap((o) => (o.accounting_entries ?? []).filter((e) => e?.move_id).map((e) => [e.move_id, o])),
  );

  const accruedLineKeys = new Set();
  const cashBasisMoves = [];
  let total = 0;

  for (const [moveId, moveItems] of Map.groupBy(matching, (item) => item.move_id)) {
    const move = moves.get(moveId);
    if (move?.cash_basis_origin_move_id) {
      cashBasisMoves.push([move, moveItems]);
    } else if (move && INVOICE_TYPES.includes(move.move_type)) {
      total = round(total + moveMatchedBase(db, move, moveItems, { cashBasis: false, accruedLineKeys }));
    } else if (move && posOrdersByMove.has(moveId)) {
      const order = posOrdersByMove.get(moveId);
      const doc = { ...move, move_type: order.refund_of ? 'out_refund' : 'out_invoice', invoice_line_ids: (order.lines ?? []).map((l) => ({ ...l, tax_cash_basis: false })) };
      total = round(total + moveMatchedBase(db, doc, moveItems, { cashBasis: false, accruedLineKeys }));
    } else {
      total = round(total + sumTaxBases(moveItems));
    }
  }

  for (const [move, moveItems] of cashBasisMoves) {
    const origin = moves.get(move.cash_basis_origin_move_id);
    total = round(total + (origin && INVOICE_TYPES.includes(origin.move_type)
      ? moveMatchedBase(db, origin, moveItems, { cashBasis: true, accruedLineKeys })
      : sumTaxBases(moveItems)));
  }

  return total;
}
