import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { fromCsv } from './csv.js';
import { accountId } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { taxSnapshot } from './models/taxes.js';
import { taxReport } from './models/finance.js';
import { ensureReturnTypes } from './models/taxreturn.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

/** Setup tax return fixture with sale & purchase invoices and a tax containing commas, quotes, <, >, &. */
function setupTaxReturnFixture(templateOverride = {}) {
  let db = ensureReturnTypes(seed());
  const vatOutAcc = accountId(db, '251000');
  const vatInAcc = accountId(db, '131000');
  const specialTax = create(db, 'account.tax', {
    name: 'VAT 14% "Std", <Goods & Services>',
    amount: 14,
    amount_type: 'percent',
    type_tax_use: 'sale',
    tax_scope: 'consu',
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100 },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatOutAcc },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100 },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatOutAcc },
    ],
  });
  db = specialTax.db;

  const purchaseTax = create(db, 'account.tax', {
    name: 'Input VAT 10% <Import & Freight>',
    amount: 10,
    amount_type: 'percent',
    type_tax_use: 'purchase',
    tax_scope: 'service',
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100 },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatInAcc },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100 },
      { repartition_type: 'tax', factor_percent: 100, account_id: vatInAcc },
    ],
  });
  db = purchaseTax.db;

  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-10',
    invoice_line_ids: [{ product_id: 5, qty: 2, price_unit: 500, ...taxSnapshot(read(db, 'account.tax', specialTax.id)) }],
  });
  db = postMove(inv1.db, inv1.id);

  const bill1 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-04-12',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 400, ...taxSnapshot(read(db, 'account.tax', purchaseTax.id)) }],
  });
  db = postMove(bill1.db, bill1.id);

  if (templateOverride.companyTemplate) {
    db = write(db, 'res.company', 1, { tax_return_template: templateOverride.companyTemplate });
  }
  const type = search(db, 'account.return.type').find((t) => (t.company_id ?? 1) === 1 && t.category === 'account_return');
  const ret = create(db, 'account.return', {
    name: 'VAT Apr 2026',
    type_id: type.id,
    date_from: '2026-04-01',
    date_to: '2026-04-30',
    company_id: 1,
    ...(templateOverride.returnTemplate ? { tax_return_template: templateOverride.returnTemplate } : {}),
  });
  return { db: ret.db, ret: read(ret.db, 'account.return', ret.id) };
}

