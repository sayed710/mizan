// Reconciliation models: rules that match bank statement lines and either match invoices or book a write-off.
import { read, search, write } from '../orm.js';
import { ensureBankSuspense, paymentJournal, postEntry } from './ledger.js';
import { candidates, reconcileWith, statementCompanyAmount, bookedStatementAmount } from './bank.js';
import { allocateCents, roundCurrency, companyCurrencyRecord } from '../money.js';
import { toCompany } from './currency.js';
import { computeLineTaxes, expandTaxIds, taxRepartitionLines } from './taxes.js';

const bySequence = (a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0) || a.id - b.id;

export { sameCommercialPartner } from './common.js';

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

/** Split a balance over counterpart lines: fixed amounts first, then percentages of the rest. */
function splitCounterparts(lines, balance, currency) {
  const fixed = lines.filter((l) => l.amount_type === 'fixed');
  const rest = roundCurrency(balance - fixed.reduce((s, l) => s + roundCurrency(Number(l.amount) || 0, currency), 0), currency);
  const pct = lines.filter((l) => l.amount_type !== 'fixed').reduce((s, l) => s + (Number(l.amount) || 0), 0);
  if (rest < 0 || roundCurrency(rest * (1 - pct / 100), currency) !== 0) throw new Error('The counterpart lines do not cover the whole amount');
  const variable = lines.filter((l) => l.amount_type !== 'fixed');
  const shares = variable.length && rest ? allocateCents(rest, variable.map((l) => Number(l.amount) || 0), currency) : variable.map(() => 0);
  let index = 0;
  return lines.map((l) => ({ ...l, value: l.amount_type === 'fixed' ? roundCurrency(Number(l.amount) || 0, currency) : shares[index++] }));
}

function writeOff(db, rule, line) {
  const incoming = line.amount > 0;
  const company = line.company_id ?? 1;
  const journalCurrency = read(db, 'account.journal', line.journal_id)?.currency_id ?? companyCurrencyRecord(db, company)?.id;
  const foreign = journalCurrency && journalCurrency !== companyCurrencyRecord(db, company)?.id;
  const currency = read(db, 'res.currency', journalCurrency);
  const balance = line.open_amount != null ? roundCurrency(line.open_amount * (foreign ? Math.abs(line.amount) / bookedStatementAmount(db, line) : 1), currency) : roundCurrency(Math.abs(line.amount), currency);
  if (!(balance > 0)) throw new Error('This bank transaction has no open amount');
  const counterparts = splitCounterparts(rule.line_ids ?? [], balance, currency).filter((l) => l.value);
  for (const counterpart of counterparts) {
    const account = read(db, 'account.account', counterpart.account_id);
    if (!counterpart.account_id) throw new Error(`Configure the counterpart account on reconciliation model ${rule.name}`);
    if (!account || account.active === false) throw new Error(`Unknown account in reconciliation model ${rule.name}`);
    if (account.company_id && account.company_id !== company) throw new Error('Reconciliation account belongs to another company');
  }
  const partner_id = line.partner_id ?? null;
  const companyValue = line.open_amount ?? statementCompanyAmount(db, line);
  const via = paymentJournal(db, line.journal_id, company);
  const side = (value, debit, extra = {}) => ({ ...extra, [debit ? 'debit' : 'credit']: roundCurrency(companyValue * value / balance, companyCurrencyRecord(db, company)), ...(foreign ? { currency_id: journalCurrency, amount_currency: (debit ? 1 : -1) * value } : {}) });
  const items = counterparts.flatMap((l) => {
    const taxRecs = expandTaxIds(db, l.tax_ids ?? []);
    for (const tax of taxRecs) {
      const repart = taxRepartitionLines(tax, 'invoice');
      for (const row of repart.filter((r) => r.repartition_type === 'tax')) {
        if (row.account_id) {
          const account = read(db, 'account.account', row.account_id);
          if (!account || account.active === false) throw new Error('Tax account does not exist or is inactive');
          if (account.company_id && account.company_id !== company) throw new Error('Tax account belongs to another company');
        }
      }
    }
    const taxSpecs = taxRecs.map((tax) => ({
      tax_id: tax.id,
      tax: Number(tax.amount) || 0,
      tax_type: tax.amount_type || 'percent',
      tax_include: true,
      tax_cash_basis: tax.tax_exigibility === 'on_payment',
      tax_name: tax.name,
      tax_include_base_amount: !!tax.include_base_amount,
      tax_is_base_affected: tax.is_base_affected !== false,
      tax_sequence: Number(tax.sequence ?? 1),
      invoice_repartition_line_ids: tax.invoice_repartition_line_ids ?? [],
      refund_repartition_line_ids: tax.refund_repartition_line_ids ?? [],
    }));

    const computed = computeLineTaxes({
      qty: 1,
      price_unit: l.value,
      tax_breakdown: taxSpecs,
    }, { currency, roundingMethod: 'round_per_line' });

    const partner = l.partner_id ?? partner_id;
    const allBaseTags = [...new Set(taxRecs.flatMap((t) => taxRepartitionLines(t, 'invoice').find((r) => r.repartition_type === 'base')?.tag_ids ?? []))];

    const taxLines = [];
    for (const t of computed.taxes) {
      const taxRec = taxRecs.find((rec) => rec.id === t.tax_id);
      if (!taxRec) continue;
      const repartLines = taxRepartitionLines(taxRec, 'invoice');
      const taxRows = repartLines.filter((r) => r.repartition_type === 'tax');
      if (!taxRows.length) continue;
      const weights = taxRows.map((r) => Number(r.factor_percent) || 0);
      const splitAmounts = taxRows.length === 1
        ? [t.amount]
        : allocateCents(t.amount, weights, currency, { tieBreak: 'last' });
      const splitBases = taxRows.length === 1
        ? [t.base]
        : allocateCents(t.base, weights, currency, { tieBreak: 'last' });

      for (let i = 0; i < taxRows.length; i++) {
        const row = taxRows[i];
        taxLines.push(side(splitAmounts[i], !incoming, {
          account: row.account_id ?? l.account_id,
          partner_id: partner,
          name: taxRec.name,
          tax_name: taxRec.name,
          tax_side: incoming ? 'sale' : 'purchase',
          tax_base: toCompany(db, journalCurrency, splitBases[i], line.date, company),
          tax_tag_ids: row.tag_ids ?? [],
        }));
      }
    }

    const net = computed.untaxed;
    return [
      side(net, !incoming, {
        account: l.account_id,
        partner_id: partner,
        name: l.label || line.payment_ref,
        ...(taxRecs.length ? {
          tax_side: incoming ? 'sale' : 'purchase',
          tax_grid_base: true,
          tax_tag_ids: allBaseTags,
        } : {}),
      }),
      ...taxLines,
    ];
  });
  const gap = roundCurrency(companyValue - items.reduce((sum, item) => sum + (item.debit || item.credit || 0), 0), companyCurrencyRecord(db, company));
  if (gap && items.length) { const key = incoming ? 'credit' : 'debit'; items[0][key] = roundCurrency(items[0][key] + gap, companyCurrencyRecord(db, company)); }
  const { db: booked, id } = postEntry(db, {
    journal: via.code, journal_id: via.id, date: line.date, ref: line.payment_ref, company: line.company_id ?? 1,
    lines: [
      side(balance, incoming, { account: line.bank_move_id ? ensureBankSuspense(db, company, via.id).id : via.accountId, partner_id }),
      ...items,
    ],
  });
  return write(booked, 'account.bank.statement.line', line.id, { state: 'reconciled', move_id: id, bank_move_id: line.bank_move_id ?? id, open_amount: 0, allocations: [...(line.allocations ?? []), { payment_move_id: id, amount: companyValue }] });
}

