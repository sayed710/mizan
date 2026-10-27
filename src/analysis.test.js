import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { apps, models } from './models/index.js';
import { appAnalyses, recordAnalyses } from './models/analysis.js';

// MOD-007: report functions that only tests called are now reachable from forms and an "Analysis" menu.
test('every record analysis targets a real model and runs on seed data', () => {
  const db = seed();
  for (const [model, list] of Object.entries(recordAnalyses)) {
    assert.ok(models[model], model);
    const rec = (db.records[model] ?? []).find((r) => list.some((a) => !a.when || a.when(r)));
    if (!rec) continue;
    for (const a of list.filter((x) => !x.when || x.when(rec))) assert.doesNotThrow(() => a.run(db, rec), `${model}: ${a.label}`);
  }
});

test('every app analysis has a menu entry in its app and runs for a period', () => {
  const db = seed();
  for (const a of appAnalyses) {
    const app = apps.find((x) => x.id === a.app);
    assert.ok(app, a.app);
    assert.ok(app.menus.flatMap((m) => m.children ?? [m]).some((leaf) => leaf.type === 'analysis' && leaf.analysis === a.key), a.key);
    assert.doesNotThrow(() => a.run(db, { from: '2026-01-01', to: '2026-12-31' }), a.label);
  }
  assert.equal(new Set(appAnalyses.map((a) => a.key)).size, appAnalyses.length, 'menu keys are unique');
});
