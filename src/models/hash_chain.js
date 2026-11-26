// Inalterability hash chain for secure entries (Odoo 20 accounting parity).
import { read, search, write } from '../orm.js';
import { currentCompany } from './company.js';
import { resolveDocumentJournal } from './ledger.js';
import { today } from './common.js';
import { moveDate } from './finance.js';
import { t } from '../i18n.js';

/** Synchronous UTF-8 SHA-256 for browser, ORM, and Node execution. */
export function sha256(text) {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  const data = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  data.set(bytes);
  data[bytes.length] = 128;
  const view = new DataView(data.buffer);
  view.setUint32(data.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(data.length - 4, bytes.length * 8);
  const primes = [];
  for (let n = 2; primes.length < 64; n++) if (!primes.some((p) => n % p === 0)) primes.push(n);
  const h = primes.slice(0, 8).map((p) => (Math.sqrt(p) % 1 * 2 ** 32) | 0);
  const k = primes.map((p) => (Math.cbrt(p) % 1 * 2 ** 32) | 0);
  const rotate = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < data.length; offset += 64) {
    const w = Array.from({ length: 64 }, (_, i) => (i < 16 ? view.getInt32(offset + i * 4) : 0));
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      w[i] = (w[i - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + w[i - 7] + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) | 0;
    }
    let [a, b, c, d, e, f, g, z] = h;
    for (let i = 0; i < 64; i++) {
      const t = (z + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i]) | 0;
      const u = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      [a, b, c, d, e, f, g, z] = [(t + u) | 0, a, b, c, (d + t) | 0, e, f, g];
    }
    [a, b, c, d, e, f, g, z].forEach((v, i) => { h[i] = (h[i] + v) | 0; });
  }
  return h.map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

/**
 * Computes SHA-256 over an entry's immutable content:
 * date, journal, name/sequence, company, partner, amounts and accounts of every line,
 * in a fixed field order concatenated with the previous entry's hash in the same journal chain.
 */
// Version 1 is the original deployed payload. Missing version denotes version 1.
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v ?? null;
export function computeMoveHash(move, previousHash = '', version = move.inalterable_hash_version ?? 1) {
  const date = move.invoice_date ?? move.date ?? '';
  const journal = String(move.journal_id ?? '');
  const name = String(move.name ?? '');
  const company = String(move.company_id ?? 1);
  const partner = String(move.partner_id ?? '');
  if (version === 1) {
    const lines = (move.line_ids ?? []).map((l) => [l.account_id ?? null, Number(l.debit || 0), Number(l.credit || 0)]);
    return sha256(JSON.stringify([date, journal, name, company, partner, lines, previousHash]));
  }
  if (version !== 2 && version !== 3) return null;
  const lineFields = ['name', 'account_id', 'partner_id', 'debit', 'credit', 'amount_currency', 'currency_id', 'tax_name', 'tax_base', 'tax_side', 'tax_zero', 'tax_id', 'tax_ids', 'tax_tag_ids', 'tag_ids', 'analytic_distribution'];
  const lines = (move.line_ids ?? []).map((line) => lineFields.map((field) => canonical(line[field])));
  return sha256(JSON.stringify([version, ...(version === 3 ? [move.ref ?? null] : []), move.invoice_date ?? null, move.date ?? null, journal, name, company, partner, move.move_type ?? null, move.reversed_entry_id ?? null, move.reversal_move_id ?? null, move.correction_of_id ?? null, move.is_closing ?? null, move.currency_id ?? null, move.fiscal_position_id ?? null, canonical(move.invoice_line_ids ?? []), lines, previousHash]));
}

// Early unversioned snapshots used a delimiter-based payload before version 1 was frozen.
function validMoveHash(move, previous) {
  if (computeMoveHash(move, previous) === move.inalterable_hash) return true;
  if (move.inalterable_hash_version != null) return false;
  const lines = (move.line_ids ?? []).map((l) => `${l.account_id ?? ''}:${Number(l.debit || 0).toFixed(2)}:${Number(l.credit || 0).toFixed(2)}`).join(',');
  const payload = `${previous}|${move.invoice_date ?? move.date ?? ''}|${move.journal_id ?? ''}|${move.name ?? ''}|${move.company_id ?? 1}|${move.partner_id ?? ''}|${lines}`;
  return sha256(payload) === move.inalterable_hash;
}

const SEQUENCE_REGEX = /^(.*\D)(\d+)$/;

