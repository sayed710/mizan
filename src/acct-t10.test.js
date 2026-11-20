import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { applyDiff, diffDb } from './sync.js';
import { seed } from './seed.js';
import { menusFor, models } from './models/index.js';

const loadArabicT = async () => {
  const prev = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {} };
  try {
    return (await import(`./i18n.js?ar=t10-${Date.now()}`)).t;
  } finally {
    globalThis.localStorage = prev;
  }
};

test('TAX-6: fiscal position account mapping rejects cross-company source accounts for company-specific positions', () => {
  let db = seed();
  const c2 = create(db, 'res.company', { name: 'Second Co', currency_id: read(db, 'res.company', 1).currency_id });
  db = c2.db;

  const accC1Src = create(db, 'account.account', { name: 'C1 Income', code: '401001', account_type: 'income', company_id: 1 });
  db = accC1Src.db;
  const accC2Src = create(db, 'account.account', { name: 'C2 Income', code: '402001', account_type: 'income', company_id: c2.id });
  db = accC2Src.db;
  const accC2Dest = create(db, 'account.account', { name: 'C2 Alt Income', code: '402002', account_type: 'income', company_id: c2.id });
  db = accC2Dest.db;

  // Valid: both source and destination belong to C2
  const validFp = create(db, 'account.fiscal.position', {
    name: 'Valid C2 FP',
    company_id: c2.id,
    account_ids: [{ account_src_id: accC2Src.id, account_dest_id: accC2Dest.id }],
  });
  const syncedValid = applyDiff(db, diffDb(db, validFp.db), { isAdmin: true });
  assert.equal(read(syncedValid, 'account.fiscal.position', validFp.id).name, 'Valid C2 FP');

  // Direct creation or diffDb + applyDiff with C1 source account in C2 fiscal position must fail
  const forgedBadSrc = {
    ...syncedValid,
    records: {
      ...syncedValid.records,
      'account.fiscal.position': syncedValid.records['account.fiscal.position'].map((fp) => (
        fp.id === validFp.id ? { ...fp, account_ids: [{ account_src_id: accC1Src.id, account_dest_id: accC2Dest.id }] } : fp
      )),
    },
  };
  assert.throws(
    () => applyDiff(syncedValid, diffDb(syncedValid, forgedBadSrc), { isAdmin: true }),
    /Fiscal position source account must belong to the fiscal position company/i,
  );
});

test('TAX-6: shared fiscal position (no company_id) rejects mapping lines where source and destination belong to different companies', () => {
  let db = seed();
  const c2 = create(db, 'res.company', { name: 'Second Co', currency_id: read(db, 'res.company', 1).currency_id });
  db = c2.db;

  const accC1Src = create(db, 'account.account', { name: 'C1 Income', code: '401001', account_type: 'income', company_id: 1 });
  db = accC1Src.db;
  const accC1Dest = create(db, 'account.account', { name: 'C1 Alt Income', code: '401002', account_type: 'income', company_id: 1 });
  db = accC1Dest.db;
  const accC2Dest = create(db, 'account.account', { name: 'C2 Alt Income', code: '402002', account_type: 'income', company_id: c2.id });
  db = accC2Dest.db;

  // Valid shared FP: source and destination belong to the same company (C1 -> C1)
  const validShared = create(db, 'account.fiscal.position', {
    name: 'Shared C1 FP',
    account_ids: [{ account_src_id: accC1Src.id, account_dest_id: accC1Dest.id }],
  });
  const syncedShared = applyDiff(db, diffDb(db, validShared.db), { isAdmin: true });
  assert.equal(read(syncedShared, 'account.fiscal.position', validShared.id).name, 'Shared C1 FP');

  // Invalid: C1 source mapped to C2 destination in a shared fiscal position
  const forgedMismatchedPair = {
    ...syncedShared,
    records: {
      ...syncedShared.records,
      'account.fiscal.position': syncedShared.records['account.fiscal.position'].map((fp) => (
        fp.id === validShared.id ? { ...fp, account_ids: [{ account_src_id: accC1Src.id, account_dest_id: accC2Dest.id }] } : fp
      )),
    },
  };
  assert.throws(
    () => applyDiff(syncedShared, diffDb(syncedShared, forgedMismatchedPair), { isAdmin: true }),
    /same company/i,
  );
});

test('TAX-6: guard error messages have Arabic translations in i18n', async () => {
  const tAr = await loadArabicT();
  const srcErr = 'Fiscal position source account must belong to the fiscal position company';
  const destErr = 'Fiscal position destination account must belong to the fiscal position company';
  const sharedErr = 'Both accounts of a fiscal position mapping line must belong to the same company';

  assert.notEqual(tAr(srcErr), srcErr, `Missing translation for: ${srcErr}`);
  assert.match(tAr(srcErr), /[\u0600-\u06FF]/);
  assert.notEqual(tAr(destErr), destErr, `Missing translation for: ${destErr}`);
  assert.match(tAr(destErr), /[\u0600-\u06FF]/);
  assert.notEqual(tAr(sharedErr), sharedErr, `Missing translation for: ${sharedErr}`);
  assert.match(tAr(sharedErr), /[\u0600-\u06FF]/);
});

test('FX-16: Unrealized Currencies menu is located under Reporting > Management', () => {
  const reviewReg = menusFor('accounting').find((m) => m.label === 'Review')?.children?.find((m) => m.label === 'Regularization Entries');
  const reviewUnrealized = reviewReg?.children?.find((m) => m.key === 'unrealized-currencies' || m.report === 'unrealizedCurrencies');
  assert.equal(reviewUnrealized, undefined, 'Unrealized Currencies should no longer be under Review > Regularization Entries');

  const reportingMgmt = menusFor('accounting').find((m) => m.label === 'Reporting')?.children?.find((m) => m.label === 'Management');
  const mgmtUnrealized = reportingMgmt?.children?.find((m) => m.key === 'unrealized-currencies');
  assert.ok(mgmtUnrealized, 'Unrealized Currencies should be under Reporting > Management');
  assert.equal(mgmtUnrealized.report, 'unrealizedCurrencies');
  assert.equal(mgmtUnrealized.type, 'report');
});

test('JE-25: account.move ref and narration fields have tracking enabled and log changes in chatter', () => {
  const moveFields = models['account.move'].fields;
  assert.equal(moveFields.ref.tracking, true, 'account.move.ref must have tracking: true');
  assert.equal(moveFields.narration.tracking, true, 'account.move.narration must have tracking: true');

  let db = seed();
  const move = create(db, 'account.move', { move_type: 'entry', ref: 'Old Ref', narration: 'Old Terms' });
  db = move.db;

  const db1 = write(db, 'account.move', move.id, { ref: 'New Ref' });
  const refMsg = db1.messages.find((m) => m.model === 'account.move' && m.res_id === move.id && m.field === 'ref');
  assert.ok(refMsg, 'Updating ref must create a tracking message in chatter');
  assert.match(refMsg.body, /Old Ref/);
  assert.match(refMsg.body, /New Ref/);

  const db2 = write(db1, 'account.move', move.id, { narration: 'New Terms' });
  const narMsg = db2.messages.find((m) => m.model === 'account.move' && m.res_id === move.id && m.field === 'narration');
  assert.ok(narMsg, 'Updating narration must create a tracking message in chatter');
  assert.match(narMsg.body, /Old Terms/);
  assert.match(narMsg.body, /New Terms/);
});
