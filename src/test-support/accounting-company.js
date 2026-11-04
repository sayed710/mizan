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

/** A fixture company with the explicitly configured sales and purchase journals copied from company 1. */
export function createCompanyWithDefaultInvoiceJournals(db, vals) {
  return createCompany(db, { ...invoiceJournalDefaults(db), ...vals });
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
  for (const code of ['BNK1', 'MISC']) {
    const original = next.records['account.journal'].find((j) => j.code === code);
    const copied = create(next, 'account.journal', { ...original, company_id: branch.id,
      ...(code === 'BNK1' ? { default_account_id: accountIds['101401'] } : {}) });
    next = copied.db;
    if (code === 'BNK1') bankJournalId = copied.id;
  }
  next = write(next, 'res.company', branch.id, { account_default_receivable_id: accountIds['121000'], account_default_payable_id: accountIds['211000'] });
  next = write(next, 'account.journal', bankJournalId, { default_for_payments: true });
  return { db: next, id: branch.id };
}

export function assertEntryCompany(assert, db, entry, companyId) {
  assert.equal(entry.company_id, companyId);
  assert.equal(read(db, 'account.journal', entry.journal_id).company_id, companyId);
  for (const line of entry.line_ids) assert.equal(read(db, 'account.account', line.account_id).company_id, companyId);
}