function moveSequencePrefix(move, journal) {
  const match = SEQUENCE_REGEX.exec(move?.name ?? '');
  if (match) return match[1];
  return journal?.invoice_sequence_prefix || journal?.code || journal?.name || '';
}

function journalOwnershipIndex(db) {
  const moves = (db.records['account.move'] ?? []).filter((m) => m.inalterable_hash);
  const byId = new Map(moves.map((m) => [m.id, m]));
  const byCompanySequence = new Map();
  for (const move of moves) {
    const key = `${move.company_id ?? 1}:${move.secure_sequence_number}`;
    if (!byCompanySequence.has(key)) byCompanySequence.set(key, []);
    byCompanySequence.get(key).push(move);
  }
  const owners = new Map();
  for (const journal of db.records['account.journal'] ?? []) {
    for (const head of journal.secure_chain_heads ?? []) {
      let current = byId.get(head.last_move_id);
      if (!current || (current.company_id ?? 1) !== head.company_id || current.inalterable_hash !== head.last_hash) continue;
      while (current) {
        const owner = owners.get(current.id);
        if (owner === undefined) owners.set(current.id, journal.id);
        else if (owner !== journal.id) owners.set(current.id, null);
        const candidates = byCompanySequence.get(`${head.company_id}:${current.secure_sequence_number - 1}`) ?? [];
        const previous = candidates.filter((m) => validMoveHash(current, m.inalterable_hash));
        current = previous.length === 1 ? previous[0] : null;
      }
    }
  }
  return owners;
}

function moveJournalId(db, move, owners = null) {
  if (move?.journal_id != null) return move.journal_id;
  if (move?.inalterable_hash) return (typeof owners === 'function' ? owners() : owners ?? journalOwnershipIndex(db)).get(move.id) ?? null;
  return resolveDocumentJournal(db, move)?.id ?? null;
}

function isSequenceConflictDraft(db, move, company, lastSecuredNameByJournal) {
  if ((move.company_id ?? 1) !== company || move.state !== 'draft') return false;
  if (!move.name || move.name === '/') return false;
  const lastSecuredName = lastSecuredNameByJournal.get(moveJournalId(db, move));
  return lastSecuredName != null && (move.name ?? '').localeCompare(lastSecuredName) <= 0;
}

const WARNING_ORDER = { danger: 0, warning: 1, info: 2 };

/** Finds sequence gaps in a list of moves sorted by sequence. */
export function findSequenceGaps(moves) {
  const gaps = [];
  let prevPrefix = null;
  let prevNum = null;
  for (const m of moves) {
    const match = SEQUENCE_REGEX.exec(m.name ?? '');
    if (!match) continue;
    const [, prefix, numStr] = match;
    const num = Number(numStr);
    if (prevPrefix === prefix && prevNum != null && num > prevNum + 1) {
      gaps.push({ prefix, from: prevNum + 1, to: num - 1 });
    }
    prevPrefix = prefix;
    prevNum = num;
  }
  return gaps;
}

/**
 * Analyses journal chains to report:
 * - unhashed posted moves to be secured
 * - unreconciled bank statement lines blocking their journal prefixes
 * - draft moves dated before/on hashDate that cannot be hashed
 * - gaps in sequences
 * - max date
 * - actionable warnings with Odoo 20 levels and action targets
 */
