// Bank statement files (OFX/QFX, CAMT.053, QIF) parsed into statement lines; re-importing the same transactions is a no-op.
import { create, read, search } from '../orm.js';
import { isLiquidityJournal, journalCompany } from './ledger.js';
import { sanitizeAccountNumber } from './partnerbank.js';

const qifDate = (v) => {
  if (!v) return null;
  const s = String(v).trim();
  const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const mdy = s.match(/^(\d{1,2})[-/.'](\d{1,2})[-/.'](\d{2,4})$/);
  if (mdy) {
    let year = mdy[3];
    if (year.length === 2) {
      year = Number(year) < 70 ? `20${year}` : `19${year}`;
    }
    return `${year}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  }
  return null;
};

const qifAmount = (v) => {
  if (!v) return NaN;
  const s = String(v).trim().replace(/\s+/g, '');
  // Commas are thousands separators beside a decimal point or in groups of three (1,234), else the decimal mark.
  if (s.includes('.') || /^-?\d{1,3}(,\d{3})+$/.test(s)) return Number(s.replace(/,/g, ''));
  return Number(s.replace(',', '.'));
};

/** Transactions of a QIF (Quicken Interchange Format) file as { date, amount, payment_ref, unique_import_id }, or with details. */
export function parseQif(text, { details = false } = {}) {
  const lines = [];
  const entries = String(text).split(/\r?\n\s*\^\s*(?:\r?\n|$)/);
  for (const entry of entries) {
    const rawLines = entry.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let date = null;
    let amount = NaN;
    let payee = '';
    let memo = '';
    let ref = '';
    for (const line of rawLines) {
      if (line.startsWith('!')) continue;
      const code = line[0];
      const val = line.slice(1).trim();
      if (code === 'D') date = qifDate(val);
      else if (code === 'T' || (code === 'U' && Number.isNaN(amount))) amount = qifAmount(val);
      else if (code === 'P') payee = val;
      else if (code === 'M') memo = val;
      else if (code === 'N') ref = val;
    }
    if (date && Number.isFinite(amount)) {
      lines.push({
        date,
        amount,
        payment_ref: [payee, memo].filter(Boolean).join(' - '),
        unique_import_id: null,
        ...(details ? {
          ...(memo ? { narration: memo } : {}),
          ...(ref ? { ref } : {}),
        } : {}),
      });
    }
  }
  return lines;
}

const ofxDate = (v) => (/^\d{8}/.test(v ?? '') ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null);
// OFX 1.x is SGML: tags may be left unclosed, so a value runs to the next "<".
const ofxTag = (block, tag) => block.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i'))?.[1]?.trim() ?? '';

/** Transactions of an OFX/QFX file as { date, amount, payment_ref, unique_import_id }, or with metadata details. */
export function parseOfx(text, { details = false } = {}) {
  const fileCurrency = ofxTag(text, 'CURDEF');
  return [...String(text).matchAll(/<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi)].map(([, b]) => {
    const memo = ofxTag(b, 'MEMO');
    const account_number = ofxTag(b, 'ACCTID');
    const ref = ofxTag(b, 'REFNUM') || ofxTag(b, 'CHECKNUM');
    const transaction_type = ofxTag(b, 'TRNTYPE');
    const currency = ofxTag(b, 'CURDEF') || fileCurrency || null;
    return {
      date: ofxDate(ofxTag(b, 'DTPOSTED')),
      ...(currency ? { currency } : {}),
      amount: Number(ofxTag(b, 'TRNAMT').replace(',', '.')),
      payment_ref: [ofxTag(b, 'NAME'), memo].filter(Boolean).join(' - '),
      unique_import_id: ofxTag(b, 'FITID') || null,
      ...(details ? {
        ...(account_number ? { account_number } : {}),
        ...(memo ? { narration: memo } : {}),
        ...(ref ? { ref } : {}),
        ...(transaction_type ? { transaction_type } : {}),
      } : {}),
    };
  }).filter((l) => l.date && Number.isFinite(l.amount));
}

const xmlTag = (block, path) => path.reduce((acc, tag) => acc?.match(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`))?.[1], block)?.trim() ?? '';
const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const camtAccount = (block, isDebit) => {
  const order = isDebit ? ['CdtrAcct', 'DbtrAcct'] : ['DbtrAcct', 'CdtrAcct'];
  for (const tag of order) {
    const acct = xmlTag(block, [tag]);
    if (!acct) continue;
    const iban = xmlTag(acct, ['Id', 'IBAN']) || xmlTag(acct, ['Id', 'Othr', 'Id']);
    if (iban) return unescapeXml(iban);
  }
  return '';
};

