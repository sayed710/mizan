// Reconciliation models: rules that match bank statement lines and either match invoices or book a write-off.
import { read, search, write } from '../orm.js';
import { ensureBankSuspense, isLiquidityJournal, paymentJournal, postEntry } from './ledger.js';
import { bookBankMovement, candidates, reconcileWith, statementCompanyAmount, bookedStatementAmount } from './bank.js';
import { allocateCents, roundCurrency, companyCurrencyRecord } from '../money.js';
import { toCompany } from './currency.js';
import { computeLineTaxes, expandTaxIds, taxRepartitionLines, taxRepartitionSplits } from './taxes.js';

export { sameCommercialPartner } from './common.js';

const bySequence = (a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0) || (a.id ?? 0) - (b.id ?? 0);
const isBlank = (v) => v == null || String(v).trim() === '';
const parseStrictNumber = (raw) => {
  const s = String(raw ?? '').trim();
  if (!s) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

/** Compile a regular expression case-insensitively, returning null if invalid or empty. */
function compileRegex(pattern) {
  const text = String(pattern ?? '');
  if (!text) return null;
  try {
    return new RegExp(text, 'i');
  } catch {
    return null;
  }
}

/** Whether the rule operates as an invoice/bill matching rule (supports legacy invoice_matching). */
export const isMatchingRule = (rule) => rule?.rule_type === 'matching_rule' || rule?.rule_type === 'invoice_matching';

/** Whether the rule runs automatically during batch auto-reconciliation. */
export const isAutoRule = (rule) => (rule?.trigger != null ? rule.trigger === 'auto_reconcile' : Boolean(rule?.auto_reconcile));

/** Keep numeric float `amount` synchronized with `amount_string` for non-regex line types. */
function syncLineAmount(line, index = 0) {
  if (!line || typeof line !== 'object') return line;
  const type = line.amount_type || 'percentage';
  const sequence = line.sequence ?? (index + 1) * 10;
  let amountString = line.amount_string;
  if (amountString == null) {
    if (line.amount != null && type !== 'regex') amountString = String(line.amount);
    else if (type === 'regex') amountString = '';
    else if (!line.account_id && line.partner_id) amountString = '100';
    else amountString = '';
  } else {
    amountString = String(amountString);
  }
  if (type === 'regex') {
    return { ...line, sequence, amount_type: type, amount_string: amountString, amount: 0 };
  }
  const parsed = parseStrictNumber(amountString);
  const amount = Number.isFinite(parsed) ? parsed : (Number(line.amount) || 0);
  return { ...line, sequence, amount_type: type, amount_string: amountString, amount };
}

/**
 * Normalize a reconciliation model record (or create payload) to the Odoo 20 schema.
 * Reused by `prepareCreate` and database migration so legacy fields map through one code path.
 */
export function normalizeReconcileRule(rule) {
  if (!rule || typeof rule !== 'object') return rule;
  const {
    auto_reconcile,
    partner_id,
    match_nature,
    match_partner,
    ...rest
  } = rule;
  const rule_type = isMatchingRule(rule) ? 'matching_rule' : 'reco_model';
  const trigger = rule.trigger != null ? rule.trigger : (auto_reconcile ? 'auto_reconcile' : 'manual');
  const match_partner_ids = Array.isArray(rule.match_partner_ids)
    ? rule.match_partner_ids
    : (partner_id ? [partner_id] : []);
  const match_journal_ids = Array.isArray(rule.match_journal_ids) ? rule.match_journal_ids : [];
  // Legacy fixed amounts were shares on the counterpart side; Odoo 20 reads them as credit (+) or debit (-).
  // A rule limited to paid (outgoing) transactions books its counterpart as a debit, so its legacy amount turns negative.
  // ponytail: a legacy rule for both directions keeps its sign, which is right for received money only.
  const legacyDebit = match_nature === 'amount_paid';
  const line_ids = (rule.line_ids ?? []).map((l, i) => syncLineAmount(
    legacyDebit && l.amount_string == null && l.amount_type === 'fixed' && l.amount != null ? { ...l, amount: -Number(l.amount) } : l,
    i,
  ));
  return {
    ...rest,
    rule_type,
    trigger,
    match_journal_ids,
    match_partner_ids,
    match_amount: rule.match_amount || null,
    match_label: rule.match_label || null,
    payment_tolerance: rule.payment_tolerance != null ? rule.payment_tolerance : 0,
    payment_tolerance_type: rule.payment_tolerance_type || 'percentage',
    matching_order: rule.matching_order || 'old_first',
    ...(match_nature === 'amount_received' || match_nature === 'amount_paid' ? { match_nature } : {}),
    ...(match_partner === true ? { match_partner: true } : {}),
    line_ids,
  };
}

function labelMatches(rule, label) {
  const text = String(label ?? '');
  const param = String(rule.match_label_param ?? '');
  if (rule.match_label === 'contains') return text.toLowerCase().includes(param.toLowerCase());
  if (rule.match_label === 'not_contains') return !text.toLowerCase().includes(param.toLowerCase());
  if (rule.match_label === 'match_regex') {
    const re = compileRegex(param);
    return re ? re.test(text) : false;
  }
  return true;
}

function amountMatches(rule, amount) {
  const value = Math.abs(Number(amount) || 0);
  const min = Number(rule.match_amount_min) || 0;
  const max = Number(rule.match_amount_max) || 0;
  if (rule.match_amount === 'lower') return value <= max;
  if (rule.match_amount === 'greater') return value >= min;
  if (rule.match_amount === 'between') return value >= min && value <= max;
  return true;
}

/** Whether a statement line meets the rule's journal, partner, amount, label and legacy nature conditions. */
export function ruleMatches(rule, line) {
  if (rule.active === false) return false;
  if (rule.company_id && rule.company_id !== (line?.company_id ?? 1)) return false;
  if (Array.isArray(rule.match_journal_ids) && rule.match_journal_ids.length > 0 && !rule.match_journal_ids.includes(line?.journal_id)) {
    return false;
  }
  const amount = Number(line?.amount) || 0;
  if (rule.match_nature === 'amount_received' && !(amount > 0)) return false;
  if (rule.match_nature === 'amount_paid' && !(amount < 0)) return false;
  const partnerIds = Array.isArray(rule.match_partner_ids) && rule.match_partner_ids.length > 0
    ? rule.match_partner_ids
    : (rule.partner_id ? [rule.partner_id] : null);
  if ((rule.match_partner || partnerIds) && !line?.partner_id) return false;
  if (partnerIds && !partnerIds.includes(line?.partner_id)) return false;
  return amountMatches(rule, amount) && labelMatches(rule, line?.payment_ref);
}

/**
 * Parse a numeric amount from `text` using `pattern`:
 * supports 0 capture groups (full match), 1 capture group (whole/decimal number),
 * or 2 capture groups (integer part + decimal part). Returns null when invalid or unmatched.
 */
function extractRegexAmount(pattern, text) {
  const re = compileRegex(pattern);
  if (!re) return null;
  const match = re.exec(String(text ?? ''));
  if (!match) return null;
  let numeric = NaN;
  if (match.length > 2 && match[1] !== undefined && match[2] !== undefined) {
    const intPart = String(match[1]).replace(/[\s,_]/g, '') || '0';
    const decPart = String(match[2]).replace(/[\s,_]/g, '');
    if (/^[+-]?\d+$/.test(intPart) && /^\d+$/.test(decPart)) {
      numeric = Number(`${intPart}.${decPart}`);
    }
  } else {
    let raw = String(match.length > 1 && match[1] !== undefined ? match[1] : match[0]).trim().replace(/\s+/g, '');
    if (/^[+-]?\d+(,\d{1,2})$/.test(raw)) raw = raw.replace(',', '.');
    else raw = raw.replace(/,/g, '');
    numeric = Number(raw);
  }
  if (!Number.isFinite(numeric) || numeric === 0) return null;
  return Math.abs(numeric);
}

function splitCounterparts(lines, balance, currency, paymentRef = '', incoming = true, stLineTotal = balance) {
  const ordered = [...lines].sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0));
  const rawOf = (l) => (l.amount_string != null && l.amount_string !== '' ? Number(l.amount_string) : Number(l.amount)) || 0;
  const fixedValueOf = (l) => {
    const raw = roundCurrency(rawOf(l), currency);
    // In Odoo 20 fixed lines follow accounting polarity (negative=debit, positive=credit);
    // express value relative to the counterpart direction (credit when incoming, debit when outgoing).
    return incoming ? raw : -raw;
  };

  const preComputed = ordered.map((l) => {
    if (l.amount_type === 'fixed') return { type: 'fixed', value: fixedValueOf(l) };
    if (l.amount_type === 'percentage_st_line') return { type: 'fixed', value: roundCurrency(stLineTotal * rawOf(l) / 100, currency) };
    if (l.amount_type === 'regex') {
      const extracted = extractRegexAmount(l.amount_string ?? l.amount, paymentRef);
      return { type: 'regex', value: extracted == null ? 0 : roundCurrency(extracted, currency) };
    }
    return { type: 'percentage', pct: rawOf(l) };
  });

  const nonPctTotal = roundCurrency(preComputed.reduce((s, item) => s + (item.type === 'percentage' ? 0 : item.value), 0), currency);
  const rest = roundCurrency(balance - nonPctTotal, currency);
  // A fixed/st-line/regex amount above the balance can only be balanced by a negative percentage share,
  // which would post a tax computed on the oversized amount beside a counterpart with the opposite sign.
  if (rest < 0) throw new Error('The fixed counterpart lines exceed the amount to reconcile');

  const pctItems = preComputed.filter((item) => item.type === 'percentage');
  const pctSum = pctItems.reduce((s, item) => s + item.pct, 0);
  const shares = pctSum === 100 && pctItems.length && rest > 0
    ? allocateCents(rest, pctItems.map((item) => item.pct), currency)
    : pctItems.map((item) => roundCurrency(rest * item.pct / 100, currency));
  let pctIndex = 0;
  const split = ordered.map((l, i) => ({
    ...l,
    value: preComputed[i].type === 'percentage' ? shares[pctIndex++] : preComputed[i].value,
  }));
  if (roundCurrency(split.reduce((sum, l) => sum + l.value, 0) - balance, currency) > 0) {
    throw new Error('The counterpart lines exceed the amount to reconcile');
  }
  return split;
}

