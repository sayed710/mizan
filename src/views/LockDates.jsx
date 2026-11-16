import { useState } from 'react';
import { write } from '../orm.js';
import { commit, currentCompany, getDb, useDb } from '../store.js';
import { Wizard } from './Wizard.jsx';
import { validateCompanySettingWrite } from './Settings.jsx';
import { t } from '../i18n.js';

export const LOCK_DATE_FIELDS = [
  { name: 'sale_lock_date', label: 'Sales Lock Date' },
  { name: 'purchase_lock_date', label: 'Purchase Lock Date' },
  { name: 'lock_date', label: 'Lock Date' },
  { name: 'tax_lock_date', label: 'Tax Return Lock Date' },
  { name: 'hard_lock_date', label: 'Hard Lock Date', warning: 'A hard lock cannot be undone.' },
];

/**
 * Persist lock dates through the canonical res.company ORM write path so existing guards apply,
 * after the same pre-write validation the Accounting settings page uses.
 */
export function saveLockDates(db, companyId, vals) {
  const company = (db.records['res.company'] ?? []).find((c) => c.id === companyId);
  if (!company) throw new Error('Record not found');
  const clean = {};
  for (const f of LOCK_DATE_FIELDS) {
    if (Object.hasOwn(vals, f.name)) {
      clean[f.name] = vals[f.name] || null;
    }
  }
  const error = validateCompanySettingWrite(db, company, clean);
  if (error) throw new Error(error);
  return write(db, 'res.company', companyId, clean);
}

/**
 * Dedicated Lock Dates dialog for the current company only.
 */
export function LockDates({ db: propDb, companyId: propCompanyId, onClose, onSave }) {
  const storeDb = useDb();
  const db = propDb ?? storeDb;
  const [error, setError] = useState(null);

  const companyId = propCompanyId ?? currentCompany(db).id;
  const company = (db.records['res.company'] ?? []).find((c) => c.id === companyId);

  const spec = {
    title: 'Lock Dates',
    confirmLabel: 'Save',
    fields: LOCK_DATE_FIELDS.map((f) => ({
      ...f,
      type: 'date',
      readonly: false,
      default: company?.[f.name] ?? '',
    })),
  };

  const close = () => {
    if (onClose) return onClose();
    if (typeof window !== 'undefined' && window.history?.length > 1) {
      window.history.back();
    } else if (typeof location !== 'undefined') {
      location.hash = '#/accounting';
    }
  };

  const handleConfirm = (values) => {
    if (!company) return;
    try {
      setError(null);
      const nextDb = saveLockDates(getDb(), company.id, values);
      commit(nextDb);
      onSave?.(nextDb);
      close();
    } catch (e) {
      setError(t(e.message));
    }
  };

  return (
    <Wizard
      db={db}
      spec={spec}
      onConfirm={handleConfirm}
      onCancel={close}
      error={error}
    />
  );
}