/** Apply a rule to a statement line: match an unambiguous invoice/bill, or post its write-off entry. */
export function applyRule(db, rule, line) {
  if (line.state === 'reconciled') throw new Error('This bank transaction is already reconciled');
  if (!(Number(line.amount) > 0 || Number(line.amount) < 0)) throw new Error('A bank transaction of 0 cannot be reconciled');
  if (rule.company_id && rule.company_id !== (line.company_id ?? 1)) throw new Error('Reconciliation model belongs to another company');
  const mappings = (rule.line_ids ?? []).filter((l) => l.partner_id && !l.account_id);
  if (mappings.length && mappings.length === (rule.line_ids ?? []).length) {
    if (new Set(mappings.map((l) => l.partner_id)).size !== 1 || !read(db, 'res.partner', mappings[0].partner_id)) throw new Error('Select one valid partner for the mapping');
    return write(db, 'account.bank.statement.line', line.id, { partner_id: mappings[0].partner_id });
  }
  if (rule.rule_type === 'invoice_matching') {
    const exact = candidates(db, line).filter((m) => toCompany(db, m.currency_id, m.amount_residual, line.date, m.company_id) === roundCurrency(line.open_amount ?? statementCompanyAmount(db, line), companyCurrencyRecord(db, line.company_id)));
    if (!line.partner_id) {
      if (exact.length) throw new Error('Select the statement partner, then review and confirm a matching invoice');
      return db;
    }
    if (exact.length > 1) throw new Error('Multiple invoices match. Review and select one in "Match with".');
    return exact.length ? reconcileWith(db, line, exact[0].id) : db;
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
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company' },
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
          account_id: { type: 'many2one', relation: 'account.account', label: 'Account' },
          label: { type: 'char', label: 'Label' },
          partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
          tax_ids: { type: 'many2many', relation: 'account.tax', label: 'Taxes' },
          amount_type: { type: 'selection', label: 'Amount Type', options: [['percentage', 'Percentage of balance'], ['fixed', 'Fixed']] },
          amount: { type: 'float', label: 'Amount' },
        },
        newLine: () => ({ label: '', amount_type: 'percentage', amount: 100 }),
      },
      active: { type: 'boolean', label: 'Active' },
    },
    defaults: () => ({
      sequence: 10, rule_type: 'writeoff_button', match_nature: 'both', match_amount: '', match_label: '', active: true,
      line_ids: [{ label: '', amount_type: 'percentage', amount: 100 }],
    }),
    guard: (db, _before, rule) => (rule.line_ids ?? []).some((line) => {
      if (!line.account_id) return false;
      const account = read(db, 'account.account', line.account_id);
      return !account || account.active === false || (account.company_id && account.company_id !== (rule.company_id ?? 1));
    }) ? 'Reconciliation accounts must be active and belong to the model company' : null,
    list: ['sequence', 'name', 'rule_type', 'auto_reconcile'],
    form: {
      title: 'name',
      groups: [['rule_type', 'sequence', 'auto_reconcile', 'active'], ['match_nature', 'match_amount', 'match_amount_min', 'match_amount_max'], ['match_label', 'match_label_param', 'match_partner', 'partner_id']],
      tabs: [{ label: 'Counterpart Entries', fields: ['line_ids'] }],
    },
  },
};