export function analyzeJournalChains(db, { companyId = null, hashDate = null } = {}) {
  const owners = journalOwnershipIndex(db);
  const company = companyId ?? currentCompany(db);
  const companyRec = read(db, 'res.company', company);
  const allJournals = search(db, 'account.journal', { includeArchived: true });
  const journalById = new Map(allJournals.map((j) => [j.id, j]));
  // The wizard asks Odoo for chains with force_hash=True, including journals without hash-on-post.
  const restrictedJournals = allJournals;
  const restrictedIds = new Set(allJournals.map((j) => j.id));

  const allMoves = (db.records['account.move'] ?? []).filter((m) => {
    if ((m.company_id ?? 1) !== company) return false;
    const jId = moveJournalId(db, m, owners);
    return restrictedIds.has(jId);
  });

  const postedDates = allMoves.filter((m) => m.state === 'posted').map((m) => moveDate(m)).filter(Boolean);
  const maxDate = postedDates.length ? postedDates.sort().at(-1) : today();
  const targetDate = hashDate || maxDate;

  const companyUnhashedPosted = allMoves.filter(
    (m) => m.state === 'posted' && !m.inalterable_hash && (moveDate(m)) <= targetDate,
  );
  const companyUnhashedMoveMap = new Map(companyUnhashedPosted.map((m) => [m.id, m]));

  const unreconciledLines = (db.records['account.bank.statement.line'] ?? []).filter((l) => {
    if ((l.company_id ?? 1) !== company) return false;
    if (l.state === 'reconciled' || l.is_reconciled === true) return false;
    if (l.bank_move_id && companyUnhashedMoveMap.has(l.bank_move_id)) return true;
    return (l.date ?? '') <= targetDate && restrictedIds.has(l.journal_id);
  });

  const ignoredChainKeys = new Set();
  const ignoredJournalIds = new Set();
  const ignoredPrefixList = [];
  for (const line of unreconciledLines) {
    const linkedMove = line.bank_move_id ? (companyUnhashedMoveMap.get(line.bank_move_id) ?? read(db, 'account.move', line.bank_move_id)) : null;
    if (linkedMove) {
      const jId = linkedMove.journal_id ?? resolveDocumentJournal(db, linkedMove)?.id ?? line.journal_id;
      const prefix = moveSequencePrefix(linkedMove, journalById.get(jId));
      ignoredChainKeys.add(`${jId}:${prefix}`);
      if (prefix) ignoredPrefixList.push(prefix);
    } else if (line.journal_id) {
      ignoredJournalIds.add(line.journal_id);
      const journal = journalById.get(line.journal_id);
      const prefix = journal?.invoice_sequence_prefix || journal?.code || journal?.name || '';
      if (prefix) ignoredPrefixList.push(prefix);
    }
  }
  const ignoredPrefixes = [...new Set(ignoredPrefixList)];

  const chainsWithGaps = [];
  const gapMoveIds = [];
  const notHashablePostedIds = [];
  const unhashedPostedMoves = [];
  const lastNewlySecuredByJournal = new Map();
  const deferredByUnreconciledPrefixes = [];
  const deferredByLaterEntryPrefixes = [];

  for (const journal of restrictedJournals) {
    if (ignoredJournalIds.has(journal.id)) continue;
    const journalMoves = allMoves
      .filter((m) => moveJournalId(db, m, owners) === journal.id)
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.id - b.id);
    const journalPosted = journalMoves.filter((m) => m.state === 'posted');
    const journalLastHashed = journalPosted.filter((m) => Boolean(m.inalterable_hash)).at(-1);

    const byPrefix = new Map();
    for (const m of journalMoves) {
      const prefix = moveSequencePrefix(m, journal);
      if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
      byPrefix.get(prefix).push(m);
    }
    const prefixCandidates = [];
    for (const [prefix, allChainMoves] of byPrefix.entries()) {
      if (ignoredChainKeys.has(`${journal.id}:${prefix}`)) continue;
      const postedChain = allChainMoves.filter((m) => m.state === 'posted');
      const lastHashed = journalLastHashed ?? postedChain.filter((m) => Boolean(m.inalterable_hash)).at(-1);
      const localNotHashable = new Set();
      if (lastHashed) {
        for (const m of postedChain) {
          if (!m.inalterable_hash
            && (moveDate(m)) <= targetDate
            && (m.name ?? '').localeCompare(lastHashed.name ?? '') < 0
            && (moveDate(m)) > (companyRec?.hard_lock_date ?? '')) {
            notHashablePostedIds.push(m.id);
            localNotHashable.add(m.id);
          }
        }
      }
      const inDateUnhashed = postedChain.filter(
        (m) => !m.inalterable_hash && !localNotHashable.has(m.id) && (moveDate(m)) <= targetDate,
      );
      const lastInDate = inDateUnhashed.at(-1);
      const chainMovesToHash = lastInDate
        ? postedChain.filter(
          (m) => !m.inalterable_hash
            && !localNotHashable.has(m.id)
            && (m.name ?? '').localeCompare(lastInDate.name ?? '') <= 0
            && (!lastHashed || (m.name ?? '').localeCompare(lastHashed.name ?? '') > 0),
        )
        : [];
      prefixCandidates.push({ prefix, allChainMoves, chainMovesToHash });
    }
    const candidateIds = new Set(prefixCandidates.flatMap((c) => c.chainMovesToHash.map((m) => m.id)));
    const firstBlocker = journalPosted.find(
      (m) => !m.inalterable_hash
        && (!journalLastHashed || (m.name ?? '').localeCompare(journalLastHashed.name ?? '') > 0)
        && !candidateIds.has(m.id),
    );
    const blockerPrefix = firstBlocker ? moveSequencePrefix(firstBlocker, journal) : '';
    const blockedByUnreconciled = Boolean(firstBlocker && ignoredChainKeys.has(`${journal.id}:${blockerPrefix}`));

    let lastNewlySecuredName = null;
    for (const { prefix, allChainMoves, chainMovesToHash } of prefixCandidates) {
      const kept = firstBlocker
        ? chainMovesToHash.filter((m) => (m.name ?? '').localeCompare(firstBlocker.name ?? '') < 0)
        : chainMovesToHash;
      if (kept.length < chainMovesToHash.length && prefix) {
        (blockedByUnreconciled ? deferredByUnreconciledPrefixes : deferredByLaterEntryPrefixes).push(prefix);
      }
      if (!kept.length) continue;
      for (const m of kept) {
        unhashedPostedMoves.push(m);
        const moveName = m.name ?? '';
        if (lastNewlySecuredName === null || moveName.localeCompare(lastNewlySecuredName) > 0) {
          lastNewlySecuredName = moveName;
        }
      }
      const keptSet = new Set(kept.map((m) => m.id));
      const gapScope = allChainMoves.filter(
        (m) => (moveDate(m)) <= targetDate || keptSet.has(m.id),
      );
      const gaps = findSequenceGaps(gapScope);
      if (gaps.length) {
        chainsWithGaps.push(`${journal.code || journal.name}: ${gaps.map((g) => `${g.prefix}${g.from}..${g.to}`).join(', ')}`);
        for (const m of gapScope) gapMoveIds.push(m.id);
      }
    }
    if (lastNewlySecuredName !== null) {
      lastNewlySecuredByJournal.set(journal.id, lastNewlySecuredName);
    }
  }

  const unhashedDates = unhashedPostedMoves.map((m) => moveDate(m)).filter(Boolean);
  const rawLockDate = unhashedDates.length ? unhashedDates.sort().at(-1) : '';
  const proposedLockDate = rawLockDate && rawLockDate > targetDate ? targetDate : rawLockDate;

  const dateDraftMoves = [];
  const sequenceConflictDraftMoves = [];
  for (const m of db.records['account.move'] ?? []) {
    if ((m.company_id ?? 1) !== company || m.state !== 'draft') continue;
    const date = moveDate(m);
    const jId = moveJournalId(db, m, owners);
    if ((proposedLockDate && date <= proposedLockDate) || (restrictedIds.has(jId) && date <= targetDate)) {
      dateDraftMoves.push(m);
    } else if (isSequenceConflictDraft(db, m, company, lastNewlySecuredByJournal)) {
      sequenceConflictDraftMoves.push(m);
    }
  }
  const draftMoves = [...dateDraftMoves, ...sequenceConflictDraftMoves];

  const afterSelectedDateMoves = unhashedPostedMoves.filter((m) => (moveDate(m)) > targetDate);

  const warnings = [];
  const warningItems = [];
  const deferredUnreconciled = [...new Set(deferredByUnreconciledPrefixes)];
  const deferredLater = [...new Set(deferredByLaterEntryPrefixes)];

  if (unreconciledLines.length) {
    const baseMsg = t(
      'There are still unreconciled bank transactions before the selected date. The entries from journal prefixes containing them will not be secured: {prefixes}',
      { prefixes: ignoredPrefixes.join(', ') },
    );
    const msg = deferredUnreconciled.length
      ? `${baseMsg} ${t('Later prefixes in the same journal are also deferred until those earlier entries are reconciled: {prefixes}', { prefixes: deferredUnreconciled.join(', ') })}`
      : baseMsg;
    warnings.push(msg);
    warningItems.push({
      key: 'account_unreconciled_bank_statement_line_ids',
      level: 'danger',
      message: msg,
      action_text: 'Review Statements',
      go: `#/accounting/bank?view=list&rel=id:${unreconciledLines.map((l) => l.id).join(',')}`,
    });
  }
  if (deferredLater.length) {
    const msg = t(
      'Later prefixes cannot be secured while earlier prefixes still have unsecured entries after the selected date: {prefixes}',
      { prefixes: deferredLater.join(', ') },
    );
    warnings.push(msg);
    warningItems.push({
      key: 'account_deferred_prefixes',
      level: 'warning',
      message: msg,
    });
  }
  if (draftMoves.length) {
    if (dateDraftMoves.length) {
      warnings.push(t('{count} draft entries found before or on {date}. Draft entries cannot be hashed.', { count: dateDraftMoves.length, date: targetDate }));
    }
    if (sequenceConflictDraftMoves.length) {
      warnings.push(t('{count} numbered draft entries precede entries to be secured. Post or cancel them before securing.', { count: sequenceConflictDraftMoves.length }));
    }
    const draftMsg = dateDraftMoves.length && sequenceConflictDraftMoves.length
      ? t('There are still draft entries before the selected date and numbered draft entries in the sequence being secured.')
      : sequenceConflictDraftMoves.length
        ? t('There are numbered draft entries in the sequence being secured. Post or cancel them before securing.')
        : t('There are still draft entries before the selected date.');
    warningItems.push({
      key: 'account_unhashed_draft_entries',
      level: 'warning',
      message: draftMsg,
      action_text: 'Review Entries',
      go: `#/accounting/entries?view=list&rel=id:${draftMoves.map((m) => m.id).join(',')}`,
    });
  }
  if (notHashablePostedIds.length) {
    warningItems.push({
      key: 'account_not_hashable_unlocked_moves',
      level: 'warning',
      message: t('There are entries that cannot be hashed. They can be protected by the Hard Lock Date.'),
      action_text: 'Review Entries',
      go: `#/accounting/entries?view=list&rel=id:${notHashablePostedIds.join(',')}`,
    });
  }
  if (chainsWithGaps.length) {
    warnings.push(t('Sequence gaps detected: {gaps}.', { gaps: chainsWithGaps.join('; ') }));
    warningItems.push({
      key: 'account_sequence_gap',
      level: 'warning',
      message: t('Securing these entries will create at least one gap in the sequence.'),
      action_text: 'Review Entries',
      go: `#/accounting/entries?view=list&rel=id:${gapMoveIds.join(',')}`,
    });
  }
  if (afterSelectedDateMoves.length) {
    warningItems.push({
      key: 'account_move_to_secure_after_selected_date',
      level: 'warning',
      message: t('Securing these entries will also secure entries after the selected date.'),
      action_text: 'Review Entries',
      go: `#/accounting/entries?view=list&rel=id:${afterSelectedDateMoves.map((m) => m.id).join(',')}`,
    });
  }

  warningItems.sort((a, b) => (WARNING_ORDER[a.level ?? 'warning'] ?? 1) - (WARNING_ORDER[b.level ?? 'warning'] ?? 1));

  return {
    company,
    hash_date: targetDate,
    max_hash_date: maxDate,
    move_to_hash_ids: unhashedPostedMoves.map((m) => m.id),
    entries_count: unhashedPostedMoves.length,
    unreconciled_bank_statement_line_ids: unreconciledLines.map((l) => l.id),
    not_hashable_unlocked_move_ids: draftMoves.map((m) => m.id),
    chains_to_hash_with_gaps: chainsWithGaps.join('; '),
    warnings: warnings.join('\n'),
    warning_items: warningItems,
  };
}

