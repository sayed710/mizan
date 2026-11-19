import { create, read, unlink, write } from '../orm.js';
import { companyCurrencyRecord, roundCurrency } from '../money.js';
import { validDate } from './common.js';
import { importStatementLines } from './statements.js';
import { journalCompany } from './ledger.js';

const LINK_MODEL = 'account.online.link';
const ACCOUNT_MODEL = 'account.online.account';
const LINE_MODEL = 'account.bank.statement.line';

const providerRegistry = new Map();
const providerOptions = [];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/**
 * Register an online synchronization provider adapter.
 *
 * Provider contract:
 * `adapter.fetchTransactions(account, cursor, connection)` must return
 * `{ transactions, nextCursor, balance? }`, where:
 * - `transactions` is an array of `{ unique_import_id: non-empty string, date: 'YYYY-MM-DD', amount: finite non-zero number, payment_ref?: string, partner_id?, narration?, ref? }`
 * - `nextCursor` is a string cursor to persist on the account (`''` when empty)
 * - `balance` (optional) is a finite number for the online account balance
 */
export function registerOnlineSyncProvider(name, adapter, label = null) {
  if (!name || typeof name !== 'string') throw new Error('Provider name is required');
  if (!adapter || typeof adapter.fetchTransactions !== 'function') throw new Error('Provider adapter must implement fetchTransactions');
  const displayLabel = label || name;
  providerRegistry.set(name, adapter);
  const existing = providerOptions.find((o) => o[0] === name);
  if (existing) existing[1] = displayLabel;
  else providerOptions.push([name, displayLabel]);
  return adapter;
}

/** Look up a registered online synchronization provider adapter by key, or `null` when unknown. */
export function getOnlineSyncProvider(name) {
  return providerRegistry.get(name) ?? null;
}

/** Whether `name` corresponds to a registered online synchronization provider. */
export function hasOnlineSyncProvider(name) {
  return providerRegistry.has(name);
}

/**
 * Built-in deterministic demo/sandbox provider adapter reading `connection.demo_transactions`.
 *
 * Expected `demo_transactions` shape:
 * `{ [accountNumber]: { [cursor]: { transactions, nextCursor, balance? } | { error } } }`
 * where `''` is the cursor for the first call. A missing account or cursor key returns no
 * transactions and preserves the current cursor.
 */
function demoFetchTransactions(account, cursor, connection) {
  const currentCursor = cursor ?? '';
  const feed = connection?.demo_transactions;
  if (feed == null) return { transactions: [], nextCursor: currentCursor };
  if (!isPlainObject(feed)) throw new Error('Demo feed payload must be an object keyed by account number');
  const accountKey = account?.account_number ?? '';
  if (!Object.hasOwn(feed, accountKey) || feed[accountKey] == null) {
    return { transactions: [], nextCursor: currentCursor };
  }
  const accountFeed = feed[accountKey];
  if (!isPlainObject(accountFeed)) throw new Error('Demo account feed must be an object keyed by cursor');
  if (!Object.hasOwn(accountFeed, currentCursor) || accountFeed[currentCursor] == null) {
    return { transactions: [], nextCursor: currentCursor };
  }
  const page = accountFeed[currentCursor];
  if (!isPlainObject(page)) throw new Error('Demo cursor page must be an object');
  if (page.error) throw new Error(String(page.error));
  return page;
}

registerOnlineSyncProvider('demo', { fetchTransactions: demoFetchTransactions }, 'Demo / Sandbox');

/** Return the active online bank account linked to `journalId`, if any. */
export function onlineAccountForJournal(db, journalId) {
  if (!db || !journalId) return null;
  return (db.records?.[ACCOUNT_MODEL] ?? []).find((a) => a.active !== false && a.journal_id === journalId) ?? null;
}

/** Return the cumulative statement running balance across all active statement lines of `journalId`. */
export function journalStatementBalance(db, journalId) {
  const journal = read(db, 'account.journal', journalId);
  const currency = (journal?.currency_id ? read(db, 'res.currency', journal.currency_id) : null)
    ?? (journal ? companyCurrencyRecord(db, journalCompany(journal)) : null);
  const total = (db.records?.[LINE_MODEL] ?? [])
    .filter((l) => l.active !== false && l.journal_id === journalId)
    .reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
  return currency ? roundCurrency(total, currency) : total;
}

