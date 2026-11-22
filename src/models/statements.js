// Bank statement files (OFX/QFX, CAMT.053, QIF) parsed into statement lines; re-importing the same transactions is a no-op.
import { create, read, search, write } from '../orm.js';
import { isLiquidityJournal, journalCompany } from './ledger.js';
import { sanitizeAccountNumber } from './partnerbank.js';
import { today } from './common.js';
import { companyCurrencyRecord, roundCurrency } from '../money.js';

const isValidCalendarDate = (y, m, d) => {
  if (!Number.isSafeInteger(y) || y < 1000 || y > 9999) return false;
  if (!Number.isSafeInteger(m) || m < 1 || m > 12) return false;
  if (!Number.isSafeInteger(d) || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && (dt.getUTCMonth() + 1) === m && dt.getUTCDate() === d;
};

const qifDate = (v, dayFirst = false) => {
  if (!v) return null;
  const s = String(v).trim();
  let y, m, d;
  const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) {
    y = Number(iso[1]);
    m = Number(iso[2]);
    d = Number(iso[3]);
  } else {
    const mdy = s.match(/^(\d{1,2})[-/.'](\d{1,2})[-/.'](\d{2,4})$/);
    if (!mdy) throw new Error('Invalid calendar date in QIF file');
    const yr = mdy[3].length === 2 ? (Number(mdy[3]) < 70 ? 2000 + Number(mdy[3]) : 1900 + Number(mdy[3])) : Number(mdy[3]);
    y = yr;
    if (dayFirst) {
      d = Number(mdy[1]);
      m = Number(mdy[2]);
    } else {
      m = Number(mdy[1]);
      d = Number(mdy[2]);
    }
  }
  if (!isValidCalendarDate(y, m, d)) {
    throw new Error('Invalid calendar date in QIF file');
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

export const qifAmount = (v) => {
  if (v == null || v === '') throw new Error('Ambiguous or invalid QIF amount');
  const s = String(v).trim().replace(/\s+/g, '');
  if (!s) throw new Error('Ambiguous or invalid QIF amount');

  const hasComma = s.includes(',');
  const hasDot = s.includes('.');

  let normalized;
  if (hasComma && hasDot) {
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastDot > lastComma) {
      // rightmost is dot (decimal mark)
      const beforeDot = s.slice(0, lastDot);
      const afterDot = s.slice(lastDot + 1);
      if (beforeDot.includes('.') || afterDot.includes('.') || afterDot.includes(',')) {
        throw new Error('Ambiguous or invalid QIF amount');
      }
      normalized = beforeDot.replace(/,/g, '') + '.' + afterDot;
    } else {
      // rightmost is comma (decimal mark)
      const beforeComma = s.slice(0, lastComma);
      const afterComma = s.slice(lastComma + 1);
      if (beforeComma.includes(',') || afterComma.includes(',') || afterComma.includes('.')) {
        throw new Error('Ambiguous or invalid QIF amount');
      }
      normalized = beforeComma.replace(/\./g, '') + '.' + afterComma;
    }
  } else if (hasComma) {
    // Lone comma followed by exactly three digits in groups (1,234 or 1,234,567) is thousands, otherwise lone comma is decimal mark.
    if (/^[+-]?\d{1,3}(,\d{3})+$/.test(s)) {
      normalized = s.replace(/,/g, '');
    } else {
      const parts = s.split(',');
      if (parts.length !== 2) throw new Error('Ambiguous or invalid QIF amount');
      normalized = parts[0] + '.' + parts[1];
    }
  } else if (hasDot) {
    const parts = s.split('.');
    if (parts.length !== 2) throw new Error('Ambiguous or invalid QIF amount');
    normalized = s;
  } else {
    normalized = s;
  }

  const num = Number(normalized);
  if (!Number.isFinite(num)) {
    throw new Error('Ambiguous or invalid QIF amount');
  }
  return num;
};

/** Transactions of a QIF (Quicken Interchange Format) file as { date, amount, payment_ref, unique_import_id }, or with details. */
export function parseQif(text, { details = false } = {}) {
  const lines = [];
  const entries = String(text).split(/\r?\n\s*\^\s*(?:\r?\n|$)/);

  let hasDayFirst = false;
  let hasMonthFirst = false;
  for (const entry of entries) {
    for (const raw of entry.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('D')) {
        const s = line.slice(1).trim();
        if (!/^\d{4}[-/]/.test(s)) {
          const mdy = s.match(/^(\d{1,2})[-/.'](\d{1,2})[-/.']\d{2,4}$/);
          if (mdy) {
            const p1 = Number(mdy[1]);
            const p2 = Number(mdy[2]);
            if (p1 > 12) hasDayFirst = true;
            if (p2 > 12) hasMonthFirst = true;
          }
        }
      }
    }
  }
  if (hasDayFirst && hasMonthFirst) {
    throw new Error('Contradictory date formats in QIF file');
  }
  const dayFirst = hasDayFirst;

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
      if (code === 'D') date = qifDate(val, dayFirst);
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
  const fileCurrency = ofxTag(text, 'CURDEF') || null;
  const str = String(text);
  const responseBlocks = [...str.matchAll(/<(?:STMTRS|CCSTMTRS)\b([\s\S]*?)(?=<\/(?:STMTRS|CCSTMTRS)>|<(?:STMTRS|CCSTMTRS)\b|<\/(?:STMTTRNRS|CCSTMTTRNRS|BANKMSGSRSV1|CREDITCARDMSGSRSV1)>|$)/gi)].map((m) => m[1]);
  const blocks = responseBlocks.length ? responseBlocks : [str];
  return blocks.flatMap((block) => {
    const blockCurrency = ofxTag(block, 'CURDEF') || fileCurrency;
    return [...block.matchAll(/<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>|<\/CCBANKTRANLIST>|$)/gi)].map(([, b]) => {
      const memo = ofxTag(b, 'MEMO');
      const account_number = ofxTag(b, 'ACCTID');
      const ref = ofxTag(b, 'REFNUM') || ofxTag(b, 'CHECKNUM');
      const transaction_type = ofxTag(b, 'TRNTYPE');
      const currency = ofxTag(b, 'CURDEF') || blockCurrency || null;
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
  });
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
    const key = sanitizeAccountNumber(b.account_number);
    partnerByAccount.set(key, partnerByAccount.has(key) && partnerByAccount.get(key) !== b.partner_id ? null : b.partner_id);
  }
  // The journal's own account (online sync stamps it on every line) is not a counterparty.
  const ownBank = journal?.bank_account_id ? read(db, 'res.partner.bank', journal.bank_account_id) : null;
  const ownKey = ownBank ? sanitizeAccountNumber(ownBank.account_number) : null;
  const line_ids = [];
  let next = db;
  for (const { currency: _currency, ...l } of fresh) {
    let partnerId = l.partner_id ?? defaults.partner_id ?? null;
    if (!partnerId && l.account_number && sanitizeAccountNumber(l.account_number) !== ownKey) {
      partnerId = partnerByAccount.get(sanitizeAccountNumber(l.account_number)) ?? null;
    }
    const res = create(next, 'account.bank.statement.line', {
      ...defaults,
      ...l,
      currency_id: currencyId,
      ...(journal ? { company_id: journalCompany(journal) } : {}),
      payment_ref: l.payment_ref || '/',
      state: 'to_check',
      ...(partnerId ? { partner_id: partnerId } : {}),
    });
    next = res.db;
    line_ids.push(res.id);
  }
  return { db: next, count: fresh.length, line_ids };
}

