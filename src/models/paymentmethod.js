import { create, read, search, unlink, write } from '../orm.js';
import { defaultPaymentJournalId, isReconcilableAccount } from './ledger.js';
import { currentCompany } from './company.js';

export const SEEDED_PAYMENT_METHODS = [
  { code: 'manual', payment_type: 'inbound', name: 'Manual' },
  { code: 'manual', payment_type: 'outbound', name: 'Manual' },
  { code: 'check_printing', payment_type: 'outbound', name: 'Checks' },
];

const METHOD_LINE_JOURNAL_TYPES = ['bank', 'cash'];
export const METHOD_LINE_FIELDS = [
  ['inbound_payment_method_line_ids', 'inbound'],
  ['outbound_payment_method_line_ids', 'outbound'],
];

/** True when a journal (or journal type) supports payment method lines (bank or cash). */
export const isMethodLineJournal = (journalOrType) =>
  METHOD_LINE_JOURNAL_TYPES.includes(typeof journalOrType === 'string' ? journalOrType : journalOrType?.type);

/** Find a payment method record by its `code` and `payment_type` (never by name or label). */
export const findPaymentMethod = (db, code, paymentType) =>
  search(db, 'account.payment.method', { includeArchived: true })
    .find((m) => m.code === code && m.payment_type === paymentType) ?? null;

/** Default method specifications for a newly created or migrated bank/cash journal. */
export function defaultMethodSpecsForJournal(journalType) {
  if (journalType === 'bank') {
    return [
      { code: 'manual', payment_type: 'inbound', sequence: 10 },
      { code: 'manual', payment_type: 'outbound', sequence: 10 },
      { code: 'check_printing', payment_type: 'outbound', sequence: 20 },
    ];
  }
  if (journalType === 'cash') {
    return [
      { code: 'manual', payment_type: 'inbound', sequence: 10 },
      { code: 'manual', payment_type: 'outbound', sequence: 10 },
    ];
  }
  return [];
}

/** Seed any missing reference payment methods (`Manual` inbound/outbound, `Checks` outbound). */
export function ensurePaymentMethods(db) {
  if (!db) return db;
  let next = {
    ...db,
    records: db.records ?? {},
    seq: db.seq ?? {},
    messages: db.messages ?? [],
  };
  for (const spec of SEEDED_PAYMENT_METHODS) {
    if (!findPaymentMethod(next, spec.code, spec.payment_type)) {
      next = create(next, 'account.payment.method', spec).db;
    }
  }
  return next;
}

/**
 * Every method line owned by `journalId`, whatever company is active. Journals are shared across companies, so
 * ownership checks must not go through the company-scoped search() or another company's lines look missing.
 */
function ownedMethodLines(db, journalId, { includeArchived = false } = {}) {
  return (db?.records?.['account.payment.method.line'] ?? [])
    .filter((l) => l.journal_id === journalId && (includeArchived || l.active !== false));
}

/** Active payment method lines for `journalId` (optionally filtered by direction), ordered by sequence then ID. */
export function journalMethodLines(db, journalId, paymentType = null) {
  if (!db || !journalId) return [];
  return ownedMethodLines(db, journalId)
    .filter((l) => !paymentType || l.payment_type === paymentType)
    .slice()
    .sort((a, b) => (a.sequence ?? 10) - (b.sequence ?? 10) || (a.id ?? 0) - (b.id ?? 0));
}

/** ID of the first payment method line by sequence for `(journalId, paymentType)`, or null. */
export function defaultPaymentMethodLineId(db, journalId, paymentType = 'inbound') {
  return journalMethodLines(db, journalId, paymentType)[0]?.id ?? null;
}

/** Validate an optional `payment_account_id` override against active status, company, and reconcilability. */
export function paymentAccountError(db, accountId, companyId) {
  if (!accountId) return null;
  const account = read(db, 'account.account', accountId);
  if (!account || account.active === false) return 'Select an active outstanding account';
  if (account.company_id && account.company_id !== companyId) return 'Outstanding account must belong to the journal company';
  if (!isReconcilableAccount(account)) return 'Outstanding account must be reconcilable';
  return null;
}

