import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { models, menusFor } from './models/index.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { addDays, today } from './models/common.js';
import { isRotting, stageColumnsFor } from './models/crm.js';

test('crm.stage, crm.lost.reason, project.task.type, and project.tags models are registered with reference fields', () => {
  const crmStage = models['crm.stage'];
  assert.ok(crmStage, 'crm.stage registered');
  assert.equal(crmStage.fields.name.type, 'char');
  assert.equal(crmStage.fields.name.required, true);
  assert.equal(crmStage.fields.sequence.type, 'integer');
  assert.equal(crmStage.fields.is_won.type, 'boolean');
  assert.equal(crmStage.fields.fold.type, 'boolean');
  assert.equal(crmStage.fields.requirements.type, 'text');
  assert.equal(crmStage.fields.rotting_threshold_days.type, 'integer');
  assert.equal(crmStage.fields.team_ids.type, 'many2many');
  assert.equal(crmStage.fields.team_ids.relation, 'crm.team');

  const lostReason = models['crm.lost.reason'];
  assert.ok(lostReason, 'crm.lost.reason registered');
  assert.equal(lostReason.fields.name.type, 'char');
  assert.equal(lostReason.fields.name.required, true);
  assert.equal(lostReason.fields.active.type, 'boolean');

  const taskType = models['project.task.type'];
  assert.ok(taskType, 'project.task.type registered');
  assert.equal(taskType.fields.name.type, 'char');
  assert.equal(taskType.fields.name.required, true);
  assert.equal(taskType.fields.active.type, 'boolean');
  assert.equal(taskType.fields.sequence.type, 'integer');
  assert.equal(taskType.fields.project_ids.type, 'many2many');
  assert.equal(taskType.fields.project_ids.relation, 'project.project');
  assert.equal(taskType.fields.fold.type, 'boolean');
  assert.equal(taskType.fields.user_id.type, 'many2one');
  assert.equal(taskType.fields.rotting_threshold_days.type, 'integer');
  assert.ok(taskType.fields.auto_validation_state);

  const projectTags = models['project.tags'];
  assert.ok(projectTags, 'project.tags registered');
  assert.equal(projectTags.fields.name.type, 'char');
  assert.equal(projectTags.fields.name.required, true);
  assert.equal(projectTags.fields.color.type, 'integer');

  assert.equal(models['crm.lead'].fields.stage_id.type, 'many2one');
  assert.equal(models['crm.lead'].fields.stage_id.relation, 'crm.stage');
  assert.equal(models['crm.lead'].fields.lost_reason_id.type, 'many2one');
  assert.equal(models['crm.lead'].fields.lost_reason_id.relation, 'crm.lost.reason');
  assert.equal(models['crm.lead'].fields.lost_feedback.type, 'text');

  assert.equal(models['project.task'].fields.stage_id.type, 'many2one');
  assert.equal(models['project.task'].fields.stage_id.relation, 'project.task.type');
  assert.equal(models['project.task'].fields.tag_ids.type, 'many2many');
  assert.equal(models['project.task'].fields.tag_ids.relation, 'project.tags');
  assert.equal(models['project.project'].fields.tag_ids.type, 'many2many');
  assert.equal(models['project.project'].fields.tag_ids.relation, 'project.tags');
});

test('configuration menus expose CRM stages, lost reasons, task stages, and tags', () => {
  const crmMenus = menusFor('crm');
  const crmConfig = crmMenus.find((m) => m.label === 'Configuration')?.children ?? [];
  assert.ok(crmConfig.some((c) => c.label === 'Stages' && c.model === 'crm.stage'));
  assert.ok(crmConfig.some((c) => c.label === 'Lost Reasons' && c.model === 'crm.lost.reason'));

  const projMenus = menusFor('project');
  const projConfig = projMenus.find((m) => m.label === 'Configuration')?.children ?? [];
  assert.ok(projConfig.some((c) => c.label === 'Task Stages' && c.model === 'project.task.type'));
  assert.ok(projConfig.some((c) => c.label === 'Tags' && c.model === 'project.tags'));
});