function writeOff(db, rule, line) {
  const incoming = line.amount > 0;
  const company = line.company_id ?? 1;
  const journalCurrency = read(db, 'account.journal', line.journal_id)?.currency_id ?? companyCurrencyRecord(db, company)?.id;
  const foreign = journalCurrency && journalCurrency !== companyCurrencyRecord(db, company)?.id;
  const currency = read(db, 'res.currency', journalCurrency);
  const balance = line.open_amount != null
    ? roundCurrency(line.open_amount * (foreign ? Math.abs(line.amount) / bookedStatementAmount(db, line) : 1), currency)
    : roundCurrency(Math.abs(line.amount), currency);
  if (!(balance > 0)) throw new Error('This bank transaction has no open amount');
  const ruleLines = rule.line_ids ?? [];
  const stLineTotal = roundCurrency(Math.abs(line.amount), currency);
  const split = splitCounterparts(ruleLines, balance, currency, line.payment_ref, incoming, stLineTotal);
  const counterparts = split.filter((l) => l.value);
  if (!counterparts.length) {
    // Regex lines that do not match the transaction label are skipped without failing the line.
    if (ruleLines.some((l) => l.amount_type === 'regex')) return db;
    throw new Error('The counterpart lines do not cover any amount');
  }
  for (const counterpart of counterparts) {
    const account = read(db, 'account.account', counterpart.account_id);
    if (!counterpart.account_id) throw new Error(`Configure the counterpart account on reconciliation model ${rule.name}`);
    if (!account || account.active === false) throw new Error(`Unknown account in reconciliation model ${rule.name}`);
    if (account.company_id && account.company_id !== company) throw new Error('Reconciliation account belongs to another company');
  }
  const partner_id = line.partner_id ?? null;
  const companyValue = line.open_amount ?? statementCompanyAmount(db, line);
  const companyCurrency = companyCurrencyRecord(db, company);
  const via = paymentJournal(db, line.journal_id, company);
  const side = (value, debit, extra = {}) => ({
    ...extra,
    [debit ? 'debit' : 'credit']: roundCurrency(companyValue * value / balance, companyCurrency),
    ...(foreign ? { currency_id: journalCurrency, amount_currency: (debit ? 1 : -1) * value } : {}),
  });
  const items = counterparts.flatMap((l) => {
    const absValue = Math.abs(l.value);
    const sameAsCounterpart = l.value > 0;
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
      price_unit: absValue,
      tax_breakdown: taxSpecs,
    }, { currency, roundingMethod: 'round_per_line' });

    const partner = l.partner_id ?? partner_id;
    const allBaseTags = [...new Set(taxRecs.flatMap((t) => taxRepartitionLines(t, 'invoice').find((r) => r.repartition_type === 'base')?.tag_ids ?? []))];

    const taxLines = [];
    for (const t of computed.taxes) {
      const taxRec = taxRecs.find((rec) => rec.id === t.tax_id);
      if (!taxRec) continue;
      for (const { row, amount, base } of taxRepartitionSplits(t, {}, 'invoice', currency).splits) {
        const taxDebit = sameAsCounterpart ? (amount < 0 ? incoming : !incoming) : (amount < 0 ? !incoming : incoming);
        taxLines.push(side(Math.abs(amount), taxDebit, {
          account: row.account_id ?? l.account_id,
          partner_id: partner,
          name: taxRec.name,
          tax_id: taxRec.id,
          tax_name: taxRec.name,
          tax_side: (sameAsCounterpart ? incoming : !incoming) ? 'sale' : 'purchase',
          tax_base: toCompany(db, journalCurrency, base, line.date, company),
          tax_tag_ids: row.tag_ids ?? [],
        }));
      }
    }

    const net = computed.untaxed;
    return [
      side(net, sameAsCounterpart ? !incoming : incoming, {
        account: l.account_id,
        partner_id: partner,
        name: l.label || line.payment_ref,
        ...(taxRecs.length ? {
          tax_side: (sameAsCounterpart ? incoming : !incoming) ? 'sale' : 'purchase',
          tax_grid_base: true,
          tax_tag_ids: allBaseTags,
        } : {}),
      }),
      ...taxLines,
    ];
  });
  const counterpartSide = incoming ? 'credit' : 'debit';
  const opposingSide = incoming ? 'debit' : 'credit';
  const counterpartTotal = roundCurrency(items.reduce((sum, item) => sum + (Number(item[counterpartSide]) || 0) - (Number(item[opposingSide]) || 0), 0), companyCurrency);
  const itemCurrency = roundCurrency(items.reduce((sum, item) => sum + (Number(item.amount_currency) || 0), 0), currency);
  const companyRemainder = roundCurrency(companyValue - counterpartTotal, companyCurrency);
  // Full coverage: the split covers the whole journal-currency balance, or its company-currency remainder rounds to nothing.
  const fullCoverage = roundCurrency(split.reduce((sum, l) => sum + l.value, 0), currency) === balance || companyRemainder <= 0;
  if (fullCoverage && items.length) {
    if (companyRemainder) items[0][counterpartSide] = roundCurrency((Number(items[0][counterpartSide]) || 0) + companyRemainder, companyCurrency);
    // A coarse company increment can round a partial share up to the booked amount: absorb the journal units
    // it cannot represent on the same counterpart, keeping the entry balanced in both currencies.
    if (foreign) {
      const sign = counterpartSide === 'debit' ? 1 : -1;
      const currencyGap = roundCurrency(sign * balance - itemCurrency, currency);
      if (currencyGap) items[0].amount_currency = roundCurrency((Number(items[0].amount_currency) || 0) + currencyGap, currency);
    }
  }
  let current = db;
  let bankMoveId = line.bank_move_id ?? null;
  let openAmount = 0;
  let allocated = companyValue;
  let entryLines = [side(balance, incoming, { account: bankMoveId ? ensureBankSuspense(db, company, via.id).id : via.accountId, partner_id }), ...items];
  if (!fullCoverage) {
    // The bank movement is booked once into the bank suspense account; this entry clears only its share.
    const bookedBank = bookBankMovement(db, line, company, { date: line.date, openAmount: companyValue });
    current = bookedBank.db;
    bankMoveId = bookedBank.bankMoveId;
    openAmount = companyRemainder;
    allocated = counterpartTotal;
    entryLines = [{
      account: bookedBank.suspense,
      partner_id,
      [incoming ? 'debit' : 'credit']: counterpartTotal,
      ...(foreign ? { currency_id: journalCurrency, amount_currency: -itemCurrency } : {}),
    }, ...items];
  }
  const { db: booked, id } = postEntry(current, {
    journal: via.code, journal_id: via.id, date: line.date, ref: line.payment_ref, company: line.company_id ?? 1,
    lines: entryLines,
  });
  return write(booked, 'account.bank.statement.line', line.id, {
    state: fullCoverage ? 'reconciled' : 'to_check',
    move_id: id,
    bank_move_id: bankMoveId ?? id,
    open_amount: openAmount,
    allocations: [...(line.allocations ?? []), { payment_move_id: id, amount: allocated, reconcile_model_id: rule.id }],
  });
}

