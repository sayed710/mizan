// Partner Bank Accounts (Odoo 20 parity).
import { create, writeManyAtomic } from '../orm.js';

export function sanitizeAccountNumber(val) {
  return String(val ?? '').replace(/\s+/g, '').toUpperCase();
}

// ISO 9362: 4-character party prefix, 2-letter country code, 2-character location, optional 3-character branch.
const BIC_RE = /^[A-Za-z0-9]{4}[A-Za-z]{2}[A-Za-z0-9]{2}(?:[A-Za-z0-9]{3})?$/;

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
 * Validate a partner bank account before create or write: required fields, BIC format and per-partner
 * uniqueness across all accounts (including archived).
 * @param {object} db
 * @param {object|null} before
 * @param {object} r
 * @returns {string|null}
 */
export function bankAccountGuard(db, before, r) {
  if (!r.partner_id) return 'Select a partner for the bank account';
  if (!r.account_number || !String(r.account_number).trim()) return 'Bank account number is required';
  if (!isValidBankBic(r.bank_bic)) return 'BIC/SWIFT must be 8 or 11 alphanumeric characters';

  const sanitized = sanitizeAccountNumber(r.account_number);
  const allBanks = db?.records?.['res.partner.bank'] ?? [];
  const duplicate = allBanks.find(
    (b) => b.id !== r.id
      && b.partner_id === r.partner_id
      && (b.sanitized_account_number === sanitized || sanitizeAccountNumber(b.account_number) === sanitized)
  );
  if (duplicate) {
    return 'The bank account number must be unique per partner';
  }
  return null;
}

/** Validate bank_ids array from partner form / public create & write. */
export function validatePartnerBankLines(db, partnerId, bankLines = []) {
  if (!Array.isArray(bankLines)) return null;
  const allBanks = db?.records?.['res.partner.bank'] ?? [];
  const seenIds = new Set();
  const candidates = [];
  for (const [index, line] of bankLines.entries()) {
    if (!line || (line.id != null && (!Number.isSafeInteger(line.id) || line.id < 1))) return 'The selected bank account is invalid or inactive';
    const supplied = Object.fromEntries(Object.entries(line).filter(([, value]) => value !== undefined));
    if (line.id) {
      const existing = allBanks.find((b) => b.id === line.id);
      if (!existing || existing.partner_id !== partnerId) return 'The selected bank account is invalid or inactive';
      if (seenIds.has(line.id)) return 'The selected bank account is invalid or inactive';
      seenIds.add(line.id);
      candidates.push({ ...existing, ...supplied, partner_id: partnerId });
    } else {
      candidates.push({ ...supplied, id: -(index + 1), partner_id: partnerId });
    }
  }
  const staged = { ...db, records: { ...db.records, 'res.partner.bank': [...allBanks.filter((b) => !seenIds.has(b.id)), ...candidates.map((b) => ({ ...b, sanitized_account_number: sanitizeAccountNumber(b.account_number) }))] } };
  for (const candidate of candidates) {
    const error = bankAccountGuard(staged, null, candidate);
    if (error) return error;
  }
  return null;
}

/** Synchronize res.partner.bank records from partner's bank_ids lines. */
export function syncPartnerBankAccounts(db, partnerId, bankLines) {
  if (!Array.isArray(bankLines)) return db;
  const error = validatePartnerBankLines(db, partnerId, bankLines);
  if (error) throw new Error(error);
  const existingBanks = db.records?.['res.partner.bank'] ?? [];
  const maxId = Math.max(0, db.seq?.['res.partner.bank'] ?? 0, ...existingBanks.map((b) => b.id ?? 0));
  let next = (db.seq?.['res.partner.bank'] ?? 0) < maxId
    ? { ...db, seq: { ...db.seq, 'res.partner.bank': maxId } } : db;
  const lineIds = new Set(bankLines.map((line) => line.id).filter(Boolean));
  const fields = ['account_number', 'holder_name', 'bank_name', 'bank_bic', 'allow_out_payment', 'currency', 'company_id', 'active'];
  const valuesOf = (line) => Object.fromEntries(fields.filter((field) => Object.hasOwn(line, field) && line[field] !== undefined).map((field) => [field, line[field]]));
  const updates = new Map(existingBanks.filter((bank) => bank.partner_id === partnerId && bank.active !== false && !lineIds.has(bank.id))
    .map((bank) => [bank.id, { active: false }]));
  for (const line of bankLines) if (line.id) updates.set(line.id, valuesOf(line));
  next = writeManyAtomic(next, 'res.partner.bank', updates);
  for (const line of bankLines) if (!line.id) next = create(next, 'res.partner.bank', { ...valuesOf(line), partner_id: partnerId }).db;
  return next;
}

