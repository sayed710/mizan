import { test } from 'node:test';
import assert from 'node:assert/strict';
import { epcPayload, invoiceQrPayload, qrMatrix, zatcaPayload } from './models/qr.js';

const decodeTlv = (b64) => {
  const raw = Buffer.from(b64, 'base64');
  const out = [];
  for (let i = 0; i < raw.length;) {
    const [tag, len] = [raw[i], raw[i + 1]];
    out.push([tag, raw.subarray(i + 2, i + 2 + len).toString('utf8')]);
    i += 2 + len;
  }
  return out;
};

test('the ZATCA payload is base64 TLV with the five phase-1 fields, UTF-8 seller names included', () => {
  const tlv = decodeTlv(zatcaPayload({ seller: 'شركة ميزان', vat: '300000000000003', timestamp: '2026-05-01T00:00:00Z', total: 1150, tax: 150 }));
  assert.deepEqual(tlv, [[1, 'شركة ميزان'], [2, '300000000000003'], [3, '2026-05-01T00:00:00Z'], [4, '1150.00'], [5, '150.00']]);
});

test('the EPC payload follows the SEPA layout and rejects a bad IBAN', () => {
  const text = epcPayload({ name: 'Mizan', iban: 'de89 3704 0044 0532 0130 00', amount: 99.5, reference: 'INV/2026/00001' });
  assert.deepEqual(text.split('\n'), ['BCD', '002', '1', 'SCT', '', 'Mizan', 'DE89370400440532013000', 'EUR99.50', '', '', 'INV/2026/00001']);
  assert.throws(() => epcPayload({ name: 'x', iban: 'nope', amount: 1 }), /IBAN/);
});

test('invoices get a QR only when enabled, posted, and (for EPC) in euros', () => {
  const move = { move_type: 'out_invoice', state: 'posted', name: 'INV/1', invoice_date: '2026-05-01', amount_total: 114, amount_tax: 14, amount_residual: 114 };
  const company = { name: 'Mizan', currency: 'USD' };
  assert.equal(invoiceQrPayload({}, company, move), null);
  assert.ok(invoiceQrPayload({ invoice_qr: 'zatca', company_vat: '3' }, company, move));
  assert.equal(invoiceQrPayload({ invoice_qr: 'epc', company_iban: 'DE89370400440532013000' }, company, move), null);
  assert.match(invoiceQrPayload({ invoice_qr: 'epc', company_iban: 'DE89370400440532013000' }, { ...company, currency: 'EUR' }, move), /^BCD/);
  assert.equal(invoiceQrPayload({ invoice_qr: 'zatca' }, company, { ...move, state: 'draft' }), null);
});

test('the QR matrix is square with the finder pattern in the corner', () => {
  const grid = qrMatrix('hello');
  assert.equal(grid.length, grid[0].length);
  assert.deepEqual(grid[0].slice(0, 7), [true, true, true, true, true, true, true]);
});