/** Validates the trust boundary at the head of a secured journal chain without traversing full history. */
export function checkChainHeadCorruption(journal, company, securedMoves) {
  const head = (journal?.secure_chain_heads ?? []).find((h) => h.company_id === company);
  const lastSecured = securedMoves.at(-1);
  const preceding = securedMoves.length > 1 ? securedMoves.at(-2) : null;
  if (head) {
    if (head.count !== securedMoves.length || head.last_sequence !== securedMoves.length || !lastSecured) return true;
    if (head.last_hash !== lastSecured.inalterable_hash || head.last_move_id !== lastSecured.id || head.last_move_name !== lastSecured.name) return true;
  }
  if (lastSecured) {
    if (lastSecured.state !== 'posted' || lastSecured.secure_sequence_number !== securedMoves.length) return true;
    if (preceding && (preceding.state !== 'posted' || preceding.secure_sequence_number !== securedMoves.length - 1)) return true;
    const prevHash = preceding ? preceding.inalterable_hash : '';
    if (!validMoveHash(lastSecured, prevHash)) return true;
  }
  return false;
}

/**
 * Secures posted entries in journals with restrict_mode_hash_table up to hashDate.
 * Computes hashes and sequence numbers in sequence order. Like Odoo, it does not touch the company's hard lock date.
 * With `throughMoveId` (the entry form's Lock button) only that entry's journal is hashed, up to and including it,
 * and no company lock date changes.
 */
