import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { accountId, postEntry, statementCompanyAmount } from './models/ledger.js';
import { eligiblePayments, matchPayment, paymentMatchError } from './models/bank.js';
import { postPayment } from './models/pay.js';
import { applyRule } from './models/reconcile.js';
import { models, viewsOf } from './models/index.js';
import { create, matches, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';

const journal = models['account.journal'];

test('JCF-1: journals open in list view', () => {
  assert.deepEqual(viewsOf('account.journal'), ['list', 'kanban']);
});

test('JCF-2: configured journal currency is exposed and used for statement lines', () => {
  const db = seed();
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank');
  const currency = search(db, 'res.currency')[0];
  const updated = write(db, 'account.journal', bank.id, { currency_id: currency.id });
  const synced = applyDiff(db, diffDb(db, updated), { isAdmin: true });
  assert.equal(read(synced, 'account.journal', bank.id).currency_id, currency.id);
  assert.equal(journal.fields.currency_id.relation, 'res.currency');
  assert.equal(journal.fields.currency_id.optional, 'hide');
  assert.ok(journal.list.includes('currency_id'));
  assert.ok(journal.form.tabs(bank)[0].groups[0].includes('currency_id'));
  assert.equal(models['account.bank.statement.line'].createDefaults(synced, { journal_id: bank.id }).currency_id, currency.id);
});

test('JCF-3: name and code search and archived filter', () => {
  const db = seed();
  const record = search(db, 'account.journal')[0];
  assert.ok(matches(db, 'account.journal', record, [record.name]));
  assert.ok(matches(db, 'account.journal', record, [record.code]));
  const filter = journal.filters.flat().find((f) => f.id === 'archived');
  assert.equal(filter.includeArchived, true);
  assert.equal(filter.fn({ active: false }), true);
  assert.equal(filter.fn({ active: true }), false);
});

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

test('JCF-4: journal smart button opens only that journal items', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();
  let db = seed();
  const first = create(db, 'account.journal', { name: 'Scope First', code: 'SCF', type: 'general' });
  const second = create(first.db, 'account.journal', { name: 'Scope Second', code: 'SCS', type: 'general' });
  db = second.db;
  for (const [id, label] of [[first.id, 'Scope Included'], [second.id, 'Scope Excluded']]) {
    db = postEntry(db, { journal_id: id, company: 1, date: '2026-04-10', lines: [
      { account_id: accountId(db, '101401'), name: label, debit: 10 },
      { account_id: accountId(db, '400000'), name: `${label} credit`, credit: 10 },
    ] }).db;
  }
  const smart = journal.form.smart[0];
  assert.equal(smart.label, 'Journal Items');
  assert.equal(smart.value(db, { id: first.id }), 2);
  const target = smart.target({ id: first.id });
  assert.equal(target, `accounting/journal-items?journal=${first.id}`);
  await React.act(async () => store.commit(db));
  const previousLocation = globalThis.location;
  globalThis.location = { hash: `#/${target}` };
  const { JournalItems } = await import('./views/JournalItems.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(JournalItems)));
    assert.ok(host.textContent.includes('Scope Included'));
    assert.ok(!host.textContent.includes('Scope Excluded'));
    const facet = find(host, (n) => n.tagName === 'SPAN' && n.textContent.includes('Journal: Scope First'));
    assert.ok(facet);
    const remove = find(facet, (n) => n.tagName === 'A');
    const props = remove[Object.keys(remove).find((key) => key.startsWith('__reactProps$'))];
    assert.equal(props.href, '#/accounting/journal-items');
  } finally {
    globalThis.location = previousLocation;
    await React.act(async () => root.unmount());
  }
});