/** Extract opening (OPBD/PRCD) and closing (CLBD/CLAV) balances from a CAMT.053 XML string. */
export function parseCamtBalances(text) {
  let balance_start = null;
  let balance_end_clbd = null;
  let balance_end_clav = null;
  for (const [, b] of String(text).matchAll(/<(?:\w+:)?Bal>([\s\S]*?)<\/(?:\w+:)?Bal>/g)) {
    const code = xmlTag(b, ['Tp', 'CdOrPrtry', 'Cd']) || xmlTag(b, ['Tp', 'CdOrPrtry', 'Prtry']);
    const amtStr = xmlTag(b, ['Amt']);
    if (!amtStr) continue;
    const isDebit = xmlTag(b, ['CdtDbtInd']) === 'DBIT';
    const num = Number(amtStr);
    if (!Number.isFinite(num)) continue;
    const val = isDebit ? -num : num;
    if (['OPBD', 'PRCD'].includes(code)) {
      if (balance_start == null) balance_start = val;
    } else if (code === 'CLBD') {
      balance_end_clbd = val;
    } else if (code === 'CLAV') {
      balance_end_clav = val;
    }
  }
  const balance_end_real = balance_end_clbd != null ? balance_end_clbd : balance_end_clav;
  return { balance_start, balance_end_real };
}