test('tax return CSV and XML export totals match taxReport and escape commas, quotes, < and &', async () => {
  const { taxReturnBoxes, taxReturnToCsv, taxReturnToXml, TAX_RETURN_TEMPLATES } = await import('./models/taxExport.js');
  assert.ok(TAX_RETURN_TEMPLATES.generic, 'Default generic template exists in registry');
  assert.ok(TAX_RETURN_TEMPLATES.eg_vat, 'Country/template registry entry eg_vat exists');

  const { db, ret } = setupTaxReturnFixture();
  const period = { from: ret.date_from, to: ret.date_to, company_id: ret.company_id };
  const expected = taxReport(db, period);

  const exportData = taxReturnBoxes(db, ret);
  assert.equal(exportData.template, 'generic');
  assert.equal(exportData.totals.output, expected.output);
  assert.equal(exportData.totals.input, expected.input);
  assert.equal(exportData.totals.payable, expected.payable);

  const csvText = taxReturnToCsv(db, ret);
  const parsedCsv = fromCsv(csvText);
  assert.deepEqual(parsedCsv[0], ['Box Code', 'Label', 'Base', 'Tax']);
  const csvTaxRow = parsedCsv.find((r) => r[1] === 'VAT 14% "Std", <Goods & Services>');
  assert.ok(csvTaxRow, 'CSV round-trip preserves commas, quotes, < and &');
  const csvOutTotal = parsedCsv.find((r) => r[0] === 'TOTAL-OUT');
  const csvInTotal = parsedCsv.find((r) => r[0] === 'TOTAL-IN');
  const csvPayable = parsedCsv.find((r) => r[0] === 'PAYABLE');
  assert.equal(Number(csvOutTotal[3]), expected.output);
  assert.equal(Number(csvInTotal[3]), expected.input);
  assert.equal(Number(csvPayable[3]), expected.payable);

  const xmlText = taxReturnToXml(db, ret);
  assert.ok(xmlText.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(!xmlText.includes('<Goods & Services>'), 'Raw < and & must be escaped in XML');
  assert.ok(xmlText.includes('&lt;Goods &amp; Services&gt;'));
  assert.ok(xmlText.includes('&quot;Std&quot;'));
  assert.match(xmlText, new RegExp(`output="${expected.output.toFixed(2)}"`));
  assert.match(xmlText, new RegExp(`input="${expected.input.toFixed(2)}"`));
  assert.match(xmlText, new RegExp(`payable="${expected.payable.toFixed(2)}"`));
});

test('tax return template selection uses explicit template field (never company name) and keeps totals exact', async () => {
  const { taxReturnBoxes } = await import('./models/taxExport.js');
  // Company name mentions Saudi/Egypt, but explicit template stays generic unless explicitly set.
  const base = setupTaxReturnFixture();
  const renamed = write(base.db, 'res.company', 1, { name: 'Saudi Arabia Trading Co.' });
  const ret1 = read(renamed, 'account.return', base.ret.id);
  assert.equal(taxReturnBoxes(renamed, ret1).template, 'generic', 'Must not guess template from company name');

  const { db: egDb, ret: egRet } = setupTaxReturnFixture({ companyTemplate: 'eg_vat' });
  const egPeriod = { from: egRet.date_from, to: egRet.date_to, company_id: egRet.company_id };
  const egExpected = taxReport(egDb, egPeriod);
  const egOut = taxReturnBoxes(egDb, egRet);
  assert.equal(egOut.template, 'eg_vat');
  assert.equal(egOut.totals.output, egExpected.output);
  assert.equal(egOut.totals.input, egExpected.input);
  assert.equal(egOut.totals.payable, egExpected.payable);
  assert.ok(egOut.boxes.some((b) => b.code === 'BOX-1' && b.tax === 140), 'Maps goods sale to BOX-1 via explicit tax_scope');
  assert.ok(egOut.boxes.some((b) => b.code === 'BOX-6' && b.tax === 40), 'Maps services purchase to BOX-6 via explicit tax_scope');

  // Return-level template overrides company-level template.
  const { db: saDb, ret: saRet } = setupTaxReturnFixture({ companyTemplate: 'eg_vat', returnTemplate: 'sa_vat' });
  const saOut = taxReturnBoxes(saDb, saRet);
  assert.equal(saOut.template, 'sa_vat');
  assert.equal(saOut.totals.payable, taxReport(saDb, { from: saRet.date_from, to: saRet.date_to, company_id: saRet.company_id }).payable);
});

test('tax return FormView renders Export CSV and Export XML buttons triggering downloads', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { initStore, commit } = await import('./store.js');
  const { menusFor } = await import('./models/index.js');
  const { FormView } = await import('./views/FormView.jsx');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  const { db, ret } = setupTaxReturnFixture();
  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (namespace, tag) => makeEl(tag);
  await initStore();
  commit(db);

  const trLeaf = menusFor('accounting').find((m) => m.label === 'Accounting').children.find((m) => m.label === 'Closing').children.find((m) => m.key === 'tax-returns');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const textOf = (n) => (n?.nodeType === 3 ? n.nodeValue : (n?.childNodes ?? []).map(textOf).join(''));
  const props = (n) => n?.[Object.keys(n).find((k) => k.startsWith('__reactProps$'))];

  try {
    await React.act(async () => {
      root.render(React.createElement(FormView, { leaf: trLeaf, id: ret.id, base: '#/accounting/tax-returns', params: new URLSearchParams() }));
    });
    const csvBtn = find(host, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Export CSV');
    const xmlBtn = find(host, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Export XML');
    assert.ok(csvBtn, 'Export CSV button is rendered on tax return');
    assert.ok(xmlBtn, 'Export XML button is rendered on tax return');
    assert.doesNotThrow(() => {
      props(csvBtn).onClick();
      props(xmlBtn).onClick();
    });
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('audit trail captures lock-date, account, tax, payment and move changes with who/when/field/old/new', async () => {
  const { setAuthor } = await import('./orm.js');
  const { collectAuditTrailRows } = await import('./models/auditTrail.js');
  setAuthor('Nadia Auditor');
  let db = seed();

  // Lock-date change on res.company is captured; unrelated company fields are excluded.
  db = write(db, 'res.company', 1, { phone: '+20 111 222 3333' });
  db = write(db, 'res.company', 1, { lock_date: '2026-01-31' });
  db = write(db, 'res.company', 1, { lock_date: '2026-02-28' });

  // Account, tax, payment, and move edits are captured.
  const acc = db.records['account.account'][0];
  db = write(db, 'account.account', acc.id, { name: `${acc.name} Audited` });

  const tax = db.records['account.tax'][0];
  db = write(db, 'account.tax', tax.id, { amount: 15 });

  const pay = create(db, 'account.payment', { partner_id: 1, amount: 250, date: '2026-04-01' });
  db = write(pay.db, 'account.payment', pay.id, { memo: 'Wire Updated' });

  const inv = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-04-02', invoice_date_due: '2026-04-12', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
  db = write(inv.db, 'account.move', inv.id, { invoice_date_due: '2026-04-20' });

  const rows = collectAuditTrailRows(db, db, { from: '2000-01-01', to: '2099-12-31' });
  const lockRow = rows.find((r) => r.model === 'res.company' && r.field === 'Lock Date' && r.newValue === '2026-02-28');
  assert.ok(lockRow, 'Company lock-date change must appear in Audit Trail');
  assert.equal(lockRow.author, 'Nadia Auditor');
  assert.ok(lockRow.date);
  assert.equal(lockRow.oldValue, '2026-01-31');

  assert.ok(!rows.some((r) => r.model === 'res.company' && /Phone/i.test(r.body)), 'Non-lock company edits stay out of Audit Trail');
  assert.ok(rows.some((r) => r.model === 'account.account' && r.res_id === acc.id && r.oldValue === acc.name && r.newValue === `${acc.name} Audited`));
  assert.ok(rows.some((r) => r.model === 'account.tax' && r.res_id === tax.id && r.newValue === '15'));
  assert.ok(rows.some((r) => r.model === 'account.payment' && r.res_id === pay.id && r.newValue === 'Wire Updated'));
  assert.ok(rows.some((r) => r.model === 'account.move' && r.res_id === inv.id && r.newValue === '2026-04-20'));
});

test('audit trail covers create, edit and delete for all 4 financial models, all 5 lock dates, and rejects applyDiff edits/deletes', async () => {
  const { unlink, setAuthor } = await import('./orm.js');
  const { collectAuditTrailRows, LOCK_DATE_FIELDS } = await import('./models/auditTrail.js');
  const { applyDiff } = await import('./sync.js');
  setAuthor('Audit Completeness Tester');
  let db = seed();

  // 1. All five company lock dates on res.company.
  const lockUpdates = {
    lock_date: '2026-01-31',
    sale_lock_date: '2026-02-15',
    purchase_lock_date: '2026-02-20',
    tax_lock_date: '2026-02-28',
    hard_lock_date: '2026-03-01',
  };
  for (const field of LOCK_DATE_FIELDS) {
    db = write(db, 'res.company', 1, { [field]: lockUpdates[field] });
  }

  // 2. Create, edit and delete for account.account, account.tax, account.payment, account.move.
  const newAcc = create(db, 'account.account', { code: '999000', name: 'Temp Audit Account', account_type: 'expense' });
  db = write(newAcc.db, 'account.account', newAcc.id, { name: 'Temp Audit Account 2' });
  db = unlink(db, 'account.account', [newAcc.id]);

  const newTax = create(db, 'account.tax', { name: 'Temp Audit Tax', type_tax_use: 'sale', amount: 7 });
  db = write(newTax.db, 'account.tax', newTax.id, { amount: 9 });
  db = unlink(db, 'account.tax', [newTax.id]);

  const newPay = create(db, 'account.payment', { partner_id: 1, amount: 120, date: '2026-04-05' });
  db = write(newPay.db, 'account.payment', newPay.id, { memo: 'Payment Memo Changed' });
  db = unlink(db, 'account.payment', [newPay.id]);

  const newMove = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-04-06', invoice_date_due: '2026-04-16', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 50, tax: 0 }] });
  db = write(newMove.db, 'account.move', newMove.id, { invoice_date_due: '2026-04-25' });
  db = unlink(db, 'account.move', [newMove.id]);

  const rows = collectAuditTrailRows(db, db, { from: '2000-01-01', to: '2099-12-31' });
  for (const [label, val] of [
    ['Lock Date', '2026-01-31'],
    ['Sales Lock Date', '2026-02-15'],
    ['Purchase Lock Date', '2026-02-20'],
    ['Tax Return Lock Date', '2026-02-28'],
    ['Hard Lock Date', '2026-03-01'],
  ]) {
    assert.ok(rows.some((r) => r.model === 'res.company' && r.field === label && r.newValue === val), `Missing lock-date audit row for ${label}`);
  }

  for (const [model, id, editText] of [
    ['account.account', newAcc.id, 'Temp Audit Account 2'],
    ['account.tax', newTax.id, '9'],
    ['account.payment', newPay.id, 'Payment Memo Changed'],
    ['account.move', newMove.id, '2026-04-25'],
  ]) {
    assert.ok(rows.some((r) => r.model === model && r.res_id === id && /record created/i.test(r.body)), `Missing create audit row for ${model}`);
    assert.ok(rows.some((r) => r.model === model && r.res_id === id && r.body.includes(editText)), `Missing edit audit row for ${model}`);
    assert.ok(rows.some((r) => r.model === model && r.res_id === id && r.body === 'Record deleted'), `Missing delete audit row for ${model}`);
  }

  // 3. Audit rows (all 4 models + company lock dates) cannot be deleted or edited by a non-server client via applyDiff.
  const auditMsgIds = rows.map((r) => r.id);
  const sampleMsgs = db.messages.filter((m) => auditMsgIds.includes(m.id));
  const afterAttempt = applyDiff(db, {
    removedMessages: auditMsgIds,
    messages: sampleMsgs.slice(0, 3).map((m) => ({ ...m, body: 'Tampered body', author: 'Attacker' })),
  }, { isAdmin: false });
  for (const orig of sampleMsgs) {
    const preserved = afterAttempt.messages.find((m) => m.id === orig.id);
    assert.ok(preserved, `Audit message ${orig.model}:${orig.id} must not be deletable via applyDiff`);
    assert.equal(preserved.body, orig.body, `Audit message ${orig.model}:${orig.id} body must not be editable via applyDiff`);
  }
});

test('res.company audit trail uses structural m.field (not body labels), protects lock-date and legacy tracking messages, and validates field in cleanMessage', async () => {
  const { collectAuditTrailRows, isAuditTrackingMessage } = await import('./models/auditTrail.js');
  const { cleanMessage } = await import('./validate.js');
  const { applyDiff } = await import('./sync.js');

  let db = write(seed(), 'res.company', 1, { lock_date: '2026-05-31' });
  const lockMsg = db.messages.at(-1);
  assert.equal(lockMsg.field, 'lock_date');
  assert.equal(lockMsg.old_value, '—');
  assert.equal(lockMsg.new_value, '2026-05-31');
  assert.equal(isAuditTrackingMessage(lockMsg), true);

  // Non-lock res.company tracking message is NOT an audit row even if its body mimics a lock-date label.
  const nonLockMsg = {
    id: 'co-non-lock-1',
    model: 'res.company',
    res_id: 1,
    company_id: 1,
    kind: 'tracking',
    field: 'phone',
    old_value: '—',
    new_value: '+20 100 000 0000',
    body: 'Lock Date: — → 2026-01-31',
    author: 'Tester',
    date: new Date().toISOString(),
  };
  // Legacy res.company tracking message without `field` stays conservatively protected.
  const legacyCoMsg = {
    id: 'co-legacy-1',
    model: 'res.company',
    res_id: 1,
    company_id: 1,
    kind: 'tracking',
    body: 'Lock Date: — → 2025-12-31',
    author: 'Legacy',
    date: new Date().toISOString(),
  };
  assert.equal(isAuditTrackingMessage(nonLockMsg), false);
  assert.equal(isAuditTrackingMessage(legacyCoMsg), true);

  db = { ...db, messages: [...db.messages, nonLockMsg, legacyCoMsg] };
  const rows = collectAuditTrailRows(db, db, { from: '2000-01-01', to: '2099-12-31' });
  assert.ok(rows.some((r) => r.id === lockMsg.id && r.field === 'Lock Date' && r.oldValue === '—' && r.newValue === '2026-05-31'));
  assert.ok(!rows.some((r) => r.id === nonLockMsg.id), 'Non-lock res.company tracking message must not appear in audit rows');
  assert.ok(rows.some((r) => r.id === legacyCoMsg.id), 'Legacy res.company tracking message without field is retained conservatively');

  // Non-admin applyDiff can remove non-lock tracking message, but cannot remove lock-date or legacy tracking messages.
  const afterRemove = applyDiff(db, { removedMessages: [lockMsg.id, nonLockMsg.id, legacyCoMsg.id] }, { isAdmin: false });
  assert.ok(!afterRemove.messages.some((m) => m.id === nonLockMsg.id));
  assert.ok(afterRemove.messages.some((m) => m.id === lockMsg.id));
  assert.ok(afterRemove.messages.some((m) => m.id === legacyCoMsg.id));

  // cleanMessage accepts declared fields and drops unknown/undeclared field metadata.
  const validCleaned = cleanMessage(lockMsg);
  assert.equal(validCleaned.field, 'lock_date');
  assert.equal(validCleaned.old_value, '—');
  assert.equal(validCleaned.new_value, '2026-05-31');
  const forgedCleaned = cleanMessage({ ...nonLockMsg, field: 'not_a_real_field' });
  assert.equal(forgedCleaned.field, undefined);
  assert.equal(forgedCleaned.old_value, undefined);
  assert.equal(forgedCleaned.new_value, undefined);
});

test('audit trail paginates past 500 move events, exports ALL matching rows to CSV, and is read-only', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { initStore, commit } = await import('./store.js');
  const { Reports } = await import('./views/Reports.jsx');
  const { PAGE_SIZE } = await import('./views/paging.js');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (namespace, tag) => makeEl(tag);
  const downloaded = [];
  const origCreate = globalThis.document.createElement.bind(globalThis.document);
  globalThis.document.createElement = (tag) => {
    const el = origCreate(tag);
    if (tag === 'a') {
      el.click = () => {};
    }
    return el;
  };
  const origBlob = globalThis.Blob;
  globalThis.Blob = function MockBlob(parts, opts) {
    downloaded.push({ text: parts.join(''), type: opts?.type });
    return { parts, opts };
  };
  globalThis.URL.createObjectURL = () => 'blob:mock';
  globalThis.URL.revokeObjectURL = () => {};

  await initStore();
  const base = seed();
  const inv = create(base, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-04-02', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
  const nowMs = Date.now();
  const moveEvents = Array.from({ length: 520 }, (_, i) => ({
    id: `mv-evt-${i}`,
    model: 'account.move',
    res_id: inv.id,
    company_id: 1,
    kind: 'tracking',
    author: 'Auditor',
    date: new Date(nowMs - i * 1000).toISOString(),
    body: `Reference: r${i} → r${i + 1}`,
  }));
  const db = { ...inv.db, messages: moveEvents };
  commit(db);

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const textOf = (n) => (n?.nodeType === 3 ? n.nodeValue : (n?.childNodes ?? []).map(textOf).join(''));
  const props = (n) => n?.[Object.keys(n).find((k) => k.startsWith('__reactProps$'))];

  try {
    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf: { report: 'audit' } }));
    });
    const bodyText = textOf(host);
    assert.ok(bodyText.includes(`1-${PAGE_SIZE} / 520`), `Expected pager for 520 rows, got: ${bodyText.slice(0, 300)}`);
    assert.ok(bodyText.includes('Reference: r0 → r1'), 'First page shows newest event');
    assert.ok(!bodyText.includes('Reference: r519 → r520'), 'Oldest event is on last page, not page 1');

    // Navigate to last page beyond row 500.
    const nextBtn = find(host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Next page');
    assert.ok(nextBtn);
    const totalPages = Math.ceil(520 / PAGE_SIZE);
    for (let p = 1; p < totalPages; p += 1) {
      await React.act(async () => {
        props(find(host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Next page')).onClick();
      });
    }
    const lastPageText = textOf(host);
    assert.ok(lastPageText.includes('Reference: r519 → r520'), 'Paginating past 500 reaches row 520');

    // Read-only check: no Edit, Delete, or Import controls.
    assert.ok(!find(host, (n) => n.tagName === 'BUTTON' && /Delete|Edit|Import/i.test(textOf(n))), 'Audit trail has no edit/delete/import controls');

    // CSV export contains ALL 520 rows, not just the visible page.
    const csvBtn = find(host, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Download CSV');
    assert.ok(csvBtn);
    downloaded.length = 0;
    props(csvBtn).onClick();
    assert.equal(downloaded.length, 1);
    const exportedRows = fromCsv(downloaded[0].text);
    assert.equal(exportedRows.length, 521, 'Header + all 520 matching audit rows must be exported');
    assert.ok(downloaded[0].text.includes('r0'));
    assert.ok(downloaded[0].text.includes('r520'));
  } finally {
    await React.act(async () => root.unmount());
    globalThis.Blob = origBlob;
  }
});

test('invoice reminder uses server mail-transport hook: failure recorded on outbound message, outbox-only keeps unsent, working sends once', async () => {
  const { runFollowUps } = await import('./models/finance.js');
  const { partnerFollowUp } = await import('./models/finance.js');
  const { messagesOf } = await import('./orm.js');
  const { today, addDays } = await import('./models/common.js');
  const { createMailTransport } = await import('../server/mailTransport.js');

  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Reminder Customer', email: 'billing@example.com', customer_rank: 1 });
  db = partner.db;
  const at = today();
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: addDays(at, -20),
    invoice_date_due: addDays(at, -10),
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 300, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // Ensure an email-enabled follow-up level at delay <= 10 exists.
  const existingLevel = search(db, 'account.followup.level')[0];
  db = existingLevel
    ? write(db, 'account.followup.level', existingLevel.id, { delay: 5, send_email: true, create_activity: false })
    : create(db, 'account.followup.level', { name: 'Overdue Notice', delay: 5, send_email: true, create_activity: false }).db;

  // 1. Failing transport (rejected Error): error recorded on outbound message, reminder NOT marked sent.
  const afterThrow = await runFollowUps(db, at, async () => { throw new Error('SMTP 550 mailbox unavailable'); });
  const pAfterThrow = read(afterThrow, 'res.partner', partner.id);
  const progressThrow = partnerFollowUp(pAfterThrow, 1);
  assert.equal(progressThrow.followup_delivery_state, 'not_sent');
  assert.equal(progressThrow.followup_level_delay, null);
  const failMsg = messagesOf(afterThrow, 'res.partner', partner.id).find((m) => m.delivery_state === 'failed');
  assert.ok(failMsg, 'Failed transport records delivery_state=failed on outbound message');
  assert.ok(failMsg.delivery_error?.includes('SMTP 550 mailbox unavailable'));
  assert.ok(failMsg.body.includes('SMTP 550 mailbox unavailable'));

  // 2. Transport returning non-contract value is treated as failure and never marked sent.
  const afterErrObj = await runFollowUps(db, at, async () => ({ delivered: false, error: 'Relay denied' }));
  const failObjMsg = messagesOf(afterErrObj, 'res.partner', partner.id).find((m) => m.delivery_state === 'failed');
  assert.ok(failObjMsg, 'Non-contract object records delivery_state=failed');
  assert.ok(failObjMsg.delivery_error?.includes('invalid delivery result'));
  assert.equal(partnerFollowUp(read(afterErrObj, 'res.partner', partner.id), 1).followup_delivery_state, 'not_sent');

  // Even an unrecognized truthy object like { ok: true } without status:'sent' fails cleanly.
  const afterBadShape = await runFollowUps(db, at, async () => ({ ok: true }));
  assert.equal(partnerFollowUp(read(afterBadShape, 'res.partner', partner.id), 1).followup_delivery_state, 'not_sent');
  assert.ok(messagesOf(afterBadShape, 'res.partner', partner.id).some((m) => m.delivery_state === 'failed'));

  // 3. Unconfigured server transport is outbox-only no-op: does not touch network or mark sent.
  const unconfigured = createMailTransport({ env: {} });
  const directOutbox = await unconfigured({ to: 'billing@example.com', subject: 'Test', text: 'Hi' });
  assert.deepEqual(directOutbox, { status: 'outbox_only', reason: 'Outbox only: automatic email transport is not configured.' });
  const afterOutbox = await runFollowUps(afterThrow, at, unconfigured);
  const progressOutbox = partnerFollowUp(read(afterOutbox, 'res.partner', partner.id), 1);
  assert.equal(progressOutbox.followup_delivery_state, 'not_sent');
  assert.equal(progressOutbox.followup_level_delay, null);
  assert.ok(messagesOf(afterOutbox, 'res.partner', partner.id).some((m) => m.delivery_state === 'outbox_only'));

  // 4. Configured mock transport succeeds once for this customer and subsequent run is a no-op.
  const deliveries = [];
  const workingTransport = createMailTransport({
    smtp: { host: 'smtp.mock', port: 587, from: 'noreply@example.com' },
    send: async (_cfg, message) => { deliveries.push(message); },
  });
  const afterSent = await runFollowUps(afterOutbox, at, workingTransport);
  const forPartnerAfterSent = deliveries.filter((m) => m.to === 'billing@example.com');
  assert.equal(forPartnerAfterSent.length, 1);
  const sentCountBeforeReplay = deliveries.length;
  const progressSent = partnerFollowUp(read(afterSent, 'res.partner', partner.id), 1);
  assert.equal(progressSent.followup_delivery_state, 'sent');
  assert.ok(progressSent.followup_level_delay != null);
  assert.ok(messagesOf(afterSent, 'res.partner', partner.id).some((m) => m.delivery_state === 'sent'));

  const afterReplay = await runFollowUps(afterSent, at, workingTransport);
  assert.equal(deliveries.length, sentCountBeforeReplay, 'Already-sent follow-up must not send a second email');
  assert.equal(afterReplay, afterSent);
});

test('payment.provider checkout returns deterministic demo redirectUrl for posted unpaid invoice and rejects invalid targets', async () => {
  const { createInvoiceCheckout } = await import('./models/paymentAdapter.js');

  let db = seed();
  const demo = search(db, 'payment.provider').find((p) => p.code === 'demo');
  assert.ok(demo, 'Seed includes demo provider');
  const draftInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-10',
    invoice_line_ids: [{ product_id: 5, qty: 2, price_unit: 150, tax: 0 }],
  });
  db = draftInv.db;
  // Draft invoice rejected before provider checks.
  assert.throws(() => createInvoiceCheckout(db, draftInv.id, demo.id), /posted/i);

  // Posted invoice with demo still disabled -> checkout rejects disabled provider.
  db = postMove(db, draftInv.id);
  assert.throws(() => createInvoiceCheckout(db, draftInv.id, demo.id), /enabled/i);

  db = write(db, 'payment.provider', demo.id, { state: 'enabled' });
  const res = createInvoiceCheckout(db, draftInv.id, demo.id, {
    baseUrl: 'https://portal.example',
    returnUrl: '/my/invoices/1?access_token=tok',
    reference: 'DEMO-REF-100',
  });
  assert.equal(res.transaction.reference, 'DEMO-REF-100');
  assert.equal(res.transaction.state, 'pending');
  assert.equal(res.transaction.company_id, 1);
  assert.equal(
    res.redirectUrl,
    'https://portal.example/my/invoices/' + draftInv.id + '/pay/demo?reference=DEMO-REF-100&amount=300&currency=USD&return_url=%2Fmy%2Finvoices%2F1%3Faccess_token%3Dtok',
  );
  const storedTx = search(res.db, 'payment.transaction').find((t) => t.id === res.transaction.id);
  assert.ok(storedTx);
  assert.equal(storedTx.redirect_url, res.redirectUrl);
});

test('payment webhook registers payment once on valid signature, replays idempotently, and rejects bad requests without mutation', async () => {
  const { createInvoiceCheckout, processPaymentWebhook, signWebhookPayload } = await import('./models/paymentAdapter.js');
  const { residual } = await import('./models/accounting.js');

  let db = seed();
  const demo = search(db, 'payment.provider').find((p) => p.code === 'demo');
  db = write(db, 'payment.provider', demo.id, { state: 'enabled' });

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-10',
    invoice_line_ids: [{ product_id: 5, qty: 2, price_unit: 125, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  const checkout = createInvoiceCheckout(db, inv.id, demo.id, { reference: 'TXN-250-OK' });
  db = checkout.db;

  const secret = 'test-webhook-secret-not-hardcoded-in-src';
  const goodPayload = {
    reference: 'TXN-250-OK',
    provider_reference: 'DEMO-GW-001',
    amount: 250,
    currency: 'USD',
    status: 'paid',
    date: '2026-04-11',
  };
  const goodBody = JSON.stringify(goodPayload);
  const goodSig = signWebhookPayload(goodBody, secret);

  // Missing secret rejected without mutating db.
  assert.throws(() => processPaymentWebhook(db, { providerCode: 'demo', rawBody: goodBody, signature: goodSig, secret: '' }), /secret/i);

  // Invalid signature (wrong secret, tampered payload, wrong length) rejected without mutating db.
  assert.throws(() => processPaymentWebhook(db, { providerCode: 'demo', rawBody: goodBody, signature: 'bad-len', secret }), /signature/i);
  assert.throws(() => processPaymentWebhook(db, { providerCode: 'demo', rawBody: goodBody, signature: signWebhookPayload(goodBody, 'wrong-secret'), secret }), /signature/i);
  assert.throws(() => processPaymentWebhook(db, { providerCode: 'demo', rawBody: goodBody.replace('250', '251'), signature: goodSig, secret }), /signature/i);

  // Unknown reference rejected without mutating db.
  const unknownBody = JSON.stringify({ ...goodPayload, reference: 'UNKNOWN-999' });
  assert.throws(() => processPaymentWebhook(db, { providerCode: 'demo', rawBody: unknownBody, signature: signWebhookPayload(unknownBody, secret), secret }), /unknown/i);

  // Wrong amount rejected without mutating db.
  const wrongAmtBody = JSON.stringify({ ...goodPayload, amount: 249.99 });
  assert.throws(() => processPaymentWebhook(db, { providerCode: 'demo', rawBody: wrongAmtBody, signature: signWebhookPayload(wrongAmtBody, secret), secret }), /amount/i);

  // Wrong currency rejected without mutating db.
  const wrongCurBody = JSON.stringify({ ...goodPayload, currency: 'EUR' });
  assert.throws(() => processPaymentWebhook(db, { providerCode: 'demo', rawBody: wrongCurBody, signature: signWebhookPayload(wrongCurBody, secret), secret }), /currency/i);

  // Ensure invoice is still completely unpaid after all rejected attempts.
  assert.equal(residual(read(db, 'account.move', inv.id), db), 250);
  assert.equal(read(db, 'payment.transaction', checkout.transaction.id).state, 'pending');

  // Valid webhook call registers payment ONCE.
  const settled = processPaymentWebhook(db, { providerCode: 'demo', rawBody: goodBody, signature: goodSig, secret });
  assert.equal(settled.alreadyProcessed, false);
  const paidMove = read(settled.db, 'account.move', inv.id);
  assert.equal(paidMove.payment_state, 'paid');
  assert.equal(residual(paidMove, settled.db), 0);
  assert.equal((paidMove.payments ?? []).length, 1);
  const settledTx = read(settled.db, 'payment.transaction', checkout.transaction.id);
  assert.equal(settledTx.state, 'done');
  assert.ok(settledTx.payment_id, 'processPaymentWebhook must link payment_id to the posted payment');
  const linkedPayment = read(settled.db, 'account.payment', settledTx.payment_id);
  assert.equal(linkedPayment?.state, 'posted');
  assert.equal(linkedPayment?.company_id ?? 1, settledTx.company_id ?? 1);

  // Replay of exact same signed webhook is an idempotent no-op.
  const replayed = processPaymentWebhook(settled.db, { providerCode: 'demo', rawBody: goodBody, signature: goodSig, secret });
  assert.equal(replayed.alreadyProcessed, true);
  assert.equal(replayed.db, settled.db);
  assert.equal((read(replayed.db, 'account.move', inv.id).payments ?? []).length, 1);

  // Already-paid invoice for a second pending transaction is rejected without double-paying.
  const paidInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 80, tax: 0 }],
  });
  let dbPaid = postMove(paidInv.db, paidInv.id);
  const txPaid = createInvoiceCheckout(dbPaid, paidInv.id, demo.id, { reference: 'TXN-ALREADY-PAID' });
  dbPaid = txPaid.db;
  const { registerPayment } = await import('./models/accounting.js');
  const bankJournal = search(dbPaid, 'account.journal').find((j) => j.default_for_payments === true && (j.company_id ?? 1) === 1);
  dbPaid = registerPayment(dbPaid, read(dbPaid, 'account.move', paidInv.id), { amount: 80, date: '2026-04-11', journal_id: bankJournal.id }).db;
  const paidAgainBody = JSON.stringify({ reference: 'TXN-ALREADY-PAID', amount: 80, currency: 'USD', status: 'paid', date: '2026-04-11' });
  assert.throws(() => processPaymentWebhook(dbPaid, { providerCode: 'demo', rawBody: paidAgainBody, signature: signWebhookPayload(paidAgainBody, secret), secret }), /already paid/i);
});

