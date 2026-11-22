import { companyViewDb } from '../companyView.js';
import { t } from '../i18n.js';
import { currentCompany } from '../models/company.js';
import { findCompanyCurrencyRecord } from '../money.js';
import { companiesOf } from '../store.js';
import { money, unconfiguredMoney } from '../ui.jsx';

/** Resolve allowed companies, scoped view database, and normalized company selector value for report views. */
export function reportCompanyScope(sourceDb, companyId, { allowAll = true } = {}) {
  const allowed = sourceDb.settings?.allowed_company_ids ?? [currentCompany(sourceDb)];
  const allowedSet = new Set(allowed);
  const companyDb = companyViewDb(sourceDb);
  const availableCompanies = companiesOf(sourceDb);
  const companies = availableCompanies.filter((company) => allowedSet.has(company.id));
  const selectedCompany = !allowAll && (companyId === 'all' || !allowedSet.has(Number(companyId)))
    ? String(currentCompany(sourceDb))
    : (companyId === 'all' || allowedSet.has(Number(companyId)) ? companyId : 'all');
  return { companyDb, availableCompanies, companies, selectedCompany };
}

/** Return a money formatter bound to the selected (or active) company's currency. */
export function reportMoney(db, companyId = null) {
  const targetId = companyId && companyId !== 'all' ? Number(companyId) : currentCompany(db);
  const currency = findCompanyCurrencyRecord(db, targetId);
  if (currency) return (amount) => money(amount, currency.name ?? null, currency);
  return (db?.records?.['res.company'] ?? []).some((c) => c.id === targetId) ? unconfiguredMoney : money;
}

/** Shared company filter dropdown for multi-company accounting reports. */
export function CompanySelect({ companies, value, onChange, allowAll = true }) {
  return (
    <label className="inline-select">
      {t('Company')}
      <select aria-label={t('Company')} value={value} onChange={(e) => onChange(e.target.value)}>
        {allowAll && <option value="all">{t('All Companies')}</option>}
        {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </label>
  );
}
