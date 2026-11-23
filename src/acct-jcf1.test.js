import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { accountId, postEntry } from './models/ledger.js';
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
