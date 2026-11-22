import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { fromCsv } from './csv.js';
import { readXlsx } from './xlsx.js';
import { menusFor, models } from './models/index.js';
import { postMove } from './models/accounting.js';
import { accountId } from './models/ledger.js';
import { applyPaymentCredit, postPayment } from './models/pay.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const run = (db, model, id, label, values = {}) => models[model].form.buttons
  .find((button) => button.label === label)
  .run(db, read(db, model, id), values).db;

function findMenuLeaf(entries, key) {
  for (const entry of entries ?? []) {
    if (entry.key === key) return entry;
    const nested = findMenuLeaf(entry.children, key);
    if (nested) return nested;
  }
  return null;
}

function normCell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g, '').trim();
  const stripped = s.replace(/[$€£¥\s]/g, '').replace(/,/g, '');
  if (/^[-+]?\d+(?:\.\d+)?$/.test(stripped)) return Number(stripped);
  return s;
}

function setupDownloadSpy(makeEl) {
  const downloads = [];
  const origCreateElement = globalThis.document.createElement;
  const origCreateElementNS = globalThis.document.createElementNS;
  const origCreateUrl = URL.createObjectURL;
  const origRevokeUrl = URL.revokeObjectURL;

  globalThis.document.createElementNS = (_ns, tag) => makeEl(tag);
  globalThis.document.createElement = (tag) => {
    const el = makeEl(tag);
    el.click = () => {
      if (tag.toLowerCase() === 'a') {
        downloads.push({ filename: el.download, blob: el._blob ?? downloads.at(-1)?.blob });
      }
    };
    return el;
  };
  URL.createObjectURL = (blob) => {
    downloads.push({ filename: null, blob });
    return 'blob:test';
  };
  URL.revokeObjectURL = () => {};

  const takeLast = async () => {
    const entry = downloads.pop();
    if (!entry?.blob) return null;
    return {
      filename: entry.filename,
      type: entry.blob.type,
      bytes: new Uint8Array(await entry.blob.arrayBuffer()),
      text: async () => entry.blob.text(),
    };
  };

  const restore = () => {
    globalThis.document.createElement = origCreateElement;
    globalThis.document.createElementNS = origCreateElementNS;
    URL.createObjectURL = origCreateUrl;
    URL.revokeObjectURL = origRevokeUrl;
  };

  return { takeLast, restore };
}

function buildUnreconciledFixture() {
  const base = seed();
  const partnerRes = create(base, 'res.partner', { name: 'UNR1 Test Customer' });
  const bnk = search(partnerRes.db, 'account.journal').find((j) => j.code === 'BNK1');
  const ar = accountId(partnerRes.db, '121000', 1);
  const rev = accountId(partnerRes.db, '400000', 1);

  const makeInv = (db, name, price, date) => create(db, 'account.move', {
    name,
    move_type: 'out_invoice',
    partner_id: partnerRes.id,
    company_id: 1,
    invoice_date: date,
    invoice_line_ids: [{ name: `${name} Line`, account_id: rev, qty: 1, price_unit: price, tax: 0 }],
  });

  // 1. Open posted invoice ($250 residual) -> must appear in Unreconciled.
  const invOpenRes = makeInv(partnerRes.db, 'INV-UNR-OPEN', 250, '2026-04-01');
  let db = postMove(invOpenRes.db, invOpenRes.id);

  // 2. Posted invoice ($100) fully paid by an overpayment ($150 with $50 unapplied):
  //    invoice AR line has abs(balance) === 100 and reconciled === false, YET amount_residual === 0 -> must NOT appear.
  //    payment AR line has reconciled === false and amount_residual === -50 -> must appear.
  const invOverRes = makeInv(db, 'INV-UNR-PAID-BY-OVERPAY', 100, '2026-04-02');
  db = postMove(invOverRes.db, invOverRes.id);
  const overpayRes = create(db, 'account.payment', {
    partner_id: partnerRes.id,
    company_id: 1,
    payment_type: 'inbound',
    partner_type: 'customer',
    journal_id: bnk.id,
    amount: 150,
    date: '2026-04-03',
  });
  db = postPayment(overpayRes.db, read(overpayRes.db, 'account.payment', overpayRes.id));
  db = applyPaymentCredit(db, read(db, 'account.payment', overpayRes.id), read(db, 'account.move', invOverRes.id), '2026-04-03');

  // 3. Fully settled invoice ($80) -> must NOT appear.
  const invFullRes = makeInv(db, 'INV-UNR-FULL', 80, '2026-04-04');
  db = postMove(invFullRes.db, invFullRes.id);
  db = run(db, 'account.move', invFullRes.id, 'Register Payment', {
    amount: 80,
    date: '2026-04-04',
    journal_id: bnk.id,
  });

  // 4. Draft journal entry ($70 on AR) -> must NOT appear by default (Posted filter active).
  const invDraftRes = create(db, 'account.move', {
    name: 'DRAFT-UNR-01',
    move_type: 'entry',
    state: 'draft',
    partner_id: partnerRes.id,
    company_id: 1,
    date: '2026-04-05',
    line_ids: [
      { account_id: ar, partner_id: partnerRes.id, debit: 70, name: 'Draft AR Line' },
      { account_id: rev, partner_id: partnerRes.id, credit: 70, name: 'Draft Rev Line' },
    ],
  });
  db = invDraftRes.db;

  const synced = applyDiff(base, diffDb(base, db), { isAdmin: true });
  return {
    db: synced,
    ar,
    rev,
    invOpenId: invOpenRes.id,
    invOverId: invOverRes.id,
    overpayMoveId: read(synced, 'account.payment', overpayRes.id).move_id,
    invFullId: invFullRes.id,
    invDraftId: invDraftRes.id,
  };
}

