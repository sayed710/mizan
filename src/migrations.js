// Versioned data migrations. The database records the last version applied (`schema_version`), so each migration
// runs once per database and its result is saved like any other change. Append new steps; never edit old ones.
import { models } from './models/index.js';
import { create, search, write } from './orm.js';
import { migrateAppointments } from './models/appointments.js';
import { migrateDocumentTags } from './models/signplus.js';
import { migrateWorkorderTimes } from './models/workorder.js';
import { ensureQuants } from './models/quant.js';
import { migrateTimeOff } from './models/timeoff.js';
import { migrateOrderpoints } from './models/orderpoint.js';
import { migrateProductCategories } from './models/productconfig.js';
import { today } from './models/common.js';
import { journalId } from './models/ledger.js';
import { migrateLegacyRentalBilling } from './models/rentalbilling.js';

export function migrateStages(db) {
  const next = db;
  // 1. Ensure crm.stage
  const existingCrmStages = next.records['crm.stage'] ?? [];
  const defaultCrmStages = [
    { name: 'New', sequence: 1, is_won: false, fold: false, team_ids: [], rotting_threshold_days: 0 },
    { name: 'Qualified', sequence: 2, is_won: false, fold: false, team_ids: [], rotting_threshold_days: 0 },
    { name: 'Proposition', sequence: 3, is_won: false, fold: false, team_ids: [], rotting_threshold_days: 0 },
    { name: 'Won', sequence: 4, is_won: true, fold: true, team_ids: [], rotting_threshold_days: 0 },
  ];
  const crmStages = [...existingCrmStages];
  let crmSeq = next.seq?.['crm.stage'] ?? 0;
  if (!crmStages.length) {
    defaultCrmStages.forEach((s) => {
      crmSeq += 1;
      crmStages.push({ ...s, id: crmSeq });
    });
  }

  // 2. Ensure project.task.type
  const existingTaskStages = next.records['project.task.type'] ?? [];
  const defaultTaskStages = [
    { name: 'To Do', sequence: 1, active: true, project_ids: [], fold: false, rotting_threshold_days: 0 },
    { name: 'In Progress', sequence: 2, active: true, project_ids: [], fold: false, rotting_threshold_days: 0 },
    { name: 'Review', sequence: 3, active: true, project_ids: [], fold: false, rotting_threshold_days: 0 },
    { name: 'Done', sequence: 4, active: true, project_ids: [], fold: true, rotting_threshold_days: 0 },
  ];
  const taskStages = [...existingTaskStages];
  let taskSeq = next.seq?.['project.task.type'] ?? 0;
  if (!taskStages.length) {
    defaultTaskStages.forEach((s) => {
      taskSeq += 1;
      taskStages.push({ ...s, id: taskSeq });
    });
  }

  // 3. Ensure crm.lost.reason
  const existingReasons = next.records['crm.lost.reason'] ?? [];
  const defaultReasons = [
    { name: 'Too expensive', active: true },
    { name: 'We lost to a competitor', active: true },
    { name: 'Not the right timing', active: true },
    { name: 'No answer', active: true },
    { name: 'Other', active: true },
  ];
  const reasons = [...existingReasons];
  let reasonSeq = next.seq?.['crm.lost.reason'] ?? 0;
  if (!reasons.length) {
    defaultReasons.forEach((r) => {
      reasonSeq += 1;
      reasons.push({ ...r, id: reasonSeq });
    });
  }

  // 4. Ensure project.tags
  const existingTags = next.records['project.tags'] ?? [];
  const tags = [...existingTags];
  let tagSeq = next.seq?.['project.tags'] ?? 0;
  const tagMap = new Map(tags.map((t) => [t.name.toLowerCase(), t.id]));
  const ensureTag = (name) => {
    const key = String(name).trim().toLowerCase();
    if (!key) return null;
    if (tagMap.has(key)) return tagMap.get(key);
    tagSeq += 1;
    const tag = { id: tagSeq, name: String(name).trim(), color: tagSeq };
    tags.push(tag);
    tagMap.set(key, tagSeq);
    return tagSeq;
  };

  // Map legacy tags on project.project
  const projects = (next.records['project.project'] ?? []).map((p) => {
    if (!Array.isArray(p.tag_ids)) return p;
    const tagIds = [...new Set(p.tag_ids.map((t) => (typeof t === 'number' ? t : ensureTag(t))).filter(Boolean))];
    return { ...p, tag_ids: tagIds };
  });

  // Map legacy tags and stages on project.task
  const taskStageKeyMap = {
    todo: taskStages.find((s) => /to\s*do/i.test(s.name))?.id ?? taskStages[0]?.id ?? 1,
    progress: taskStages.find((s) => /progress/i.test(s.name))?.id ?? taskStages[1]?.id ?? 2,
    review: taskStages.find((s) => /review/i.test(s.name))?.id ?? taskStages[2]?.id ?? 3,
    done: taskStages.find((s) => /done/i.test(s.name))?.id ?? taskStages[3]?.id ?? 4,
  };
  const tasks = (next.records['project.task'] ?? []).map((t) => {
    let stage_id = t.stage_id;
    if (typeof stage_id === 'string') {
      stage_id = taskStageKeyMap[stage_id.toLowerCase()] ?? taskStages.find((s) => s.name.toLowerCase() === stage_id.toLowerCase())?.id ?? taskStages[0]?.id ?? 1;
    }
    const tagIds = Array.isArray(t.tag_ids) ? [...new Set(t.tag_ids.map((tag) => (typeof tag === 'number' ? tag : ensureTag(tag))).filter(Boolean))] : [];
    return {
      ...t,
      stage_id,
      tag_ids: tagIds,
      date_last_stage_update: t.date_last_stage_update || t.date_start || today(),
    };
  });

  // Map legacy stages and lost reasons on crm.lead
  const crmStageKeyMap = {
    new: crmStages.find((s) => /new/i.test(s.name))?.id ?? crmStages[0]?.id ?? 1,
    qualified: crmStages.find((s) => /qualified/i.test(s.name))?.id ?? crmStages[1]?.id ?? 2,
    proposition: crmStages.find((s) => /proposition/i.test(s.name))?.id ?? crmStages[2]?.id ?? 3,
    won: crmStages.find((s) => s.is_won || /won/i.test(s.name))?.id ?? crmStages[3]?.id ?? 4,
  };
  const lostReasonKeyMap = {
    price: reasons.find((r) => /expensive/i.test(r.name))?.id ?? reasons[0]?.id ?? 1,
    competitor: reasons.find((r) => /competitor/i.test(r.name))?.id ?? reasons[1]?.id ?? 2,
    timing: reasons.find((r) => /timing/i.test(r.name))?.id ?? reasons[2]?.id ?? 3,
    no_answer: reasons.find((r) => /no\s*answer/i.test(r.name))?.id ?? reasons[3]?.id ?? 4,
    other: reasons.find((r) => /other/i.test(r.name))?.id ?? reasons[4]?.id ?? 5,
  };
  const leads = (next.records['crm.lead'] ?? []).map((l) => {
    let stage_id = l.stage_id;
    if (typeof stage_id === 'string') {
      stage_id = crmStageKeyMap[stage_id.toLowerCase()] ?? crmStages.find((s) => s.name.toLowerCase() === stage_id.toLowerCase())?.id ?? crmStages[0]?.id ?? 1;
    }
    let lost_reason_id = l.lost_reason_id;
    if (lost_reason_id == null && l.lost_reason) {
      lost_reason_id = typeof l.lost_reason === 'number' ? l.lost_reason : (lostReasonKeyMap[String(l.lost_reason).toLowerCase()] ?? reasons[0]?.id ?? null);
    }
    const { lost_reason: _legacy, ...rest } = l;
    return {
      ...rest,
      stage_id,
      lost_reason_id: lost_reason_id ?? null,
      lost_feedback: l.lost_feedback ?? '',
      date_last_stage_update: l.date_last_stage_update || l.create_date || today(),
    };
  });

  return {
    ...next,
    records: {
      ...next.records,
      'crm.stage': crmStages,
      'project.task.type': taskStages,
      'crm.lost.reason': reasons,
      'project.tags': tags,
      'crm.lead': leads,
      'project.task': tasks,
      'project.project': projects,
    },
    seq: {
      ...next.seq,
      'crm.stage': crmSeq,
      'project.task.type': taskSeq,
      'crm.lost.reason': reasonSeq,
      'project.tags': tagSeq,
    },
  };
}

