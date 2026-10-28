// Reconciliation models: rules that match bank statement lines and either match invoices or book a write-off.
import { read, search, write } from '../orm.js';
import { accountId, postEntry } from './ledger.js';
import { candidates, reconcileWith } from './bank.js';
import { round } from '../money.js';

const bySequence = (a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0) || a.id - b.id;

function labelMatches(rule, label) {
  const text = String(label ?? '');
  const param = String(rule.match_label_param ?? '');
  if (rule.match_label === 'contains') return text.toLowerCase().includes(param.toLowerCase());
  if (rule.match_label === 'not_contains') return !text.toLowerCase().includes(param.toLowerCase());
  if (rule.match_label === 'match_regex') {
    try { return new RegExp(param, 'i').test(text); } catch { return false; }
  }
  return true;
}

function amountMatches(rule, amount) {
  const value = Math.abs(Number(amount) || 0);
  const min = Number(rule.match_amount_min) || 0;
  const max = Number(rule.match_amount_max) || 0;
  if (rule.match_amount === 'lower') return value < max;
  if (rule.match_amount === 'greater') return value > min;
  if (rule.match_amount === 'between') return value >= min && value <= max;
  return true;
}

/** Whether a statement line meets the rule's nature, amount, label and partner conditions. */
export function ruleMatches(rule, line) {
  const amount = Number(line.amount) || 0;
  if (rule.match_nature === 'amount_received' && !(amount > 0)) return false;
  if (rule.match_nature === 'amount_paid' && !(amount < 0)) return false;
  if ((rule.match_partner || rule.partner_id) && !line.partner_id) return false;
  if (rule.partner_id && line.partner_id !== rule.partner_id) return false;
  return amountMatches(rule, amount) && labelMatches(rule, line.payment_ref);
}

/** Split a balance over counterpart lines: fixed amounts first, then percentages of the rest; the last line absorbs rounding. */
function splitCounterparts(lines, balance) {
  const fixed = lines.filter((l) => l.amount_type === 'fixed');
  const rest = round(balance - fixed.reduce((s, l) => s + (Number(l.amount) || 0), 0));
  const pct = lines.filter((l) => l.amount_type !== 'fixed').reduce((s, l) => s + (Number(l.amount) || 0), 0);
  if (rest < 0 || Math.abs(rest * (1 - pct / 100)) >= 0.005) throw new Error('The counterpart lines do not cover the whole amount');
  const values = lines.map((l) => (l.amount_type === 'fixed' ? round(Number(l.amount) || 0) : round((rest * (Number(l.amount) || 0)) / 100)));
  values[values.length - 1] = round(balance - values.slice(0, -1).reduce((s, v) => s + v, 0));
  return lines.map((l, i) => ({ ...l, value: values[i] }));
}

function writeOff(db, rule, line) {
  const incoming = line.amount > 0;
  const balance = round(Math.abs(line.amount));
  const counterparts = splitCounterparts(rule.line_ids ?? [], balance).filter((l) => l.value);
  const unknown = counterparts.find((l) => !accountId(db, l.account_code));
  if (unknown) throw new Error(`Unknown account ${unknown.account_code} in reconciliation model ${rule.name}`);
  const partner_id = line.partner_id ?? null;
  const { db: booked, id } = postEntry(db, {
    journal: 'BNK1', date: line.date, ref: line.payment_ref,
    lines: [
      { account: '101401', [incoming ? 'debit' : 'credit']: balance, partner_id },
      ...counterparts.map((l) => ({ account: l.account_code, [incoming ? 'credit' : 'debit']: l.value, partner_id, name: l.label || line.payment_ref })),
    ],
  });
  return write(booked, 'account.bank.statement.line', line.id, { state: 'reconciled', move_id: id });
}

/** Apply a rule to a statement line: match the first candidate invoice/bill, or post its write-off entry. */
export function applyRule(db, rule, line) {
  if (line.state === 'reconciled') throw new Error('This bank transaction is already reconciled');
  if (!(Number(line.amount) > 0 || Number(line.amount) < 0)) throw new Error('A bank transaction of 0 cannot be reconciled');
  if (rule.rule_type === 'invoice_matching') {
    // Only an exact amount match, and from the line's partner when it has one: never pay someone else's invoice.
    const match = candidates(db, line).find((m) => (!line.partner_id || m.partner_id === line.partner_id) && round(m.amount_residual) === round(Math.abs(line.amount)));
    return match ? reconcileWith(db, line, match.id) : db;
  }
  return writeOff(db, rule, line);
}

