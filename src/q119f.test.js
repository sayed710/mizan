import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, postNote, read, search, write } from './orm.js';
import { applyDiff, diffDb } from './sync.js';
import { cleanMessage } from './validate.js';
import { auditTrailToCsv, collectAuditTrailRows } from './models/auditTrail.js';
import { syncOnlineJournal } from './models/onlineSync.js';
import { importStatement } from './models/statements.js';
import { escapeXml, taxReturnToXml } from './models/taxExport.js';
import { accountId } from './models/ledger.js';
import { today } from './models/common.js';
import { postMove } from './models/accounting.js';
import { taxSnapshot } from './models/taxes.js';
import { find, setupDom } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

/** Return true when `str` contains only valid XML 1.0 Char code points and no lone surrogates. */
function isValidXml10Text(str) {
  for (let i = 0; i < str.length; i += 1) {
    const cu = str.charCodeAt(i);
    if (cu >= 0xD800 && cu <= 0xDBFF) {
      const next = str.charCodeAt(i + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
      i += 1;
      continue;
    }
    if (cu >= 0xDC00 && cu <= 0xDFFF) return false;
    const valid = cu === 0x09 || cu === 0x0A || cu === 0x0D
      || (cu >= 0x20 && cu <= 0xD7FF)
      || (cu >= 0xE000 && cu <= 0xFFFD);
    if (!valid) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 1. Audit trail structured metadata provenance
// ---------------------------------------------------------------------------

test('1a: non-admin applyDiff strips forged structured tracking metadata when no matching write occurred', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { audit_trail: true });
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = inv.db;

  const forgedMoveMsg = {
    id: 'forged-move-tracking-1',
    model: 'account.move',
    res_id: inv.id,
    body: 'Amount: 1 -> 999',
    kind: 'tracking',
    author: 'Attacker',
    date: '2026-04-10T10:00:00.000Z',
    field: 'amount_total',
    old_value: '1',
    new_value: '999',
  };
  const forgedCompanyMsg = {
    id: 'forged-company-lock-1',
    model: 'res.company',
    res_id: 1,
    body: 'Lock Date: — → 2026-12-31',
    kind: 'tracking',
    author: 'Attacker',
    date: '2026-04-10T10:00:00.000Z',
    field: 'lock_date',
    old_value: '—',
    new_value: '2026-12-31',
  };

  const synced = applyDiff(db, { messages: [forgedMoveMsg, forgedCompanyMsg] }, { isAdmin: false, author: 'Clerk' });
  const storedMove = synced.messages.find((m) => m.id === 'forged-move-tracking-1');
  const storedLock = synced.messages.find((m) => m.id === 'forged-company-lock-1');
  assert.ok(storedMove, 'message body should be retained');
  assert.equal(storedMove.kind, 'tracking');
  assert.equal(storedMove.body, 'Amount: 1 -> 999');
  assert.equal(storedMove.field, undefined);
  assert.equal(storedMove.old_value, undefined);
  assert.equal(storedMove.new_value, undefined);

  assert.ok(storedLock);
  assert.equal(storedLock.kind, 'tracking');
  assert.equal(storedLock.field, undefined);
  assert.equal(storedLock.old_value, undefined);
  assert.equal(storedLock.new_value, undefined);

  const rows = collectAuditTrailRows(synced, synced, { from: '2000-01-01', to: '2099-12-31' });
  assert.equal(rows.some((r) => r.res_id === inv.id && (r.field === 'Total' || (r.oldValue === '1' && r.newValue === '999'))), false);
  assert.equal(rows.some((r) => r.model === 'res.company' && r.field === 'Lock Date' && r.newValue === '2026-12-31'), false);

  const csv = auditTrailToCsv(rows);
  assert.equal(csv.includes('"1","999"'), false);
  assert.equal(csv.includes('"Lock Date","—","2026-12-31"'), false);
});

test('1b: non-admin applyDiff preserves structured tracking metadata for a genuine offline edit synced with its tracking message', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { audit_trail: true });
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-10',
    invoice_date_due: '2026-04-20',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = inv.db;

  const offline = write(db, 'account.move', inv.id, { invoice_date_due: '2026-05-01' });
  const diff = diffDb(db, offline);
  assert.ok((diff.messages ?? []).some((m) => m.field === 'invoice_date_due' && m.old_value === '2026-04-20' && m.new_value === '2026-05-01'));

  const synced = applyDiff(db, diff, { isAdmin: false, author: 'Offline User' });
  const rows = collectAuditTrailRows(synced, synced, { from: '2000-01-01', to: '2099-12-31' });
  const dueRow = rows.find((r) => r.model === 'account.move' && r.res_id === inv.id && r.field === 'Due Date' && r.newValue === '2026-05-01');
  assert.ok(dueRow, 'genuine offline tracked write must keep its structured audit row');
  assert.equal(dueRow.oldValue, '2026-04-20');
  assert.ok(auditTrailToCsv(rows).includes('"Due Date","2026-04-20","2026-05-01"'));
});