/** Extract ledger balance from an OFX string. */
export function parseOfxBalances(text) {
  let balance_start = null;
  let balance_end_real = null;
  const ledgerMatch = String(text).match(/<LEDGERBAL>([\s\S]*?)(?:<\/LEDGERBAL>|<LEDGERBAL>|<\/STMTRS>|<\/CCSTMTRS>|$)/i);
  if (ledgerMatch) {
    const balAmt = ofxTag(ledgerMatch[1], 'BALAMT');
    if (balAmt) {
      const num = Number(balAmt.replace(',', '.'));
      if (Number.isFinite(num)) {
        balance_end_real = num;
      }
    }
  } else {
    const availMatch = String(text).match(/<AVAILBAL>([\s\S]*?)(?:<\/AVAILBAL>|<AVAILBAL>|<\/STMTRS>|<\/CCSTMTRS>|$)/i);
    if (availMatch) {
      const balAmt = ofxTag(availMatch[1], 'BALAMT');
      if (balAmt) {
        const num = Number(balAmt.replace(',', '.'));
        if (Number.isFinite(num)) {
          balance_end_real = num;
        }
      }
    }
  }
  return { balance_start, balance_end_real };
}

/** Compute balance from booked journal items of the statement's own journal/bank account before a given date. */
function bookedAccountBalance(db, journal, beforeDate = null) {
  if (!journal?.default_account_id) return 0;
  const items = search(db, 'account.move')
    .filter((m) => m.state === 'posted' && (beforeDate ? String(m.date ?? m.invoice_date ?? '') < String(beforeDate) : true))
    .flatMap((m) => m.line_ids ?? [])
    .filter((l) => l.account_id === journal.default_account_id)
    .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.id - b.id);
  const currency = journal.currency_id ? read(db, 'res.currency', journal.currency_id) : companyCurrencyRecord(db, journal.company_id ?? 1);
  let total = 0;
  for (const l of items) {
    const val = (journal.currency_id && l.currency_id === journal.currency_id && l.amount_currency != null)
      ? Number(l.amount_currency)
      : (Number(l.debit) || 0) - (Number(l.credit) || 0);
    total += val;
  }
  return currency ? roundCurrency(total, currency) : total;
}

/** Find a bank journal matching the account number in a file block. */
function findJournalForAccount(db, acctNumber, companyId = 1) {
  if (!acctNumber) return null;
  const clean = sanitizeAccountNumber(acctNumber);
  if (!clean) return null;
  const bankAccounts = search(db, 'res.partner.bank').filter(
    (b) => b.active !== false && (!b.company_id || b.company_id === companyId)
      && sanitizeAccountNumber(b.account_number) === clean
  );
  if (!bankAccounts.length) return null;
  const bankIds = new Set(bankAccounts.map((b) => b.id));
  const journals = search(db, 'account.journal').filter(
    (j) => isLiquidityJournal(j) && bankIds.has(j.bank_account_id) && (j.company_id ?? 1) === companyId
  );
  return journals.length === 1 ? journals[0] : null;
}

