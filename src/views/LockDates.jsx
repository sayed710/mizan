import { useState } from 'react';
import { write } from '../orm.js';
import { commit, currentCompany, getDb, getUser, isServer, useDb } from '../store.js';
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

// A cleared date input means "no lock", which the ORM stores as null.
const norm = (value) => value || null;

const lockValues = (company) => Object.fromEntries(
  LOCK_DATE_FIELDS.map((f) => [f.name, norm(company?.[f.name])]),
);

/**
 * Persist lock dates through the canonical res.company ORM write path so existing guards apply,
 * after the same pre-write validation the Accounting settings page uses. Only fields that differ
 * from the value stored in `db` are written, so stale form values cannot revert a newer change.
 * Returns `db` itself when nothing changed.
 */
export function saveLockDates(db, companyId, vals) {
  const company = (db.records['res.company'] ?? []).find((c) => c.id === companyId);
  if (!company) throw new Error('Record not found');
  const clean = {};
  for (const f of LOCK_DATE_FIELDS) {
    if (!Object.hasOwn(vals, f.name)) continue;
    const next = norm(vals[f.name]);
    if (next === norm(company[f.name])) continue;
    clean[f.name] = next;
  }
  if (!Object.keys(clean).length) return db;
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
  const companyId = propCompanyId ?? currentCompany(db).id;
  const company = (db.records['res.company'] ?? []).find((c) => c.id === companyId);
  if (!company) return null;
  // The same rule as the Accounting settings page: non-admin server users only see these values.
  const readOnly = isServer() && !getUser()?.isAdmin;
  // Keyed by company id so switching the selected company remounts the form with that company's values.
  return (
    <LockDatesDialog
      key={company.id}
      db={db}
      company={company}
      readOnly={readOnly}
      onClose={onClose}
      onSave={onSave}
    />
  );
}

function LockDatesDialog({ db, company, readOnly, onClose, onSave }) {
  // The values the form was opened with: only edits against these may be written.
  const [baseline] = useState(() => lockValues(company));
  const [error, setError] = useState(null);

  const spec = {
    title: 'Lock Dates',
    confirmLabel: 'Save',
    readOnly,
    fields: LOCK_DATE_FIELDS.map((f) => ({
      ...f,
      type: 'date',
      disabled: readOnly,
      default: baseline[f.name] ?? '',
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

  const handleConfirm = async (values) => {
    // Only fields the user actually edited: a value loaded before another action changed it is not re-applied.
    const changed = {};
    for (const f of LOCK_DATE_FIELDS) {
      const next = norm(values[f.name]);
      if (next !== baseline[f.name]) changed[f.name] = next;
    }
    if (!Object.keys(changed).length) {
      close();
      return;
    }

    const currentDb = getDb();
    const current = (currentDb.records['res.company'] ?? []).find((c) => c.id === company.id);
    if (!current) {
      setError(t('Record not found'));
      return;
    }

    // Same rule and wording as the Accounting settings page: moving the hard lock forward needs a confirmation.
    if (Object.hasOwn(changed, 'hard_lock_date')
      && changed.hard_lock_date && changed.hard_lock_date > (norm(current.hard_lock_date) ?? '')
      && !confirm(t('The hard lock date cannot be moved back or removed. Continue?'))) return;

    let nextDb;
    try {
      nextDb = saveLockDates(currentDb, company.id, changed);
    } catch (e) {
      setError(t(e.message));
      return;
    }
    if (nextDb === currentDb) {
      close();
      return;
    }

    let result;
    try {
      // Quiet: a refusal belongs in this dialog, next to the values the user can correct.
      result = await commit(nextDb, { quiet: true });
    } catch (e) {
      setError(e.message);
      return;
    }
    if (result?.ok === false) {
      setError(result.error);
      return;
    }
    onSave?.(nextDb);
    close();
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
