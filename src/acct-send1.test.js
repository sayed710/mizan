import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';
import { inflateSync } from 'node:zlib';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { applyDiff, diffDb } from './sync.js';
import {
  postMove,
  runSendMoves,
  salesInvoiceView,
  sendMovesWizard,
  defaultInvoiceMailTemplate,
} from './models/accounting.js';
import { today } from './models/common.js';
import { taxSnapshot } from './models/taxes.js';
import { sendDocument } from '../server/mail.js';
import { generateInvoicePdf, UNSUPPORTED_UNICODE_PDF_ERROR } from '../server/invoicePdf.js';
import { startServer } from '../server/test-server.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const classOf = (node) => props(node)?.className ?? node?.className ?? '';
const hasClass = (node, name) => String(classOf(node)).split(/\s+/).includes(name);
const allFind = (node, pred, acc = []) => {
  if (!node) return acc;
  if (pred(node)) acc.push(node);
  for (const child of node.childNodes ?? []) allFind(child, pred, acc);
  return acc;
};

function fakeSmtp({ failData = false } = {}) {
  const seen = [];
  const server = net.createServer((s) => {
    s.on('error', () => {});
    s.write('220 fake\r\n');
    let inData = false;
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      for (let i; (i = buf.indexOf('\r\n')) >= 0;) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            s.write(failData ? '550 Rejected\r\n' : '250 queued\r\n');
          } else {
            seen.push(line);
          }
          continue;
        }
        seen.push(line);
        if (line.startsWith('EHLO')) s.write('250 fake\r\n');
        else if (line.startsWith('MAIL') || line.startsWith('RCPT')) s.write('250 ok\r\n');
        else if (line === 'DATA') { inData = true; s.write('354 go\r\n'); } else if (line === 'QUIT') { s.write('221 bye\r\n'); s.end(); }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    seen,
    cfg: { host: '127.0.0.1', port: server.address().port, from: 'erp@mizan.example' },
  })));
}

function extractSmtpAttachments(lines) {
  const raw = lines.join('\r\n');
  const results = [];
  const partRe = /Content-Type:\s*([^;\r\n]+);\s*name="([^"]+)"\r\nContent-Disposition:\s*attachment;\s*filename="([^"]+)"\r\nContent-Transfer-Encoding:\s*base64\r\n\r\n([\s\S]*?)(?=\r\n--mizan-mixed-)/g;
  for (const m of raw.matchAll(partRe)) {
    results.push({
      contentType: m[1].trim(),
      filename: m[3].trim(),
      content: Buffer.from(m[4].replace(/\r\n/g, ''), 'base64'),
    });
  }
  return results;
}

function readPdfLiteralString(txt, startParen) {
  const bytes = [];
  let depth = 1;
  let i = startParen + 1;
  while (i < txt.length && depth > 0) {
    const ch = txt[i++];
    if (ch === '\\') {
      const nxt = txt[i++];
      if (nxt === 'n') bytes.push(10);
      else if (nxt === 'r') bytes.push(13);
      else if (nxt === 't') bytes.push(9);
      else if (nxt === 'b') bytes.push(8);
      else if (nxt === 'f') bytes.push(12);
      else if (nxt >= '0' && nxt <= '7') {
        let oct = nxt;
        while (txt[i] >= '0' && txt[i] <= '7' && oct.length < 3) oct += txt[i++];
        bytes.push(parseInt(oct, 8));
      } else if (nxt !== undefined) {
        bytes.push(nxt.charCodeAt(0));
      }
    } else if (ch === '(') {
      depth++;
      bytes.push(ch.charCodeAt(0));
    } else if (ch === ')') {
      depth--;
      if (depth > 0) bytes.push(ch.charCodeAt(0));
    } else {
      bytes.push(ch.charCodeAt(0));
    }
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let j = 2; j < bytes.length; j += 2) out += String.fromCharCode((bytes[j] << 8) | bytes[j + 1]);
    return out;
  }
  return Buffer.from(bytes).toString('latin1');
}

function inspectPdf(pdfBuffer) {
  const raw = pdfBuffer.toString('latin1');
  const cmaps = new Map();
  const pageFontRefs = {};
  const contentStreams = [];

  for (const m of raw.matchAll(/(\d+)\s+0\s+obj\b([\s\S]*?)endobj/g)) {
    const objId = m[1];
    const body = m[2];
    if (body.includes('/Font <<')) {
      for (const fm of body.matchAll(/\/(F\d+)\s+(\d+)\s+0\s+R/g)) pageFontRefs[fm[1]] = fm[2];
    }
    if (body.includes('/ToUnicode')) {
      const um = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(body);
      if (um) pageFontRefs[`obj_${objId}`] = um[1];
    }
    if (!body.includes('stream\n') || !body.includes('\nendstream')) continue;
    const objStart = pdfBuffer.indexOf(Buffer.from(m[0].slice(0, 40), 'latin1'));
    const rawStart = pdfBuffer.indexOf(Buffer.from('stream\n', 'latin1'), objStart) + 7;
    const rawEnd = pdfBuffer.indexOf(Buffer.from('\nendstream', 'latin1'), rawStart);
    let data = pdfBuffer.subarray(rawStart, rawEnd);
    if (body.includes('/FlateDecode')) data = inflateSync(data);
    const txt = data.toString('latin1');
    if (txt.includes('begincmap')) {
      const cmap = new Map();
      for (const rm of txt.matchAll(/<([0-9a-f]+)>\s+<([0-9a-f]+)>\s+\[([^\]]+)\]/gi)) {
        let cid = parseInt(rm[1], 16);
        for (const gm of rm[3].matchAll(/<([0-9a-f]*)>/gi)) {
          let u = '';
          for (let i = 0; i < gm[1].length; i += 4) u += String.fromCodePoint(parseInt(gm[1].slice(i, i + 4), 16));
          cmap.set(cid.toString(16).padStart(4, '0').toLowerCase(), u);
          cid++;
        }
      }
      for (const bm of txt.matchAll(/beginbfchar([\s\S]*?)endbfchar/gi)) {
        for (const pm of bm[1].matchAll(/<([0-9a-f]+)>\s+<([0-9a-f]*)>/gi)) {
          let u = '';
          for (let i = 0; i < pm[2].length; i += 4) u += String.fromCodePoint(parseInt(pm[2].slice(i, i + 4), 16));
          cmap.set(pm[1].toLowerCase(), u);
        }
      }
      cmaps.set(objId, cmap);
    } else if (txt.includes('BT') && (txt.includes('TJ') || txt.includes('/ActualText'))) {
      contentStreams.push(txt);
    }
  }

  const fontToCmap = new Map();
  for (const [fName, fontObjId] of Object.entries(pageFontRefs)) {
    if (!fName.startsWith('obj_') && pageFontRefs[`obj_${fontObjId}`]) {
      fontToCmap.set(fName, cmaps.get(pageFontRefs[`obj_${fontObjId}`]));
    }
  }

  const actualTexts = [];
  const glyphBlocks = [];
  for (const cs of contentStreams) {
    let idx = 0;
    while ((idx = cs.indexOf('/ActualText', idx)) !== -1) {
      const paren = cs.indexOf('(', idx);
      if (paren === -1) break;
      actualTexts.push(readPdfLiteralString(cs, paren));
      idx = paren + 1;
    }
    for (const bt of cs.matchAll(/BT\r?\n([\s\S]*?)\r?\nET/g)) {
      let curFont = null;
      let firstX = null;
      let curY = null;
      const chars = [];
      for (const line of bt[1].split(/\r?\n/)) {
        const fm = /\/(F\d+)\s+[\d.]+\s+Tf/.exec(line);
        if (fm) curFont = fm[1];
        const tm = /1\s+0\s+0\s+1\s+([\d.]+)\s+([\d.]+)\s+Tm/.exec(line);
        if (tm) {
          if (firstX === null) firstX = parseFloat(tm[1]);
          curY = parseFloat(tm[2]);
        }
        const jm = /\[([^\]]+)\]\s+TJ/.exec(line);
        if (jm && curFont && fontToCmap.has(curFont)) {
          const cmap = fontToCmap.get(curFont);
          for (const hm of jm[1].matchAll(/<([0-9a-f]+)>/gi)) {
            const hex = hm[1].toLowerCase();
            for (let i = 0; i < hex.length; i += 4) {
              chars.push(cmap.get(hex.slice(i, i + 4)) ?? '');
            }
          }
        }
      }
      if (chars.length) glyphBlocks.push({ x: firstX, y: curY, visualLtr: chars.join('') });
    }
  }

  return {
    raw,
    actualTexts,
    glyphBlocks,
    cmapsCount: fontToCmap.size,
    text: actualTexts.length ? actualTexts.join('\n') : glyphBlocks.map((g) => g.visualLtr).join('\n'),
  };
}