const byMatchingOrder = (order) => (a, b) => {
  const da = a.invoice_date || a.date || '';
  const dbDate = b.invoice_date || b.date || '';
  const cmp = da.localeCompare(dbDate) || ((a.id ?? 0) - (b.id ?? 0));
  return order === 'new_first' ? -cmp : cmp;
};

/** Apply a rule to a statement line: match an eligible invoice/bill per matching_order/tolerance, or post its write-off entry. */
export function applyRule(db, rule, line) {
  if (line.state === 'reconciled') throw new Error('This bank transaction is already reconciled');
  if (!(Number(line.amount) > 0 || Number(line.amount) < 0)) throw new Error('A bank transaction of 0 cannot be reconciled');
  if (rule.company_id && rule.company_id !== (line.company_id ?? 1)) throw new Error('Reconciliation model belongs to another company');
  const mappings = (rule.line_ids ?? []).filter((l) => l.partner_id && !l.account_id);
  if (mappings.length && mappings.length === (rule.line_ids ?? []).length) {
    if (new Set(mappings.map((l) => l.partner_id)).size !== 1 || !read(db, 'res.partner', mappings[0].partner_id)) throw new Error('Select one valid partner for the mapping');
    return write(db, 'account.bank.statement.line', line.id, { partner_id: mappings[0].partner_id });
  }
  if (isMatchingRule(rule)) {
    const companyCurrency = companyCurrencyRecord(db, line.company_id);
    const target = roundCurrency(line.open_amount ?? statementCompanyAmount(db, line), companyCurrency);
    const residual = (m) => toCompany(db, m.currency_id, m.amount_residual, line.date, m.company_id);
    const ordered = [...candidates(db, line)].sort(byMatchingOrder(rule.matching_order || 'old_first'));
    const exact = ordered.filter((m) => residual(m) === target);
    if (!line.partner_id) {
      if (exact.length) throw new Error('Select the statement partner, then review and confirm a matching invoice');
      return db;
    }
    if (exact.length > 1) {
      const dateOf = (m) => m.invoice_date || m.date || '';
      if (dateOf(exact[0]) === dateOf(exact[1])) {
        throw new Error('Multiple invoices match. Review and select one in "Match with".');
      }
    }
    if (exact.length) return reconcileWith(db, line, exact[0].id);
    const tolerance = Number(rule.payment_tolerance) || 0;
    if (tolerance > 0) {
      const tolType = rule.payment_tolerance_type || 'percentage';
      const match = ordered.find((m) => {
        const res = residual(m);
        const limit = tolType === 'amount' ? tolerance : roundCurrency(res * tolerance / 100, companyCurrency);
        return Math.abs(res - target) <= limit;
      });
      if (match) {
        const res = residual(match);
        if (target < res) {
          const wo = (rule.line_ids ?? []).find((l) => l.account_id);
          if (wo) {
            const diff = roundCurrency(res - target, companyCurrency);
            const signedWo = line.amount >= 0 ? -diff : diff;
            const withWo = write(db, 'account.bank.statement.line', line.id, {
              writeoff_account_id: wo.account_id,
              writeoff_label: wo.label || rule.name || 'Payment Tolerance',
              writeoff_amount: signedWo,
            });
            return reconcileWith(withWo, read(withWo, 'account.bank.statement.line', line.id), match.id);
          }
        }
        const afterRec = reconcileWith(db, line, match.id);
        const updatedLine = read(afterRec, 'account.bank.statement.line', line.id);
        if (target > res && (rule.line_ids ?? []).length && updatedLine.state !== 'reconciled' && (updatedLine.open_amount ?? 0) > 0) {
          return writeOff(afterRec, rule, updatedLine);
        }
        return afterRec;
      }
    }
    return db;
  }
  return writeOff(db, rule, line);
}

