import { test } from 'node:test';
import assert from 'node:assert/strict';
import { models } from './models/index.js';

// Features with no real outside effect must say so on screen (MOD-006); FormView/ActionView render `simulated`.
test('features that only record an outside action are labelled as simulations', () => {
  for (const model of ['social.account', 'social.post', 'marketing.campaign']) {
    assert.equal(typeof models[model].simulated, 'string', model);
    assert.ok(models[model].simulated.length > 20, model);
  }
  assert.equal(models['documents.share'].simulated, undefined, 'share links have a real public route');
});