/** UI domain predicate for `payment_account_id` on a payment method line. */
export function methodLineAccountDomain(account, line, db) {
  const journal = line?.journal_id && db ? read(db, 'account.journal', line.journal_id) : null;
  const companyId = journal?.company_id ?? line?.company_id ?? 1;
  return account.active !== false && isReconcilableAccount(account) && (!account.company_id || account.company_id === companyId);
}

/** Block deletion of any payment method line referenced by a posted payment (stored or staged). */
export function protectMethodLineDelete(db, line, staged = db) {
  const postedInDb = search(db, 'account.payment', { includeArchived: true }).some((p) => p.payment_method_line_id === line.id && p.state === 'posted');
  const postedInStaged = search(staged, 'account.payment', { includeArchived: true }).some((p) => p.payment_method_line_id === line.id && p.state === 'posted');
  return postedInDb || postedInStaged ? 'A payment method line used by a posted payment cannot be deleted' : null;
}

/** Validate `account.payment.method.line` invariants for both ORM and diff+sync. */
export function paymentMethodLineGuard(db, before, after) {
  const journal = after.journal_id ? read(db, 'account.journal', after.journal_id) : null;
  if (!journal || !isMethodLineJournal(journal)) return 'Payment method lines are only valid for bank and cash journals';
  const method = after.payment_method_id ? read(db, 'account.payment.method', after.payment_method_id) : null;
  if (!method) return 'Select an existing payment method';
  if (after.payment_type !== method.payment_type) return 'Payment method line direction must match its payment method';
  if (after.company_id && journal.company_id && after.company_id !== journal.company_id) {
    return 'Payment method line must belong to the journal company';
  }
  if (before && (after.journal_id !== before.journal_id || after.payment_type !== before.payment_type)) {
    const payments = search(db, 'account.payment', { includeArchived: true }).filter((p) => p.payment_method_line_id === after.id);
    if (payments.some((p) => p.state === 'posted')) {
      return 'Cannot change journal or direction of a payment method line used by a posted payment';
    }
    if (payments.some((p) => p.journal_id !== after.journal_id)) return 'Payment method must belong to the payment journal';
    if (payments.some((p) => p.payment_type !== after.payment_type)) return 'Payment method direction must match the payment type';
  }
  return paymentAccountError(db, after.payment_account_id, journal.company_id ?? 1);
}

/** Validate that a payment's `payment_method_line_id` (when set) belongs to its journal and direction. */
export function paymentMethodLineError(db, payment) {
  if (payment?.payment_method_line_id == null || payment.payment_method_line_id === '') return null;
  const line = read(db, 'account.payment.method.line', payment.payment_method_line_id);
  if (!line) return 'Selected payment method line does not exist';
  if (!payment.journal_id || line.journal_id !== payment.journal_id) return 'Payment method must belong to the payment journal';
  if (line.payment_type !== payment.payment_type) return 'Payment method direction must match the payment type';
  return null;
}

/** Create default method lines for `journal` on any direction that currently has none. */
export function ensureJournalDefaultMethodLines(db, journal, direction = null) {
  if (!journal || !isMethodLineJournal(journal)) return db;
  let next = db;
  const directions = direction ? [direction] : ['inbound', 'outbound'];
  for (const dir of directions) {
    const hasAny = ownedMethodLines(next, journal.id, { includeArchived: true }).some((l) => l.payment_type === dir);
    if (hasAny) continue;
    for (const spec of defaultMethodSpecsForJournal(journal.type).filter((s) => s.payment_type === dir)) {
      const method = findPaymentMethod(next, spec.code, spec.payment_type);
      if (!method) continue;
      next = create(next, 'account.payment.method.line', {
        name: method.name,
        payment_method_id: method.id,
        journal_id: journal.id,
        payment_type: method.payment_type,
        sequence: spec.sequence,
        company_id: journal.company_id ?? 1,
      }).db;
    }
  }
  return next;
}