const activeRules = (db) => search(db, 'account.reconcile.model').filter((r) => r.active !== false).sort(bySequence);

/**
 * Reconcile every 'to_check' line with the first matching auto-validated active rule (by sequence).
 * Runs unattended on the server, so regex rules (user patterns could backtrack for ages) are left to manual use,
 * and a line that fails (locked period, bad rule) is skipped rather than stopping the run. A rule that already
 * allocated part of a line left the rest for another match, so it is not applied to that line again; other
 * rules and manual matching remain available for the remainder.
 */
export function autoReconcile(db) {
  const rules = activeRules(db).filter((r) => isAutoRule(r) && r.match_label !== 'match_regex');
  return search(db, 'account.bank.statement.line').filter((l) => l.state === 'to_check').reduce((acc, l) => {
    const line = read(acc, 'account.bank.statement.line', l.id);
    const rule = rules.find((r) => ruleMatches(r, line) && !(line.allocations ?? []).some((a) => a.reconcile_model_id === r.id));
    if (!rule) return acc;
    try {
      return applyRule(acc, rule, line);
    } catch {
      return acc;
    }
  }, db);
}

/** The first active matching rule (by sequence), or null. */
export function suggestRule(db, line) {
  return activeRules(db).find((r) => ruleMatches(r, line)) ?? null;
}

