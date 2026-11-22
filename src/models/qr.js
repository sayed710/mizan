// Payment QR codes printed on customer invoices: ZATCA (Saudi e-invoicing TLV) or EPC/SEPA credit transfer.
import qrcode from 'qrcode-generator';
import { read } from '../orm.js';
import { partnerBankBic, sanitizeAccountNumber } from './partnerbank.js';

qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

const bytes = (s) => new TextEncoder().encode(String(s));
const base64 = (arr) => btoa(String.fromCharCode(...arr));
const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;

const resolveCompanyPartnerId = (db, company, move) => {
  if (company?.partner_id != null) return company.partner_id;
  const companyId = company?.id ?? move?.company_id ?? null;
  return companyId && db ? (read(db, 'res.company', companyId)?.partner_id ?? null) : null;
};

const isCompanyBankAccount = (db, company, move, bankAccount) => {
  if (!bankAccount || bankAccount.active === false) return false;
  const companyId = company?.id ?? move?.company_id ?? null;
  if (companyId && bankAccount.company_id && bankAccount.company_id !== companyId) return false;
  const ownerPartnerId = resolveCompanyPartnerId(db, company, move);
  return Boolean(ownerPartnerId && bankAccount.partner_id === ownerPartnerId);
};

/** ZATCA phase-1 payload: base64 of tag-length-value fields (seller, VAT number, timestamp, total, VAT). */
export function zatcaPayload({ seller, vat, timestamp, total, tax }) {
  const fields = [seller, vat, timestamp, Number(total).toFixed(2), Number(tax).toFixed(2)].map(bytes);
  if (fields.some((f) => f.length > 255)) throw new Error('A QR field is too long');
  return base64(fields.flatMap((f, i) => [i + 1, f.length, ...f]));
}

/** EPC069-12 (SEPA credit transfer) text; amounts in EUR only, as the standard requires. */
export function epcPayload({ name, iban, bic = '', amount, reference }) {
  const cleanIban = sanitizeAccountNumber(iban);
  if (!IBAN_RE.test(cleanIban)) throw new Error('Set a valid IBAN for payment QR codes');
  return ['BCD', '002', '1', 'SCT', bic, String(name).slice(0, 70), cleanIban, `EUR${Number(amount).toFixed(2)}`, '', '', String(reference ?? '').slice(0, 140)].join('\n');
}

/** QR payload for a posted customer invoice per the company setting, or null when off / not applicable. */
export function invoiceQrPayload(settings, company, move, invoiceCurrency = move.currency_id ? null : company.currency, db = null) {
  if (move.move_type !== 'out_invoice' || move.state !== 'posted' || !settings?.invoice_qr) return null;
  if (settings.invoice_qr === 'zatca') {
    return zatcaPayload({ seller: company.name, vat: settings.company_vat ?? '', timestamp: `${move.invoice_date}T00:00:00Z`, total: move.amount_total, tax: move.amount_tax });
  }
  // EPC is euro-only and needs at least 0.01 to pay.
  if (invoiceCurrency !== 'EUR' || !(move.amount_residual >= 0.01)) return null;
  const bankAccount = db && move?.partner_bank_id ? read(db, 'res.partner.bank', move.partner_bank_id) : null;
  const companyOwnedBank = isCompanyBankAccount(db, company, move, bankAccount);
  const bankAccountIban = companyOwnedBank ? sanitizeAccountNumber(bankAccount.account_number) : '';
  const isBankAccountIban = Boolean(companyOwnedBank && IBAN_RE.test(bankAccountIban));
  const iban = isBankAccountIban ? bankAccountIban : (settings?.company_iban ?? '');

  let bic = '';
  if (isBankAccountIban) {
    bic = partnerBankBic(db, bankAccount);
  } else {
    const cleanCompanyIban = sanitizeAccountNumber(iban);
    if (cleanCompanyIban && db) {
      const match = (db.records?.['res.partner.bank'] ?? []).find(
        (b) => isCompanyBankAccount(db, company, move, b)
          && (b.sanitized_account_number === cleanCompanyIban || sanitizeAccountNumber(b.account_number) === cleanCompanyIban)
      );
      if (match) bic = partnerBankBic(db, match);
    }
  }

  return epcPayload({ name: company.name, iban, bic, amount: move.amount_residual, reference: move.payment_reference || move.name });
}

/** Resolve QR mode and issuer identity from the document company. */
export function invoiceQrSettingsForCompany(db, company) {
  const comp = company ?? {};
  return {
    invoice_qr: comp.invoice_qr ?? null,
    company_vat: comp.vat ?? '',
    company_iban: comp.company_iban ?? '',
  };
}

/** QR modules as rows of booleans (error correction M, smallest version that fits). */
export function qrMatrix(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (__, c) => qr.isDark(r, c)));
}