/** Resolve and validate recipient bank account for outbound payments. */
export function resolveAndValidateRecipientBank(db, partnerId, requestedBankId, { invoiceBankId = null, companyId = 1 } = {}) {
  const allBanks = db?.records?.['res.partner.bank'] ?? [];
  if (requestedBankId && invoiceBankId && requestedBankId !== invoiceBankId) {
    throw new Error('Payment and invoice bank accounts must match');
  }
  requestedBankId = requestedBankId || invoiceBankId;

  if (requestedBankId) {
    const chosen = allBanks.find((b) => b.id === requestedBankId);
    if (!chosen || chosen.active === false) {
      throw new Error('The selected bank account is invalid or inactive');
    }
    if (chosen.partner_id !== partnerId) {
      throw new Error('The bank account does not belong to the partner');
    }
    if (chosen.company_id && chosen.company_id !== companyId) {
      throw new Error('The bank account belongs to another company');
    }
    if (!chosen.allow_out_payment) {
      throw new Error('The bank account does not allow outbound payments');
    }
    return chosen.id;
  }

  return null;
}

export const partnerBankModels = {
  'res.partner.bank': {
    label: 'Bank Accounts',
    views: ['list'],
    fields: {
      sequence: { type: 'integer', label: 'Sequence', widget: 'handle' },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner', required: true },
      account_number: { type: 'char', label: 'Account Number', required: true },
      legacy_account_numbers: { type: 'tags', label: 'Legacy Account Numbers', readonly: true, hidden: true },
      sanitized_account_number: {
        type: 'char',
        label: 'Sanitized Account Number',
        readonly: true,
        hidden: true,
        compute: (r) => sanitizeAccountNumber(r.account_number),
      },
      holder_name: {
        type: 'char',
        label: 'Holder Name',
        help: 'Account holder name in case it is different than the name of the partner.',
      },
      bank_name: { type: 'char', label: 'Bank Name', placeholder: 'e.g. Bank of America' },
      bank_bic: {
        type: 'char',
        label: 'BIC/SWIFT',
        help: 'Bank Identifier Code for international wires in the format Bank Code (4 letters) + Country Code (2 letters) + Location Code (2 letters/numbers) + Optional Branch Code (3 letters/numbers).',
      },
      allow_out_payment: {
        type: 'boolean',
        label: 'Trust Bank Account',
        widget: 'toggle',
        help: 'Sending fake invoices with a fraudulent account number is a common phishing practice. To protect yourself, always verify new bank account numbers, preferably by calling the vendor, as phishing usually happens when their emails are compromised. Once verified, you can activate the ability to send money.',
      },
      clearing_number: {
        type: 'char',
        label: 'Clearing Number',
        help: 'A clearing number (or routing number) refers to a bank, branch, or location and is used by domestic money transfer protocols (from/to bank accounts in the same country).',
      },
      note: { type: 'text', label: 'Notes', placeholder: 'Internal notes...' },
      street: { type: 'char', label: 'Street' },
      street2: { type: 'char', label: 'Street 2' },
      city: { type: 'char', label: 'City' },
      state: { type: 'char', label: 'State' },
      zip: { type: 'char', label: 'ZIP' },
      country: { type: 'char', label: 'Country' },
      currency: { type: 'char', label: 'Currency', hidden: true },
      company_id: {
        type: 'many2one',
        relation: 'res.company',
        label: 'Company',
        multiCompanyOnly: true,
        placeholder: 'Visible to all',
      },
      active: { type: 'boolean', label: 'Active' },
    },
    defaults: () => ({
      sequence: 10,
      allow_out_payment: false,
      active: true,
    }),
    sort: (a, b) => (a.sequence ?? 10) - (b.sequence ?? 10) || (a.id ?? 0) - (b.id ?? 0),
    guard: bankAccountGuard,
    onchange: (r, key) => (key === 'account_number' ? { sanitized_account_number: sanitizeAccountNumber(r.account_number) } : {}),
    searchFields: ['bank_name', 'account_number', 'company_id', 'partner_id'],
    list: ['sequence', 'account_number', 'partner_id', 'holder_name', 'bank_name', 'bank_bic', 'clearing_number', 'company_id', 'allow_out_payment', 'active'],
    listLabels: { bank_name: 'Bank' },
    listFields: {
      partner_id: { optional: 'hide' },
      holder_name: { optional: 'hide' },
      bank_name: { optional: 'hide' },
      bank_bic: { optional: 'show' },
      clearing_number: { optional: 'hide' },
      company_id: { optional: 'hide', multiCompanyOnly: true },
      allow_out_payment: { optional: 'show', widget: 'toggle' },
      active: { optional: 'hide', widget: 'toggle' },
    },
    editableList: ['allow_out_payment', 'active'],
    listDecoration: (r) => (r.active === false ? 'muted' : ''),
    form: {
      title: 'account_number',
      hideTitle: true,
      groups: [
        ['account_number', 'clearing_number', 'bank_bic', 'partner_id', 'holder_name'],
        ['allow_out_payment', 'company_id'],
      ],
      tabs: [
        { label: 'Note', fields: ['note'] },
        {
          label: 'Bank Information',
          groups: [
            ['bank_name'],
            { title: 'Bank Address', fields: ['street', 'street2', 'city', 'state', 'zip', 'country'] },
          ],
        },
      ],
      chatter: true,
    },
  },
};
