import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { models } from './models/index.js';
import { accountId } from './models/ledger.js';
import { applyRule } from './models/reconcile.js';
import { syncDueOnlineLinks } from './models/onlineSync.js';
import { runScheduledJobs } from './models/scheduler.js';
import { applyDiff, diffDb } from './sync.js';
import { seed } from './seed.js';

const MODEL = 'account.reconcile.model';
const LINE = 'account.bank.statement.line';
const LINK = 'account.online.link';

const bankJournals = (db) => search(db, 'account.journal').filter((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
const addLine = (db, vals) => create(db, LINE, { journal_id: bankJournals(db)[0].id, date: '2026-10-01', state: 'to_check', ...vals });
const addRule = (db, vals) => create(db, MODEL, { name: 'B20 Test Rule', ...vals });

test('BANK-20: reconciliation model counterpart lines have analytic_distribution shown on form and post analytic items', () => {
  const base = seed();
  const feeAcc = accountId(base, '600000');
  const plan = create(base, 'account.analytic.plan', { name: 'Projects' });
  const analyticAcc = create(plan.db, 'account.analytic.account', { name: 'Project Alpha', plan_id: plan.id });
  let db = analyticAcc.db;

  // 1. Counterpart field is declared and shown on model form lines (not hidden by default)
  const lineField = models[MODEL].fields.line_ids.fields.analytic_distribution;
  assert.ok(lineField, 'analytic_distribution field is declared on counterpart items');
  assert.equal(lineField.type, 'distribution');
  assert.notEqual(lineField.optional, 'hide', 'analytic_distribution is shown on the model form lines table');

  // 2. Creating a model with counterpart line carrying analytic_distribution
  const r = addRule(db, {
    name: 'Fee with Analytic B20',
    line_ids: [{
      sequence: 10,
      account_id: feeAcc,
      label: 'Bank Fee',
      amount_type: 'percentage',
      amount_string: '100',
      analytic_distribution: { [analyticAcc.id]: 100 },
    }],
  });
  db = r.db;
  const savedRule = read(db, MODEL, r.id);
  assert.deepEqual(savedRule.line_ids[0].analytic_distribution, { [analyticAcc.id]: 100 });

  // 3. Applying the model posts write-off journal item with analytic_distribution and creates account.analytic.line
  const stLine = addLine(db, { payment_ref: 'Service Charge Oct B20', amount: -60 });
  db = stLine.db;
  const after = applyRule(db, savedRule, read(db, LINE, stLine.id));
  const updatedLine = read(after, LINE, stLine.id);
  assert.equal(updatedLine.state, 'reconciled');

  const move = read(after, 'account.move', updatedLine.move_id);
  assert.ok(move, 'Write-off move created');
  const counterpartItem = move.line_ids.find((l) => l.account_id === feeAcc);
  assert.ok(counterpartItem, 'Counterpart fee line exists in move');
  assert.deepEqual(counterpartItem.analytic_distribution, { [analyticAcc.id]: 100 }, 'Move line receives analytic distribution');

  const analyticLines = search(after, 'account.analytic.line').filter((l) => l.move_id === move.id);
  assert.equal(analyticLines.length, 1, 'Analytic line item posted');
  assert.equal(analyticLines[0].account_id, analyticAcc.id);
  assert.equal(analyticLines[0].amount, -60);

  // 4. Guard and diffDb + applyDiff: valid distribution passes, foreign company analytic account rejected
  const validRuleDb = {
    ...db,
    records: {
      ...db.records,
      [MODEL]: [...(db.records[MODEL] ?? []), {
        id: 9992,
        name: 'Valid Analytic Model',
        company_id: 1,
        sequence: 10,
        trigger: 'manual',
        rule_type: 'reco_model',
        line_ids: [{ sequence: 10, account_id: feeAcc, amount_type: 'percentage', amount_string: '100', analytic_distribution: { [analyticAcc.id]: 100 } }],
      }],
    },
  };
  const validDiff = diffDb(db, validRuleDb);
  const appliedValid = applyDiff(db, validDiff, { isAdmin: true });
  assert.ok(read(appliedValid, MODEL, 9992), 'Valid rule with analytic distribution passes applyDiff');

  const co2 = create(db, 'res.company', { name: 'Company 2', currency_id: 1 });
  const co2Plan = create(co2.db, 'account.analytic.plan', { name: 'Co2 Plan' });
  const foreignAnalytic = create(co2Plan.db, 'account.analytic.account', { name: 'Foreign Project', company_id: co2.id, plan_id: co2Plan.id });
  db = foreignAnalytic.db;
  const badCompanyRule = {
    ...db,
    records: {
      ...db.records,
      [MODEL]: [...(db.records[MODEL] ?? []), {
        id: 9991,
        name: 'Foreign Company Analytic',
        company_id: 1,
        sequence: 10,
        trigger: 'manual',
        rule_type: 'reco_model',
        line_ids: [{ sequence: 10, account_id: feeAcc, amount_type: 'percentage', amount_string: '100', analytic_distribution: { [foreignAnalytic.id]: 100 } }],
      }],
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, badCompanyRule), { isAdmin: true }), /Analytic accounts in the distribution must belong to the model company/);
});

test('BANK-21: scheduled online bank sync job syncs due links, skips recent links, and keeps going past failing links', () => {
  let db = seed();
  const journals = bankJournals(db);
  const j1 = journals[0];
  const j2 = makeBankJournal(db, { name: 'Sync Bank 2', code: 'SBK2' });
  db = j2.db;
  const journal2 = read(db, 'account.journal', j2.id);
  const j3 = makeBankJournal(db, { name: 'Sync Bank 3', code: 'SBK3' });
  db = j3.db;
  const journal3 = read(db, 'account.journal', j3.id);
  const j4 = makeBankJournal(db, { name: 'Sync Bank 4', code: 'SBK4' });
  db = j4.db;
  const journal4 = read(db, 'account.journal', j4.id);
  const j5 = makeBankJournal(db, { name: 'Sync Bank 5', code: 'SBK5' });
  db = j5.db;
  const journal5 = read(db, 'account.journal', j5.id);

  // Link 1: DUE link (last_refresh was 3 days ago; sync_interval: 24h)
  const link1Res = create(db, LINK, {
    name: 'Due Bank Link',
    provider: 'demo',
    state: 'connected',
    last_refresh: '2026-06-01T10:00:00Z',
    sync_interval: 24,
    demo_transactions: {
      'ACC-DUE': {
        '': {
          transactions: [{ unique_import_id: 'TX-DUE-1', date: '2026-06-04', amount: 300, payment_ref: 'Due wire' }],
          nextCursor: 'cur-due',
          balance: 300,
        },
      },
    },
    account_ids: [{ name: 'Due Account', account_number: 'ACC-DUE', journal_id: j1.id }],
  });
  db = link1Res.db;
  const link1Id = link1Res.id;

  // Link 2: RECENT link (last_refresh was 1 hour ago at 2026-06-04T11:00:00Z; interval 24h)
  const link2Res = create(db, LINK, {
    name: 'Recent Bank Link',
    provider: 'demo',
    state: 'connected',
    last_refresh: '2026-06-04T11:00:00Z',
    sync_interval: 24,
    demo_transactions: {
      'ACC-REC': {
        '': {
          transactions: [{ unique_import_id: 'TX-REC-1', date: '2026-06-04', amount: 150, payment_ref: 'Recent wire' }],
          nextCursor: 'cur-rec',
          balance: 150,
        },
      },
    },
    account_ids: [{ name: 'Recent Account', account_number: 'ACC-REC', journal_id: journal2.id }],
  });
  db = link2Res.db;
  const link2Id = link2Res.id;

  // Link 3: FAILING link (provider returns error)
  const link3Res = create(db, LINK, {
    name: 'Failing Bank Link',
    provider: 'demo',
    state: 'connected',
    last_refresh: '2026-06-01T10:00:00Z',
    sync_interval: 24,
    demo_transactions: {
      'ACC-FAIL': {
        '': {
          error: 'Bank API connection refused',
        },
      },
    },
    account_ids: [{ name: 'Fail Account', account_number: 'ACC-FAIL', journal_id: journal3.id }],
  });
  db = link3Res.db;
  const link3Id = link3Res.id;

  // Disconnected and archived links
  const discRes = create(db, LINK, {
    name: 'Disconnected Link',
    provider: 'demo',
    state: 'disconnected',
    last_refresh: '2026-05-01T10:00:00Z',
    account_ids: [{ name: 'Disc Account', account_number: 'ACC-DISC', journal_id: journal4.id }],
  });
  db = discRes.db;
  const discId = discRes.id;

  const archRes = create(db, LINK, {
    name: 'Archived Link',
    provider: 'demo',
    state: 'connected',
    active: false,
    last_refresh: '2026-05-01T10:00:00Z',
    account_ids: [{ name: 'Arch Account', account_number: 'ACC-ARCH', journal_id: journal5.id }],
  });
  db = archRes.db;
  const archId = archRes.id;

  // Run the scheduler jobs at 2026-06-04T12:00:00Z
  const at = '2026-06-04T12:00:00Z';
  const afterScheduled = runScheduledJobs(db, at);

  // Verify Link 1 was DUE and got synced
  const updatedLink1 = read(afterScheduled, LINK, link1Id);
  assert.equal(updatedLink1.state, 'connected');
  assert.equal(updatedLink1.last_refresh, at, 'Due link last_refresh was updated to scheduler time');
  const importedTx1 = search(afterScheduled, LINE).find((l) => l.unique_import_id === 'TX-DUE-1');
  assert.ok(importedTx1, 'Due link transactions were imported');
  assert.equal(importedTx1.amount, 300);

  // Verify Link 2 was RECENT and got SKIPPED
  const updatedLink2 = read(afterScheduled, LINK, link2Id);
  assert.equal(updatedLink2.last_refresh, '2026-06-04T11:00:00Z', 'Recent link last_refresh was preserved');
  const importedTx2 = search(afterScheduled, LINE).find((l) => l.unique_import_id === 'TX-REC-1');
  assert.equal(importedTx2, undefined, 'Recent link transactions were NOT imported');

  // Verify Link 3 FAILED and recorded its error, without stopping Link 1
  const updatedLink3 = read(afterScheduled, LINK, link3Id);
  assert.equal(updatedLink3.state, 'error', 'Failing link transition to error state');
  assert.equal(updatedLink3.error_message, 'Bank API connection refused', 'Failing link recorded error message');

  // Verify disconnected and archived links are ignored
  assert.equal(read(afterScheduled, LINK, discId).state, 'disconnected');
  assert.equal(read(afterScheduled, LINK, discId).last_refresh, '2026-05-01T10:00:00Z');
  assert.equal(read(afterScheduled, LINK, archId).last_refresh, '2026-05-01T10:00:00Z');

  // Verify direct syncDueOnlineLinks call produces same behavior
  const directSyncDb = syncDueOnlineLinks(db, at);
  assert.equal(read(directSyncDb, LINK, link1Id).state, 'connected');
  assert.equal(read(directSyncDb, LINK, link2Id).last_refresh, '2026-06-04T11:00:00Z');
  assert.equal(read(directSyncDb, LINK, link3Id).state, 'error');

  // Guard test on account.online.link via diffDb + applyDiff
  const badIntervalLink = {
    ...db,
    records: {
      ...db.records,
      [LINK]: [...(db.records[LINK] ?? []), {
        id: 9994,
        name: 'Invalid Interval Link',
        provider: 'demo',
        state: 'not_synchronized',
        sync_interval: -10,
      }],
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, badIntervalLink), { isAdmin: true }), /Sync interval must be a positive number/);
});

function makeBankJournal(db, { name, code }) {
  let nextDb = db;
  let cashAcc = create(nextDb, 'account.account', { code: `1019${code}`, name: `${name} Cash`, account_type: 'asset_cash', company_id: 1 });
  nextDb = cashAcc.db;
  let suspAcc = create(nextDb, 'account.account', { code: `1049${code}`, name: `${name} Suspense`, account_type: 'asset_current', company_id: 1 });
  nextDb = suspAcc.db;
  return create(nextDb, 'account.journal', {
    name,
    code,
    type: 'bank',
    company_id: 1,
    default_account_id: cashAcc.id,
    suspense_account_id: suspAcc.id,
    bank_statements_source: 'undefined',
  });
}