const camtTxType = (block) => {
  const bk = xmlTag(block, ['BkTxCd']);
  if (!bk) return '';
  const prtry = xmlTag(bk, ['Prtry', 'Cd']);
  if (prtry) return unescapeXml(prtry);
  return unescapeXml([xmlTag(bk, ['Domn', 'Cd']), xmlTag(bk, ['Fmly', 'Cd']), xmlTag(bk, ['Fmly', 'SubFmlyCd'])].filter(Boolean).join('-'));
};

/** Booked entries of an ISO 20022 CAMT.053 statement; debits (DBIT) are negative. */
export function parseCamt(text, { details = false } = {}) {
  return [...String(text).matchAll(/<(?:\w+:)?Ntry>([\s\S]*?)<\/(?:\w+:)?Ntry>/g)].map(([, b]) => {
    const amount = Number(xmlTag(b, ['Amt']));
    const amountTag = b.match(/<(?:\w+:)?Amt\b[^>]*>/)?.[0] ?? '';
    const ref = xmlTag(b, ['Ustrd']) || xmlTag(b, ['AddtlNtryInf']) || xmlTag(b, ['Nm']);
    // CdtDbtInd is the direction actually booked. A reversal (RvslInd) keeps the parties of the original
    // operation, which ran the other way, so the counterpart is taken from the opposite side.
    const isDebit = xmlTag(b, ['CdtDbtInd']) === 'DBIT';
    const reversed = /^(true|1)$/i.test(xmlTag(b, ['RvslInd']));
    // A batch entry (several TxDtls) books one total: transaction-level details would describe only one of them.
    const single = (b.match(/<(?:\w+:)?TxDtls\b/g) ?? []).length <= 1;
    const account_number = details && single ? camtAccount(b, reversed ? !isDebit : isDebit) : '';
    const narration = details ? unescapeXml((single ? xmlTag(b, ['AddtlTxInf']) : '') || xmlTag(b, ['AddtlNtryInf'])) : '';
    const lineRef = details ? unescapeXml([
      xmlTag(b, ['NtryRef']),
      ...(single ? [xmlTag(b, ['EndToEndId']), xmlTag(b, ['TxId']), xmlTag(b, ['InstrId']), xmlTag(b, ['CdtrRefInf', 'Ref'])] : []),
    ].find((v) => v && v.toUpperCase() !== 'NOTPROVIDED') ?? '') : '';
    const transaction_type = details ? camtTxType(b) : '';
    return {
      date: (xmlTag(b, ['BookgDt', 'Dt']) || xmlTag(b, ['BookgDt', 'DtTm'])).slice(0, 10) || null,
      currency: amountTag.match(/\sCcy\s*=\s*["']([^"']+)["']/)?.[1] ?? null,
      amount: isDebit ? -amount : amount,
      payment_ref: unescapeXml(ref),
      unique_import_id: xmlTag(b, ['AcctSvcrRef']) || null,
      ...(details ? {
        ...(account_number ? { account_number } : {}),
        ...(narration ? { narration } : {}),
        ...(lineRef ? { ref: lineRef } : {}),
        ...(transaction_type ? { transaction_type } : {}),
      } : {}),
    };
  }).filter((l) => /^\d{4}-\d{2}-\d{2}$/.test(l.date ?? '') && Number.isFinite(l.amount));
}

/** Bank and cash journals a user may choose when the action has no journal relation. */
export function statementImportJournalChoices(db, companyId = null) {
  const configuredCompanies = db.settings?.allowed_company_ids;
  const visibleCompanies = companyId == null
    ? (Array.isArray(configuredCompanies) && configuredCompanies.length ? configuredCompanies : [db.settings?.current_company_id ?? 1])
    : [companyId];
  const companyIds = new Set(visibleCompanies.map(Number));
  return search(db, 'account.journal').filter((journal) =>
    isLiquidityJournal(journal) && companyIds.has(Number(journalCompany(journal)))
  );
}

/** Add the journal explicitly selected in the import UI while preserving action defaults. */
export function withSelectedStatementJournal(defaults = {}, selectedJournalId = null) {
  if (defaults.journal_id || selectedJournalId == null || selectedJournalId === '') return defaults;
  const journalId = Number(selectedJournalId);
  return Number.isSafeInteger(journalId) && journalId > 0 ? { ...defaults, journal_id: journalId } : defaults;
}

/** Import defaults for one journal: its lines belong to the journal's own company, never to the active one. */
export function statementImportDefaults(journal, defaults = {}) {
  return {
    ...defaults,
    ...(journal?.id ? { journal_id: journal.id } : {}),
    ...(journal?.company_id != null ? { company_id: journal.company_id } : {}),
  };
}

