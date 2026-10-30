import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const textOf = (node) => node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join('');

test('follow-up reminder logs only the selected company invoices and level for a shared customer', async () => {
  const { makeEl } = setupDom(); globalThis.location = { hash: '#/accounting' };
  const React = await import('react'); const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js'); await initStore(); const base = getDb();
  const due = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const partner = { ...base.records['res.partner'][0], email: 'shared@example.test', followup_lines: [] };
  const invoices = [
    { id: 9001, name: 'VISIBLE-INV', company_id: 1, invoice_date_due: due(10), amount_residual: 100 },
    { id: 9002, name: 'FOREIGN-INV', company_id: 2, invoice_date_due: due(90), amount_residual: 999 },
  ].map((move) => ({ ...move, partner_id: partner.id, state: 'posted', move_type: 'out_invoice', invoice_line_ids: [{ qty: 1, price_unit: move.amount_residual }] }));
  const db = { ...base, settings: { ...base.settings, current_company_id: 1, allowed_company_ids: [1] }, records: { ...base.records,
    'res.partner': base.records['res.partner'].map((p) => p.id === partner.id ? partner : p),
    'account.move': invoices, 'account.followup.level': [{ id: 1, name: 'Gentle', delay: 0 }, { id: 2, name: 'Final', delay: 30 }] } };
  await React.act(async () => commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document; const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'followups' } })));
    const link = find(host, (node) => node.tagName === 'A' && props(node)?.href?.startsWith('mailto:shared@example.test'));
    assert.ok(link, textOf(host));
    const body = new URLSearchParams(props(link).href.split('?')[1]).get('body');
    assert.match(body, /VISIBLE-INV/); assert.doesNotMatch(body, /FOREIGN-INV/);
    await React.act(async () => props(link).onClick());
    assert.match(getDb().messages.at(-1).body, /opened in mail app/);
    assert.equal(getDb().records['res.partner'].find((p) => p.id === partner.id).followup_lines.length, 0);
    const confirm = find(link.parentNode, (node) => node.tagName === 'BUTTON' && textOf(node) === 'Confirm Sent');
    assert.ok(confirm);
    await React.act(async () => props(confirm).onClick());
    const saved = getDb();
    const note = saved.messages.at(-1).body;
    assert.match(note, /Gentle/); assert.match(note, /VISIBLE-INV/); assert.doesNotMatch(note, /FOREIGN-INV|Final/);
    assert.equal(saved.records['res.partner'].find((p) => p.id === partner.id).followup_lines.find((line) => line.company_id === 1)?.followup_level_delay, 0);
    assert.ok(saved.records['account.move'].some((move) => move.name === 'FOREIGN-INV'));
  } finally { await React.act(async () => root.unmount()); }
});

test('Reports navigation resets custom Journal Audit period before rendering a comparison report', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/journal-audit' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore } = await import('./store.js');
  await initStore();
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'journalAudit' } })));
    const period = find(host, (node) => node.tagName === 'SELECT' && props(node)?.value === 'year');
    assert.ok(period, 'Journal Audit period selector is rendered');
    await React.act(async () => props(period).onChange({ target: { value: 'custom' } }));
    assert.equal(props(period).value, 'custom');
    assert.ok(find(host, (node) => node.tagName === 'INPUT' && props(node)?.type === 'date'));
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'pnl' } })));
    const nextPeriod = find(host, (node) => node.tagName === 'SELECT' && props(node)?.value === 'year');
    assert.ok(nextPeriod, 'comparison report starts on the default year');
    assert.equal(find(host, (node) => node.tagName === 'INPUT' && props(node)?.type === 'date'), null);
    const comparison = find(host, (node) => node.tagName === 'SELECT' && props(node)?.value === 'none');
    assert.ok(comparison);
    await React.act(async () => props(comparison).onChange({ target: { value: 'previous' } }));
    assert.equal(props(comparison).value, 'previous');
  } finally { await React.act(async () => root.unmount()); }
});

