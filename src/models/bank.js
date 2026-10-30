// Bank reconciliation: statement lines matched to open invoices/bills, or booked directly to an account.
import { read, search, write } from '../orm.js';
import { today } from './common.js';
import { postEntry } from './ledger.js';
import { payMove } from './accounting.js';
import { applyRule, ruleMatches, suggestRule } from './reconcile.js';
import { importStatement } from './statements.js';
import { datedLockDelete, datedLockGuard } from './finance.js';
import { round } from '../money.js';

/** The suggested reconciliation model for a line, else the first matching button model. */
const modelFor = (db, line) => suggestRule(db, line)
  ?? search(db, 'account.reconcile.model').filter((m) => m.active !== false && m.rule_type === 'writeoff_button' && ruleMatches(m, line)).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))[0] ?? null;

const inboundTypes = ['out_invoice', 'in_refund'];
const outboundTypes = ['in_invoice', 'out_refund'];

/** Why this line cannot settle this invoice/bill: not open, wrong direction (money in vs out) or more than is due. */
export function matchError(line, move) {
  if (!move) return 'Select an invoice or bill to match';
  if ((line.company_id ?? 1) !== (move.company_id ?? 1)) return 'The invoice belongs to another company';
  if (!(Number(line.amount) > 0 || Number(line.amount) < 0)) return 'A bank transaction of 0 cannot be reconciled';
  if (move.state !== 'posted' || !(move.amount_residual > 0)) return `${move.name} has nothing left to pay`;
  const incoming = line.amount > 0;
  if (!(incoming ? inboundTypes : outboundTypes).includes(move.move_type)) {
    return incoming ? 'Money received can only settle a customer invoice or a vendor refund' : 'Money paid out can only settle a vendor bill or a customer refund';
  }
  if (round(Math.abs(line.amount)) > round(move.amount_residual)) {
    return `${move.name} only has ${round(move.amount_residual)} left to pay; book the difference to an account first`;
  }
  return null;
}

/** Open posted invoices (money in) or bills (money out) whose amount due equals the line amount; same partner first. */
export function candidates(db, line) {
  const incoming = line.amount > 0;
  return search(db, 'account.move')
    .filter((m) => m.state === 'posted' && (m.company_id ?? 1) === (line.company_id ?? 1) && m.amount_residual > 0 && (incoming ? inboundTypes : outboundTypes).includes(m.move_type))
    .sort((a, b) => Number(b.partner_id === line.partner_id) - Number(a.partner_id === line.partner_id)
      || Math.abs(a.amount_residual - Math.abs(line.amount)) - Math.abs(b.amount_residual - Math.abs(line.amount)));
}

/** Reconcile with a specific invoice/bill: registers the payment (bank entry) and closes the line. */
export function reconcileWith(db, line, moveId) {
  const move = read(db, 'account.move', moveId);
  const err = matchError(line, move);
  if (err) throw new Error(err);
  const paid = payMove(db, moveId, Math.abs(line.amount), line.date ?? today(), { journalId: line.journal_id, ...(line.amount < 0 ? { statementLineId: line.id } : {}) });
  const paymentMove = read(paid, 'account.move', moveId).payments.at(-1).move_id;
  return write(paid, 'account.bank.statement.line', line.id, { state: 'reconciled', move_id: moveId, payment_move_id: paymentMove, partner_id: line.partner_id ?? move.partner_id });
}

function autoReconcile(db, line) {
  const match = candidates(db, line).find((m) => round(m.amount_residual) === round(Math.abs(line.amount)));
  if (!match) throw new Error('No open invoice or bill with this exact amount. Pick one in "Match with" or book it to an account.');
  return { db: reconcileWith(db, line, match.id) };
}

function bookToAccount(db, line) {
  if (!(Number(line.amount) > 0 || Number(line.amount) < 0)) throw new Error('A bank transaction of 0 cannot be reconciled');
  const account = line.counterpart ?? (line.amount > 0 ? '450000' : '600000');
  const value = Math.abs(line.amount);
  const lines = line.amount > 0
    ? [{ account: '101401', debit: value }, { account, credit: value }]
    : [{ account, debit: value }, { account: '101401', credit: value }];
  const { db: booked, id } = postEntry(db, { journal: 'BNK1', journal_id: line.journal_id, date: line.date, ref: line.payment_ref, company: line.company_id ?? 1, lines: lines.map((l) => ({ ...l, partner_id: line.partner_id })) });
  return { db: write(booked, 'account.bank.statement.line', line.id, { state: 'reconciled', move_id: id }) };
}