test('server portal invoice checkout redirects to demo provider and server webhook endpoint rejects/settles safely', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { createPortal } = await import('../server/portal.js');
  const { handlePaymentWebhook } = await import('../server/paymentWebhook.js');
  const { signWebhookPayload } = await import('./models/paymentAdapter.js');
  const { checkConfig } = await import('../server/config.js');
  const { residual } = await import('./models/accounting.js');

  assert.deepEqual(checkConfig({ MIZAN_PAYMENT_WEBHOOK_SECRET: 's3cr3t' }), []);

  const sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)');
  let db = seed();
  const demo = search(db, 'payment.provider').find((p) => p.code === 'demo');
  db = write(db, 'payment.provider', demo.id, { state: 'enabled' });
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 90, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  const portal = createPortal({
    sql,
    getDb: () => db,
    commitDb: (next) => { db = next; },
    sessionUser: () => null,
    allowedFor: () => null,
    clientIp: () => '127.0.0.1',
    tooMany: () => false,
    recordFailure: () => {},
    readRaw: async (req) => Buffer.from(req._rawBody ?? ''),
    securityHeaders: {},
    env: { MIZAN_DEMO_PAYMENTS: '1', NODE_ENV: 'test', MIZAN_PUBLIC_URL: 'https://erp.example' },
  });

  const portalLink = portal.portalUrl('account.move', read(db, 'account.move', inv.id));
  const token = new URL(portalLink, 'https://erp.example').searchParams.get('access_token');

  // GET invoice portal page displays Pay online form.
  const makeRes = () => {
    const out = { status: 0, headers: {}, body: '' };
    return {
      out,
      writeHead(s, h) { out.status = s; out.headers = h; },
      end(b) { out.body = b ?? ''; },
    };
  };
  const getRes = makeRes();
  await portal.handle({ method: 'GET', url: portalLink, headers: { host: 'erp.example' } }, getRes);
  assert.equal(getRes.out.status, 200);
  assert.ok(getRes.out.body.includes('/pay"'));

  // POST /my/invoices/:id/pay redirects to provider checkout URL and records pending transaction.
  const postRes = makeRes();
  await portal.handle({
    method: 'POST',
    url: `/my/invoices/${inv.id}/pay`,
    headers: { host: 'erp.example', 'content-type': 'application/x-www-form-urlencoded' },
    _rawBody: new URLSearchParams({ access_token: token, provider_id: String(demo.id) }).toString(),
  }, postRes);
  assert.equal(postRes.out.status, 303);
  assert.ok(postRes.out.headers.Location.includes(`/my/invoices/${inv.id}/pay/demo`));
  const ref = new URL(postRes.out.headers.Location, 'https://erp.example').searchParams.get('reference');
  assert.ok(ref);

  // Webhook endpoint rejects invalid signature (401) and pays once on valid signature (200).
  const secret = 'test-env-webhook-secret';
  const logs = [];
  const rawBody = JSON.stringify({ reference: ref, amount: 90, currency: 'USD', status: 'paid', date: '2026-04-12' });
  const badRes = makeRes();
  await handlePaymentWebhook({
    req: { method: 'POST', url: '/api/payment/webhook/demo', headers: { 'x-mizan-signature': 'invalid' }, _rawBody: rawBody },
    res: badRes,
    providerCode: 'demo',
    getDb: () => db,
    commitDb: (next) => { db = next; },
    readRaw: async (req) => Buffer.from(req._rawBody),
    env: { MIZAN_PAYMENT_WEBHOOK_SECRET: secret },
    log: (...args) => logs.push(args),
  });
  assert.equal(badRes.out.status, 401);
  assert.equal(residual(read(db, 'account.move', inv.id), db), 90);
  assert.ok(!JSON.stringify(logs).includes(secret), 'Secret must never appear in logs');

  const okRes = makeRes();
  await handlePaymentWebhook({
    req: { method: 'POST', url: '/api/payment/webhook/demo', headers: { 'x-mizan-signature': signWebhookPayload(rawBody, secret) }, _rawBody: rawBody },
    res: okRes,
    providerCode: 'demo',
    getDb: () => db,
    commitDb: (next) => { db = next; },
    readRaw: async (req) => Buffer.from(req._rawBody),
    env: { MIZAN_PAYMENT_WEBHOOK_SECRET: secret },
    log: (...args) => logs.push(args),
  });
  assert.equal(okRes.out.status, 200);
  assert.equal(read(db, 'account.move', inv.id).payment_state, 'paid');
  assert.ok(!JSON.stringify(logs).includes(secret), 'Secret must never appear in logs');
});

