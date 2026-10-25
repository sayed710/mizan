// Payment QR codes printed on customer invoices: ZATCA (Saudi e-invoicing TLV) or EPC/SEPA credit transfer.
import qrcode from 'qrcode-generator';

qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

const bytes = (s) => new TextEncoder().encode(String(s));
const base64 = (arr) => btoa(String.fromCharCode(...arr));

/** ZATCA phase-1 payload: base64 of tag-length-value fields (seller, VAT number, timestamp, total, VAT). */
export function zatcaPayload({ seller, vat, timestamp, total, tax }) {
  const fields = [seller, vat, timestamp, Number(total).toFixed(2), Number(tax).toFixed(2)].map(bytes);
  if (fields.some((f) => f.length > 255)) throw new Error('A QR field is too long');
  return base64(fields.flatMap((f, i) => [i + 1, f.length, ...f]));
}

/** EPC069-12 (SEPA credit transfer) text; amounts in EUR only, as the standard requires. */
export function epcPayload({ name, iban, bic = '', amount, reference }) {
  const cleanIban = String(iban ?? '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(cleanIban)) throw new Error('Set a valid IBAN for payment QR codes');
  return ['BCD', '002', '1', 'SCT', bic, String(name).slice(0, 70), cleanIban, `EUR${Number(amount).toFixed(2)}`, '', '', String(reference ?? '').slice(0, 140)].join('\n');
}

/** QR payload for a posted customer invoice per the company setting, or null when off / not applicable. */
export function invoiceQrPayload(settings, company, move) {
  if (move.move_type !== 'out_invoice' || move.state !== 'posted' || !settings?.invoice_qr) return null;
  if (settings.invoice_qr === 'zatca') {
    return zatcaPayload({ seller: company.name, vat: settings.company_vat ?? '', timestamp: `${move.invoice_date}T00:00:00Z`, total: move.amount_total, tax: move.amount_tax });
  }
  // EPC is euro-only and needs at least 0.01 to pay.
  if (company.currency !== 'EUR' || move.currency_id || !(move.amount_residual >= 0.01)) return null;
  return epcPayload({ name: company.name, iban: settings.company_iban, amount: move.amount_residual, reference: move.payment_reference || move.name });
}

/** QR modules as rows of booleans (error correction M, smallest version that fits). */
export function qrMatrix(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (__, c) => qr.isDark(r, c)));
}
