import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { register } from 'node:module';
import { setupDom } from './test-support/dom.js';
import { create, emptyDb, read, write } from './orm.js';
import { seed } from './seed.js';
import { creditNote, postMove } from './models/accounting.js';
import { sendDocument } from '../server/mail.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const admin = { name: 'Admin', isAdmin: true };
const textOf = (node) => node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join('');

/** Minimal SMTP server accepting every message; resolves with the lines it received. */
function fakeSmtp() {
  const seen = [];
  const server = net.createServer((socket) => {
    socket.write('220 fake\r\n');
    let inData = false;
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data.toString();
      for (let i; (i = buffer.indexOf('\r\n')) >= 0;) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; socket.write('250 queued\r\n'); } else seen.push(line);
          continue;
        }
        seen.push(line);
        if (line.startsWith('EHLO')) socket.write('250 fake\r\n');
        else if (line.startsWith('MAIL') || line.startsWith('RCPT')) socket.write('250 ok\r\n');
        else if (line === 'DATA') { inData = true; socket.write('354 go\r\n'); } else if (line === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    seen,
    cfg: { host: '127.0.0.1', port: server.address().port, from: 'erp@mizan.example' },
  })));
}

/** Decode an RFC 2047 subject line the SMTP client may encode as one base64 word. */
function decodedSubject(line) {
  const value = line.slice('Subject:'.length).trim();
  const match = /^=\?UTF-8\?B\?(.+)\?=$/.exec(value);
  return match ? Buffer.from(match[1], 'base64').toString('utf8') : value;
}

async function renderPrint(model, { db, id }) {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { PrintDoc } = await import('./views/PrintDoc.jsx');
  await initStore();
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => commit(db));
  try {
    await React.act(async () => root.render(React.createElement(PrintDoc, { model, id })));
    return textOf(host);
  } finally {
    await React.act(async () => root.unmount());
  }
}

test('a printed credit note shows the reason recorded on the document', async () => {
  const invoice = create(seed(), 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  const posted = postMove(invoice.db, invoice.id);
  const note = creditNote(posted, read(posted, 'account.move', invoice.id), { reason: 'Damaged chair' });
  const printed = await renderPrint('account.move', { db: note.db, id: note.id });
  assert.match(printed, /Reversal of/);
  assert.match(printed, /Damaged chair/);
});

test('a printed invoice shows both parties full addresses, the company tax ID and the per-tax breakdown', async () => {
  const base = seed();
  const company = write(base, 'res.company', 1, { street: '12 Nile Street', city: 'Cairo', country: 'Egypt', vat: 'EG-123' });
  const buyer = create(company, 'res.partner', {
    name: 'Printed Buyer', email: 'buyer@example.com', street: '45 Palm Avenue', zip: '11511', city: 'Giza', country: 'Egypt', vat: 'EG-999',
  });
  const invoice = create(buyer.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: buyer.id,
    invoice_line_ids: [{ product_id: 1, qty: 2, price_unit: 100, tax: 14, tax_name: 'VAT 14%' }],
  });
  const posted = postMove(invoice.db, invoice.id);
  const printed = await renderPrint('account.move', { db: posted, id: invoice.id });
  assert.match(printed, /12 Nile Street/);
  assert.match(printed, /EG-123/);
  assert.match(printed, /45 Palm Avenue/);
  assert.match(printed, /11511 Giza/);
  assert.match(printed, /EG-999/);
  assert.match(printed, /VAT 14%/);
  assert.match(printed, /200\.00/);
  assert.match(printed, /28\.00/);
});

test('an emailed invoice uses its own company in the subject and contains the full invoice detail', async () => {
  const { server, seen, cfg } = await fakeSmtp();
  try {
    const base = seed();
    const company = write(base, 'res.company', 1, { name: 'Renamed Co', street: '12 Nile Street', city: 'Cairo', country: 'Egypt', vat: 'EG-123' });
    const buyer = create(company, 'res.partner', {
      name: 'Mail Buyer', email: 'buyer@example.com', street: '45 Palm Avenue', zip: '11511', city: 'Giza', country: 'Egypt',
    });
    const invoice = create(buyer.db, 'account.move', {
      move_type: 'out_invoice',
      partner_id: buyer.id,
      invoice_line_ids: [{ product_id: 1, qty: 2, price_unit: 100, tax: 14, tax_name: 'VAT 14%' }],
    });
    const posted = postMove(invoice.db, invoice.id);
    const out = await sendDocument(cfg, posted, admin, { model: 'account.move', id: invoice.id });
    assert.equal(out.status, 200);
    const subject = decodedSubject(seen.find((line) => line.startsWith('Subject:')));
    assert.match(subject, /^Renamed Co — /);
    assert.doesNotMatch(subject, new RegExp(base.settings.company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(seen.some((line) => line.includes('45 Palm Avenue')));
    assert.ok(seen.some((line) => line.includes('EG-123')));
    assert.ok(seen.some((line) => line.includes('VAT 14%')));
    assert.ok(seen.some((line) => line.includes('Total:')));
  } finally {
    server.close();
  }
});

test('emailing a document whose company cannot be resolved explains what to configure', async () => {
  const base = emptyDb();
  const buyer = create(base, 'res.partner', { name: 'No Company Buyer', email: 'buyer@example.com' });
  const order = create(buyer.db, 'sale.order', { partner_id: buyer.id, order_line: [] });
  const out = await sendDocument({}, order.db, admin, { model: 'sale.order', id: order.id });
  assert.deepEqual([out.status, out.body.error], [400, 'Configure the document company before emailing.']);
});
