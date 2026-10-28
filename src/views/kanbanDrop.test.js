import { test } from 'node:test';
import assert from 'node:assert/strict';
import { models } from '../models/index.js';
import { canDropOn } from './kanbanDrop.js';

test('workflow states cannot be changed by dragging a card', () => {
  for (const [model, field] of [['account.move', 'state'], ['hr.leave', 'state'], ['approval.request', models['approval.request'].form.statusbar], ['stock.picking', 'state'], ['pos.order', 'state'], ['hr.expense', 'state']]) {
    assert.equal(canDropOn(model, field), false, `${model}.${field}`);
  }
});

test('no model accepts drops on a status bar its form does not let users click', () => {
  for (const [model, def] of Object.entries(models)) {
    const bar = def.form?.statusbar;
    if (bar && !def.form.statusbarClickable) assert.equal(canDropOn(model, bar), false, model);
    if (def.fields.state && bar !== 'state') assert.equal(canDropOn(model, 'state'), false, model);
  }
});

test('pipeline stages and ordinary fields stay draggable', () => {
  assert.equal(canDropOn('crm.lead', 'stage_id'), true);
  assert.equal(canDropOn('project.task', 'stage_id'), true);
  assert.equal(canDropOn('crm.lead', 'team_id'), true);
  assert.equal(canDropOn('crm.lead', 'missing_field'), false);
  // Talks have no stage actions: the stage is picked freely in the form, so dragging between stage columns works too.
  assert.equal(canDropOn('event.track', 'stage'), true);
  // Booths become sold only through invoicing, so their state column still refuses drops.
  assert.equal(canDropOn('event.booth', 'state'), false);
});