/** Preserve old tender names and amounts while assigning stable method records. */
export function migratePosMethods(db) {
  let next = db;
  const companies = new Set([1, ...(db.records['res.company'] ?? []).map((c) => c.id), ...(db.records['pos.config'] ?? []).map((c) => c.company_id ?? 1)]);

  for (const company_id of companies) {
    for (const [name, type, journal] of [['Cash', 'cash', 'CSH1'], ['Card', 'bank', 'BNK1']]) {
      if (!(next.records['pos.payment.method'] ?? []).some((m) => (m.company_id ?? 1) === company_id && m.type === type && m.name === name)) {
        next = create(next, 'pos.payment.method', { name, type, company_id, journal_id: journalId(next, journal), config_ids: [] }).db;
      }
    }
  }

  for (const c of (next.records['pos.config'] ?? [])) {
    const compId = c.company_id ?? 1;
    for (const p of (c.payment_method_ids ?? [])) {
      if (typeof p === 'object' && p !== null) {
        const name = p.name || (p.journal === 'cash' ? 'Cash' : 'Card');
        const type = p.type || (p.journal === 'cash' ? 'cash' : 'bank');
        const journal = journalId(next, p.journal === 'cash' ? 'CSH1' : 'BNK1');
        let existing = (next.records['pos.payment.method'] ?? []).find((m) => (m.company_id ?? 1) === compId && m.name === name && m.type === type);
        if (!existing) {
          const res = create(next, 'pos.payment.method', { name, type, company_id: compId, journal_id: journal, config_ids: [c.id] });
          next = res.db;
        } else if (!existing.config_ids?.includes(c.id)) {
          next = write(next, 'pos.payment.method', existing.id, { config_ids: [...(existing.config_ids ?? []), c.id] });
        }
      }
    }
  }

  for (const c of (next.records['pos.config'] ?? [])) {
    const compId = c.company_id ?? 1;
    for (const type of ['cash', 'bank']) {
      const defMethod = (next.records['pos.payment.method'] ?? []).find((m) => (m.company_id ?? 1) === compId && m.type === type);
      if (defMethod && !defMethod.config_ids?.includes(c.id)) {
        next = write(next, 'pos.payment.method', defMethod.id, { config_ids: [...(defMethod.config_ids ?? []), c.id] });
      }
    }
  }

  const method = (company, typeOrName) => (next.records['pos.payment.method'] ?? []).find((m) => (m.company_id ?? 1) === company && (m.name === typeOrName || m.type === (typeOrName === 'cash' ? 'cash' : 'bank')))?.id;

  const configs = (next.records['pos.config'] ?? []).map((c) => {
    const compId = c.company_id ?? 1;
    return {
      ...c,
      payment_method_ids: (c.payment_method_ids ?? []).map((p) => (typeof p === 'object' && p !== null ? { ...p, payment_method_id: p.payment_method_id ?? method(compId, p.name) ?? method(compId, p.journal) } : p)),
      available_preset_ids: c.available_preset_ids ?? [],
      cash_rounding: c.cash_rounding ?? false,
      only_round_cash_method: c.only_round_cash_method ?? false,
    };
  });

  const orders = (next.records['pos.order'] ?? []).map((o) => {
    const compId = o.company_id ?? 1;
    const defaultMethod = method(compId, o.payment_method ?? 'cash');
    return {
      ...o,
      payment_method_id: o.payment_method_id ?? defaultMethod,
      payment_ids: (o.payment_ids ?? []).map((p) => ({
        ...p,
        payment_method_id: p.payment_method_id ?? method(compId, p.method ?? p.name ?? 'cash'),
      })),
    };
  });

  return { ...next, records: { ...next.records, ...(next.records['pos.config'] ? { 'pos.config': configs } : {}), ...(next.records['pos.order'] ? { 'pos.order': orders } : {}) } };
}

