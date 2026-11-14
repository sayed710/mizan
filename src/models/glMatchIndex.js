// Index and residual/matching-group derivation for general-ledger partial matchings (account.partial.reconcile).
import { read } from '../orm.js';
import { findCompanyCurrencyRecord, isCurrencyZero, round, roundCurrency } from '../money.js';
import { sameCommercialPartner } from './common.js';

const DOCUMENT_TYPES = ['out_invoice', 'out_refund', 'in_invoice', 'in_refund'];

/** Build a stable node key identifying a specific journal line inside a move. */
export const lineKey = (moveId, lineIndex) => `${moveId}:${lineIndex}`;

/** Extract active `account.partial.reconcile` links whose moves are posted. */
export function indexGlMatchings(db) {
  const byLine = new Map();
  const byMove = new Map();
  const activeIds = new Set();
  const links = [];
  const addLine = (key, entry) => byLine.set(key, [...(byLine.get(key) ?? []), entry]);
  const addMove = (a, b) => {
    if (!a || !b || a === b) return;
    if (!byMove.has(a)) byMove.set(a, new Set());
    byMove.get(a).add(b);
  };
  for (const g of db.records['account.partial.reconcile'] ?? []) {
    if (!g || g.active === false || g.reversed || !(Number(g.amount) > 0)) continue;
    const debitMove = read(db, 'account.move', g.debit_move_id);
    const creditMove = read(db, 'account.move', g.credit_move_id);
    if (debitMove?.state !== 'posted' || creditMove?.state !== 'posted') continue;
    activeIds.add(g.id);
    links.push(g);
    addLine(lineKey(g.debit_move_id, g.debit_line_index), g);
    addLine(lineKey(g.credit_move_id, g.credit_line_index), g);
    addMove(g.debit_move_id, g.credit_move_id);
    addMove(g.credit_move_id, g.debit_move_id);
  }
  return { byLine, byMove, activeIds, links };
}

/**
 * Compute per-line matched amounts (company currency) on a non-document posted move, combining active
 * `account.partial.reconcile` links with legacy AR/AP payment-row applications that lack a `partial_reconcile_id`.
 */
export function entryMatchedAmounts(db, move, index) {
  const ownCurrency = findCompanyCurrencyRecord(db, move.company_id ?? 1);
  const roundOwn = (v) => (ownCurrency ? roundCurrency(v, ownCurrency) : round(v));
  const rawLines = move.line_ids ?? [];
  const applications = index.applications.get(move.id) ?? [];
  const glIds = index.glMatchings.activeIds;
  const moveCompany = move.company_id ?? 1;

  // Legacy AR/AP settlement rows not tracked by an account.partial.reconcile link (e.g., bank/payment/write-off).
  const legacyByAccountPartner = applications.filter(({ invoice, row }) => (
    !row.reversed && !row.unapplied && !(row.partial_reconcile_id != null && glIds.has(row.partial_reconcile_id))
    && (invoice.company_id ?? 1) === moveCompany
  ));

  const legacyRemaining = legacyByAccountPartner.map(({ invoice, row }) => ({
    invoice,
    accountIds: new Set((invoice.line_ids ?? []).map((l) => l.account_id)),
    left: roundOwn(Number(row.company_amount ?? row.payment_company_amount ?? row.amount) || 0),
  }));

  return rawLines.map((line, lineIdx) => {
    const absBal = roundOwn(Math.abs((Number(line.debit) || 0) - (Number(line.credit) || 0)));
    const glLinks = index.glMatchings.byLine.get(lineKey(move.id, lineIdx)) ?? [];
    const glMatched = roundOwn(glLinks.reduce((s, g) => s + (Number(g.amount) || 0), 0));
    let leftCap = Math.max(0, roundOwn(absBal - glMatched));
    let legacyMatched = 0;
    const account = read(db, 'account.account', line.account_id);
    const isArAp = ['asset_receivable', 'liability_payable'].includes(account?.account_type);
    if (isArAp && !isCurrencyZero(leftCap, ownCurrency)) {
      for (const item of legacyRemaining) {
        if (isCurrencyZero(item.left, ownCurrency) || !item.accountIds.has(line.account_id)) continue;
        if (!(item.invoice.partner_id === line.partner_id || sameCommercialPartner(db, item.invoice.partner_id, line.partner_id))) continue;
        const take = Math.min(leftCap, item.left);
        legacyMatched = roundOwn(legacyMatched + take);
        item.left = roundOwn(item.left - take);
        leftCap = roundOwn(leftCap - take);
        if (isCurrencyZero(leftCap, ownCurrency)) break;
      }
    }
    return {
      absBal,
      glMatched,
      matchedTotal: roundOwn(glMatched + legacyMatched),
      hasAnyLink: glLinks.length > 0 || legacyMatched > 0,
    };
  });
}

