// @ts-check
// Opening balances helper (FX-13): create/update the company's draft opening move.
import { create, read, write } from '../orm.js';
import { fiscalYearStart } from './ledger.js';
import { today } from './common.js';
import { companyCurrencyRecord, roundCurrency } from '../money.js';

/** Resolve the opening move for a company (or null). */
function openingMove(db, companyId) {
  const company = read(db, 'res.company', companyId);
  return company?.account_opening_move_id ? read(db, 'account.move', company.account_opening_move_id) : null;
}

/**
 * Set or clear the opening balance for one account.
 * - Creates the company's draft opening move when none exists.
 * - Replaces that account's lines with one line (or none if both 0).
 * - Keeps ONE balancing line on opening_equity_account_id.
 * - Refuses when the opening move is already posted.
 * - Refuses debit and credit both > 0.
 * - Refuses setting a balance on the equity account itself.
 * @param {object} db
 * @param {number} accountId
 * @param {{ debit?: number, credit?: number, companyId?: number }} options
 * @returns {object} new db
 */
export function setOpeningBalance(db, accountId, { debit = 0, credit = 0, companyId = null } = {}) {
  const account = read(db, 'account.account', accountId);
  if (!account) throw new Error('Account not found');
  const cId = companyId ?? account.company_id ?? 1;
  const company = read(db, 'res.company', cId);
  if (!company) throw new Error('Company not found');

  const companyCurrency = companyCurrencyRecord(db, cId);
  if (account.currency_id && (!companyCurrency || account.currency_id !== companyCurrency.id)) {
    throw new Error('Opening balances on accounts in another currency are not supported yet');
  }

  if (!company.opening_equity_account_id) {
    throw new Error('Configure the Opening Balance Equity Account on the company before setting opening balances');
  }
  if (accountId === company.opening_equity_account_id) {
    throw new Error('The opening equity account carries the automatic balancing line and cannot have a manual opening balance');
  }
  if (Number(debit) > 0 && Number(credit) > 0) {
    throw new Error('An account cannot have both a debit and a credit opening balance');
  }

  const d = roundCurrency(Math.max(0, Number(debit) || 0), companyCurrency);
  const c = roundCurrency(Math.max(0, Number(credit) || 0), companyCurrency);
  const equityId = company.opening_equity_account_id;

  // --- Ensure the opening move exists ---
  let next = db;
  let move = openingMove(db, cId);

  if (move && move.state === 'posted') {
    throw new Error('The opening move is posted; reset it to draft to change opening balances');
  }

  if (!move) {
    if (!company.default_general_journal_id) {
      throw new Error('Configure the Default General Journal on the company before setting opening balances');
    }
    const journal = read(db, 'account.journal', company.default_general_journal_id);
    if (!journal) throw new Error('The configured Default General Journal does not exist');

    const openingDate = company.account_opening_date
      ?? fiscalYearStart(db, today(), cId);

    const made = create(next, 'account.move', {
      move_type: 'entry',
      state: 'draft',
      journal_id: company.default_general_journal_id,
      company_id: cId,
      date: openingDate,
      name: '/',
      ref: 'Opening Balance',
      line_ids: [],
    });
    next = write(made.db, 'res.company', cId, { account_opening_move_id: made.id });
    move = read(next, 'account.move', made.id);
  }

  // --- Rebuild line_ids ---
  const moveId = move.id;
  const existing = move.line_ids ?? [];

  // All lines except the ones for this account and the balancing line.
  const otherLines = existing.filter(
    (l) => !l.is_opening_balancing && l.account_id !== accountId,
  );

  // The new line for this account (omit when both 0).
  const newAccountLine = (d > 0 || c > 0)
    ? [{ account_id: accountId, debit: d, credit: c, name: 'Opening Balance' }]
    : [];

  // Compute net of all non-equity lines after the change.
  const otherNet = otherLines.reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);
  const totalNet = roundCurrency(otherNet + d - c, companyCurrencyRecord(next, cId));

  // Balancing line: opposite of the total so the move nets to zero.
  // Remove the balancing line when total is already zero.
  const balancingLine = totalNet !== 0
    ? [{
      account_id: equityId,
      debit: totalNet < 0 ? -totalNet : 0,
      credit: totalNet > 0 ? totalNet : 0,
      name: 'Automatic Balancing Line',
      is_opening_balancing: true,
    }]
    : [];

  const line_ids = [...otherLines, ...newAccountLine, ...balancingLine];
  next = write(next, 'account.move', moveId, { line_ids });
  return next;
}

/** The account's opening debit and credit, read from its company's opening move. */
export function openingAmounts(db, account) {
  const move = openingMove(db, account.company_id ?? 1);
  return (move?.line_ids ?? []).filter((l) => l.account_id === account.id).reduce((sum, l) => ({
    debit: sum.debit + (Number(l.debit) || 0),
    credit: sum.credit + (Number(l.credit) || 0),
  }), { debit: 0, credit: 0 });
}