test('payment.transaction is protected, company-scoped, shares provider options, and rejects forged applyDiff mutations', async () => {
  const { models, writableModelsForApps } = await import('./models/index.js');
  const { visibleTo } = await import('./models/company.js');
  const { PAYMENT_PROVIDERS } = await import('./models/ecommerce.js');
  const { applyDiff } = await import('./sync.js');
  const { createInvoiceCheckout, processPaymentWebhook, signWebhookPayload } = await import('./models/paymentAdapter.js');

  assert.strictEqual(models['payment.provider'].fields.code.options, PAYMENT_PROVIDERS);
  assert.strictEqual(models['payment.transaction'].fields.provider_code.options, PAYMENT_PROVIDERS);
  assert.strictEqual(models['sale.order'].fields.payment_provider.options, PAYMENT_PROVIDERS);

  assert.ok(!writableModelsForApps(['ecommerce']).has('payment.transaction'));
  assert.ok(writableModelsForApps(['accounting']).has('payment.transaction'));

  let db = seed();
  const demo = search(db, 'payment.provider').find((p) => p.code === 'demo');
  db = write(db, 'payment.provider', demo.id, { state: 'enabled' });
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  const draft = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 50, tax: 0 }],
  });
  db = draft.db;

  const usd = db.records['res.currency'].find((c) => c.name === 'USD');
  const checkout = createInvoiceCheckout(db, inv.id, demo.id, { reference: 'TX-GUARD-1' });
  db = checkout.db;
  const tx = checkout.transaction;
  assert.equal(visibleTo(new Set([2]), 'payment.transaction', tx, db), false);
  assert.equal(visibleTo(new Set([1]), 'payment.transaction', tx, db), true);

  // Forged create by non-accounting app refused.
  assert.throws(() => applyDiff(db, {
    upserts: { 'payment.transaction': [{ id: 901, reference: 'FORGE-1', move_id: inv.id, provider_id: demo.id, provider_code: 'demo', amount: 100, currency_id: usd.id, state: 'pending', company_id: 1 }] },
  }, { allowed: writableModelsForApps(['ecommerce']) }), /No access to payment\.transaction/);

  // Forged create directly in 'done' state or duplicate reference or draft move rejected.
  const acctOpts = { allowed: writableModelsForApps(['accounting']) };
  assert.throws(() => applyDiff(db, {
    upserts: { 'payment.transaction': [{ id: 902, reference: 'FORGE-DONE', move_id: inv.id, provider_id: demo.id, provider_code: 'demo', amount: 100, currency_id: usd.id, state: 'done', company_id: 1 }] },
  }, acctOpts), /Pending/i);
  assert.throws(() => applyDiff(db, {
    upserts: { 'payment.transaction': [{ id: 903, reference: 'TX-GUARD-1', move_id: inv.id, provider_id: demo.id, provider_code: 'demo', amount: 100, currency_id: usd.id, state: 'pending', company_id: 1 }] },
  }, acctOpts), /unique/i);
  assert.throws(() => applyDiff(db, {
    upserts: { 'payment.transaction': [{ id: 904, reference: 'FORGE-DRAFT', move_id: draft.id, provider_id: demo.id, provider_code: 'demo', amount: 50, currency_id: usd.id, state: 'pending', company_id: 1 }] },
  }, acctOpts), /posted customer invoice/i);

  // Forged edit of immutable fields or done without payment_id rejected.
  assert.throws(() => applyDiff(db, {
    upserts: { 'payment.transaction': [{ ...tx, amount: 999 }] },
    bases: { 'payment.transaction': { [tx.id]: { amount: tx.amount } } },
  }, acctOpts), /modified after creation/i);
  assert.throws(() => applyDiff(db, {
    upserts: { 'payment.transaction': [{ ...tx, state: 'done' }] },
    bases: { 'payment.transaction': { [tx.id]: { state: 'pending' } } },
  }, acctOpts), /posted payment/i);

  // Settle cleanly via webhook -> done with payment_id -> cannot transition back or be deleted.
  const secret = 'guard-secret';
  const rawBody = JSON.stringify({ reference: 'TX-GUARD-1', amount: 100, currency: 'USD', status: 'paid' });
  const settled = processPaymentWebhook(db, { providerCode: 'demo', rawBody, signature: signWebhookPayload(rawBody, secret), secret });
  const doneTx = settled.transaction;
  assert.ok(doneTx.payment_id);
  assert.throws(() => applyDiff(settled.db, {
    upserts: { 'payment.transaction': [{ ...doneTx, state: 'pending' }] },
    bases: { 'payment.transaction': { [doneTx.id]: { state: 'done' } } },
  }, acctOpts), /transition/i);
  assert.throws(() => applyDiff(settled.db, { deletes: { 'payment.transaction': [doneTx.id] } }, acctOpts), /cannot be deleted/i);
});

