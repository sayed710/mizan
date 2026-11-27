import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabFieldReadonly } from './field-metadata.js';
import { reportRecordModels } from './models/reportRecords.js';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { targetOf } from './models/index.js';
import { register } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

test('computed report line relations are read-only in form tabs', () => {
  const fields = reportRecordModels['account.report.line'].fields;
  assert.equal(tabFieldReadonly(false, fields.children_ids, {}, {}), true);
  assert.equal(tabFieldReadonly(false, fields.expression_ids, {}, {}), true);
  assert.equal(tabFieldReadonly(false, fields.name, {}, {}), false);
  assert.equal(tabFieldReadonly(true, fields.name, {}, {}), true);
});

test('related report records have editor routes and persist edits', async () => {
  let db = seed();
  const report = db.records['account.report'].find((item) => item.kind === 'pnl');
  const parent = create(db, 'account.report.line', { report_id: report.id, name: 'Parent', code: 'EDITOR_PARENT' }); db = parent.db;
  const child = create(db, 'account.report.line', { report_id: report.id, parent_id: parent.id, name: 'Child', code: 'EDITOR_CHILD' }); db = child.db;
  const expression = create(db, 'account.report.expression', { report_line_id: parent.id, label: 'balance', engine: 'domain', formula: '[]', subformula: 'sum', date_scope: 'strict_range' }); db = expression.db;
  assert.notEqual(targetOf('account.report.line'), '#/');
  assert.notEqual(targetOf('account.report.expression'), '#/');
  const fields = reportRecordModels['account.report.line'].fields;
  assert.equal(fields.children_ids.openRelated, true);
  assert.equal(fields.expression_ids.openRelated, true);
  const { FieldInput } = await import('./ui.jsx');
  for (const [name, id] of [['children_ids', child.id], ['expression_ids', expression.id]]) {
    const field = fields[name];
    const html = renderToStaticMarkup(React.createElement(FieldInput, { db, model: 'account.report.line', fieldName: name, field, value: field.compute(parent.record ?? read(db, 'account.report.line', parent.id), db), readonly: true, onChange: () => {} }));
    assert.ok(html.includes(`#/open/${field.relation}/${id}`));
  }
  db = write(db, 'account.report.line', child.id, { name: 'Saved child' });
  db = write(db, 'account.report.expression', expression.id, { formula: '[["company_id","=",1]]' });
  assert.equal(read(db, 'account.report.line', parent.id).children_ids[0].name, 'Saved child');
  assert.equal(read(db, 'account.report.line', parent.id).expression_ids[0].formula, '[["company_id","=",1]]');
});