test('1c: non-admin applyDiff cannot alter field, old_value, or new_value of an existing stored tracking message', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { audit_trail: true });
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-10',
    invoice_date_due: '2026-04-20',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = write(inv.db, 'account.move', inv.id, { invoice_date_due: '2026-04-25' });

  const storedMsg = db.messages.find((m) => m.model === 'account.move' && m.res_id === inv.id && m.field === 'invoice_date_due');
  assert.ok(storedMsg);

  const edited = { ...storedMsg, field: 'amount_total', old_value: '1', new_value: '999', body: 'Tampered' };
  const afterEdit = applyDiff(db, {
    messages: [edited],
    removedMessages: [storedMsg.id],
  }, { isAdmin: false, author: 'Clerk' });

  const afterStored = afterEdit.messages.find((m) => m.id === storedMsg.id);
  assert.ok(afterStored, 'stored protected tracking message cannot be removed');
  assert.equal(afterStored.field, 'invoice_date_due');
  assert.equal(afterStored.old_value, '2026-04-20');
  assert.equal(afterStored.new_value, '2026-04-25');
  assert.equal(afterStored.body, storedMsg.body);
});

test('1d: cleanMessage strips structured fields from note messages and postNote cannot spoof tracking fields', () => {
  const cleanedNote = cleanMessage({
    id: 'note-spoof-1',
    model: 'account.move',
    res_id: 1,
    body: 'Amount: 1 -> 999',
    kind: 'note',
    field: 'amount_total',
    old_value: '1',
    new_value: '999',
  });
  assert.equal(cleanedNote.kind, 'note');
  assert.equal(cleanedNote.field, undefined);
  assert.equal(cleanedNote.old_value, undefined);
  assert.equal(cleanedNote.new_value, undefined);

  let db = seed();
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postNote(inv.db, 'account.move', inv.id, 'Spoofed note', null, {
    kind: 'tracking',
    field: 'amount_total',
    old_value: '1',
    new_value: '999',
  });
  const posted = db.messages.at(-1);
  assert.equal(posted.kind, 'note');
  assert.equal(posted.field, undefined);
  assert.equal(posted.old_value, undefined);
  assert.equal(posted.new_value, undefined);
});

// ---------------------------------------------------------------------------
// 2. Online sync scoped deduplication by target journal
// ---------------------------------------------------------------------------

