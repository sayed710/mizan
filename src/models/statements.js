// Bank statement files (OFX/QFX, CAMT.053) parsed into statement lines; re-importing the same transactions is a no-op.
import { create, search } from '../orm.js';

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
    const ref = xmlTag(b, ['Ustrd']) || xmlTag(b, ['AddtlNtryInf']) || xmlTag(b, ['Nm']);
    return {
      date: (xmlTag(b, ['BookgDt', 'Dt']) || xmlTag(b, ['BookgDt', 'DtTm'])).slice(0, 10) || null,
      amount: xmlTag(b, ['CdtDbtInd']) === 'DBIT' ? -amount : amount,
      payment_ref: unescapeXml(ref),
      unique_import_id: xmlTag(b, ['AcctSvcrRef']) || null,
    };
  }).filter((l) => /^\d{4}-\d{2}-\d{2}$/.test(l.date ?? '') && Number.isFinite(l.amount));
}

/** Parse a statement file by its name/content and create the new lines; returns { db, count }. */
export function importStatement(db, fileName, text) {
  const camt = /\.xml$/i.test(fileName) || /<BkToCstmrStmt/.test(text);
  const lines = camt ? parseCamt(text) : parseOfx(text);
  if (!lines.length) throw new Error('No transactions found in this file');
  const known = new Set(search(db, 'account.bank.statement.line').map((l) => l.unique_import_id).filter(Boolean));
  const fresh = lines.filter((l) => !l.unique_import_id || !known.has(l.unique_import_id));
  const next = fresh.reduce((acc, l) => create(acc, 'account.bank.statement.line', { ...l, payment_ref: l.payment_ref || '/', state: 'to_check' }).db, db);
  return { db: next, count: fresh.length };
}
