import { test } from 'node:test';
import assert from 'node:assert/strict';
import './seed.js';
import { MODEL_MODULES, models } from './models/index.js';
import { composeModels, modelOverrides } from './models/compose.js';

test('models are composed from the declared module order', () => {
  const composed = composeModels(MODEL_MODULES);
  for (const name of Object.keys(composed)) assert.ok(models[name], name);
  assert.deepEqual(Object.keys(models).sort(), Object.keys(composed).sort());
});

test('a module that redefines a model extends it: no field, button, hook, view or filter is dropped', () => {
  const overrides = modelOverrides(MODEL_MODULES);
  assert.ok(overrides.length > 20, 'extension modules override base models');
  assert.deepEqual(overrides.filter((o) => Object.keys(o.drops).length), []);
});

test('the override report names what a replacing definition would drop', () => {
  const base = { a: { fields: { x: {}, y: {} }, guard: () => null, views: ['list', 'kanban'], form: { buttons: [{ label: 'Go' }] } } };
  const replacing = { a: { fields: { x: {} }, views: ['list'], form: { buttons: [] } } };
  assert.deepEqual(modelOverrides({ base, replacing }), [{ model: 'a', from: 'base', by: 'replacing', drops: { fields: ['y'], buttons: ['Go'], hooks: ['guard'], views: ['kanban'] } }]);
});
