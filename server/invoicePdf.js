// Genuine Unicode/RTL-capable PDF 1.4 generator for account.move invoice/credit note reports.
import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import bidiFactory from 'bidi-js';
import { models } from '../src/models/index.js';
import { read } from '../src/orm.js';
import { subtotal, today, validDate } from '../src/models/common.js';
import { addressLines, documentCompany, documentTaxBreakdown } from '../src/models/company.js';
import { invoiceTaxTotals } from '../src/models/ledger.js';
import { invoiceQrPayload, invoiceQrSettingsForCompany, qrMatrix } from '../src/models/qr.js';
import { invoiceTaxLegalNotes, isSectionOrNote, taxInvoiceLabel } from '../src/models/taxes.js';
import { dueTermLinesError, installments, invoiceInstallments, invoiceTermNote, termScheduleError } from '../src/models/terms.js';
import { documentCurrency, formatCurrency } from '../src/money.js';
import { translate } from '../src/i18n.js';

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN_X = 40;
const MARGIN_TOP = 48;
const MARGIN_BOTTOM = 48;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const WITHOUT_PAYMENT_REPORTS = new Set(['without_payment', 'invoices_without_payment']);

const ARABIC_FEATURES = ['calt', 'liga', 'rlig'];
const BIDI_CONTROL_CPS = new Set([0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff]);

const req = createRequire(import.meta.url);
const FONT_PATHS = {
  Ar: req.resolve('@fontsource-variable/noto-sans-arabic/files/noto-sans-arabic-arabic-wght-normal.woff2'),
  La: req.resolve('@fontsource-variable/noto-sans-arabic/files/noto-sans-arabic-latin-wght-normal.woff2'),
  Le: req.resolve('@fontsource-variable/noto-sans-arabic/files/noto-sans-arabic-latin-ext-wght-normal.woff2'),
  Ma: req.resolve('@fontsource-variable/noto-sans-arabic/files/noto-sans-arabic-math-wght-normal.woff2'),
  Sy: req.resolve('@fontsource-variable/noto-sans-arabic/files/noto-sans-arabic-symbols-wght-normal.woff2'),
};

const bidi = bidiFactory();

export const UNSUPPORTED_UNICODE_PDF_ERROR = 'Invoice PDF generation does not support non-Latin or Arabic characters without a Unicode PDF renderer or embedded TTF font';

const toHexColor = ([r, g, b]) =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')).join('');

const normalizeText = (value) =>
  String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\t/g, ' ');

const isSurrogateHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isSurrogateLow = (c) => c >= 0xdc00 && c <= 0xdfff;

/** Read one visual token (handling surrogate pairs regardless of sweep direction) from reordered indices. */
function collectVisualChars(text, embed, order) {
  const mirrored = bidi.getMirroredCharactersMap(text, embed.levels);
  const items = [];
  for (let k = 0; k < order.length; k++) {
    const idx = order[k];
    const cu = text.charCodeAt(idx);
    let ch = text[idx];
    let level = embed.levels[idx];
    if (k + 1 < order.length) {
      const nextIdx = order[k + 1];
      if (isSurrogateHigh(cu) && isSurrogateLow(text.charCodeAt(nextIdx))) {
        ch = text[idx] + text[nextIdx];
        k++;
      } else if (isSurrogateLow(cu) && isSurrogateHigh(text.charCodeAt(nextIdx))) {
        ch = text[nextIdx] + text[idx];
        k++;
      }
    }
    if (ch.length === 1 && mirrored.has(idx)) ch = mirrored.get(idx);
    const cp = ch.codePointAt(0);
    if (BIDI_CONTROL_CPS.has(cp) || cp < 0x20) continue;
    items.push({ ch, cp, rtl: (level % 2) === 1 });
  }
  return items;
}