export function secureEntries(db, { companyId = null, hashDate = null, throughMoveId = null, moveIds = null } = {}) {
  const owners = journalOwnershipIndex(db);
  const through = throughMoveId ? read(db, 'account.move', throughMoveId) : null;
  if (throughMoveId && !through) throw new Error('Select an existing entry');
  const company = through ? (through.company_id ?? 1) : (companyId ?? currentCompany(db));
  const restrictedJournals = search(db, 'account.journal', { includeArchived: true })
    .filter((j) => (Array.isArray(moveIds) || Boolean(j.restrict_mode_hash_table)) && (!through || j.id === moveJournalId(db, through, owners)));
  const targetDate = hashDate || today();
  const moveIdSet = Array.isArray(moveIds) ? new Set(moveIds) : null;
  const inScope = (m) => (through ? (m.name ?? '').localeCompare(through.name ?? '') <= 0 : moveIdSet ? moveIdSet.has(m.id) : (moveDate(m)) <= targetDate);
  // A numbered draft before the entry (reset to draft keeps its number) would land unhashed inside the chain once re-posted.
  if (through && (db.records['account.move'] ?? []).some((m) => isSequenceConflictDraft(
    db, m, company, new Map([[moveJournalId(db, through, owners), through.name ?? '']]),
  ))) {
    throw new Error('Post or cancel the earlier draft entries of this journal before locking this entry');
  }

  let next = db;
  let securedThrough = '';
  const lastNewlySecuredByJournal = new Map();
  for (const journal of restrictedJournals) {
    const journalMoves = (next.records['account.move'] ?? [])
      .filter((m) => (m.company_id ?? 1) === company && moveJournalId(next, m, owners) === journal.id && m.state === 'posted')
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.id - b.id);
    const moves = journalMoves.filter(inScope);
    const securedMoves = journalMoves.filter((m) => m.inalterable_hash);
    if (checkChainHeadCorruption(journal, company, securedMoves)) throw new Error('Cannot extend a corrupted secure entry chain');
    const lastSecured = securedMoves.at(-1);
    let previousHash = lastSecured ? lastSecured.inalterable_hash : '';
    let lastSeqNum = lastSecured ? (lastSecured.secure_sequence_number || 0) : 0;

    const unhashed = moves.filter((m) => !m.inalterable_hash);
    if (unhashed.length && journalMoves.some((m) => !m.inalterable_hash
      && !unhashed.includes(m)
      && (!lastSecured || (m.name ?? '').localeCompare(lastSecured.name ?? '') > 0)
      && (m.name ?? '').localeCompare(unhashed.at(-1).name ?? '') < 0)) {
      throw new Error('Cannot secure entries while an earlier sequence remains unsecured');
    }
    if (lastSecured && unhashed.some((m) => (m.name ?? '').localeCompare(lastSecured.name ?? '') <= 0)) throw new Error('Cannot secure an entry before the last secured sequence');
    if (unhashed.length && !through) {
      lastNewlySecuredByJournal.set(journal.id, unhashed.at(-1).name ?? '');
    }
    for (const move of unhashed) {
      lastSeqNum += 1;
      const hash = computeMoveHash({ ...move, journal_id: journal.id }, previousHash, 3);
      next = write(next, 'account.move', move.id, {
        journal_id: journal.id,
        inalterable_hash: hash,
        secure_sequence_number: lastSeqNum,
        inalterable_hash_version: 3,
      });
    
      previousHash = hash;
      const date = moveDate(move);
      if (date > securedThrough) securedThrough = date;
    }
    if (unhashed.length || (securedMoves.length && !(journal.secure_chain_heads ?? []).some((h) => h.company_id === company))) {
      const priorHeads = journal.secure_chain_heads ?? [];
      const last = unhashed.at(-1) ?? lastSecured;
      const head = { company_id: company, count: lastSeqNum, last_sequence: lastSeqNum, last_hash: previousHash, last_move_id: last.id, last_move_name: last.name };
      next = write(next, 'account.journal', journal.id, { secure_chain_heads: [...priorHeads.filter((h) => h.company_id !== company), head] });
    }
  }

  const currentComp = read(next, 'res.company', company);
  if (!currentComp) throw new Error('Select an existing company');
  if (through) return next;
  const lockDate = hashDate && securedThrough > hashDate ? hashDate : securedThrough;
  if (lockDate) {
    const drafts = (db.records['account.move'] ?? []).filter((m) => (m.company_id ?? 1) === company && m.state === 'draft' && (moveDate(m)) <= lockDate);
    if (drafts.length) throw new Error('Cannot secure entries while draft entries exist on or before the secured date');
  }
  if (lastNewlySecuredByJournal.size && (db.records['account.move'] ?? []).some((m) => isSequenceConflictDraft(db, m, company, lastNewlySecuredByJournal))) {
    throw new Error('Cannot secure entries while numbered draft entries precede entries to be secured');
  }
  // Odoo's action_secure_entries only hashes moves (account_secure_entries_wizard.py:241-250); it never writes hard_lock_date.

  return next;
}

