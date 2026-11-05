// Bank statement files (OFX/QFX, CAMT.053) parsed into statement lines; re-importing the same transactions is a no-op.
import { create, read, search } from '../orm.js';

const ofxDate = (v) => (/^\d{8}/.test(v ?? '') ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null);
// OFX 1.x is SGML: tags may be left unclosed, so a value runs to the next "<".
const ofxTag = (block, tag) => block.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i'))?.[1]?.trim() ?? '';

/** Transactions of an OFX/QFX file as { date, amount, payment_ref, unique_import_id }. */
export function parseOfx(text) {
  return [...String(text).matchAll(/<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi)].map(([, b]) => ({
    date: ofxDate(ofxTag(b, 'DTPOSTED')),
    amount: Number(ofxTag(b, 'TRNAMT').replace(',', '.')),
    payment_ref: [ofxTag(b, 'NAME'), ofxTag(b, 'MEMO')].filter(Boolean).join(' - '),
    unique_import_id: ofxTag(b, 'FITID') || null,
  })).filter((l) => l.date && Number.isFinite(l.amount));
}

const xmlTag = (block, path) => path.reduce((acc, tag) => acc?.match(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`))?.[1], block)?.trim() ?? '';
const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Booked entries of an ISO 20022 CAMT.053 statement; debits (DBIT) are negative. */
export function parseCamt(text) {
  return [...String(text).matchAll(/<(?:\w+:)?Ntry>([\s\S]*?)<\/(?:\w+:)?Ntry>/g)].map(([, b]) => {
    const amount = Number(xmlTag(b, ['Amt']));
    const amountTag = b.match(/<(?:\w+:)?Amt\b[^>]*>/)?.[0] ?? '';
    const ref = xmlTag(b, ['Ustrd']) || xmlTag(b, ['AddtlNtryInf']) || xmlTag(b, ['Nm']);
    return {
      date: (xmlTag(b, ['BookgDt', 'Dt']) || xmlTag(b, ['BookgDt', 'DtTm'])).slice(0, 10) || null,
      currency: amountTag.match(/\sCcy\s*=\s*["']([^"']+)["']/)?.[1] ?? null,
      amount: xmlTag(b, ['CdtDbtInd']) === 'DBIT' ? -amount : amount,
      payment_ref: unescapeXml(ref),
      unique_import_id: xmlTag(b, ['AcctSvcrRef']) || null,
    };
  }).filter((l) => /^\d{4}-\d{2}-\d{2}$/.test(l.date ?? '') && Number.isFinite(l.amount));
}

/** Parse a statement file by its name/content and create the new lines; returns { db, count }. */
export function importStatement(db, fileName, text, defaults = {}) {
  const camt = /\.xml$/i.test(fileName) || /<BkToCstmrStmt/.test(text);
  const lines = camt ? parseCamt(text) : parseOfx(text);
  if (!lines.length) throw new Error('No transactions found in this file');
  if (!defaults.journal_id) throw new Error('Bank Journal is required');
  const journal = read(db, 'account.journal', defaults.journal_id);
  if (!journal) throw new Error('The bank journal does not exist');
  if (defaults.company_id && (journal.company_id ?? 1) !== defaults.company_id) throw new Error('The bank journal belongs to another company');
  const company = journal?.company_id ?? defaults.company_id ?? 1;
  const currencyId = journal?.currency_id ?? read(db, 'res.company', company)?.currency_id ?? null;
  const currency = read(db, 'res.currency', currencyId);
  if (camt && lines.some((l) => !l.currency || l.currency !== currency?.name)) throw new Error(`Statement currency does not match journal currency ${currency?.name ?? ''}`);
  const journalId = defaults.journal_id ?? null;
  const known = new Set(search(db, 'account.bank.statement.line').filter((l) => (l.journal_id ?? null) === journalId && (l.company_id ?? 1) === company).map((l) => l.unique_import_id).filter(Boolean));
  const fresh = lines.filter((l) => {
    if (!l.unique_import_id) return true;
    if (known.has(l.unique_import_id)) return false;
    known.add(l.unique_import_id);
    return true;
  });
  const next = fresh.reduce((acc, { currency: _currency, ...l }) => create(acc, 'account.bank.statement.line', { ...defaults, ...l, currency_id: currencyId, ...(journal ? { company_id: journal.company_id ?? 1 } : {}), payment_ref: l.payment_ref || '/', state: 'to_check' }).db, db);
  return { db: next, count: fresh.length };
}