/** Validate a statement journal linked to an online account or connection of `companyId`. */
function linkedJournalError(journal, companyId) {
  if (!journal) return 'Select an existing journal';
  if (!['bank', 'credit'].includes(journal.type)) return 'Only bank or credit card journals can be linked to an online account';
  if (journalCompany(journal) !== companyId) return 'The linked journal must belong to the same company as the connection';
  return null;
}

/** UI domain filter for linking a statement journal to an online connection or account. */
function linkedJournalDomain(journal, record, db) {
  const companyId = record?.company_id ?? db?._company;
  return ['bank', 'credit'].includes(journal.type) && (!companyId || journalCompany(journal) === companyId);
}

/** Validate an `account.online.account` record against its connection, company, journal type, and 1-to-1 uniqueness. */
export function onlineAccountGuard(db, before, after) {
  if (before && after.link_id !== before.link_id) {
    return 'Online account cannot be moved to another connection';
  }
  const link = after.link_id ? read(db, LINK_MODEL, after.link_id) : null;
  if (!link) return 'Select an existing online connection';
  const companyId = after.company_id ?? link.company_id ?? 1;
  if ((link.company_id ?? 1) !== companyId) return 'Online account and connection must belong to the same company';
  if (after.journal_id) {
    const journal = read(db, 'account.journal', after.journal_id);
    const journalErr = linkedJournalError(journal, companyId);
    if (journalErr) return journalErr;
    const duplicate = (db.records?.[ACCOUNT_MODEL] ?? []).find(
      (a) => a.id !== after.id && a.active !== false && a.journal_id === after.journal_id,
    );
    if (duplicate) return 'This journal is already linked to another online account';
  }
  return null;
}

/** Resolve the `bank_statements_source` value to restore when the last online account leaves `journal`. */
function restoredJournalStatementSource(journal) {
  const prev = journal.previous_bank_statements_source;
  if (prev === 'none' || !prev) return journal.type === 'bank' ? 'undefined' : undefined;
  return prev;
}

/** Keep `journal.bank_statements_source` synchronized with an online account link write/create/unlink. */
function syncJournalStatementSource(db, before, after) {
  let next = db;
  const leavingBeforeJournal = before?.journal_id
    && before.active !== false
    && (before.journal_id !== after?.journal_id || after?.active === false);
  if (leavingBeforeJournal) {
    const prevJournal = read(next, 'account.journal', before.journal_id);
    if (prevJournal && prevJournal.bank_statements_source === 'online_sync' && !onlineAccountForJournal(next, before.journal_id)) {
      next = write(next, 'account.journal', before.journal_id, {
        bank_statements_source: restoredJournalStatementSource(prevJournal),
        previous_bank_statements_source: null,
      });
    }
  }
  if (after?.journal_id && after.active !== false) {
    const journal = read(next, 'account.journal', after.journal_id);
    const newlyLinked = !before || before.journal_id !== after.journal_id || before.active === false;
    if (journal && (journal.bank_statements_source !== 'online_sync' || (newlyLinked && !journal.previous_bank_statements_source))) {
      next = write(next, 'account.journal', after.journal_id, {
        previous_bank_statements_source: journal.previous_bank_statements_source ?? (journal.bank_statements_source || 'none'),
        bank_statements_source: 'online_sync',
      });
    }
  }
  return next;
}

/** Link `accountId` to `journalId`, enforcing same-company, bank/credit type, and 1-to-1 journal rules. */
export function linkOnlineAccountJournal(db, accountId, journalId) {
  return write(db, ACCOUNT_MODEL, accountId, { journal_id: journalId });
}

const stripAccountIdsField = (db, linkId) => ({
  ...db,
  records: {
    ...db.records,
    [LINK_MODEL]: (db.records[LINK_MODEL] ?? []).map((r) => {
      if (r.id !== linkId || !Object.hasOwn(r, 'account_ids')) return r;
      const { account_ids: _omitted, ...rest } = r;
      return rest;
    }),
  },
});

