import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import './models/index.js';

for (const [model, stageModel, scope, scopeList, related] of [
  ['crm.lead', 'crm.stage', 'team_id', 'team_ids', 'crm.team'],
  ['project.task', 'project.task.type', 'project_id', 'project_ids', 'project.project'],
]) {
  test(`${model} defaults to the first applicable existing stage`, () => {
    const base = seed();
    let db = { ...base, records: { ...base.records, [stageModel]: [] } };
    const [first, second] = search(db, related);
    const foreign = create(db, stageModel, { name: 'Foreign', sequence: 1, [scopeList]: [second.id] }); db = foreign.db;
    const later = create(db, stageModel, { name: 'Later', sequence: 20, [scopeList]: [] }); db = later.db;
    const selected = create(db, stageModel, { name: 'Applicable', sequence: 5, [scopeList]: [first.id] }); db = selected.db;
    const tied = create(db, stageModel, { name: 'Tie', sequence: 5, [scopeList]: [first.id] }); db = tied.db;
    if (model === 'project.task') db = create(db, stageModel, { name: 'Archived', active: false, sequence: 0 }).db;
    const record = create(db, model, { name: 'Scoped record', [scope]: first.id }); db = record.db;
    assert.equal(read(db, model, record.id).stage_id, selected.id);
    const other = create(db, model, { name: 'Other scope', [scope]: second.id }); db = other.db;
    assert.equal(read(db, model, other.id).stage_id, foreign.id);
    const unscoped = create(db, model, { name: 'Unscoped' }); db = unscoped.db;
    assert.equal(read(db, model, unscoped.id).stage_id, later.id);
    const explicit = create(db, model, { name: 'Explicit', [scope]: first.id, stage_id: tied.id }); db = explicit.db;
    assert.equal(read(db, model, explicit.id).stage_id, tied.id);
    const blank = create(db, model, { name: 'Explicitly empty', [scope]: first.id, stage_id: null });
    assert.equal(read(blank.db, model, blank.id).stage_id, null);
  });

  test(`${model} leaves the stage empty when no appropriate stage exists`, () => {
    const base = seed();
    let db = { ...base, records: { ...base.records, [stageModel]: [] } };
    const empty = create(db, model, { name: 'No stages' }); db = empty.db;
    assert.equal(read(db, model, empty.id).stage_id, null);
    const [first, second] = search(db, related);
    db = create(db, stageModel, { name: 'Only another scope', [scopeList]: [second.id] }).db;
    const scoped = create(db, model, { name: 'No applicable stage', [scope]: first.id });
    assert.equal(read(scoped.db, model, scoped.id).stage_id, null);
  });
}
