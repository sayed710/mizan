// Inalterability hash chain for secure entries (Odoo 20 accounting parity).
import { read, search, write } from '../orm.js';
import { currentCompany } from './company.js';
import { today } from './common.js';
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
  if (version !== 2) return null;
  const lineFields = ['name', 'account_id', 'partner_id', 'debit', 'credit', 'amount_currency', 'currency_id', 'tax_name', 'tax_base', 'tax_side', 'tax_zero', 'tax_id', 'tax_ids', 'tax_tag_ids', 'tag_ids', 'analytic_distribution'];
  const lines = (move.line_ids ?? []).map((line) => lineFields.map((field) => canonical(line[field])));
  return sha256(JSON.stringify([2, move.invoice_date ?? null, move.date ?? null, journal, name, company, partner, move.move_type ?? null, move.reversed_entry_id ?? null, move.reversal_move_id ?? null, move.correction_of_id ?? null, move.is_closing ?? null, move.currency_id ?? null, move.fiscal_position_id ?? null, canonical(move.invoice_line_ids ?? []), lines, previousHash]));
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
 * - draft moves dated before/on hashDate that cannot be hashed
 * - gaps in sequences
 * - max date
 */
export function analyzeJournalChains(db, { companyId = null, hashDate = null } = {}) {
  const company = companyId ?? currentCompany(db);
  const allJournals = search(db, 'account.journal', { includeArchived: true });
  const restrictedJournals = allJournals.filter((j) => Boolean(j.restrict_mode_hash_table));
  const restrictedIds = new Set(restrictedJournals.map((j) => j.id));

  const allMoves = (db.records['account.move'] ?? []).filter((m) => {
    if ((m.company_id ?? 1) !== company) return false;


    const jId = m.journal_id || (m.move_type ? (db.records['account.journal'] ?? []).find((j) => j.code === (m.move_type.startsWith('in_') ? 'BILL' : 'INV'))?.id : null);
    return restrictedIds.has(jId);
  });


  // Find max date among posted moves in restricted journals
  const postedDates = allMoves.filter((m) => m.state === 'posted').map((m) => m.invoice_date ?? m.date).filter(Boolean);
  const maxDate = postedDates.length ? postedDates.sort().at(-1) : today();
  const targetDate = hashDate || maxDate;

  const targetMoves = allMoves.filter((m) => (m.invoice_date ?? m.date ?? '') <= targetDate);
  const unhashedPostedMoves = targetMoves.filter((m) => m.state === 'posted' && !m.inalterable_hash);

  const unhashedDates = unhashedPostedMoves.map((m) => m.invoice_date ?? m.date ?? '').filter(Boolean);
  const proposedLockDate = unhashedDates.length ? unhashedDates.sort().at(-1) : '';

  const draftMoves = (db.records['account.move'] ?? []).filter((m) => {
    if ((m.company_id ?? 1) !== company || m.state !== 'draft') return false;
    const date = m.invoice_date ?? m.date ?? '';
    if (proposedLockDate && date <= proposedLockDate) return true;
    const jId = m.journal_id || (m.move_type ? (db.records['account.journal'] ?? []).find((j) => j.code === (m.move_type.startsWith('in_') ? 'BILL' : 'INV'))?.id : null);
    return restrictedIds.has(jId) && date <= targetDate;
  });

  const chainsWithGaps = [];
  for (const journal of restrictedJournals) {
    const jMoves = allMoves.filter((m) => m.journal_id === journal.id && (m.invoice_date ?? m.date ?? '') <= targetDate)
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    const gaps = findSequenceGaps(jMoves);
    if (gaps.length) {
      chainsWithGaps.push(`${journal.code || journal.name}: ${gaps.map((g) => `${g.prefix}${g.from}..${g.to}`).join(', ')}`);
    }
  }

  const warnings = [];
  if (draftMoves.length) {
    warnings.push(t('{count} draft entries found before or on {date}. Draft entries cannot be hashed.', { count: draftMoves.length, date: targetDate }));
  }
  if (chainsWithGaps.length) {
    warnings.push(t('Sequence gaps detected: {gaps}.', { gaps: chainsWithGaps.join('; ') }));
  }

  return {
    company,
    hash_date: targetDate,
    max_hash_date: maxDate,
    move_to_hash_ids: unhashedPostedMoves.map((m) => m.id),
    entries_count: unhashedPostedMoves.length,
    not_hashable_unlocked_move_ids: draftMoves.map((m) => m.id),
    chains_to_hash_with_gaps: chainsWithGaps.join('; '),
    warnings: warnings.join('\n'),
  };
}

/**
 * Secures posted entries in journals with restrict_mode_hash_table up to hashDate.
 * Computes hashes and sequence numbers in sequence order, and sets the company's hard lock date.
 */