/** Validate that inline `account_ids` rows only reference existing `account.online.account` IDs owned by `linkId`. */
function linkAccountLinesError(db, linkId, accountLines) {
  if (accountLines == null) return null;
  if (!Array.isArray(accountLines)) return 'Invalid online accounts payload';
  const existingIds = new Set(
    (db.records?.[ACCOUNT_MODEL] ?? []).filter((a) => a.link_id === linkId).map((a) => a.id),
  );
  const seenIds = new Set();
  for (const line of accountLines) {
    if (!line || typeof line !== 'object' || Array.isArray(line)) return 'Invalid online account row';
    if (line.id != null && line.id !== '' && line.id !== false) {
      if (!Number.isInteger(line.id) || line.id < 1 || !existingIds.has(line.id)) {
        return 'Online account does not belong to this connection';
      }
      if (seenIds.has(line.id)) return 'Duplicate online account in connection';
      seenIds.add(line.id);
    }
  }
  return null;
}

/** Synchronize `account.online.account` child records when editing `account_ids` on an `account.online.link` form. */
function syncLinkAccounts(db, link, accountLines) {
  let next = stripAccountIdsField(db, link.id);
  if (!Array.isArray(accountLines)) return next;
  const err = linkAccountLinesError(next, link.id, accountLines);
  if (err) throw new Error(err);
  const existing = (next.records?.[ACCOUNT_MODEL] ?? []).filter((a) => a.link_id === link.id);
  const keepIds = new Set(accountLines.map((l) => l.id).filter(Boolean));
  const removeIds = existing.filter((a) => !keepIds.has(a.id)).map((a) => a.id);
  if (removeIds.length) next = unlink(next, ACCOUNT_MODEL, removeIds);
  const editable = ['name', 'account_number', 'journal_id', 'balance', 'last_sync_cursor'];
  const pickValues = (line) => Object.fromEntries(
    editable.filter((k) => Object.hasOwn(line, k) && line[k] !== undefined).map((k) => [k, line[k]]),
  );
  for (const line of accountLines) {
    const vals = pickValues(line);
    if (line.id) next = write(next, ACCOUNT_MODEL, line.id, vals);
    else next = create(next, ACCOUNT_MODEL, { ...vals, link_id: link.id, company_id: link.company_id ?? 1 }).db;
  }
  return next;
}

/** Validate `account.online.link` provider, state, and optional inline `account_ids` rows before writing. */
function linkGuard(db, before, after, _ctx, vals) {
  if (!after.provider || !hasOnlineSyncProvider(after.provider)) {
    return 'Unknown online synchronization provider';
  }
  const accountLines = vals && Object.hasOwn(vals, 'account_ids') ? vals.account_ids : after?.account_ids;
  const linesErr = linkAccountLinesError(db, after.id, accountLines);
  if (linesErr) return linesErr;
  if (Array.isArray(accountLines)) {
    const companyId = after.company_id ?? 1;
    const seenJournals = new Set();
    const otherAccounts = (db.records?.[ACCOUNT_MODEL] ?? []).filter((a) => a.link_id !== after.id && a.active !== false);
    for (const line of accountLines) {
      if (line.journal_id) {
        if (seenJournals.has(line.journal_id)) return 'This journal is already linked to another online account';
        seenJournals.add(line.journal_id);
        const dup = otherAccounts.find((a) => a.journal_id === line.journal_id);
        if (dup) return 'This journal is already linked to another online account';
        const journal = read(db, 'account.journal', line.journal_id);
        const journalErr = linkedJournalError(journal, companyId);
        if (journalErr) return journalErr;
      }
    }
  }
  if (before && after.company_id !== before.company_id) {
    const linked = (db.records?.[ACCOUNT_MODEL] ?? []).some((a) => a.link_id === after.id && a.active !== false);
    if (linked) return 'Cannot change company while online accounts exist on this connection';
  }
  return null;
}