/**
 * Data Inalterability Check report:
 * Recomputes every chain per journal and reports:
 * - first secured entry
 * - last secured entry
 * - OK or the first corrupted entry
 */
/** A newly posted entry whose number sorts inside the journal's secured chain could never be hashed. */
export const SECURED_ORDER_ERROR = 'This entry would be numbered before the secured entries of its journal';
export function postedBeforeSecuredChain(db, after, before, owners = null) {
  if (after.state !== 'posted' || before?.state === 'posted') return false;
  owners ??= ownershipResolver(db);
  const company = after.company_id ?? 1;
  return (db.records['account.move'] ?? []).some((m) => m.id !== after.id && m.inalterable_hash
    && (m.company_id ?? 1) === company && (m.name ?? '').localeCompare(after.name ?? '') >= 0
    && moveJournalId(db, m, owners) === moveJournalId(db, after, owners));
}

function ownershipResolver(db, cache = null) {
  let owners;
  return () => {
    if (cache && cache.records !== db.records) { cache.records = db.records; cache.owners = null; }
    if (cache) return cache.owners ??= journalOwnershipIndex(db);
    return owners ??= journalOwnershipIndex(db);
  };
}

/** Validate a newly secured move against the complete staged chain, including concurrent server diffs. */
export function secureMoveInvariant(db, after, before, cache = null) {
  const owners = ownershipResolver(db, cache);
  if (!after.inalterable_hash && !after.secure_sequence_number) return postedBeforeSecuredChain(db, after, before, owners) ? SECURED_ORDER_ERROR : null;
  if (before?.inalterable_hash) return null;
  if (!after.inalterable_hash || !Number.isInteger(after.secure_sequence_number) || after.secure_sequence_number < 1) return 'Invalid secure entry hash chain';
  const journalId = moveJournalId(db, after, owners);
  const journal = (db.records['account.journal'] ?? []).find((j) => j.id === journalId);
  if (!journal || after.state !== 'posted') return 'Only posted entries in secure journals can be hashed';
  const company = after.company_id ?? 1;
  const all = (db.records['account.move'] ?? []).filter((m) => moveJournalId(db, m, owners) === journalId && (m.company_id ?? 1) === company && m.state === 'posted')
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.id - b.id);
  let previous = '';
  let sequence = 0;
  let sawUnsecured = false;
  for (const move of all) {
    if (!move.inalterable_hash) { sawUnsecured = true; continue; }
    if ((sawUnsecured && move.id === after.id) || move.secure_sequence_number !== ++sequence || !validMoveHash(move, previous)) return 'Invalid secure entry hash chain';
    sawUnsecured = false;
    previous = move.inalterable_hash;
  }
  const head = (journal.secure_chain_heads ?? []).find((h) => h.company_id === company);
  if (!head || head.count !== sequence || head.last_hash !== previous) return 'Invalid secure chain head';
  return null;
}

