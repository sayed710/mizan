import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { apps } from './models/index.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

test('every app on the launcher has its own icon and no icon is orphaned', async () => {
  const { APP_ICON_IDS } = await import('./AppIcon.jsx');
  assert.deepEqual([...APP_ICON_IDS].sort(), apps.map((a) => a.id).sort());
});