/**
 * Validate the target liquidity journal and create deduplicated `account.bank.statement.line` records.
 * Deduplicates by `unique_import_id` within `(journal_id, company_id)` (including journal-less same-company
 * legacy lines unless `exactJournalOnly` is `true`); returns `{ db, count }`.
 *
 * @param {object} db
 * @param {object[]} lines
 * @param {object} [defaults]
 * @param {{ camt?: boolean, exactJournalOnly?: boolean }} [options]
 *   `exactJournalOnly` restricts duplicate detection to lines whose `journal_id` equals the target journal
 *   (used by online sync so provider IDs do not collide with journal-less legacy file imports).
 */
export function importStatementLines(db, lines, defaults = {}, { camt = false, exactJournalOnly = false } = {}) {
  if (!defaults.journal_id) throw new Error('Bank Journal is required');
  const journal = read(db, 'account.journal', defaults.journal_id);
  if (!journal) throw new Error('The bank journal does not exist');
  if (!isLiquidityJournal(journal)) throw new Error('Choose a bank or cash journal');
  if (defaults.company_id && journalCompany(journal) !== defaults.company_id) throw new Error('The bank journal belongs to another company');
  const company = journal?.company_id ?? defaults.company_id ?? 1;
  const currencyId = journal?.currency_id ?? read(db, 'res.company', company)?.currency_id ?? null;
  const currency = read(db, 'res.currency', currencyId);
  if (lines.some((l) => (camt && !l.currency) || (l.currency && l.currency !== currency?.name))) throw new Error(`Statement currency does not match journal currency ${currency?.name ?? ''}`);
  const journalId = defaults.journal_id ?? null;
  const existing = search(db, 'account.bank.statement.line')
    .filter((l) => (exactJournalOnly ? l.journal_id === journalId : (l.journal_id == null || l.journal_id === journalId)) && (l.company_id ?? 1) === company);
  const known = new Set(existing.map((l) => l.unique_import_id).filter(Boolean));
  const existingCounts = new Map();
  for (const l of existing) {
    const fp = `${l.date}|${l.payment_ref || '/'}|${Number(l.amount)}`;
    existingCounts.set(fp, (existingCounts.get(fp) || 0) + 1);
  }
  const fresh = lines.filter((l) => {
    if (l.unique_import_id) {
      if (known.has(l.unique_import_id)) return false;
      known.add(l.unique_import_id);
      return true;
    }
    const fp = `${l.date}|${l.payment_ref || '/'}|${Number(l.amount)}`;
    const count = existingCounts.get(fp) || 0;
    if (count > 0) {
      existingCounts.set(fp, count - 1);
      return false;
    }
    return true;
  });
  const bankAccounts = search(db, 'res.partner.bank')
    .filter((b) => b.active !== false && (!b.company_id || b.company_id === company));
  // An account number held by several partners identifies none of them.
  const partnerByAccount = new Map();
  for (const b of bankAccounts) {
    const key = b.sanitized_account_number || sanitizeAccountNumber(b.account_number);
    partnerByAccount.set(key, partnerByAccount.has(key) && partnerByAccount.get(key) !== b.partner_id ? null : b.partner_id);
  }
  // The journal's own account (online sync stamps it on every line) is not a counterparty.
  const ownBank = journal?.bank_account_id ? read(db, 'res.partner.bank', journal.bank_account_id) : null;
  const ownKey = ownBank ? ownBank.sanitized_account_number || sanitizeAccountNumber(ownBank.account_number) : null;
  const next = fresh.reduce((acc, { currency: _currency, ...l }) => {
    let partnerId = l.partner_id ?? defaults.partner_id ?? null;
    if (!partnerId && l.account_number && sanitizeAccountNumber(l.account_number) !== ownKey) {
      partnerId = partnerByAccount.get(sanitizeAccountNumber(l.account_number)) ?? null;
    }
    return create(acc, 'account.bank.statement.line', {
      ...defaults,
      ...l,
      currency_id: currencyId,
      ...(journal ? { company_id: journalCompany(journal) } : {}),
      payment_ref: l.payment_ref || '/',
      state: 'to_check',
      ...(partnerId ? { partner_id: partnerId } : {}),
    }).db;
  }, db);
  return { db: next, count: fresh.length };
}

/** Parse a statement file by its name/content and create the new lines; returns { db, count }. */
export function importStatement(db, fileName, text, defaults = {}) {
  const camt = /\.xml$/i.test(fileName) || /<BkToCstmrStmt/.test(text);
  const qif = /\.qif$/i.test(fileName) || /^\s*!Type:(?:Bank|Cash|CCard|Invst|Oth A|Oth L)/im.test(text);
  const lines = camt
    ? parseCamt(text, { details: true })
    : (qif ? parseQif(text, { details: true }) : parseOfx(text, { details: true }));
  if (!lines.length) throw new Error('No transactions found in this file');
  return importStatementLines(db, lines, defaults, { camt });
}
