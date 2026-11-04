// Bank reconciliation: statement lines matched to open invoices/bills, or booked directly to an account.
import { read, search, write } from '../orm.js';
import { today } from './common.js';
import { reverseEntry, reversePayment, reverseWriteoff } from './pay.js';
import { accountId, ensureBankSuspense, journalId, paymentJournal, postEntry } from './ledger.js';
import { rateAt, toCompany } from './currency.js';
import { payMove, settleWriteoff } from './accounting.js';
import { applyRule, ruleMatches, suggestRule } from './reconcile.js';
import { importStatement } from './statements.js';
import { datedLockDelete, datedLockGuard } from './finance.js';
import { round } from '../money.js';

/** The suggested reconciliation model for a line, else the first matching button model. */
const modelFor = (db, line) => suggestRule(db, line)
  ?? search(db, 'account.reconcile.model').filter((m) => m.active !== false && m.rule_type === 'writeoff_button' && ruleMatches(m, line)).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))[0] ?? null;

const inboundTypes = ['out_invoice', 'in_refund'];
const outboundTypes = ['in_invoice', 'out_refund'];

/** Why this line cannot settle this invoice/bill: not open or wrong company/direction. */
export function matchError(line, move) {
  if (!move) return 'Select an invoice or bill to match';
  if ((line.company_id ?? 1) !== (move.company_id ?? 1)) return 'The invoice belongs to another company';
  if (!(Number(line.amount) > 0 || Number(line.amount) < 0)) return 'A bank transaction of 0 cannot be reconciled';
  if (move.state !== 'posted' || !(move.amount_residual > 0)) return `${move.name} has nothing left to pay`;
  const incoming = line.amount > 0;
  if (!(incoming ? inboundTypes : outboundTypes).includes(move.move_type)) {
    return incoming ? 'Money received can only settle a customer invoice or a vendor refund' : 'Money paid out can only settle a vendor bill or a customer refund';
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

/** Apply the available statement balance to an invoice; an excess is held in bank suspense. */
export function reconcileWith(db, line, moveId) {
  const move = read(db, 'account.move', moveId);
  const err = matchError(line, move);
  if (err) throw new Error(err);
  if (line.state !== 'to_check') throw new Error('This bank transaction is already reconciled');
  const date = line.date ?? today();
  const company = line.company_id ?? 1;
  const available = round(line.open_amount ?? Math.abs(Number(line.amount)));
  const rate = rateAt(db, move.currency_id, date, company);
  const value = Math.min(round(move.amount_residual), Math.floor((available * rate + 1e-9) * 100) / 100);
  const used = toCompany(db, move.currency_id, value, date, company);
  if (!(value > 0) || !(used > 0) || used > available) throw new Error('The open statement amount is too small to settle this invoice');
  const remaining = round(available - used);
  const hasWriteoff = line.writeoff_account_id != null || line.writeoff_amount != null || Boolean(line.writeoff_label);
  let writeoffValue = 0;
  if (hasWriteoff) {
    const amount = Number(line.writeoff_amount);
    const account = read(db, 'account.account', line.writeoff_account_id);
    if (!account || (account.company_id && account.company_id !== company)) throw new Error('Write-off account belongs to another company or does not exist');
    if (!String(line.writeoff_label ?? '').trim()) throw new Error('Set a write-off label');
    if (!Number.isFinite(amount) || !(amount > 0) || round(amount) !== amount) throw new Error('Write-off amount must be a positive monetary amount');
    writeoffValue = round(amount * rate);
    if (!(writeoffValue > 0) || writeoffValue > round(move.amount_residual - value) || toCompany(db, move.currency_id, writeoffValue, date, company) !== amount) throw new Error('Write-off amount exceeds the remaining invoice or cannot be represented in its currency');
    const receivable = accountId(db, ['in_invoice', 'in_refund'].includes(move.move_type) ? '211000' : '121000', company);
    const bankAccount = accountId(db, paymentJournal(db, line.journal_id).account, company);
    if (account.id === receivable || account.id === bankAccount || account.id === accountId(db, '101404', company)) throw new Error('Write-off account must differ from the invoice, bank and suspense accounts');
  }
  let current = db;
  let bankMoveId = line.bank_move_id;
  let suspense = null;
  if (bankMoveId || remaining > 0) {
    const ensured = ensureBankSuspense(current, company);
    current = ensured.db;
    suspense = ensured.id;
    if (!bankMoveId) {
      const via = paymentJournal(db, line.journal_id);
      const incoming = line.amount > 0;
      const amount = round(Math.abs(line.amount));
      const booked = postEntry(current, { journal: via.code, journal_id: line.journal_id, date, ref: line.payment_ref, company,
        lines: incoming ? [{ account: via.account, debit: amount }, { account: suspense, credit: amount }] : [{ account: suspense, debit: amount }, { account: via.account, credit: amount }] });
      bankMoveId = booked.id;
      current = write(booked.db, 'account.bank.statement.line', line.id, { bank_move_id: bankMoveId, open_amount: available });
    }
  }
  const paid = payMove(current, moveId, value, date, { journalId: line.journal_id, statementLineId: line.id, ...(suspense ? { liquidityAccountId: suspense } : { directBank: true }) });
  const paymentMove = read(paid, 'account.move', moveId).payments.at(-1).move_id;
  const writeoff = hasWriteoff ? settleWriteoff(paid, moveId, writeoffValue, Number(line.writeoff_amount), date, { accountId: line.writeoff_account_id, label: line.writeoff_label, journalId: line.journal_id }) : null;
  return write(writeoff?.db ?? paid, 'account.bank.statement.line', line.id, { state: remaining ? 'to_check' : 'reconciled', move_id: moveId, payment_move_id: paymentMove, writeoff_move_id: writeoff?.id ?? null, bank_move_id: bankMoveId ?? paymentMove, open_amount: remaining, allocations: [...(line.allocations ?? []), { invoice_id: moveId, payment_move_id: paymentMove, amount: used, ...(writeoff ? { writeoff_move_id: writeoff.id } : {}) }], partner_id: line.partner_id ?? move.partner_id });
}

function matchPayment(db, line) {
  if (line.state !== 'to_check' || line.bank_move_id || (line.allocations ?? []).length) throw new Error('Unreconcile the booked bank transaction before matching a payment');
  const payment = read(db, 'account.payment', line.payment_id);
  const company = line.company_id ?? 1;
  if (!payment || payment.state !== 'posted' || !payment.move_id) throw new Error('Select a posted payment');
  if ((payment.company_id ?? 1) !== company) throw new Error('The payment belongs to another company');
  if (search(db, 'account.bank.statement.line').some((l) => l.id !== line.id && l.state === 'reconciled' && l.payment_move_id === payment.move_id)) throw new Error('Payment is already matched');
  const entry = read(db, 'account.move', payment.move_id);
  const incoming = line.amount > 0;
  if (!line.amount || (payment.payment_type === 'inbound') !== incoming) throw new Error('Statement amount and direction must match the payment');
  const via = paymentJournal(db, line.journal_id ?? payment.journal_id);
  const journal = read(db, 'account.journal', line.journal_id ?? payment.journal_id ?? journalId(db, via.code, company));
  if (journal && !['bank', 'cash'].includes(journal.type)) throw new Error('Bank transactions need a bank or cash journal');
  if (!entry || entry.state !== 'posted' || (entry.company_id ?? 1) !== company) throw new Error('Payment entry must be posted in the same company');
  const outstanding = payment.outstanding_account_id;
  const liquidity = entry.line_ids.filter((l) => l.account_id === outstanding && (incoming ? round(l.debit) === round(Math.abs(line.amount)) : round(l.credit) === round(Math.abs(line.amount))));
  if (!outstanding || liquidity.length !== 1) throw new Error('Cannot identify the payment outstanding item');
  if (read(db, 'account.account', outstanding)?.code === via.account) throw new Error('Outstanding and bank accounts must differ');
  const amount = round(Math.abs(line.amount));
  const lines = incoming ? [{ account: via.account, debit: amount }, { account: outstanding, credit: amount }] : [{ account: outstanding, debit: amount }, { account: via.account, credit: amount }];
  const booked = postEntry(db, { journal: via.code, journal_id: journal?.id, company, date: line.date, ref: line.payment_ref, lines });
  return { db: write(booked.db, 'account.bank.statement.line', line.id, { state: 'reconciled', move_id: booked.id, bank_move_id: booked.id, open_amount: 0, allocations: [{ payment_move_id: booked.id, amount }], payment_move_id: payment.move_id, payment_id: payment.id }) };
}

function autoReconcile(db, line) {
  const match = candidates(db, line).find((m) => round(m.amount_residual) === round(line.open_amount ?? Math.abs(line.amount)));
  if (!match) throw new Error('No open invoice or bill with this exact amount. Pick one in "Match with" or book it to an account.');
  return { db: reconcileWith(db, line, match.id) };
}

function bookToAccount(db, line) {
  if (!(Number(line.amount) > 0 || Number(line.amount) < 0)) throw new Error('A bank transaction of 0 cannot be reconciled');
  const account = line.counterpart ?? (line.amount > 0 ? '450000' : '600000');
  const value = round(line.open_amount ?? Math.abs(line.amount));
  if (!(value > 0)) throw new Error('This bank transaction has no open amount');
  const liquidity = line.bank_move_id ? accountId(db, '101404', line.company_id ?? 1) : paymentJournal(db, line.journal_id).account;
  const lines = line.amount > 0
    ? [{ account: liquidity, debit: value }, { account, credit: value }]
    : [{ account, debit: value }, { account: liquidity, credit: value }];
  const { db: booked, id } = postEntry(db, { journal: 'BNK1', journal_id: line.journal_id, date: line.date, ref: line.payment_ref, company: line.company_id ?? 1, lines: lines.map((l) => ({ ...l, partner_id: line.partner_id })) });
  return { db: write(booked, 'account.bank.statement.line', line.id, { state: 'reconciled', move_id: id, bank_move_id: line.bank_move_id ?? id, open_amount: 0, allocations: [...(line.allocations ?? []), { payment_move_id: id, amount: value }] }) };
}

/** Validate a release against linked, posted mirror entries rather than trusting a client flag. */
function unreconcileError(db, before, after) {
  if (after.state !== 'to_check' || after.move_id || after.payment_id || after.payment_move_id || after.writeoff_move_id || after.bank_move_id || after.open_amount != null || (after.allocations ?? []).length) return 'Unreconciliation requires reversing entries and clearing the bank links';
  const clearedFields = new Set(['state', 'move_id', 'payment_id', 'payment_move_id', 'writeoff_move_id', 'bank_move_id', 'open_amount', 'allocations', 'name']);
  if ([...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !clearedFields.has(k)).some((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null))) return 'A reconciled bank transaction cannot be changed';
  const bankId = before.bank_move_id ?? (before.payment_id ? before.move_id : null);
  if (!bankId) return 'Cannot unreconcile a transaction without its bank entry link';
  const allocations = before.allocations ?? [];
  const sources = new Set([bankId, ...allocations.flatMap((a) => [a.payment_move_id, a.writeoff_move_id]).filter(Boolean)]);
  for (const id of sources) {
    const source = read(db, 'account.move', id);
    const mirrors = (db.records['account.move'] ?? []).filter((m) => m.state === 'posted' && m.reversed_entry_id === id);
    const mirror = mirrors[0];
    if (!source || mirrors.length !== 1 || mirror.journal_id !== source.journal_id || (mirror.company_id ?? 1) !== (source.company_id ?? 1) || mirror.invoice_date < source.invoice_date || JSON.stringify((source.line_ids ?? []).map((l) => [l.account_id, l.partner_id ?? null, l.debit || 0, l.credit || 0])) !== JSON.stringify((mirror.line_ids ?? []).map((l) => [l.account_id, l.partner_id ?? null, l.credit || 0, l.debit || 0]))) return 'Unreconciliation requires linked reversing entries';
  }
  for (const a of allocations) {
    if (!a.invoice_id) continue;
    const invoice = read(db, 'account.move', a.invoice_id);
    for (const id of [a.payment_move_id, a.writeoff_move_id].filter(Boolean)) {
      const row = (invoice?.payments ?? []).find((p) => p.move_id === id);
      if (!row?.reversed || read(db, 'account.move', row.reversal_move_id)?.reversed_entry_id !== id) return 'Unreconciliation must restore the invoice settlement';
    }
    const payment = (db.records['account.payment'] ?? []).find((p) => p.move_id === a.payment_move_id);
    if (!payment || payment.state !== 'reversed') return 'Unreconciliation must reverse its generated payment';
  }
  if (before.payment_id && read(db, 'account.payment', before.payment_id)?.state !== 'posted') return 'The matched payment must remain posted';
  return null;
}

/** Release a match by posting linked reversals; existing payments are not reversed. */
function unreconcile(db, line) {
  const bankId = line.bank_move_id ?? (line.payment_id ? line.move_id : null);
  if (!bankId) throw new Error('Cannot unreconcile a transaction without its bank entry link');
  const allocations = line.allocations ?? [];
  const date = [today(), line.date ?? '', ...allocations.map((a) => read(db, 'account.move', a.payment_move_id)?.invoice_date ?? '')].sort().at(-1);
  // Stage an unlinked line while reversals are generated; the original and complete result are validated below.
  const original = db.records['account.bank.statement.line'].find((l) => l.id === line.id);
  const cleared = { ...original, state: 'to_check', move_id: null, payment_id: null, payment_move_id: null, writeoff_move_id: null, bank_move_id: null, open_amount: null, allocations: [] };
  let current = { ...db, records: { ...db.records, 'account.bank.statement.line': db.records['account.bank.statement.line'].map((l) => l.id === line.id ? cleared : l) } };
  for (const allocation of allocations) {
    if (allocation.invoice_id) {
      const payment = (current.records['account.payment'] ?? []).find((p) => p.move_id === allocation.payment_move_id);
      if (!payment) throw new Error('Cannot unreconcile: the generated payment link is missing');
      current = reversePayment(current, payment, date);
      if (allocation.writeoff_move_id) current = reverseWriteoff(current, allocation.invoice_id, allocation.writeoff_move_id, date);
    } else {
      const made = reverseEntry(current, read(current, 'account.move', allocation.payment_move_id), date);
      current = made.db;
    }
  }
  if (!(current.records['account.move'] ?? []).some((m) => m.state === 'posted' && m.reversed_entry_id === bankId)) current = reverseEntry(current, read(current, 'account.move', bankId), date).db;
  const error = unreconcileError(current, line, cleared);
  if (error) throw new Error(error);
  return { db: current };
}

/** A reconciled line must point at a posted entry, and is frozen afterwards (amount, sign, date, partner, label, link). */
function lineGuard(db, before, after) {
  if (before && (before.state === 'reconciled' || before.bank_move_id) && after.state === 'to_check' && !after.move_id) return unreconcileError(db, before, after);
  if (before?.state === 'reconciled') {
    const changed = ['state', 'amount', 'date', 'partner_id', 'move_id', 'payment_move_id', 'payment_id', 'writeoff_account_id', 'writeoff_label', 'writeoff_amount', 'writeoff_move_id', 'bank_move_id', 'open_amount', 'allocations', 'payment_ref', 'company_id', 'journal_id'].find((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
    return changed ? 'A reconciled bank transaction cannot be changed' : null;
  }
  if (before?.bank_move_id) {
    const changed = ['amount', 'date', 'payment_ref', 'company_id', 'journal_id', 'bank_move_id'].find((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
    if (changed) return 'A booked bank transaction cannot be changed';
  }
  const company = after.company_id ?? 1;
  if (after.journal_id) {
    const journal = read(db, 'account.journal', after.journal_id);
    if (!journal || (journal.company_id && journal.company_id !== company)) return 'The bank journal belongs to another company or does not exist';
    if (!['bank', 'cash'].includes(journal.type)) return 'Bank transactions need a bank or cash journal';
  }
  if (after.payment_id) {
    const payment = read(db, 'account.payment', after.payment_id);
    if (!payment || (payment.company_id ?? 1) !== company) return 'The linked payment belongs to another company or does not exist';
  }
  if (after.open_amount != null && (!Number.isFinite(Number(after.open_amount)) || after.open_amount < 0 || round(after.open_amount) > round(Math.abs(after.amount)))) return 'Invalid open bank transaction amount';
  if (before?.bank_move_id && JSON.stringify((after.allocations ?? []).slice(0, (before.allocations ?? []).length)) !== JSON.stringify(before.allocations ?? [])) return 'Bank transaction allocations cannot be changed';
  if (after.bank_move_id && after.open_amount != null) {
    const allocations = after.allocations ?? [];
    const allocated = allocations.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
    if (allocations.some((a) => !(Number(a.amount) > 0) || !a.payment_move_id) || new Set(allocations.map((a) => a.payment_move_id)).size !== allocations.length || round(allocated + Number(after.open_amount)) !== round(Math.abs(after.amount))) return 'Bank transaction allocations must match its amount';
    const bankEntry = read(db, 'account.move', after.bank_move_id);
    const via = paymentJournal(db, after.journal_id);
    const bankAccount = accountId(db, via.account, company);
    const bankLines = (bankEntry?.line_ids ?? []).filter((l) => l.account_id === bankAccount);
    if (bankEntry?.state !== 'posted' || (after.journal_id && bankEntry.journal_id !== after.journal_id) || bankLines.length !== 1 || round(after.amount > 0 ? bankLines[0].debit : bankLines[0].credit) !== round(Math.abs(after.amount))) return 'The bank entry must book the transaction amount once';
    const suspense = accountId(db, '101404', company);
    for (const allocation of allocations) {
      const entry = read(db, 'account.move', allocation.payment_move_id);
      if (allocation.invoice_id && !(read(db, 'account.move', allocation.invoice_id)?.payments ?? []).some((p) => p.move_id === allocation.payment_move_id && !p.reversed)) return 'The matched document must link to its settlement entry';
      if (allocation.writeoff_move_id) {
        const invoice = read(db, 'account.move', allocation.invoice_id);
        const writeoff = read(db, 'account.move', allocation.writeoff_move_id);
        const account = read(db, 'account.account', after.writeoff_account_id);
        const items = (writeoff?.line_ids ?? []).filter((l) => l.account_id === after.writeoff_account_id && l.name === after.writeoff_label && l.partner_id === invoice?.partner_id);
        if (after.writeoff_move_id !== allocation.writeoff_move_id || !(invoice?.payments ?? []).some((p) => p.move_id === allocation.writeoff_move_id && !p.reversed) || !account || (account.company_id && account.company_id !== company) || writeoff?.journal_id !== bankEntry.journal_id || items.length !== 1 || round(after.amount > 0 ? items[0].debit : items[0].credit) !== round(after.writeoff_amount)) return 'The matched document must link to its write-off entry';
      }
      if (allocation.payment_move_id !== after.bank_move_id) {
        const items = (entry?.line_ids ?? []).filter((l) => l.account_id === suspense);
        if (entry?.journal_id !== bankEntry.journal_id || items.length !== 1 || round(after.amount > 0 ? items[0].debit : items[0].credit) !== round(allocation.amount)) return 'The settlement must clear the bank suspense amount';
      }
    }
    if (after.writeoff_move_id && !allocations.some((a) => a.writeoff_move_id === after.writeoff_move_id)) return 'The matched document must link to its write-off entry';
  }
  if (after.state === 'reconciled' && after.open_amount > 0) return 'A reconciled bank transaction cannot have an open amount';
  if (after.state !== 'reconciled' && !after.bank_move_id) return null;
  if (after.state === 'reconciled' && !after.move_id) return 'A bank transaction can only be reconciled against a posted journal entry';
  // The server validates bank lines after the entries of the same change set (guardLast).
  for (const id of [after.state === 'reconciled' ? after.move_id : null, after.payment_move_id, after.writeoff_move_id, after.bank_move_id, ...(after.allocations ?? []).flatMap((a) => [a.payment_move_id, a.writeoff_move_id])].filter(Boolean)) {
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
    guard: (db, before, after) => datedLockGuard(['date', 'amount', 'partner_id', 'state', 'move_id', 'payment_move_id', 'payment_id', 'writeoff_account_id', 'writeoff_label', 'writeoff_amount', 'writeoff_move_id', 'bank_move_id', 'open_amount', 'allocations', 'journal_id', 'counterpart', 'unique_import_id', 'payment_ref', 'company_id', 'active'], (l) => l.state === 'reconciled' || Boolean(l.bank_move_id) || Boolean(l.move_id))(db, before, after) ?? lineGuard(db, before, after),
    protectDelete: (db, l) => datedLockDelete((l) => l.state === 'reconciled' || Boolean(l.bank_move_id) || Boolean(l.move_id))(db, l) ?? (l.state === 'reconciled' || l.bank_move_id ? 'A reconciled or booked bank transaction cannot be deleted' : null),
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
      payment_id: { type: 'many2one', relation: 'account.payment', label: 'Existing Payment' },
      payment_move_id: { type: 'many2one', relation: 'account.move', label: 'Journal Entry', readonly: true },
      writeoff_account_id: { type: 'many2one', relation: 'account.account', label: 'Write-off Account' },
      writeoff_label: { type: 'char', label: 'Write-off Label' },
      writeoff_amount: { type: 'monetary', label: 'Write-off Amount' },
      writeoff_move_id: { type: 'many2one', relation: 'account.move', label: 'Write-off Entry', readonly: true },
      bank_move_id: { type: 'many2one', relation: 'account.move', label: 'Bank Entry', readonly: true },
      open_amount: { type: 'monetary', label: 'Open Amount', readonly: true },
      allocations: { type: 'one2many', label: 'Matched Documents', readonly: true, fields: {
        invoice_id: { type: 'many2one', relation: 'account.move', label: 'Invoice' },
        payment_move_id: { type: 'many2one', relation: 'account.move', label: 'Journal Entry' },
        writeoff_move_id: { type: 'many2one', relation: 'account.move', label: 'Write-off Entry' },
        amount: { type: 'monetary', label: 'Amount' },
      } },
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
    list: ['date', 'payment_ref', 'partner_id', 'amount', 'open_amount', 'move_id', 'state'],
    listDecoration: (r) => (r.state === 'to_check' ? 'info' : null),
    views: ['list', 'kanban'],
    form: {
      statusbar: 'state',
      lockedWhen: (r) => r.state === 'reconciled',
      buttons: [
        { label: 'Unreconcile', when: (r) => r.state === 'reconciled' || Boolean(r.bank_move_id), run: unreconcile },
        { label: 'Reconcile', primary: true, when: (r) => r.state === 'to_check' && !r.move_id, run: autoReconcile },
        { label: 'Match Payment', primary: true, when: (r) => r.state === 'to_check' && r.payment_id, run: matchPayment },
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
      groups: [['date', 'partner_id', 'amount', 'open_amount', 'journal_id'], ['move_id', 'payment_id', 'counterpart'], ['writeoff_account_id', 'writeoff_label', 'writeoff_amount']],
      chatter: true,
    },
  },
};