function setupOnlineBanks(db) {
  const banks = search(db, 'account.journal').filter((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const journalA = banks[0];
  const journalBRes = create(db, 'account.journal', {
    name: 'Secondary Bank B',
    code: 'BNK2',
    type: 'bank',
    company_id: 1,
    suspense_account_id: journalA.suspense_account_id ?? accountId(db, '101401', 1),
  });
  const journalB = read(journalBRes.db, 'account.journal', journalBRes.id);
  const conn = create(journalBRes.db, 'account.online.link', {
    name: 'Demo Online Bank',
    provider: 'demo',
    company_id: 1,
    state: 'connected',
    demo_transactions: {
      'ACC-A': {
        '': {
          transactions: [{ unique_import_id: 'TX-X', date: '2026-04-15', amount: 125, payment_ref: 'Online Deposit X' }],
          nextCursor: 'cursor-1',
          balance: 125,
        },
      },
    },
  });
  const acc = create(conn.db, 'account.online.account', {
    name: 'Checking A',
    account_number: 'ACC-A',
    link_id: conn.id,
    journal_id: journalA.id,
    last_sync_cursor: '',
  });
  return { db: acc.db, journalA, journalB, onlineAccountId: acc.id };
}

function withLegacyJournalLessLine(db, uniqueImportId) {
  const legacyLine = {
    id: (db.seq['account.bank.statement.line'] ?? 0) + 1,
    company_id: 1,
    journal_id: null,
    date: '2026-04-01',
    amount: 125,
    payment_ref: 'Legacy Journal-less Line',
    unique_import_id: uniqueImportId,
    state: 'to_check',
    active: true,
  };
  return {
    ...db,
    seq: { ...db.seq, 'account.bank.statement.line': legacyLine.id },
    records: {
      ...db.records,
      'account.bank.statement.line': [...(db.records['account.bank.statement.line'] ?? []), legacyLine],
    },
  };
}

test('2a: online sync imports TX-X into journal A despite same-company legacy journal-less line with TX-X and advances cursor', () => {
  let { db, journalA, onlineAccountId } = setupOnlineBanks(seed());
  // Inject a legacy same-company statement line without a journal_id.
  db = withLegacyJournalLessLine(db, 'TX-X');

  const res = syncOnlineJournal(db, journalA.id);
  assert.equal(res.error, null);
  assert.equal(res.count, 1);
  const linesInA = search(res.db, 'account.bank.statement.line')
    .filter((l) => l.journal_id === journalA.id && l.unique_import_id === 'TX-X');
  assert.equal(linesInA.length, 1);
  assert.equal(read(res.db, 'account.online.account', onlineAccountId).last_sync_cursor, 'cursor-1');
});

test('2b: online sync skips TX-X when journal A already has a line with unique_import_id TX-X', () => {
  let { db, journalA, onlineAccountId } = setupOnlineBanks(seed());
  const existing = create(db, 'account.bank.statement.line', {
    journal_id: journalA.id,
    company_id: 1,
    date: '2026-04-15',
    amount: 125,
    payment_ref: 'Already In A',
    unique_import_id: 'TX-X',
  });
  db = existing.db;

  const res = syncOnlineJournal(db, journalA.id);
  assert.equal(res.error, null);
  assert.equal(res.count, 0);
  const linesInA = search(res.db, 'account.bank.statement.line')
    .filter((l) => l.journal_id === journalA.id && l.unique_import_id === 'TX-X');
  assert.equal(linesInA.length, 1);
  assert.equal(read(res.db, 'account.online.account', onlineAccountId).last_sync_cursor, 'cursor-1');
});

test('2c: online sync imports TX-X into journal A when unique_import_id TX-X exists on journal B of the same company', () => {
  let { db, journalA, journalB, onlineAccountId } = setupOnlineBanks(seed());
  const inB = create(db, 'account.bank.statement.line', {
    journal_id: journalB.id,
    company_id: 1,
    date: '2026-04-15',
    amount: 125,
    payment_ref: 'Line In B',
    unique_import_id: 'TX-X',
  });
  db = inB.db;

  const res = syncOnlineJournal(db, journalA.id);
  assert.equal(res.error, null);
  assert.equal(res.count, 1);
  const linesInA = search(res.db, 'account.bank.statement.line')
    .filter((l) => l.journal_id === journalA.id && l.unique_import_id === 'TX-X');
  assert.equal(linesInA.length, 1);
  assert.equal(read(res.db, 'account.online.account', onlineAccountId).last_sync_cursor, 'cursor-1');
});

test('2d: file import still treats a same-company journal-less legacy line as a duplicate', () => {
  let { db, journalA } = setupOnlineBanks(seed());
  db = withLegacyJournalLessLine(db, 'FILE-TX-1');

  const ofx = '<BANKTRANLIST><STMTTRN><DTPOSTED>20260401<TRNAMT>125<FITID>FILE-TX-1<NAME>Legacy Journal-less Line</STMTTRN></BANKTRANLIST>';
  const res = importStatement(db, 'bank.ofx', ofx, { journal_id: journalA.id, company_id: 1 });
  assert.equal(res.count, 0);
  assert.equal(search(res.db, 'account.bank.statement.line').filter((l) => l.unique_import_id === 'FILE-TX-1').length, 1);
});

// ---------------------------------------------------------------------------
// 3. BankReconcile foreign bank currency display
// ---------------------------------------------------------------------------

test('3: BankReconcile formats statement amount in foreign EUR journal currency while open balance stays in USD company currency', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/reconcile' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { BankReconcile } = await import('./views/BankReconcile.jsx');
  await initStore();

  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(eur, 'EUR currency exists in seed');
  const usdBank = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const eurJournalRes = create(db, 'account.journal', {
    name: 'Euro Bank EUR',
    code: 'EURB',
    type: 'bank',
    company_id: 1,
    currency_id: eur.id,
    suspense_account_id: usdBank.suspense_account_id ?? accountId(db, '101401', 1),
  });
  const lineRes = create(eurJournalRes.db, 'account.bank.statement.line', {
    journal_id: eurJournalRes.id,
    company_id: 1,
    date: today(),
    amount: 90,
    payment_ref: 'EUR-LINE-90',
  });
  // Ensure line itself relies on its journal currency, even without an explicit line.currency_id.
  const withoutLineCurrency = {
    ...lineRes.db,
    records: {
      ...lineRes.db.records,
      'account.bank.statement.line': lineRes.db.records['account.bank.statement.line'].map((l) => (
        l.id === lineRes.id ? { ...l, currency_id: null } : l
      )),
    },
  };
  await commit(withoutLineCurrency);

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(BankReconcile, { leaf: { key: 'reconcile', type: 'bankReconcile' } })));
    const eurBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('EUR-LINE-90'));
    assert.ok(eurBtn, 'EUR statement line appears in left pane');
    await React.act(async () => props(eurBtn).onClick());

    const amountsEl = find(host, (n) => n.tagName === 'DIV' && props(n)?.className === 'bank-reconcile-amounts');
    assert.ok(amountsEl, 'amounts summary rendered');
    const summaryText = amountsEl.textContent;
    // Statement Amount is in EUR (€), Open Balance is in USD ($100.00 at latest 0.9 rate).
    assert.match(summaryText, /Statement Amount:\s*90\.00 €/);
    assert.match(summaryText, /Open Balance:\s*\$100\.00/);
  } finally {
    await React.act(async () => root.unmount());
  }
});