function decodedSubject(headerLine) {
  if (!headerLine) return '';
  const raw = headerLine.replace(/^Subject:\s*/i, '');
  const m = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(raw);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : raw;
}

function createPostedInvoice(db, { partnerId, moveType = 'out_invoice', price = 150, product = 1 } = {}) {
  const res = create(db, 'account.move', {
    move_type: moveType,
    partner_id: partnerId,
    invoice_date: today(),
    invoice_line_ids: [{ product_id: product, qty: 1, price_unit: price, tax: 0 }],
  });
  return { db: postMove(res.db, res.id), id: res.id };
}

const origFetch = globalThis.fetch;
const origConfirm = globalThis.confirm;
const origAlert = globalThis.alert;
const origLoc = globalThis.location;

afterEach(() => {
  globalThis.fetch = origFetch;
  globalThis.confirm = origConfirm;
  globalThis.alert = origAlert;
  globalThis.location = origLoc;
});

test('SEND1-1: Invoice and Credit Note sending templates are seeded with EN/AR text and migrated cleanly', () => {
  const db = seed();
  assert.equal(db.schema_version, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 85);
  const templates = search(db, 'mail.template').filter((t) => t.model === 'account.move');
  const invTpl = templates.find((t) => t.name === 'Invoice: Sending');
  const cnTpl = templates.find((t) => t.name === 'Credit Note: Sending');
  assert.ok(invTpl, 'Invoice: Sending template is seeded');
  assert.ok(cnTpl, 'Credit Note: Sending template is seeded');
  assert.match(invTpl.subject, /Invoice \{\{\s*object\.name\s*\}\}/);
  assert.match(invTpl.subject_ar, /الفاتورة \{\{\s*object\.name\s*\}\}/);
  assert.match(invTpl.body, /\{\{\s*object\.partner_id\.name\s*\}\}/);
  assert.match(invTpl.body_ar, /\{\{\s*object\.partner_id\.name\s*\}\}/);
  assert.match(cnTpl.subject, /Credit Note \{\{\s*object\.name\s*\}\}/);
  assert.match(cnTpl.subject_ar, /الإشعار الدائن \{\{\s*object\.name\s*\}\}/);

  // Migration 85 adds missing templates to existing schema v84 databases idempotently.
  const withoutTemplates = {
    ...db,
    schema_version: 84,
    records: {
      ...db.records,
      'mail.template': (db.records['mail.template'] ?? []).filter((t) => t.model !== 'account.move'),
    },
  };
  const migrated = migrate(withoutTemplates);
  assert.equal(migrated.schema_version, 85);
  assert.ok(search(migrated, 'mail.template').some((t) => t.name === 'Invoice: Sending'));
  assert.ok(search(migrated, 'mail.template').some((t) => t.name === 'Credit Note: Sending'));
  assert.equal(migrate(migrated), migrated);
});

test('SEND1-2: single wizard defaults (recipients, template, rendered subject/body, lang, report, attachments)', () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Single Default Customer', email: 'single@example.com' });
  db = partner.db;
  const inv = createPostedInvoice(db, { partnerId: partner.id, price: 250 });
  db = inv.db;
  const move = read(db, 'account.move', inv.id);

  const spec = sendMovesWizard(db, move);
  assert.equal(spec.wizardModel, 'account.move.send.wizard');
  const byName = (name) => spec.fields.find((f) => f.name === name);

  assert.equal(byName('email').default, true);
  assert.equal(byName('download').default, false);
  assert.deepEqual(byName('mail_partner_ids').default, [partner.id]);

  const invTpl = defaultInvoiceMailTemplate(db, move);
  assert.equal(invTpl.name, 'Invoice: Sending');
  assert.equal(byName('template_id').default, invTpl.id);
  assert.equal(byName('lang').default, 'en');
  assert.equal(byName('pdf_report_id').default, 'invoices');

  assert.ok(byName('subject').default.includes(move.name));
  assert.ok(byName('body').default.includes('Single Default Customer'));
  assert.ok(byName('body').default.includes(move.name));
  assert.ok(byName('body').default.includes('250'));

  const atts = byName('attachments').default;
  assert.equal(atts.length, 1);
  assert.equal(atts[0].kind, 'invoice_pdf');
  assert.equal(atts[0].type, 'application/pdf');
  assert.ok(atts[0].name.endsWith('.pdf'));
  assert.ok(atts[0].name.includes(move.name.replace(/[^A-Za-z0-9._-]+/g, '_')));
  assert.deepEqual(byName('alerts').compute({ mail_partner_ids: [partner.id] }, db), []);

  // Switching invoice report updates invoice_pdf attachment pdf_report_id.
  const noPayUpdate = spec.onchange({ pdf_report_id: 'invoices_without_payment', attachments: atts }, 'pdf_report_id', db);
  assert.equal(noPayUpdate.attachments[0].pdf_report_id, 'invoices_without_payment');

  // Switching language in onchange re-renders subject & body in Arabic.
  const arUpdate = spec.onchange({ template_id: invTpl.id, lang: 'ar', attachments: atts }, 'lang', db);
  assert.match(arUpdate.subject, /الفاتورة/);
  assert.match(arUpdate.body, /عزيزي Single Default Customer/);
});

test('SEND1-3: credit note defaults to Credit Note: Sending template and uses it in batch', () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Refund Customer', email: 'refund@example.com' });
  db = partner.db;
  const cn = createPostedInvoice(db, { partnerId: partner.id, moveType: 'out_refund', price: 120 });
  db = cn.db;
  const cnMove = read(db, 'account.move', cn.id);

  const spec = sendMovesWizard(db, cnMove);
  const byName = (name) => spec.fields.find((f) => f.name === name);
  const cnTpl = search(db, 'mail.template').find((t) => t.name === 'Credit Note: Sending');
  assert.equal(byName('template_id').default, cnTpl.id);
  assert.match(byName('subject').default, /Credit Note/);
  assert.ok(byName('body').default.includes(cnMove.name));
  assert.match(byName('body').default, /credit note/i);

  // Batch with one invoice and one credit note picks the matching template per document.
  const inv = createPostedInvoice(db, { partnerId: partner.id, moveType: 'out_invoice', price: 300 });
  db = inv.db;
  const batchRes = runSendMoves(db, [inv.id, cn.id], { email: true, download: false, live: true });
  const invTpl = search(db, 'mail.template').find((t) => t.name === 'Invoice: Sending');
  assert.equal(batchRes.emailPayloads[inv.id].template_id, invTpl.id);
  assert.equal(batchRes.emailPayloads[cn.id].template_id, cnTpl.id);
  assert.match(batchRes.emailPayloads[inv.id].subject, /Invoice/);
  assert.match(batchRes.emailPayloads[cn.id].subject, /Credit Note/);
});