/**
 * Derive stable matching group numbers (`A<minLinkId>`) from connected components of active
 * `account.partial.reconcile` links whose participating lines are ALL fully reconciled.
 * Deriving the number from the component's smallest link record ID keeps numbers invariant
 * when unrelated matching groups are created or unreconciled.
 */
export function buildMatchingNumbers(db, index, isLineFullyReconciled) {
  const { links, activeIds } = index.glMatchings;
  if (!links.length) return new Map();

  const adj = new Map();
  const nodeLinks = new Map();
  const linkEdge = (a, b, linkId) => {
    if (!a || !b || a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
    if (linkId != null) {
      if (!nodeLinks.has(a)) nodeLinks.set(a, []);
      if (!nodeLinks.has(b)) nodeLinks.set(b, []);
      nodeLinks.get(a).push(linkId);
      nodeLinks.get(b).push(linkId);
    }
  };
  for (const g of links) {
    linkEdge(lineKey(g.debit_move_id, g.debit_line_index), lineKey(g.credit_move_id, g.credit_line_index), g.id);
  }
  const activePaymentMoves = new Set(links.map((g) => g.debit_move_id).concat(links.map((g) => g.credit_move_id)));
  for (const move of db.records['account.move'] ?? []) {
    if (move.state !== 'posted' || !DOCUMENT_TYPES.includes(move.move_type) || !activePaymentMoves.has(move.id)) continue;
    for (const row of move.payments ?? []) {
      if (row.reversed || row.unapplied || row.partial_reconcile_id == null || !activeIds.has(row.partial_reconcile_id)) continue;
      if (Number.isInteger(row.line_index)) {
        for (const other of move.payments ?? []) {
          if (!other.reversed && !other.unapplied && other.partial_reconcile_id != null && other !== row) {
            const sameTarget = (other.line_index ?? row.line_index) === row.line_index;
            if (sameTarget) {
              const otherLink = links.find((l) => l.id === other.partial_reconcile_id);
              if (otherLink) {
                linkEdge(
                  lineKey(move.id, row.line_index),
                  lineKey(otherLink.debit_move_id === move.id ? otherLink.credit_move_id : otherLink.debit_move_id,
                    otherLink.debit_move_id === move.id ? otherLink.credit_line_index : otherLink.debit_line_index),
                  otherLink.id,
                );
              }
            }
          }
        }
      }
    }
  }

  const visited = new Set();
  const numbers = new Map();
  for (const start of adj.keys()) {
    if (visited.has(start)) continue;
    const comp = [];
    const compLinkIds = new Set();
    const queue = [start];
    visited.add(start);
    while (queue.length) {
      const cur = queue.shift();
      comp.push(cur);
      for (const lid of nodeLinks.get(cur) ?? []) compLinkIds.add(lid);
      for (const nxt of adj.get(cur) ?? []) {
        if (!visited.has(nxt)) {
          visited.add(nxt);
          queue.push(nxt);
        }
      }
    }
    if (comp.length < 2 || !compLinkIds.size) continue;
    const allReconciled = comp.every((k) => {
      const [mIdStr, idxStr] = k.split(':');
      return isLineFullyReconciled(Number(mIdStr), Number(idxStr));
    });
    if (allReconciled) {
      const code = `A${Math.min(...compLinkIds)}`;
      for (const k of comp) numbers.set(k, code);
    }
  }
  return numbers;
}