/** Create a PDFKit builder with lazy Noto Sans Arabic variable-font subsets and UAX #9 bidi layout. */
function createPdfBuilder(footerLeft, isRtl, tr) {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 0,
    compress: true,
    pdfVersion: '1.4',
    bufferPages: true,
  });

  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const loadedFonts = new Map();
  const ensureFont = (key, bold = false) => {
    const id = `${key}${bold ? 'Bold' : 'Reg'}`;
    if (!loadedFonts.has(id)) {
      doc.registerFont(id, FONT_PATHS[key], bold ? 'Bold' : 'Regular');
      doc.font(id);
      loadedFonts.set(id, { id, raw: doc._font.font });
    }
    return loadedFonts.get(id);
  };

  // Preload Regular primary Latin & Arabic subsets for fast glyph lookup.
  ensureFont('Ar', false);
  ensureFont('La', false);

  const pickFontKey = (cp, rtl) => {
    if (cp === 0x20) return rtl ? 'Ar' : 'La';
    if (cp === 0x200c || cp === 0x200d) return 'Ar';
    const order = rtl ? ['Ar', 'La', 'Le', 'Ma', 'Sy'] : ['La', 'Ar', 'Le', 'Ma', 'Sy'];
    for (const key of order) {
      if (ensureFont(key, false).raw.hasGlyphForCodePoint(cp)) return key;
    }
    throw new Error(UNSUPPORTED_UNICODE_PDF_ERROR);
  };

  /** Split one logical line into visually left-to-right positioned segments with resolved fonts and widths. */
  const layoutVisualLine = (rawText, size, bold = false, baseDir = isRtl ? 'auto' : 'ltr') => {
    const text = normalizeText(rawText);
    if (!text) return { segments: [], width: 0 };
    const embed = bidi.getEmbeddingLevels(text, baseDir);
    const order = bidi.getReorderedIndices(text, embed);
    const items = collectVisualChars(text, embed, order);
    const grouped = [];
    for (const item of items) {
      const font = pickFontKey(item.cp, item.rtl);
      const isEasternDigit = (item.cp >= 0x0660 && item.cp <= 0x0669) || (item.cp >= 0x06f0 && item.cp <= 0x06f9);
      const mode = item.rtl && font === 'Ar' ? 'ar-rtl' : font === 'Ar' && isEasternDigit ? 'ar-digit' : 'ltr';
      const prev = grouped[grouped.length - 1];
      if (mode !== 'ar-digit' && prev && prev.mode === mode && prev.font === font) {
        prev.chars.push(item.ch);
      } else {
        grouped.push({ mode, font, chars: [item.ch] });
      }
    }
    let totalW = 0;
    const segments = grouped.map((g) => {
      const segText = g.mode === 'ar-rtl' ? g.chars.reverse().join('') : g.chars.join('');
      const features = g.font === 'Ar' ? ARABIC_FEATURES : undefined;
      const { id } = ensureFont(g.font, bold);
      const w = doc.font(id).fontSize(size).widthOfString(segText, features ? { features } : {});
      totalW += w;
      return { fontId: id, text: segText, features, width: w };
    });
    return { segments, width: totalW };
  };

  const measureText = (text, size, bold = false, baseDir = isRtl ? 'auto' : 'ltr') =>
    layoutVisualLine(text, size, bold, baseDir).width;

  const wrapText = (text, maxWidth, size, bold = false, baseDir = isRtl ? 'auto' : 'ltr') => {
    const paragraphs = normalizeText(text).split(/\r?\n/);
    const lines = [];
    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) {
        lines.push('');
        continue;
      }
      const words = trimmed.split(/\s+/);
      let current = '';
      for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (measureText(candidate, size, bold, baseDir) <= maxWidth) {
          current = candidate;
        } else if (!current) {
          let chunk = '';
          for (const ch of word) {
            if (measureText(chunk + ch, size, bold, baseDir) > maxWidth && chunk) {
              lines.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          current = chunk;
        } else {
          lines.push(current);
          current = word;
        }
      }
      if (current) lines.push(current);
    }
    return lines.length ? lines : [''];
  };

  let y = MARGIN_TOP;

  const newPage = () => {
    doc.addPage({ size: 'A4', margin: 0 });
    y = MARGIN_TOP;
  };

  const ensureSpace = (height, onNewPage = null) => {
    if (y + height > PAGE_H - MARGIN_BOTTOM) {
      newPage();
      onNewPage?.();
    }
  };

  const drawText = (x, baselineY, text, { size = 10, bold = false, color = [0.07, 0.09, 0.13], align = isRtl ? 'right' : 'left', baseDir = isRtl ? 'auto' : 'ltr' } = {}) => {
    const clean = normalizeText(text);
    const layout = layoutVisualLine(clean, size, bold, baseDir);
    if (!layout.segments.length) return;
    let cursorX = align === 'right' ? x - layout.width : align === 'center' ? x - layout.width / 2 : x;
    doc.fillColor(toHexColor(color));
    doc.markContent('Span', { actual: clean, lang: isRtl ? 'ar' : 'en' });
    for (const seg of layout.segments) {
      doc.font(seg.fontId).fontSize(size).text(seg.text, cursorX, baselineY, {
        baseline: 'alphabetic',
        lineBreak: false,
        ...(seg.features ? { features: seg.features } : {}),
      });
      cursorX += seg.width;
    }
    doc.endMarkedContent();
  };

  const drawLine = (x1, y1, x2, y2, { width = 0.5, color = [0.82, 0.85, 0.89] } = {}) => {
    doc.save().lineWidth(width).strokeColor(toHexColor(color)).moveTo(x1, y1).lineTo(x2, y2).stroke().restore();
  };

  const fillRect = (x, rectY, w, h, color = [0.95, 0.96, 0.98]) => {
    doc.save().fillColor(toHexColor(color)).rect(x, rectY, w, h).fill().restore();
  };

  const finish = () => {
    const range = doc.bufferedPageRange();
    const total = range.count;
    const footerColor = [0.42, 0.45, 0.5];
    const lineY = PAGE_H - 38;
    const textY = PAGE_H - 24;
    for (let i = 0; i < total; i++) {
      doc.switchToPage(range.start + i);
      drawLine(MARGIN_X, lineY, PAGE_W - MARGIN_X, lineY, { width: 0.5, color: [0.85, 0.87, 0.91] });
      const pageLabel = tr('Page {page} of {pages}', { page: i + 1, pages: total });
      if (isRtl) {
        drawText(PAGE_W - MARGIN_X, textY, footerLeft, { size: 8, color: footerColor, align: 'right' });
        drawText(MARGIN_X, textY, pageLabel, { size: 8, color: footerColor, align: 'left' });
      } else {
        drawText(MARGIN_X, textY, footerLeft, { size: 8, color: footerColor, align: 'left' });
        drawText(PAGE_W - MARGIN_X, textY, pageLabel, { size: 8, color: footerColor, align: 'right' });
      }
    }
    doc.end();
    return done;
  };

  return {
    get y() { return y; },
    set y(v) { y = v; },
    newPage,
    ensureSpace,
    wrapText,
    drawText,
    drawLine,
    fillRect,
    finish,
  };
}