test('UNR-2: Unreconciled leaf offers Print, CSV, and XLSX exports matching Journal Items via the shared export helpers', async () => {
  const unreconciledLeaf = findMenuLeaf(menusFor('accounting'), 'unreconciled');
  const f = buildUnreconciledFixture();

  const { makeEl } = setupDom();
  const spy = setupDownloadSpy(makeEl);
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { JournalItems } = await import('./views/JournalItems.jsx');
  await initStore();

  const origPrint = globalThis.window.print;
  let printCalls = 0;
  globalThis.window.print = () => { printCalls += 1; };

  const root = createRoot(host);
  try {
    await React.act(async () => {
      await commit(f.db);
      root.render(React.createElement(JournalItems, { leaf: unreconciledLeaf }));
    });

    const printBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Print');
    const csvBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Download CSV');
    const xlsxBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Export XLSX');
    assert.ok(printBtn, 'Unreconciled leaf has Print button');
    assert.ok(csvBtn, 'Unreconciled leaf has Download CSV button');
    assert.ok(xlsxBtn, 'Unreconciled leaf has Export XLSX button');

    await React.act(async () => props(csvBtn).onClick());
    const csvDl = await spy.takeLast();
    assert.equal(csvDl.filename, 'unreconciled.csv');
    const csvRows = fromCsv(await csvDl.text());

    await React.act(async () => props(xlsxBtn).onClick());
    const xlsxDl = await spy.takeLast();
    assert.equal(xlsxDl.filename, 'unreconciled.xlsx');
    const xlsxRows = readXlsx(xlsxDl.bytes).rows;

    assert.equal(csvRows.length, xlsxRows.length, 'CSV and XLSX export the exact same rows');
    for (let i = 0; i < csvRows.length; i += 1) {
      assert.deepEqual(csvRows[i].map(normCell), xlsxRows[i].map(normCell));
    }
    assert.ok(!xlsxRows[0].includes('Select'), 'Select column excluded from export');
    assert.ok(xlsxRows.some((r) => r.includes('INV-UNR-OPEN')), 'Open invoice exported');
    assert.ok(!xlsxRows.some((r) => r.includes('INV-UNR-DRAFT')), 'Draft invoice excluded from export');
    assert.ok(xlsxRows.at(-1).includes('Total'), 'Totals row included in export');

    await React.act(async () => props(printBtn).onClick());
    assert.equal(printCalls, 1, 'Print view triggers window.print once');
    const heading = find(host, (n) => n.tagName === 'H1');
    assert.equal(heading?.textContent, 'Unreconciled', 'Print view renders Unreconciled heading');
    const backBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Back');
    assert.ok(backBtn, 'Print view shows Back button');
    assert.equal(find(host, (n) => n.tagName === 'TH' && n.textContent.includes('Select')), null, 'Print view omits Select column');

    await React.act(async () => props(backBtn).onClick());
    assert.ok(find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Download CSV'), 'Back restores normal controls');
  } finally {
    globalThis.window.print = origPrint;
    await React.act(async () => root.unmount());
    spy.restore();
  }
});