/** Parse a statement file by its name/content and create the new lines and statement record; returns { db, count }. */
export function importStatement(db, fileName, text, defaults = {}) {
  const camt = /\.xml$/i.test(fileName) || /<BkToCstmrStmt/.test(text);
  const qif = /\.qif$/i.test(fileName) || /^\s*!Type:(?:Bank|Cash|CCard|Invst|Oth A|Oth L)/im.test(text);

  let blocks = [];
  if (camt) {
    const stmtMatches = [...String(text).matchAll(/<(?:\w+:)?Stmt\b[\s\S]*?<\/(?:\w+:)?Stmt>/g)];
    if (stmtMatches.length > 0) {
      blocks = stmtMatches.map((m) => ({ content: m[0], camt: true }));
    }
  } else if (!qif) {
    const ofxMatches = [...String(text).matchAll(/<(?:STMTRS|CCSTMTRS)\b[\s\S]*?<\/(?:STMTRS|CCSTMTRS)>/gi)];
    if (ofxMatches.length > 0) {
      blocks = ofxMatches.map((m) => ({ content: m[0], ofx: true }));
    }
  }
  if (!blocks.length) {
    blocks = [{ content: text, camt, qif }];
  }

  let currentDb = db;
  let totalCount = 0;
  const createdStatementIds = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const blockText = block.content;
    const isCamt = Boolean(block.camt);
    const isQif = Boolean(block.qif);

    const lines = isCamt
      ? parseCamt(blockText, { details: true })
      : (isQif ? parseQif(blockText, { details: true }) : parseOfx(blockText, { details: true }));
    if (!lines.length) continue;

    let blockAcctNumber = null;
    if (isCamt) {
      blockAcctNumber = xmlTag(blockText, ['Acct', 'Id', 'IBAN']) || xmlTag(blockText, ['Acct', 'Id', 'Othr', 'Id']);
    } else if (!isQif) {
      blockAcctNumber = ofxTag(blockText, 'ACCTID');
    }

    const targetJournal = defaults.journal_id ? read(currentDb, 'account.journal', defaults.journal_id) : null;
    const companyId = defaults.company_id ?? targetJournal?.company_id ?? 1;
    const matchedJournal = findJournalForAccount(currentDb, blockAcctNumber, companyId);
    const finalJournal = matchedJournal ?? targetJournal;
    const targetJournalId = finalJournal?.id ?? defaults.journal_id;
    if (!targetJournalId) throw new Error('Bank Journal is required');

    const blockDefaults = {
      ...defaults,
      journal_id: targetJournalId,
      company_id: defaults.company_id ?? finalJournal?.company_id ?? companyId,
    };

    const { db: linesDb, count, line_ids } = importStatementLines(currentDb, lines, blockDefaults, { camt: isCamt });
    if (!count || !line_ids.length) {
      continue;
    }
    totalCount += count;
    currentDb = linesDb;

    const fileBalances = isCamt
      ? parseCamtBalances(blockText)
      : (isQif ? { balance_start: null, balance_end_real: null } : parseOfxBalances(blockText));

    const finalTargetJournal = read(currentDb, 'account.journal', targetJournalId);
    const company = finalTargetJournal?.company_id ?? blockDefaults.company_id ?? 1;
    const currencyId = finalTargetJournal?.currency_id ?? read(currentDb, 'res.company', company)?.currency_id ?? null;
    const currency = read(currentDb, 'res.currency', currencyId);

    const importedLines = line_ids.map((id) => read(currentDb, 'account.bank.statement.line', id));
    const importedLinesSum = importedLines.reduce((acc, l) => acc + (Number(l.amount) || 0), 0);
    const statementDate = blockDefaults.statement_date || importedLines.map((l) => l.date).filter(Boolean).sort().at(-1) || today();

    // Chronological predecessor for balance_start (Bug 9):
    const precedingStatements = search(currentDb, 'account.bank.statement')
      .filter((s) => s.journal_id === targetJournalId && String(s.date ?? '') <= String(statementDate))
      .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.id - b.id);
    const prevStatement = precedingStatements.at(-1);

    const prevEnd = prevStatement
      ? Number(prevStatement.balance_end_real) || 0
      : bookedAccountBalance(currentDb, targetJournal, statementDate);

    // Overlapping imports / duplicate lines handling (Bug 11):
    let balance_start;
    let balance_end_real;
    const hasDups = lines.length > count;

    if (hasDups && fileBalances.balance_end_real != null) {
      balance_end_real = fileBalances.balance_end_real;
      balance_start = currency
        ? roundCurrency(balance_end_real - importedLinesSum, currency)
        : balance_end_real - importedLinesSum;
    } else {
      balance_start = fileBalances.balance_start != null ? fileBalances.balance_start : prevEnd;
      const computedEnd = currency
        ? roundCurrency(balance_start + importedLinesSum, currency)
        : balance_start + importedLinesSum;
      balance_end_real = fileBalances.balance_end_real != null ? fileBalances.balance_end_real : computedEnd;
    }

    const stmtName = defaults.statement_name
      ? (blocks.length > 1 ? `${defaults.statement_name} #${i + 1}` : defaults.statement_name)
      : (blocks.length > 1 ? `${fileName} #${i + 1}` : fileName);

    const stmtRes = create(currentDb, 'account.bank.statement', {
      name: stmtName,
      journal_id: targetJournalId,
      company_id: company,
      date: statementDate,
      balance_start,
      balance_end_real,
    });

    currentDb = stmtRes.db;
    createdStatementIds.push(stmtRes.id);

    for (const lineId of line_ids) {
      currentDb = write(currentDb, 'account.bank.statement.line', lineId, { statement_id: stmtRes.id });
    }
  }

  if (!totalCount) {
    const hasAnyTransactions = blocks.some((b) => {
      const l = b.camt ? parseCamt(b.content) : (b.qif ? parseQif(b.content) : parseOfx(b.content));
      return l.length > 0;
    });
    if (!hasAnyTransactions) throw new Error('No transactions found in this file');
    return { db, count: 0 };
  }

  return {
    db: currentDb,
    count: totalCount,
    statement_id: createdStatementIds[0],
    statement_ids: createdStatementIds,
  };
}