test('JCF-5: changing journal currency preserves statement line original currency and calculated amounts during reconciliation and write-off, and refuses unsafe currency changes', () => {
  let db = seed();
  const companyId = 1;
  const companyCurr = read(db, 'res.company', companyId).currency_id;

  const eurRes = create(db, 'res.currency', {
    name: 'EUR',
    symbol: '€',
    rounding: 0.01,
    rate_ids: [{ date: '2026-01-01', rate: 0.5, company_id: companyId }],
  });
  db = eurRes.db;
  const eurId = eurRes.id;

  const defaultAccount = search(db, 'account.account').find((a) => a.account_type === 'asset_cash');
  const suspenseAccount = search(db, 'account.account').find((a) => a.code === '101404');
  const bankJournalRes = create(db, 'account.journal', {
    name: 'Test Bank FX',
    code: 'TBFX',
    type: 'bank',
    currency_id: companyCurr,
    company_id: companyId,
    default_account_id: defaultAccount.id,
    suspense_account_id: suspenseAccount.id,
  });
  db = bankJournalRes.db;
  const bankJournalId = bankJournalRes.id;

  const lineRes = create(db, 'account.bank.statement.line', {
    journal_id: bankJournalId,
    payment_ref: 'Line before journal currency change',
    amount: 100,
    date: '2026-04-15',
  });
  db = lineRes.db;
  const lineId = lineRes.id;
  const lineBefore = read(db, 'account.bank.statement.line', lineId);
  assert.equal(lineBefore.currency_id, companyCurr);

  const initialCompanyAmount = statementCompanyAmount(db, lineBefore);
  assert.equal(initialCompanyAmount, 100);

  // Changing journal currency to EUR
  db = write(db, 'account.journal', bankJournalId, { currency_id: eurId });
  assert.equal(read(db, 'account.journal', bankJournalId).currency_id, eurId);

  // Existing statement line preserves its original currency and calculated company amount
  const lineAfter = read(db, 'account.bank.statement.line', lineId);
  assert.equal(lineAfter.currency_id, companyCurr);
  assert.equal(statementCompanyAmount(db, lineAfter), 100, 'Existing statement line amount must not change when journal currency changes');

  // Verify that an unsafe currency change (e.g. statement line without currency_id) is blocked by guard
  const rawLineRes = create(db, 'account.bank.statement.line', {
    journal_id: bankJournalId,
    payment_ref: 'Unsafe line without currency',
    amount: 50,
    date: '2026-04-15',
  });
  db = rawLineRes.db;
  db = {
    ...db,
    records: {
      ...db.records,
      'account.bank.statement.line': db.records['account.bank.statement.line'].map((l) =>
        l.id === rawLineRes.id ? { ...l, currency_id: null } : l
      ),
    },
  };

  assert.throws(
    () => write(db, 'account.journal', bankJournalId, { currency_id: companyCurr }),
    /Cannot change journal currency when existing transactions cannot be safely interpreted in their original currency/
  );
});