test('webhook contract requires rawBody, strict demo parseWebhook status, explicit statuses, 404 unknown provider before body, and failure-only rate limit', async () => {
  const { createInvoiceCheckout, PAYMENT_ADAPTERS, processPaymentWebhook, signWebhookPayload, WebhookError } = await import('./models/paymentAdapter.js');
  const { handlePaymentWebhook } = await import('../server/paymentWebhook.js');

  let db = seed();
  const demo = search(db, 'payment.provider').find((p) => p.code === 'demo');
  db = write(db, 'payment.provider', demo.id, { state: 'enabled' });
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 75, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  db = createInvoiceCheckout(db, inv.id, demo.id, { reference: 'TX-CONTRACT-1' }).db;
  const secret = 'contract-secret';

  // Reject object payload without rawBody string.
  assert.throws(
    () => processPaymentWebhook(db, { providerCode: 'demo', payload: { reference: 'TX-CONTRACT-1', status: 'paid', amount: 75, currency: 'USD' }, signature: 'x', secret }),
    (e) => e instanceof WebhookError && e.status === 400 && e.code === 'RAW_BODY_REQUIRED',
  );

  // Adapter parseWebhook rejects missing status and guessed synonyms.
  assert.deepEqual(
    PAYMENT_ADAPTERS.demo.parseWebhook({ reference: 'TX-CONTRACT-1', status: 'paid', amount: 75, currency: 'usd', provider_reference: 'GW-1', date: '2026-04-12' }),
    { reference: 'TX-CONTRACT-1', paid: true, amount: 75, currency: 'USD', providerReference: 'GW-1', date: '2026-04-12' },
  );
  for (const badStatus of [undefined, '', 'succeeded', 'complete', 'completed', 'unknown']) {
    const raw = JSON.stringify({ reference: 'TX-CONTRACT-1', ...(badStatus !== undefined ? { status: badStatus } : {}), amount: 75, currency: 'USD' });
    assert.throws(
      () => processPaymentWebhook(db, { providerCode: 'demo', rawBody: raw, signature: signWebhookPayload(raw, secret), secret }),
      (e) => e instanceof WebhookError && e.status === 400 && e.code === 'UNSUPPORTED_STATUS',
    );
  }

  const makeRes = () => {
    const out = { status: 0, headers: {}, body: '' };
    return { out, writeHead(s, h) { out.status = s; out.headers = h; }, end(b) { out.body = b ?? ''; } };
  };

  // Unknown provider returns 404 BEFORE reading body and increments rejections.
  let bodyReadCount = 0;
  let rejections = 0;
  const unknownRes = makeRes();
  await handlePaymentWebhook({
    req: { method: 'POST', headers: {} },
    res: unknownRes,
    providerCode: 'unknown_gw',
    getDb: () => db,
    commitDb: (next) => { db = next; },
    readRaw: async () => { bodyReadCount++; return Buffer.from('{}'); },
    env: {},
    onRejected: () => { rejections++; },
  });
  assert.equal(unknownRes.out.status, 404);
  assert.equal(bodyReadCount, 0);
  assert.equal(rejections, 1);

  // Non-size readRaw error returns 400 while too-large returns 413.
  const readErrRes = makeRes();
  await handlePaymentWebhook({
    req: { method: 'POST', headers: {} },
    res: readErrRes,
    providerCode: 'demo',
    getDb: () => db,
    commitDb: (next) => { db = next; },
    readRaw: async () => { throw new Error('Socket reset'); },
    env: { MIZAN_PAYMENT_WEBHOOK_SECRET: secret },
    onRejected: () => { rejections++; },
  });
  assert.equal(readErrRes.out.status, 400);
  assert.equal(rejections, 2);

  const tooBigRes = makeRes();
  await handlePaymentWebhook({
    req: { method: 'POST', headers: {} },
    res: tooBigRes,
    providerCode: 'demo',
    getDb: () => db,
    commitDb: (next) => { db = next; },
    readRaw: async () => { throw new Error('Request too large'); },
    env: { MIZAN_PAYMENT_WEBHOOK_SECRET: secret },
    onRejected: () => { rejections++; },
  });
  assert.equal(tooBigRes.out.status, 413);
  assert.equal(rejections, 3);

  // Successful webhook does NOT call onRejected.
  const goodRaw = JSON.stringify({ reference: 'TX-CONTRACT-1', amount: 75, currency: 'USD', status: 'paid' });
  const okRes = makeRes();
  await handlePaymentWebhook({
    req: { method: 'POST', headers: { 'x-mizan-signature': signWebhookPayload(goodRaw, secret) } },
    res: okRes,
    providerCode: 'demo',
    getDb: () => db,
    commitDb: (next) => { db = next; },
    readRaw: async () => Buffer.from(goodRaw),
    env: { MIZAN_PAYMENT_WEBHOOK_SECRET: secret },
    onRejected: () => { rejections++; },
  });
  assert.equal(okRes.out.status, 200);
  assert.equal(rejections, 3);
});

