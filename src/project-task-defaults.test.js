import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read } from './orm.js';
import { seed } from './seed.js';
import { changeFormValue, newDefaults } from './views/formDefaults.js';
import { saveFormRecord } from './views/formSave.js';

function fixture() {
  let db = seed();
  const first = create(db, 'project.project', { name: 'First' });
  const second = create(first.db, 'project.project', { name: 'Second' });
  db = { ...second.db, records: { ...second.db.records, 'project.task.type': [] } };
  const stageA = create(db, 'project.task.type', { name: 'First stage', project_ids: [first.id] });
  const stageB = create(stageA.db, 'project.task.type', { name: 'Second stage', project_ids: [second.id] });
  return { db: stageB.db, first: first.id, second: second.id, stageA: stageA.id, stageB: stageB.id };
}

test('project smart-button context supplies the stage before saving a new task', () => {
  const { db, first, stageA } = fixture();
  const values = newDefaults(db, 'project.task', {}, new URLSearchParams(), { field: 'project_id', id: first });
  const saved = saveFormRecord(db, 'project.task', null, { ...values, name: 'Task' });
  assert.equal(read(saved.db, 'project.task', saved.id).stage_id, stageA);
});

test('changing project defaults the stage until a stage is explicitly selected', () => {
  const { db, first, second, stageA, stageB } = fixture();
  const initial = newDefaults(db, 'project.task', {}, new URLSearchParams(), null);
  let changes = changeFormValue('project.task', initial, {}, 'project_id', first, db, false);
  assert.equal(changes.stage_id, stageA);
  changes = changeFormValue('project.task', initial, changes, 'project_id', second, db, false);
  assert.equal(changes.stage_id, stageB);
  changes = changeFormValue('project.task', initial, changes, 'stage_id', stageA, db, true);
  changes = changeFormValue('project.task', initial, changes, 'project_id', second, db, true);
  assert.equal(changes.stage_id, stageA);
  const saved = saveFormRecord(db, 'project.task', null, { ...initial, ...changes, name: 'Changed project' });
  assert.equal(read(saved.db, 'project.task', saved.id).stage_id, stageA);
});
