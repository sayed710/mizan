// Partner Bank Accounts (Odoo 20 parity).
import { create, writeManyAtomic } from '../orm.js';

export function sanitizeAccountNumber(val) {
  return String(val ?? '').replace(/\s+/g, '').toUpperCase();
}

/** Validate partner bank account: required fields and per-partner uniqueness across all accounts (including archived). */
export function bankAccountGuard(db, before, r) {
  if (!r.partner_id) return 'Select a partner for the bank account';
  if (!r.account_number || !String(r.account_number).trim()) return 'Bank account number is required';

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
export function resolveAndValidateRecipientBank(db, partnerId, requestedBankId, { invoiceBankId = null } = {}) {
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
    if (!chosen.allow_out_payment) {
      throw new Error('The bank account does not allow outbound payments');
    }
    return chosen.id;
  }

  const partnerBanks = allBanks.filter((b) => b.partner_id === partnerId && b.active !== false);
  if (!partnerBanks.length) throw new Error('A recipient bank account is required');

  const allowed = partnerBanks.find((b) => b.allow_out_payment);
  if (!allowed) {
    throw new Error('The bank account does not allow outbound payments');
  }
  return allowed.id;
}

export const partnerBankModels = {
  'res.partner.bank': {
    label: 'Bank Accounts',
    fields: {
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner', required: true },
      account_number: { type: 'char', label: 'Account Number', required: true },
      legacy_account_numbers: { type: 'tags', label: 'Legacy Account Numbers', readonly: true },
      sanitized_account_number: {
        type: 'char',
        label: 'Sanitized Account Number',
        readonly: true,
        compute: (r) => sanitizeAccountNumber(r.account_number),
      },
      holder_name: { type: 'char', label: 'Account Holder' },
      bank_name: { type: 'char', label: 'Bank Name' },
      bank_bic: { type: 'char', label: 'Bank Identifier Code' },
      allow_out_payment: { type: 'boolean', label: 'Send Money' },
      currency: { type: 'char', label: 'Currency' },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company' },
      active: { type: 'boolean', label: 'Active' },
    },
    defaults: () => ({
      allow_out_payment: true,
      active: true,
    }),
    guard: bankAccountGuard,
    onchange: (r, key) => (key === 'account_number' ? { sanitized_account_number: sanitizeAccountNumber(r.account_number) } : {}),
    groupBys: ['partner_id', 'bank_name'],
    list: ['account_number', 'partner_id', 'bank_name', 'bank_bic', 'allow_out_payment', 'active'],
    kanban: { title: 'account_number', lines: ['partner_id', 'bank_name'] },
    form: {
      title: 'account_number',
      groups: [
        ['partner_id', 'account_number', 'sanitized_account_number', 'holder_name', 'legacy_account_numbers'],
        ['bank_name', 'bank_bic', 'allow_out_payment', 'currency', 'company_id', 'active'],
      ],
      chatter: true,
    },
  },
};