const validateTransaction = (tx) => {
  if (!tx || typeof tx !== 'object' || Array.isArray(tx)) {
    throw new Error('Provider transaction must be an object');
  }
  if (typeof tx.unique_import_id !== 'string' || !tx.unique_import_id.trim()) {
    throw new Error('Provider transaction is missing a non-empty unique_import_id');
  }
  if (!validDate(tx.date)) {
    throw new Error('Provider transaction has an invalid date (expected YYYY-MM-DD)');
  }
  if (typeof tx.amount !== 'number' || !Number.isFinite(tx.amount) || tx.amount === 0) {
    throw new Error('Provider transaction amount must be a finite non-zero number');
  }
  for (const [field, msg] of [
    ['payment_ref', 'Provider transaction payment_ref must be a string'],
    ['narration', 'Provider transaction narration must be a string'],
    ['ref', 'Provider transaction ref must be a string'],
  ]) {
    if (tx[field] !== undefined && tx[field] !== null && typeof tx[field] !== 'string') {
      throw new Error(msg);
    }
  }
  if (tx.partner_id !== undefined && tx.partner_id !== null && (!Number.isSafeInteger(tx.partner_id) || tx.partner_id < 1)) {
    throw new Error('Provider transaction partner_id must be a positive integer');
  }
};

const validateProviderResult = (result) => {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Provider response must be an object');
  }
  if (!Array.isArray(result.transactions)) {
    throw new Error('Provider response must include a transactions array');
  }
  if (typeof result.nextCursor !== 'string') {
    throw new Error('Provider response is missing nextCursor');
  }
  // Both undefined and null denote an absent optional balance; any supplied value must be a finite number.
  if (result.balance !== undefined && result.balance !== null && (typeof result.balance !== 'number' || !Number.isFinite(result.balance))) {
    throw new Error('Provider response balance must be a finite number');
  }
  const seenImportIds = new Set();
  for (const tx of result.transactions) {
    validateTransaction(tx);
    if (seenImportIds.has(tx.unique_import_id)) {
      throw new Error('Provider batch contains duplicate unique_import_id');
    }
    seenImportIds.add(tx.unique_import_id);
  }
};

const normalizeTransaction = (tx, account) => ({
  unique_import_id: tx.unique_import_id,
  date: tx.date,
  amount: tx.amount,
  payment_ref: tx.payment_ref || '/',
  ...(account.account_number ? { account_number: String(account.account_number) } : {}),
  ...(tx.partner_id != null ? { partner_id: tx.partner_id } : {}),
  ...(tx.narration != null && tx.narration !== '' ? { narration: tx.narration } : {}),
  ...(tx.ref != null && tx.ref !== '' ? { ref: tx.ref } : {}),
});

const failConnection = (db, linkId, message) => ({
  db: write(db, LINK_MODEL, linkId, { state: 'error', error_message: message }),
  count: 0,
  error: message,
});

/** Fetch transactions across `accounts`, staging all writes so mid-sync failures leave no partial state. */
function runSyncForAccounts(db, link, accounts, { now = new Date().toISOString() } = {}) {
  if (link.state === 'disconnected') throw new Error('Reconnect the online connection before fetching transactions');
  const provider = getOnlineSyncProvider(link.provider);
  if (!provider) return failConnection(db, link.id, 'Unknown online synchronization provider');

  const linkedAccounts = accounts.filter((a) => a.active !== false && a.journal_id);
  if (!linkedAccounts.length) {
    throw new Error('Link an online account to a bank journal first');
  }
  let stagedDb = db;
  let totalCreated = 0;

  try {
    const fetched = linkedAccounts.map((account) => {
      const result = provider.fetchTransactions(account, account.last_sync_cursor ?? '', link);
      validateProviderResult(result);
      return { account, result };
    });

    for (const { account, result } of fetched) {
      const txs = result.transactions.map((tx) => normalizeTransaction(tx, account));
      const imported = importStatementLines(stagedDb, txs, {
        journal_id: account.journal_id,
        company_id: link.company_id ?? 1,
      }, { exactJournalOnly: true });
      stagedDb = imported.db;
      totalCreated += imported.count;

      const nextBalance = result.balance != null
        ? result.balance
        : journalStatementBalance(stagedDb, account.journal_id);
      stagedDb = write(stagedDb, ACCOUNT_MODEL, account.id, {
        balance: nextBalance,
        last_sync_cursor: result.nextCursor,
      });
    }

    stagedDb = write(stagedDb, LINK_MODEL, link.id, {
      state: 'connected',
      error_message: '',
      last_refresh: now,
    });
    return { db: stagedDb, count: totalCreated, error: null };
  } catch (error) {
    return failConnection(db, link.id, error instanceof Error ? error.message : String(error));
  }
}

