import { create, read, write } from '../orm.js';
import { createCompany } from '../models/company.js';

/** Copy the seeded company's explicit document and general journals into fixtures for a new company. */
export function invoiceJournalDefaults(db, sourceCompanyId = 1) {
  const company = read(db, 'res.company', sourceCompanyId);
  const sales = company?.default_sale_journal_id && read(db, 'account.journal', company.default_sale_journal_id);
  const purchases = company?.default_purchase_journal_id && read(db, 'account.journal', company.default_purchase_journal_id);
  const general = company?.default_general_journal_id && read(db, 'account.journal', company.default_general_journal_id);
  if (!sales || sales.type !== 'sale' || !purchases || purchases.type !== 'purchase' || !general || general.type !== 'general') {
    throw new Error(`Configure default sales, purchase, and general journals on company ${sourceCompanyId} before creating this fixture`);
  }
  return { default_sale_journal_id: sales.id, default_purchase_journal_id: purchases.id, default_general_journal_id: general.id };
}

/** Give a fixture company its own default payment journal, copied from company 1's default bank journal. */
export function withDefaultBankJournal(db, companyId) {
  const source = db.records['account.journal'].find((j) => j.company_id === 1 && j.default_for_payments === true);
  if (!source) throw new Error('Configure a default payment journal on company 1 before creating this fixture');
  const { id: _id, ...vals } = source;
  return create(db, 'account.journal', { ...vals, code: `BNK${companyId}`, company_id: companyId }).db;
}

/** A fixture company with the explicitly configured sales and purchase journals copied from company 1 and its own bank journal. */
export function createCompanyWithDefaultInvoiceJournals(db, vals) {
  const made = createCompany(db, { ...invoiceJournalDefaults(db), ...vals });
  return { ...made, db: withDefaultBankJournal(made.db, made.id) };
}

/** A second company with its own copies of selected accounts and journals. */
export function accountingCompany(db) {
  const branch = createCompany(db, { name: 'Accounting branch', currency_id: db.records['res.company'][0].currency_id });
  let next = branch.db;
  const accountIds = {};
  for (const code of ['101401', '121000', '211000', '131000', '230100', '450000', '600000']) {
    const existing = next.records['account.account'].find((a) => a.code === code && a.company_id === branch.id);
    if (existing) { accountIds[code] = existing.id; continue; }
    const original = next.records['account.account'].find((a) => a.code === code);
    const copied = create(next, 'account.account', { ...original, company_id: branch.id });
    next = copied.db;
    accountIds[code] = copied.id;
  }
  let bankJournalId;
  let generalJournalId;
  for (const code of ['BNK1', 'MISC']) {
    const original = next.records['account.journal'].find((j) => j.code === code);
    const copied = create(next, 'account.journal', { ...original, company_id: branch.id,
      ...(code === 'BNK1' ? { default_account_id: accountIds['101401'] } : {}) });
    next = copied.db;
    if (code === 'BNK1') bankJournalId = copied.id;
    else generalJournalId = copied.id;
  }
  const purchase = create(next, 'account.journal', { name: 'Branch expense journal', code: 'EXP2', type: 'purchase', company_id: branch.id, default_account_id: accountIds['600000'] });
  const sourceTax = read(purchase.db, 'account.tax', read(purchase.db, 'res.company', 1).account_purchase_tax_id);
  const sourceGroup = read(purchase.db, 'account.tax.group', sourceTax.tax_group_id);
  const group = create(purchase.db, 'account.tax.group', { ...sourceGroup, id: undefined, company_id: branch.id });
  const tax = create(group.db, 'account.tax', { ...sourceTax, company_id: branch.id, tax_group_id: group.id, ...Object.fromEntries(['invoice_repartition_line_ids', 'refund_repartition_line_ids'].map((key) => [key, (sourceTax[key] ?? []).map((l) => (l.repartition_type === 'tax' ? { ...l, account_id: accountIds['131000'] } : l))])) });
  next = write(tax.db, 'res.company', branch.id, { account_default_receivable_id: accountIds['121000'], account_default_payable_id: accountIds['211000'], default_purchase_journal_id: purchase.id, default_general_journal_id: generalJournalId, account_purchase_tax_id: tax.id });
  next = write(next, 'account.journal', bankJournalId, { default_for_payments: true });
  return { db: next, id: branch.id };
}

export function assertEntryCompany(assert, db, entry, companyId) {
  assert.equal(entry.company_id, companyId);
  assert.equal(read(db, 'account.journal', entry.journal_id).company_id, companyId);
  for (const line of entry.line_ids) assert.equal(read(db, 'account.account', line.account_id).company_id, companyId);
}

/** Give a fixture company its own VAT accounts and default sales and purchase taxes, which plain-rate lines post to. */
export function withDefaultVat(db, companyId, rate = 14) {
  const madeGroup = create(db, 'account.tax.group', { name: 'VAT', company_id: companyId });
  let next = madeGroup.db;
  const tax = (type_tax_use, account_type, name) => {
    const account = create(next, 'account.account', { name, code: `VAT-${type_tax_use}-${companyId}`, account_type, company_id: companyId });
    const rows = [{ repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] }, { repartition_type: 'tax', factor_percent: 100, account_id: account.id, tag_ids: [] }];
    const made = create(account.db, 'account.tax', { name: `${name} ${rate}%`, company_id: companyId, type_tax_use, amount: rate, amount_type: 'percent', tax_exigibility: 'on_invoice', active: true, tax_group_id: madeGroup.id, invoice_repartition_line_ids: rows, refund_repartition_line_ids: rows });
    next = made.db;
    return made.id;
  };
  const sale = tax('sale', 'liability_current', 'Output VAT');
  const purchase = tax('purchase', 'asset_current', 'Input VAT');
  return write(next, 'res.company', companyId, { account_sale_tax_id: sale, account_purchase_tax_id: purchase });
}