test('reports exclude legacy company-less assets and budgets when another company is selected', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js');
  await initStore();
  const base = getDb();
  const db = { ...base, settings: { ...base.settings, current_company_id: 2, allowed_company_ids: [2] }, records: { ...base.records,
    'res.company': [{ id: 1, name: 'First' }, { id: 2, name: 'Second' }],
    'account.asset': [{ id: 71, name: 'Legacy asset', state: 'open', original_value: 111 }, { id: 72, name: 'Second asset', company_id: 2, state: 'open', original_value: 222 }],
    'account.budget': [{ id: 71, name: 'Legacy budget', state: 'open', lines: [] }, { id: 72, name: 'Second budget', company_id: 2, state: 'open', lines: [] }],
    product: [{ id: 71, name: 'Legacy stock', type: 'goods', qty_available: 7, cost: 10 }, { id: 72, name: 'Second stock', type: 'goods', qty_available: 0, cost: 10 }],
    'stock.valuation.layer': [{ id: 71, product_id: 71, date: '2026-01-01', quantity: 7, value: 70 }, { id: 72, product_id: 72, company_id: 2, date: '2026-01-01', quantity: 2, value: 20 }],
    'account.analytic.account': [{ id: 72, name: 'Second analytic', company_id: 2 }],
    'account.analytic.line': [{ id: 71, account_id: 72, amount: 999, move_id: 71, date: new Date().toISOString().slice(0, 10) }, { id: 72, account_id: 72, amount: 222, company_id: 2, move_id: 72, date: new Date().toISOString().slice(0, 10) }],
    'account.move': [{ id: 71, state: 'posted', move_type: 'out_invoice', invoice_date: new Date().toISOString().slice(0, 10), invoice_line_ids: [{ analytic_account_id: 72, qty: 1, price_unit: 999 }] }, { id: 72, state: 'posted', move_type: 'out_invoice', company_id: 2, invoice_date: new Date().toISOString().slice(0, 10), invoice_line_ids: [{ analytic_account_id: 72, qty: 1, price_unit: 222 }] }],
  } };
  await React.act(async () => commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document; const root = createRoot(host);
  try {
    for (const [report, included, excluded] of [['depreciation', 'Second asset', 'Legacy asset'], ['budget', 'Second budget', 'Legacy budget'], ['valuation', 'Second stock', 'Legacy stock']]) {
      await React.act(async () => root.render(React.createElement(Reports, { leaf: { report } })));
      assert.ok(textOf(host).includes(included)); assert.ok(!textOf(host).includes(excluded));
    }
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'analytic' } })));
    assert.match(textOf(host), /Second analytic/); assert.match(textOf(host), /222\.00/); assert.doesNotMatch(textOf(host), /999\.00|1,221\.00/);
  } finally { await React.act(async () => root.unmount()); }
});

test('local Audit Trail excludes other company and deleted record messages', async () => {
  const { makeEl } = setupDom(); globalThis.location = { hash: '#/accounting' };
  const React = await import('react'); const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js'); await initStore(); const base = getDb();
  const db = { ...base, settings: { ...base.settings, current_company_id: 2, allowed_company_ids: [2] }, records: { ...base.records,
    'res.company': [{ id: 1, name: 'First' }, { id: 2, name: 'Second' }],
    'account.move': [{ id: 71, name: 'First move', company_id: 1 }, { id: 72, name: 'Second move', company_id: 2 }] },
    messages: [71, 72, 73].map((id) => ({ id, model: 'account.move', res_id: id, body: `Message ${id}`, author: 'Test', date: new Date().toISOString() })) };
  await React.act(async () => commit(db)); const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document; const root = createRoot(host);
  try { await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'audit' } })));
    assert.match(textOf(host), /Message 72/); assert.doesNotMatch(textOf(host), /Message 71|Message 73/);
  } finally { await React.act(async () => root.unmount()); }
});

test('local Audit Trail does not assign unknown deleted history to company one', async () => {
  const { makeEl } = setupDom(); globalThis.location = { hash: '#/accounting' };
  const React = await import('react'); const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js'); await initStore(); const base = getDb();
  const db = { ...base, settings: { ...base.settings, current_company_id: 1, allowed_company_ids: [1] },
    messages: [{ id: 'unknown', model: 'account.move', res_id: 999999, body: 'Unknown deleted secret', author: 'Test', date: new Date().toISOString() }] };
  await React.act(async () => commit(db)); const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document; const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'audit' } })));
    assert.doesNotMatch(textOf(host), /Unknown deleted secret/);
  } finally { await React.act(async () => root.unmount()); }
});