/** Fetch transactions for every linked online account belonging to `linkId`. */
export function syncOnlineConnection(db, linkId, opts = {}) {
  const link = read(db, LINK_MODEL, linkId);
  if (!link) throw new Error('Online synchronization connection not found');
  const accounts = (db.records?.[ACCOUNT_MODEL] ?? []).filter((a) => a.link_id === linkId && a.active !== false);
  return runSyncForAccounts(db, link, accounts, opts);
}

/** Fetch transactions for a single online bank account `accountId`. */
export function syncOnlineAccount(db, accountId, opts = {}) {
  const account = read(db, ACCOUNT_MODEL, accountId);
  if (!account) throw new Error('Online bank account not found');
  const link = read(db, LINK_MODEL, account.link_id);
  if (!link) throw new Error('Online synchronization connection not found');
  return runSyncForAccounts(db, link, [account], opts);
}

/** Fetch transactions for whichever online bank account is linked to `journalId`. */
export function syncOnlineJournal(db, journalId, opts = {}) {
  const account = onlineAccountForJournal(db, journalId);
  if (!account) throw new Error('No online account is linked to this journal');
  return syncOnlineAccount(db, account.id, opts);
}

/** Reconnect an online sync link: transitions to connected if previously synchronized, or not_synchronized if never refreshed. */
export function reconnectOnlineConnection(db, linkId) {
  const link = read(db, LINK_MODEL, linkId);
  if (!link) throw new Error('Online synchronization connection not found');
  const state = link.last_refresh ? 'connected' : 'not_synchronized';
  return write(db, LINK_MODEL, linkId, { state, error_message: '' });
}

const computeLinkAccounts = (r, db) => (db?.records?.[ACCOUNT_MODEL] ?? [])
  .filter((a) => a.link_id === r?.id && a.active !== false)
  .map((a) => {
    const rec = read(db, ACCOUNT_MODEL, a.id);
    return {
      id: rec.id,
      name: rec.name,
      account_number: rec.account_number ?? '',
      balance: rec.balance ?? 0,
      last_sync_cursor: rec.last_sync_cursor ?? '',
      journal_id: rec.journal_id ?? null,
    };
  });