/** Whether a journal has secured entries: non-empty secure_chain_heads or any moves with inalterable_hash. */
export function journalHasSecuredEntries(db, journal) {
  const owners = journalOwnershipIndex(db);
  if (!journal) return false;
  if ((journal.secure_chain_heads ?? []).length > 0) return true;
  return (db?.records?.['account.move'] ?? []).some((m) => Boolean(m.inalterable_hash) && moveJournalId(db, m, owners) === journal.id);
}

/** A journal head must only advance to a valid chain; it cannot be removed or rewritten. */
export function secureHeadsGuard(db, before, after, ctx) {
  const owners = journalOwnershipIndex(db);
  if (before?.restrict_mode_hash_table && !after.restrict_mode_hash_table) {
    if (journalHasSecuredEntries(db, before) || journalHasSecuredEntries(db, after)) {
      return 'Cannot turn off Secure Posted Entries with Hash on a journal with secured entries';
    }
  }
  const oldHeads = before?.secure_chain_heads ?? [];
  const heads = after.secure_chain_heads ?? [];
  if (new Set(heads.map((h) => h.company_id)).size !== heads.length) return 'Duplicate secure chain head';
  for (const old of oldHeads) {
    const head = heads.find((h) => h.company_id === old.company_id);
    if (!head || head.count < old.count || (head.count === old.count && JSON.stringify(head) !== JSON.stringify(old))) return 'Secure chain heads cannot be removed or rewritten';
  }
  for (const head of heads) {
    const old = oldHeads.find((h) => h.company_id === head.company_id);
    if (JSON.stringify(old) === JSON.stringify(head)) continue;
    if (ctx?.companies && !ctx.companies.has(head.company_id)) return 'No access to this company secure chain';
    const moves = (db.records['account.move'] ?? []).filter((m) => moveJournalId(db, m, owners) === after.id && (m.company_id ?? 1) === head.company_id && m.inalterable_hash)
      .sort((a, b) => a.secure_sequence_number - b.secure_sequence_number);
    if (!head.company_id || !Number.isInteger(head.count) || head.count < 1 || head.count !== head.last_sequence || moves.length !== head.count) return 'Invalid secure chain head';
    let previous = '';
    for (let i = 0; i < moves.length; i++) {
      const move = moves[i];
      if (move.state !== 'posted' || move.secure_sequence_number !== i + 1 || !validMoveHash(move, previous)) return 'Invalid secure chain head';
      previous = move.inalterable_hash;
    }
    const last = moves.at(-1);
    if (head.last_hash !== previous || head.last_move_id !== last.id || head.last_move_name !== last.name) return 'Invalid secure chain head';
  }
  return null;
}