/** Migration helper: seed reference payment methods and add default lines to existing bank/cash journals. */
export function migratePaymentMethods(db) {
  let next = ensurePaymentMethods(db);
  for (const journal of search(next, 'account.journal', { includeArchived: true })) {
    if (isMethodLineJournal(journal)) {
      next = ensureJournalDefaultMethodLines(next, journal);
    }
  }
  // Payments created before method lines existed get their journal's default line, so they can still be posted.
  const payments = (next.records?.['account.payment'] ?? []).map((p) => {
    if (p.payment_method_line_id) return p;
    const jId = p.journal_id ?? defaultPaymentJournalId(next, p.company_id ?? 1);
    const journal = jId ? read(next, 'account.journal', jId) : null;
    if (!journal || !isMethodLineJournal(journal)) return p;
    const lineId = defaultPaymentMethodLineId(next, journal.id, p.payment_type ?? 'inbound');
    return lineId ? { ...p, payment_method_line_id: lineId } : p;
  });
  if (payments.length) next = { ...next, records: { ...next.records, 'account.payment': payments } };
  return next;
}

/** Compute inline one2many rows for `inbound_payment_method_line_ids` / `outbound_payment_method_line_ids` on `account.journal`. */
export function computeJournalMethodLines(journal, db, direction) {
  const field = direction === 'inbound' ? 'inbound_payment_method_line_ids' : 'outbound_payment_method_line_ids';
  if (!journal?.id || !db) return Array.isArray(journal?.[field]) ? journal[field] : [];
  return journalMethodLines(db, journal.id, direction).map((l) => ({
    id: l.id,
    sequence: l.sequence ?? 10,
    payment_method_id: l.payment_method_id,
    name: l.name,
    payment_account_id: l.payment_account_id ?? null,
  }));
}

/** Default unsaved row when clicking "Add a line" on a journal's payment method tab. */
export function defaultNewJournalMethodLine(db, direction) {
  const method = findPaymentMethod(db, 'manual', direction)
    ?? search(db, 'account.payment.method').find((m) => m.payment_type === direction)
    ?? null;
  return {
    sequence: 10,
    payment_method_id: method?.id ?? null,
    name: method?.name ?? '',
    payment_account_id: null,
  };
}

/** Default inline lines when switching a new journal's type on the form before saving. */
export function defaultJournalLinesForForm(db, journalType, direction) {
  return defaultMethodSpecsForJournal(journalType)
    .filter((s) => s.payment_type === direction)
    .flatMap((s) => {
      const method = findPaymentMethod(db, s.code, s.payment_type);
      return method ? [{ sequence: s.sequence, payment_method_id: method.id, name: method.name, payment_account_id: null }] : [];
    });
}

/** Update a journal method line's name when its payment method changes. */
export function methodLineOnchange(line, key, db) {
  if (key !== 'payment_method_id' || !db) return line;
  const method = line.payment_method_id ? read(db, 'account.payment.method', line.payment_method_id) : null;
  if (!method) return line;
  return { ...line, name: method.name };
}