test('SEND1-4: editing subject/body, extra recipient, removing/adding attachments are delivered via SMTP and logged in chatter', async () => {
  const { server, seen, cfg } = await fakeSmtp();
  try {
    let db = seed();
    const p1 = create(db, 'res.partner', { name: 'Primary Buyer', email: 'primary@example.com' });
    const p2 = create(p1.db, 'res.partner', { name: 'CC Finance', email: 'finance@example.com' });
    db = p2.db;

    const invTpl = search(db, 'mail.template').find((t) => t.name === 'Invoice: Sending');
    const tplAttachmentData = `data:text/plain;base64,${Buffer.from('Terms & Conditions').toString('base64')}`;
    db = write(db, 'mail.template', invTpl.id, {
      attachments: [{ name: 'terms.txt', file: { name: 'terms.txt', type: 'text/plain', size: 18, data: tplAttachmentData } }],
    });

    const inv = createPostedInvoice(db, { partnerId: p1.id, price: 400 });
    db = inv.db;
    const move = read(db, 'account.move', inv.id);

    const spec = sendMovesWizard(db, move);
    const defaultAtts = spec.fields.find((f) => f.name === 'attachments').default;
    assert.equal(defaultAtts.length, 2, 'Wizard defaults include invoice PDF plus template attachment');
    assert.equal(defaultAtts[0].kind, 'invoice_pdf');
    assert.equal(defaultAtts[1].kind, 'template');
    assert.equal(defaultAtts[1].name, 'terms.txt');

    // Remove template attachment, keep invoice PDF, and add a custom file.
    const extraData = `data:text/plain;base64,${Buffer.from('Signed PO #42').toString('base64')}`;
    const editedAtts = [
      defaultAtts[0],
      { id: 'custom-1', kind: 'custom', name: 'po-42.txt', type: 'text/plain', size: 13, data: extraData },
    ];

    const res = runSendMoves(db, move, {
      email: true,
      download: false,
      live: true,
      mail_partner_ids: [p1.id, p2.id],
      template_id: invTpl.id,
      lang: 'en',
      subject: 'Custom Edited Subject 2026',
      body: 'Custom edited email body for customer.',
      pdf_report_id: 'invoices',
      attachments: editedAtts,
    });

    const out = await sendDocument(cfg, res.db, { name: 'Admin', isAdmin: true }, {
      model: 'account.move',
      id: move.id,
      send: res.emailPayloads[move.id],
    });
    assert.equal(out.status, 200);
    assert.equal(read(out.db, 'account.move', move.id).is_move_sent, true);

    assert.ok(seen.includes('RCPT TO:<primary@example.com>'));
    assert.ok(seen.includes('RCPT TO:<finance@example.com>'));
    assert.equal(decodedSubject(seen.find((l) => l.startsWith('Subject:'))), 'Custom Edited Subject 2026');
    const dataText = seen.join('\n');
    assert.ok(dataText.includes('Custom edited email body for customer.'));
    assert.ok(dataText.includes('po-42.txt'), 'Added custom attachment sent over SMTP');
    assert.ok(!dataText.includes('terms.txt'), 'Removed template attachment must not be sent');

    const sentAttachments = extractSmtpAttachments(seen);
    assert.equal(sentAttachments.length, 2);
    const pdfAtt = sentAttachments.find((a) => a.filename.endsWith('.pdf'));
    assert.ok(pdfAtt, 'Invoice attachment must have .pdf filename');
    assert.equal(pdfAtt.contentType, 'application/pdf');
    const pdfText = pdfAtt.content.toString('latin1');
    assert.ok(pdfText.startsWith('%PDF-1.4'), 'Invoice attachment must be genuine PDF bytes');
    assert.ok(pdfText.trimEnd().endsWith('%%EOF'));
    assert.ok(!pdfText.includes('<!doctype html>'), 'Invoice attachment must not be HTML');
    const pdfInfo = inspectPdf(pdfAtt.content);
    assert.ok(pdfInfo.cmapsCount >= 1, 'Generated PDF must embed Unicode font CMaps');
    assert.ok(pdfInfo.text.includes(move.name));
    assert.ok(pdfInfo.text.includes('Primary Buyer'));

    const chatterMsg = out.db.messages.find((m) => m.model === 'account.move' && m.res_id === move.id && m.body.includes('Sent by email to'));
    assert.ok(chatterMsg, 'Sent email logged on invoice chatter');
    assert.ok(chatterMsg.body.includes('primary@example.com'));
    assert.ok(chatterMsg.body.includes('finance@example.com'));
    assert.ok(chatterMsg.body.includes('po-42.txt'));
    assert.equal(chatterMsg.attachments.length, 2);
    assert.ok(chatterMsg.attachments.some((a) => a.name === 'po-42.txt'));
    assert.ok(chatterMsg.attachments.some((a) => a.name.endsWith('.pdf') && a.type === 'application/pdf'));

    // Chosen pdf_report_id controls payment QR inclusion in generated PDF.
    const qrDb = write(db, 'res.company', 1, { invoice_qr: 'zatca', vat: '300000000000003' });
    seen.length = 0;
    const withPayRes = runSendMoves(qrDb, move, {
      email: true, download: false, live: true, mail_partner_ids: [p1.id], pdf_report_id: 'invoices',
    });
    const withPayOut = await sendDocument(cfg, withPayRes.db, { name: 'Admin', isAdmin: true }, {
      model: 'account.move', id: move.id, send: withPayRes.emailPayloads[move.id],
    });
    assert.equal(withPayOut.status, 200);
    const withPayPdf = inspectPdf(extractSmtpAttachments(seen).find((a) => a.filename.endsWith('.pdf')).content);
    assert.ok(withPayPdf.text.includes('Scan to verify this invoice'), 'Standard invoice report includes payment QR');

    seen.length = 0;
    const withoutPayRes = runSendMoves(qrDb, move, {
      email: true, download: false, live: true, mail_partner_ids: [p1.id], pdf_report_id: 'invoices_without_payment',
    });
    const withoutPayOut = await sendDocument(cfg, withoutPayRes.db, { name: 'Admin', isAdmin: true }, {
      model: 'account.move', id: move.id, send: withoutPayRes.emailPayloads[move.id],
    });
    assert.equal(withoutPayOut.status, 200);
    const withoutPayPdf = inspectPdf(extractSmtpAttachments(seen).find((a) => a.filename.endsWith('.pdf')).content);
    assert.ok(withoutPayPdf.text.includes(move.name));
    assert.ok(!withoutPayPdf.text.includes('Scan to verify this invoice'), 'Invoices without Payment report omits payment QR');

    // Removing ALL attachments (including invoice PDF) sends zero attachments.
    seen.length = 0;
    const noAttRes = runSendMoves(db, move, {
      email: true,
      download: false,
      live: true,
      mail_partner_ids: [p1.id],
      subject: 'No Attachment Subject',
      body: 'No attachments here.',
      attachments: [],
    });
    const outNoAtt = await sendDocument(cfg, noAttRes.db, { name: 'Admin', isAdmin: true }, {
      model: 'account.move',
      id: move.id,
      send: noAttRes.emailPayloads[move.id],
    });
    assert.equal(outNoAtt.status, 200);
    assert.ok(!seen.join('\n').includes('Content-Disposition: attachment'));
  } finally {
    server.close();
  }
});

