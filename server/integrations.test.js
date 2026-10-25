import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { read, search, write } from '../src/orm.js';
import { seed } from '../src/seed.js';
import { aiDraft, assertPublicUrl, ingestIot, issueIotToken, quoteShipping, sendWhatsApp, syncMarketplace } from './integrations.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
/** Replace fetch with a handler (url, init) → JSON body; records calls. */
function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const body = await handler(String(url), init);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}

test('outbound URLs must be public https', async () => {
  await assert.rejects(assertPublicUrl('http://example.com/feed'), /Only https/);
  await assert.rejects(assertPublicUrl('https://127.0.0.1/feed'), /private networks/);
  await assert.rejects(assertPublicUrl('https://192.168.1.10/feed'), /private networks/);
  await assert.rejects(assertPublicUrl('not a url'), /Invalid URL/);
});

test('marketplace sync imports new orders once, matching products by SKU', async () => {
  const db0 = write(seed(), 'marketplace.connector', 1, { feed_url: 'https://1.1.1.1/orders.json' });
  const feed = [
    { id: 'A-100', customer: { name: 'Mai Online', email: 'mai@shop.example', city: 'Cairo' }, lines: [{ sku: 'FURN-001', qty: 2, price: 199 }] },
    { id: 'A-101', customer: { name: 'Unknown SKU' }, lines: [{ sku: 'NOPE', qty: 1 }] },
  ];
  mockFetch(() => feed);
  const first = await syncMarketplace(db0, { id: 1 });
  assert.equal(first.message, '1 order(s) imported');
  const order = search(first.db, 'sale.order').find((o) => o.client_order_ref === 'amazon:A-100');
  assert.equal(order.connector_id, 1);
  assert.deepEqual(order.order_line.map((l) => [l.product_id, l.qty, l.price_unit]), [[1, 2, 199]]);
  const second = await syncMarketplace(first.db, { id: 1 });
  assert.equal(second.message, '0 order(s) imported');
});

test('API carrier quotes are added as the shipping line', async () => {
  let db = seed();
  const aramex = search(db, 'delivery.carrier').find((c) => c.delivery_type === 'api');
  db = write(db, 'delivery.carrier', aramex.id, { api_url: 'https://1.1.1.1/rate' });
  db = write(db, 'sale.order', 1, { carrier_id: aramex.id });
  const calls = mockFetch(() => ({ price: 77.5 }));
  const out = await quoteShipping({ MIZAN_SHIPPING_TOKEN: 'tok' }, db, { id: 1 });
  const ship = search(out.db, 'product').find((p) => p.default_code === 'SHIP');
  assert.equal(read(out.db, 'sale.order', 1).order_line.find((l) => l.product_id === ship.id).price_unit, 77.5);
  assert.equal(JSON.parse(calls[0].init.body).weight_kg, 560);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
});

test('WhatsApp sends to the partner phone and logs it', async () => {
  const calls = mockFetch(() => ({ messages: [{ id: 'wamid' }] }));
  const out = await sendWhatsApp({ MIZAN_WHATSAPP_TOKEN: 't', MIZAN_WHATSAPP_PHONE_ID: '123' }, seed(), { name: 'Admin' }, { model: 'sale.order', id: 1, text: 'Your quotation is ready' });
  assert.match(calls[0].url, /graph\.facebook\.com\/v21\.0\/123\/messages$/);
  assert.equal(JSON.parse(calls[0].init.body).to, '20223456789');
  assert.match(out.db.messages.at(-1).body, /WhatsApp sent/);
});

test('IoT tokens are stored hashed and authenticate ingestion', () => {
  const issued = issueIotToken(seed(), { id: 1 });
  const token = /iot_[\w-]+/.exec(issued.message)[0];
  assert.notEqual(read(issued.db, 'iot.device', 1).token_hash, token);
  const next = ingestIot(issued.db, token, { value: 42.5 });
  assert.equal(read(next, 'iot.device', 1).last_value, 42.5);
  assert.equal(ingestIot(issued.db, 'iot_wrongwrongwrongwrongwrong', { value: 1 }), null);
  assert.throws(() => ingestIot(issued.db, token, { value: 'x' }), /must be a number/);
});

test('AI draft sends record context to Claude and returns the text', async () => {
  process.env.ANTHROPIC_API_KEY ??= 'test-key';
  const calls = mockFetch(() => ({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text: 'Call Nile Furniture tomorrow to confirm the chair quote.' }], usage: { input_tokens: 10, output_tokens: 10 },
  }));
  const out = await aiDraft(seed(), { name: 'Admin' }, { model: 'crm.lead', id: 1, instruction: 'next step?' });
  assert.match(out.text, /Nile Furniture/);
  const req = JSON.parse(calls[0].init.body);
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.fallbacks, 'default');
  assert.match(req.messages[0].content, /Office chairs for new HQ/);
});

test('bill digitization sends the document to Claude and fills the draft bill', async () => {
  process.env.ANTHROPIC_API_KEY ??= 'test-key';
  const { create } = await import('../src/orm.js');
  const { digitizeBill } = await import('./integrations.js');
  const calls = mockFetch(() => ({
    id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', stop_sequence: null,
    content: [{ type: 'tool_use', id: 'tu_1', name: 'record_bill', input: {
      vendor: 'Delta Timber Co', vendor_vat: 'EG-555', reference: 'DT-2041', invoice_date: '2026-10-20', due_date: '2026-11-19',
      lines: [{ description: 'Oak planks', quantity: 12, unit_price: 45.5, tax_percent: 14 }],
    } }],
    usage: { input_tokens: 10, output_tokens: 10 },
  }));
  const { db, id } = create(seed(), 'account.move', { move_type: 'in_invoice', invoice_line_ids: [] });
  const out = await digitizeBill(db, { id, file: { name: 'bill.pdf', type: 'application/pdf', data: 'JVBERi0xLjQ=' } });
  const req = JSON.parse(calls[0].init.body);
  assert.equal(req.tool_choice.name, 'record_bill');
  assert.equal(req.messages[0].content[0].type, 'document');
  const bill = read(out.db, 'account.move', id);
  assert.equal(read(out.db, 'res.partner', bill.partner_id).name, 'Delta Timber Co');
  assert.deepEqual([bill.ref, bill.invoice_date, bill.invoice_date_due], ['DT-2041', '2026-10-20', '2026-11-19']);
  assert.deepEqual(bill.invoice_line_ids.map((l) => [l.name, l.qty, l.price_unit, l.tax]), [['Oak planks', 12, 45.5, 14]]);
  await assert.rejects(digitizeBill(db, { id, file: { name: 'x.exe', type: 'application/octet-stream', data: 'AA==' } }), /Upload a PDF or an image/);
});