function validateJournalLinesForDirection(db, journal, lines, direction) {
  if (!Array.isArray(lines)) return 'Invalid payment method lines';
  if (lines.length > 0 && !isMethodLineJournal(journal)) return 'Payment method lines are only valid for bank and cash journals';
  const existingAll = ownedMethodLines(db, journal.id, { includeArchived: true }).filter((l) => l.payment_type === direction);
  const existingIds = new Set(existingAll.map((l) => l.id));
  const seenIds = new Set();
  for (const line of lines) {
    if (!line || typeof line !== 'object' || Array.isArray(line)) return 'Invalid payment method line';
    if (line.id != null && line.id !== '' && line.id !== false) {
      if (!Number.isInteger(line.id) || line.id < 1 || !existingIds.has(line.id)) {
        return 'Payment method line does not belong to this journal';
      }
      if (seenIds.has(line.id)) return 'Duplicate payment method line';
      seenIds.add(line.id);
    }
    const method = line.payment_method_id ? read(db, 'account.payment.method', line.payment_method_id) : null;
    if (!method) return 'Select an existing payment method';
    if (method.payment_type !== direction) return 'Payment method line direction must match its payment method';
    if (!String(line.name ?? '').trim()) return 'Name is required';
    const accErr = paymentAccountError(db, line.payment_account_id, journal.company_id ?? 1);
    if (accErr) return accErr;
  }
  const existingActive = existingAll.filter((l) => l.active !== false);
  for (const oldLine of existingActive) {
    if (!seenIds.has(oldLine.id)) {
      const blocked = protectMethodLineDelete(db, oldLine);
      if (blocked) return blocked;
    }
  }
  return null;
}

/** Validate `account.journal` changes affecting payment method lines (both ORM and diff+sync). */
export function journalMethodLineGuard(db, before, after, vals) {
  for (const [field, direction] of METHOD_LINE_FIELDS) {
    const hasField = vals ? Object.hasOwn(vals, field) : (!before && Array.isArray(after[field]));
    if (hasField) {
      const err = validateJournalLinesForDirection(db, after, vals?.[field] ?? after[field], direction);
      if (err) return err;
    }
  }
  if (before?.id) {
    const ownLines = ownedMethodLines(db, before.id, { includeArchived: true });
    if (ownLines.length && !isMethodLineJournal(after)) {
      const blocked = ownLines.map((l) => protectMethodLineDelete(db, l)).find(Boolean);
      if (blocked) return blocked;
      return 'Clear or delete payment method lines before changing journal type away from bank or cash';
    }
    if (after.company_id !== before.company_id) {
      for (const line of ownLines) {
        const err = paymentAccountError(db, line.payment_account_id, after.company_id ?? 1);
        if (err) return err;
      }
    }
  }
  return null;
}

const stripJournalMethodLineFields = (db, journalId) => ({
  ...db,
  records: {
    ...db.records,
    'account.journal': (db.records?.['account.journal'] ?? []).map((j) => {
      if (j.id !== journalId || (!Object.hasOwn(j, 'inbound_payment_method_line_ids') && !Object.hasOwn(j, 'outbound_payment_method_line_ids'))) return j;
      const { inbound_payment_method_line_ids: _in, outbound_payment_method_line_ids: _out, ...rest } = j;
      return rest;
    }),
  },
});

function syncDirectionLines(db, journal, lines, direction) {
  let next = db;
  const existingActive = ownedMethodLines(next, journal.id).filter((l) => l.payment_type === direction);
  const keepIds = new Set(lines.map((l) => l.id).filter(Boolean));
  const removeIds = existingActive.filter((l) => !keepIds.has(l.id)).map((l) => l.id);
  if (removeIds.length) next = unlink(next, 'account.payment.method.line', removeIds);
  for (const line of lines) {
    const payload = {
      name: line.name,
      payment_method_id: line.payment_method_id,
      payment_account_id: line.payment_account_id ?? null,
      sequence: line.sequence ?? 10,
      payment_type: direction,
    };
    if (line.id) {
      next = write(next, 'account.payment.method.line', line.id, payload);
    } else {
      next = create(next, 'account.payment.method.line', {
        ...payload,
        journal_id: journal.id,
        company_id: journal.company_id ?? 1,
      }).db;
    }
  }
  return next;
}

