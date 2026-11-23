import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, write } from './orm.js';
import { diffDb, applyDiff } from './sync.js';
import { createCompany } from './models/company.js';
import { findStatementReport } from './models/statementReports.js';
import { auditReportModels, annualReportToRows } from './models/auditreport.js';

test('annual report sections select and order reports and notes, scoped to the company and preserved through print and export', () => {
  const base = seed();
  const company = createCompany(base, { name: 'Second company', currency_id: base.records['res.company'][0].currency_id });
  const initial = company.db;
  const pnl = findStatementReport(initial, 'pnl', 1);
  const balance = findStatementReport(initial, 'balance', 1);
  const sections = [
    { type: 'report', report_id: balance.id, sequence: 30 },
    { type: 'note', note: 'A <note> & explanation', sequence: 20 },
    { type: 'report', report_id: pnl.id, sequence: 10 },
  ];
  const created = create(initial, 'audit.report', { title: 'Review', section_ids: sections });
  let db = applyDiff(initial, diffDb(initial, created.db), { isAdmin: true });
  let report = read(db, 'audit.report', created.id);
  assert.ok(report.body.indexOf('Profit and Loss') < report.body.indexOf('A &lt;note&gt;'));
  assert.ok(report.body.indexOf('A &lt;note&gt;') < report.body.indexOf('Balance Sheet'));
  assert.ok(annualReportToRows(report.body).some((row) => row.includes('A <note> & explanation')));
  const buttons = auditReportModels['audit.report'].form.buttons;
  assert.equal(buttons.find((b) => b.label === 'Print').run(db, report).go, `#/print/audit.report/${report.id}`);
  db = write(db, 'audit.report', report.id, { section_ids: [sections[1]] });
  report = read(db, 'audit.report', report.id);
  db = buttons.find((b) => b.label === 'Refresh').run(db, report).db;
  report = read(db, 'audit.report', report.id);
  assert.doesNotMatch(report.body, /Profit and Loss|Balance Sheet/);
  const otherReport = findStatementReport(db, 'pnl', company.id);
  const otherCreated = create(db, 'audit.report', { title: 'Other company', company_id: company.id, section_ids: [{ type: 'report', report_id: otherReport.id }] });
  assert.match(read(otherCreated.db, 'audit.report', otherCreated.id).body, /Profit and Loss/);
  const forged = structuredClone(db);
  forged.records['audit.report'].find((r) => r.id === report.id).section_ids = [{ type: 'report', report_id: otherReport.id }];
  assert.throws(() => applyDiff(db, diffDb(db, forged), { isAdmin: true }), /Select an active report for this company/);
  db = write(db, 'audit.report', report.id, { status: 'done' });
  const locked = structuredClone(db);
  locked.records['audit.report'].find((r) => r.id === report.id).section_ids = [];
  assert.throws(() => applyDiff(db, diffDb(db, locked), { isAdmin: true }), /Done reports are read-only/);
});

test('annual report body regenerates when section_ids change and stays editable', () => {
  const base = seed();
  const pnl = findStatementReport(base, 'pnl', 1);
  const balance = findStatementReport(base, 'balance', 1);
  const sections = [
    { type: 'report', report_id: balance.id, sequence: 10 },
  ];
  const created = create(base, 'audit.report', { title: 'Test Report', section_ids: sections });
  let db = created.db;
  let report = read(db, 'audit.report', created.id);
  assert.ok(report.body.includes('Balance Sheet'));
  assert.ok(!report.body.includes('Profit and Loss'));

  // Update section_ids to include PnL
  db = write(db, 'audit.report', report.id, {
    section_ids: [
      { type: 'report', report_id: balance.id, sequence: 10 },
      { type: 'report', report_id: pnl.id, sequence: 20 },
    ],
  });
  report = read(db, 'audit.report', report.id);
  // Stored body must immediately include Profit and Loss without Refresh!
  assert.ok(report.body.includes('Profit and Loss'), 'Body must be regenerated when section_ids changes');

  // Verify onchange also produces the regenerated body
  const onchangeRes = auditReportModels['audit.report'].onchange?.(
    { ...report, section_ids: [{ type: 'note', note: 'Draft note' }] },
    'section_ids',
    db,
  );
  assert.ok(onchangeRes?.body?.includes('Draft note'));

  // A body edited in the same save as a section change is kept, not regenerated.
  db = write(db, 'audit.report', report.id, { section_ids: [{ type: 'report', report_id: balance.id, sequence: 10 }], body: '<p>Edited with sections</p>' });
  assert.equal(read(db, 'audit.report', report.id).body, '<p>Edited with sections</p>');

  // The body stays editable: a user-edited body is kept when the report is marked done.
  db = write(db, 'audit.report', report.id, { body: '<p>Reviewed by the auditor</p>' });
  const doneBtn = auditReportModels['audit.report'].form.buttons.find((b) => b.label === 'Mark as Done');
  const doneReport = read(doneBtn.run(db, read(db, 'audit.report', report.id)).db, 'audit.report', report.id);
  assert.equal(doneReport.status, 'done');
  assert.equal(doneReport.body, '<p>Reviewed by the auditor</p>');
});