export function checkInalterability(db, { journalId = null, companyId = null } = {}) {
  const owners = journalOwnershipIndex(db);
  let targetJournalId = null;
  if (journalId != null && journalId !== '') {
    const parsed = Number(journalId);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error('Invalid journal identifier');
    }
    targetJournalId = parsed;
  }
  const journals = search(db, 'account.journal', { includeArchived: true }).filter((j) => targetJournalId === null || j.id === targetJournalId);
  const results = [];
  for (const j of journals) {
    const secured = (db.records['account.move'] ?? []).filter((m) => moveJournalId(db, m, owners) === j.id && Boolean(m.inalterable_hash) && (!companyId || (m.company_id ?? 1) === companyId));
    const heads = (j.secure_chain_heads ?? []).filter((h) => !companyId || h.company_id === companyId);
    const companies = [...new Set([...secured.map((m) => m.company_id ?? 1), ...heads.map((h) => h.company_id)])];
    if (!companies.length && j.restrict_mode_hash_table) companies.push(companyId);
    for (const company of companies) {
      const moves = secured.filter((m) => (m.company_id ?? 1) === company).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.id - b.id);
      const head = heads.find((h) => h.company_id === company);
      let previous = '';
      let corrupted = null;
      for (let i = 0; i < moves.length; i++) {
        const move = moves[i];
        if (move.state !== 'posted' || move.secure_sequence_number !== i + 1 || !validMoveHash(move, previous)) { corrupted = move; break; }
        previous = move.inalterable_hash;
      }
      const headMismatch = head && (head.count !== moves.length || head.last_sequence !== moves.length || head.last_hash !== previous || head.last_move_id !== moves.at(-1)?.id || head.last_move_name !== moves.at(-1)?.name);
      const unanchored = moves.length && !head;
      const missing = headMismatch && !corrupted ? (db.records['account.move'] ?? []).find((m) => m.id === head.last_move_id) ?? { id: head.last_move_id, name: head.last_move_name } : null;
      const bad = corrupted ?? missing;
      results.push({ journal_id: j.id, company_id: company, journal_name: j.name, journal_code: j.code,
        first_move: moves[0]?.name ?? null, last_move: moves.at(-1)?.name ?? null,
        status: corrupted || headMismatch ? 'corrupted' : unanchored ? 'unanchored' : 'ok',
        message: corrupted || headMismatch ? `Corrupted at entry ${bad?.name ?? ''}` : unanchored ? 'Secure chain has no independent head' : moves.length ? 'Data Inalterable - OK' : 'No secured entries',
        corrupted_move: bad });
    }
  }
  return results;
}
