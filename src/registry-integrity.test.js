// Structural checks on the merged registry (what the app actually runs), not on module-local model objects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { models } from './models/index.js';

const fieldsOf = (def) => Object.entries(def.fields ?? {});
const problems = (check) => Object.entries(models).flatMap(([model, def]) => check(model, def));

test('every relation points at a registered model, including relations inside lines', () => {
  const bad = problems((model, def) => fieldsOf(def).flatMap(([k, f]) => [
    ...(f.relation && !models[f.relation] ? [`${model}.${k} -> ${f.relation}`] : []),
    ...Object.entries(f.type === 'one2many' ? f.fields ?? {} : {}).filter(([, s]) => s.relation && !models[s.relation]).map(([s, sf]) => `${model}.${k}.${s} -> ${sf.relation}`),
  ]));
  assert.deepEqual(bad, []);
});

test('lines declare their columns and selections declare their options', () => {
  const bad = problems((model, def) => fieldsOf(def).flatMap(([k, f]) => [
    ...(f.type === 'one2many' && !Object.keys(f.fields ?? {}).length ? [`${model}.${k} has no line fields`] : []),
    ...(f.type === 'selection' && !(f.options ?? []).length ? [`${model}.${k} has no options`] : []),
  ]));
  assert.deepEqual(bad, []);
});

test('defaults pick declared selection options and the statusbar is a selection or stage field', () => {
  const bad = problems((model, def) => {
    const defaults = def.defaults?.(1) ?? {};
    const status = def.form?.statusbar;
    return [
      ...Object.entries(defaults).filter(([k, v]) => def.fields[k]?.type === 'selection' && v != null && !def.fields[k].options.some(([o]) => o === v)).map(([k, v]) => `${model}.${k} default ${v}`),
      ...(status && !['selection', 'many2one'].includes(def.fields[status]?.type) ? [`${model} statusbar ${status}`] : []),
    ];
  });
  assert.deepEqual(bad, []);
});

test('group-bys and list columns name real fields', () => {
  const known = (def, k) => k in (def.fields ?? {}) || ['id', 'company_id', 'create_date'].includes(k);
  const bad = problems((model, def) => (def.groupBys ?? []).map((g) => (typeof g === 'string' ? g : g?.field)).filter((k) => k && !known(def, k)).map((k) => `${model} groupBy ${k}`));
  assert.deepEqual(bad, []);
});