test('SEND1-5: partner without email shows alert in single and batch wizards and batch summary shows method counts', () => {
  let db = seed();
  const noEmail = create(db, 'res.partner', { name: 'Missing Mail Co', email: '' });
  const emailCo = create(noEmail.db, 'res.partner', { name: 'Email Co', email: 'ok@example.com', invoice_sending_method: 'email' });
  const manualCo = create(emailCo.db, 'res.partner', { name: 'Manual Co', email: 'man@example.com', invoice_sending_method: 'manual' });
  db = manualCo.db;

  const invNoEmail = createPostedInvoice(db, { partnerId: noEmail.id, price: 100 });
  const invEmail = createPostedInvoice(invNoEmail.db, { partnerId: emailCo.id, price: 200 });
  const invManual = createPostedInvoice(invEmail.db, { partnerId: manualCo.id, price: 300 });
  db = invManual.db;

  // Single wizard alert for partner without email
  const singleSpec = sendMovesWizard(db, read(db, 'account.move', invNoEmail.id));
  assert.equal(singleSpec.fields.find((f) => f.name === 'email').default, false);
  const singleAlerts = singleSpec.fields.find((f) => f.name === 'alerts').compute({ mail_partner_ids: [noEmail.id] }, db);
  assert.equal(singleAlerts.length, 1);
  assert.match(singleAlerts[0].message, /Missing Mail Co has no email address/);

  // Batch wizard: no subject/body editing, summary counts by sending method, and alert for missing email
  const batchSpec = sendMovesWizard(db, [invNoEmail.id, invEmail.id, invManual.id]);
  assert.equal(batchSpec.wizardModel, 'account.move.send.batch.wizard');
  assert.equal(batchSpec.fields.some((f) => f.name === 'subject'), false);
  assert.equal(batchSpec.fields.some((f) => f.name === 'body'), false);

  const summary = batchSpec.fields.find((f) => f.name === 'summary').compute({}, db);
  assert.equal(summary.total, 3);
  assert.equal(summary.email, 2);
  assert.equal(summary.download, 1);
  assert.deepEqual(summary.items, [
    { method: 'email', label: 'Email', count: 2 },
    { method: 'manual', label: 'Download', count: 1 },
  ]);

  const batchAlerts = batchSpec.fields.find((f) => f.name === 'alerts').compute({}, db);
  assert.equal(batchAlerts.length, 1);
  assert.match(batchAlerts[0].message, /1 invoice\(s\) cannot be emailed.*Missing Mail Co/);
});

test('SEND1-6: mail.template attachment guard is diff-verifiable (diffDb + applyDiff)', () => {
  const db = seed();
  const badState = {
    ...db,
    seq: { ...db.seq, 'mail.template': (db.seq['mail.template'] ?? 0) + 1 },
    records: {
      ...db.records,
      'mail.template': [
        ...(db.records['mail.template'] ?? []),
        { id: (db.seq['mail.template'] ?? 0) + 1, name: 'Broken Tpl', model: 'account.move', attachments: [{ name: 'missing.txt', file: null }] },
      ],
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, badState), { isAdmin: true }), /Each template attachment requires a file/);
});

