import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { models } from './models/index.js';
import { create, read, search, write, applyFilters } from './orm.js';
import { seed } from './seed.js';
import { postMove, salesInvoiceView, purchaseInvoiceView } from './models/accounting.js';
import { duplicateValues } from './duplicate.js';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const allFind = (node, pred, acc = []) => {
  if (!node) return acc;
  if (pred(node)) acc.push(node);
  for (const child of node.childNodes ?? []) allFind(child, pred, acc);
  return acc;
};

test('SND-1: Send button replaces Send by Email and defines wizard with Email and Download checkboxes', () => {
  let db = seed();
  const buttons = models['account.move'].form.buttons;

  // Send by Email button is replaced
  const oldBtn = buttons.find((b) => b.label === 'Send by Email');
  assert.equal(oldBtn, undefined, 'Send by Email button must be replaced');

  const sendBtn = buttons.find((b) => b.label === 'Send');
  assert.ok(sendBtn, 'Send button must be defined');
  assert.equal(sendBtn.email, 'document', 'Send button must retain email: document');

  // Partner with email
  const partnerWithEmail = create(db, 'res.partner', { name: 'Customer With Email', email: 'cust@example.com' });
  db = partnerWithEmail.db;

  // Partner without email
  const partnerNoEmail = create(db, 'res.partner', { name: 'Customer No Email', email: '' });
  db = partnerNoEmail.db;

  // Customer invoice with email
  const invWithEmail = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partnerWithEmail.id,
    invoice_date: '2026-05-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100 }],
  });
  db = postMove(invWithEmail.db, invWithEmail.id);
  const postedWithEmail = read(db, 'account.move', invWithEmail.id);

  // Customer invoice without email
  const invNoEmail = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partnerNoEmail.id,
    invoice_date: '2026-05-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100 }],
  });
  db = postMove(invNoEmail.db, invNoEmail.id);
  const postedNoEmail = read(db, 'account.move', invNoEmail.id);

  // Wizard fields for partner with email
  const specWithEmail = sendBtn.wizard(db, postedWithEmail);
  assert.equal(specWithEmail.title, 'Send');
  const emailField1 = specWithEmail.fields.find((f) => f.name === 'email');
  const dlField1 = specWithEmail.fields.find((f) => f.name === 'download');
  assert.ok(emailField1, 'Email field must be present in wizard');
  assert.equal(emailField1.type, 'boolean');
  assert.equal(emailField1.default, true, 'Email checkbox defaults to true when partner has email');
  assert.ok(dlField1, 'Download field must be present in wizard');
  assert.equal(dlField1.type, 'boolean');
  assert.equal(dlField1.default, false, 'Download checkbox defaults to false');

  // Wizard fields for partner without email
  const specNoEmail = sendBtn.wizard(db, postedNoEmail);
  const emailField2 = specNoEmail.fields.find((f) => f.name === 'email');
  assert.equal(emailField2.default, false, 'Email checkbox defaults to false when partner has no email');

  // Primary while not sent, secondary after
  assert.equal(typeof sendBtn.primary, 'function', 'Send button primary must be dynamic');
  assert.equal(sendBtn.primary(postedWithEmail), true, 'Primary before invoice is sent');
  const sentMove = { ...postedWithEmail, is_move_sent: true };
  assert.equal(sendBtn.primary(sentMove), false, 'Secondary after invoice is sent');

  // Confirming with download: opens print route and sets is_move_sent
  const resDl = sendBtn.run(db, postedWithEmail, { email: false, download: true });
  assert.equal(read(resDl.db, 'account.move', postedWithEmail.id).is_move_sent, true);
  assert.equal(resDl.go, `#/print/account.move/${postedWithEmail.id}`);

  // Email only without the server sends nothing, so the invoice is not marked sent
  const resEmail = sendBtn.run(db, postedWithEmail, { email: true, download: false });
  assert.equal(read(resEmail.db, 'account.move', postedWithEmail.id).is_move_sent ?? false, false);
  assert.equal(resEmail.go, undefined);

  // Confirming with both: sets is_move_sent and opens print route
  const resBoth = sendBtn.run(db, postedWithEmail, { email: true, download: true });
  assert.equal(read(resBoth.db, 'account.move', postedWithEmail.id).is_move_sent, true);
  assert.equal(resBoth.go, `#/print/account.move/${postedWithEmail.id}`);
});