// ---------------------------------------------------------------------------
// 4. Tax return XML export character sanitization & attribute normalization
// ---------------------------------------------------------------------------

test('4: escapeXml and taxReturnToXml strip disallowed XML 1.0 chars, escape markup, encode control whitespace in attributes, and keep Arabic/emoji', () => {
  const nastyName = 'Return\u0000\u0008\u001f\uD800\uFFFE\uFFFF\t\n\r<&"\' ضريبة 🧾';
  const escapedAttr = escapeXml(nastyName, { attribute: true });
  assert.ok(isValidXml10Text(escapedAttr), 'escaped attribute must contain only XML 1.0 valid characters');
  assert.equal(escapedAttr.includes('\t'), false);
  assert.equal(escapedAttr.includes('\n'), false);
  assert.equal(escapedAttr.includes('\r'), false);
  assert.ok(escapedAttr.includes('&#x9;&#xA;&#xD;'));
  assert.ok(escapedAttr.includes('&lt;&amp;&quot;&apos;'));
  assert.ok(escapedAttr.includes('ضريبة'));
  assert.ok(escapedAttr.includes('🧾'));

  let db = seed();
  const nastyTaxLabel = 'VAT\u0000\u0008\u001f\uD800\uFFFE\uFFFF\t\n\r <&"\' ضريبة 🧾';
  const tax = create(db, 'account.tax', {
    name: nastyTaxLabel,
    amount: 10,
    type_tax_use: 'sale',
    company_id: 1,
  });
  const revAcc = accountId(tax.db, '400000', 1) ?? accountId(tax.db, '410000', 1);
  const inv = create(tax.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    company_id: 1,
    invoice_date: '2026-04-10',
    invoice_line_ids: [{ qty: 1, price_unit: 200, ...taxSnapshot(read(tax.db, 'account.tax', tax.id)), account_id: revAcc }],
  });
  db = postMove(inv.db, inv.id);
  const returnType = search(db, 'account.return.type').find((t) => (t.company_id ?? 1) === 1);
  assert.ok(returnType, 'default return type exists');
  const ret = create(db, 'account.return', {
    name: nastyName,
    type_id: returnType.id,
    company_id: 1,
    date_from: '2026-04-01',
    date_to: '2026-04-30',
    template: 'generic',
  });
  const xml = taxReturnToXml(ret.db, read(ret.db, 'account.return', ret.id));
  assert.ok(isValidXml10Text(xml), 'exported XML must contain zero characters outside XML 1.0 Char production');
  assert.ok(xml.includes('ضريبة'));
  assert.ok(xml.includes('🧾'));
  assert.ok(xml.includes('&#x9;&#xA;&#xD;'));
  assert.ok(xml.includes('&lt;&amp;&quot;&apos;'));
  // Ensure raw control whitespace or unescaped markup did not leak inside attributes
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.ok(xml.includes('<taxReturn name="Return&#x9;&#xA;&#xD;&lt;&amp;&quot;&apos; ضريبة 🧾"'));
  assert.ok(xml.includes('label="VAT&#x9;&#xA;&#xD; &lt;&amp;&quot;&apos; ضريبة 🧾"'));
});