test('seed populates configurable stages, reasons, tags, and references them on leads and tasks', () => {
  const db = seed();
  const crmStages = search(db, 'crm.stage');
  assert.ok(crmStages.length >= 4);
  assert.deepEqual(crmStages.map((s) => s.name).slice(0, 4), ['New', 'Qualified', 'Proposition', 'Won']);
  const wonStage = crmStages.find((s) => s.is_won);
  assert.ok(wonStage, 'seeded won stage exists');
  assert.equal(wonStage.name, 'Won');
  assert.equal(wonStage.fold, true);

  const taskStages = search(db, 'project.task.type');
  assert.ok(taskStages.length >= 4);
  assert.deepEqual(taskStages.map((s) => s.name).slice(0, 4), ['To Do', 'In Progress', 'Review', 'Done']);
  const doneStage = taskStages.find((s) => s.name === 'Done');
  assert.equal(doneStage.fold, true);

  const reasons = search(db, 'crm.lost.reason');
  assert.ok(reasons.length >= 5);
  assert.ok(reasons.some((r) => r.name === 'Too expensive'));

  const tags = search(db, 'project.tags');
  assert.ok(tags.length >= 2);

  const leads = search(db, 'crm.lead');
  assert.ok(leads.every((l) => typeof l.stage_id === 'number' && read(db, 'crm.stage', l.stage_id)));
  assert.ok(leads.every((l) => l.date_last_stage_update));

  const tasks = search(db, 'project.task');
  assert.ok(tasks.every((t) => typeof t.stage_id === 'number' && read(db, 'project.task.type', t.stage_id)));
  assert.ok(tasks.every((t) => t.date_last_stage_update));
});

test('migration v9 transforms legacy string stages, lost reasons, and tags without data loss', () => {
  const base = seed();
  const legacyLeads = [
    { id: 101, name: 'Lead New', stage_id: 'new', active: true, create_date: '2026-01-01' },
    { id: 102, name: 'Lead Won', stage_id: 'won', active: true, create_date: '2026-01-02' },
    { id: 103, name: 'Lead Lost', stage_id: 'qualified', active: false, lost_reason: 'price', create_date: '2026-01-03' },
  ];
  const legacyTasks = [
    { id: 201, name: 'Task 1', stage_id: 'todo', tag_ids: ['VIP', 'Urgent'], date_start: '2026-01-01' },
    { id: 202, name: 'Task 2', stage_id: 'done', tag_ids: ['Urgent'], date_start: '2026-01-02' },
  ];
  const legacyProjects = [
    { id: 301, name: 'Project 1', tag_ids: ['VIP'] },
  ];

  const oldDb = {
    ...base,
    schema_version: 8,
    records: {
      ...base.records,
      'crm.lead': legacyLeads,
      'project.task': legacyTasks,
      'project.project': legacyProjects,
      'crm.stage': [],
      'project.task.type': [],
      'crm.lost.reason': [],
      'project.tags': [],
    },
  };

  const migrated = migrate(oldDb);
  assert.equal(migrated.schema_version, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 9);

  const l1 = read(migrated, 'crm.lead', 101);
  assert.equal(typeof l1.stage_id, 'number');
  assert.equal(read(migrated, 'crm.stage', l1.stage_id).name, 'New');
  assert.equal(l1.date_last_stage_update, '2026-01-01');

  const l2 = read(migrated, 'crm.lead', 102);
  assert.equal(typeof l2.stage_id, 'number');
  assert.equal(read(migrated, 'crm.stage', l2.stage_id).is_won, true);

  const l3 = read(migrated, 'crm.lead', 103);
  assert.equal(typeof l3.lost_reason_id, 'number');
  assert.match(read(migrated, 'crm.lost.reason', l3.lost_reason_id).name, /expensive/i);

  const t1 = read(migrated, 'project.task', 201);
  assert.equal(typeof t1.stage_id, 'number');
  assert.equal(read(migrated, 'project.task.type', t1.stage_id).name, 'To Do');
  assert.ok(Array.isArray(t1.tag_ids) && t1.tag_ids.length === 2);
  assert.ok(t1.tag_ids.every((id) => typeof id === 'number' && read(migrated, 'project.tags', id)));

  const p1 = read(migrated, 'project.project', 301);
  assert.ok(Array.isArray(p1.tag_ids) && p1.tag_ids.length === 1);
  assert.equal(read(migrated, 'project.tags', p1.tag_ids[0]).name, 'VIP');
});