test('SND-1: FormView integration reuses existing document email path on Send confirmation', async () => {
  const prevStorage = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
  setupDom();
  const origCreate = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const el = origCreate(tag);
    el.ownerDocument = globalThis.document;
    el.insertBefore = (child, before) => {
      const idx = before ? el.childNodes.indexOf(before) : -1;
      if (idx >= 0) el.childNodes.splice(idx, 0, child);
      else el.childNodes.push(child);
      child.parentNode = el;
      if (child.tagName === 'OPTION') el.options.push(child);
      return child;
    };
    return el;
  };
  globalThis.document.createElementNS = (_, tag) => globalThis.document.createElement(tag);

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { FormView } = await import('./views/FormView.jsx');
  const { initStore, commit, getDb } = await import('./store.js');
  await initStore();

  let db = getDb();
  const partner = create(db, 'res.partner', { name: 'FormView Cust', email: 'fv@example.com' });
  db = partner.db;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-05-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100 }],
  });
  db = postMove(inv.db, inv.id);
  await commit(db);

  const leaf = { key: 'invoices', label: 'Invoices', model: 'account.move' };
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  // Auto-confirm window.confirm
  const origConfirm = globalThis.confirm;
  let confirmCalled = false;
  globalThis.confirm = () => {
    confirmCalled = true;
    return true;
  };

  try {
    await React.act(async () => {
      root.render(React.createElement(FormView, {
        leaf,
        id: inv.id,
        base: '#/accounting/invoices',
        params: new URLSearchParams('view=form'),
      }));
    });

    // Verify Send button is rendered with primary class
    const buttons = allFind(host, (n) => n.tagName === 'BUTTON');
    const sendButton = buttons.find((b) => b.textContent.trim() === 'Send');
    assert.ok(sendButton, 'Send button must be rendered in FormView');
    assert.ok(sendButton.className?.includes('primary'), 'Send button must be primary when unsent');

    // Click Send button to open wizard dialog
    await React.act(async () => {
      props(sendButton).onClick();
    });

    const dialog = find(host, (n) => n.className?.includes('wizard') && n.tagName === 'FORM');
    assert.ok(dialog, 'Wizard dialog must open upon clicking Send');

    // Submit wizard with default values (Email checked, Download unchecked)
    await React.act(async () => {
      props(dialog).onSubmit({ preventDefault() {} });
    });

    // Check that confirm was called for unconfigured SMTP and chatter note posted
    assert.ok(confirmCalled, 'confirm() was called because SMTP is not configured');
    const updated = read(getDb(), 'account.move', inv.id);
    assert.equal(updated.is_move_sent ?? false, false, 'an email that was not sent does not mark the invoice as sent');

    const messages = (getDb().messages ?? []).filter((m) => m.model === 'account.move' && m.res_id === inv.id);
    assert.ok(messages.some((m) => m.body.includes('Not sent: Email is not configured')), 'Chatter note posted via existing email path');
  } finally {
    globalThis.confirm = origConfirm;
    await React.act(async () => root.unmount());
    globalThis.localStorage = prevStorage;
  }
});