test('SEND1-7: FormView single Send wizard and ActionView batch Send wizard UI integration', async () => {
  const prevStorage = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  };
  const { makeEl } = setupDom();
  globalThis.document.createElementNS ??= (_, tag) => makeEl(tag);
  const origSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => ({ unref() {} });
  globalThis.alert = () => {};
  globalThis.confirm = () => true;
  globalThis.location = { hash: '#/accounting/invoices' };

  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { FormView } = await import('./views/FormView.jsx');
  const { ActionView } = await import('./views/ActionView.jsx');

  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [] } };
  const p1 = create(db, 'res.partner', { name: 'UI Buyer', email: 'uibuyer@example.com' });
  const p2 = create(p1.db, 'res.partner', { name: 'UI Extra', email: 'uiextra@example.com' });
  const pManual = create(p2.db, 'res.partner', { name: 'UI Manual', email: '', invoice_sending_method: 'manual' });
  const inv1 = createPostedInvoice(pManual.db, { partnerId: p1.id, price: 500 });
  const inv2 = createPostedInvoice(inv1.db, { partnerId: pManual.id, price: 600 });
  db = inv2.db;

  const dispatched = [];
  let serverDb = db;
  globalThis.fetch = async (url, init) => {
    if (url === '/api/session') {
      return new Response(JSON.stringify({ name: 'Admin', isAdmin: true, integrations: { smtp: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === '/api/db') {
      return new Response(JSON.stringify(serverDb), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === '/api/diff') {
      serverDb = applyDiff(serverDb, JSON.parse(init.body), { isAdmin: true });
      return new Response(JSON.stringify(serverDb), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === '/api/mail/document') {
      const payload = JSON.parse(init.body);
      dispatched.push(payload);
      serverDb = write(serverDb, 'account.move', payload.id, { is_move_sent: true });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const leaf = { key: 'invoices', label: 'Invoices', model: 'account.move', ...salesInvoiceView };

  try {
    await act(async () => { await initStore(); });
    await act(async () => { await commit(db); });
    await act(async () => {
      root.render(React.createElement(FormView, { leaf, id: inv1.id, base: '#/accounting/invoices', params: new URLSearchParams('view=form') }));
    });

    const sendBtn = allFind(host, (n) => n.tagName === 'BUTTON').find((b) => b.textContent.trim() === 'Send');
    await act(async () => props(sendBtn).onClick());
    const dialog = find(host, (n) => n.tagName === 'FORM' && hasClass(n, 'wizard'));
    assert.ok(dialog);

    // Edit subject and body, add extra recipient, add custom file attachment
    const subjectInput = find(dialog, (n) => n.tagName === 'INPUT' && props(n)?.id === 'w-subject');
    const bodyTextarea = find(dialog, (n) => n.tagName === 'TEXTAREA' && props(n)?.id === 'w-body');
    const recipientSelect = find(dialog, (n) => n.tagName === 'SELECT' && props(n)?.id === 'w-mail_partner_ids');
    const attachmentInput = find(dialog, (n) => n.tagName === 'INPUT' && props(n)?.id === 'w-attachments');

    await act(async () => props(subjectInput).onChange({ target: { value: 'UI Subject Override' } }));
    await act(async () => props(bodyTextarea).onChange({ target: { value: 'UI Body Override' } }));
    await act(async () => props(recipientSelect).onChange({ target: { value: String(p2.id) } }));
    // Adding two 2 MB files (4 MB total > 3 MB cap) is blocked in the UI with the matching 3 MB error.
    await act(async () => props(attachmentInput).onChange({
      target: {
        files: [{
          name: 'two-mb.bin',
          type: 'application/octet-stream',
          size: 2 * 1024 * 1024,
          data: `data:application/octet-stream;base64,${Buffer.alloc(16, 65).toString('base64')}`,
        }],
        value: 'C:\\fakepath\\two-mb.bin',
      },
    }));
    await act(async () => props(attachmentInput).onChange({
      target: {
        files: [{
          name: 'second-two-mb.bin',
          type: 'application/octet-stream',
          size: 2 * 1024 * 1024,
          data: `data:application/octet-stream;base64,${Buffer.alloc(16, 66).toString('base64')}`,
        }],
        value: 'C:\\fakepath\\second-two-mb.bin',
      },
    }));
    const attErrorEl = find(dialog, (n) => hasClass(n, 'req'));
    assert.ok(attErrorEl && attErrorEl.textContent.includes('Attachments exceed the 3 MB limit'));
    const removeTwoMbBtn = allFind(dialog, (n) => n.tagName === 'BUTTON').find((b) => props(b)?.['aria-label'] === 'Remove two-mb.bin');
    assert.ok(removeTwoMbBtn);
    await act(async () => props(removeTwoMbBtn).onClick());
    await act(async () => props(attachmentInput).onChange({
      target: {
        files: [{
          name: 'custom-ui.txt',
          type: 'text/plain',
          size: 5,
          data: `data:text/plain;base64,${Buffer.from('hello').toString('base64')}`,
        }],
        value: 'C:\\fakepath\\custom-ui.txt',
      },
    }));

    await act(async () => props(find(host, (n) => n.tagName === 'FORM' && hasClass(n, 'wizard'))).onSubmit({ preventDefault() {} }));

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].send.subject, 'UI Subject Override');
    assert.equal(dispatched[0].send.body, 'UI Body Override');
    assert.deepEqual(dispatched[0].send.mail_partner_ids, [p1.id, p2.id]);
    assert.equal(dispatched[0].send.attachments.length, 2);
    assert.ok(dispatched[0].send.attachments.some((a) => a.name === 'custom-ui.txt'));

    // Now render ActionView and open batch Send wizard on both invoices
    await act(async () => {
      root.render(React.createElement(ActionView, { leaf, base: '#/accounting/invoices', params: new URLSearchParams('view=list') }));
    });
    const checkboxes = () => allFind(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox');
    await act(async () => props(checkboxes()[1]).onChange());
    await act(async () => props(checkboxes()[2]).onChange());
    const listSendBtn = allFind(host, (n) => n.tagName === 'BUTTON').find((b) => b.textContent.trim() === 'Send');
    await act(async () => props(listSendBtn).onClick());

    const batchDialog = find(host, (n) => n.tagName === 'FORM' && hasClass(n, 'wizard'));
    assert.ok(batchDialog);
    assert.equal(find(batchDialog, (n) => props(n)?.id === 'w-subject'), null);
    assert.equal(find(batchDialog, (n) => props(n)?.id === 'w-body'), null);
    const summaryEl = find(batchDialog, (n) => props(n)?.id === 'w-summary');
    assert.ok(summaryEl.textContent.includes('Email: 1 invoice(s)'));
    assert.ok(summaryEl.textContent.includes('Download: 1 invoice(s)'));
  } finally {
    globalThis.fetch = () => Promise.reject(new Error('offline'));
    await act(async () => root.unmount());
    globalThis.setInterval = origSetInterval;
    globalThis.localStorage = prevStorage;
    await initStore();
  }
});

test('SEND1-8: Arabic translations exist for all new send wizard labels, alerts, and errors', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  let tAr;
  try {
    ({ t: tAr } = await import(`./i18n.js?send1-ar=${Date.now()}`));
  } finally {
    globalThis.localStorage = prevStorage;
  }

  for (const label of [
    'Mail Template',
    'Invoice report',
    'Invoices without Payment',
    'Add recipient…',
    'Add attachment',
    'Invoice PDF',
    'Template attachment',
    'Select at least one recipient',
    'No recipient selected.',
    'Sending Summary',
    'No invoices selected.',
    'Arabic Subject',
    'Arabic Body',
    'File Name',
    'Each template attachment requires a file',
    'Attachments exceed the 3 MB limit',
    'Invalid attachment',
    'Invalid invoice report',
    'Only one generated invoice PDF attachment is allowed',
    UNSUPPORTED_UNICODE_PDF_ERROR,
    'Partner Nile Co has no email address.',
    'Partner Nile Co has an invalid email address.',
    '2 invoice(s) cannot be emailed because the partner has no email address: A, B.',
    'Email: 2 invoice(s)',
    'Download: 1 invoice(s)',
  ]) {
    const translated = tAr(label);
    assert.ok(translated && translated !== label, `Missing Arabic translation for: ${label}`);
  }
});

test('SEND1-9: sendDocument enforces 3 MB attachment cap, rejects invalid attachments, and never marks sent on failure', async () => {
  const { server, seen, cfg } = await fakeSmtp();
  try {
    let db = seed();
    const partner = create(db, 'res.partner', { name: 'Big Attachment Co', email: 'big@example.com' });
    const inv = createPostedInvoice(partner.db, { partnerId: partner.id, price: 100 });
    db = inv.db;
    const move = read(db, 'account.move', inv.id);

    const twoMb = `data:application/octet-stream;base64,${Buffer.alloc(2 * 1024 * 1024, 65).toString('base64')}`;
    const res = runSendMoves(db, move, {
      email: true,
      download: false,
      live: true,
      mail_partner_ids: [partner.id],
      subject: 'Too Large',
      body: 'Should fail',
      attachments: [
        { id: 'big-1', kind: 'custom', name: 'part1.bin', type: 'application/octet-stream', data: twoMb },
        { id: 'big-2', kind: 'custom', name: 'part2.bin', type: 'application/octet-stream', data: twoMb },
      ],
    });

    const out = await sendDocument(cfg, res.db, { name: 'Admin', isAdmin: true }, {
      model: 'account.move',
      id: move.id,
      send: res.emailPayloads[move.id],
    });
    assert.equal(out.status, 400);
    assert.equal(out.body.error, 'Attachments exceed the 3 MB limit');
    assert.equal(seen.length, 0, 'SMTP must not be contacted when attachments exceed limit');
    assert.equal(read(res.db, 'account.move', move.id).is_move_sent, false);

    // Invalid attachment fails stably without calling SMTP or marking sent.
    const badOut = await sendDocument(cfg, res.db, { name: 'Admin', isAdmin: true }, {
      model: 'account.move',
      id: move.id,
      send: {
        mail_partner_ids: [partner.id],
        subject: 'Bad Att',
        body: 'Should fail',
        attachments: [{ id: 'bad-1', kind: 'custom', name: 'bad.bin', type: 'application/octet-stream', data: 'not-a-data-url' }],
      },
    });
    assert.equal(badOut.status, 400);
    assert.equal(badOut.body.error, 'Invalid attachment');
    assert.equal(seen.length, 0);
    assert.equal(read(res.db, 'account.move', move.id).is_move_sent, false);

    // Exactly 3 MB total decoded attachments is accepted and produces genuine PDF.
    const threeMb = `data:application/octet-stream;base64,${Buffer.alloc(3 * 1024 * 1024, 66).toString('base64')}`;
    const okRes = runSendMoves(db, move, {
      email: true,
      download: false,
      live: true,
      mail_partner_ids: [partner.id],
      subject: 'Exact Limit',
      body: 'Should succeed',
      attachments: [
        { id: 'pdf', kind: 'invoice_pdf', name: 'inv.pdf', type: 'application/pdf', pdf_report_id: 'invoices' },
        { id: 'ok-1', kind: 'custom', name: 'exact.bin', type: 'application/octet-stream', data: threeMb },
      ],
    });
    const okOut = await sendDocument(cfg, okRes.db, { name: 'Admin', isAdmin: true }, {
      model: 'account.move',
      id: move.id,
      send: okRes.emailPayloads[move.id],
    });
    assert.equal(okOut.status, 200);
    assert.equal(read(okOut.db, 'account.move', move.id).is_move_sent, true);
    const pdfPart = extractSmtpAttachments(seen).find((a) => a.filename === 'inv.pdf');
    assert.ok(pdfPart && pdfPart.content.toString('latin1').startsWith('%PDF-1.4'));
  } finally {
    server.close();
  }
});

test('SEND1-10: real HTTP /api/mail/document route sends genuine PDFs for single and batch, aligns 3 MB cap with 5 MiB limit, and marks sent only on success', async () => {
  const smtp = await fakeSmtp();
  const failingSmtp = await fakeSmtp({ failData: true });
  const dir = mkdtempSync(join(tmpdir(), 'mizan-send1-http-'));
  const dbPath = join(dir, 'test.sqlite');
  const password = 'test-admin-password';
  let appServer;
  let failServer;
  try {
    appServer = await startServer({
      env: {
        ...process.env,
        PORT: '0',
        MIZAN_DB: dbPath,
        MIZAN_ADMIN_PASSWORD: password,
        MIZAN_SMTP_HOST: smtp.cfg.host,
        MIZAN_SMTP_PORT: String(smtp.cfg.port),
        MIZAN_SMTP_FROM: smtp.cfg.from,
        MIZAN_PUBLIC_URL: '',
        MIZAN_SECURE_COOKIE: '0',
      },
    });

    const loginRes = await fetch(`${appServer.origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' },
      body: JSON.stringify({ login: 'admin', password }),
    });
    assert.equal(loginRes.status, 200);
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];

    const dbRes = await fetch(`${appServer.origin}/api/db`, { headers: { Cookie: cookie } });
    assert.equal(dbRes.status, 200);
    const epoch = dbRes.headers.get('x-mizan-epoch');
    const baseDb = await dbRes.json();

    const partnerRes = create(baseDb, 'res.partner', { name: 'HTTP Synthetic Co', email: 'httpbuyer@example.com' });
    const inv1 = createPostedInvoice(partnerRes.db, { partnerId: partnerRes.id, price: 320 });
    const inv2 = createPostedInvoice(inv1.db, { partnerId: partnerRes.id, price: 410 });
    const cn1 = createPostedInvoice(inv2.db, { partnerId: partnerRes.id, moveType: 'out_refund', price: 90 });
    const invLimit = createPostedInvoice(cn1.db, { partnerId: partnerRes.id, price: 500 });
    const withQr = write(invLimit.db, 'res.company', 1, { invoice_qr: 'zatca', vat: '300000000000003' });

    const diffRes = await fetch(`${appServer.origin}/api/diff`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'mizan',
        'X-Mizan-Epoch': epoch,
        Cookie: cookie,
      },
      body: JSON.stringify(diffDb(baseDb, withQr)),
    });
    assert.equal(diffRes.status, 200);
    let serverDb = await diffRes.json();

    const postMail = async (payload) => {
      const r = await fetch(`${appServer.origin}/api/mail/document`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan', Cookie: cookie },
        body: JSON.stringify(payload),
      });
      return { status: r.status, body: await r.json() };
    };
    const fetchMove = async (id) => {
      const r = await fetch(`${appServer.origin}/api/db`, { headers: { Cookie: cookie } });
      const current = await r.json();
      return read(current, 'account.move', id);
    };

    // 1. Single invoice HTTP send with invoices_without_payment and custom attachment
    const move1 = read(serverDb, 'account.move', inv1.id);
    const singleRun = runSendMoves(serverDb, move1, {
      email: true,
      download: false,
      live: true,
      mail_partner_ids: [partnerRes.id],
      subject: 'HTTP Single Invoice',
      body: 'Attached is your invoice PDF.',
      pdf_report_id: 'invoices_without_payment',
      attachments: [
        ...sendMovesWizard(serverDb, move1).fields.find((f) => f.name === 'attachments').default
          .map((a) => ({ ...a, pdf_report_id: 'invoices_without_payment' })),
        {
          id: 'c1',
          kind: 'custom',
          name: 'notes.txt',
          type: 'text/plain',
          size: 5,
          data: `data:text/plain;base64,${Buffer.from('hello').toString('base64')}`,
        },
      ],
    });
    const singleOut = await postMail({ model: 'account.move', id: inv1.id, send: singleRun.emailPayloads[inv1.id] });
    assert.equal(singleOut.status, 200);
    const singleAtts = extractSmtpAttachments(smtp.seen);
    assert.equal(singleAtts.length, 2);
    const singlePdf = singleAtts.find((a) => a.filename.endsWith('.pdf'));
    assert.ok(singlePdf);
    assert.equal(singlePdf.contentType, 'application/pdf');
    const singlePdfText = singlePdf.content.toString('latin1');
    assert.ok(singlePdfText.startsWith('%PDF-1.4'));
    assert.ok(singlePdfText.trimEnd().endsWith('%%EOF'));
    const singlePdfInfo = inspectPdf(singlePdf.content);
    assert.ok(singlePdfInfo.cmapsCount >= 1);
    assert.ok(singlePdfInfo.text.includes(move1.name));
    assert.ok(!singlePdfInfo.text.includes('Scan to verify this invoice'), 'without_payment report omits QR');
    assert.equal((await fetchMove(inv1.id)).is_move_sent, true);

    // 2. Batch HTTP send (invoice + credit note) sends genuine PDFs for both
    smtp.seen.length = 0;
    const batchRun = runSendMoves(serverDb, [inv2.id, cn1.id], { email: true, download: false, live: true });
    for (const mid of batchRun.emailIds) {
      const res = await postMail({ model: 'account.move', id: mid, send: batchRun.emailPayloads[mid] });
      assert.equal(res.status, 200);
    }
    const batchAtts = extractSmtpAttachments(smtp.seen);
    assert.equal(batchAtts.length, 2);
    for (const att of batchAtts) {
      assert.equal(att.contentType, 'application/pdf');
      assert.ok(att.filename.endsWith('.pdf'));
      assert.ok(att.content.toString('latin1').startsWith('%PDF-1.4'));
    }
    const batchTexts = batchAtts.map((a) => inspectPdf(a.content).text);
    assert.ok(batchTexts.some((t) => t.includes(read(serverDb, 'account.move', inv2.id).name)));
    assert.ok(batchTexts.some((t) => t.includes(read(serverDb, 'account.move', cn1.id).name)));
    assert.equal((await fetchMove(inv2.id)).is_move_sent, true);
    assert.equal((await fetchMove(cn1.id)).is_move_sent, true);

    // 3. Over-cap attachments (> 3 MB decoded, <= 5 MiB JSON body) fail with 400 and leave invoice unsent
    smtp.seen.length = 0;
    const twoMb = `data:application/octet-stream;base64,${Buffer.alloc(2 * 1024 * 1024, 65).toString('base64')}`;
    const oneHalfMb = `data:application/octet-stream;base64,${Buffer.alloc(1.5 * 1024 * 1024, 66).toString('base64')}`;
    const overCapRun = runSendMoves(serverDb, read(serverDb, 'account.move', invLimit.id), {
      email: true,
      download: false,
      live: true,
      mail_partner_ids: [partnerRes.id],
      subject: 'Over Cap',
      body: 'Should fail',
      attachments: [
        { id: 'p1', kind: 'custom', name: 'a.bin', type: 'application/octet-stream', data: twoMb },
        { id: 'p2', kind: 'custom', name: 'b.bin', type: 'application/octet-stream', data: oneHalfMb },
      ],
    });
    const overCapOut = await postMail({ model: 'account.move', id: invLimit.id, send: overCapRun.emailPayloads[invLimit.id] });
    assert.equal(overCapOut.status, 400);
    assert.equal(overCapOut.body.error, 'Attachments exceed the 3 MB limit');
    assert.equal(smtp.seen.length, 0);
    assert.equal((await fetchMove(invLimit.id)).is_move_sent, false);

    // 3b. Malformed attachment fails stably with 400 without contacting SMTP or marking sent
    const badAttOut = await postMail({
      model: 'account.move',
      id: invLimit.id,
      send: {
        mail_partner_ids: [partnerRes.id],
        subject: 'Bad Att HTTP',
        body: 'Should fail',
        attachments: [{ id: 'bad', kind: 'custom', name: 'bad.bin', type: 'application/octet-stream', data: 'bad' }],
      },
    });
    assert.equal(badAttOut.status, 400);
    assert.equal(badAttOut.body.error, 'Invalid attachment');
    assert.equal(smtp.seen.length, 0);
    assert.equal((await fetchMove(invLimit.id)).is_move_sent, false);

    // 4. Oversized raw JSON body (> 5 MiB MAX_BODY) returns 413 without contacting SMTP or marking sent
    const sixMb = `data:application/octet-stream;base64,${Buffer.alloc(4.5 * 1024 * 1024, 67).toString('base64')}`;
    const tooLargeOut = await postMail({
      model: 'account.move',
      id: invLimit.id,
      send: { mail_partner_ids: [partnerRes.id], subject: 'Too Big HTTP', body: 'x', attachments: [{ kind: 'custom', name: 'big.bin', data: sixMb }] },
    });
    assert.equal(tooLargeOut.status, 413);
    assert.equal(tooLargeOut.body.error, 'Request too large');
    assert.equal(smtp.seen.length, 0);
    assert.equal((await fetchMove(invLimit.id)).is_move_sent, false);

    // 5. Exactly 3 MB decoded attachment + invoice_pdf succeeds over real HTTP (within 5 MiB global limit)
    const threeMb = `data:application/octet-stream;base64,${Buffer.alloc(3 * 1024 * 1024, 68).toString('base64')}`;
    const exactLimitOut = await postMail({
      model: 'account.move',
      id: invLimit.id,
      send: {
        mail_partner_ids: [partnerRes.id],
        subject: 'Exact 3 MB HTTP',
        body: 'Fits in 5 MiB JSON limit',
        pdf_report_id: 'invoices',
        attachments: [
          { id: 'pdf', kind: 'invoice_pdf', name: 'inv-limit.pdf', type: 'application/pdf', pdf_report_id: 'invoices' },
          { id: 'ok', kind: 'custom', name: 'exact3mb.bin', type: 'application/octet-stream', data: threeMb },
        ],
      },
    });
    assert.equal(exactLimitOut.status, 200);
    assert.equal((await fetchMove(invLimit.id)).is_move_sent, true);

    // 6. SMTP delivery failure returns 502 and leaves invoice unsent
    await appServer.stop();
    appServer = null;
    const dbPathFail = join(dir, 'fail.sqlite');
    failServer = await startServer({
      env: {
        ...process.env,
        PORT: '0',
        MIZAN_DB: dbPathFail,
        MIZAN_ADMIN_PASSWORD: password,
        MIZAN_SMTP_HOST: failingSmtp.cfg.host,
        MIZAN_SMTP_PORT: String(failingSmtp.cfg.port),
        MIZAN_SMTP_FROM: failingSmtp.cfg.from,
        MIZAN_PUBLIC_URL: '',
        MIZAN_SECURE_COOKIE: '0',
      },
    });
    const loginFail = await fetch(`${failServer.origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' },
      body: JSON.stringify({ login: 'admin', password }),
    });
    const failCookie = loginFail.headers.get('set-cookie').split(';')[0];
    const failDbRes = await fetch(`${failServer.origin}/api/db`, { headers: { Cookie: failCookie } });
    const failEpoch = failDbRes.headers.get('x-mizan-epoch');
    const failBaseDb = await failDbRes.json();
    const failPartner = create(failBaseDb, 'res.partner', { name: 'Fail Co', email: 'fail@example.com' });
    const failInv = createPostedInvoice(failPartner.db, { partnerId: failPartner.id, price: 200 });
    await fetch(`${failServer.origin}/api/diff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan', 'X-Mizan-Epoch': failEpoch, Cookie: failCookie },
      body: JSON.stringify(diffDb(failBaseDb, failInv.db)),
    });
    const failSend = await fetch(`${failServer.origin}/api/mail/document`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan', Cookie: failCookie },
      body: JSON.stringify({
        model: 'account.move',
        id: failInv.id,
        send: runSendMoves(failInv.db, read(failInv.db, 'account.move', failInv.id), { email: true, download: false, live: true }).emailPayloads[failInv.id],
      }),
    });
    assert.equal(failSend.status, 502);
    const afterFailDb = await (await fetch(`${failServer.origin}/api/db`, { headers: { Cookie: failCookie } })).json();
    assert.equal(read(afterFailDb, 'account.move', failInv.id).is_move_sent, false);
  } finally {
    await appServer?.stop();
    await failServer?.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    smtp.server.close();
    failingSmtp.server.close();
  }
});

test('SEND1-11: Arabic/RTL invoice PDF embeds fonts, shapes mixed Arabic/Latin/numbers cleanly, and marks sent only on delivery', async () => {
  const { server, seen, cfg } = await fakeSmtp();
  const failSmtp = await fakeSmtp({ failData: true });
  try {
    let db = seed();
    db = write(db, 'res.company', 1, {
      name: 'شركة النيل للتجارة',
      street: '١٢ شارع التحرير',
      city: 'القاهرة',
      country: 'مصر',
      invoice_qr: 'zatca',
      vat: '300000000000003',
    });
    const arPartner = create(db, 'res.partner', {
      name: 'مؤسسة الشرق الأوسط - East West Co',
      email: 'ar@example.com',
      lang: 'ar',
      street: '٤٥ شارع النخيل',
      city: 'الجيزة',
    });
    const arProd = create(arPartner.db, 'product', { name: 'خدمة استشارية (ERP)', list_price: 250 });
    const arTax = create(arProd.db, 'account.tax', {
      name: 'ضريبة ١٤٪',
      amount: 14,
      type_tax_use: 'sale',
      invoice_legal_notes: 'خاضع لضريبة القيمة المضافة وفقاً للقانون المصري (14%)',
    });
    const arTaxSnap = taxSnapshot(read(arTax.db, 'account.tax', arTax.id), arTax.db);
    const inv = create(arTax.db, 'account.move', {
      move_type: 'out_invoice',
      partner_id: arPartner.id,
      invoice_date: today(),
      payment_reference: 'مرجع-دفع-٢٠٢٦',
      invoice_line_ids: [{ product_id: arProd.id, qty: 2, price_unit: 250, discount: 10, ...arTaxSnap }],
    });
    db = postMove(inv.db, inv.id);
    const move = read(db, 'account.move', inv.id);

    const arPdf = await generateInvoicePdf(db, move, { pdfReportId: 'invoices', lang: 'ar' });
    assert.ok(arPdf.toString('latin1').startsWith('%PDF-1.4'));
    assert.ok(arPdf.toString('latin1').trimEnd().endsWith('%%EOF'));
    assert.ok(arPdf.includes(Buffer.from('/Subtype /Type0')));
    assert.ok(arPdf.includes(Buffer.from('/Encoding /Identity-H')));
    assert.ok(arPdf.includes(Buffer.from('/FontFile2')));

    const info = inspectPdf(arPdf);
    assert.ok(info.cmapsCount >= 2, 'Both Arabic and Latin font subsets must have ToUnicode CMaps');
    for (const expected of [
      'شركة النيل للتجارة',
      '١٢ شارع التحرير',
      'القاهرة',
      'مصر',
      'مؤسسة الشرق الأوسط - East West Co',
      '٤٥ شارع النخيل',
      'الجيزة',
      move.name,
      'مرجع-دفع-٢٠٢٦',
      'خدمة استشارية (ERP)',
      'ضريبة ١٤٪',
      'خاضع لضريبة القيمة المضافة وفقاً للقانون المصري (14%)',
      'امسح للتحقق من الفاتورة',
    ]) {
      assert.ok(info.text.includes(expected), `Extracted Arabic PDF text must include: ${expected}`);
    }

    // Verify RTL layout geometry and UAX #9 visual glyph order beyond PDF signature:
    const headerY = info.glyphBlocks.find((g) => g.y > 775)?.y;
    assert.ok(headerY != null);
    const companyBlock = info.glyphBlocks.find((g) => Math.abs(g.y - headerY) < 5 && g.x > 400);
    const eastWestBlock = info.glyphBlocks.find((g) => g.visualLtr === 'East West Co');
    assert.ok(companyBlock, 'RTL company name must render on right half of header');
    assert.ok(eastWestBlock && eastWestBlock.x < 200, 'LTR segment inside RTL partner name must sit left of Arabic segment');

    // Payment ref "مرجع-دفع-٢٠٢٦": visually LTR Eastern digits '٢','٠','٢','٦' must appear left of '-' and right-side Arabic glyphs.
    const refDigits = info.glyphBlocks.filter((g) => ['٢', '٠', '٦'].includes(g.visualLtr) && g.y > 600 && g.y < 630);
    const refRtl = info.glyphBlocks.filter((g) => g.y > 600 && g.y < 630 && g.x > 520);
    assert.ok(refDigits.length >= 4 && refRtl.length >= 1);
    assert.ok(refDigits[0].x < refDigits[1].x && refDigits[1].x < refDigits[2].x && refDigits[2].x < refDigits[3].x, 'Eastern Arabic digits remain LTR in visual X order');
    assert.ok(refDigits[3].x < refRtl[0].x, 'Eastern digits in مرجع-دفع-٢٠٢٦ must sit left of RTL prefix');

    // Without-payment report omits QR caption in Arabic too.
    const noPayPdf = inspectPdf(await generateInvoicePdf(db, move, { pdfReportId: 'invoices_without_payment', lang: 'ar' }));
    assert.ok(!noPayPdf.text.includes('امسح للتحقق من الفاتورة'));

    // Failing SMTP must leave is_move_sent false.
    const res = runSendMoves(db, move, { email: true, download: false, live: true, lang: 'ar' });
    await assert.rejects(() => sendDocument(failSmtp.cfg, res.db, { name: 'Admin', isAdmin: true }, {
      model: 'account.move', id: move.id, send: res.emailPayloads[move.id],
    }));
    assert.equal(read(res.db, 'account.move', move.id).is_move_sent, false);
    assert.equal(seen.length, 0);

    // Working mock SMTP delivers genuine Arabic PDF attachment and marks move sent.
    const out = await sendDocument(cfg, res.db, { name: 'Admin', isAdmin: true }, {
      model: 'account.move', id: move.id, send: res.emailPayloads[move.id],
    });
    assert.equal(out.status, 200);
    assert.equal(read(out.db, 'account.move', move.id).is_move_sent, true);
    const att = extractSmtpAttachments(seen).find((a) => a.filename.endsWith('.pdf'));
    assert.ok(att && att.contentType === 'application/pdf');
    const sentPdf = inspectPdf(att.content);
    assert.ok(sentPdf.text.includes('شركة النيل للتجارة'));
    assert.ok(sentPdf.text.includes('مؤسسة الشرق الأوسط - East West Co'));
    assert.ok(sentPdf.text.includes('مرجع-دفع-٢٠٢٦'));
  } finally {
    server.close();
    failSmtp.server.close();
  }
});

test('SEND1-12: server rejects duplicate generated invoice_pdf attachments per move without calling SMTP or marking sent', async () => {
  const { server, seen, cfg } = await fakeSmtp();
  const dir = mkdtempSync(join(tmpdir(), 'mizan-send1-dup-pdf-'));
  const dbPath = join(dir, 'test.sqlite');
  const password = 'test-admin-password';
  let appServer;
  try {
    let db = seed();
    const partner = create(db, 'res.partner', { name: 'Dup PDF Co', email: 'dup@example.com' });
    const inv = createPostedInvoice(partner.db, { partnerId: partner.id, price: 180 });
    db = inv.db;
    const move = read(db, 'account.move', inv.id);

    const dupPayload = {
      mail_partner_ids: [partner.id],
      subject: 'Duplicate Invoice PDF',
      body: 'Should fail',
      attachments: [
        { id: 'pdf-1', kind: 'invoice_pdf', name: 'inv-1.pdf', type: 'application/pdf', pdf_report_id: 'invoices' },
        { id: 'pdf-2', kind: 'invoice_pdf', name: 'inv-2.pdf', type: 'application/pdf', pdf_report_id: 'invoices_without_payment' },
      ],
    };

    const directOut = await sendDocument(cfg, db, { name: 'Admin', isAdmin: true }, {
      model: 'account.move',
      id: move.id,
      send: dupPayload,
    });
    assert.equal(directOut.status, 400);
    assert.equal(directOut.body.error, 'Only one generated invoice PDF attachment is allowed');
    assert.equal(seen.length, 0);
    assert.equal(read(db, 'account.move', move.id).is_move_sent, false);

    // Also verify the real HTTP /api/mail/document route rejects duplicate generated PDFs.
    appServer = await startServer({
      env: {
        ...process.env,
        PORT: '0',
        MIZAN_DB: dbPath,
        MIZAN_ADMIN_PASSWORD: password,
        MIZAN_SMTP_HOST: cfg.host,
        MIZAN_SMTP_PORT: String(cfg.port),
        MIZAN_SMTP_FROM: cfg.from,
        MIZAN_PUBLIC_URL: '',
        MIZAN_SECURE_COOKIE: '0',
      },
    });
    const loginRes = await fetch(`${appServer.origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' },
      body: JSON.stringify({ login: 'admin', password }),
    });
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];
    const dbRes = await fetch(`${appServer.origin}/api/db`, { headers: { Cookie: cookie } });
    const epoch = dbRes.headers.get('x-mizan-epoch');
    const baseDb = await dbRes.json();
    const hp = create(baseDb, 'res.partner', { name: 'HTTP Dup Co', email: 'httpdup@example.com' });
    const hinv = createPostedInvoice(hp.db, { partnerId: hp.id, price: 210 });
    await fetch(`${appServer.origin}/api/diff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan', 'X-Mizan-Epoch': epoch, Cookie: cookie },
      body: JSON.stringify(diffDb(baseDb, hinv.db)),
    });

    seen.length = 0;
    const httpOut = await fetch(`${appServer.origin}/api/mail/document`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan', Cookie: cookie },
      body: JSON.stringify({
        model: 'account.move',
        id: hinv.id,
        send: { ...dupPayload, mail_partner_ids: [hp.id] },
      }),
    });
    assert.equal(httpOut.status, 400);
    assert.equal((await httpOut.json()).error, 'Only one generated invoice PDF attachment is allowed');
    assert.ok(!seen.some((l) => l.includes('httpdup@example.com') || l.includes('Duplicate Invoice PDF')));
    const afterDb = await (await fetch(`${appServer.origin}/api/db`, { headers: { Cookie: cookie } })).json();
    assert.equal(read(afterDb, 'account.move', hinv.id).is_move_sent, false);
  } finally {
    await appServer?.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    server.close();
  }
});