/** Synchronize `account.payment.method.line` records after `account.journal` create or write. */
export function syncJournalMethodLines(db, journal, vals, before = null) {
  let next = stripJournalMethodLineFields(db, journal.id);
  for (const [field, direction] of METHOD_LINE_FIELDS) {
    if (vals && Object.hasOwn(vals, field)) {
      next = syncDirectionLines(next, journal, vals[field], direction);
    } else if (isMethodLineJournal(journal) && (!before || before.type !== journal.type)) {
      next = ensureJournalDefaultMethodLines(next, journal, direction);
    }
  }
  if (before && before.company_id !== journal.company_id) {
    const companyId = journal.company_id ?? 1;
    for (const line of ownedMethodLines(next, journal.id, { includeArchived: true })) {
      if (line.company_id !== companyId) next = write(next, 'account.payment.method.line', line.id, { company_id: companyId });
    }
  }
  return next;
}

/** Unlink all payment method lines owned by a journal being deleted. */
export function unlinkJournalMethodLines(db, journal) {
  const lineIds = ownedMethodLines(db, journal.id, { includeArchived: true }).map((l) => l.id);
  return lineIds.length ? unlink(db, 'account.payment.method.line', lineIds) : db;
}

export const paymentMethodModels = {
  'account.payment.method': {
    label: 'Payment Methods',
    views: ['list'],
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      code: {
        type: 'selection',
        label: 'Code',
        required: true,
        options: [['manual', 'Manual'], ['check_printing', 'Checks']],
      },
      payment_type: {
        type: 'selection',
        label: 'Payment Type',
        required: true,
        options: [['inbound', 'Inbound'], ['outbound', 'Outbound']],
      },
    },
    defaults: () => ({ code: 'manual', payment_type: 'inbound' }),
    searchFields: ['name', 'code', 'payment_type'],
    list: ['name', 'code', 'payment_type'],
    form: {
      title: 'name',
      groups: [['name', 'code', 'payment_type']],
    },
  },

  'account.payment.method.line': {
    label: 'Payment Method Lines',
    views: ['list'],
    fields: {
      sequence: { type: 'integer', label: 'Sequence', widget: 'handle' },
      name: { type: 'char', label: 'Name', required: true },
      payment_method_id: { type: 'many2one', relation: 'account.payment.method', label: 'Payment Method', required: true },
      journal_id: {
        type: 'many2one',
        relation: 'account.journal',
        label: 'Journal',
        required: true,
        domain: (j) => isMethodLineJournal(j),
      },
      payment_type: {
        type: 'selection',
        label: 'Payment Type',
        readonly: true,
        options: [['inbound', 'Inbound'], ['outbound', 'Outbound']],
      },
      payment_account_id: {
        type: 'many2one',
        relation: 'account.account',
        label: 'Outstanding Account',
        domain: methodLineAccountDomain,
      },
    },
    defaults: () => ({ sequence: 10 }),
    createDefaults: (db, vals = {}) => {
      const journal = vals.journal_id ? read(db, 'account.journal', vals.journal_id) : null;
      const method = vals.payment_method_id ? read(db, 'account.payment.method', vals.payment_method_id) : null;
      return {
        company_id: journal?.company_id ?? currentCompany(db),
        ...(method?.payment_type ? { payment_type: method.payment_type } : {}),
        ...(vals.name === undefined && method?.name ? { name: method.name } : {}),
      };
    },
    onchange: (r, key, db) => {
      if (key === 'payment_method_id' && db) {
        const method = r.payment_method_id ? read(db, 'account.payment.method', r.payment_method_id) : null;
        return {
          payment_type: method?.payment_type ?? null,
          ...(!r.name && method?.name ? { name: method.name } : {}),
        };
      }
      return {};
    },
    guard: paymentMethodLineGuard,
    protectDelete: protectMethodLineDelete,
    sort: (a, b) => (a.sequence ?? 10) - (b.sequence ?? 10) || (a.id ?? 0) - (b.id ?? 0),
    searchFields: ['name', 'journal_id', 'payment_method_id', 'payment_type'],
    list: ['sequence', 'name', 'journal_id', 'payment_method_id', 'payment_type', 'payment_account_id'],
    form: {
      title: 'name',
      groups: [['name', 'payment_method_id', 'journal_id'], ['payment_type', 'payment_account_id', 'sequence']],
    },
  },
};