test('SND-2: Boolean is_move_sent on account.move, not copied on duplicate, and Sent / Not Sent list filters', () => {
  let db = seed();

  // Model field definition
  const field = models['account.move'].fields.is_move_sent;
  assert.ok(field, 'is_move_sent field must exist on account.move');
  assert.equal(field.type, 'boolean');
  assert.equal(field.label, 'Is Move Sent');
  assert.equal(field.copy, false, 'is_move_sent must have copy: false');

  // Not copied on duplicate
  const partner = search(db, 'res.partner')[0];
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-05-01',
    is_move_sent: true,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100 }],
  });
  db = postMove(inv.db, inv.id);
  const posted = read(db, 'account.move', inv.id);
  assert.equal(posted.is_move_sent, true);

  const dupVals = duplicateValues('account.move', posted, db);
  assert.equal(dupVals.is_move_sent, undefined, 'is_move_sent must not be copied on duplicate');

  // List filters on salesInvoiceView
  const allFilters = salesInvoiceView.filters.flat();
  const sentFilter = allFilters.find((f) => f.label === 'Sent');
  const notSentFilter = allFilters.find((f) => f.label === 'Not Sent');

  assert.ok(sentFilter, 'Filter with label "Sent" must exist on salesInvoiceView');
  assert.ok(notSentFilter, 'Filter with label "Not Sent" must exist on salesInvoiceView');
  assert.notEqual(notSentFilter.id, 'not_sent', 'Filter id must not be "not_sent" to preserve parity checks');

  // Test filter behavior
  const invUnsent = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-05-02',
    is_move_sent: false,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50 }],
  });
  db = postMove(invUnsent.db, invUnsent.id);

  const moves = [read(db, 'account.move', inv.id), read(db, 'account.move', invUnsent.id)];

  const sentResult = applyFilters('account.move', moves, [sentFilter.id], db, salesInvoiceView.filters);
  assert.deepEqual(sentResult.map((m) => m.id), [inv.id], 'Sent filter matches only sent invoices');

  const notSentResult = applyFilters('account.move', moves, [notSentFilter.id], db, salesInvoiceView.filters);
  assert.deepEqual(notSentResult.map((m) => m.id), [invUnsent.id], 'Not Sent filter matches only unsent invoices');
});

test('SND-3: Apply Send button and list filters to customer invoices and credit notes only (not vendor bills)', () => {
  let db = seed();
  const buttons = models['account.move'].form.buttons;
  const sendBtn = buttons.find((b) => b.label === 'Send');
  assert.ok(sendBtn, 'Send button must be defined');

  const partner = search(db, 'res.partner')[0];

  // Customer invoice
  const custInv = { move_type: 'out_invoice', state: 'posted', partner_id: partner.id };
  assert.equal(sendBtn.when(custInv), true, 'Send button available on posted customer invoices');

  // Customer credit note
  const custRefund = { move_type: 'out_refund', state: 'posted', partner_id: partner.id };
  assert.equal(sendBtn.when(custRefund), true, 'Send button available on posted credit notes');

  // Vendor bill
  const vendorBill = { move_type: 'in_invoice', state: 'posted', partner_id: partner.id };
  assert.equal(sendBtn.when(vendorBill), false, 'Send button NOT available on posted vendor bills');

  // Vendor refund
  const vendorRefund = { move_type: 'in_refund', state: 'posted', partner_id: partner.id };
  assert.equal(sendBtn.when(vendorRefund), false, 'Send button NOT available on posted vendor refunds');

  // Journal entry
  const entry = { move_type: 'entry', state: 'posted', partner_id: partner.id };
  assert.equal(sendBtn.when(entry), false, 'Send button NOT available on journal entries');

  // Draft customer invoice
  const draftInv = { move_type: 'out_invoice', state: 'draft', partner_id: partner.id };
  assert.equal(sendBtn.when(draftInv), false, 'Send button NOT available on draft customer invoices');

  // Filters: present on customer invoices (salesInvoiceView), NOT on vendor bills (purchaseInvoiceView)
  const salesFilterLabels = salesInvoiceView.filters.flat().map((f) => f.label);
  assert.ok(salesFilterLabels.includes('Sent'), 'Sent filter present on salesInvoiceView');
  assert.ok(salesFilterLabels.includes('Not Sent'), 'Not Sent filter present on salesInvoiceView');

  const purchaseFilterLabels = purchaseInvoiceView.filters.flat().map((f) => f.label);
  assert.ok(!purchaseFilterLabels.includes('Sent'), 'Sent filter must NOT be on purchaseInvoiceView');
  assert.ok(!purchaseFilterLabels.includes('Not Sent'), 'Not Sent filter must NOT be on purchaseInvoiceView');
});