export const onlineSyncModels = {
  [LINK_MODEL]: {
    label: 'Online Synchronization',
    fields: {
      name: { type: 'char', label: 'Connection Name', required: true },
      provider: { type: 'selection', label: 'Provider', required: true, options: providerOptions },
      state: {
        type: 'selection',
        label: 'Status',
        readonly: true,
        tracking: true,
        badge: { not_synchronized: 'muted', connected: 'success', error: 'danger', disconnected: 'muted' },
        options: [
          ['not_synchronized', 'Not Synchronized'],
          ['connected', 'Connected'],
          ['error', 'Error'],
          ['disconnected', 'Disconnected'],
        ],
      },
      last_refresh: { type: 'datetime', label: 'Last Refresh', readonly: true },
      error_message: { type: 'text', label: 'Error Message', readonly: true },
      demo_transactions: { type: 'json', label: 'Demo Feed Payload', hidden: true },
      account_ids: {
        type: 'one2many',
        relation: ACCOUNT_MODEL,
        label: 'Online Accounts',
        editable: true,
        compute: computeLinkAccounts,
        fields: {
          id: { type: 'integer', label: 'ID', hidden: true },
          name: { type: 'char', label: 'Account Name', required: true },
          account_number: { type: 'char', label: 'Account Number' },
          balance: { type: 'monetary', label: 'Balance', readonly: true },
          last_sync_cursor: { type: 'char', label: 'Last Cursor', readonly: true },
          journal_id: {
            type: 'many2one',
            relation: 'account.journal',
            label: 'Linked Journal',
            domain: linkedJournalDomain,
          },
        },
        newLine: () => ({ name: '', account_number: '', balance: 0, last_sync_cursor: '', journal_id: null }),
      },
    },
    defaults: () => ({
      name: 'Demo Bank',
      provider: 'demo',
      state: 'not_synchronized',
      last_refresh: null,
      error_message: '',
      demo_transactions: null,
    }),
    guard: linkGuard,
    onCreate: (db, after, _before, vals) => syncLinkAccounts(db, after, vals?.account_ids),
    onWrite: (db, after, _before, vals) => syncLinkAccounts(db, after, vals?.account_ids),
    onUnlink: (db, removed) => {
      const childIds = (db.records?.[ACCOUNT_MODEL] ?? []).filter((a) => a.link_id === removed.id).map((a) => a.id);
      return childIds.length ? unlink(db, ACCOUNT_MODEL, childIds) : db;
    },
    filters: [[
      { id: 'not_synchronized', label: 'Not Synchronized', fn: (r) => r.state === 'not_synchronized' },
      { id: 'connected', label: 'Connected', fn: (r) => r.state === 'connected' },
      { id: 'error', label: 'Error', fn: (r) => r.state === 'error' },
      { id: 'disconnected', label: 'Disconnected', fn: (r) => r.state === 'disconnected' },
    ]],
    groupBys: ['provider', 'state', 'company_id'],
    list: ['name', 'provider', 'state', 'last_refresh', 'error_message'],
    form: {
      title: 'name',
      statusbar: 'state',
      buttons: [
        { label: 'Fetch Transactions', primary: true, when: (r) => Boolean(r?.id) && r.state !== 'disconnected', run: (db, r) => ({ db: syncOnlineConnection(db, r.id).db }) },
        { label: 'Disconnect', when: (r) => Boolean(r?.id) && r.state !== 'disconnected', vals: { state: 'disconnected' } },
        { label: 'Reconnect', when: (r) => Boolean(r?.id) && r.state === 'disconnected', run: (db, r) => ({ db: reconnectOnlineConnection(db, r.id) }) },
      ],
      groups: [['name', 'provider'], ['last_refresh', 'error_message']],
      tabs: [{ label: 'Online Accounts', fields: ['account_ids'] }],
      chatter: true,
    },
  },

  [ACCOUNT_MODEL]: {
    label: 'Online Bank Account',
    fields: {
      name: { type: 'char', label: 'Account Name', required: true },
      link_id: { type: 'many2one', relation: LINK_MODEL, label: 'Connection', required: true },
      account_number: { type: 'char', label: 'Account Number' },
      balance: { type: 'monetary', label: 'Balance', readonly: true },
      last_sync_cursor: { type: 'char', label: 'Last Cursor', readonly: true },
      journal_id: {
        type: 'many2one',
        relation: 'account.journal',
        label: 'Linked Journal',
        domain: linkedJournalDomain,
      },
    },
    defaults: () => ({ account_number: '', balance: 0, last_sync_cursor: '', journal_id: null }),
    createDefaults: (db, vals) => {
      const link = vals?.link_id ? read(db, LINK_MODEL, vals.link_id) : null;
      return link?.company_id ? { company_id: link.company_id } : {};
    },
    guard: onlineAccountGuard,
    onCreate: (db, after) => syncJournalStatementSource(db, null, after),
    onWrite: (db, after, before) => syncJournalStatementSource(db, before, after),
    onUnlink: (db, removed) => syncJournalStatementSource(db, removed, null),
    list: ['name', 'link_id', 'account_number', 'journal_id', 'balance', 'last_sync_cursor'],
    form: {
      title: 'name',
      buttons: [
        { label: 'Fetch Transactions', primary: true, when: (r) => Boolean(r?.id) && Boolean(r.journal_id), run: (db, r) => ({ db: syncOnlineAccount(db, r.id).db }) },
      ],
      groups: [['name', 'link_id', 'account_number'], ['journal_id', 'balance', 'last_sync_cursor']],
    },
  },
};