/** Tag lists stored as names (['Tax']) become lines pointing at documents.tag records, creating missing tags. */
function documentTagLines(db) {
  let next = db;
  const tagId = (name) => {
    const found = search(next, 'documents.tag', { includeArchived: true }).find((t) => t.name === name);
    if (found) return found.id;
    const made = create(next, 'documents.tag', { name });
    next = made.db;
    return made.id;
  };
  for (const [model, def] of Object.entries(models)) {
    const keys = Object.entries(def.fields ?? {})
      .filter(([, f]) => f.type === 'one2many' && f.fields?.tag_id?.relation === 'documents.tag').map(([k]) => k);
    const recs = next.records[model];
    if (!keys.length || !recs?.some((r) => keys.some((k) => r[k]?.some?.((x) => typeof x === 'string')))) continue;
    const records = recs.map((r) => {
      const fixed = Object.fromEntries(keys.filter((k) => Array.isArray(r[k]) && r[k].some((x) => typeof x === 'string'))
        .map((k) => [k, r[k].filter((x) => typeof x !== 'string' || x.trim()).map((x) => (typeof x === 'string' ? { tag_id: tagId(x) } : x))]));
      return Object.keys(fixed).length ? { ...r, ...fixed } : r;
    });
    next = { ...next, records: { ...next.records, [model]: records } };
  }
  return next;
}