function formatMoneyAmount(db, rec, currency, value) {
  const n = Number(value) || 0;
  if (currency) return formatCurrency(n, currency);
  const compCurrency = rec?.company_id ? read(db, 'res.company', rec.company_id)?.currency_id : null;
  const fallback = compCurrency ? read(db, 'res.currency', compCurrency) : null;
  if (fallback) return formatCurrency(n, fallback);
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function moveTitle(rec, tr = (s) => s) {
  const stateTitles = {
    draft: { out_invoice: 'Draft Invoice', out_refund: 'Draft Credit Note', in_invoice: 'Draft Bill', in_refund: 'Draft Refund' },
    cancel: { out_invoice: 'Cancelled Invoice', out_refund: 'Cancelled Credit Note', in_invoice: 'Cancelled Bill', in_refund: 'Cancelled Refund' },
  };
  const base = tr(stateTitles[rec.state]?.[rec.move_type] ?? models['account.move'].form.subtitle(rec));
  const showName = rec.name && rec.name !== '/' && !(rec.state === 'draft' && ['out_invoice', 'out_refund', 'in_invoice', 'in_refund'].includes(rec.move_type));
  return showName ? `${base} ${rec.name}` : base;
}

function lineTaxDisplay(l) {
  if (Array.isArray(l.tax_ids) && l.tax_ids.length > 1 && Array.isArray(l.tax_breakdown) && l.tax_breakdown.length) {
    return l.tax_breakdown.map((t) => taxInvoiceLabel(t)).join(', ');
  }
  if (l.tax_invoice_label) return l.tax_invoice_label;
  if (l.tax_name) return l.tax_name;
  return '';
}

/** Generate a genuine Unicode/RTL-capable PDF binary for an `account.move` invoice/credit note and chosen `pdfReportId`. */
export async function generateInvoicePdf(db, move, { pdfReportId = 'invoices', company = null, lang = 'en' } = {}) {
  const docCompany = company ?? documentCompany(db, move);
  if (!docCompany) throw new Error('Configure the document company before emailing.');
  const isRtl = lang === 'ar';
  const tr = (label, vars) => translate(label, lang, vars);
  const currency = documentCurrency(db, move);
  const money = (v) => formatMoneyAmount(db, move, currency, v);
  const partner = move.partner_id ? read(db, 'res.partner', move.partner_id) : null;

  const pdf = createPdfBuilder(`${docCompany.name} · ${tr('Generated by Mizan')}`, isRtl, tr);
  const muted = [0.38, 0.42, 0.49];
  const dark = [0.07, 0.09, 0.13];

  // Header: Company (left in LTR, right in RTL) and Partner (right in LTR, left in RTL)
  const companyLines = [
    ...addressLines(docCompany, tr('Tax ID')),
    docCompany.currency ?? tr('Company currency is not configured'),
  ];
  const partnerLines = partner
    ? [
        ...[partner.email ?? partner.work_email, partner.phone ?? partner.work_phone].filter(Boolean),
        ...addressLines(partner, tr('Tax ID')),
      ]
    : [];

  const companyX = isRtl ? PAGE_W - MARGIN_X : MARGIN_X;
  const companyAlign = isRtl ? 'right' : 'left';
  let companyY = pdf.y + 12;
  pdf.drawText(companyX, companyY, docCompany.name, { size: 13, bold: true, color: dark, align: companyAlign });
  companyY += 16;
  for (const line of companyLines) {
    for (const wrapped of pdf.wrapText(line, 240, 9)) {
      pdf.drawText(companyX, companyY, wrapped, { size: 9, color: muted, align: companyAlign });
      companyY += 12;
    }
  }

  let partnerY = pdf.y + 11;
  if (partner) {
    const partnerX = isRtl ? MARGIN_X + 240 : MARGIN_X + 275;
    const partnerAlign = isRtl ? 'right' : 'left';
    pdf.drawText(partnerX, partnerY, partner.name, { size: 11, bold: true, color: dark, align: partnerAlign });
    partnerY += 14;
    for (const line of partnerLines) {
      for (const wrapped of pdf.wrapText(line, 240, 9)) {
        pdf.drawText(partnerX, partnerY, wrapped, { size: 9, color: dark, align: partnerAlign });
        partnerY += 12;
      }
    }
  }

  pdf.y = Math.max(companyY, partnerY) + 6;
  pdf.drawLine(MARGIN_X, pdf.y, PAGE_W - MARGIN_X, pdf.y, { width: 0.75 });
  pdf.y += 24;

  // Document Title
  const titleX = isRtl ? PAGE_W - MARGIN_X : MARGIN_X;
  const textAlign = isRtl ? 'right' : 'left';
  pdf.drawText(titleX, pdf.y, moveTitle(move, tr), { size: 16, bold: true, color: dark, align: textAlign });
  pdf.y += 22;

  // Header info fields (matching PrintDoc LAYOUTS['account.move'].info)
  const infoPairs = [
    [tr('Invoice Date'), move.invoice_date],
    [tr('Due Date'), move.invoice_date_due],
    [tr('Reference'), move.ref],
    [tr('Source Document'), move.invoice_origin],
    [tr('Payment Reference'), move.payment_reference],
    [tr('Incoterm'), move.incoterm_id ? read(db, 'account.incoterm', move.incoterm_id)?.name : null],
    [tr('Incoterm Location'), move.incoterm_location],
  ].filter(([, val]) => val);

  if (infoPairs.length) {
    const colW = CONTENT_W / 2;
    for (let i = 0; i < infoPairs.length; i += 2) {
      pdf.ensureSpace(26);
      const rowY = pdf.y;
      for (let j = 0; j < 2 && i + j < infoPairs.length; j++) {
        const [label, value] = infoPairs[i + j];
        const x = isRtl ? PAGE_W - MARGIN_X - j * colW : MARGIN_X + j * colW;
        pdf.drawText(x, rowY, label, { size: 8, bold: true, color: muted, align: textAlign });
        pdf.drawText(x, rowY + 11, String(value), { size: 9.5, color: dark, align: textAlign });
      }
      pdf.y += 28;
    }
    pdf.y += 4;
  }

  // Invoice Lines Table
  const lines = move.invoice_line_ids ?? [];
  const hasDiscount = lines.some((l) => Number(l.discount) > 0);
  const numAlign = isRtl ? 'left' : 'right';
  const cols = isRtl
    ? hasDiscount
      ? [
          { key: 'desc', label: tr('Description'), x: PAGE_W - MARGIN_X - 4, w: 185, align: 'right' },
          { key: 'qty', label: tr('Quantity'), x: MARGIN_X + 270, w: 45, align: 'left' },
          { key: 'price', label: tr('Unit Price'), x: MARGIN_X + 195, w: 68, align: 'left' },
          { key: 'disc', label: tr('Disc %'), x: MARGIN_X + 152, w: 36, align: 'left' },
          { key: 'tax', label: tr('Taxes'), x: MARGIN_X + 144, w: 68, align: 'right' },
          { key: 'amt', label: tr('Amount'), x: MARGIN_X + 4, w: 66, align: 'left' },
        ]
      : [
          { key: 'desc', label: tr('Description'), x: PAGE_W - MARGIN_X - 4, w: 220, align: 'right' },
          { key: 'qty', label: tr('Quantity'), x: MARGIN_X + 232, w: 50, align: 'left' },
          { key: 'price', label: tr('Unit Price'), x: MARGIN_X + 154, w: 70, align: 'left' },
          { key: 'tax', label: tr('Taxes'), x: MARGIN_X + 146, w: 68, align: 'right' },
          { key: 'amt', label: tr('Amount'), x: MARGIN_X + 4, w: 68, align: 'left' },
        ]
    : hasDiscount
      ? [
          { key: 'desc', label: tr('Description'), x: MARGIN_X + 4, w: 190, align: 'left' },
          { key: 'qty', label: tr('Quantity'), x: MARGIN_X + 245, w: 45, align: 'right' },
          { key: 'price', label: tr('Unit Price'), x: MARGIN_X + 320, w: 70, align: 'right' },
          { key: 'disc', label: tr('Disc %'), x: MARGIN_X + 362, w: 36, align: 'right' },
          { key: 'tax', label: tr('Taxes'), x: MARGIN_X + 370, w: 65, align: 'left' },
          { key: 'amt', label: tr('Amount'), x: PAGE_W - MARGIN_X - 4, w: 70, align: 'right' },
        ]
      : [
          { key: 'desc', label: tr('Description'), x: MARGIN_X + 4, w: 225, align: 'left' },
          { key: 'qty', label: tr('Quantity'), x: MARGIN_X + 285, w: 50, align: 'right' },
          { key: 'price', label: tr('Unit Price'), x: MARGIN_X + 365, w: 75, align: 'right' },
          { key: 'tax', label: tr('Taxes'), x: MARGIN_X + 375, w: 65, align: 'left' },
          { key: 'amt', label: tr('Amount'), x: PAGE_W - MARGIN_X - 4, w: 68, align: 'right' },
        ];

  const drawLinesHeader = () => {
    pdf.ensureSpace(24);
    pdf.fillRect(MARGIN_X, pdf.y - 4, CONTENT_W, 18, [0.94, 0.95, 0.97]);
    for (const col of cols) {
      pdf.drawText(col.x, pdf.y + 8, col.label, { size: 8.5, bold: true, color: dark, align: col.align });
    }
    pdf.drawLine(MARGIN_X, pdf.y + 15, PAGE_W - MARGIN_X, pdf.y + 15, { width: 1, color: [0.12, 0.14, 0.19] });
    pdf.y += 28;
  };

  drawLinesHeader();
  const fullRowX = isRtl ? PAGE_W - MARGIN_X - 4 : MARGIN_X + 4;
  for (const l of lines) {
    if (isSectionOrNote(l)) {
      const wrapped = pdf.wrapText(l.name ?? '', CONTENT_W - 8, 9, l.display_type === 'line_section');
      const rowH = wrapped.length * 12 + 6;
      pdf.ensureSpace(rowH, drawLinesHeader);
      for (let i = 0; i < wrapped.length; i++) {
        pdf.drawText(fullRowX, pdf.y + i * 12, wrapped[i], {
          size: 9,
          bold: l.display_type === 'line_section',
          color: l.display_type === 'line_section' ? dark : muted,
          align: textAlign,
        });
      }
      pdf.y += rowH;
      pdf.drawLine(MARGIN_X, pdf.y - 4, PAGE_W - MARGIN_X, pdf.y - 4, { width: 0.4, color: [0.89, 0.91, 0.94] });
      continue;
    }

    const prodName = l.product_id ? (read(db, 'product', l.product_id)?.name ?? '') : '';
    const descText = prodName && l.name && l.name !== prodName ? `${prodName} - ${l.name}` : (prodName || l.name || '');
    const descWrapped = pdf.wrapText(descText, cols[0].w, 9);
    const taxCol = cols.find((c) => c.key === 'tax');
    const taxWrapped = pdf.wrapText(lineTaxDisplay(l), taxCol.w, 8.5);
    const lineCount = Math.max(descWrapped.length, taxWrapped.length, 1);
    const rowH = lineCount * 12 + 6;
    pdf.ensureSpace(rowH, drawLinesHeader);

    const topY = pdf.y;
    for (let i = 0; i < descWrapped.length; i++) {
      pdf.drawText(cols[0].x, topY + i * 12, descWrapped[i], { size: 9, color: dark, align: textAlign });
    }
    pdf.drawText(cols[1].x, topY, String(l.qty ?? 0), { size: 9, color: dark, align: numAlign });
    pdf.drawText(cols[2].x, topY, money(l.price_unit ?? 0), { size: 9, color: dark, align: numAlign });
    if (hasDiscount) {
      pdf.drawText(cols[3].x, topY, `${Number(l.discount) || 0}%`, { size: 9, color: dark, align: numAlign });
    }
    for (let i = 0; i < taxWrapped.length; i++) {
      pdf.drawText(taxCol.x, topY + i * 11, taxWrapped[i], { size: 8.5, color: muted, align: textAlign });
    }
    pdf.drawText(cols.at(-1).x, topY, money(subtotal(l)), { size: 9, color: dark, align: numAlign });
    pdf.y += rowH;
    pdf.drawLine(MARGIN_X, pdf.y - 4, PAGE_W - MARGIN_X, pdf.y - 4, { width: 0.4, color: [0.89, 0.91, 0.94] });
  }

  pdf.y += 8;

  // Tax Breakdown Table
  const taxBreakdown = documentTaxBreakdown(db, move, lines);
  if (taxBreakdown.length > 0) {
    const tbTaxX = isRtl ? PAGE_W - MARGIN_X - 4 : MARGIN_X + 4;
    const tbBaseX = isRtl ? MARGIN_X + 130 : MARGIN_X + 380;
    const tbAmtX = isRtl ? MARGIN_X + 4 : PAGE_W - MARGIN_X - 4;
    const drawTaxHeader = () => {
      pdf.ensureSpace(24);
      pdf.fillRect(MARGIN_X, pdf.y - 4, CONTENT_W, 18, [0.94, 0.95, 0.97]);
      pdf.drawText(tbTaxX, pdf.y + 8, tr('Tax'), { size: 8.5, bold: true, color: dark, align: textAlign });
      pdf.drawText(tbBaseX, pdf.y + 8, tr('Base'), { size: 8.5, bold: true, color: dark, align: numAlign });
      pdf.drawText(tbAmtX, pdf.y + 8, tr('Amount'), { size: 8.5, bold: true, color: dark, align: numAlign });
      pdf.drawLine(MARGIN_X, pdf.y + 15, PAGE_W - MARGIN_X, pdf.y + 15, { width: 0.75, color: [0.12, 0.14, 0.19] });
      pdf.y += 28;
    };
    drawTaxHeader();
    for (const row of taxBreakdown) {
      pdf.ensureSpace(16, drawTaxHeader);
      pdf.drawText(tbTaxX, pdf.y, row.label || tr('Tax'), { size: 9, color: dark, align: textAlign });
      pdf.drawText(tbBaseX, pdf.y, money(row.base), { size: 9, color: dark, align: numAlign });
      pdf.drawText(tbAmtX, pdf.y, money(row.amount), { size: 9, color: dark, align: numAlign });
      pdf.y += 16;
    }
    pdf.y += 8;
  }

  // Totals (matching PrintDoc invoiceTaxTotals)
  const taxTotals = invoiceTaxTotals(db, move);
  const totalRows = [];
  if (taxTotals) {
    const hasTaxGroups = taxTotals.subtotals.some((s) => s.groups.length > 0);
    for (const sub of taxTotals.subtotals) {
      totalRows.push([tr(sub.name), money(sub.amount), false]);
      for (const g of sub.groups) {
        totalRows.push([g.tax_group_id ? g.name : tr(g.name), money(g.amount), false]);
      }
    }
    if (!hasTaxGroups && move.amount_tax != null) {
      totalRows.push([tr('Taxes'), money(move.amount_tax), false]);
    }
    if (taxTotals.rounding_amount !== 0) {
      totalRows.push([tr('Cash Rounding'), money(taxTotals.rounding_amount), false]);
    }
  } else if (move.amount_untaxed != null) {
    totalRows.push([tr('Untaxed Amount'), money(move.amount_untaxed), false]);
    if (move.amount_tax != null) totalRows.push([tr('Taxes'), money(move.amount_tax), false]);
  }
  if (move.amount_total != null) totalRows.push([tr('Total'), money(move.amount_total), true]);
  if (move.state === 'posted' && move.amount_residual != null) {
    totalRows.push([tr('Amount Due'), money(move.amount_residual), false]);
  }

  if (totalRows.length) {
    const labelX = isRtl ? MARGIN_X + 220 : PAGE_W - MARGIN_X - 220;
    const valX = isRtl ? MARGIN_X + 4 : PAGE_W - MARGIN_X - 4;
    const lineStart = isRtl ? MARGIN_X : labelX;
    const lineEnd = isRtl ? labelX : PAGE_W - MARGIN_X;
    pdf.ensureSpace(totalRows.length * 16 + 12);
    for (const [label, val, strong] of totalRows) {
      if (strong) {
        pdf.drawLine(lineStart, pdf.y - 10, lineEnd, pdf.y - 10, { width: 0.75, color: [0.12, 0.14, 0.19] });
      }
      pdf.drawText(labelX, pdf.y, label, { size: strong ? 10.5 : 9.5, bold: strong, color: dark, align: textAlign });
      pdf.drawText(valX, pdf.y, val, { size: strong ? 10.5 : 9.5, bold: strong, color: dark, align: numAlign });
      pdf.y += strong ? 18 : 15;
    }
    pdf.y += 8;
  }

  // Payment QR Code (omitted for without_payment / invoices_without_payment reports, matching PrintDoc.jsx)
  if (!WITHOUT_PAYMENT_REPORTS.has(pdfReportId)) {
    const qrSettings = invoiceQrSettingsForCompany(db, docCompany);
    let qrPayload;
    try {
      qrPayload = invoiceQrPayload(qrSettings, docCompany, move, currency?.name ?? null, db);
    } catch {
      qrPayload = null;
    }
    if (qrPayload) {
      const grid = qrMatrix(qrPayload);
      const qrSize = 90;
      const cell = qrSize / grid.length;
      pdf.ensureSpace(qrSize + 24);
      const qrTop = pdf.y;
      const qrLeft = isRtl ? PAGE_W - MARGIN_X - qrSize : MARGIN_X;
      pdf.fillRect(qrLeft - 4, qrTop - 4, qrSize + 8, qrSize + 8, [1, 1, 1]);
      for (let r = 0; r < grid.length; r++) {
        for (let c = 0; c < grid[r].length; c++) {
          if (grid[r][c]) {
            pdf.fillRect(qrLeft + c * cell, qrTop + r * cell, cell, cell, [0, 0, 0]);
          }
        }
      }
      const caption = tr(qrSettings.invoice_qr === 'zatca' ? 'Scan to verify this invoice' : 'Scan to pay');
      const captionX = isRtl ? PAGE_W - MARGIN_X : qrLeft;
      pdf.drawText(captionX, qrTop + qrSize + 14, caption, { size: 8, color: muted, align: textAlign });
      pdf.y = qrTop + qrSize + 26;
    }
  }

  // Payment Terms & Installments
  const term = move.invoice_payment_term_id ? read(db, 'account.payment.term', move.invoice_payment_term_id) : null;
  const termNote = invoiceTermNote(db, move);
  if (termNote) {
    for (const line of pdf.wrapText(termNote, CONTENT_W, 9)) {
      pdf.ensureSpace(14);
      pdf.drawText(titleX, pdf.y, line, { size: 9, color: dark, align: textAlign });
      pdf.y += 13;
    }
  }
  if (term?.display_on_invoice) {
    const baseDate = validDate(move.invoice_date) ? move.invoice_date : today();
    const canCompute = !termScheduleError(term, move.amount_total, currency, baseDate) && !dueTermLinesError(term);
    const sched = move.state === 'posted'
      ? (invoiceInstallments(db, move, term) ?? (canCompute ? installments(term, move.amount_total, baseDate, currency) : null))
      : move.state === 'draft' && canCompute
        ? installments(term, move.amount_total, baseDate, currency)
        : null;
    if (sched?.length) {
      const schedDateX = titleX;
      const schedAmtX = isRtl ? PAGE_W - MARGIN_X - 180 : MARGIN_X + 180;
      pdf.ensureSpace(20 + sched.length * 14);
      pdf.drawText(schedDateX, pdf.y, tr('Due Date'), { size: 8.5, bold: true, color: muted, align: textAlign });
      pdf.drawText(schedAmtX, pdf.y, tr('Amount'), { size: 8.5, bold: true, color: muted, align: numAlign });
      pdf.y += 14;
      for (const row of sched) {
        pdf.ensureSpace(14);
        pdf.drawText(schedDateX, pdf.y, String(row.date ?? ''), { size: 9, color: dark, align: textAlign });
        pdf.drawText(schedAmtX, pdf.y, money(row.amount), { size: 9, color: dark, align: numAlign });
        pdf.y += 14;
      }
      pdf.y += 6;
    }
  }

  // Narration and Tax Legal Notes
  if (move.narration) {
    for (const line of pdf.wrapText(move.narration, CONTENT_W, 9)) {
      pdf.ensureSpace(14);
      pdf.drawText(titleX, pdf.y, line, { size: 9, color: muted, align: textAlign });
      pdf.y += 13;
    }
  }
  if (['out_invoice', 'out_refund'].includes(move.move_type)) {
    for (const note of invoiceTaxLegalNotes(lines)) {
      for (const line of pdf.wrapText(note, CONTENT_W, 8.5)) {
        pdf.ensureSpace(13);
        pdf.drawText(titleX, pdf.y, line, { size: 8.5, color: muted, align: textAlign });
        pdf.y += 12;
      }
    }
  }

  return pdf.finish();
}