test('Finding 3 regression: Reset to Draft clears is_move_sent so reposted invoice requires Send again', () => {
  let db = seed();
  const partner = search(db, 'res.partner')[0];
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-05-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100 }],
  });
  db = postMove(inv.db, inv.id);

  const sendBtn = models['account.move'].form.buttons.find((b) => b.label === 'Send');
  const resetBtn = models['account.move'].form.buttons.find((b) => b.label === 'Reset to Draft');

  // Mark sent via Send
  const sentRes = sendBtn.run(db, read(db, 'account.move', inv.id), { email: false, download: true });
  db = sentRes.db;
  assert.equal(read(db, 'account.move', inv.id).is_move_sent, true, 'is_move_sent is true after Send');

  // Reset to Draft
  const resetRes = resetBtn.run(db, read(db, 'account.move', inv.id));
  db = resetRes.db;
  const draft = read(db, 'account.move', inv.id);
  assert.equal(draft.state, 'draft', 'state is draft');
  assert.equal(draft.is_move_sent, false, 'Reset to Draft must clear is_move_sent to false');

  // Repost invoice
  db = postMove(db, inv.id);
  const reposted = read(db, 'account.move', inv.id);
  assert.equal(reposted.state, 'posted');
  assert.equal(reposted.is_move_sent, false, 'Reposted invoice retains is_move_sent=false');
  assert.equal(sendBtn.primary(reposted), true, 'Send button must be primary again after reposting');

  // Filter check
  const sentFilter = salesInvoiceView.filters.flat().find((f) => f.label === 'Sent');
  const notSentFilter = salesInvoiceView.filters.flat().find((f) => f.label === 'Not Sent');
  assert.deepEqual(applyFilters('account.move', [reposted], [sentFilter.id], db, salesInvoiceView.filters), []);
  assert.deepEqual(applyFilters('account.move', [reposted], [notSentFilter.id], db, salesInvoiceView.filters).map((m) => m.id), [inv.id]);
});

test('Finding 1 regression: Send.run refuses when neither Email nor Download is selected', () => {
  let db = seed();
  const partner = search(db, 'res.partner')[0];
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-05-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100 }],
  });
  db = postMove(inv.db, inv.id);
  const posted = read(db, 'account.move', inv.id);

  const sendBtn = models['account.move'].form.buttons.find((b) => b.label === 'Send');
  assert.throws(
    () => sendBtn.run(db, posted, { email: false, download: false }),
    /Select at least one channel/i,
    'Send.run must throw when neither email nor download is selected'
  );
  assert.throws(
    () => sendBtn.run(db, posted, {}),
    /Select at least one channel/i,
    'Send.run must throw when empty values are passed'
  );
});

