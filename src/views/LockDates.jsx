import { useEffect, useRef, useState } from 'react';
import { read, search, write } from '../orm.js';
import { commit, currentCompany, getDb, getUser, isServer, useDb } from '../store.js';
import { validateCompanySettingWrite } from './Settings.jsx';
import { handleDialogKeyDown } from './Wizard.jsx';
import { t } from '../i18n.js';
import { createLockException, revokeLockException, exceptionState, isAccountingManager, LOCK_EXCEPTION_FIELDS } from '../models/lockexception.js';

const EXCEPTION_FIELD_LABELS = Object.fromEntries(LOCK_EXCEPTION_FIELDS);

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
  const company = read(db, 'res.company', companyId);
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
  const company = read(db, 'res.company', companyId);
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
  const [values, setValues] = useState(() => lockValues(company));
  const [error, setError] = useState(null);

  const [newEx, setNewEx] = useState({
    lock_field: 'global',
    user_id: '',
    lock_date: '',
    end_datetime: '',
    reason: '',
  });

  const box = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    box.current?.querySelector('input, select, textarea, button')?.focus();
    return () => previous?.focus?.();
  }, []);

  const close = () => {
    if (onClose) return onClose();
    if (typeof window !== 'undefined' && window.history?.length > 1) {
      window.history.back();
    } else if (typeof location !== 'undefined') {
      location.hash = '#/accounting';
    }
  };

  const handleConfirm = async (changedValues) => {
    // Only fields the user actually edited: a value loaded before another action changed it is not re-applied.
    const changed = {};
    for (const f of LOCK_DATE_FIELDS) {
      const next = norm(changedValues[f.name]);
      if (next !== baseline[f.name]) changed[f.name] = next;
    }
    if (!Object.keys(changed).length) {
      close();
      return;
    }

    const currentDb = getDb();
    const current = read(currentDb, 'res.company', company.id);
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

  const handleSubmit = (e) => {
    e?.preventDefault?.();
    if (readOnly) return;
    handleConfirm(values);
  };

  const onKeyDown = (e) => handleDialogKeyDown(e, box.current, close);

  const onExceptionKeyDown = (e) => {
    if (e.key === 'Enter' && e.target?.tagName !== 'BUTTON') {
      e.preventDefault();
      e.stopPropagation();
      handleAddException();
    }
  };

  const currentUser = getUser();
  const canManageExceptions = !readOnly && (!isServer() || currentUser?.isAdmin || isAccountingManager(currentUser));

  const allExceptions = search(db, 'account.lock_exception').filter((ex) => (ex.company_id ?? 1) === (company.id ?? 1));
  const activeExceptions = allExceptions.filter((ex) => exceptionState(ex) === 'active');

  const userCandidates = search(db, 'hr.employee');
  const userName = (uid) => {
    if (!uid) return t('Everyone');
    const match = read(db, 'hr.employee', uid);
    return match?.name ?? `User #${uid}`;
  };

  const fieldName = (f) => EXCEPTION_FIELD_LABELS[f] ?? f;

  const handleRevoke = async (id) => {
    const currentDb = getDb();
    try {
      const nextDb = revokeLockException(currentDb, id);
      const res = await commit(nextDb, { quiet: true });
      if (res?.ok === false) {
        setError(res.error);
      }
    } catch (e) {
      setError(t(e.message));
    }
  };

  const handleAddException = async () => {
    if (!newEx.lock_field) {
      setError(t('Select a lock date field'));
      return;
    }
    if (!newEx.lock_date) {
      setError(t('Enter a valid exception lock date'));
      return;
    }
    if (!newEx.end_datetime) {
      setError(t('Enter a valid expiry date'));
      return;
    }
    const currentDb = getDb();
    try {
      const expiry = newEx.end_datetime.includes('T') ? newEx.end_datetime : `${newEx.end_datetime}T23:59:59Z`;
      const nextDb = createLockException(currentDb, {
        company_id: company.id,
        user_id: newEx.user_id ? Number(newEx.user_id) : null,
        lock_field: newEx.lock_field,
        lock_date: newEx.lock_date,
        end_datetime: expiry,
        reason: newEx.reason || '',
      });
      const res = await commit(nextDb, { quiet: true });
      if (res?.ok === false) {
        setError(res.error);
        return;
      }
      setNewEx({
        lock_field: 'global',
        user_id: '',
        lock_date: '',
        end_datetime: '',
        reason: '',
      });
      setError(null);
    } catch (e) {
      setError(t(e.message));
    }
  };

  return (
    <div className="wizard-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={box} className="wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-title" onKeyDown={onKeyDown}>
        <h2 id="wizard-title">{t('Lock Dates')}</h2>
        <form onSubmit={handleSubmit}>
          {LOCK_DATE_FIELDS.map((f) => (
            <div className="field" key={f.name}>
              <label htmlFor={`w-${f.name}`}>{t(f.label)}</label>
              <div className="field-value">
                <input
                  type="date"
                  id={`w-${f.name}`}
                  disabled={readOnly}
                  value={values[f.name] ?? ''}
                  onChange={(e) => setValues((s) => ({ ...s, [f.name]: e.target.value || null }))}
                />
                {f.warning && <p className="muted setting-desc">{t(f.warning)}</p>}
              </div>
            </div>
          ))}
          {error && (
            <div className="alert" role="alert">{error}</div>
          )}
          <div className="row">
            <button type="submit" className="btn primary" disabled={readOnly}>{t('Save')}</button>
            <button type="button" className="btn" onClick={close}>{t('Cancel')}</button>
          </div>
        </form>

        <div className="lock-exceptions-section" style={{ marginTop: '20px', borderTop: '1px solid #ddd', paddingTop: '16px' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '8px' }}>{t('Active Exceptions')}</h3>
          {activeExceptions.length === 0 ? (
            <p className="muted" style={{ fontSize: '0.875rem' }}>{t('No active exceptions.')}</p>
          ) : (
            <table className="table" style={{ width: '100%', fontSize: '0.875rem', marginBottom: '12px' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>{t('Field')}</th>
                  <th style={{ textAlign: 'left' }}>{t('User')}</th>
                  <th style={{ textAlign: 'left' }}>{t('Exception Lock Date')}</th>
                  <th style={{ textAlign: 'left' }}>{t('Expiry Date')}</th>
                  <th style={{ textAlign: 'left' }}>{t('Reason')}</th>
                  <th style={{ textAlign: 'left' }}>{t('Action')}</th>
                </tr>
              </thead>
              <tbody>
                {activeExceptions.map((ex) => (
                  <tr key={ex.id}>
                    <td>{t(fieldName(ex.lock_field))}</td>
                    <td>{userName(ex.user_id)}</td>
                    <td>{ex.lock_date}</td>
                    <td>{ex.end_datetime ? String(ex.end_datetime).slice(0, 16) : '-'}</td>
                    <td>{ex.reason || '-'}</td>
                    <td>
                      {canManageExceptions && (
                        <button
                          type="button"
                          className="btn sm danger"
                          onClick={() => handleRevoke(ex.id)}
                        >
                          {t('Revoke')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {canManageExceptions && (
            <div className="add-exception-box" onKeyDown={onExceptionKeyDown} style={{ marginTop: '12px', background: '#f9fafb', padding: '12px', borderRadius: '4px' }}>
              <h4 style={{ fontSize: '0.875rem', fontWeight: 600, marginBottom: '8px' }}>{t('Add Exception')}</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '8px', marginBottom: '8px' }}>
                <div>
                  <label htmlFor="ex-field" style={{ fontSize: '0.75rem', display: 'block' }}>{t('Select a lock date field')}</label>
                  <select
                    id="ex-field"
                    value={newEx.lock_field}
                    onChange={(e) => setNewEx((s) => ({ ...s, lock_field: e.target.value }))}
                  >
                    {LOCK_EXCEPTION_FIELDS.map(([key, label]) => (
                      <option key={key} value={key}>{t(label)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="ex-user" style={{ fontSize: '0.75rem', display: 'block' }}>{t('User')}</label>
                  <select
                    id="ex-user"
                    value={newEx.user_id}
                    onChange={(e) => setNewEx((s) => ({ ...s, user_id: e.target.value ? Number(e.target.value) : '' }))}
                  >
                    <option value="">{t('Everyone')}</option>
                    {userCandidates.map((u) => (
                      <option key={u.id} value={u.id}>{u.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="ex-date" style={{ fontSize: '0.75rem', display: 'block' }}>{t('Exception Lock Date')}</label>
                  <input
                    type="date"
                    id="ex-date"
                    value={newEx.lock_date}
                    onChange={(e) => setNewEx((s) => ({ ...s, lock_date: e.target.value }))}
                  />
                </div>
                <div>
                  <label htmlFor="ex-expiry" style={{ fontSize: '0.75rem', display: 'block' }}>{t('Expiry Date')}</label>
                  <input
                    type="date"
                    id="ex-expiry"
                    value={newEx.end_datetime}
                    onChange={(e) => setNewEx((s) => ({ ...s, end_datetime: e.target.value }))}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input
                  type="text"
                  id="ex-reason"
                  placeholder={t('Reason')}
                  value={newEx.reason}
                  onChange={(e) => setNewEx((s) => ({ ...s, reason: e.target.value }))}
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  id="btn-add-exception"
                  className="btn sm primary"
                  onClick={handleAddException}
                >
                  {t('Add Exception')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