test('kanban columns filter CRM stages by sales team and task stages by project in sequence order', () => {
  let db = seed();
  const team1 = search(db, 'crm.team')[0].id;
  const team2 = search(db, 'crm.team')[1].id;

  // Add a team-specific stage for team1 only
  const { db: withStages, id: specialStageId } = create(db, 'crm.stage', {
    name: 'Special Evaluation',
    sequence: 25,
    team_ids: [team1],
    fold: true,
  });
  db = withStages;

  // Team 1 sees common stages + special stage
  const colsTeam1 = stageColumnsFor(db, 'crm.lead', { team_id: team1 });
  assert.ok(colsTeam1.some((c) => c.key === specialStageId));
  assert.ok(colsTeam1.some((c) => c.label === 'New'));

  // Team 2 does NOT see special stage
  const colsTeam2 = stageColumnsFor(db, 'crm.lead', { team_id: team2 });
  assert.ok(!colsTeam2.some((c) => c.key === specialStageId));

  // Sequence order is maintained
  const sequences = colsTeam1.map((c) => read(db, 'crm.stage', c.key).sequence ?? 0);
  for (let i = 1; i < sequences.length; i += 1) {
    assert.ok(sequences[i] >= sequences[i - 1], 'stages sorted by sequence');
  }

  // Folded stage is indicated in column metadata
  const specialCol = colsTeam1.find((c) => c.key === specialStageId);
  assert.equal(specialCol.fold, true);

  // Project task stages filtering
  const proj1 = search(db, 'project.project')[0].id;
  const proj2 = search(db, 'project.project')[1].id;
  const { db: withTaskStage, id: proj1StageId } = create(db, 'project.task.type', {
    name: 'Client Approval',
    sequence: 35,
    project_ids: [proj1],
    fold: true,
  });
  db = withTaskStage;

  const taskColsProj1 = stageColumnsFor(db, 'project.task', { project_id: proj1 });
  assert.ok(taskColsProj1.some((c) => c.key === proj1StageId));

  const taskColsProj2 = stageColumnsFor(db, 'project.task', { project_id: proj2 });
  assert.ok(!taskColsProj2.some((c) => c.key === proj1StageId));
});

test('moving lead to an is_won stage marks it won; Won button navigates to won stage', () => {
  let db = seed();
  const wonStage = search(db, 'crm.stage').find((s) => s.is_won);
  const newStage = search(db, 'crm.stage').find((s) => s.name === 'New');
  const { db: d1, id: leadId } = create(db, 'crm.lead', {
    name: 'Won Test Lead',
    stage_id: newStage.id,
    probability: 10,
    type: 'opportunity',
  });

  // Writing won stage updates probability to 100 via onchange
  const d2 = write(d1, 'crm.lead', leadId, { stage_id: wonStage.id });
  const leadWon = read(d2, 'crm.lead', leadId);
  assert.equal(leadWon.stage_id, wonStage.id);
  assert.equal(leadWon.probability, 100);

  // Won button on form
  const btnWon = models['crm.lead'].form.buttons.find((b) => b.label === 'Won');
  assert.ok(btnWon);
  const runRes = btnWon.run(d1, read(d1, 'crm.lead', leadId));
  const fromBtn = read(runRes.db, 'crm.lead', leadId);
  assert.equal(fromBtn.stage_id, wonStage.id);
  assert.equal(fromBtn.probability, 100);
});