export function secureEntries(db, { companyId = null, hashDate = null } = {}) {
  const company = companyId ?? currentCompany(db);
  const restrictedJournals = search(db, 'account.journal', { includeArchived: true }).filter((j) => Boolean(j.restrict_mode_hash_table));
  const targetDate = hashDate || today();

  let next = db;
  let securedThrough = '';
  for (const journal of restrictedJournals) {
    const journalMoves = (next.records['account.move'] ?? [])
      .filter((m) => (m.company_id ?? 1) === company && m.journal_id === journal.id && m.state === 'posted')
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    const moves = journalMoves.filter((m) => (m.invoice_date ?? m.date ?? '') <= targetDate);
    const securedMoves = journalMoves.filter((m) => m.inalterable_hash);
    if ((securedMoves.length || (journal.secure_chain_heads ?? []).some((h) => h.company_id === company)) && checkInalterability(next, { journalId: journal.id, companyId: company }).some((r) => r.status === 'corrupted')) throw new Error('Cannot extend a corrupted secure entry chain');
    const lastSecured = securedMoves.at(-1);
    let previousHash = lastSecured ? lastSecured.inalterable_hash : '';
    let lastSeqNum = lastSecured ? (lastSecured.secure_sequence_number || 0) : 0;

    const unhashed = moves.filter((m) => !m.inalterable_hash);
    if (unhashed.length && journalMoves.some((m) => !m.inalterable_hash && !unhashed.includes(m) && (m.name ?? '').localeCompare(unhashed.at(-1).name ?? '') < 0)) throw new Error('Cannot secure entries while an earlier sequence remains unsecured');
    if (lastSecured && unhashed.some((m) => (m.name ?? '').localeCompare(lastSecured.name ?? '') <= 0)) throw new Error('Cannot secure an entry before the last secured sequence');
    for (const move of unhashed) {
      lastSeqNum += 1;
      const hash = computeMoveHash(move, previousHash, 2);
      next = write(next, 'account.move', move.id, {
        inalterable_hash: hash,
        secure_sequence_number: lastSeqNum,
        inalterable_hash_version: 2,
      });
    
      previousHash = hash;
      const date = move.invoice_date ?? move.date ?? '';
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
  if (securedThrough) {
    const drafts = (db.records['account.move'] ?? []).filter((m) => (m.company_id ?? 1) === company && m.state === 'draft' && (m.invoice_date ?? m.date ?? '') <= securedThrough);
    if (drafts.length) throw new Error('Cannot secure entries while draft entries exist on or before the secured date');
  }
  if (securedThrough && (!currentComp.hard_lock_date || securedThrough > currentComp.hard_lock_date)) {
    next = write(next, 'res.company', company, { hard_lock_date: securedThrough });
  }

  return next;
}

/**
 * Data Inalterability Check report:
 * Recomputes every chain per journal and reports:
 * - first secured entry
 * - last secured entry
 * - OK or the first corrupted entry
 */
/** Validate a newly secured move against the complete staged chain, including concurrent server diffs. */
export function secureMoveInvariant(db, after, before) {
  if (!after.inalterable_hash && !after.secure_sequence_number) return null;
  if (before?.inalterable_hash) return null;
  if (!after.inalterable_hash || !Number.isInteger(after.secure_sequence_number) || after.secure_sequence_number < 1) return 'Invalid secure entry hash chain';
  const journal = (db.records['account.journal'] ?? []).find((j) => j.id === after.journal_id);
  if (!journal?.restrict_mode_hash_table || after.state !== 'posted') return 'Only posted entries in secure journals can be hashed';
  const company = after.company_id ?? 1;
  const all = (db.records['account.move'] ?? []).filter((m) => m.journal_id === journal.id && (m.company_id ?? 1) === company && m.state === 'posted')
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.id - b.id);
  let previous = '';
  let sequence = 0;
  let sawUnsecured = false;
  for (const move of all) {
    if (!move.inalterable_hash) { sawUnsecured = true; continue; }
    if (sawUnsecured || move.secure_sequence_number !== ++sequence || !validMoveHash(move, previous)) return 'Invalid secure entry hash chain';
    previous = move.inalterable_hash;
  }
  const head = (journal.secure_chain_heads ?? []).find((h) => h.company_id === company);
  if (!head || head.count !== sequence || head.last_hash !== previous) return 'Invalid secure chain head';
  return null;
}

/** A journal head must only advance to a valid chain; it cannot be removed or rewritten. */
export function secureHeadsGuard(db, before, after, ctx) {
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
    const moves = (db.records['account.move'] ?? []).filter((m) => m.journal_id === after.id && (m.company_id ?? 1) === head.company_id && m.inalterable_hash)
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
  const journals = search(db, 'account.journal', { includeArchived: true }).filter((j) => !journalId || j.id === journalId);
  const results = [];
  for (const j of journals) {
    const secured = (db.records['account.move'] ?? []).filter((m) => m.journal_id === j.id && Boolean(m.inalterable_hash) && (!companyId || (m.company_id ?? 1) === companyId));
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
