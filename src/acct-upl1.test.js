import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { seed } from './seed.js';
import { create, read, search, write } from './orm.js';
import { applyDiff, assignIds, diffDb } from './sync.js';
import { createCompany, setCompanies } from './models/company.js';
import { apps, findLeaf } from './models/index.js';
import { createUploadedMoves, MAX_SERVER_DIFF_BYTES, MAX_UPLOAD_BATCH_BYTES, uploadMoves } from './views/uploadMoves.js';
import { finishDigitizedBill } from '../server/integrations.js';
import { applyDigitizedBill } from '../server/digitized-store.js';
import { setupDom } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const allFind = (root, pred, out = []) => {
  if (!root) return out;
  if (pred(root)) out.push(root);
  for (const child of root.childNodes ?? []) allFind(child, pred, out);
  return out;
};

const file = (name) => ({ name, type: 'application/pdf', size: 1, data: 'data:application/pdf;base64,AA==' });
const largeFile = (name, rawBytes = 2 * 1024 * 1024) => {
  const b64 = Buffer.alloc(rawBytes, 65).toString('base64');
  return { name, type: 'application/pdf', size: rawBytes, data: `data:application/pdf;base64,${b64}` };
};
const options = { moveType: 'in_invoice', companyId: 1 };

async function mountActionView(db, { base, leafKey, query, serverHandler }) {
  const prevStorage = globalThis.localStorage;
  const prevLocation = globalThis.location;
  const prevFetch = globalThis.fetch;
  const prevAlert = globalThis.alert;
  const prevFileReader = globalThis.FileReader;
  const origSetInterval = globalThis.setInterval;
  const mem = new Map();
  const alerts = [];
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), clear: () => mem.clear() };
  setupDom();
  const origCreate = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const el = origCreate(tag);
    el.insertBefore = (child, before) => {
      const idx = before ? el.childNodes.indexOf(before) : -1;
      if (idx >= 0) el.childNodes.splice(idx, 0, child);
      else el.childNodes.push(child);
      child.parentNode = el;
      if (child.tagName === 'OPTION') el.options.push(child);
      return el;
    };
    return el;
  };
  globalThis.document.createElementNS = (_, tag) => globalThis.document.createElement(tag);
  globalThis.location = { hash: `${base}?${query}`, replace(h) { this.hash = h; } };
  globalThis.alert = (msg) => alerts.push(msg);
  globalThis.setInterval = () => 0;
  globalThis.FileReader = class {
    readAsDataURL(f) {
      queueMicrotask(() => {
        if (f._failRead) {
          this.onerror?.();
          return;
        }
        this.result = f._dataUrl ?? `data:${f.type || 'application/pdf'};base64,${Buffer.alloc(f.size ?? 1, 65).toString('base64')}`;
        this.onload?.();
      });
    }
  };
  let serverDb = db;
  globalThis.fetch = async (url, init) => {
    if (url === '/api/session') return new Response(JSON.stringify({ name: 'Admin', isAdmin: true, integrations: { ai: false } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url === '/api/db') return new Response(JSON.stringify(serverDb), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url === '/api/diff') {
      const byteSize = Buffer.byteLength(init.body, 'utf8');
      if (byteSize > MAX_SERVER_DIFF_BYTES) return new Response(JSON.stringify({ error: 'Request too large', db: serverDb }), { status: 413, headers: { 'Content-Type': 'application/json' } });
      if (serverHandler) {
        const res = await serverHandler(serverDb, JSON.parse(init.body), byteSize);
        if (res.status && res.status >= 400) return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json' } });
        serverDb = res.db;
        return new Response(JSON.stringify(res.remapped && Object.keys(res.remapped).length ? { ...serverDb, remapped: res.remapped } : serverDb), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const assigned = assignIds(serverDb, JSON.parse(init.body));
      serverDb = applyDiff(serverDb, assigned.diff, { isAdmin: true });
      return new Response(JSON.stringify(Object.keys(assigned.remapped).length ? { ...serverDb, remapped: assigned.remapped } : serverDb), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  const { ActionView } = await import('./views/ActionView.jsx');
  const leaf = findLeaf(apps.find((a) => a.id === 'accounting'), leafKey);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => { await store.initStore(); });
  await React.act(async () => {
    root.render(React.createElement(ActionView, { leaf, base, params: new URLSearchParams(query) }));
  });
  return {
    React,
    host,
    store,
    alerts,
    getServerDb: () => serverDb,
    uploadInput: () => allFind(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'file' && props(n)?.multiple)[0],
    done: async () => {
      globalThis.fetch = () => Promise.reject(new Error('offline'));
      await React.act(async () => root.unmount());
      globalThis.fetch = prevFetch;
      globalThis.alert = prevAlert;
      globalThis.location = prevLocation;
      globalThis.localStorage = prevStorage;
      globalThis.FileReader = prevFileReader;
      globalThis.setInterval = origSetInterval;
      await store.initStore();
    },
  };
}

test('each uploaded bill is a draft in the purchase journal with a linked file and passes diff guards', () => {
  const db = seed();
  const result = createUploadedMoves(db, [file('one.pdf'), file('two.pdf')], options);
  const saved = applyDiff(db, diffDb(db, result.db), { isAdmin: true });
  const journal = read(db, 'res.company', 1).default_purchase_journal_id;
  assert.equal(result.ids.length, 2);
  for (const [i, id] of result.ids.entries()) {
    const move = read(saved, 'account.move', id);
    assert.equal(move.move_type, 'in_invoice'); assert.equal(move.state, 'draft'); assert.equal(move.journal_id, journal);
    const doc = search(saved, 'documents.document').find((d) => d.res_model === 'account.move' && d.res_id === id);
    assert.equal(doc.file.name, ['one.pdf', 'two.pdf'][i]);
  }
});

test('sales journal card creates an invoice in its journal', () => {
  const db = seed();
  const journal = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id ?? 1) === 1);
  const result = createUploadedMoves(db, [file('invoice.pdf')], { moveType: 'out_invoice', companyId: 1, journalId: journal.id });
  const invoice = read(result.db, 'account.move', result.ids[0]);
  assert.equal(invoice.journal_id, journal.id); assert.equal(invoice.move_type, 'out_invoice'); assert.equal(invoice.state, 'draft');
});

test('without AI several files create drafts and navigate to selected ids, without digitization', async () => {
  let db = seed(); let calls = 0;
  const result = await uploadMoves([file('a.pdf'), file('b.pdf')], options, { getDb: () => db, commit: async (next) => { db = next; return { ok: true }; }, ai: false, digitize: async () => { calls++; } });
  assert.equal(calls, 0); assert.equal(result.ids.length, 2);
  assert.equal(result.go, `#/accounting/bills?view=list&rel=id:${result.ids.join(',')}`);
  assert.ok(result.ids.every((id) => read(db, 'account.move', id).state === 'draft'));
});

test('AI fills uploaded bill without posting and single file navigates to form', async () => {
  let db = seed(); let base; const oldFetch = globalThis.fetch; const oldKey = process.env.ANTHROPIC_API_KEY;
  const vendor = search(db, 'res.partner')[0];
  db = write(write(db, 'res.company', 1, { autopost_bills: true }), 'res.partner', vendor.id, { autopost_bills: 'always' });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  globalThis.fetch = async () => new Response(JSON.stringify({ content: [{ type: 'tool_use', input: { vendor: vendor.name, lines: [] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const store = { get: () => { base = db; return db; }, commit: (next) => { db = next; }, commitDigitizedBill: (next, id) => { db = applyDigitizedBill(db, base, next, id, { isAdmin: true }); } };
  try {
    const result = await uploadMoves([file('a.pdf')], options, { getDb: () => db, commit: async (next) => { db = next; return { ok: true }; }, ai: true, digitize: (input) => finishDigitizedBill(store, input) });
    assert.deepEqual(result.errors, []); assert.equal(result.go, `#/accounting/bills/${result.ids[0]}`);
    assert.equal(read(db, 'account.move', result.ids[0]).state, 'draft'); assert.equal(read(db, 'account.move', result.ids[0]).digitized_document, true);
  } finally { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldKey; }
});

test('Arabic upload labels are present in UTF-8', () => {
  const source = readFileSync(new URL('./i18n.js', import.meta.url), 'utf8');
  assert.match(source, /'Upload': 'رفع'/); assert.match(source, /'Could not read file': 'تعذرت قراءة الملف'/);
});

test('remapped ids are used for digitization and navigation; invoices do not call digitization', async () => {
  let db = seed(); let calls = 0;
  const save = async (next) => { db = next; const id = next.seq['account.move']; return { ok: true, remapped: { 'account.move': { [id]: 999 } } }; };
  const bill = await uploadMoves([file('bill.pdf')], options, { getDb: () => db, commit: save, ai: true, digitize: async ({ id, draft_only }) => { calls++; assert.equal(id, 999); assert.equal(draft_only, true); } });
  assert.equal(bill.go, '#/accounting/bills/999');
  const invoice = await uploadMoves([file('invoice.pdf')], { moveType: 'out_invoice', companyId: 1 }, { getDb: () => db, commit: save, ai: true, digitize: async () => { calls++; } });
  assert.equal(invoice.go, '#/accounting/invoices/999'); assert.equal(calls, 1);
});

test('ActionView normal two-file upload creates drafts in company default journal and navigates to list of created IDs', async () => {
  const db = seed();
  const defaultPurchase = read(db, 'res.company', 1).default_purchase_journal_id;
  const ctx = await mountActionView(db, { base: '#/accounting/bills', leafKey: 'bills', query: 'view=list' });
  try {
    const input = ctx.uploadInput();
    assert.ok(input, 'Upload input renders on bills list');
    const target = { files: [{ name: 'bill-one.pdf', type: 'application/pdf', size: 16 }, { name: 'bill-two.pdf', type: 'application/pdf', size: 16 }], value: 'chosen' };
    await ctx.React.act(async () => { await props(input).onChange({ target }); });
    assert.deepEqual(ctx.alerts, []);
    const createdBills = search(ctx.getServerDb(), 'account.move').filter((m) => m.move_type === 'in_invoice' && !db.records['account.move'].some((orig) => orig.id === m.id));
    assert.equal(createdBills.length, 2);
    for (const [idx, bill] of createdBills.entries()) {
      assert.equal(bill.state, 'draft');
      assert.equal(bill.company_id, 1);
      assert.equal(bill.journal_id, defaultPurchase);
      const doc = search(ctx.getServerDb(), 'documents.document').find((d) => d.res_model === 'account.move' && d.res_id === bill.id);
      assert.equal(doc.file.name, ['bill-one.pdf', 'bill-two.pdf'][idx]);
    }
    assert.equal(globalThis.location.hash, `#/accounting/bills?view=list&rel=id:${createdBills.map((b) => b.id).join(',')}`);
  } finally {
    await ctx.done();
  }
});

test('ActionView journal-filtered upload uses selected journal and its allowed company instead of active company default', async () => {
  let db = seed();
  const currencyId = read(db, 'res.company', 1).currency_id;
  const comp2 = createCompany(db, { name: 'Branch Co', currency_id: currencyId });
  db = setCompanies(comp2.db, { current: 1, allowed: [1, comp2.id] });
  const expAcc = create(db, 'account.account', { code: '600001', name: 'Branch Expense', account_type: 'expense', company_id: comp2.id });
  const branchPurchase = create(expAcc.db, 'account.journal', { name: 'Branch Bills', code: 'BBILL', type: 'purchase', company_id: comp2.id, default_account_id: expAcc.id, invoice_sequence_prefix: 'BB/' });
  const altPurchase = create(branchPurchase.db, 'account.journal', { name: 'Alt Bills', code: 'ABILL', type: 'purchase', company_id: comp2.id, default_account_id: expAcc.id, invoice_sequence_prefix: 'AB/' });
  db = altPurchase.db;
  const activeDefault = read(db, 'res.company', 1).default_purchase_journal_id;
  assert.notEqual(altPurchase.id, activeDefault);

  const ctx = await mountActionView(db, { base: '#/accounting/bills', leafKey: 'bills', query: `view=list&rel=journal_id:${altPurchase.id}` });
  try {
    const input = ctx.uploadInput();
    await ctx.React.act(async () => {
      await props(input).onChange({ target: { files: [{ name: 'branch-bill.pdf', type: 'application/pdf', size: 12 }], value: 'x' } });
    });
    assert.deepEqual(ctx.alerts, []);
    const created = search(ctx.getServerDb(), 'account.move').filter((m) => !db.records['account.move'].some((orig) => orig.id === m.id));
    assert.equal(created.length, 1);
    assert.equal(created[0].journal_id, altPurchase.id);
    assert.equal(created[0].company_id, comp2.id);
    assert.equal(created[0].state, 'draft');
    const doc = search(ctx.getServerDb(), 'documents.document').find((d) => d.res_model === 'account.move' && d.res_id === created[0].id);
    assert.equal(doc.company_id, comp2.id);
    assert.equal(doc.file.name, 'branch-bill.pdf');
    assert.equal(globalThis.location.hash, `#/accounting/bills/${created[0].id}`);

    // Clearing the journal filter facet reverts subsequent uploads to the active company default journal.
    const clearFacet = allFind(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label']?.startsWith('Remove filter Journal:'))[0];
    assert.ok(clearFacet, 'Journal filter facet has a remove button');
    await ctx.React.act(async () => { props(clearFacet).onClick(); });
    await ctx.React.act(async () => {
      await props(ctx.uploadInput()).onChange({ target: { files: [{ name: 'main-bill.pdf', type: 'application/pdf', size: 12 }], value: 'x' } });
    });
    assert.deepEqual(ctx.alerts, []);
    const latest = search(ctx.getServerDb(), 'account.move').at(-1);
    assert.equal(latest.journal_id, activeDefault);
    assert.equal(latest.company_id, 1);
  } finally {
    await ctx.done();
  }
});

test('uploadMoves validates journal scope, type and activity without falling back to company default', async () => {
  let db = seed();
  const currencyId = read(db, 'res.company', 1).currency_id;
  const c2 = createCompany(db, { name: 'Hidden Co', currency_id: currencyId });
  const hiddenExp = create(c2.db, 'account.account', { code: '600002', name: 'Hidden Expense', account_type: 'expense', company_id: c2.id });
  const hiddenJournal = create(hiddenExp.db, 'account.journal', { name: 'Hidden Bills', code: 'HBILL', type: 'purchase', company_id: c2.id, default_account_id: hiddenExp.id, invoice_sequence_prefix: 'HB/' });
  db = setCompanies(hiddenJournal.db, { current: 1, allowed: [1] });
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id ?? 1) === 1);
  const purchaseJournal = search(db, 'account.journal').find((j) => j.type === 'purchase' && (j.company_id ?? 1) === 1);
  const archivedJournal = create(db, 'account.journal', { name: 'Archived Bills', code: 'ARCHB', type: 'purchase', company_id: 1, active: false, default_account_id: purchaseJournal.default_account_id, invoice_sequence_prefix: 'AR/' });
  db = archivedJournal.db;

  const commit = async (next) => { db = next; return { ok: true }; };
  await assert.rejects(() => uploadMoves([file('a.pdf')], { moveType: 'in_invoice', journalId: hiddenJournal.id }, { getDb: () => db, commit }), /No access to that company/);
  await assert.rejects(() => uploadMoves([file('a.pdf')], { moveType: 'in_invoice', companyId: 1, journalId: saleJournal.id }, { getDb: () => db, commit }), /Select an active journal for this company and document type/);
  await assert.rejects(() => uploadMoves([file('a.pdf')], { moveType: 'in_invoice', companyId: 1, journalId: archivedJournal.id }, { getDb: () => db, commit }), /Select an active journal for this company and document type/);
  await assert.rejects(() => uploadMoves([file('a.pdf')], { moveType: 'in_invoice', companyId: 1, journalId: 999999 }, { getDb: () => db, commit }), /Selected journal does not exist/);
});

test('multi-file upload exceeding 5 MiB splits into bounded sequential batches accounting for encoding and payload overhead', async () => {
  let db = seed();
  const requestSizes = [];
  const files = [largeFile('بند-١.pdf'), largeFile('بند-٢.pdf'), largeFile('بند-٣.pdf')];
  const commit = async (next) => {
    const diff = diffDb(db, next);
    const bytes = Buffer.byteLength(JSON.stringify(diff), 'utf8');
    requestSizes.push(bytes);
    if (bytes > MAX_SERVER_DIFF_BYTES) return { ok: false, error: 'Request too large' };
    const assigned = assignIds(db, diff);
    db = applyDiff(db, assigned.diff, { isAdmin: true });
    return { ok: true, remapped: assigned.remapped };
  };

  const result = await uploadMoves(files, options, { getDb: () => db, commit, ai: false });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ids.length, 3);
  assert.equal(requestSizes.length, 3, 'Three 2 MiB files (~2.67 MiB each in base64) split into 3 sequential requests');
  assert.ok(requestSizes.every((b) => b <= MAX_UPLOAD_BATCH_BYTES && b < MAX_SERVER_DIFF_BYTES), `All requests stay under batch/server ceiling: ${requestSizes.join(', ')}`);
  assert.equal(result.go, `#/accounting/bills?view=list&rel=id:${result.ids.join(',')}`);
  for (const [i, id] of result.ids.entries()) {
    const doc = search(db, 'documents.document').find((d) => d.res_model === 'account.move' && d.res_id === id);
    assert.equal(doc.file.name, files[i].name);
  }
});

test('partial failure preserves success IDs, per-file failures, and navigation across batching and digitization', async () => {
  let db = seed();
  const badDataFile = { name: 'corrupt.pdf', type: 'application/pdf', size: 10, data: 'not-a-data-url' };
  const batchCommit = async (next) => {
    const diff = diffDb(db, next);
    const bytes = Buffer.byteLength(JSON.stringify(diff), 'utf8');
    if (bytes > MAX_SERVER_DIFF_BYTES) return { ok: false, error: 'Request too large' };
    try {
      const assigned = assignIds(db, diff);
      db = applyDiff(db, assigned.diff, { isAdmin: true });
      return { ok: true, remapped: assigned.remapped };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  // Local validation failure (invalid data URL) does not taint or drop later valid files in the selection.
  let commitCalls = 0;
  const countedBatchCommit = async (next) => { commitCalls += 1; return batchCommit(next); };
  const partialLocal = await uploadMoves([file('ok-1.pdf'), badDataFile, file('ok-2.pdf')], options, { getDb: () => db, commit: countedBatchCommit, ai: false });
  assert.equal(commitCalls, 1, 'Only valid files are batched and committed once');
  assert.equal(partialLocal.ids.length, 2);
  assert.equal(partialLocal.errors.length, 1);
  assert.match(partialLocal.errors[0], /^corrupt\.pdf: /);
  assert.equal(partialLocal.go, `#/accounting/bills?view=list&rel=id:${partialLocal.ids.join(',')}`);

  // Ambiguous commit failure (e.g. response lost after persistence) is NEVER replayed individually.
  let ambiguousCalls = 0;
  const ambiguousCommit = async (next) => {
    ambiguousCalls += 1;
    if (ambiguousCalls === 1) return batchCommit(next);
    // Simulate server persisting batch 2 while client receives ok:false from lost network response.
    await batchCommit(next);
    return { ok: false, error: 'Could not save changes: Failed to fetch.' };
  };
  const ambiguousResult = await uploadMoves([largeFile('confirmed.pdf'), largeFile('lost-1.pdf', 1900 * 1024), file('lost-2.pdf')], options, { getDb: () => db, commit: ambiguousCommit, ai: false });
  assert.equal(ambiguousCalls, 2, 'Failed second batch must never be replayed individually');
  assert.equal(ambiguousResult.ids.length, 1, 'Only confirmed IDs from batch 1 are returned');
  assert.deepEqual(ambiguousResult.errors, [
    'lost-1.pdf: Could not save changes: Failed to fetch.',
    'lost-2.pdf: Could not save changes: Failed to fetch.',
  ]);
  assert.equal(ambiguousResult.go, `#/accounting/bills/${ambiguousResult.ids[0]}`);

  // AI digitization partial failure keeps both created IDs and records the failed file.
  const digitizedIds = [];
  const aiPartial = await uploadMoves([file('bill-a.pdf'), file('bill-b.pdf')], options, {
    getDb: () => db,
    commit: batchCommit,
    ai: true,
    digitize: async ({ id }) => {
      digitizedIds.push(id);
      if (digitizedIds.length === 1) throw new Error('The document could not be read as a bill.');
      return { ok: true };
    },
  });
  assert.equal(aiPartial.ids.length, 2);
  assert.deepEqual(aiPartial.errors, ['bill-a.pdf: The document could not be read as a bill.']);
  assert.equal(aiPartial.go, `#/accounting/bills?view=list&rel=id:${aiPartial.ids.join(',')}`);

  // Total failure returns no IDs and null navigation target.
  const totalFailure = await uploadMoves([badDataFile], options, { getDb: () => db, commit: batchCommit, ai: false });
  assert.deepEqual(totalFailure.ids, []);
  assert.equal(totalFailure.errors.length, 1);
  assert.equal(totalFailure.go, null);
});

test('ActionView MoveUpload reads bounded chunks sequentially and skips oversized earlier files without dropping later valid files', async () => {
  const db = seed();
  const events = [];
  const prevFetch = globalThis.fetch;
  const ctx = await mountActionView(db, { base: '#/accounting/bills', leafKey: 'bills', query: 'view=list' });
  const origFileReader = globalThis.FileReader;
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url === '/api/diff') events.push(`commit:${Buffer.byteLength(init.body, 'utf8')}`);
    return baseFetch(url, init);
  };
  globalThis.FileReader = class {
    readAsDataURL(f) {
      events.push(`read:${f.name}`);
      queueMicrotask(() => {
        this.result = `data:${f.type || 'application/pdf'};base64,${Buffer.alloc(f.size ?? 1, 65).toString('base64')}`;
        this.onload?.();
      });
    }
  };
  try {
    const input = ctx.uploadInput();
    const mixedFiles = [
      { name: 'too-big-first.pdf', type: 'application/pdf', size: 2 * 1024 * 1024 + 1 },
      { name: 'chunk-a.pdf', type: 'application/pdf', size: 1900 * 1024 },
      { name: 'chunk-b.pdf', type: 'application/pdf', size: 1900 * 1024 },
    ];
    await ctx.React.act(async () => { await props(input).onChange({ target: { files: mixedFiles, value: 'x' } }); });
    assert.deepEqual(ctx.alerts, ['too-big-first.pdf: File is larger than 2 MB']);
    assert.deepEqual(
      events.map((e) => (e.startsWith('commit:') ? 'commit' : e)),
      ['read:chunk-a.pdf', 'commit', 'read:chunk-b.pdf', 'commit'],
      'First chunk commits before reading later file that would exceed the batch ceiling, and oversized earlier item does not drop later valid files',
    );
    const created = search(ctx.getServerDb(), 'account.move').filter((m) => !db.records['account.move'].some((orig) => orig.id === m.id));
    assert.equal(created.length, 2);
    assert.equal(globalThis.location.hash, `#/accounting/bills?view=list&rel=id:${created.map((m) => m.id).join(',')}`);
  } finally {
    globalThis.FileReader = origFileReader;
    globalThis.fetch = prevFetch;
    await ctx.done();
  }
});

test('ActionView single company relation selects its matching journal, and disallowed/ambiguous/empty relations never fall back', async () => {
  let db = seed();
  const currencyId = read(db, 'res.company', 1).currency_id;
  const comp2 = createCompany(db, { name: 'Allowed Co 2', currency_id: currencyId });
  const exp2 = create(comp2.db, 'account.account', { code: '600010', name: 'Co2 Expense', account_type: 'expense', company_id: comp2.id });
  const j2 = create(exp2.db, 'account.journal', { name: 'Co2 Bills', code: 'C2B', type: 'purchase', company_id: comp2.id, default_account_id: exp2.id, invoice_sequence_prefix: 'C2B/' });
  db = write(j2.db, 'res.company', comp2.id, { default_purchase_journal_id: j2.id });
  const comp3 = createCompany(db, { name: 'Blocked Co 3', currency_id: currencyId });
  const exp3 = create(comp3.db, 'account.account', { code: '600011', name: 'Co3 Expense', account_type: 'expense', company_id: comp3.id });
  const j3 = create(exp3.db, 'account.journal', { name: 'Co3 Bills', code: 'C3B', type: 'purchase', company_id: comp3.id, default_account_id: exp3.id, invoice_sequence_prefix: 'C3B/' });
  db = write(j3.db, 'res.company', comp3.id, { default_purchase_journal_id: j3.id });
  db = setCompanies(db, { current: 1, allowed: [1, comp2.id] });

  // Single allowed company_id relation uses company 2's default purchase journal, not active company 1.
  const c2Ctx = await mountActionView(db, { base: '#/accounting/bills', leafKey: 'bills', query: `view=list&rel=company_id:${comp2.id}` });
  try {
    await c2Ctx.React.act(async () => {
      await props(c2Ctx.uploadInput()).onChange({ target: { files: [{ name: 'co2-bill.pdf', type: 'application/pdf', size: 12 }], value: 'x' } });
    });
    assert.deepEqual(c2Ctx.alerts, []);
    const created = search(c2Ctx.getServerDb(), 'account.move').filter((m) => !db.records['account.move'].some((orig) => orig.id === m.id));
    assert.equal(created.length, 1);
    assert.equal(created[0].company_id, comp2.id);
    assert.equal(created[0].journal_id, j2.id);
  } finally {
    await c2Ctx.done();
  }

  // Blocked company, ambiguous relations, and empty relations never create documents in active company 1.
  const mainPurchase = read(db, 'res.company', 1).default_purchase_journal_id;
  for (const [query, expectedAlert] of [
    [`view=list&rel=company_id:${comp3.id}`, /No access to that company/],
    [`view=list&rel=journal_id:${j3.id}`, /No access to that company/],
    [`view=list&rel=journal_id:${mainPurchase},${j2.id}`, /Select an active journal for this company and document type/],
    [`view=list&rel=company_id:1,${comp2.id}`, /Select an existing active company/],
    ['view=list&rel=journal_id:', /Selected journal does not exist/],
    ['view=list&rel=company_id:', /Select an existing active company/],
  ]) {
    const errCtx = await mountActionView(db, { base: '#/accounting/bills', leafKey: 'bills', query });
    try {
      await errCtx.React.act(async () => {
        await props(errCtx.uploadInput()).onChange({ target: { files: [{ name: 'blocked.pdf', type: 'application/pdf', size: 12 }], value: 'x' } });
      });
      assert.equal(errCtx.alerts.length, 1, `Expected alert for ${query}`);
      assert.match(errCtx.alerts[0], expectedAlert, `Alert matches for ${query}`);
      assert.equal(errCtx.getServerDb().records['account.move'].length, db.records['account.move'].length, `No move created for ${query}`);
    } finally {
      await errCtx.done();
    }
  }
});

test('uploadMoves rebases flush onto latest store db across awaited FileReader and rejects multi-GB files before readFile', async () => {
  let db = seed();
  const concurrentPartner = create(db, 'res.partner', { name: 'Concurrent Poll Partner' });
  const readCalls = [];
  let commitDiff = null;
  const result = await uploadMoves(
    [
      { name: 'multi-gb.pdf', type: 'application/pdf', size: 5 * 1024 * 1024 * 1024 },
      { name: 'first.pdf', type: 'application/pdf', size: 16 },
      { name: 'second.pdf', type: 'application/pdf', size: 16 },
    ],
    options,
    {
      getDb: () => db,
      readFile: async (raw) => {
        readCalls.push(raw.name);
        if (raw.name === 'second.pdf') {
          // Simulate a background poll / concurrent save updating the store between FileReader awaits.
          db = concurrentPartner.db;
        }
        return file(raw.name);
      },
      commit: async (next) => {
        commitDiff = diffDb(db, next);
        const assigned = assignIds(db, commitDiff);
        db = applyDiff(db, assigned.diff, { isAdmin: true });
        return { ok: true, remapped: assigned.remapped };
      },
      ai: false,
    },
  );
  assert.deepEqual(readCalls, ['first.pdf', 'second.pdf'], 'Multi-GB file is rejected before readFile');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^multi-gb\.pdf: /);
  assert.equal(result.ids.length, 2);
  assert.deepEqual(commitDiff.deletes, {}, 'Concurrent record added during awaited FileReader is not deleted');
  assert.ok(!('res.partner' in (commitDiff.upserts ?? {})), 'Concurrent partner is not reverted');
  assert.equal(read(db, 'res.partner', concurrentPartner.id)?.name, 'Concurrent Poll Partner');
});