test('Lost action on crm.lead opens wizard with reason and closing note, then archives lead', () => {
  const db = seed();
  const reasons = search(db, 'crm.lost.reason');
  const targetReason = reasons[0];
  const lead = search(db, 'crm.lead')[0];

  const lostBtn = models['crm.lead'].form.buttons.find((b) => b.label === 'Lost');
  assert.ok(lostBtn, 'Lost button exists');
  assert.ok(lostBtn.wizard, 'Lost button has wizard');

  const wizSpec = lostBtn.wizard(db, lead);
  assert.ok(wizSpec.fields.some((f) => f.name === 'lost_reason_id' && f.type === 'many2one' && f.relation === 'crm.lost.reason'));
  assert.ok(wizSpec.fields.some((f) => f.name === 'lost_feedback' && f.type === 'text'));

  const result = lostBtn.run(db, lead, { lost_reason_id: targetReason.id, lost_feedback: 'Customer went with competitor X due to budget' });
  const lostLead = read(result.db, 'crm.lead', lead.id);
  assert.equal(lostLead.active, false);
  assert.equal(lostLead.probability, 0);
  assert.equal(lostLead.lost_reason_id, targetReason.id);
  assert.equal(lostLead.lost_feedback, 'Customer went with competitor X due to budget');

  // Restore button restores active state
  const restoreBtn = models['crm.lead'].form.buttons.find((b) => b.label === 'Restore');
  assert.ok(restoreBtn);
  const restored = models['crm.lead'].form.buttons.find((b) => b.label === 'Restore').vals;
  const d3 = write(result.db, 'crm.lead', lead.id, restored);
  const restoredLead = read(d3, 'crm.lead', lead.id);
  assert.equal(restoredLead.active, true);
  assert.equal(restoredLead.lost_reason_id, null);
});

test('rotting threshold computes whether lead or task has stayed in stage too long', () => {
  let db = seed();
  const { db: d1, id: rottingStageId } = create(db, 'crm.stage', {
    name: 'Slow Stage',
    sequence: 50,
    rotting_threshold_days: 7,
  });
  db = d1;

  // Fresh lead (0 days in stage)
  const { db: d2, id: freshLeadId } = create(db, 'crm.lead', {
    name: 'Fresh Lead',
    stage_id: rottingStageId,
    date_last_stage_update: today(),
  });
  db = d2;
  assert.equal(isRotting(db, 'crm.lead', read(db, 'crm.lead', freshLeadId)), false);

  // Lead that entered 8 days ago (exceeds threshold of 7 days)
  const { db: d3, id: rottenLeadId } = create(db, 'crm.lead', {
    name: 'Rotten Lead',
    stage_id: rottingStageId,
    date_last_stage_update: addDays(today(), -8),
  });
  db = d3;
  assert.equal(isRotting(db, 'crm.lead', read(db, 'crm.lead', rottenLeadId)), true);

  // Exactly at threshold (7 days) is not strictly longer than threshold
  const { db: d4, id: boundaryLeadId } = create(db, 'crm.lead', {
    name: 'Boundary Lead',
    stage_id: rottingStageId,
    date_last_stage_update: addDays(today(), -7),
  });
  db = d4;
  assert.equal(isRotting(db, 'crm.lead', read(db, 'crm.lead', boundaryLeadId)), false);

  // Rotting filter on crm.lead
  const allLeads = [read(db, 'crm.lead', freshLeadId), read(db, 'crm.lead', rottenLeadId), read(db, 'crm.lead', boundaryLeadId)];
  const rottingFilter = models['crm.lead'].filters.flat().find((f) => f.id === 'rotting');
  assert.ok(rottingFilter, 'rotting filter exists on crm.lead');
  const filtered = allLeads.filter(rottingFilter.fn);
  assert.deepEqual(filtered.map((l) => l.id), [rottenLeadId]);
});
