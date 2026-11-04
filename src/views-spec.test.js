import { test } from 'node:test';
import assert from 'node:assert/strict';
import { models, viewsOf } from './models/index.js';

test('every model offers only views it has a spec for, and at least one view', () => {
  for (const model of Object.keys(models)) {
    const views = viewsOf(model);
    assert.ok(views.length, model);
    for (const view of ['kanban', 'calendar', 'gantt']) if (views.includes(view)) assert.ok(models[model][view], `${model} offers ${view} without a spec`);
  }
  assert.deepEqual(viewsOf('stock.warehouse'), ['list']);
});