export const MIGRATIONS = [
  { version: 1, name: 'Appointments: minutes, staff lines, start/end', up: migrateAppointments },
  { version: 2, name: 'Documents: tag names to documents.tag lines', up: (db) => documentTagLines(migrateDocumentTags(db)) },
  { version: 3, name: 'Work orders: date-only times to datetimes', up: migrateWorkorderTimes },
  { version: 4, name: 'Stock: initialize located quants from done transfers and opening stock', up: ensureQuants },
  { version: 5, name: 'Time off: request units and leave types', up: migrateTimeOff },
  { version: 6, name: 'Stock: migrate product reorder_min and reorder_max into warehouse orderpoints', up: migrateOrderpoints },
  { version: 7, name: 'Employees: random referral tokens invalidate forgeable legacy links', up: (db) => ({
    ...db, records: { ...db.records, 'hr.employee': (db.records['hr.employee'] ?? []).map((e) => ({ ...e, referral_token: /^[0-9a-f]{32}$/.test(e.referral_token ?? '') ? e.referral_token : crypto.randomUUID().replaceAll('-', '') })) },
  }) },
  { version: 8, name: 'Product categories: preserve and link legacy names', up: migrateProductCategories },
  { version: 9, name: 'CRM and task stages: configurable models, lost reasons, tags', up: migrateStages },
  { version: 10, name: 'POS: migrate payment methods', up: migratePosMethods },
  { version: 11, name: 'Rental: flag legacy billing counters for review', up: migrateLegacyRentalBilling },
];
export const SCHEMA_VERSION = MIGRATIONS.at(-1).version;

/** Bring a database up to SCHEMA_VERSION. Returns the same object when nothing ran. */
export function migrate(db) {
  if (!db?.records) return db;
  const from = db.schema_version ?? 0;
  if (from > SCHEMA_VERSION) throw new Error(`Database schema ${from} is newer than this version of Mizan (${SCHEMA_VERSION})`);
  const pending = MIGRATIONS.filter((m) => m.version > from);
  if (!pending.length) return db;
  return { ...pending.reduce((acc, m) => m.up(acc), db), schema_version: SCHEMA_VERSION };
}