test('portal demo checkout landing requires valid access token and demoPaymentsAllowed, and POST rejects unoffered providers', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { createPortal } = await import('../server/portal.js');

  const sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)');
  let db = seed();
  const demo = search(db, 'payment.provider').find((p) => p.code === 'demo');
  const wire = search(db, 'payment.provider').find((p) => p.code === 'wire');
  db = write(db, 'payment.provider', demo.id, { state: 'enabled' });
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 90, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  let env = { MIZAN_DEMO_PAYMENTS: '1', NODE_ENV: 'test', MIZAN_PUBLIC_URL: 'https://erp.example' };
  const portal = createPortal({
    sql,
    getDb: () => db,
    commitDb: (next) => { db = next; },
    sessionUser: () => null,
    allowedFor: () => null,
    clientIp: () => '127.0.0.1',
    tooMany: () => false,
    recordFailure: () => {},
    readRaw: async (req) => Buffer.from(req._rawBody ?? ''),
    securityHeaders: {},
    env,
  });

  const link = portal.portalUrl('account.move', read(db, 'account.move', inv.id));
  const token = new URL(link, 'https://erp.example').searchParams.get('access_token');
  const makeRes = () => {
    const out = { status: 0, headers: {}, body: '' };
    return { out, writeHead(s, h) { out.status = s; out.headers = h; }, end(b) { out.body = b ?? ''; } };
  };

  // Start valid checkout first so a pending tx exists.
  const payRes = makeRes();
  await portal.handle({
    method: 'POST',
    url: `/my/invoices/${inv.id}/pay`,
    headers: { host: 'erp.example', 'content-type': 'application/x-www-form-urlencoded' },
    _rawBody: new URLSearchParams({ access_token: token, provider_id: String(demo.id) }).toString(),
  }, payRes);
  assert.equal(payRes.out.status, 303);
  const landingUrl = payRes.out.headers.Location;
  const ref = new URL(landingUrl, 'https://erp.example').searchParams.get('reference');
  assert.equal(search(db, 'payment.transaction').length, 1);

  // Unauthenticated and wrong-token requests to demo landing page are rejected with 404.
  for (const badUrl of [
    `/my/invoices/${inv.id}/pay/demo?reference=${encodeURIComponent(ref)}`,
    `/my/invoices/${inv.id}/pay/demo?reference=${encodeURIComponent(ref)}&access_token=wrongtoken`,
  ]) {
    const r = makeRes();
    await portal.handle({ method: 'GET', url: badUrl, headers: { host: 'erp.example' } }, r);
    assert.equal(r.out.status, 404);
  }

  // Valid token works when demoPaymentsAllowed(env) is true.
  const okLanding = makeRes();
  await portal.handle({ method: 'GET', url: landingUrl, headers: { host: 'erp.example' } }, okLanding);
  assert.equal(okLanding.out.status, 200);
  assert.ok(okLanding.out.body.includes(ref));

  // Unoffered / disabled / non-integer provider on POST creates no transaction.
  const disabledRes = makeRes();
  await portal.handle({
    method: 'POST',
    url: `/my/invoices/${inv.id}/pay`,
    headers: { host: 'erp.example', 'content-type': 'application/x-www-form-urlencoded' },
    _rawBody: new URLSearchParams({ access_token: token, provider_id: String(wire.id) }).toString(),
  }, disabledRes);
  assert.equal(disabledRes.out.status, 303);
  assert.ok(disabledRes.out.headers.Location.includes('message='));
  assert.equal(search(db, 'payment.transaction').length, 1);

  const nonIntRes = makeRes();
  await portal.handle({
    method: 'POST',
    url: `/my/invoices/${inv.id}/pay`,
    headers: { host: 'erp.example', 'content-type': 'application/x-www-form-urlencoded' },
    _rawBody: new URLSearchParams({ access_token: token, provider_id: `${demo.id}.5` }).toString(),
  }, nonIntRes);
  assert.equal(nonIntRes.out.status, 303);
  assert.ok(nonIntRes.out.headers.Location.includes('message='));
  assert.equal(search(db, 'payment.transaction').length, 1);

  // When demoPaymentsAllowed becomes false, both landing page and POST reject demo.
  env.NODE_ENV = 'production';
  env.MIZAN_DEMO_PAYMENTS = '0';
  const prodLanding = makeRes();
  await portal.handle({ method: 'GET', url: landingUrl, headers: { host: 'erp.example' } }, prodLanding);
  assert.equal(prodLanding.out.status, 404);
  const prodPost = makeRes();
  await portal.handle({
    method: 'POST',
    url: `/my/invoices/${inv.id}/pay`,
    headers: { host: 'erp.example', 'content-type': 'application/x-www-form-urlencoded' },
    _rawBody: new URLSearchParams({ access_token: token, provider_id: String(demo.id) }).toString(),
  }, prodPost);
  assert.equal(prodPost.out.status, 303);
  assert.ok(prodPost.out.headers.Location.includes('message='));
  assert.equal(search(db, 'payment.transaction').length, 1);
});

