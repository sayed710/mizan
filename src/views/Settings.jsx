import { useEffect, useState } from 'react';
import { updateSettings, write } from '../orm.js';
import { companiesOf, currentCompany, addUser, commit, createKey, getDb, getUser, isServer, listKeys, listUsers, logout, resetDemo, restoreBackup, revokeKey, changePassword, revokeOtherSessions, revokeUser, useDb } from '../store.js';
import { lang, setLang, setTheme, t, theme } from '../i18n.js';
import { CURRENCIES } from '../ui.jsx';
import { createCompany, ensureCurrencyRecord, renameCompany, setCompanyCurrency } from '../models/company.js';
import { models } from '../models/index.js';
import { migrate } from '../migrations.js';
import { appOpen } from '../access.js';

const isDb = (x) => x && typeof x === 'object' && x.records && typeof x.records === 'object' && x.seq && Array.isArray(x.messages);

function Users() {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ login: '', name: '', password: '', apps: '', companies: '' });
  const [error, setError] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const refresh = () => listUsers().then(setUsers);
  useEffect(() => { refresh(); }, []);
  const submit = async (e) => {
    e.preventDefault();
    try {
      await addUser(form);
      setForm({ login: '', name: '', password: '', apps: '', companies: '' });
      setError(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    }
  };
  const revokeAccess = async (e) => {
    e.preventDefault();
    try {
      await revokeUser(revoking.id, revoking.password);
      setError(null);
      if (revoking.id === getUser()?.id) return logout(); // the admin's own session is gone: leave no data on screen
      setRevoking(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    }
  };
  const input = (key, extra = {}) => (
    <input aria-label={t(extra.label)} placeholder={t(extra.label)} required value={form[key]} type={extra.type ?? 'text'}
      autoComplete="off" onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
  );
  return (
    <>
      <h3>{t('Users')}</h3>
      <table className="list">
        <tbody>
          {users.map((u) => <tr key={u.id}><td>{u.name}</td><td>{u.login}</td><td>{u.isAdmin ? t('Administrator') : ''}</td><td className="muted">{u.apps || t('All apps')}</td><td className="muted">{u.companies || t('All companies')}</td>
            <td>{revoking?.id === u.id
              ? <form className="row" onSubmit={revokeAccess}>
                <input aria-label={t('New Password')} placeholder={t('New password (leave empty to keep it)')} type="password" minLength={8} autoComplete="new-password" autoFocus
                  value={revoking.password} onChange={(e) => setRevoking({ ...revoking, password: e.target.value })} />
                <button className="btn danger">{t('Revoke Access')}</button>
              </form>
              : <button type="button" className="link danger" onClick={() => setRevoking({ id: u.id, password: '' })}>{t('Revoke Access')}</button>}</td></tr>)}
        </tbody>
      </table>
      <form className="row user-form" onSubmit={submit}>
        {input('name', { label: 'Name' })}
        {input('login', { label: 'Login' })}
        {input('password', { label: 'Password', type: 'password' })}
        <input aria-label={t('Allowed apps')} placeholder={t('Allowed apps (e.g. crm,sales) — empty = all')} value={form.apps} onChange={(e) => setForm({ ...form, apps: e.target.value })} />
        <input aria-label={t('Allowed companies')} placeholder={t('Allowed company ids (e.g. 1,2) — empty = all')} value={form.companies} onChange={(e) => setForm({ ...form, companies: e.target.value })} />
        <button type="submit" className="btn primary">{t('Add user')}</button>
      </form>
      {error && <div className="alert" role="alert">{error}</div>}
    </>
  );
}

function Companies({ db }) {
  const list = companiesOf(db);
  const mainCurrency = list.find((c) => c.id === 1)?.currency ?? list[0]?.currency ?? CURRENCIES[0];
  const [newCurrency, setNewCurrency] = useState(mainCurrency);
  const [newName, setNewName] = useState('');
  useEffect(() => {
    if (mainCurrency) setNewCurrency(mainCurrency);
  }, [mainCurrency]);
  const add = (e) => {
    e?.preventDefault?.();
    const name = newName.trim() || prompt(t('Company Name'))?.trim();
    if (!name) return;
    const current = getDb();
    const currency = newCurrency || mainCurrency;
    if (current.records['res.company']?.length) {
      const curRec = currency ? ensureCurrencyRecord(current, currency) : null;
      const dbWithCurr = curRec ? curRec.db : current;
      const currencyId = curRec?.id ?? null;
      const created = createCompany(dbWithCurr, { name, ...(currencyId ? { currency_id: currencyId } : {}) });
      commit(created.db);
      setNewName('');
      return;
    }
    const next = [...list, { id: Math.max(...list.map((c) => c.id), 0) + 1, name, currency }];
    commit(updateSettings(current, { companies: next }));
    setNewName('');
  };
  const setCurrencyOf = (id, currency) => commit(getDb().records['res.company']?.length ? setCompanyCurrency(getDb(), id, currency)
    : updateSettings(getDb(), { companies: list.map((c) => (c.id === id ? { ...c, currency } : c)) }));
  return (
    <>
      <h3>{t('Companies')}</h3>
      <table className="list">
        <tbody>
          {list.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>
                <select aria-label={t('Currency')} value={c.currency} onChange={(e) => setCurrencyOf(c.id, e.target.value)}>
                  {CURRENCIES.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="row user-form" onSubmit={add}>
        <input aria-label={t('Company Name')} placeholder={t('Company Name')} value={newName} onChange={(e) => setNewName(e.target.value)} />
        <select aria-label={t('Currency')} value={newCurrency} onChange={(e) => setNewCurrency(e.target.value)}>
          {CURRENCIES.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <button type="submit" className="btn">{t('Add Company')}</button>
      </form>
    </>
  );
}

function Security() {
  const [form, setForm] = useState({ current: '', password: '' });
  const [status, setStatus] = useState(null);
  const run = async (action, done) => {
    try {
      await action();
      setStatus({ ok: true, text: t(done) });
      return true;
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : 'Error' });
      return false;
    }
  };
  const submit = async (e) => {
    e.preventDefault();
    if (await run(() => changePassword(form.current, form.password), 'Password changed; other sessions were signed out')) setForm({ current: '', password: '' });
  };
  return (
    <>
      <h3>{t('Password & Sessions')}</h3>
      <form className="row user-form" onSubmit={submit}>
        <input aria-label={t('Current Password')} placeholder={t('Current Password')} type="password" required autoComplete="current-password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} />
        <input aria-label={t('New Password')} placeholder={t('New Password')} type="password" required minLength={8} autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <button className="btn">{t('Change Password')}</button>
      </form>
      <button type="button" className="btn" onClick={() => run(revokeOtherSessions, 'Other sessions were signed out')}>{t('Sign Out Other Sessions')}</button>
      {status && <div className={`alert ${status.ok ? 'info-box' : ''}`} role={status.ok ? 'status' : 'alert'}>{status.text}</div>}
    </>
  );
}

function ApiKeys() {
  const [keys, setKeys] = useState([]);
  const [fresh, setFresh] = useState(null);
  const refresh = () => listKeys().then(setKeys);
  useEffect(() => { refresh(); }, []);
  const add = async () => {
    const name = prompt(t('Key name'), 'Integration');
    if (!name) return;
    setFresh(await createKey(name));
    refresh();
  };
  return (
    <>
      <h3>{t('API Keys')}</h3>
      <p className="muted">{t('Use with')} <code>Authorization: Bearer &lt;key&gt;</code> {t('on')} <code>/api/v1/&lt;model&gt;</code></p>
      <ul>{keys.map((k) => <li key={k.created}>{k.name} · {new Date(k.created).toLocaleDateString()} <button type="button" className="link danger" onClick={() => revokeKey(k.created).then(refresh)}>{t('Revoke')}</button></li>)}</ul>
      {fresh && <div className="alert info-box" role="status">{t('Copy this key now, it will not be shown again')}: <code>{fresh}</code></div>}
      <button type="button" className="btn" onClick={add}>{t('New API Key')}</button>
    </>
  );
}

const ACCOUNTING_LOCK_FIELDS = [
  ['lock_date', 'Lock Date', 'Prevent creating, editing or deleting accounting entries on or before this date.'],
  ['sale_lock_date', 'Sales Lock Date', 'Prevent creating or modifying customer invoices and credit notes on or before this date.'],
  ['purchase_lock_date', 'Purchase Lock Date', 'Prevent creating or modifying vendor bills and refunds on or before this date.'],
  ['tax_lock_date', 'Tax Return Lock Date', 'Lock tax-impacting entries up to the submitted tax return period.'],
];

function SettingRow({ id, label, description, children }) {
  return (
    <div className="field" data-setting={id}>
      <label htmlFor={id}>{t(label)}</label>
      <div className="field-value">
        {children}
        {description && <p className="muted setting-desc">{t(description)}</p>}
      </div>
    </div>
  );
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate company accounting setting values before passing them to ORM write. */
function validateCompanySettingWrite(db, company, vals) {
  for (const [field, use, label] of [['account_sale_tax_id', 'sale', 'Default Sales Tax'], ['account_purchase_tax_id', 'purchase', 'Default Purchase Tax']]) {
    if (vals[field] === undefined || vals[field] === null) continue;
    const tax = (db.records['account.tax'] ?? []).find((x) => x.id === vals[field]);
    if (!tax || tax.active === false || tax.type_tax_use !== use || (tax.company_id && tax.company_id !== company.id)) {
      return `${label} must be an active ${use} tax shared with or belonging to this company`;
    }
  }
  if (vals.tax_calculation_rounding_method !== undefined && !['round_per_line', 'round_globally'].includes(vals.tax_calculation_rounding_method)) {
    return 'Select a valid tax rounding method';
  }
  if (vals.tax_periodicity !== undefined && !['monthly', 'trimester', 'semester', 'year'].includes(vals.tax_periodicity)) {
    return 'Select a valid tax periodicity';
  }
  if (vals.invoice_qr !== undefined && vals.invoice_qr !== null && !['zatca', 'epc'].includes(vals.invoice_qr)) {
    return 'Select a valid payment QR format';
  }
  for (const field of ['deferred_revenue_journal_id', 'deferred_expense_journal_id']) {
    if (vals[field] === undefined || vals[field] === null) continue;
    const journal = (db.records['account.journal'] ?? []).find((x) => x.id === vals[field]);
    if (!journal || journal.active === false || journal.type !== 'general' || (journal.company_id && journal.company_id !== company.id)) {
      return 'Select an active general journal belonging to this company';
    }
  }
  for (const field of ['deferred_revenue_account_id', 'deferred_expense_account_id']) {
    if (vals[field] === undefined || vals[field] === null) continue;
    const account = (db.records['account.account'] ?? []).find((x) => x.id === vals[field]);
    if (!account || account.active === false || (account.company_id && account.company_id !== company.id)) {
      return 'Select an active deferred account belonging to this company';
    }
  }
  for (const field of ['generate_deferred_revenue_entries_method', 'generate_deferred_expense_entries_method']) {
    if (vals[field] !== undefined && vals[field] !== null && !['on_validation', 'manual'].includes(vals[field])) {
      return 'Select a valid deferred entry generation method';
    }
  }
  for (const field of ['deferred_revenue_amount_computation_method', 'deferred_expense_amount_computation_method']) {
    if (vals[field] !== undefined && vals[field] !== null && !['day', 'month', 'full_months'].includes(vals[field])) {
      return 'Select a valid deferred amount computation method';
    }
  }
  for (const field of ['deferred_revenue_periodicity', 'deferred_expense_periodicity']) {
    if (vals[field] !== undefined && vals[field] !== null && !['month', 'year'].includes(vals[field])) {
      return 'Select a valid deferred periodicity';
    }
  }
  for (const dateField of ['tax_start_date', 'lock_date', 'sale_lock_date', 'purchase_lock_date', 'tax_lock_date', 'hard_lock_date']) {
    if (vals[dateField] !== undefined && vals[dateField] !== null && !DATE_RE.test(vals[dateField])) {
      return 'Enter a valid date';
    }
  }
  return null;
}

/** Odoo-ordered Accounting settings blocks editing active res.company fields via the ORM write path. */
function AccountingSection({ db, company, readOnly, onWriteCompany }) {
  const fields = models['res.company']?.fields ?? {};
  const hasField = (name) => Boolean(fields[name]);
  const taxesByUse = (use) => (db.records['account.tax'] ?? [])
    .filter((tax) => tax.active !== false && tax.type_tax_use === use && (!tax.company_id || !company || tax.company_id === company.id));
  const showTaxes = ['account_sale_tax_id', 'account_purchase_tax_id', 'tax_calculation_rounding_method', 'tax_periodicity', 'tax_start_date', 'vat'].some(hasField);
  const showCurrencies = hasField('currency_id') || !company;
  const showCustomerPayments = hasField('invoice_qr') || hasField('company_iban');
  const showVendorBills = hasField('three_way_matching');
  const showFiscalPeriods = ['lock_date', 'sale_lock_date', 'purchase_lock_date', 'tax_lock_date', 'hard_lock_date', 'audit_trail'].some(hasField);
  const roundingOptions = fields.tax_calculation_rounding_method?.options ?? [['round_per_line', 'Round per Line'], ['round_globally', 'Round Globally']];
  const periodicityOptions = fields.tax_periodicity?.options ?? [['monthly', 'Monthly'], ['trimester', 'Trimester'], ['semester', 'Semester'], ['year', 'Year']];
  const generalJournals = (db.records['account.journal'] ?? [])
    .filter((j) => j.active !== false && j.type === 'general' && (!j.company_id || !company || j.company_id === company.id));
  const companyAccounts = (db.records['account.account'] ?? [])
    .filter((a) => a.active !== false && (!a.company_id || !company || a.company_id === company.id));
  const deferredBlocks = [
    {
      block: 'deferred_revenues',
      title: 'Deferred Revenues',
      journalField: 'deferred_revenue_journal_id',
      journalLabel: 'Deferred Revenue Journal',
      journalDesc: 'Journal used for deferred revenue recognition entries.',
      accountField: 'deferred_revenue_account_id',
      accountLabel: 'Deferred Revenue Account',
      accountDesc: 'Default account where deferred revenues are booked until recognition.',
      generateField: 'generate_deferred_revenue_entries_method',
      generateDesc: 'Choose whether deferred revenue entries are generated on invoice validation or manually in grouped batches.',
      computationField: 'deferred_revenue_amount_computation_method',
      computationDesc: 'Choose how deferred revenue amounts are prorated across recognition periods.',
      periodicityField: 'deferred_revenue_periodicity',
      periodicityDesc: 'Periodicity used for deferred revenue boards and grouped entry generation.',
    },
    {
      block: 'deferred_expenses',
      title: 'Deferred Expenses',
      journalField: 'deferred_expense_journal_id',
      journalLabel: 'Deferred Expense Journal',
      journalDesc: 'Journal used for deferred expense recognition entries.',
      accountField: 'deferred_expense_account_id',
      accountLabel: 'Deferred Expense Account',
      accountDesc: 'Default account where prepaid expenses are booked until recognition.',
      generateField: 'generate_deferred_expense_entries_method',
      generateDesc: 'Choose whether deferred expense entries are generated on bill validation or manually in grouped batches.',
      computationField: 'deferred_expense_amount_computation_method',
      computationDesc: 'Choose how deferred expense amounts are prorated across recognition periods.',
      periodicityField: 'deferred_expense_periodicity',
      periodicityDesc: 'Periodicity used for deferred expense boards and grouped entry generation.',
    },
  ];

  return (
    <section className="settings-accounting" aria-label={t('Accounting')}>
      <h2>{t('Accounting')}</h2>

      {showTaxes && (
        <div className="settings-block" data-block="taxes">
          <h3>{t('Taxes')}</h3>
          {[['account_sale_tax_id', 'Default Sales Tax', 'sale', 'Default tax applied automatically to new customer invoice and sales order lines.'],
            ['account_purchase_tax_id', 'Default Purchase Tax', 'purchase', 'Default tax applied automatically to new vendor bill and purchase order lines.']]
            .filter(([key]) => hasField(key))
            .map(([key, label, use, desc]) => (
              <SettingRow key={key} id={key} label={label} description={desc}>
                <select id={key} disabled={readOnly || !company} value={company?.[key] ?? ''} onChange={(e) => onWriteCompany({ [key]: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">{t('None')}</option>
                  {taxesByUse(use).map((tax) => <option key={tax.id} value={tax.id}>{tax.name}</option>)}
                </select>
              </SettingRow>
            ))}
          {hasField('tax_calculation_rounding_method') && (
            <SettingRow id="tax_calculation_rounding_method" label="Rounding Method" description="Round tax amounts per invoice line or globally per tax group on the document.">
              <select id="tax_calculation_rounding_method" disabled={readOnly || !company} value={company?.tax_calculation_rounding_method ?? 'round_per_line'}
                onChange={(e) => onWriteCompany({ tax_calculation_rounding_method: e.target.value })}>
                {roundingOptions.map(([val, label]) => <option key={val} value={val}>{t(label)}</option>)}
              </select>
            </SettingRow>
          )}
          {hasField('tax_periodicity') && (
            <SettingRow id="tax_periodicity" label="Tax Periodicity" description="How often periodic tax returns are generated for the company.">
              <select id="tax_periodicity" disabled={readOnly || !company} value={company?.tax_periodicity ?? 'monthly'}
                onChange={(e) => onWriteCompany({ tax_periodicity: e.target.value })}>
                {periodicityOptions.map(([val, label]) => <option key={val} value={val}>{t(label)}</option>)}
              </select>
            </SettingRow>
          )}
          {hasField('tax_start_date') && (
            <SettingRow id="tax_start_date" label="Tax Period Start" description="First date from which periodic tax return periods are scheduled.">
              <input id="tax_start_date" type="date" disabled={readOnly || !company} value={company?.tax_start_date ?? ''}
                onChange={(e) => onWriteCompany({ tax_start_date: e.target.value || null })} />
            </SettingRow>
          )}
          {hasField('vat') && (
            <SettingRow id="company_vat" label="Company Tax ID" description="Company VAT registration number printed on invoices, tax reports and ZATCA QR codes.">
              <input id="company_vat" disabled={readOnly || !company} value={company?.vat ?? ''}
                onChange={(e) => onWriteCompany({ vat: e.target.value })} />
            </SettingRow>
          )}
        </div>
      )}

      {showCurrencies && (
        <div className="settings-block" data-block="currencies">
          <h3>{t('Currencies')}</h3>
          <SettingRow id="currency" label="Main Currency" description="The company currency is part of its accounting: amounts are not converted, so it is set on the company record before posting.">
            {company
              ? <span id="currency" className="readonly">{currentCompany(db).currency}</span>
              : (
                <select id="currency" disabled={readOnly} value={currentCompany(db).currency ?? CURRENCIES[0]} onChange={(e) => {
                  const currency = e.target.value;
                  const curId = db.settings?.current_company_id ?? 1;
                  const companies = (db.settings?.companies ?? []).map((c) => (c.id === curId ? { ...c, currency } : c));
                  commit(updateSettings(getDb(), { currency, ...(db.settings?.companies?.length ? { companies } : {}) }));
                }}>
                  {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              )}
            <p className="muted setting-links">
              {appOpen(db, getUser(), 'accounting') ? <a href="#/accounting/currencies">{t('Currencies')}</a> : <span>{t('Currencies')}</span>}
              {company && <> {' · '} <a href={`#/open/res.company/${company.id}`}>{t('Open the company')}</a></>}
            </p>
          </SettingRow>
        </div>
      )}

      {showCustomerPayments && (
        <div className="settings-block" data-block="customer_payments">
          <h3>{t('Customer Payments')}</h3>
          {hasField('invoice_qr') && (
            <SettingRow id="invoice_qr" label="Payment QR Codes" description="Add a scannable payment QR code to printed customer invoices.">
              <select id="invoice_qr" disabled={readOnly || !company} value={company?.invoice_qr ?? ''} onChange={(e) => onWriteCompany({ invoice_qr: e.target.value || null })}>
                <option value="">{t('None')}</option>
                <option value="zatca">{t('ZATCA phase 1 QR (Saudi)')}</option>
                <option value="epc">{t('SEPA Credit Transfer (EPC)')}</option>
              </select>
              {company?.invoice_qr === 'zatca' && <p className="muted">{t('Prints the phase 1 QR only. ZATCA phase 2 (XML, cryptographic stamp, clearance) and Egypt or UAE e-invoicing are not supported yet.')}</p>}
            </SettingRow>
          )}
          {hasField('company_iban') && (
            <SettingRow id="company_iban" label="Bank Account (IBAN)" description="Company IBAN encoded into SEPA (EPC) payment QR codes on customer invoices.">
              <input id="company_iban" disabled={readOnly || !company} value={company?.company_iban ?? ''}
                onChange={(e) => onWriteCompany({ company_iban: e.target.value })} />
            </SettingRow>
          )}
        </div>
      )}

      {showVendorBills && (
        <div className="settings-block" data-block="vendor_bills">
          <h3>{t('Vendor Bills')}</h3>
          {hasField('three_way_matching') && (
            <SettingRow id="three_way_matching" label="Three-Way Matching" description="Verify that vendor bill quantities match the purchase order and receipt before marking bills ready to pay.">
              <input id="three_way_matching" type="checkbox" checked={!!company?.three_way_matching} disabled={readOnly || !company}
                onChange={(e) => onWriteCompany({ three_way_matching: e.target.checked })} />
            </SettingRow>
          )}
        </div>
      )}

      {showFiscalPeriods && (
        <div className="settings-block" data-block="fiscal_periods">
          <h3>{t('Fiscal Periods')}</h3>
          {ACCOUNTING_LOCK_FIELDS.filter(([key]) => hasField(key)).map(([key, label, desc]) => (
            <SettingRow key={key} id={key} label={label} description={desc}>
              <input id={key} type="date" disabled={readOnly || !company} value={company?.[key] ?? ''}
                onChange={(e) => onWriteCompany({ [key]: e.target.value || null })} />
            </SettingRow>
          ))}
          {hasField('hard_lock_date') && (
            <SettingRow id="hard_lock_date" label="Hard Lock Date" description="Permanent closing date that cannot be moved back or removed once set.">
              <input id="hard_lock_date" type="date" disabled={readOnly || !company} min={company?.hard_lock_date ?? undefined} value={company?.hard_lock_date ?? ''}
                onChange={(e) => company && e.target.value && e.target.value > (company.hard_lock_date ?? '') && confirm(t('The hard lock date cannot be moved back or removed. Continue?')) && onWriteCompany({ hard_lock_date: e.target.value })} />
            </SettingRow>
          )}
          {hasField('audit_trail') && (
            <SettingRow id="audit_trail" label="Restrictive Audit Trail" description="Prevent altering posted entries, logs and sequences once permanently enabled.">
              <input id="audit_trail" type="checkbox" checked={!!company?.audit_trail} disabled={readOnly || !company || !!company?.audit_trail}
                onChange={(e) => company && e.target.checked && confirm(t('The audit trail cannot be disabled once enabled. Continue?')) && onWriteCompany({ audit_trail: true })} />
            </SettingRow>
          )}
        </div>
      )}

      {deferredBlocks.map((cfg) => {
        const showBlock = [cfg.journalField, cfg.accountField, cfg.generateField, cfg.computationField, cfg.periodicityField].some(hasField);
        if (!showBlock) return null;
        const generateOptions = fields[cfg.generateField]?.options ?? [];
        const computationOptions = fields[cfg.computationField]?.options ?? [];
        const deferredPeriodicityOptions = fields[cfg.periodicityField]?.options ?? [];
        return (
          <div key={cfg.block} className="settings-block" data-block={cfg.block}>
            <h3>{t(cfg.title)}</h3>
            {hasField(cfg.journalField) && (
              <SettingRow id={cfg.journalField} label={cfg.journalLabel} description={cfg.journalDesc}>
                <select id={cfg.journalField} disabled={readOnly || !company} value={company?.[cfg.journalField] ?? ''}
                  onChange={(e) => onWriteCompany({ [cfg.journalField]: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">{t('None')}</option>
                  {generalJournals.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
                </select>
              </SettingRow>
            )}
            {hasField(cfg.accountField) && (
              <SettingRow id={cfg.accountField} label={cfg.accountLabel} description={cfg.accountDesc}>
                <select id={cfg.accountField} disabled={readOnly || !company} value={company?.[cfg.accountField] ?? ''}
                  onChange={(e) => onWriteCompany({ [cfg.accountField]: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">{t('None')}</option>
                  {companyAccounts.map((a) => <option key={a.id} value={a.id}>{a.code ? `${a.code} ${a.name}` : a.name}</option>)}
                </select>
              </SettingRow>
            )}
            {hasField(cfg.generateField) && (
              <SettingRow id={cfg.generateField} label="Generate Entries" description={cfg.generateDesc}>
                <select id={cfg.generateField} disabled={readOnly || !company} value={company?.[cfg.generateField] ?? ''}
                  onChange={(e) => onWriteCompany({ [cfg.generateField]: e.target.value || null })}>
                  {generateOptions.map(([val, label]) => <option key={val} value={val}>{t(label)}</option>)}
                </select>
              </SettingRow>
            )}
            {hasField(cfg.computationField) && (
              <SettingRow id={cfg.computationField} label="Amount Computation" description={cfg.computationDesc}>
                <select id={cfg.computationField} disabled={readOnly || !company} value={company?.[cfg.computationField] ?? ''}
                  onChange={(e) => onWriteCompany({ [cfg.computationField]: e.target.value || null })}>
                  {computationOptions.map(([val, label]) => <option key={val} value={val}>{t(label)}</option>)}
                </select>
              </SettingRow>
            )}
            {hasField(cfg.periodicityField) && (
              <SettingRow id={cfg.periodicityField} label="Periodicity" description={cfg.periodicityDesc}>
                <select id={cfg.periodicityField} disabled={readOnly || !company} value={company?.[cfg.periodicityField] ?? ''}
                  onChange={(e) => onWriteCompany({ [cfg.periodicityField]: e.target.value || null })}>
                  {deferredPeriodicityOptions.map(([val, label]) => <option key={val} value={val}>{t(label)}</option>)}
                </select>
              </SettingRow>
            )}
          </div>
        );
      })}
    </section>
  );
}

export function Settings() {
  const db = useDb();
  const [status, setStatus] = useState(null);
  const company = (db.records['res.company'] ?? []).find((c) => c.id === currentCompany(db).id);
  const total = Object.values(db.records).reduce((s, recs) => s + recs.length, 0);
  // The server keeps company-wide settings for administrators; others see them read-only instead of edits that vanish.
  const readOnly = isServer() && !getUser()?.isAdmin;

  // On a server the backup is the server's full database (admins only); the browser copy may be filtered.
  const download = () => {
    const a = document.createElement('a');
    a.href = isServer() ? '/api/backup' : URL.createObjectURL(new Blob([JSON.stringify(getDb(), null, 2)], { type: 'application/json' }));
    a.download = `mizan-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    if (!isServer()) URL.revokeObjectURL(a.href);
  };
  const restore = async (file) => {
    setStatus(null);
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      setStatus(t('Invalid backup file.'));
      return;
    }
    if (!isServer()) {
      if (!isDb(data)) { setStatus(t('Invalid backup file.')); return; }
      if (confirm(t('Replace all data in this browser with the backup?'))) { commit(migrate(data)); setStatus(t('Backup restored.')); }
      return;
    }
    try {
      // Ask the server what would change, then require a typed confirmation before anything is replaced.
      const plan = await restoreBackup(data);
      const typed = prompt(`${t('Restoring replaces all data for every user.')}\n${t('Now')}: ${plan.current} · ${t('Backup')}: ${plan.restored} (${t('removed')}: ${plan.removed}, ${t('added')}: ${plan.added}, ${t('changed')}: ${plan.changed})\n${t('Messages')}: ${plan.messages.current} → ${plan.messages.restored} · ${t('Settings')}: ${plan.settingsChanged ? t('replaced') : t('unchanged')}\n${t('Type RESTORE to continue.')}`);
      if (typed !== 'RESTORE') return;
      await restoreBackup(data, 'RESTORE');
      setStatus(t('Backup restored.'));
    } catch (e) {
      setStatus(`${t('Backup not restored')}: ${e.message}`);
    }
  };
  const canReplaceData = !isServer() || getUser()?.isAdmin;
  const writeCompany = (vals) => {
    if (!company) return;
    const currentDb = getDb();
    const error = validateCompanySettingWrite(currentDb, company, vals);
    if (error) { setStatus(t(error)); return; }
    try {
      setStatus(null);
      commit(write(currentDb, 'res.company', company.id, vals));
    } catch (e) {
      setStatus(e.message);
    }
  };

  return (
    <main className="action settings">
      <div className="control-panel"><h1 className="cp-title">{t('General Settings')}</h1></div>
      <section className="sheet settings-sheet">
        {readOnly && <p className="muted">{t('Only administrators can change company settings.')}</p>}
        <div className="field">
          <label htmlFor="company">{t('Company Name')}</label>
          <div className="field-value">
            {/* One source of truth: the current company record, which the navbar, documents and QR codes all read. */}
            {company
              ? <input id="company" disabled={readOnly} key={company.id} defaultValue={company.name}
                  onBlur={(e) => { const name = e.target.value.trim(); if (!name) e.target.value = company.name; else if (name !== company.name) commit(renameCompany(getDb(), company.id, name)); }} />
              : <input id="company" disabled={readOnly} value={currentCompany(db).name} onChange={(e) => {
                  const name = e.target.value;
                  const curId = db.settings?.current_company_id ?? 1;
                  const companies = (db.settings?.companies ?? []).map((c) => (c.id === curId ? { ...c, name } : c));
                  commit(updateSettings(getDb(), { company: name, ...(db.settings?.companies?.length ? { companies } : {}) }));
                }} />}
          </div>
        </div>
        <div className="field">
          <label htmlFor="theme">{t('Theme')}</label>
          <div className="field-value">
            <select id="theme" value={theme} onChange={(e) => setTheme(e.target.value)}>
              <option value="auto">{t('Auto')}</option>
              <option value="light">{t('Light')}</option>
              <option value="dark">{t('Dark')}</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="lang">{t('Language')}</label>
          <div className="field-value">
            <select id="lang" value={lang} onChange={(e) => setLang(e.target.value)}>
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </select>
          </div>
        </div>
        <AccountingSection db={db} company={company} readOnly={readOnly} onWriteCompany={writeCompany} />
        <h3>{t('Data')}</h3>
        <p className="muted">{t('Records stored')}: {total}</p>
        <div className="row">
          {canReplaceData && <button type="button" className="btn" onClick={download}>⬇ {t('Download backup')}</button>}
          {canReplaceData && (
            <label className="btn">
              ⬆ {t('Restore backup')}
              <input type="file" accept="application/json" hidden onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; if (f) restore(f); }} />
            </label>
          )}
          {(!isServer() || getUser()?.canReset) && <button type="button" className="btn danger" onClick={() => { if (prompt(t('This deletes all data and loads the demo database. Type RESET to continue.')) === 'RESET') resetDemo(); }}>
            {t('Reset demo')}
          </button>}
        </div>
        {status && <p role="status">{status}</p>}
        {!isServer() && <p className="muted">{t('Browser-only demo mode: data is stored in this browser.')}</p>}
        {(!isServer() || getUser()?.isAdmin) && <Companies db={db} />}
        {isServer() && getUser()?.isAdmin && <Users />}
        {isServer() && <Security />}
        {isServer() && <ApiKeys />}
        {isServer() && <p><button type="button" className="btn" onClick={logout}>{t('Log out')}</button></p>}
      </section>
    </main>
  );
}