test('local Audit Trail keeps older selected-company history behind 501 foreign messages', async () => {
  const { makeEl } = setupDom(); globalThis.location = { hash: '#/accounting' };
  const React = await import('react'); const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js'); await initStore(); const base = getDb();
  const now = new Date();
  const db = { ...base, settings: { ...base.settings, current_company_id: 2, allowed_company_ids: [2] }, records: { ...base.records,
    'account.move': [{ id: 71, name: 'Foreign', company_id: 1 }, { id: 72, name: 'Selected', company_id: 2 }] },
  messages: [{ id: 'selected', model: 'account.move', res_id: 72, body: 'Older selected history', author: 'Test', date: now.toISOString() },
    ...Array.from({ length: 501 }, (_, i) => ({ id: `foreign-${i}`, model: 'account.move', res_id: 71, body: 'Foreign history', author: 'Test', date: new Date(now.getTime() + 1000).toISOString() }))] };
  await React.act(async () => commit(db)); const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document; const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'audit' } })));
    assert.match(textOf(host), /Older selected history/);
    assert.doesNotMatch(textOf(host), /Foreign history/);
  } finally { await React.act(async () => root.unmount()); }
});

test('local Audit Trail retains deleted record history only for its company', async () => {
  const { makeEl } = setupDom(); globalThis.location = { hash: '#/accounting' };
  const React = await import('react'); const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js'); const { postTracking, unlink } = await import('./orm.js');
  await initStore(); const base = getDb();
  let db = { ...base, settings: { ...base.settings, current_company_id: 2, allowed_company_ids: [2] }, records: { ...base.records,
    'res.company': [{ id: 1, name: 'First' }, { id: 2, name: 'Second' }],
    'account.move': [{ id: 9871, name: 'First draft', company_id: 1 }, { id: 9872, name: 'Second draft', company_id: 2 }] } };
  db = postTracking(db, 'account.move', 9871, 'First deleted history');
  db = postTracking(db, 'account.move', 9872, 'Second deleted history');
  db = unlink(db, 'account.move', [9871, 9872]);
  await React.act(async () => commit(db)); const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document; const root = createRoot(host);
  try { await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'audit' } })));
    assert.match(textOf(host), /Second deleted history/); assert.doesNotMatch(textOf(host), /First deleted history/);
  } finally { await React.act(async () => root.unmount()); }
});

test('Inalterability report hides period controls and explains its all-time scope', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/inalterability-check' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore } = await import('./store.js');
  await initStore();
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'inalterability' } })));
    assert.equal(find(host, (node) => node.tagName === 'SELECT' && ['year', 'month', 'quarter', 'all'].includes(props(node)?.value)), null);
    assert.equal(find(host, (node) => node.tagName === 'INPUT' && props(node)?.type === 'date'), null);
    assert.ok(find(host, (node) => node.tagName === 'SPAN' && node.textContent === 'Chain verification always covers all secured entries.'));
  } finally { await React.act(async () => root.unmount()); }
});