test('annualReportToRows preserves line breaks in multiline notes for non-DOM and DOM paths', () => {
  const multilineNote = 'Line 1: Summary\nLine 2: Details\nLine 3: Conclusion';
  const html = `<div class="annual-report-body">
<table class="report-table"><tbody><tr><td>Line 1: Summary<br>Line 2: Details<br>Line 3: Conclusion</td></tr></tbody></table>
</div>`;

  // 1. Non-DOM path (ensure typeof document === 'undefined')
  const originalDoc = globalThis.document;
  try {
    delete globalThis.document;
    const nonDomRows = annualReportToRows(html);
    assert.deepEqual(nonDomRows, [[multilineNote]]);
  } finally {
    if (originalDoc) globalThis.document = originalDoc;
  }

  // 2. DOM path (mock document)
  const savedDoc = globalThis.document;
  try {
    globalThis.document = {
      createElement: (tag) => {
        let content = '';
        const node = {
          tagName: tag.toUpperCase(),
          childNodes: [],
          set innerHTML(val) {
            content = val;
            const trNodes = [];
            const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
            const cellRegex = /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
            let trMatch;
            while ((trMatch = trRegex.exec(val)) !== null) {
              const tdNodes = [];
              let cellMatch;
              while ((cellMatch = cellRegex.exec(trMatch[1])) !== null) {
                const childNodes = [];
                const parts = cellMatch[1].split(/(<br\s*\/?>)/gi);
                for (const part of parts) {
                  if (/<br\s*\/?>/i.test(part)) {
                    const br = {
                      tagName: 'BR',
                      parentNode: null,
                      replaceWith(replacement) {
                        const idx = childNodes.indexOf(br);
                        if (idx >= 0) childNodes.splice(idx, 1, { nodeType: 3, nodeValue: replacement, textContent: replacement });
                      },
                    };
                    br.parentNode = {
                      replaceChild(newChild, oldChild) {
                        const idx = childNodes.indexOf(oldChild);
                        if (idx >= 0) childNodes.splice(idx, 1, newChild);
                      },
                    };
                    childNodes.push(br);
                  } else if (part) {
                    childNodes.push({ nodeType: 3, nodeValue: part, textContent: part });
                  }
                }
                const td = {
                  tagName: 'TD',
                  childNodes,
                  querySelectorAll(sel) {
                    if (sel.toLowerCase() === 'br') return childNodes.filter((c) => c.tagName === 'BR');
                    return [];
                  },
                  get textContent() {
                    return childNodes.map((c) => c.textContent ?? c.nodeValue ?? '').join('');
                  },
                };
                tdNodes.push(td);
              }
              const tr = {
                tagName: 'TR',
                childNodes: tdNodes,
                querySelectorAll(sel) {
                  if (sel.includes('td') || sel.includes('th')) return tdNodes;
                  return [];
                },
              };
              trNodes.push(tr);
            }
            this.childNodes = trNodes;
          },
          get innerHTML() {
            return content;
          },
          querySelectorAll(sel) {
            if (sel === 'br') {
              const brs = [];
              for (const tr of this.childNodes ?? []) {
                for (const td of tr.childNodes ?? []) {
                  for (const c of td.childNodes ?? []) {
                    if (c.tagName === 'BR') brs.push(c);
                  }
                }
              }
              return brs;
            }
            if (sel === 'tr') return this.childNodes ?? [];
            return [];
          },
        };
        return node;
      },
      createTextNode: (text) => ({ nodeType: 3, nodeValue: text, textContent: text }),
    };

    const domRows = annualReportToRows(html);
    assert.deepEqual(domRows, [[multilineNote]]);
  } finally {
    globalThis.document = savedDoc;
  }
});