function guardReconcileModel(db, _before, rule) {
  if (['greater', 'between'].includes(rule.match_amount) && isBlank(rule.match_amount_min)) {
    return 'Minimum amount is required for the selected amount condition';
  }
  if (rule.match_amount === 'between' && isBlank(rule.match_amount_max)) {
    return 'Maximum amount is required when matching between two amounts';
  }
  if (rule.match_label) {
    if (isBlank(rule.match_label_param)) return 'Label parameter is required for the selected label condition';
    if (rule.match_label === 'match_regex' && !compileRegex(rule.match_label_param)) {
      return 'Invalid regular expression in label parameter';
    }
  }
  if (rule.payment_tolerance != null && Number(rule.payment_tolerance) < 0) {
    return 'Payment tolerance cannot be negative';
  }
  for (const line of rule.line_ids ?? []) {
    if (!line.account_id && !line.partner_id && !line.account_code) {
      return 'Each counterpart item requires an account unless a partner is set';
    }
    if (line.account_id) {
      const account = read(db, 'account.account', line.account_id);
      if (!account || account.active === false || (account.company_id && account.company_id !== (rule.company_id ?? 1))) {
        return 'Reconciliation accounts must be active and belong to the model company';
      }
    }
    const isPartnerMappingOnly = !line.account_id && !line.account_code && Boolean(line.partner_id) && line.amount_string == null && line.amount == null;
    if (isPartnerMappingOnly) continue;
    const type = line.amount_type || 'percentage';
    if (type === 'regex') {
      if (!compileRegex(line.amount_string)) return 'Invalid regular expression in counterpart line amount';
      continue;
    }
    const raw = line.amount_string != null ? line.amount_string : (line.amount != null ? String(line.amount) : '');
    const numeric = parseStrictNumber(raw);
    if (!Number.isFinite(numeric)) return 'Counterpart line amount must be numeric';
    if ((type === 'percentage' || type === 'percentage_st_line') && (numeric < 0 || numeric > 100)) {
      return 'Percentage amount must be between 0 and 100';
    }
  }
  return null;
}