test('Journal Audit and Inalterability show only selected companies and their selector choices', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/journal-audit' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js');
  const { computeMoveHash } = await import('./models/hash_chain.js');
  await initStore();
  const base = getDb();
  const moves = [1, 2].map((company) => {
    const move = { id: 900 + company, name: `SEC/${company}`, company_id: company, journal_id: 900, date: `${new Date().getFullYear()}-01-01`, state: 'posted', secure_sequence_number: 1, inalterable_hash_version: 2, line_ids: [{ name: `Company ${company} item`, debit: company * 100, credit: 0 }] };
    return { ...move, inalterable_hash: computeMoveHash(move, '', 2) };
  });
  const heads = moves.map((m) => ({ company_id: m.company_id, count: 1, last_sequence: 1, last_hash: m.inalterable_hash, last_move_id: m.id, last_move_name: m.name }));
  const db = { ...base, settings: { ...base.settings, current_company_id: 1, allowed_company_ids: [1] }, records: { ...base.records,
    'res.company': [{ id: 1, name: 'First Company' }, { id: 2, name: 'Second Company' }],
    'account.journal': [{ id: 900, name: 'Shared Secure Journal', code: 'SEC', restrict_mode_hash_table: true, secure_chain_heads: heads }], 'account.move': moves } };
  await React.act(async () => commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    for (const report of ['journalAudit', 'inalterability']) {
      await React.act(async () => root.render(React.createElement(Reports, { leaf: { report } })));
      const selector = find(host, (node) => node.tagName === 'SELECT' && node.options.some((option) => option.textContent === 'First Company'));
      assert.ok(selector, `${report} company selector`);
      assert.deepEqual(selector.options.map((option) => option.textContent), ['All Companies', 'First Company']);
      assert.match(textOf(host), /SEC\/1/);
      assert.doesNotMatch(textOf(host), /SEC\/2|Second Company|Company 2 item/);
      if (report === 'journalAudit') {
        assert.match(textOf(host), /Company 1 item/);
        assert.doesNotMatch(textOf(host), /300\.00/);
      }
    }
    await React.act(async () => commit({ ...db, settings: { ...db.settings, current_company_id: 2, allowed_company_ids: [2] } }));
    assert.match(textOf(host), /SEC\/2/);
    assert.doesNotMatch(textOf(host), /SEC\/1|First Company/);
    await React.act(async () => commit({ ...db, settings: { ...db.settings, allowed_company_ids: [1, 2] } }));
    for (const report of ['journalAudit', 'inalterability']) {
      await React.act(async () => root.render(React.createElement(Reports, { leaf: { report } })));
      const selector = find(host, (node) => node.tagName === 'SELECT' && node.options.some((option) => option.textContent === 'First Company'));
      assert.deepEqual(selector.options.map((option) => option.textContent), ['All Companies', 'First Company', 'Second Company']);
      for (const [selection, shown, hidden] of [['all', ['SEC/1', 'SEC/2'], []], ['1', ['SEC/1'], ['SEC/2']], ['2', ['SEC/2'], ['SEC/1']]]) {
        await React.act(async () => props(selector).onChange({ target: { value: selection } }));
        const output = textOf(host);
        shown.forEach((name) => assert.ok(output.includes(name), `${report} ${selection} includes ${name}`));
        hidden.forEach((name) => assert.ok(!output.includes(name), `${report} ${selection} excludes ${name}`));
        if (report === 'journalAudit') {
          const totals = { all: '300.00', '1': '100.00', '2': '200.00' };
          const total = find(host, (node) => node.tagName === 'TR' && props(node)?.className === 'rep-total strong');
          assert.ok(total, `${selection} total row`);
          assert.equal(textOf(total.childNodes[1]), `$${totals[selection]}`, `${selection} debit total`);
          assert.equal(textOf(total.childNodes[2]), '$0.00', `${selection} credit total`);
        } else {
          const body = find(host, (node) => node.tagName === 'TBODY');
          const rows = body.childNodes.filter((node) => node.tagName === 'TR');
          assert.equal(rows.length, selection === 'all' ? 2 : 1, `${selection} chain rows`);
          assert.ok(rows.every((row) => textOf(row).includes('Data Inalterable - OK')), `${selection} chain status`);
        }
      }
    }
  } finally { await React.act(async () => root.unmount()); }
});

