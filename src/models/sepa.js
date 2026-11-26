// SWIFT IBAN Registry, release 103 (September 2026): registered country lengths.
const IBAN_LENGTHS = { AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FP: 27, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HN: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28, NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20, YE: 30 };

// EPC SEPA Scheme Geographical Scope (EPC409-09 v8.0): 27 EU member states, 3 EEA, and 11 non-EEA countries/territories.
export const SEPA_COUNTRY_CODES = new Set([
  'AD', 'AL', 'AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI',
  'FR', 'GB', 'GI', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV',
  'MC', 'MD', 'ME', 'MK', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'RS', 'SE', 'SI',
  'SK', 'SM', 'VA',
]);

export function isSepaCountry(countryCode) {
  return SEPA_COUNTRY_CODES.has(String(countryCode ?? '').toUpperCase());
}

// ISO 13616 checksum; whitespace is accepted in displayed account numbers.
export function isValidIban(value) {
  const iban = String(value ?? '').replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban) || IBAN_LENGTHS[iban.slice(0, 2)] !== iban.length) return false;
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}

const escapeXml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const normalizedIban = (value) => String(value ?? '').replace(/\s/g, '').toUpperCase();

export const DEFAULT_SEPA_PAIN_VERSION = 'pain.001.001.09';
export const CHARGE_BEARERS = [['CRED', 'Borne by Creditor'], ['DEBT', 'Borne by Debtor'], ['SHAR', 'Shared'], ['SLEV', 'Following Service Level']];
export const DEFAULT_CHARGE_BEARER = 'SHAR';

export const SEPA_PAIN_VERSIONS = [
  ['pain.001.001.03', 'Generic'],
  ['pain.001.001.09', 'New generic version (09)'],
];

const PAIN_VARIANTS = {
  'pain.001.001.03': {
    namespace: 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.03',
    bicTag: 'BIC',
    formatExecutionDate: (date) => `<ReqdExctnDt>${escapeXml(date)}</ReqdExctnDt>`,
  },
  'pain.001.001.09': {
    namespace: 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.09',
    bicTag: 'BICFI',
    formatExecutionDate: (date) => `<ReqdExctnDt><Dt>${escapeXml(date)}</Dt></ReqdExctnDt>`,
  },
};

export function isValidSepaPainVersion(version) {
  return typeof version === 'string' && Object.hasOwn(PAIN_VARIANTS, version);
}

/** Build a pain.001.001.03 or pain.001.001.09 document from already resolved payment data. */
export function buildSepaXml({ id, msgId, pmtInfId, createdAt, date, painVersion = DEFAULT_SEPA_PAIN_VERSION, debtor, payments }) {
  const variant = isValidSepaPainVersion(painVersion) ? PAIN_VARIANTS[painVersion] : null;
  if (!variant) throw new Error('Unsupported SEPA pain version');
  const effectiveId = id ?? msgId;
  const effectiveMsgId = msgId ?? effectiveId;
  const effectivePmtInfId = pmtInfId ?? effectiveId;
  if (!effectiveMsgId) throw new Error('The batch reference is required');
  if (String(effectiveMsgId).length > 35) throw new Error('Batch reference cannot exceed 35 characters');
  if (effectivePmtInfId && String(effectivePmtInfId).length > 35) throw new Error('Payment information identifier cannot exceed 35 characters');
  if (!debtor?.iban) throw new Error('The journal account has no IBAN');
  if (!isValidIban(debtor.iban)) throw new Error('The journal account has an invalid IBAN');
  const debtorCountry = normalizedIban(debtor.iban).slice(0, 2);
  if (!isSepaCountry(debtorCountry)) throw new Error('The journal account IBAN is not in the SEPA zone');
  if (!debtor.name || !debtor.bic) throw new Error('The debtor name and BIC are required');
  if (String(debtor.name).length > 70) throw new Error('Debtor name cannot exceed 70 characters');
  if (!payments?.length) throw new Error('Add at least one payment to the batch');
  let total = 0;
  const transactions = payments.map((payment) => {
    if (payment.id != null && String(payment.id).length > 35) throw new Error('Payment reference cannot exceed 35 characters');
    if (!payment.iban) throw new Error('A payment has no recipient IBAN');
    if (!isValidIban(payment.iban)) throw new Error('A payment has an invalid recipient IBAN');
    const recipientCountry = normalizedIban(payment.iban).slice(0, 2);
    if (!isSepaCountry(recipientCountry)) throw new Error('A payment recipient IBAN is not in the SEPA zone');
    const amount = Number(payment.amount);
    if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) throw new Error('Payment amount must be positive with at most two decimals');
    if (!payment.name) throw new Error('A payment has no creditor name');
    if (String(payment.name).length > 70) throw new Error('Creditor name cannot exceed 70 characters');
    if (payment.memo && String(payment.memo).length > 140) throw new Error('Remittance information cannot exceed 140 characters');
    total += Math.round(amount * 100);
    return `<CdtTrfTxInf><PmtId><EndToEndId>${escapeXml(payment.id)}</EndToEndId></PmtId><Amt><InstdAmt Ccy="EUR">${amount.toFixed(2)}</InstdAmt></Amt><Cdtr><Nm>${escapeXml(payment.name)}</Nm></Cdtr><CdtrAcct><Id><IBAN>${normalizedIban(payment.iban)}</IBAN></Id></CdtrAcct>${payment.memo ? `<RmtInf><Ustrd>${escapeXml(payment.memo)}</Ustrd></RmtInf>` : ''}</CdtTrfTxInf>`;
  }).join('');
  const sum = (total / 100).toFixed(2);
  const count = payments.length;
  return `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="${variant.namespace}"><CstmrCdtTrfInitn><GrpHdr><MsgId>${escapeXml(effectiveMsgId)}</MsgId><CreDtTm>${escapeXml(createdAt)}</CreDtTm><NbOfTxs>${count}</NbOfTxs><CtrlSum>${sum}</CtrlSum><InitgPty><Nm>${escapeXml(debtor.name)}</Nm></InitgPty></GrpHdr><PmtInf><PmtInfId>${escapeXml(effectivePmtInfId)}</PmtInfId><PmtMtd>TRF</PmtMtd><NbOfTxs>${count}</NbOfTxs><CtrlSum>${sum}</CtrlSum><PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>${variant.formatExecutionDate(date)}<Dbtr><Nm>${escapeXml(debtor.name)}</Nm></Dbtr><DbtrAcct><Id><IBAN>${normalizedIban(debtor.iban)}</IBAN></Id></DbtrAcct><DbtrAgt><FinInstnId><${variant.bicTag}>${escapeXml(debtor.bic)}</${variant.bicTag}></FinInstnId></DbtrAgt><ChrgBr>SLEV</ChrgBr>${transactions}</PmtInf></CstmrCdtTrfInitn></Document>`;
}