export const reconcileModels = {
  'account.reconcile.model': {
    label: 'Reconciliation Models',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company' },
      sequence: { type: 'integer', label: 'Sequence', widget: 'handle' },
      trigger: {
        type: 'selection',
        label: 'Trigger',
        help: 'Validate the transaction automatically (reconciliation based on your rule).',
        options: [['manual', 'Manual'], ['auto_reconcile', 'Automated']],
      },
      rule_type: {
        type: 'selection',
        label: 'Type',
        readonly: true,
        hidden: true,
        options: [['matching_rule', 'Matching rule'], ['reco_model', 'Reconciliation model']],
      },
      match_journal_ids: {
        type: 'many2many',
        relation: 'account.journal',
        label: 'Journals',
        optional: 'hide',
        help: 'The reconciliation model will only be available from the selected journals.',
        domain: (j, r) => (!r?.company_id || !j.company_id || j.company_id === r.company_id) && isLiquidityJournal(j),
      },
      match_partner_ids: {
        type: 'many2many',
        relation: 'res.partner',
        label: 'Partners',
        help: 'The reconciliation model will only be applied to the selected customers/vendors.',
      },
      match_amount: {
        type: 'selection',
        label: 'Amount Condition',
        options: [['lower', 'Is lower than or equal to'], ['greater', 'Is greater than or equal to'], ['between', 'Is between']],
      },
      match_amount_min: { type: 'monetary', label: 'Amount Min' },
      match_amount_max: { type: 'monetary', label: 'Amount Max' },
      match_label: {
        type: 'selection',
        label: 'Label',
        options: [['contains', 'Contains'], ['not_contains', 'Not Contains'], ['match_regex', 'Match Regex']],
      },
      match_label_param: { type: 'char', label: 'Label Parameter' },
      payment_tolerance: { type: 'float', label: 'Payment Tolerance' },
      payment_tolerance_type: {
        type: 'selection',
        label: 'Payment Tolerance Type',
        options: [['amount', 'In amount'], ['percentage', 'In percentage']],
      },
      matching_order: {
        type: 'selection',
        label: 'Matching Order',
        options: [['new_first', 'Newest first'], ['old_first', 'Oldest first']],
      },
      // Legacy matching fields retained hidden so rules preserving non-default match_nature/match_partner continue working.
      match_nature: { type: 'selection', label: 'Amount Type', hidden: true, options: [['amount_received', 'Received'], ['amount_paid', 'Paid'], ['both', 'Paid/Received']] },
      match_partner: { type: 'boolean', label: 'Partner is Set', hidden: true },
      created_automatically: { type: 'boolean', label: 'Created Automatically', hidden: true },
      line_ids: {
        type: 'one2many',
        label: 'Counterpart Items',
        fields: {
          sequence: { type: 'integer', label: 'Sequence', widget: 'handle' },
          partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
          account_id: { type: 'many2one', relation: 'account.account', label: 'Account' },
          amount_type: {
            type: 'selection',
            label: 'Amount Type',
            options: [
              ['fixed', 'Fixed'],
              ['percentage', 'Percentage of balance'],
              ['percentage_st_line', 'Percentage of transaction'],
              ['regex', 'From label'],
            ],
          },
          amount_string: { type: 'char', label: 'Amount' },
          amount: { type: 'float', label: 'Numeric Amount', hidden: true },
          tax_ids: { type: 'many2many', relation: 'account.tax', label: 'Taxes', optional: 'hide' },
          label: { type: 'char', label: 'Label' },
        },
        newLine: () => ({ sequence: 10, partner_id: null, account_id: null, amount_type: 'percentage', amount_string: '100', amount: 100, tax_ids: [], label: '' }),
        onchange: (line, key) => {
          if (key === 'amount_string' || key === 'amount_type') return syncLineAmount(line);
          if (key === 'amount' && line.amount != null && line.amount_type !== 'regex') {
            return { ...line, amount_string: String(line.amount), amount: Number(line.amount) || 0 };
          }
          return line;
        },
      },
      active: { type: 'boolean', label: 'Active' },
    },
    defaults: () => ({
      sequence: 10,
      trigger: 'manual',
      rule_type: 'reco_model',
      match_journal_ids: [],
      match_partner_ids: [],
      match_amount: null,
      match_label: null,
      payment_tolerance: 0,
      payment_tolerance_type: 'percentage',
      matching_order: 'old_first',
      created_automatically: false,
      active: true,
      line_ids: [],
    }),
    prepareCreate: (db, vals) => ({ db, vals: normalizeReconcileRule(vals) }),
    guard: guardReconcileModel,
    onWrite: (db, after) => {
      const synced = (after.line_ids ?? []).map((l, i) => syncLineAmount(l, i));
      if (JSON.stringify(synced) === JSON.stringify(after.line_ids ?? [])) return db;
      return {
        ...db,
        records: {
          ...db.records,
          'account.reconcile.model': (db.records['account.reconcile.model'] ?? []).map((r) => (r.id === after.id ? { ...r, line_ids: synced } : r)),
        },
      };
    },
    list: ['sequence', 'name', 'trigger', 'match_journal_ids'],
    filters: [
      [
        { id: 'created_by_user', label: 'Created by User', fn: (r) => !r.created_automatically },
        { id: 'created_automatically', label: 'Created Automatically', fn: (r) => Boolean(r.created_automatically) },
      ],
      [
        { id: 'automated', label: 'Automated', fn: (r) => r.trigger === 'auto_reconcile' },
      ],
      [
        { id: 'with_tax', label: 'With tax', fn: (r) => (r.line_ids ?? []).some((l) => (l.tax_ids ?? []).length > 0) },
      ],
    ],
    groupBys: ['match_journal_ids', 'trigger'],
    groupByLabels: { match_journal_ids: 'Journals Availability', trigger: 'Automation' },
    form: {
      title: 'name',
      statusbar: 'trigger',
      statusbarClickable: false,
      buttons: [
        { label: 'Automate', primary: true, when: (r) => r.trigger !== 'auto_reconcile', vals: { trigger: 'auto_reconcile' } },
        { label: 'Set Manual', when: (r) => r.trigger === 'auto_reconcile', vals: { trigger: 'manual' } },
      ],
      groups: (r) => [
        [
          'match_journal_ids',
          'match_partner_ids',
          'sequence',
          'active',
        ],
        [
          'match_amount',
          ...(r?.match_amount === 'greater' || r?.match_amount === 'between' ? ['match_amount_min'] : []),
          ...(r?.match_amount === 'lower' || r?.match_amount === 'between' ? ['match_amount_max'] : []),
          'match_label',
          ...(r?.match_label ? ['match_label_param'] : []),
        ],
        ...(isMatchingRule(r) ? [[
          'matching_order',
          'payment_tolerance',
          'payment_tolerance_type',
        ]] : []),
      ],
      tabs: (r) => (isMatchingRule(r) && !(Number(r?.payment_tolerance) > 0)
        ? []
        : [{ label: 'Counterpart Items', fields: ['line_ids'] }]),
    },
  },
};