test('Findings 1 & 2 regression: FormView Send wizard handles unselected channels and live email failure', async () => {
  const prevStorage = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
  setupDom();
  const origCreate = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const el = origCreate(tag);
    el.ownerDocument = globalThis.document;
    el.insertBefore = (child, before) => {
      const idx = before ? el.childNodes.indexOf(before) : -1;
      if (idx >= 0) el.childNodes.splice(idx, 0, child);
      else el.childNodes.push(child);
      child.parentNode = el;
      if (child.tagName === 'OPTION') el.options.push(child);
      return child;
    };
    return el;
  };
  globalThis.document.createElementNS = (_, tag) => globalThis.document.createElement(tag);

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { FormView } = await import('./views/FormView.jsx');
  const { initStore, commit, getDb } = await import('./store.js');
  await initStore();

  let db = getDb();
  // Partner without email
  const partnerNoEmail = create(db, 'res.partner', { name: 'No Email Cust', email: '' });
  db = partnerNoEmail.db;
  const invNoEmail = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partnerNoEmail.id,
    invoice_date: '2026-05-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100 }],
  });
  db = postMove(invNoEmail.db, invNoEmail.id);
  await commit(db);

  const leaf = { key: 'invoices', label: 'Invoices', model: 'account.move' };
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  const origFetch = globalThis.fetch;
  const origLoc = globalThis.location;
  const origAlert = globalThis.alert;
  const origSetInterval = globalThis.setInterval;
  globalThis.alert = () => {};
  globalThis.setInterval = () => ({ unref() {} });

  try {
    // 1. Submit wizard when neither channel is chosen (partner without email)
    await React.act(async () => {
      root.render(React.createElement(FormView, {
        leaf,
        id: invNoEmail.id,
        base: '#/accounting/invoices',
        params: new URLSearchParams('view=form'),
      }));
    });

    const sendButton = allFind(host, (n) => n.tagName === 'BUTTON').find((b) => b.textContent.trim() === 'Send');
    assert.ok(sendButton);

    await React.act(async () => {
      props(sendButton).onClick();
    });

    let dialog = find(host, (n) => n.className?.includes('wizard') && n.tagName === 'FORM');
    assert.ok(dialog, 'Wizard dialog open');

    // Submit wizard with default (both false)
    await React.act(async () => {
      props(dialog).onSubmit({ preventDefault() {} });
    });

    // Dialog must STILL be open, error message must be shown, and invoice must NOT be sent
    dialog = find(host, (n) => n.className?.includes('wizard') && n.tagName === 'FORM');
    assert.ok(dialog, 'Wizard dialog must remain open when confirmation is rejected');
    const alertEl = find(host, (n) => n.className?.includes('alert'));
    assert.ok(alertEl, 'Alert message must be shown in wizard');
    assert.equal(read(getDb(), 'account.move', invNoEmail.id).is_move_sent, false, 'Invoice must not be marked sent');

    // Cancel to close dialog
    const cancelBtn = allFind(dialog, (n) => n.tagName === 'BUTTON').find((b) => b.textContent.trim() === 'Cancel');
    if (cancelBtn) await React.act(async () => { props(cancelBtn).onClick(); });

    // 2. Live email failure when Email and Download are both chosen
    const partnerWithEmail = create(getDb(), 'res.partner', { name: 'With Email Cust', email: 'cust@example.com' });
    const invWithEmail = create(partnerWithEmail.db, 'account.move', {
      move_type: 'out_invoice',
      partner_id: partnerWithEmail.id,
      invoice_date: '2026-05-01',
      invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100 }],
    });
    const postedWithEmailDb = postMove(invWithEmail.db, invWithEmail.id);
    await commit(postedWithEmailDb);

    let failEmail = true;
    let serverDb = getDb();
    globalThis.location = { hash: '#/accounting/invoices' };
    globalThis.fetch = async (url) => {
      if (url === '/api/session') {
        return new Response(JSON.stringify({ name: 'Admin', isAdmin: true, integrations: { smtp: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/db') {
        return new Response(JSON.stringify(serverDb), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/diff') {
        return new Response(JSON.stringify(getDb()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/mail/document') {
        if (failEmail) {
          return new Response(JSON.stringify({ error: failEmail === 'recording' ? 'The email was sent, but its status could not be recorded: access denied' : 'SMTP delivery failed' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        serverDb = write(serverDb, 'account.move', invWithEmail.id, { is_move_sent: true });
        return new Response(JSON.stringify({ ok: true, message: 'Email sent successfully' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    // Re-init store in server mode with smtp enabled
    await React.act(async () => {
      await initStore();
    });

    await React.act(async () => {
      root.render(React.createElement(FormView, {
        leaf,
        id: invWithEmail.id,
        base: '#/accounting/invoices',
        params: new URLSearchParams('view=form'),
      }));
    });

    const sendBtn2 = allFind(host, (n) => n.tagName === 'BUTTON').find((b) => b.textContent.trim() === 'Send');
    assert.ok(sendBtn2);

    await React.act(async () => {
      props(sendBtn2).onClick();
    });

    const dialog2 = find(host, (n) => n.className?.includes('wizard') && n.tagName === 'FORM');
    assert.ok(dialog2);

    // Toggle download checkbox so both email and download are true
    const downloadCheckbox = find(dialog2, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox' && props(n)?.id === 'w-download');
    assert.ok(downloadCheckbox, 'Download checkbox must exist');
    await React.act(async () => {
      props(downloadCheckbox).onChange({ target: { checked: true } });
    });

    // Reset location.hash
    globalThis.location.hash = '#/accounting/invoices';

    // Submit wizard with email failure
    await React.act(async () => {
      const liveDialog = find(host, (n) => n.className?.includes('wizard') && n.tagName === 'FORM');
      await props(liveDialog).onSubmit({ preventDefault() {} });
    });

    // Should NOT navigate to download route
    assert.equal(globalThis.location.hash, '#/accounting/invoices', 'Must not navigate to download route on email failure');
    // Invoice must NOT be marked sent
    assert.equal(read(getDb(), 'account.move', invWithEmail.id).is_move_sent, false, 'Failed email must not mark invoice sent');
    // Error must be displayed on FormView
    const errorEl = find(host, (n) => n.className?.includes('alert'));
    assert.ok(errorEl, 'FormView must show error on email failure');
    assert.ok(errorEl.textContent.includes('SMTP delivery failed'), 'Error text must mention failure');

    // A delivered email whose status could not be recorded must also stop the print route.
    failEmail = 'recording';
    await React.act(async () => { props(sendBtn2).onClick(); });
    const recordingDialog = find(host, (n) => n.className?.includes('wizard') && n.tagName === 'FORM');
    const recordingDownload = find(recordingDialog, (n) => n.tagName === 'INPUT' && props(n)?.id === 'w-download');
    await React.act(async () => { props(recordingDownload).onChange({ target: { checked: true } }); });
    await React.act(async () => {
      const form = find(host, (n) => n.className?.includes('wizard') && n.tagName === 'FORM');
      await props(form).onSubmit({ preventDefault() {} });
    });
    assert.equal(globalThis.location.hash, '#/accounting/invoices');
    assert.equal(read(getDb(), 'account.move', invWithEmail.id).is_move_sent, false);
    assert.match(find(host, (n) => n.className?.includes('alert')).textContent, /status could not be recorded/);

    // 3. Now let live email SUCCEED
    failEmail = false;
    await React.act(async () => {
      props(sendBtn2).onClick();
    });
    const dialog3 = find(host, (n) => n.className?.includes('wizard') && n.tagName === 'FORM');
    assert.ok(dialog3);
    const dl3 = find(dialog3, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox' && props(n)?.id === 'w-download');
    assert.ok(dl3, 'Download checkbox must exist for dialog3');
    await React.act(async () => {
      props(dl3).onChange({ target: { checked: true } });
    });
    await React.act(async () => {
      const liveDialog3 = find(host, (n) => n.className?.includes('wizard') && n.tagName === 'FORM');
      await props(liveDialog3).onSubmit({ preventDefault() {} });
    });

    // Upon success: invoice marked sent and navigated to print
    assert.equal(read(getDb(), 'account.move', invWithEmail.id).is_move_sent, true, 'Succeeded email must mark invoice sent');
    assert.equal(globalThis.location.hash, `#/print/account.move/${invWithEmail.id}`, 'Must navigate to download route after email succeeds');
  } finally {
    globalThis.fetch = () => Promise.reject(new Error('offline'));
    await React.act(async () => root.unmount());
    globalThis.fetch = origFetch;
    globalThis.location = origLoc;
    globalThis.alert = origAlert;
    globalThis.setInterval = origSetInterval;
    globalThis.localStorage = prevStorage;
    await initStore();
  }
});
