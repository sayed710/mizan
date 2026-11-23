// Banks directory (Odoo 20 res.bank parity).
import { writeMany } from '../orm.js';

// ISO 9362: 4-character party prefix, 2-letter country code, 2-character location, optional 3-character branch.
const BIC_RE = /^[A-Za-z]{4}[A-Za-z]{2}[A-Za-z0-9]{2}(?:[A-Za-z0-9]{3})?$/;

/**
 * Normalize a BIC/SWIFT string by trimming whitespace and upper-casing characters.
 * @param {string|null|undefined} bic
 * @returns {string|null|undefined}
 */
export function normalizeBic(bic) {
  if (bic == null) return bic;
  return String(bic).trim().toUpperCase();
}

/**
 * Check whether a BIC/SWIFT string is empty or a well-formed 8/11-character code with a letter country code.
 * @param {string|null|undefined} bic
 * @returns {boolean}
 */
export function isValidBankBic(bic) {
  if (bic == null) return true;
  const trimmed = String(bic).trim();
  return trimmed === '' || BIC_RE.test(trimmed);
}

/**
 * Validate a stored BIC/SWIFT value: empty, or 8/11 ISO 9362 alphanumeric characters already in upper-case.
 * @param {string|null|undefined} bic
 * @returns {string|null}
 */
export function bicError(bic) {
  if (bic == null || bic === '') return null;
  const trimmed = String(bic).trim();
  if (trimmed === '') return null;
  if (!BIC_RE.test(trimmed)) return 'BIC/SWIFT must be 8 or 11 alphanumeric characters';
  if (bic !== trimmed.toUpperCase()) return 'BIC/SWIFT must be stored in upper-case';
  return null;
}

const normalizeResBankVals = (vals) => (
  vals && Object.hasOwn(vals, 'bic') ? { ...vals, bic: normalizeBic(vals.bic) } : vals
);

/**
 * Validate a res.bank record before create or write (ORM and diff+sync).
 * @param {object} _db
 * @param {object|null} before
 * @param {object} r
 * @returns {string|null}
 */
export function resBankGuard(_db, before, r) {
  if (!r?.name || !String(r.name).trim()) return 'Name is required';
  if (r.bic !== before?.bic) {
    const err = bicError(r.bic);
    if (err) return err;
  }
  return null;
}

export function syncLinkedPartnerBanks(db, after, before) {
  if (!before) return db;
  if (after.name === before.name && after.bic === before.bic) return db;
  const linked = (db.records?.['res.partner.bank'] ?? []).filter((b) => b.bank_id === after.id);
  if (!linked.length) return db;
  const nextName = after.name ?? '';
  const nextBic = after.bic ?? '';
  const updates = new Map();
  for (const b of linked) {
    if (b.bank_name !== nextName || b.bank_bic !== nextBic) {
      updates.set(b.id, { bank_name: nextName, bank_bic: nextBic });
    }
  }
  return updates.size ? writeMany(db, 'res.partner.bank', updates) : db;
}

export const resBankModels = {
  'res.bank': {
    label: 'Banks',
    views: ['list'],
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      bic: {
        type: 'char',
        label: 'Bank Identifier Code',
        help: 'Bank Identifier Code for international wires in the format Bank Code (4 letters) + Country Code (2 letters) + Location Code (2 letters/numbers) + Optional Branch Code (3 letters/numbers).',
      },
      street: { type: 'char', label: 'Street' },
      street2: { type: 'char', label: 'Street 2' },
      zip: { type: 'char', label: 'ZIP' },
      city: { type: 'char', label: 'City' },
      state: { type: 'char', label: 'State' },
      country: { type: 'char', label: 'Country' },
      email: { type: 'char', label: 'Email' },
      phone: { type: 'char', label: 'Phone' },
      active: { type: 'boolean', label: 'Active' },
    },
    defaults: () => ({ active: true }),
    prepareCreate: (db, vals) => ({ db, vals: normalizeResBankVals(vals) }),
    prepareWrite: (db, vals) => ({ db, vals: normalizeResBankVals(vals) }),
    guard: resBankGuard,
    onWrite: syncLinkedPartnerBanks,
    searchFields: ['name', 'bic'],
    list: ['name', 'bic', 'country', 'active'],
    listFields: {
      active: { optional: 'hide', widget: 'toggle' },
    },
    editableList: ['active'],
    listDecoration: (r) => (r.active === false ? 'muted' : ''),
    form: {
      title: 'name',
      groups: [
        { title: 'Bank Address', fields: ['street', 'street2', 'city', 'state', 'zip', 'country'] },
        ['bic', 'phone', 'email', 'active'],
      ],
    },
  },
};
