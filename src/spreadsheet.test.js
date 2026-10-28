import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search } from './orm.js';
import { colName, evaluateSheet } from './models/spreadsheet.js';
import { seed } from './seed.js';

test('literals, references, precedence and ranges', () => {
  const v = evaluateSheet({ A1: '2', A2: '3', A3: '=A1+A2*4', A4: '=(A1+A2)*4', A5: '=SUM(A1:A4)', B1: 'hello', B2: '=B1&" "&"world"', B3: '=-A1^2', B4: '=2^3^1' });
  assert.equal(v.A3, 14);
  assert.equal(v.A4, 20);
  assert.equal(v.A5, 39);
  assert.equal(v.B2, 'hello world');
  assert.equal(v.B3, 4); // as in Excel, unary minus binds tighter than ^
  assert.equal(v.B4, 8);
});

test('functions and comparisons', () => {
  const v = evaluateSheet({ A1: '10', A2: '20', A3: '', A4: 'x', B1: '=AVERAGE(A1:A4)', B2: '=MAX(A1:A2)-MIN(A1:A2)', B3: '=IF(A1>5,"big","small")', B4: '=ROUND(10/3,2)', B5: '=COUNT(A1:A4)', B6: '=COUNTA(A1:A4)', B7: '=AND(A1=10,A2<>10)' });
  assert.deepEqual([v.B1, v.B2, v.B3, v.B4, v.B5, v.B6, v.B7], [15, 10, 'big', 3.33, 2, 3, true]);
});

test('errors: division by zero, unknown function, syntax, cycles, and errors propagating through references', () => {
  const v = evaluateSheet({ A1: '=1/0', A2: '=FOO(1)', A3: '=1+', A4: '=B4', B4: '=A4', A5: '=A1+1', A6: '="a"*2' });
  assert.equal(v.A1, '#DIV/0!');
  assert.match(v.A2, /Unknown function FOO/);
  assert.match(v.A3, /^#ERROR/);
  assert.equal(v.A4, '#CYCLE!');
  assert.equal(v.A5, '#DIV/0!');
  assert.equal(v.A6, '#VALUE!');
});

test('ERP functions read live records with an optional filter', () => {
  const db = seed();
  const posted = search(db, 'account.move').filter((m) => m.state === 'posted');
  const v = evaluateSheet({ A1: '=MIZAN.COUNT("account.move","","state=posted")', A2: '=MIZAN.SUM("account.move","amount_total","state=posted")', A3: '=MIZAN.COUNT("res.partner")' }, db);
  assert.equal(v.A1, posted.length);
  assert.equal(Math.round(v.A2 * 100), Math.round(posted.reduce((s, m) => s + m.amount_total, 0) * 100));
  assert.equal(v.A3, search(db, 'res.partner').length);
  assert.match(evaluateSheet({ A1: '=MIZAN.COUNT("res.partner")' }).A1, /not available/);
  assert.deepEqual([colName(0), colName(25), colName(26), colName(27)], ['A', 'Z', 'AA', 'AB']);
});