test('JCF-6: SearchPanel suppresses duplicate generic Archived control when model has named archived filter, and only one facet is selectable/clearable', async () => {
  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (_, tag) => globalThis.document.createElement(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();
  const db = seed();
  await React.act(async () => store.commit(db));

  const { ControlPanel } = await import('./views/ControlPanel.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  let searchState = { terms: [], filters: [], archived: false, groupBy: [], rel: null };
  const setSearch = (s) => { searchState = s; };

  const renderComponent = async (searchVal) => {
    await React.act(async () => {
      root.render(React.createElement(ControlPanel, {
        model: 'account.journal',
        title: 'Journals',
        base: '#/accounting/journals',
        view: 'list',
        search: searchVal,
        setSearch: (updater) => {
          const next = typeof updater === 'function' ? updater(searchState) : updater;
          setSearch(next);
        },
      }));
    });
  };

  try {
    await renderComponent(searchState);

    const toggleBtn = find(host, (n) => n.tagName === 'BUTTON' && n.className && n.className.includes('search-toggle'));
    assert.ok(toggleBtn);
    await React.act(async () => {
      const clickProp = toggleBtn[Object.keys(toggleBtn).find((k) => k.startsWith('__reactProps$'))]?.onClick;
      clickProp?.({ preventDefault: () => {}, stopPropagation: () => {} });
    });

    const searchPanel = find(host, (n) => n.className && n.className.includes('search-panel'));
    assert.ok(searchPanel);

    const archivedButtons = [];
    const walk = (node) => {
      if (node.tagName === 'BUTTON' && node.textContent.trim() === 'Archived') {
        archivedButtons.push(node);
      }
      for (const child of node.childNodes || []) walk(child);
    };
    walk(searchPanel);
    assert.equal(archivedButtons.length, 1, 'SearchPanel must render only one Archived button');

    // Click the Archived button
    await React.act(async () => {
      const btn = archivedButtons[0];
      const clickProp = btn[Object.keys(btn).find((k) => k.startsWith('__reactProps$'))]?.onClick;
      clickProp?.({ preventDefault: () => {}, stopPropagation: () => {} });
    });

    // Re-render with new searchState
    await renderComponent(searchState);
    assert.ok(searchState.filters.includes('archived'), 'Named archived filter was toggled in search.filters');

    const facetNodes = [];
    const findFacets = (node) => {
      if (node.className && typeof node.className === 'string' && node.className.split(' ').includes('facet')) {
        if (node.textContent.includes('Archived')) facetNodes.push(node);
      }
      for (const child of node.childNodes || []) findFacets(child);
    };
    findFacets(host);
    assert.equal(facetNodes.length, 1, 'Only one Archived facet must be rendered');

    // Click remove on the facet
    const removeBtn = find(facetNodes[0], (n) => n.tagName === 'BUTTON');
    assert.ok(removeBtn);
    await React.act(async () => {
      const clickProp = removeBtn[Object.keys(removeBtn).find((k) => k.startsWith('__reactProps$'))]?.onClick;
      clickProp?.({ preventDefault: () => {}, stopPropagation: () => {} });
    });

    // Re-render and verify the facet is cleared
    await renderComponent(searchState);
    assert.equal(searchState.filters.includes('archived'), false);
    assert.equal(searchState.archived, false);

    facetNodes.length = 0;
    findFacets(host);
    assert.equal(facetNodes.length, 0, 'Archived facet must be completely removed');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('JCF-7: matching an old-currency statement line to a posted payment after journal currency changes', () => {
  let db = seed();
  const companyId = 1;
  const companyCurr = read(db, 'res.company', companyId).currency_id;

  const eurRes = create(db, 'res.currency', {
    name: 'EUR',
    symbol: '€',
    rounding: 0.01,
    rate_ids: [{ date: '2026-01-01', rate: 0.5, company_id: companyId }],
  });
  db = eurRes.db;
  const eurId = eurRes.id;

  const defaultAccount = search(db, 'account.account').find((a) => a.account_type === 'asset_cash');
  const suspenseAccount = search(db, 'account.account').find((a) => a.code === '101404');
  const outstandingReceipts = accountId(db, '101402', companyId);
  const feeAccount = search(db, 'account.account').find((a) => a.code === '600000') ?? search(db, 'account.account').find((a) => a.account_type === 'expense');
  const bankJournalRes = create(db, 'account.journal', {
    name: 'EUR Bank',
    code: 'EUBK',
    type: 'bank',
    currency_id: eurId,
    company_id: companyId,
    default_account_id: defaultAccount.id,
    suspense_account_id: suspenseAccount.id,
    outstanding_receipts_account_id: outstandingReceipts,
  });
  db = bankJournalRes.db;
  const bankJournalId = bankJournalRes.id;

  const partner = search(db, 'res.partner')[0];
  const payRes = create(db, 'account.payment', {
    partner_id: partner.id,
    company_id: companyId,
    journal_id: bankJournalId,
    currency_id: eurId,
    amount: 100,
    date: '2026-04-10',
    payment_type: 'inbound',
    partner_type: 'customer',
  });
  db = postPayment(payRes.db, read(payRes.db, 'account.payment', payRes.id));
  const payment = read(db, 'account.payment', payRes.id);

  const lineRes = create(db, 'account.bank.statement.line', {
    journal_id: bankJournalId,
    payment_ref: 'Old EUR statement line',
    amount: 100,
    date: '2026-04-10',
  });
  db = lineRes.db;
  const lineId = lineRes.id;
  const lineBefore = read(db, 'account.bank.statement.line', lineId);
  assert.equal(lineBefore.currency_id, eurId);

  const woLineRes = create(db, 'account.bank.statement.line', {
    journal_id: bankJournalId,
    payment_ref: 'Old EUR statement line with fee writeoff',
    amount: 95,
    date: '2026-04-10',
  });
  db = woLineRes.db;
  const woLineId = woLineRes.id;

  const woPayRes = create(db, 'account.payment', {
    partner_id: partner.id,
    company_id: companyId,
    journal_id: bankJournalId,
    currency_id: eurId,
    amount: 100,
    date: '2026-04-10',
    payment_type: 'inbound',
    partner_type: 'customer',
  });
  db = postPayment(woPayRes.db, read(woPayRes.db, 'account.payment', woPayRes.id));
  const woPayment = read(db, 'account.payment', woPayRes.id);

  // Change journal currency to company currency
  db = write(db, 'account.journal', bankJournalId, { currency_id: companyCurr });
  assert.equal(read(db, 'account.journal', bankJournalId).currency_id, companyCurr);

  // Also post a payment in the journal's new currency; it must NOT match the old EUR line
  const newCurrPayRes = create(db, 'account.payment', {
    partner_id: partner.id,
    company_id: companyId,
    journal_id: bankJournalId,
    currency_id: companyCurr,
    amount: 100,
    date: '2026-04-10',
    payment_type: 'inbound',
    partner_type: 'customer',
  });
  db = postPayment(newCurrPayRes.db, read(newCurrPayRes.db, 'account.payment', newCurrPayRes.id));
  const newCurrPayment = read(db, 'account.payment', newCurrPayRes.id);

  // Existing statement line retains its EUR currency
  const lineAfter = read(db, 'account.bank.statement.line', lineId);
  assert.equal(lineAfter.currency_id, eurId);

  // Payment matching must accept the EUR payment and reject the new-currency payment
  assert.equal(paymentMatchError(db, lineAfter, payment), null);
  assert.match(paymentMatchError(db, lineAfter, newCurrPayment) ?? '', /currency/i);
  const eligibleIds = eligiblePayments(db, lineAfter).map((p) => p.id);
  assert.ok(eligibleIds.includes(payment.id));
  assert.ok(!eligibleIds.includes(newCurrPayment.id));

  const matched = matchPayment(db, { ...lineAfter, payment_id: payment.id });
  const reconciledLine = read(matched.db, 'account.bank.statement.line', lineId);
  assert.equal(reconciledLine.state, 'reconciled');
  const matchMove = read(matched.db, 'account.move', reconciledLine.move_id);
  const matchBankLine = matchMove.line_ids.find((l) => l.account_id === defaultAccount.id);
  const matchOutLine = matchMove.line_ids.find((l) => l.account_id === outstandingReceipts);
  assert.equal(matchBankLine.currency_id, eurId);
  assert.equal(matchBankLine.amount_currency, 100);
  assert.equal(matchBankLine.debit, 200);
  assert.equal(matchOutLine.currency_id, eurId);
  assert.equal(matchOutLine.amount_currency, -100);
  assert.equal(matchOutLine.credit, 200);

  // Matching with a write-off difference also uses the statement line's EUR currency
  const woLineAfter = read(matched.db, 'account.bank.statement.line', woLineId);
  const woMatched = matchPayment(matched.db, {
    ...woLineAfter,
    payment_id: woPayment.id,
    writeoff_account_id: feeAccount.id,
    writeoff_label: 'EUR bank fee',
    writeoff_amount: 5,
  });
  const woReconciled = read(woMatched.db, 'account.bank.statement.line', woLineId);
  assert.equal(woReconciled.state, 'reconciled');
  const woMove = read(woMatched.db, 'account.move', woReconciled.move_id);
  const woFeeLine = woMove.line_ids.find((l) => l.account_id === feeAccount.id);
  assert.ok(woFeeLine);
  assert.equal(woFeeLine.currency_id, eurId);
  assert.equal(woFeeLine.amount_currency, 5);
  assert.equal(woFeeLine.debit, 10);
});

test('JCF-8: reconciliation-rule write-off on an old-currency line after journal currency changes', () => {
  let db = seed();
  const companyId = 1;
  const companyCurr = read(db, 'res.company', companyId).currency_id;

  const eurRes = create(db, 'res.currency', {
    name: 'EUR',
    symbol: '€',
    rounding: 0.01,
    rate_ids: [{ date: '2026-01-01', rate: 0.5, company_id: companyId }],
  });
  db = eurRes.db;
  const eurId = eurRes.id;

  const defaultAccount = search(db, 'account.account').find((a) => a.account_type === 'asset_cash');
  const suspenseAccount = search(db, 'account.account').find((a) => a.code === '101404');
  const feeAccount = search(db, 'account.account').find((a) => a.code === '600000') ?? search(db, 'account.account').find((a) => a.account_type === 'expense');

  const bankJournalRes = create(db, 'account.journal', {
    name: 'EUR Bank 2',
    code: 'EUB2',
    type: 'bank',
    currency_id: eurId,
    company_id: companyId,
    default_account_id: defaultAccount.id,
    suspense_account_id: suspenseAccount.id,
  });
  db = bankJournalRes.db;
  const bankJournalId = bankJournalRes.id;

  const lineRes = create(db, 'account.bank.statement.line', {
    journal_id: bankJournalId,
    payment_ref: 'Old EUR fee line',
    amount: -50,
    date: '2026-04-10',
  });
  db = lineRes.db;
  const lineId = lineRes.id;
  const lineBefore = read(db, 'account.bank.statement.line', lineId);
  assert.equal(lineBefore.currency_id, eurId);

  // Change journal currency to company currency
  db = write(db, 'account.journal', bankJournalId, { currency_id: companyCurr });
  assert.equal(read(db, 'account.journal', bankJournalId).currency_id, companyCurr);

  // Existing statement line retains its EUR currency
  const lineAfter = read(db, 'account.bank.statement.line', lineId);
  assert.equal(lineAfter.currency_id, eurId);

  const rule = {
    name: 'Bank Fee Writeoff',
    rule_type: 'writeoff_button',
    line_ids: [{ account_id: feeAccount.id, amount_type: 'percentage', amount: 100 }],
  };

  const nextDb = applyRule(db, rule, lineAfter);
  const reconciledLine = read(nextDb, 'account.bank.statement.line', lineId);
  assert.equal(reconciledLine.state, 'reconciled');

  // Verify posted entry lines are tagged with the line's recorded currency (EUR), not the journal's new currency
  const entry = read(nextDb, 'account.move', reconciledLine.move_id ?? reconciledLine.bank_move_id ?? reconciledLine.allocations?.[0]?.payment_move_id);
  assert.ok(entry, 'A write-off entry was posted');
  const feeLine = entry.line_ids.find((l) => l.account_id === feeAccount.id);
  assert.ok(feeLine, 'Fee line exists in entry');
  assert.equal(feeLine.currency_id, eurId, 'Counterpart item currency must be the line original currency (EUR)');
  assert.equal(feeLine.amount_currency, 50, 'Counterpart amount_currency must equal line amount in original currency');
  assert.equal(feeLine.debit, 100, 'Counterpart debit must equal converted company amount');
  const bankLine = entry.line_ids.find((l) => l.account_id === defaultAccount.id);
  assert.ok(bankLine, 'Bank line exists in entry');
  assert.equal(bankLine.currency_id, eurId, 'Bank item currency must be the line original currency (EUR)');
  assert.equal(bankLine.amount_currency, -50, 'Bank amount_currency must equal signed line amount in original currency');
  assert.equal(bankLine.credit, 100, 'Bank credit must equal converted company amount');
});