test('all new PKG-10 labels, options, buttons and error strings have non-identical Arabic translations', async () => {
  const { models } = await import('./models/index.js');
  const { TAX_RETURN_TEMPLATES } = await import('./models/taxTemplates.js');
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => 'ar', setItem: () => {} };
  try {
    const { t } = await import(`./i18n.js?loc10_ar=${Date.now()}`);
    const strings = new Set([
      'Audit Trail', 'Export CSV', 'Export XML', 'Summary', 'Author', 'Record', 'Model', 'Field', 'Old Value', 'New Value', 'Date',
      'Page {page} of {pages}', 'Showing {from}-{to} of {total}', 'Created', 'Deleted', 'Record deleted', 'Pay online',
      'Outbox only: automatic email transport is not configured.', 'Mail transport returned an invalid delivery result',
      'Selected payment provider is not available',
      'Payment transaction reference is required',
      'Payment transaction reference must be unique',
      'Payment transaction details cannot be modified after creation',
      'Payment transaction invoice must be a posted customer invoice of the same company',
      'Payment transaction provider does not match the selected provider or company',
      'New payment transactions must start in Pending state',
      'Invalid payment transaction status transition',
      'Completed payment transactions require a posted payment of the same company',
      'Completed payment transactions cannot be deleted',
      'Unknown payment provider',
      'Webhook raw body string is required',
      'Malformed JSON payment webhook payload',
      'Payment webhook payload must be a JSON object',
      'Payment provider mismatch for transaction',
      'Payment transaction is not awaiting settlement',
      'Unsupported payment status in webhook',
      'Invoice not found for payment transaction',
      'Invoice is not in a payable posted state',
      'Failed to record posted payment for transaction',
      'Payment webhook secret is not configured',
      'Invoice must be posted before creating a payment checkout',
      'Selected payment provider is not enabled',
      'Selected payment provider does not support online checkout redirects',
      'Invalid payment webhook signature',
      'Unknown payment transaction reference',
      'Payment currency does not match the invoice currency',
      'Payment amount does not match the invoice amount due',
      'Invoice is already paid',
      'Invoice not found',
      'Online payment checkout is only supported for customer invoices',
      'Payment provider not found',
      'Payment provider belongs to another company',
      'Configure a currency on the invoice before starting online payment',
      'Payment transaction reference already exists',
    ]);
    for (const modelName of ['payment.provider', 'payment.transaction']) {
      const m = models[modelName];
      if (m.label) strings.add(m.label);
      for (const f of Object.values(m.fields ?? {})) {
        if (f.label) strings.add(f.label);
        for (const o of f.options ?? []) if (o[1]) strings.add(o[1]);
      }
      for (const b of m.form?.buttons ?? []) if (b.label) strings.add(b.label);
      for (const tab of m.form?.tabs ?? []) if (tab.label) strings.add(tab.label);
    }
    const taxTplField = models['res.company'].fields.tax_return_template;
    if (taxTplField?.label) strings.add(taxTplField.label);
    for (const o of taxTplField?.options ?? []) if (o[1]) strings.add(o[1]);
    for (const tpl of Object.values(TAX_RETURN_TEMPLATES)) if (tpl.label) strings.add(tpl.label);
    if (models['account.followup.level'].fields.email_body?.label) strings.add(models['account.followup.level'].fields.email_body.label);
    for (const s of strings) {
      const translated = t(s);
      assert.notEqual(translated, s, `Missing Arabic translation in src/i18n.js for: ${s}`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});



