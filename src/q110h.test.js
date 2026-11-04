import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

import './models/index.js';
import { seed } from './seed.js';
import { create, read, updateSettings, write, setActiveCompany } from './orm.js';
import { createCompany } from './models/company.js';
import { postEntry, accountId } from './models/ledger.js';
import { closeFiscalYear } from './models/closing.js';
import { migrate } from './migrations.js';
import { renderAnnualReportHtml } from './models/auditreport.js';
import { setupDom, find } from './test-support/dom.js';
import { newDefaults } from './views/formDefaults.js';
import { menusFor } from './models/index.js';
import { models } from './registry.js';
import { configurableReport } from './models/configurableReports.js';

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

function createMockDomParser() {
  return class MockDOMParser {
    parseFromString(markup, _type) {
      const makeNode = (tagName, attrs = {}, children = []) => {
        const node = {
          nodeType: 1,
          tagName: tagName.toUpperCase(),
          childNodes: [...children],
          attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
          removeAttribute(name) {
            this.attributes = this.attributes.filter((a) => a.name !== name);
          },
          remove() {
            if (this.parent) {
              const idx = this.parent.childNodes.indexOf(this);
              if (idx >= 0) this.parent.childNodes.splice(idx, 1);
            }
          },
          replaceWith(...nodes) {
            if (this.parent) {
              const idx = this.parent.childNodes.indexOf(this);
              if (idx >= 0) this.parent.childNodes.splice(idx, 1, ...nodes);
              for (const n of nodes) n.parent = this.parent;
            }
          },
          get innerHTML() {
            return this.childNodes
              .map((c) => (c.nodeType === 3 ? c.nodeValue : `<${c.tagName.toLowerCase()}${c.attributes.length ? ' ' + c.attributes.map((a) => `${a.name}="${a.value}"`).join(' ') : ''}>${c.innerHTML}</${c.tagName.toLowerCase()}>`))
              .join('');
          },
        };
        for (const child of children) child.parent = node;
        return node;
      };

      const textNode = (value) => ({ nodeType: 3, nodeValue: value });

      const parseTokens = (str) => {
        const nodes = [];
        const regex = /<(\/)?([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g;
        const stack = [{ childNodes: nodes }];
        let match;
        while ((match = regex.exec(str)) !== null) {
          const [, isClosing, tagName, attrStr, text] = match;
          if (text) {
            const tNode = textNode(text);
            stack[stack.length - 1].childNodes.push(tNode);
            tNode.parent = stack[stack.length - 1];
          } else if (isClosing) {
            if (stack.length > 1 && stack[stack.length - 1].tagName === tagName.toUpperCase()) {
              stack.pop();
            }
          } else {
            const attrs = {};
            if (attrStr) {
              const attrRegex = /([a-zA-Z0-9_-]+)(?:=["']([^"']*)["'])?/g;
              let aMatch;
              while ((aMatch = attrRegex.exec(attrStr)) !== null) {
                attrs[aMatch[1]] = aMatch[2] ?? '';
              }
            }
            const el = makeNode(tagName, attrs, []);
            stack[stack.length - 1].childNodes.push(el);
            el.parent = stack[stack.length - 1];
            if (!['BR', 'HR', 'IMG', 'INPUT'].includes(tagName.toUpperCase())) {
              stack.push(el);
            }
          }
        }
        return nodes;
      };

      const body = makeNode('BODY', {}, parseTokens(String(markup ?? '')));
      return { body };
    }
  };
}

// -----------------------------------------------------------------------------
// Finding 5: Migration removes independently set locks
// -----------------------------------------------------------------------------
test('Finding 5: migration preserves global lock date matching closed fiscal year end without clearing it', () => {
  const dates = { date_from: '2032-01-01', date_to: '2032-12-31' };
  const company = createCompany(seed(), { name: 'Independent Subsidiary' });
  const expense = create(company.db, 'account.account', { code: '600000', name: 'Sub expense', account_type: 'expense', company_id: company.id });
  const year = create(expense.db, 'account.fiscal.year', { name: 'FY 2032', ...dates, company_id: 1 });
  const closed = closeFiscalYear(year.db, year.id);

  // An admin independently set a global lock date equal to 2032-12-31 on schema version 20
  const legacy = { ...closed, schema_version: 20, settings: { ...closed.settings, lock_date: dates.date_to } };
  const migrated = migrate(legacy);

  // Global lock must be preserved, not wiped to null
  assert.equal(migrated.settings.lock_date, dates.date_to, 'Global lock date must be retained');

  // Attempting to post in company 2 within the locked period must throw /locked/
  assert.throws(
    () => postEntry(migrated, {
      company: company.id,
      journal: 'MISC',
      date: '2032-06-15',
      lines: [{ account: expense.id, debit: 50 }, { account: '301000', credit: 50 }],
    }),
    /locked/i,
  );
});

// -----------------------------------------------------------------------------
// Finding 19: Dropped HTML can remain in the editor
// -----------------------------------------------------------------------------
test('Finding 19: dropped HTML is sanitized and unsanitized markup cannot remain in the live editor DOM', async () => {
  const { makeEl } = setupDom();
  const { HtmlEditor } = await import('./HtmlEditor.jsx');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  globalThis.document.createElementNS = (namespace, tag) => makeEl(tag);
  globalThis.DOMParser = createMockDomParser();

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  let emitted = '';
  await React.act(async () => {
    root.render(React.createElement(HtmlEditor, {
      id: 'test-editor',
      label: 'Annual Report Body',
      value: '<p>Initial</p>',
      onChange: (val) => { emitted = val; },
    }));
  });

  const editor = find(host, (n) => props(n)?.role === 'textbox');
  assert.ok(editor, 'Editor textbox exists');

  // 1. Drop event with untrusted HTML is intercepted and sanitized
  let prevented = false;
  await React.act(async () => {
    props(editor).onDrop({
      preventDefault: () => { prevented = true; },
      dataTransfer: {
        getData: (type) => (type === 'text/html' ? '<script>alert("evil")</script><b>Safe Drop</b>' : ''),
      },
      clientX: 0,
      clientY: 0,
    });
  });

  assert.equal(prevented, true, 'Default drop was prevented');
  assert.ok(!emitted.includes('script'), 'Emitted value must not contain script tag');
  assert.ok(emitted.includes('<b>Safe Drop</b>'), 'Emitted value includes sanitized content');
  assert.ok(!editor.innerHTML.includes('script'), 'Editor live DOM must not retain dropped script tag');

  // 2. Direct unsanitized input to live DOM is purged on handleInput
  await React.act(async () => {
    editor.innerHTML = '<script>pwn()</script><p>Clean text</p>';
    props(editor).onInput();
  });

  assert.ok(!editor.innerHTML.includes('script'), 'Live DOM script markup purged on input');
  assert.ok(editor.innerHTML.includes('<p>Clean text</p>'), 'Live DOM clean markup preserved');

  await React.act(async () => root.unmount());
});

// -----------------------------------------------------------------------------
// Finding 20: Some audit checks use the wrong company
// -----------------------------------------------------------------------------
test('Finding 20: direct creation without explicit company resolves active company for type and checks', () => {
  const company = createCompany(seed(), { name: 'Branch Two' });
  let db = company.db;

  // Company 1 has a draft entry in 2026
  db = create(db, 'account.move', {
    company_id: 1,
    move_type: 'entry',
    invoice_date: '2026-05-01',
    state: 'draft',
    line_ids: [{ account_id: accountId(db, '600000', 1), debit: 10 }, { account_id: accountId(db, '301000', 1), credit: 10 }],
  }).db;

  // Company 2 has NO draft entries
  setActiveCompany(company.id);
  try {
    const created = create(db, 'account.return', {
      name: 'Branch 2 Working File',
      audit_status: 'ongoing',
      date_from: '2026-01-01',
      date_to: '2026-12-31',
    });

    const ret = read(created.db, 'account.return', created.id);
    assert.equal(ret.company_id, company.id, 'Stored return must belong to active company');

    const draftCheck = ret.checks.find((c) => c.name === 'Draft Entries');
    assert.ok(draftCheck, 'Draft Entries check is present');
    assert.equal(draftCheck.status, 'passed', 'Company 2 has no draft entries so check must pass');
  } finally {
    setActiveCompany(null);
  }
});

// -----------------------------------------------------------------------------
// Finding 21: Annual reports lose their table formatting
// -----------------------------------------------------------------------------
test('Finding 21: renderAnnualReportHtml styles tables with approved classes that survive strict sanitization', async () => {
  const { sanitizeHtml } = await import('./HtmlEditor.jsx');
  const db = seed();
  globalThis.DOMParser = createMockDomParser();

  const rawHtml = renderAnnualReportHtml(db, {
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    company_id: 1,
  });

  // Verify raw HTML uses classes, not inline presentation styles/attributes
  assert.ok(rawHtml.includes('class="report-table balance-sheet-table"'));
  assert.ok(rawHtml.includes('class="text-left"'));
  assert.ok(rawHtml.includes('class="text-right"'));
  assert.ok(rawHtml.includes('class="section-header"'));
  assert.ok(rawHtml.includes('class="total-row"'));
  assert.ok(rawHtml.includes('class="grand-total-row"'));
  assert.ok(!rawHtml.includes('border="1"'));
  assert.ok(!rawHtml.includes('cellpadding="6"'));
  assert.ok(!rawHtml.includes('style="'));

  // Run through sanitizer
  const sanitized = sanitizeHtml(rawHtml);
  assert.ok(sanitized.includes('class="report-table balance-sheet-table"'));
  assert.ok(sanitized.includes('class="text-right"'));
  assert.ok(sanitized.includes('class="section-header"'));
  assert.ok(sanitized.includes('class="total-row"'));
  assert.ok(sanitized.includes('class="grand-total-row"'));
});

// -----------------------------------------------------------------------------
// Finding 22: Working files from the menu never get checks
// -----------------------------------------------------------------------------
test('Finding 22: working files created from menu seed default checks and expose Refresh Checks with readonly checks', () => {
  const db = seed();
  const wfLeaf = menusFor('accounting').find((m) => m.label === 'Review').children
    .find((m) => m.label === 'Audit').children.find((m) => m.key === 'working-files');

  // Form initialization via newDefaults
  const formValues = newDefaults(db, 'account.return', wfLeaf, new URLSearchParams());
  assert.ok(Array.isArray(formValues.checks), 'Checks is an array');
  assert.ok(formValues.checks.length > 0, 'Checks must be populated by createDefaults, not empty');
  assert.ok(formValues.checks.some((c) => c.name === 'Draft Entries'));
  assert.ok(formValues.checks.some((c) => c.name === 'Balanced Entries'));
  assert.ok(formValues.checks.some((c) => c.name === 'Data Inalterability'));

  // Checks field must be readonly
  assert.equal(models['account.return'].fields.checks.readonly, true, 'Checks field must be readonly');

  // Refresh Checks button exists and updates checks
  const ret = create(db, 'account.return', {
    name: 'Audit File',
    audit_status: 'ongoing',
    company_id: 1,
    date_from: '2026-01-01',
    date_to: '2026-12-31',
    checks: [],
  });

  const refreshBtn = models['account.return'].form.buttons.find((b) => b.label === 'Refresh Checks');
  assert.ok(refreshBtn, 'Refresh Checks button must exist');
  assert.equal(refreshBtn.when(read(ret.db, 'account.return', ret.id), ret.db), true);

  const refreshed = refreshBtn.run(ret.db, read(ret.db, 'account.return', ret.id));
  const afterChecks = read(refreshed.db, 'account.return', ret.id).checks;
  assert.ok(afterChecks.length > 0, 'Checks recomputed by Refresh Checks button');
});

// -----------------------------------------------------------------------------
// Finding 23: Audit checks go stale before completion
// -----------------------------------------------------------------------------
test('Finding 23: Mark as Done recomputes audit checks against current ledger state, and date change refreshes checks', () => {
  let db = seed();

  // Create an audit file for H1 2026 where all checks pass (seed draft entry is in November)
  const created = create(db, 'account.return', {
    name: 'H1 2026 Audit',
    audit_status: 'ongoing',
    company_id: 1,
    date_from: '2026-01-01',
    date_to: '2026-06-30',
  });
  db = created.db;

  const initial = read(db, 'account.return', created.id);
  assert.equal(initial.checks.find((c) => c.name === 'Draft Entries')?.status, 'passed');

  // Introduce a draft move within H1
  db = create(db, 'account.move', {
    company_id: 1,
    move_type: 'entry',
    invoice_date: '2026-04-01',
    state: 'draft',
    line_ids: [{ account_id: accountId(db, '600000', 1), debit: 100 }, { account_id: accountId(db, '301000', 1), credit: 100 }],
  }).db;

  // Mark as Done action
  const markDone = models['account.return'].form.buttons.find((b) => b.label === 'Mark as Done');
  assert.ok(markDone);
  db = markDone.run(db, read(db, 'account.return', created.id)).db;

  const doneRecord = read(db, 'account.return', created.id);
  assert.equal(doneRecord.audit_status, 'done');
  assert.equal(
    doneRecord.checks.find((c) => c.name === 'Draft Entries')?.status,
    'warning',
    'Mark as Done must recompute checks against latest database state',
  );

  // Also verify onchange refreshes checks when dates change on an open audit file
  const reopen = models['account.return'].form.buttons.find((b) => b.label === 'Reset to Draft');
  db = reopen.run(db, doneRecord).db;

  // Change period to Q1 2026 (before the April draft move)
  db = write(db, 'account.return', created.id, { date_to: '2026-03-31' });
  const updatedPeriod = read(db, 'account.return', created.id);
  assert.equal(
    updatedPeriod.checks.find((c) => c.name === 'Draft Entries')?.status,
    'passed',
    'Changing period refreshes checks to match the new date range',
  );
});

// -----------------------------------------------------------------------------
// Finding 24: Analytic splits use the wrong company
// -----------------------------------------------------------------------------
test('Finding 24: analytic weights resolve distribution models using the document company context', () => {
  const branch = createCompany(seed(), { name: 'Branch Co' });
  let db = updateSettings(branch.db, { current_company_id: 1, allowed_company_ids: [1, branch.id] });

  const analytic1 = create(db, 'account.analytic.account', { name: 'Plan C1', company_id: 1 }); db = analytic1.db;
  const analytic2 = create(db, 'account.analytic.account', { name: 'Plan C2', company_id: branch.id }); db = analytic2.db;

  // Distribution models for account code 600000
  db = create(db, 'account.analytic.distribution.model', {
    company_id: 1,
    account_prefix: '600000',
    analytic_distribution: { [analytic1.id]: 100 },
  }).db;

  db = create(db, 'account.analytic.distribution.model', {
    company_id: branch.id,
    account_prefix: '600000',
    analytic_distribution: { [analytic2.id]: 100 },
  }).db;

  const branchExp = create(db, 'account.account', {
    name: 'Branch Expense', code: '600000', company_id: branch.id, account_type: 'expense',
  }); db = branchExp.db;

  // Post entry in Branch company without explicit analytic_distribution on the line
  const date = '2027-03-01';
  db = postEntry(db, {
    journal: 'MISC',
    company: branch.id,
    date,
    lines: [
      { account: branchExp.id, debit: 500 },
      { account: '301000', credit: 500 },
    ],
  }).db;

  const report = create(db, 'account.report', {
    name: 'Branch Expense Report',
    company_id: branch.id,
    line_ids: [{ code: 'EXP', name: 'Expense', formula: '600000', sequence: 10 }],
  }); db = report.db;

  const group = create(db, 'account.report.horizontal.group', {
    name: 'Analytic Group C2',
    company_id: branch.id,
    report_ids: [report.id],
    rule_ids: [{ field: 'analytic', ids: `${analytic2.id}` }],
  }); db = group.db;

  const result = configurableReport(
    db,
    read(db, 'account.report', report.id),
    { from: date, to: date },
    read(db, 'account.report.horizontal.group', group.id),
  );

  // The branch expense must be allocated to Plan C2 (analytic2.id), and 0 to Others
  assert.equal(result.buckets.length, 2);
  assert.equal(result.buckets[0].label, 'Plan C2');
  assert.deepEqual(result.rows[0].values, [500, 0]);
});

// -----------------------------------------------------------------------------
// Finding 25: Branch users start files in company one
// -----------------------------------------------------------------------------
test('Finding 25: new working files initialize company_id from the active company', () => {
  const company = createCompany(seed(), { name: 'Regional Office' });
  const db = updateSettings(company.db, { current_company_id: company.id, allowed_company_ids: [1, company.id] });

  const wfLeaf = menusFor('accounting').find((m) => m.label === 'Review').children
    .find((m) => m.label === 'Audit').children.find((m) => m.key === 'working-files');

  setActiveCompany(company.id);
  try {
    const defaults = newDefaults(db, 'account.return', wfLeaf, new URLSearchParams());
    assert.equal(defaults.company_id, company.id, 'New working file should start with the active company');
  } finally {
    setActiveCompany(null);
  }
});
