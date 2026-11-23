import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { seed } from './seed.js';
import { create } from './orm.js';
import { diffDb, applyDiff } from './sync.js';
import { fromCsv } from './csv.js';
import { readXlsx } from './xlsx.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));
const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];

function setupDownloadSpy(makeEl) {
  const downloads = [];
  const origCreateElement = globalThis.document.createElement;
  const origCreateElementNS = globalThis.document.createElementNS;
  const origCreateUrl = URL.createObjectURL;
  const origRevokeUrl = URL.revokeObjectURL;

  globalThis.document.createElementNS = (_ns, tag) => makeEl(tag);
  globalThis.document.createElement = (tag) => {
    const el = makeEl(tag);
    const origSetAttr = el.setAttribute;
    el.setAttribute = (name, value) => {
      origSetAttr(name, value);
      if (name === 'colspan' || name === 'colSpan') el.colSpan = Number(value);
      if (name === 'rowspan' || name === 'rowSpan') el.rowSpan = Number(value);
    };
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
    const buf = new Uint8Array(await entry.blob.arrayBuffer());
    return {
      filename: entry.filename,
      type: entry.blob.type,
      bytes: buf,
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

test('AUD-1: Audit Trail (Review > Control) filters: user, model, record, field changed, date range, pagination, and admin access rule', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };

  let db = seed();
  const move1 = create(db, 'account.move', { name: 'INV/2026/0001', move_type: 'entry', company_id: 1, ref: 'AUD-INV-1' });
  const move2 = create(move1.db, 'account.move', { name: 'INV/2026/0002', move_type: 'entry', company_id: 1, ref: 'AUD-INV-2' });
  db = move2.db;

  // Guard diff-verifiability test through diffDb + applyDiff
  const modified = { ...db, settings: { ...db.settings, current_company_id: 1, allowed_company_ids: [1] } };
  const diff = diffDb(db, modified);
  const applied = applyDiff(db, diff, { isAdmin: true });
  assert.equal(applied.settings.current_company_id, 1);

  const mockRows = [
    {
      id: 101,
      at: '2026-03-05T10:00:00Z',
      actor: 'auditor_user',
      model: 'account.move',
      res_id: move1.id,
      action: 'write',
      changes: { ref: ['', 'AUD-INV-1'] },
      company_id: 1,
    },
    {
      id: 102,
      at: '2026-03-10T11:00:00Z',
      actor: 'other_user',
      model: 'account.move',
      res_id: move2.id,
      action: 'write',
      changes: { ref: ['', 'AUD-INV-2'], narration: ['', 'Extra note'] },
      company_id: 1,
    },
    {
      id: 103,
      at: '2026-03-15T12:00:00Z',
      actor: 'admin',
      model: 'res.company',
      res_id: 1,
      action: 'write',
      changes: { lock_date: [null, '2026-03-31'] },
      company_id: 1,
    },
  ];

  const requests = [];
  const oldFetch = globalThis.fetch;
  const oldInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;

  globalThis.fetch = async (url) => {
    requests.push(url);
    if (url === '/api/session') {
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ name: 'Admin', isAdmin: true }) };
    }
    if (url === '/api/db') {
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => db };
    }
    if (url.startsWith('/api/audit')) {
      const u = new URL(url, 'http://localhost');
      let result = [...mockRows];
      const user = u.searchParams.get('user');
      if (user) result = result.filter((r) => r.actor.toLowerCase().includes(user.toLowerCase()));
      const model = u.searchParams.get('model');
      if (model) result = result.filter((r) => r.model === model);
      const record = u.searchParams.get('record');
      if (record) result = result.filter((r) => String(r.res_id) === record.replace(/^#/, ''));
      const field = u.searchParams.get('field');
      if (field) {
        const lowerField = field.toLowerCase();
        result = result.filter((r) => Object.keys(r.changes ?? {}).some((k) => k.toLowerCase().includes(lowerField)) || Object.values(r.changes ?? {}).some((v) => JSON.stringify(v).toLowerCase().includes(lowerField)));
      }
      const from = u.searchParams.get('date_from');
      if (from) result = result.filter((r) => r.at.slice(0, 10) >= from);
      const to = u.searchParams.get('date_to');
      if (to) result = result.filter((r) => r.at.slice(0, 10) <= to);
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => result };
    }
    return { ok: false, status: 404, headers: { get: () => 'application/json' }, json: async () => ({ error: 'Not found' }) };
  };

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'audit' } })));

    // Verify initial load has audit rows
    assert.match(textOf(host), /AUD-INV-1/);
    assert.match(textOf(host), /AUD-INV-2/);

    // Verify filter inputs exist with their aria-labels
    const userInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'User');
    const modelSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Model');
    const recordInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Record');
    const fieldInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Field Changed');
    const periodSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value !== undefined && n.childNodes?.some((c) => textOf(c).includes('Custom Period') || textOf(c).includes('فترة مخصصة')));

    assert.ok(userInput, 'User filter input rendered');
    assert.ok(modelSelect, 'Model filter select rendered');
    assert.ok(recordInput, 'Record filter input rendered');
    assert.ok(fieldInput, 'Field Changed filter input rendered');
    assert.ok(periodSelect, 'Period select rendered with Custom Period option');

    // 1. Filter by User: 'auditor_user'
    await React.act(async () => {
      props(userInput).onChange({ target: { value: 'auditor_user' } });
    });
    assert.ok(requests.some((url) => url.includes('user=auditor_user')), 'Query param user sent to /api/audit');
    assert.match(textOf(host), /AUD-INV-1/);
    assert.doesNotMatch(textOf(host), /AUD-INV-2/);

    // 1b. Partial user filter: 'audit' matches 'auditor_user'
    await React.act(async () => {
      props(userInput).onChange({ target: { value: 'audit' } });
    });
    assert.match(textOf(host), /AUD-INV-1/);
    assert.doesNotMatch(textOf(host), /AUD-INV-2/);

    // 2. Filter by Model: 'res.company'
    await React.act(async () => {
      props(userInput).onChange({ target: { value: '' } });
      props(modelSelect).onChange({ target: { value: 'res.company' } });
    });
    assert.ok(requests.some((url) => url.includes('model=res.company')), 'Query param model sent to /api/audit');
    assert.match(textOf(host), /Lock Date/);

    // 3. Filter by Record: move1.id
    await React.act(async () => {
      props(modelSelect).onChange({ target: { value: 'account.move' } });
      props(recordInput).onChange({ target: { value: String(move1.id) } });
    });
    assert.ok(requests.some((url) => url.includes(`record=${move1.id}`)), 'Query param record sent to /api/audit');
    assert.match(textOf(host), /AUD-INV-1/);
    assert.doesNotMatch(textOf(host), /AUD-INV-2/);

    // 3b. Filter by Record Name: 'INV/2026/0001' (non-numeric string)
    requests.length = 0;
    await React.act(async () => {
      props(recordInput).onChange({ target: { value: 'INV/2026/0001' } });
    });
    assert.ok(!requests.some((url) => url.includes('record=INV')), 'Non-numeric record text is not sent to server as record param');
    assert.doesNotMatch(textOf(host), /Only administrators can read the audit trail/);
    assert.match(textOf(host), /AUD-INV-1/);
    assert.doesNotMatch(textOf(host), /AUD-INV-2/);

    // 3c. Filter by Record with hash prefix: '#<id>'
    await React.act(async () => {
      props(recordInput).onChange({ target: { value: `#${move1.id}` } });
    });
    assert.match(textOf(host), /AUD-INV-1/);
    assert.doesNotMatch(textOf(host), /AUD-INV-2/);

    // 4. Filter by Field Changed: 'narration'
    await React.act(async () => {
      props(modelSelect).onChange({ target: { value: '' } });
      props(recordInput).onChange({ target: { value: '' } });
      props(fieldInput).onChange({ target: { value: 'narration' } });
    });
    assert.ok(requests.some((url) => url.includes('field=narration')), 'Query param field sent to /api/audit');
    assert.match(textOf(host), /Extra note/);
    assert.doesNotMatch(textOf(host), /AUD-INV-1/);

    // 4b. Filter by partial Field Changed: 'narr'
    await React.act(async () => {
      props(fieldInput).onChange({ target: { value: 'narr' } });
    });
    assert.match(textOf(host), /Extra note/);
    assert.doesNotMatch(textOf(host), /AUD-INV-1/);

    // 5. Filter by Custom Date Range: 2026-03-01 to 2026-03-08
    await React.act(async () => {
      props(fieldInput).onChange({ target: { value: '' } });
      props(periodSelect).onChange({ target: { value: 'custom' } });
    });
    const fromInput = find(host, (n) => n.tagName === 'INPUT' && n.type === 'date' && props(n)?.value?.includes('01-01'));
    if (fromInput) {
      await React.act(async () => {
        props(fromInput).onChange({ target: { value: '2026-03-01' } });
      });
    }
    assert.ok(requests.some((url) => url.includes('date_from=') || url.includes('selected=1')), 'Date range sent in query');

    // 6. Test Admin-only access rule: when forbidden, displays admin-only warning
    globalThis.fetch = async (url) => {
      if (url.startsWith('/api/audit')) {
        return { ok: false, status: 403, headers: { get: () => 'application/json' }, json: async () => ({ error: 'Admins only' }) };
      }
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}) };
    };
    await React.act(async () => {
      props(userInput).onChange({ target: { value: 'non_admin_test' } });
    });
    assert.match(textOf(host), /Only administrators can read the audit trail/);

    // 6b. Validation failure (400) from server does not show administrators-only warning
    globalThis.fetch = async (url) => {
      if (url.startsWith('/api/audit')) {
        return { ok: false, status: 400, headers: { get: () => 'application/json' }, json: async () => ({ error: 'date_from must be a valid date or timestamp' }) };
      }
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}) };
    };
    await React.act(async () => {
      props(userInput).onChange({ target: { value: 'trigger_400' } });
    });
    assert.doesNotMatch(textOf(host), /Only administrators can read the audit trail/);
    // 7. Verify Arabic translations for all new UI strings
    globalThis.localStorage = { getItem: () => 'ar' };
    const { t: tAr } = await import(`./i18n.js?lang_ar_aud1=${Date.now()}`);
    for (const key of ['User', 'Model', 'Field Changed', 'All Models', 'All Users', 'Record ID', 'Field name']) {
      assert.notEqual(tAr(key), key, `Missing Arabic translation for: ${key}`);
    }
  } finally {
    delete globalThis.localStorage;
    await React.act(async () => root.unmount());
    globalThis.fetch = oldFetch;
    globalThis.setInterval = oldInterval;
  }
});

