import { create } from '../orm.js';
import { CHART, JOURNALS, isLiquidityJournal } from './ledger.js';
import { defaultCashFlowActivity } from './reports.js';
import { ensurePaymentMethods } from './paymentmethod.js';
import { countryIdFor } from './country.js';

/**
 * Install the chart-of-accounts template (accounts, journals, tax groups, taxes,
 * fiscal positions, and payment terms) on `companyId`.
 * When `legacy` is true, reproduces the exact initial seed data for company 1.
 */
export function installChartTemplate(db, companyId = 1, { legacy = false, includeChart = true, includeTerms = true } = {}) {
  const scopedModels = new Set(['account.account', 'account.journal', 'account.tax', 'account.tax.group', 'account.fiscal.position', 'account.payment.term']);
  const add = (model, vals) => {
    const res = create(db, model, legacy ? vals : { ...vals, ...(scopedModels.has(model) ? { company_id: companyId } : {}) });
    db = res.db;
    return res.id;
  };

  let installedAccountIds = {};
  let installedByCode = {};
  let companyJournals = {};
  let demoBankJournal = null;
  let vatSale = null;
  let vatPurchase = null;

  if (includeChart) {
    const ensureTag = (name, cash_flow_activity) => {
      if (!legacy) {
        const existing = (db.records['account.account.tag'] ?? []).find((tag) => tag.name === name && tag.cash_flow_activity === cash_flow_activity);
        if (existing) return existing.id;
      }
      return add('account.account.tag', { name, cash_flow_activity });
    };
    const cashFlowTags = {
      operating: ensureTag('Operating Activities', 'operating'),
      investing: ensureTag('Investing Activities', 'investing'),
      financing: ensureTag('Financing Activities', 'financing'),
    };
    // The demo chart tags loans payable as financing explicitly; every other account follows its type.
    const chartActivity = { '260000': 'financing' };
    CHART.forEach(([code, name, account_type, key]) => {
      const existing = !legacy && (db.records['account.account'] ?? []).find((a) => a.code === code && a.company_id === companyId);
      const id = existing ? existing.id : add('account.account', {
        code, name, account_type,
        ...(account_type === 'asset_fixed' ? { create_asset: 'draft' } : {}),
        reconcile: ['asset_receivable', 'liability_payable'].includes(account_type),
        tag_ids: [cashFlowTags[chartActivity[code] ?? defaultCashFlowActivity(account_type)]],
      });
      installedByCode[code] = id;
      if (key) installedAccountIds[key] = id;
    });
    db = ensurePaymentMethods(db);
    demoBankJournal = !legacy
      ? ((db.records['account.journal'] ?? []).find((j) => j.company_id === companyId && j.default_for_payments === true)?.id ?? null)
      : null;
    JOURNALS.forEach((journal, idx) => {
      const existing = !legacy && (db.records['account.journal'] ?? []).find((j) => j.code === journal.code && j.company_id === companyId);
      const wantsDefaultPayment = journal.default_for_payments === true;
      const isDefaultPayment = wantsDefaultPayment && (legacy || !demoBankJournal);
      const id = existing ? existing.id : add('account.journal', {
        code: journal.code, name: journal.name, type: journal.type,
        sequence: (idx + 1) * 10, active: true,
        default_account_id: journal.account ? installedByCode[journal.account] : null,
        ...(isLiquidityJournal(journal) ? { company_id: companyId } : {}),
        ...(['bank', 'cash', 'credit'].includes(journal.type) ? { suspense_account_id: installedByCode['101404'] } : {}),
        ...(journal.type === 'cash' ? { profit_account_id: installedByCode['450000'], loss_account_id: installedByCode['690000'] } : {}),
        default_for_payments: isDefaultPayment,
        ...(journal.refund_sequence != null ? { refund_sequence: journal.refund_sequence } : {}),
        ...(journal.payment_sequence != null ? { payment_sequence: journal.payment_sequence } : {}),
        ...(journal.bank_statements_source ? { bank_statements_source: journal.bank_statements_source } : {}),
        ...(journal.sepa_pain_version ? { sepa_pain_version: journal.sepa_pain_version } : {}),
        ...(journal.invoice_reference_type ? { invoice_reference_type: journal.invoice_reference_type } : {}),
        ...(journal.invoice_reference_model ? { invoice_reference_model: journal.invoice_reference_model } : {}),
        ...(journal.invoice_sequence_prefix ? { invoice_sequence_prefix: journal.invoice_sequence_prefix } : {}),
        ...(journal.invoice_sequence_next_number != null ? { invoice_sequence_next_number: journal.invoice_sequence_next_number } : {}),
        ...(journal.refund_sequence_prefix ? { refund_sequence_prefix: journal.refund_sequence_prefix } : {}),
        ...(journal.refund_sequence_next_number != null ? { refund_sequence_next_number: journal.refund_sequence_next_number } : {}),
      });
      if (journal.company_default) companyJournals[journal.company_default] = id;
      if (isDefaultPayment) {
        if (demoBankJournal) throw new Error('Demo setup needs exactly one default payment journal');
        demoBankJournal = id;
      }
    });
    if (!demoBankJournal) throw new Error('Demo setup needs a default payment journal');
    const ensureGroup = (name, sequence) => {
      const existing = !legacy && (db.records['account.tax.group'] ?? []).find((g) => g.name === name && g.company_id === companyId);
      return existing ? existing.id : add('account.tax.group', { name, sequence, company_id: companyId });
    };
    const vatGroupId = ensureGroup('VAT', 10);
    const stampGroupId = ensureGroup('Stamp', 20);
    const tax = (name, type_tax_use, amount, account, vals = {}) => {
      const existing = !legacy && (db.records['account.tax'] ?? []).find((t) => t.name === name && t.type_tax_use === type_tax_use && t.company_id === companyId);
      if (existing) return existing.id;
      const accId = account ? installedByCode[account] : null;
      return add('account.tax', {
        name,
        type_tax_use,
        amount,
        amount_type: 'percent',
        tax_exigibility: 'on_invoice',
        active: true,
        tax_group_id: vatGroupId,
        invoice_repartition_line_ids: [
          { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
          { repartition_type: 'tax', factor_percent: 100, account_id: accId, tag_ids: [] },
        ],
        refund_repartition_line_ids: [
          { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
          { repartition_type: 'tax', factor_percent: 100, account_id: accId, tag_ids: [] },
        ],
        ...vals,
      });
    };
    const ensureFp = (name, vals) => {
      const existing = !legacy && (db.records['account.fiscal.position'] ?? []).find((fp) => fp.name === name && fp.company_id === companyId);
      return existing ? existing.id : add('account.fiscal.position', { name, auto_apply: false, account_ids: [], ...vals });
    };
    ensureFp('Domestic', { country_id: countryIdFor(db, 'EG') });
    const exportFp = ensureFp('Export', { note: 'Export of goods: zero-rated VAT.' });
    vatSale = tax('VAT 14%', 'sale', 14, '251000');
    vatPurchase = tax('VAT 14%', 'purchase', 14, '131000');
    tax('0% Exports', 'sale', 0, null, { fiscal_position_ids: [exportFp], original_tax_ids: [vatSale] });
    tax('0% Imports', 'purchase', 0, null, { fiscal_position_ids: [exportFp], original_tax_ids: [vatPurchase] });
    tax('VAT 14% Included', 'sale', 14, '251000', { price_include: true });
    tax('VAT 14% (Cash Basis)', 'sale', 14, '251000', { tax_exigibility: 'on_payment', cash_basis_transition_account_id: installedByCode['251100'] });
    tax('Stamp Duty', 'sale', 5, '251000', { amount_type: 'fixed', tax_group_id: stampGroupId });
  }

  let t30 = null;
  if (includeTerms) {
    const addTerm = (vals) => {
      if (!legacy) {
        const existing = (db.records['account.payment.term'] ?? []).find((r) => r.name === vals.name && r.company_id === companyId);
        if (existing) return existing.id;
      }
      return add('account.payment.term', vals);
    };
    const line = (value, nb_days, value_type = 'percent', delay_type = 'days_after', extra = {}) => ({ value, value_type, nb_days, delay_type, ...extra });
    addTerm({ name: 'Immediate Payment', sequence: 1, line_ids: [line(100, 0)] });
    t30 = addTerm({ name: '30 Days', sequence: 4, line_ids: [line(100, 30)] });
    addTerm({ name: '30% Now, Balance 60 Days', sequence: 8, line_ids: [line(30, 0), line(70, 60)] });
    addTerm({ name: '2/7 Net 30', sequence: 9, early_discount: true, discount_percent: 2, discount_days: 7, discount_tax_computation: 'included', line_ids: [line(100, 30)] });
    addTerm({ name: '15 Days', sequence: 2, line_ids: [line(100, 15)] });
    addTerm({ name: '21 Days', sequence: 3, line_ids: [line(100, 21)] });
    addTerm({ name: '45 Days', sequence: 5, line_ids: [line(100, 45)] });
    addTerm({ name: 'End of Following Month', sequence: 6, line_ids: [line(100, 0, 'percent', 'days_after_end_of_next_month')] });
    addTerm({ name: '10 Days after End of Next Month', sequence: 7, line_ids: [line(100, 10, 'percent', 'days_after_end_of_next_month')] });
    addTerm({ name: '90 days, on the 10th', sequence: 10, line_ids: [line(100, 90, 'percent', 'days_end_of_month_on_the', { days_next_month: 10 })] });
  }

  return { db, installedAccountIds, installedByCode, companyJournals, demoBankJournal, vatSale, vatPurchase, t30 };
}