const activeRules = (db) => search(db, 'account.reconcile.model').filter((r) => r.active !== false).sort(bySequence);

/**
 * Reconcile every 'to_check' line with the first matching auto-validated active rule (by sequence).
 * Runs unattended on the server, so regex rules (user patterns could backtrack for ages) are left to manual use,
 * and a line that fails (locked period, bad rule) is skipped rather than stopping the run.
 */
export function autoReconcile(db) {
  const rules = activeRules(db).filter((r) => r.auto_reconcile && r.match_label !== 'match_regex');
  return search(db, 'account.bank.statement.line').filter((l) => l.state === 'to_check').reduce((acc, l) => {
    const rule = rules.find((r) => ruleMatches(r, l));
    if (!rule) return acc;
    try {
      return applyRule(acc, rule, read(acc, 'account.bank.statement.line', l.id));
    } catch {
      return acc;
    }
  }, db);
}

/** The first active matching suggestion or invoice-matching rule (by sequence), or null. */
export function suggestRule(db, line) {
  return activeRules(db).find((r) => ['writeoff_suggestion', 'invoice_matching'].includes(r.rule_type) && ruleMatches(r, line)) ?? null;
}

export const reconcileModels = {
  'account.reconcile.model': {
    label: 'Reconciliation Models',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      sequence: { type: 'integer', label: 'Sequence' },
      rule_type: { type: 'selection', label: 'Type', options: [['writeoff_button', 'Button to generate counterpart entry'], ['writeoff_suggestion', 'Rule to suggest counterpart entry'], ['invoice_matching', 'Rule to match invoices/bills']] },
      auto_reconcile: { type: 'boolean', label: 'Auto-validate' },
      match_nature: { type: 'selection', label: 'Amount Type', options: [['amount_received', 'Received'], ['amount_paid', 'Paid'], ['both', 'Paid/Received']] },
      match_amount: { type: 'selection', label: 'Amount', options: [['', 'Any'], ['lower', 'Is Lower Than'], ['greater', 'Is Greater Than'], ['between', 'Is Between']] },
      match_amount_min: { type: 'monetary', label: 'Amount Min' },
      match_amount_max: { type: 'monetary', label: 'Amount Max' },
      match_label: { type: 'selection', label: 'Label', options: [['', 'None'], ['contains', 'Contains'], ['not_contains', 'Not Contains'], ['match_regex', 'Match Regex']] },
      match_label_param: { type: 'char', label: 'Label Parameter' },
      match_partner: { type: 'boolean', label: 'Partner is Set' },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Matching Partner' },
      line_ids: {
        type: 'one2many',
        label: 'Counterpart Entries',
        fields: {
          account_code: { type: 'char', label: 'Account' },
          label: { type: 'char', label: 'Label' },
          amount_type: { type: 'selection', label: 'Amount Type', options: [['percentage', 'Percentage of balance'], ['fixed', 'Fixed']] },
          amount: { type: 'float', label: 'Amount' },
        },
        newLine: () => ({ account_code: '690000', label: '', amount_type: 'percentage', amount: 100 }),
      },
      active: { type: 'boolean', label: 'Active' },
    },
    defaults: () => ({
      sequence: 10, rule_type: 'writeoff_button', match_nature: 'both', match_amount: '', match_label: '', active: true,
      line_ids: [{ account_code: '690000', label: '', amount_type: 'percentage', amount: 100 }],
    }),
    list: ['sequence', 'name', 'rule_type', 'auto_reconcile'],
    form: {
      title: 'name',
      groups: [['rule_type', 'sequence', 'auto_reconcile', 'active'], ['match_nature', 'match_amount', 'match_amount_min', 'match_amount_max'], ['match_label', 'match_label_param', 'match_partner', 'partner_id']],
      tabs: [{ label: 'Counterpart Entries', fields: ['line_ids'] }],
    },
  },
};