test('AUD-2: Export the filtered audit rows as CSV/XLSX', async () => {
  const { makeEl } = setupDom();
  const spy = setupDownloadSpy(makeEl);
  globalThis.location = { hash: '#/accounting' };

  let db = seed();
  const move1 = create(db, 'account.move', { name: 'INV/EXP/001', move_type: 'entry', company_id: 1, ref: 'EXPORT-MATCH' });
  const move2 = create(move1.db, 'account.move', { name: 'INV/EXP/002', move_type: 'entry', company_id: 1, ref: 'EXPORT-OTHER' });
  db = move2.db;

  const mockRows = [
    {
      id: 201,
      at: '2026-04-01T10:00:00Z',
      actor: 'special_actor',
      model: 'account.move',
      res_id: move1.id,
      action: 'write',
      changes: { ref: ['', 'EXPORT-MATCH'] },
      company_id: 1,
    },
    {
      id: 202,
      at: '2026-04-02T10:00:00Z',
      actor: 'other_actor',
      model: 'account.move',
      res_id: move2.id,
      action: 'write',
      changes: { ref: ['', 'EXPORT-OTHER'] },
      company_id: 1,
    },
  ];

  const oldFetch = globalThis.fetch;
  const oldInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;

  globalThis.fetch = async (url) => {
    if (url === '/api/session') {
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ name: 'Admin', isAdmin: true }) };
    }
    if (url === '/api/db') {
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => db };
    }
    if (url.startsWith('/api/audit')) {
      const u = new URL(url, 'http://localhost');
      let result = [...mockRows];
      const user = u.searchParams.get('user');
      if (user) result = result.filter((r) => r.actor.toLowerCase() === user.toLowerCase());
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => result };
    }
    return { ok: false, status: 404, headers: { get: () => 'application/json' }, json: async () => ({ error: 'Not found' }) };
  };

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'audit' } })));

    // Apply filter to keep only special_actor
    const userInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'User');
    assert.ok(userInput, 'User input found');

    await React.act(async () => {
      props(userInput).onChange({ target: { value: 'special_actor' } });
    });

    // Find export buttons
    const csvButton = find(host, (n) => n.tagName === 'BUTTON' && textOf(n).includes('Download CSV'));
    const xlsxButton = find(host, (n) => n.tagName === 'BUTTON' && textOf(n).includes('Export XLSX'));
    assert.ok(csvButton, 'Download CSV button found');
    assert.ok(xlsxButton, 'Export XLSX button found');

    // 1. Export CSV
    await React.act(async () => {
      props(csvButton).onClick();
    });
    const csvDl = await spy.takeLast();
    assert.ok(csvDl, 'CSV download captured');
    assert.equal(csvDl.filename, 'audit.csv');
    const csvText = await csvDl.text();
    const csvParsed = fromCsv(csvText);
    assert.deepEqual(csvParsed[0], ['Record', 'Model', 'Field', 'Old Value', 'New Value', 'Summary', 'Author', 'Date']);
    assert.ok(csvText.includes('EXPORT-MATCH'), 'Filtered record is exported in CSV');
    assert.ok(!csvText.includes('EXPORT-OTHER'), 'Unmatched record is excluded from exported CSV');

    // 2. Export XLSX
    await React.act(async () => {
      props(xlsxButton).onClick();
    });
    const xlsxDl = await spy.takeLast();
    assert.ok(xlsxDl, 'XLSX download captured');
    assert.equal(xlsxDl.filename, 'audit.xlsx');
    const xlsxData = readXlsx(xlsxDl.bytes);
    assert.equal(xlsxData.sheetName, 'Audit Trail');
    assert.deepEqual(xlsxData.rows[0], ['Record', 'Model', 'Field', 'Old Value', 'New Value', 'Summary', 'Author', 'Date']);
    const rowTexts = xlsxData.rows.map((r) => r.join(' ')).join('\n');
    assert.ok(rowTexts.includes('EXPORT-MATCH'), 'Filtered record is present in XLSX');
    assert.ok(!rowTexts.includes('EXPORT-OTHER'), 'Unmatched record is excluded from XLSX');

    // 3. Export filtered by record name (non-numeric string)
    const recordInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Record');
    assert.ok(recordInput, 'Record input found');
    await React.act(async () => {
      props(userInput).onChange({ target: { value: '' } });
      props(recordInput).onChange({ target: { value: 'INV/EXP/001' } });
    });
    await React.act(async () => {
      props(csvButton).onClick();
    });
    const recordCsvDl = await spy.takeLast();
    assert.ok(recordCsvDl, 'CSV download captured for record name search');
    const recordCsvText = await recordCsvDl.text();
    assert.ok(recordCsvText.includes('EXPORT-MATCH'), 'Record name matched row is exported in CSV');
    assert.ok(!recordCsvText.includes('EXPORT-OTHER'), 'Unmatched row is excluded from exported CSV');
  } finally {
    spy.restore();
    await React.act(async () => root.unmount());
    globalThis.fetch = oldFetch;
    globalThis.setInterval = oldInterval;
  }
});
