import { create, read } from '../orm.js';
import { createCompany } from '../models/company.js';

/** A second company with its own copies of selected accounts and journals. */
export function accountingCompany(db) {
  const branch = createCompany(db, { name: 'Accounting branch', currency_id: db.records['res.company'][0].currency_id });
  let next = branch.db;
  for (const code of ['101401', '121000', '211000', '131000', '230100', '450000', '600000']) {
    const original = next.records['account.account'].find((a) => a.code === code);
    next = create(next, 'account.account', { ...original, company_id: branch.id }).db;
  }
  for (const code of ['BNK1', 'MISC']) {
    const original = next.records['account.journal'].find((j) => j.code === code);
    next = create(next, 'account.journal', { ...original, company_id: branch.id }).db;
  }
  return { db: next, id: branch.id };
}

export function assertEntryCompany(assert, db, entry, companyId) {
  assert.equal(entry.company_id, companyId);
  assert.equal(read(db, 'account.journal', entry.journal_id).company_id, companyId);
  for (const line of entry.line_ids) assert.equal(read(db, 'account.account', line.account_id).company_id, companyId);
}