test('follow-up report with several companies selected shows separate sections with per-company reminder actions and levels', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js');
  await initStore();
  const base = getDb();
  const due = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const partner = { ...base.records['res.partner'][0], email: 'multishared@example.test', followup_lines: [] };
  const invoices = [
    { id: 9101, name: 'COMP1-INV', company_id: 1, invoice_date_due: due(40), amount_residual: 100 },
    { id: 9102, name: 'COMP2-INV', company_id: 2, invoice_date_due: due(5), amount_residual: 200 },
  ].map((move) => ({ ...move, partner_id: partner.id, state: 'posted', move_type: 'out_invoice', invoice_line_ids: [{ qty: 1, price_unit: move.amount_residual }] }));
  const db = {
    ...base,
    settings: { ...base.settings, current_company_id: 1, allowed_company_ids: [1, 2] },
    records: {
      ...base.records,
      'res.company': [{ id: 1, name: 'Alpha Corp' }, { id: 2, name: 'Beta Branch' }],
      'res.partner': base.records['res.partner'].map((p) => (p.id === partner.id ? partner : p)),
      'account.move': invoices,
      'account.followup.level': [
        { id: 1, name: 'Gentle', delay: 0, message: 'Please pay.' },
        { id: 2, name: 'First Reminder', delay: 15, message: 'Overdue 15 days.' },
        { id: 3, name: 'Final Notice', delay: 30, message: 'Overdue 30 days.' },
      ],
    },
  };
  await React.act(async () => commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'followups' } })));

    const text = textOf(host);
    assert.match(text, /Alpha Corp/);
    assert.match(text, /Beta Branch/);

    const links = [];
    const walk = (node) => {
      if (node.tagName === 'A' && props(node)?.href?.startsWith('mailto:multishared@example.test')) {
        links.push(node);
      }
      for (const child of node.childNodes ?? []) walk(child);
    };
    walk(host);
    assert.equal(links.length, 2, 'one reminder action per company');

    const body1 = decodeURIComponent(new URLSearchParams(props(links[0]).href.split('?')[1]).get('body'));
    assert.match(body1, /COMP1-INV/);
    assert.doesNotMatch(body1, /COMP2-INV/);

    const body2 = decodeURIComponent(new URLSearchParams(props(links[1]).href.split('?')[1]).get('body'));
    assert.match(body2, /COMP2-INV/);
    assert.doesNotMatch(body2, /COMP1-INV/);

    await React.act(async () => props(links[0]).onClick());
    assert.match(getDb().messages.at(-1).body, /opened in mail app/);
    assert.equal(getDb().messages.at(-1).company_id, 1);
    assert.equal(getDb().records['res.partner'].find((x) => x.id === partner.id).followup_lines.length, 0);
    const confirm1 = find(links[0].parentNode, (node) => node.tagName === 'BUTTON' && textOf(node) === 'Confirm Sent');
    assert.ok(confirm1);
    await React.act(async () => props(confirm1).onClick());
    let saved = getDb();
    let note1 = saved.messages.at(-1).body;
    assert.match(note1, /Final Notice/);
    assert.match(note1, /COMP1-INV/);
    assert.doesNotMatch(note1, /COMP2-INV/);
    let p = saved.records['res.partner'].find((x) => x.id === partner.id);
    let line1 = p.followup_lines.find((l) => l.company_id === 1);
    assert.equal(line1?.followup_level_delay, 30, 'Company 1 gets 30-day level (40 days overdue)');

    await React.act(async () => props(links[1]).onClick());
    assert.match(getDb().messages.at(-1).body, /opened in mail app/);
    assert.equal(getDb().messages.at(-1).company_id, 2);
    assert.equal(getDb().records['res.partner'].find((x) => x.id === partner.id).followup_lines.find((l) => l.company_id === 2), undefined);
    const confirm2 = find(links[1].parentNode, (node) => node.tagName === 'BUTTON' && textOf(node) === 'Confirm Sent');
    assert.ok(confirm2);
    await React.act(async () => props(confirm2).onClick());
    saved = getDb();
    let note2 = saved.messages.at(-1).body;
    assert.match(note2, /Gentle/);
    assert.match(note2, /COMP2-INV/);
    assert.doesNotMatch(note2, /COMP1-INV|Final Notice/);
    p = saved.records['res.partner'].find((x) => x.id === partner.id);
    let line2 = p.followup_lines.find((l) => l.company_id === 2);
    assert.equal(line2?.followup_level_delay, 0, 'Company 2 gets 0-day level (5 days overdue)');

    line1 = p.followup_lines.find((l) => l.company_id === 1);
    assert.equal(line1?.followup_level_delay, 30);
  } finally {
    await React.act(async () => root.unmount());
  }
});