/** A reconciled line must point at a posted entry, and is frozen afterwards (amount, sign, date, partner, label, link). */
function lineGuard(db, before, after) {
  if (before?.state === 'reconciled') {
    const changed = ['state', 'amount', 'date', 'partner_id', 'move_id', 'payment_move_id', 'payment_ref', 'company_id', 'journal_id'].find((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
    return changed ? 'A reconciled bank transaction cannot be changed' : null;
  }
  const company = after.company_id ?? 1;
  if (after.journal_id) {
    const journal = read(db, 'account.journal', after.journal_id);
    if (!journal || (journal.company_id && journal.company_id !== company)) return 'The bank journal belongs to another company or does not exist';
  }
  if (after.state !== 'reconciled') return null;
  if (!after.move_id) return 'A bank transaction can only be reconciled against a posted journal entry';
  // The server validates bank lines after the entries of the same change set (guardLast).
  for (const id of [after.move_id, after.payment_move_id].filter(Boolean)) {
    const move = read(db, 'account.move', id);
    if (move?.state !== 'posted') return 'A bank transaction can only be reconciled against a posted journal entry';
    if ((move.company_id ?? 1) !== company) return 'The matched entry belongs to another company';
    const journal = read(db, 'account.journal', move.journal_id);
    if (journal?.company_id && journal.company_id !== company) return 'The matched entry journal belongs to another company';
    if ((move.line_ids ?? []).some((l) => {
      const account = read(db, 'account.account', l.account_id);
      return account?.company_id && account.company_id !== company;
    })) return 'A matched entry account belongs to another company';
    if ((db.records['account.payment'] ?? []).some((p) => p.move_id === id && (p.company_id ?? 1) !== company)) return 'The linked payment belongs to another company';
  }
  return null;
}

export const bankModels = {
  'account.bank.statement.line': {
    label: 'Bank Transactions',
    guard: (db, before, after) => datedLockGuard(['date', 'amount', 'partner_id', 'state', 'move_id', 'payment_move_id', 'journal_id', 'counterpart', 'unique_import_id', 'payment_ref', 'company_id', 'active'], (l) => l.state === 'reconciled' || Boolean(l.move_id))(db, before, after) ?? lineGuard(db, before, after),
    protectDelete: (db, l) => datedLockDelete((l) => l.state === 'reconciled' || Boolean(l.move_id))(db, l) ?? (l.state === 'reconciled' ? 'A reconciled bank transaction cannot be deleted' : null),
    guardLast: true,
    // Statement files from the bank (beside the generic CSV import).
    importFile: { accept: '.ofx,.qfx,.xml', run: importStatement },
    fields: {
      date: { type: 'date', label: 'Date', required: true },
      payment_ref: { type: 'char', label: 'Label', required: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
      amount: { type: 'monetary', label: 'Amount', required: true },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['to_check', 'To Reconcile'], ['reconciled', 'Reconciled']] },
      journal_id: { type: 'many2one', relation: 'account.journal', label: 'Bank Journal' },
      move_id: { type: 'many2one', relation: 'account.move', label: 'Matched with' },
      payment_move_id: { type: 'many2one', relation: 'account.move', label: 'Journal Entry', readonly: true },
      unique_import_id: { type: 'char', label: 'Import ID', readonly: true },
      counterpart: {
        type: 'selection',
        label: 'Book to Account',
        options: [['450000', '450000 Other Income'], ['600000', '600000 Expenses'], ['610000', '610000 Travel & Meals'], ['630000', '630000 Rent'], ['690000', '690000 Bank Fees']],
      },
      name: { type: 'char', label: 'Name', compute: (r) => r.payment_ref },
    },
    defaults: () => ({ date: today(), state: 'to_check' }),
    defaultFilters: ['open'],
    filters: [[{ id: 'open', label: 'To Reconcile', fn: (r) => r.state === 'to_check' }, { id: 'done', label: 'Reconciled', fn: (r) => r.state === 'reconciled' }],
      [{ id: 'in', label: 'Incoming', fn: (r) => r.amount > 0 }, { id: 'out', label: 'Outgoing', fn: (r) => r.amount < 0 }]],
    groupBys: ['state', 'partner_id', 'date'],
    kanban: { groupBy: 'state', title: 'payment_ref', lines: ['date', 'amount', 'partner_id'] },
    list: ['date', 'payment_ref', 'partner_id', 'amount', 'move_id', 'state'],
    listDecoration: (r) => (r.state === 'to_check' ? 'info' : null),
    views: ['list', 'kanban'],
    form: {
      statusbar: 'state',
      lockedWhen: (r) => r.state === 'reconciled',
      buttons: [
        { label: 'Reconcile', primary: true, when: (r) => r.state === 'to_check' && !r.move_id, run: autoReconcile },
        { label: 'Match', primary: true, when: (r) => r.state === 'to_check' && r.move_id, run: (db, r) => ({ db: reconcileWith(db, r, r.move_id) }) },
        {
          label: 'Apply Reconciliation Model', when: (r) => r.state === 'to_check',
          run: (db, r) => {
            const model = modelFor(db, r);
            if (!model) throw new Error('No reconciliation model matches this transaction');
            return { db: applyRule(db, model, r) };
          },
        },
        { label: 'Book to Account', when: (r) => r.state === 'to_check', run: bookToAccount },
      ],
      title: 'payment_ref',
      groups: [['date', 'partner_id', 'amount', 'journal_id'], ['move_id', 'counterpart']],
      chatter: true,
    },
  },
};
