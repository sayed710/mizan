// Versioned data migrations. The database records the last version applied (`schema_version`), so each migration
// runs once per database and its result is saved like any other change. Append new steps; never edit old ones.
import { models } from './models/index.js';
import { create, postNote, search, write } from './orm.js';
import { migrateAppointments } from './models/appointments.js';
import { analyticLinesForMove } from './models/analyticplus.js';
import { migrateDocumentTags } from './models/signplus.js';
import { migrateWorkorderTimes } from './models/workorder.js';
import { ensureQuants } from './models/quant.js';
import { migrateTimeOff } from './models/timeoff.js';
import { sanitizeAccountNumber } from './models/partnerbank.js';
import { migrateOrderpoints } from './models/orderpoint.js';
import { migrateProductCategories } from './models/productconfig.js';
import { today, validDate } from './models/common.js';
import { CHART, isLiquidityJournal, journalId, STOCK_CHART_ROLES } from './models/ledger.js';
import { INCOTERMS_2020 } from './models/accounting.js';
import { migrateLegacyRentalBilling } from './models/rentalbilling.js';
import { followUpSignedDelay, returnTaxLock } from './models/finance.js';
import { defaultCashFlowActivity } from './models/reports.js';
import { normalizeReconcileRule } from './models/reconcile.js';
import { ensureStatementReports } from './models/statementReports.js';
import { deferredEntryTypeForKind, mapLegacyDeferredGenerationMethod, normalizeDeferredComputationMethod } from './models/deferred.js';

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
        next = create(next, 'pos.payment.method', { name, type, company_id, journal_id: journalId(next, journal, company_id), config_ids: [] }).db;
      }
    }
  }

  for (const c of (next.records['pos.config'] ?? [])) {
    const compId = c.company_id ?? 1;
    for (const p of (c.payment_method_ids ?? [])) {
      if (typeof p === 'object' && p !== null) {
        const name = p.name || (p.journal === 'cash' ? 'Cash' : 'Card');
        const type = p.type || (p.journal === 'cash' ? 'cash' : 'bank');
        const journal = journalId(next, p.journal === 'cash' ? 'CSH1' : 'BNK1', compId);
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
    const hasExplicit = Array.isArray(c.payment_method_ids) && c.payment_method_ids.length > 0;
    if (!hasExplicit) {
      for (const type of ['cash', 'bank']) {
        const defMethod = (next.records['pos.payment.method'] ?? []).find((m) => (m.company_id ?? 1) === compId && m.type === type);
        if (defMethod && !defMethod.config_ids?.includes(c.id)) {
          next = write(next, 'pos.payment.method', defMethod.id, { config_ids: [...(defMethod.config_ids ?? []), c.id] });
        }
      }
    }
  }

  const method = (company, typeOrName) => {
    const candidates = (next.records['pos.payment.method'] ?? []).filter((m) => (m.company_id ?? 1) === company);
    const exact = candidates.find((m) => m.name?.toLowerCase() === String(typeOrName ?? '').toLowerCase());
    if (exact) return exact.id;
    const type = ({ cash: 'cash', card: 'bank', bank: 'bank' })[typeOrName];
    return type ? candidates.find((m) => m.type === type)?.id : null;
  };

  const methodForOrder = (order, typeOrName) => {
    const compId = order.company_id ?? 1;
    const cfg = order.config_id ? (next.records['pos.config'] ?? []).find((c) => c.id === order.config_id) : null;
    const configMethodIds = new Set(cfg?.payment_method_ids ?? []);
    const allMethods = (next.records['pos.payment.method'] ?? []).filter((m) => (m.company_id ?? 1) === compId);
    const configMethods = allMethods.filter((m) => configMethodIds.has(m.id) || (m.config_ids ?? []).includes(order.config_id));
    const targetName = String(typeOrName ?? '').toLowerCase();
    const targetType = ({ cash: 'cash', card: 'bank', bank: 'bank' })[typeOrName];

    const exactConfig = configMethods.find((m) => m.name?.toLowerCase() === targetName);
    if (exactConfig) return exactConfig.id;
    if (targetType) {
      const typeConfig = configMethods.find((m) => m.type === targetType);
      if (typeConfig) return typeConfig.id;
    }
    const exactCompany = allMethods.find((m) => m.name?.toLowerCase() === targetName);
    if (exactCompany) return exactCompany.id;
    if (targetType) {
      const typeCompany = allMethods.find((m) => m.type === targetType);
      if (typeCompany) return typeCompany.id;
    }
    return null;
  };

  const configs = (next.records['pos.config'] ?? []).map((c) => {
    const compId = c.company_id ?? 1;
    const methodIds = [];
    if (Array.isArray(c.payment_method_ids) && c.payment_method_ids.length > 0) {
      for (const p of c.payment_method_ids) {
        if (typeof p === 'number') {
          if (!methodIds.includes(p)) methodIds.push(p);
        } else if (typeof p === 'object' && p !== null) {
          const mid = p.payment_method_id ?? method(compId, p.name) ?? method(compId, p.journal);
          if (mid && !methodIds.includes(mid)) methodIds.push(mid);
        }
      }
    } else {
      for (const type of ['cash', 'bank']) {
        const defMethod = (next.records['pos.payment.method'] ?? []).find((m) => (m.company_id ?? 1) === compId && m.type === type);
        if (defMethod && !methodIds.includes(defMethod.id)) methodIds.push(defMethod.id);
      }
    }
    return {
      ...c,
      payment_method_ids: methodIds,
      available_preset_ids: c.available_preset_ids ?? [],
      cash_rounding: c.cash_rounding ?? false,
      only_round_cash_method: c.only_round_cash_method ?? false,
    };
  });

  for (const c of configs) {
    for (const mid of c.payment_method_ids) {
      const m = (next.records['pos.payment.method'] ?? []).find((rec) => rec.id === mid);
      if (m && !m.config_ids?.includes(c.id)) {
        next = write(next, 'pos.payment.method', m.id, { config_ids: [...(m.config_ids ?? []), c.id] });
      }
    }
  }

  const orders = (next.records['pos.order'] ?? []).map((o) => {
    const defaultMethod = methodForOrder(o, o.payment_method ?? 'cash');
    return {
      ...o,
      payment_method_id: o.payment_method_id ?? defaultMethod,
      payment_ids: (o.payment_ids ?? []).map((p) => ({
        ...p,
        payment_method_id: p.payment_method_id ?? methodForOrder(o, p.name ?? p.method ?? 'cash'),
      })),
    };
  });

  return { ...next, records: { ...next.records, ...(next.records['pos.config'] ? { 'pos.config': configs } : {}), ...(next.records['pos.order'] ? { 'pos.order': orders } : {}) } };
}

function repairPosMethods(db) {
  let next = db;
  const methods = next.records['pos.payment.method'] ?? [];
  const configs = next.records['pos.config'] ?? [];
  const orders = (next.records['pos.order'] ?? []).map((o) => {
    const compId = o.company_id ?? 1;
    const cfg = o.config_id ? configs.find((c) => c.id === o.config_id) : null;
    const configMethodIds = new Set(cfg?.payment_method_ids ?? []);
    const companyMethods = methods.filter((m) => (m.company_id ?? 1) === compId);
    const configMethods = companyMethods.filter((m) => cfg && (Array.isArray(cfg.payment_method_ids)
      ? configMethodIds.has(m.id)
      : (m.config_ids ?? []).includes(cfg.id)));
    // An inactive method can still be a valid historical selection. When the order
    // has no configuration, company membership is the only available constraint.
    const validMethod = (id) => companyMethods.some((m) => m.id === id && (!cfg || configMethods.includes(m)));

    const resolveMethod = (typeOrName) => {
      const targetName = String(typeOrName ?? '').toLowerCase();
      const targetType = ({ cash: 'cash', card: 'bank', bank: 'bank' })[typeOrName];
      return (
        configMethods.find((m) => m.name?.toLowerCase() === targetName)?.id ??
        (targetType ? configMethods.find((m) => m.type === targetType)?.id : null) ??
        companyMethods.find((m) => m.name?.toLowerCase() === targetName)?.id ??
        (targetType ? companyMethods.find((m) => m.type === targetType)?.id : null) ??
        null
      );
    };

    const payment_ids = (o.payment_ids ?? []).map((p) => {
      const currentMethod = p.payment_method_id ? methods.find((m) => m.id === p.payment_method_id) : null;
      const resolvedId = validMethod(p.payment_method_id)
        ? p.payment_method_id
        : (resolveMethod(p.name ?? p.method ?? currentMethod?.name ?? currentMethod?.type) ?? p.payment_method_id ?? null);
      return { ...p, payment_method_id: resolvedId };
    });
    const mainMethod = validMethod(o.payment_method_id)
      ? o.payment_method_id
      : (payment_ids[0]?.payment_method_id ?? resolveMethod(o.payment_method) ?? o.payment_method_id ?? null);
    return {
      ...o,
      payment_method_id: mainMethod,
      payment_ids,
    };
  });
  return { ...next, records: { ...next.records, 'pos.order': orders } };
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

export function migrateIncoterms(db) {
  let next = db;
  const existing = new Set((next.records['account.incoterm'] ?? []).map((i) => i.code));
  for (const [code, name] of INCOTERMS_2020) {
    if (!existing.has(code)) {
      next = create(next, 'account.incoterm', { code, name, active: true }).db;
    }
  }
  return next;
}

export function migrateFollowUps(db) {
  if (!db?.records?.['res.partner']) return db;
  const partners = db.records['res.partner'].map((p) => {
    const { followup_level_delay, followup_date, followup_level, ...rest } = p;
    const company = p.company_id || 1;
    const lines = (p.followup_lines ?? []).map((line) => line && line.company_id == null ? { ...line, company_id: 1 } : line);
    const hasLegacy = followup_level_delay != null || followup_date != null || followup_level != null;
    if (hasLegacy && !lines.some((l) => l.company_id === company)) {
      lines.push({
        company_id: company,
        followup_level_delay: followup_level_delay ?? null,
        followup_date: followup_date ?? null,
        followup_level: followup_level ?? null,
      });
    }
    return lines.length ? { ...rest, followup_lines: lines } : rest;
  });
  return { ...db, records: { ...db.records, 'res.partner': partners } };
}

/** Free-text bank_account on partners becomes res.partner.bank records. */
export function migratePartnerBankAccounts(db) {
  if (!db?.records) return db;
  const partners = db.records['res.partner'] ?? [];
  const existingBanks = db.records['res.partner.bank'] ?? [];
  const banks = [...existingBanks];
  let maxId = Math.max(0, db.seq?.['res.partner.bank'] ?? 0, ...banks.map((b) => b.id ?? 0));

  const updatedPartners = partners.map((p) => {
    if (!p.bank_account || !sanitizeAccountNumber(p.bank_account)) return p;
    const { bank_account, ...rest } = p;
    const sanitized = sanitizeAccountNumber(bank_account);
    const existingIndex = banks.findIndex((b) => b.partner_id === p.id && (b.sanitized_account_number === sanitized || sanitizeAccountNumber(b.account_number) === sanitized));
    if (existingIndex >= 0) {
      const existing = banks[existingIndex];
      if (existing.account_number !== bank_account) {
        banks[existingIndex] = { ...existing, legacy_account_numbers: [...new Set([...(existing.legacy_account_numbers ?? []), bank_account])] };
      }
    } else {
      maxId += 1;
      banks.push({
        id: maxId,
        partner_id: p.id,
        company_id: p.company_id || 1,
        account_number: bank_account,
        sanitized_account_number: sanitized,
        allow_out_payment: true,
        active: true,
      });
    }
    return rest;
  });

  const nextSeq = Math.max(db.seq?.['res.partner.bank'] ?? 0, maxId);

  return {
    ...db,
    records: {
      ...db.records,
      'res.partner': updatedPartners,
      'res.partner.bank': banks,
    },
    seq: {
      ...(db.seq ?? {}),
      'res.partner.bank': nextSeq,
    },
  };
}

function migrateCashFlowActivities(db) {
  let next = db;
  const activities = ['operating', 'investing', 'financing'];
  const tagFor = (activity) => {
    const existing = (next.records['account.account.tag'] ?? []).find((tag) => tag.cash_flow_activity === activity);
    if (existing) return existing.id;
    const made = create(next, 'account.account.tag', { name: `Legacy ${activity} activities`, cash_flow_activity: activity });
    next = made.db;
    return made.id;
  };
  for (const account of db.records['account.account'] ?? []) {
    const tags = account.tag_ids ?? [];
    if (tags.some((tag) => activities.includes((typeof tag === 'object' ? tag : (next.records['account.account.tag'] ?? []).find((item) => item.id === tag))?.cash_flow_activity))) continue;
    const activity = defaultCashFlowActivity(account.account_type);
    const id = tagFor(activity);
    next = write(next, 'account.account', account.id, { tag_ids: [...tags, id] });
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
  { version: 11, name: 'Invoicing: seed standard Incoterms 2020', up: migrateIncoterms },
  { version: 12, name: 'Follow-ups: store follow-up progress per partner and company', up: migrateFollowUps },
  { version: 13, name: 'POS: repair payment method resolution within configuration', up: repairPosMethods },
  { version: 14, name: 'Rental: flag legacy billing counters for review', up: migrateLegacyRentalBilling },
  { version: 15, name: 'Partners: migrate free-text bank accounts to res.partner.bank', up: migratePartnerBankAccounts },
  { version: 16, name: 'Tax returns: initialize company-specific locks', up: (db) => {
    const ids = new Set((db.records['account.return'] ?? []).map((r) => r.company_id ?? 1).filter((id) => id !== 1));
    const locks = { ...db.settings?.tax_lock_dates };
    for (const id of ids) if (!(id in locks)) locks[id] = returnTaxLock(db, id) || null;
    return { ...db, settings: { ...db.settings, tax_lock_dates: locks } };
  } },
  { version: 17, name: 'Follow-ups: assign legacy untagged progress to company 1', up: migrateFollowUps },
  { version: 18, name: 'Tax returns: unify per-company tax locks', up: (db) => {
    const { tax_lock_date: legacy, ...settings } = db.settings ?? {};
    const locks = { ...settings.tax_lock_dates };
    if (legacy !== undefined) locks[1] = legacy;
    return { ...db, settings: { ...settings, tax_lock_dates: locks } };
  } },
  { version: 19, name: 'Analytics and cash flow: restore historical reporting', up: (db) => {
    const generated = new Set((db.records['account.analytic.line'] ?? [])
      .filter((line) => ['invoice', 'vendor_bill', 'journal_entry'].includes(line.category))
      .map((line) => line.move_id));
    const analytic = (db.records['account.move'] ?? []).reduce((next, move) => {
      if (move.state !== 'posted' || generated.has(move.id)
        || !['entry', 'out_invoice', 'in_invoice', 'out_refund', 'in_refund'].includes(move.move_type)) return next;
      // Do not apply current distribution defaults to historically unassigned lines.
      const historical = { ...move, invoice_line_ids: (move.invoice_line_ids ?? []).map((line) =>
        line.analytic_distribution == null && !line.analytic_account_id ? { ...line, analytic_distribution: {} } : line) };
      return analyticLinesForMove(next, historical, { historical: true })
        .reduce((acc, values) => create(acc, 'account.analytic.line', values).db, next);
    }, db);
    return migrateCashFlowActivities(analytic);
  } },
];
MIGRATIONS.push({ version: 20, name: 'Fiscal years: assign legacy years to company 1', up: (db) => ({
  ...db, records: { ...db.records, 'account.fiscal.year': (db.records['account.fiscal.year'] ?? []).map((year) => ({ ...year, company_id: year.company_id ?? 1 })) },
}) });
MIGRATIONS.push({ version: 21, name: 'Fiscal years: retain global closing lock', up: (db) => db });
MIGRATIONS.push({ version: 22, name: 'Currency rounding defaults', up: (db) => ({
  ...db, records: { ...db.records, 'res.currency': (db.records['res.currency'] ?? []).map((currency) => currency.rounding == null ? { ...currency, rounding: 0.01 } : currency) },
}) });
MIGRATIONS.push({ version: 23, name: 'Explicit base currency and fiscal earnings accounts', up: (db) => {
  db = MIGRATIONS.find((migration) => migration.version === 22).up(db);
  const currencies = (db.records['res.currency'] ?? []).filter((currency) => currency.name === db.settings?.currency);
  const companies = (db.records['res.company'] ?? []).map((company) => {
    if (company.current_year_earnings_account_id != null) return company;
    const accounts = (db.records['account.account'] ?? []).filter((account) => account.code === '302000'
      && ['equity', 'equity_unaffected'].includes(account.account_type) && (!account.company_id || account.company_id === company.id));
    return accounts.length === 1 ? { ...company, current_year_earnings_account_id: accounts[0].id } : company;
  });
  return { ...db, settings: { ...db.settings, ...(db.settings?.base_currency_id == null && currencies.length === 1 ? { base_currency_id: currencies[0].id } : {}) },
    records: { ...db.records, 'res.company': companies } };
} });

MIGRATIONS.push({ version: 24, name: 'Currency rates: mark legacy rows as shared', up: (db) => ({
  ...db, records: { ...db.records, 'res.currency': (db.records['res.currency'] ?? []).map((currency) => ({
    ...currency, rate_ids: (currency.rate_ids ?? []).map((row) => ({ ...row, company_id: row.company_id ?? null })),
  })) },
}) });
MIGRATIONS.push({ version: 25, name: 'Link legacy cash-basis releases', up: migrateCashBasisOrigins });
MIGRATIONS.push({ version: 26, name: 'Lock dates and payment QR settings live on res.company', up: (db) => {
  const settings = db.settings ?? {};
  const lockKeys = ['lock_date', 'sale_lock_date', 'purchase_lock_date', 'hard_lock_date'];
  const currentCompId = settings.current_company_id ?? 1;
  const qrSetting = settings.invoice_qr;
  const vatSetting = settings.company_vat ?? settings.vat;
  const ibanSetting = settings.company_iban;

  const companies = (db.records?.['res.company'] ?? []).map((c) => {
    let updated = { ...c };
    for (const k of lockKeys) {
      if (settings[k] != null && settings[k] !== '' && (c[k] == null || c[k] === '')) {
        updated[k] = settings[k];
      }
    }
    if (c.id === currentCompId) {
      if (qrSetting && (c.invoice_qr == null || c.invoice_qr === '')) {
        updated.invoice_qr = qrSetting;
      }
      if (vatSetting && (c.vat == null || c.vat === '')) {
        updated.vat = vatSetting;
      }
      if (ibanSetting && (c.company_iban == null || c.company_iban === '')) {
        updated.company_iban = ibanSetting;
      }
    }
    return updated;
  });

  const nextSettings = { ...settings };
  for (const k of lockKeys) {
    delete nextSettings[k];
  }

  return {
    ...db,
    settings: nextSettings,
    records: { ...db.records, 'res.company': companies },
  };
} });

MIGRATIONS.push({ version: 27, name: 'Accounting settings (three-way matching and audit trail) live on res.company', up: (db) => {
  const settings = db.settings ?? {};
  const threeWayMatching = settings.three_way_matching;
  const auditTrail = settings.audit_trail;

  const companies = (db.records?.['res.company'] ?? []).map((c) => {
    const updated = { ...c };
    if (threeWayMatching !== undefined && updated.three_way_matching == null) {
      updated.three_way_matching = threeWayMatching;
    }
    if (auditTrail !== undefined && updated.audit_trail == null) {
      updated.audit_trail = auditTrail;
    }
    return updated;
  });

  const nextSettings = { ...settings };
  delete nextSettings.three_way_matching;
  delete nextSettings.audit_trail;

  return {
    ...db,
    settings: nextSettings,
    records: { ...db.records, 'res.company': companies },
  };
} });

function migrateCashBasisOrigins(db) {
  // Each release is linked through the invoice payment that recorded it; unlinked releases are flagged for review.
  const origins = new Map();
  for (const invoice of db.records['account.move'] ?? []) {
    for (const payment of invoice.payments ?? []) if (payment.cash_basis_move_id) origins.set(payment.cash_basis_move_id, invoice.id);
  }
  let next = { ...db, records: { ...db.records, 'account.move': (db.records['account.move'] ?? []).map((move) => (
    move.cash_basis_origin_move_id == null && origins.has(move.id) ? { ...move, cash_basis_origin_move_id: origins.get(move.id) } : move
  )) } };
  for (const move of next.records['account.move']) {
    if (move.move_type === 'entry' && move.cash_basis_origin_move_id == null && move.ref?.startsWith('Cash basis taxes ')) {
      next = postNote(next, 'account.move', move.id, 'Cash-basis origin invoice could not be determined; review this entry.');
    }
  }
  const { cash_basis_origins_migrated: ignored, ...settings } = next.settings ?? {};
  void ignored;
  return { ...next, settings };
}

MIGRATIONS.push({
  version: 28,
  name: 'Taxes: repartition lines for invoice and refund documents',
  up: (db) => {
    const taxMap = new Map((db.records['account.tax'] ?? []).map((t) => [t.id, t]));
    // Before repartition lines, a tax without an account posted to the chart's VAT account; keep that only when it is unambiguous.
    const defaultTaxAccount = (companyId, use) => {
      const code = use === 'purchase' ? '131000' : '251000';
      const type = CHART.find((row) => row[0] === code)?.[2];
      const typed = (db.records['account.account'] ?? []).filter((a) => a.code === code && a.account_type === type);
      const owned = typed.filter((a) => a.company_id === (companyId ?? 1));
      const pick = owned.length ? owned : typed.filter((a) => a.company_id == null);
      return pick.length === 1 ? pick[0].id : null;
    };
    const convertLine = (l) => {
      if (!l) return l;
      const { tax_account_id, tax_tag_ids, tax_base_tag_ids, ...rest } = l;
      let invLines = l.invoice_repartition_line_ids;
      let refLines = l.refund_repartition_line_ids;
      if (!invLines?.length && !refLines?.length && (tax_account_id !== undefined || tax_tag_ids !== undefined || l.tax_id)) {
        const taxRec = l.tax_id ? taxMap.get(l.tax_id) : null;
        const lineCompId = taxRec?.company_id ?? 1;
        const defAcc = defaultTaxAccount(lineCompId, taxRec?.type_tax_use);
        const acc = tax_account_id ?? taxRec?.account_id ?? defAcc;
        const baseTags = [...(tax_base_tag_ids ?? taxRec?.base_tag_ids ?? [])];
        const taxTags = [...(tax_tag_ids ?? taxRec?.tag_ids ?? [])];
        invLines = [
          { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: baseTags },
          { repartition_type: 'tax', factor_percent: 100, account_id: acc, tag_ids: taxTags },
        ];
        refLines = [
          { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: baseTags },
          { repartition_type: 'tax', factor_percent: 100, account_id: acc, tag_ids: taxTags },
        ];
      }
      let breakdown = rest.tax_breakdown;
      if (Array.isArray(breakdown) && breakdown.length) {
        breakdown = breakdown.map(convertLine);
      }
      return {
        ...rest,
        ...(invLines?.length ? { invoice_repartition_line_ids: invLines } : {}),
        ...(refLines?.length ? { refund_repartition_line_ids: refLines } : {}),
        ...(breakdown ? { tax_breakdown: breakdown } : {}),
      };
    };

    const convertModelLines = (recs, fieldName) =>
      (recs ?? []).map((r) => (r[fieldName] ? { ...r, [fieldName]: r[fieldName].map(convertLine) } : r));

    const nextRecords = { ...db.records };
    nextRecords['account.tax'] = (db.records['account.tax'] ?? []).map((t) => {
      const baseTags = [...(t.base_tag_ids ?? [])];
      const taxTags = [...(t.tag_ids ?? [])];
      const defAcc = defaultTaxAccount(t.company_id, t.type_tax_use);
      const accountId = t.account_id ?? defAcc;
      const { account_id, tag_ids, base_tag_ids, ...restTax } = t;
      return {
        ...restTax,
        invoice_repartition_line_ids: t.invoice_repartition_line_ids?.length
          ? t.invoice_repartition_line_ids
          : [
            { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: baseTags },
            { repartition_type: 'tax', factor_percent: 100, account_id: accountId, tag_ids: taxTags },
          ],
        refund_repartition_line_ids: t.refund_repartition_line_ids?.length
          ? t.refund_repartition_line_ids
          : [
            { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: baseTags },
            { repartition_type: 'tax', factor_percent: 100, account_id: accountId, tag_ids: taxTags },
          ],
      };
    });

    nextRecords['account.move'] = convertModelLines(nextRecords['account.move'], 'invoice_line_ids');
    nextRecords['sale.order'] = convertModelLines(nextRecords['sale.order'], 'order_line');
    nextRecords['purchase.order'] = convertModelLines(nextRecords['purchase.order'], 'order_line');
    nextRecords['pos.order'] = convertModelLines(nextRecords['pos.order'], 'lines');
    nextRecords['sale.subscription'] = convertModelLines(nextRecords['sale.subscription'], 'order_line');

    return { ...db, records: nextRecords };
  },
});

MIGRATIONS.push({ version: 29, name: 'Explicit company stock accounts', up: (db) => ({
  ...db, records: { ...db.records, 'res.company': (db.records['res.company'] ?? []).map((company) => {
    const values = {};
    for (const [field, [code, type]] of Object.entries(STOCK_CHART_ROLES)) {
      if (company[field]) continue;
      const matches = (db.records['account.account'] ?? []).filter((account) => account.company_id === company.id && account.code === code && account.account_type === type);
      if (matches.length === 1) values[field] = matches[0].id;
    }
    return { ...company, ...values };
  }) },
}) });

MIGRATIONS.push({ version: 30, name: 'Configure installed journal and deferral accounts', up: (db) => {
  const find = (company, code) => {
    const type = CHART.find((row) => row[0] === code)?.[2];
    const accounts = db.records['account.account'] ?? [];
    const owned = accounts.filter((a) => a.company_id === company && a.code === code);
    if (owned.length) {
      const match = owned.filter((a) => a.account_type === type);
      return match.length === 1 ? match[0].id : null;
    }
    const shared = accounts.filter((a) => a.company_id == null && a.code === code && a.account_type === type);
    return shared.length === 1 ? shared[0].id : null;
  };
  const companies = (db.records['res.company'] ?? []).map((company) => ({ ...company,
    deferred_revenue_account_id: company.deferred_revenue_account_id ?? find(company.id, '212000'),
    deferred_expense_account_id: company.deferred_expense_account_id ?? find(company.id, '132000'),
  }));
  const journals = (db.records['account.journal'] ?? []).map((journal) => {
    if (!['bank', 'cash'].includes(journal.type)) return journal;
    const company = journal.company_id ?? 1;
    return { ...journal, suspense_account_id: journal.suspense_account_id ?? find(company, '101404'),
      ...(journal.type === 'cash' ? { profit_account_id: journal.profit_account_id ?? find(company, '450000'), loss_account_id: journal.loss_account_id ?? find(company, '690000') } : {}) };
  });
  // Statement lines stored the chosen counterpart as a chart code; resolve it once to that company's account.
  const accounts = db.records['account.account'] ?? [];
  const lines = (db.records['account.bank.statement.line'] ?? []).map(({ counterpart, ...line }) => {
    const company = line.company_id ?? 1;
    let journalId = line.journal_id ?? null;
    if (!journalId) {
      // Only an unambiguous journal is assigned: the company's single default bank journal, else its single bank journal.
      const banks = (db.records['account.journal'] ?? []).filter((j) => j.type === 'bank' && (j.company_id ?? 1) === company);
      const defaults = banks.filter((j) => j.default_for_payments);
      journalId = (defaults.length === 1 ? defaults[0] : banks.length === 1 ? banks[0] : null)?.id ?? null;
    }
    const withJournal = journalId ? { ...line, journal_id: journalId } : line;
    if (counterpart == null || line.counterpart_account_id) return withJournal;
    const matches = accounts.filter((a) => a.code === counterpart && a.company_id === company);
    const candidates = matches.length ? matches : accounts.filter((a) => a.code === counterpart && a.company_id == null);
    // An unresolved code stays on the line so the user's choice is not lost (Qodo 40).
    return candidates.length === 1 ? { ...withJournal, counterpart_account_id: candidates[0].id } : { ...withJournal, counterpart };
  });
  return { ...db, records: { ...db.records, 'res.company': companies, 'account.journal': journals, 'account.bank.statement.line': lines } };
} });

MIGRATIONS.push({ version: 31, name: 'Explicit asset, exchange, discount, rental and reconciliation accounts', up: (db) => {
  const find = (company, code) => {
    const type = CHART.find((row) => row[0] === code)?.[2];
    if (!type) return null;
    const accounts = db.records['account.account'] ?? [];
    const owned = accounts.filter((account) => account.company_id === company && account.code === code);
    if (owned.length) {
      const match = owned.filter((a) => a.account_type === type);
      return match.length === 1 ? match[0].id : null;
    }
    const shared = accounts.filter((account) => account.company_id == null && account.code === code && account.account_type === type);
    return shared.length === 1 ? shared[0].id : null;
  };
  const resolveRuleAccount = (company, code) => {
    if (!code) return null;
    const accounts = db.records['account.account'] ?? [];
    const owned = company == null ? [] : accounts.filter((a) => a.company_id === company && a.code === code);
    if (owned.length) return owned.length === 1 ? owned[0].id : null;
    const shared = accounts.filter((a) => a.company_id == null && a.code === code);
    return shared.length === 1 ? shared[0].id : null;
  };
  const companyRoles = { gain_account_id: '450300', loss_account_id: '690300', income_currency_exchange_account_id: '450100', expense_currency_exchange_account_id: '690100', income_early_payment_discount_account_id: '450200', expense_early_payment_discount_account_id: '690200', rental_deposit_account_id: '230100', rental_withheld_deposit_account_id: '450000', down_payment_account_id: '212000' };
  const companies = (db.records['res.company'] ?? []).map((company) => ({ ...company, ...Object.fromEntries(Object.entries(companyRoles).filter(([field]) => !company[field]).map(([field, code]) => [field, find(company.id, code)])) }));
  const assets = (records) => (records ?? []).map(({ account_expense_id, ...asset }) => ({ ...asset,
    account_asset_id: asset.account_asset_id ?? find(asset.company_id ?? 1, '151000'),
    account_depreciation_id: asset.account_depreciation_id ?? find(asset.company_id ?? 1, '152000'),
    account_depreciation_expense_id: asset.account_depreciation_expense_id ?? account_expense_id ?? find(asset.company_id ?? 1, '680000'),
  }));
  const rules = (db.records['account.reconcile.model'] ?? []).map((rule) => ({ ...rule, line_ids: (rule.line_ids ?? []).map(({ account_code, ...line }) => {
    const account_id = line.account_id ?? resolveRuleAccount(rule.company_id ?? null, account_code);
    return { ...line, account_id, ...(!account_id && account_code ? { account_code } : {}) };
  }) }));
  return { ...db, records: { ...db.records, 'res.company': companies, 'account.asset': assets(db.records['account.asset']), 'account.asset.model': assets(db.records['account.asset.model']), 'account.reconcile.model': rules } };
} });

MIGRATIONS.push({ version: 32, name: 'Budget company', up: (db) => {
  // Only a single-company database identifies the budget's company; otherwise the report asks the user to select one.
  const companies = db.records['res.company'] ?? [];
  if (companies.length !== 1) return db;
  const budgets = (db.records['account.budget'] ?? []).map((budget) => budget.company_id ? budget : { ...budget, company_id: companies[0].id });
  return { ...db, records: { ...db.records, 'account.budget': budgets } };
} });

MIGRATIONS.push({ version: 33, name: 'Explicit payroll, cash basis and rounding accounts', up: (db) => {
  const find = (company, code) => {
    const type = CHART.find((row) => row[0] === code)?.[2];
    const matches = (db.records['account.account'] ?? []).filter((a) => a.company_id === company && a.code === code && a.account_type === type);
    return matches.length === 1 ? matches[0].id : null;
  };
  const structures = (db.records['hr.payroll.structure'] ?? []).map((structure) => {
    const company = structure.company_id ?? 1;
    const journals = (db.records['account.journal'] ?? []).filter((j) => (j.company_id ?? 1) === company && j.code === 'SAL' && j.type === 'general');
    return { ...structure, company_id: company, journal_id: structure.journal_id ?? (journals.length === 1 ? journals[0].id : null),
      salary_expense_account_id: structure.salary_expense_account_id ?? find(company, '620000'),
      salary_payable_account_id: structure.salary_payable_account_id ?? find(company, '230000'),
      rules: (structure.rules ?? []).map(({ account, ...rule }) => ({ ...rule,
        ...(account && !rule.account_credit_id ? { account_credit_id: find(company, account) } : {}),
      })),
    };
  });
  return { ...db, records: { ...db.records,
    'hr.payroll.structure': structures,
    'stock.valuation.layer': (db.records['stock.valuation.layer'] ?? []).map((layer) => typeof layer.counterpart === 'string' ? { ...layer, counterpart: find(layer.company_id ?? 1, layer.counterpart) } : layer),
    'res.company': (db.records['res.company'] ?? []).map((company) => {
      const candidates = structures.filter((s) => s.company_id === company.id);
      return { ...company, opening_equity_account_id: company.opening_equity_account_id ?? find(company.id, '301000'),
        default_payroll_structure_id: company.default_payroll_structure_id ?? (candidates.length === 1 ? candidates[0].id : null) };
    }),
    'account.tax': (db.records['account.tax'] ?? []).map((tax) => ({ ...tax, cash_basis_transition_account_id: tax.cash_basis_transition_account_id ?? (tax.tax_exigibility === 'on_payment' ? find(tax.company_id ?? 1, tax.type_tax_use === 'sale' ? '251100' : '131100') : null) })),
    'account.cash.rounding': (db.records['account.cash.rounding'] ?? []).map((rounding) => ({ ...rounding,
      profit_account_id: Number.isInteger(rounding.profit_account_id) ? rounding.profit_account_id : find(rounding.company_id ?? 1, rounding.profit_account_id || '450000'),
      loss_account_id: Number.isInteger(rounding.loss_account_id) ? rounding.loss_account_id : find(rounding.company_id ?? 1, rounding.loss_account_id || '690000'),
    })),
  } };
} });

MIGRATIONS.push({ version: 34, name: 'Default general journal for companies with a single general journal', up: (db) => {
  const journals = db.records?.['account.journal'] ?? [];
  const unresolved = [];
  const companies = (db.records?.['res.company'] ?? []).map((company) => {
    if (company.default_general_journal_id) return company;
    const candidates = journals.filter((j) => j.type === 'general' && (j.company_id ?? 1) === company.id);
    if (candidates.length === 1) return { ...company, default_general_journal_id: candidates[0].id };
    unresolved.push([company.id, candidates.length]);
    return company;
  });
  // The note lives in the company's chatter, which is stored with the database and shown to administrators.
  return unresolved.reduce((next, [id, count]) => postNote(next, 'res.company', id,
    `Upgrade: this company has ${count} general journals, so no default general journal was chosen. Set the default general journal in the company settings before revaluing foreign balances.`),
  { ...db, messages: db.messages ?? [], records: { ...db.records, 'res.company': companies } });
} });

MIGRATIONS.push({ version: 35, name: 'Per-company lock dates and accounting settings on res.company', up: (db) => {
  const settings = db.settings ?? {};
  const companyRows = db.records?.['res.company'] ?? [];
  const companyIds = new Set(companyRows.map((c) => c.id));
  // Same placement as migration 26, which already moved QR/VAT/IBAN onto the company the user was working in.
  const currentCompanyId = settings.current_company_id ?? 1;
  const lockFields = ['lock_date', 'sale_lock_date', 'purchase_lock_date', 'hard_lock_date'];
  const removedKeys = [
    ...lockFields, 'tax_lock_date', 'tax_lock_dates', 'audit_trail', 'three_way_matching', 'tax_periodicity',
    'invoice_qr', 'company_vat', 'vat', 'company_iban',
  ];
  const unplacedSettings = { ...(settings.unplaced_company_accounting_settings ?? {}) };
  const unplacedTaxLocks = { ...(settings.unplaced_tax_lock_dates ?? {}) };
  const keep = (key, value) => { unplacedSettings[key] = value; };
  const latestDate = (...values) => values.filter(validDate).sort().at(-1) ?? null;
  const globalSettingsHaveTarget = companyRows.length > 0;

  for (const field of lockFields) {
    const value = settings[field];
    if (value == null || value === '') continue;
    if (!validDate(value) || !globalSettingsHaveTarget) {
      keep(field, value);
      continue;
    }
  }

  const taxLocks = settings.tax_lock_dates;
  if (taxLocks !== undefined && (!taxLocks || typeof taxLocks !== 'object' || Array.isArray(taxLocks))) keep('tax_lock_dates', taxLocks);
  else for (const [idText, value] of Object.entries(taxLocks ?? {})) {
    const id = /^[1-9]\d*$/.test(idText) && Number.isSafeInteger(Number(idText)) ? Number(idText) : null;
    if (id == null || !companyIds.has(id)) {
      unplacedTaxLocks[idText] = value;
      continue;
    }
    if (value == null || value === '') continue;
    if (!validDate(value)) {
      unplacedTaxLocks[idText] = value;
      continue;
    }
  }

  const legacyTaxLock = Object.hasOwn(settings, 'tax_lock_date') ? settings.tax_lock_date : undefined;
  if (legacyTaxLock != null && legacyTaxLock !== '' && !validDate(legacyTaxLock)) keep('tax_lock_date', legacyTaxLock);
  else if (legacyTaxLock !== undefined && !companyIds.has(1)) keep('tax_lock_date', legacyTaxLock);

  for (const field of ['audit_trail', 'three_way_matching']) {
    if (settings[field] !== undefined && typeof settings[field] !== 'boolean') keep(field, settings[field]);
    else if (settings[field] !== undefined && !globalSettingsHaveTarget) keep(field, settings[field]);
  }

  const rawPeriodicity = settings.tax_periodicity;
  const periodicity = rawPeriodicity === 'quarterly' ? 'trimester' : rawPeriodicity;
  if (rawPeriodicity !== undefined && (!['monthly', 'quarterly', 'trimester', 'semester', 'year'].includes(rawPeriodicity) || !globalSettingsHaveTarget)) {
    keep('tax_periodicity', rawPeriodicity);
  }

  const qrMode = settings.invoice_qr;
  if (qrMode != null && qrMode !== '' && !['zatca', 'epc'].includes(qrMode)) keep('invoice_qr', qrMode);
  else if (qrMode && !companyIds.has(currentCompanyId)) keep('invoice_qr', qrMode);
  const vatValues = ['company_vat', 'vat'].filter((key) => Object.hasOwn(settings, key) && settings[key] != null && settings[key] !== '');
  const conflictingVat = vatValues.length > 1 && settings.company_vat !== settings.vat;
  if (conflictingVat) for (const key of vatValues) keep(key, settings[key]);
  else if (vatValues.length && (typeof settings[vatValues[0]] !== 'string' || !companyIds.has(currentCompanyId))) {
    for (const key of vatValues) keep(key, settings[key]);
  }
  if (settings.company_iban != null && settings.company_iban !== ''
    && (typeof settings.company_iban !== 'string' || !companyIds.has(currentCompanyId))) keep('company_iban', settings.company_iban);

  const companySettings = { ...settings };
  for (const key of removedKeys) delete companySettings[key];
  if (Object.keys(unplacedSettings).length) companySettings.unplaced_company_accounting_settings = unplacedSettings;
  else delete companySettings.unplaced_company_accounting_settings;
  if (Object.keys(unplacedTaxLocks).length) companySettings.unplaced_tax_lock_dates = unplacedTaxLocks;
  else delete companySettings.unplaced_tax_lock_dates;

  const companies = companyRows.map((company) => {
    const updated = { ...company };
    for (const field of lockFields) {
      const globalDate = settings[field];
      if (validDate(globalDate)) updated[field] = latestDate(company[field], globalDate);
    }
    for (const [idText, value] of Object.entries(taxLocks && typeof taxLocks === 'object' && !Array.isArray(taxLocks) ? taxLocks : {})) {
      if (Number(idText) !== company.id) continue;
      updated.tax_lock_date = value == null || value === '' ? null : validDate(value) ? latestDate(company.tax_lock_date, value) : company.tax_lock_date;
    }
    if (company.id === 1 && legacyTaxLock !== undefined && (legacyTaxLock == null || legacyTaxLock === '' || validDate(legacyTaxLock))) {
      updated.tax_lock_date = legacyTaxLock == null || legacyTaxLock === '' ? null : latestDate(updated.tax_lock_date, legacyTaxLock);
    }
    if (typeof settings.three_way_matching === 'boolean') updated.three_way_matching = settings.three_way_matching;
    if (typeof settings.audit_trail === 'boolean') updated.audit_trail = company.audit_trail === true || settings.audit_trail;
    if (typeof periodicity === 'string' && ['monthly', 'trimester', 'semester', 'year'].includes(periodicity)) updated.tax_periodicity = periodicity;

    if (company.id === currentCompanyId) {
      if (['zatca', 'epc'].includes(qrMode) && !company.invoice_qr) updated.invoice_qr = qrMode;
      const vat = conflictingVat ? undefined : vatValues.length ? settings[vatValues[0]] : undefined;
      if (typeof vat === 'string' && !company.vat) updated.vat = vat;
      if (typeof settings.company_iban === 'string' && !company.company_iban) updated.company_iban = settings.company_iban;
    }
    return updated;
  });

  let nextDb = { ...db, settings: companySettings, records: { ...db.records, 'res.company': companies } };
  const reportKeys = [...Object.keys(unplacedSettings), ...Object.keys(unplacedTaxLocks)];
  if (reportKeys.length && companyIds.has(1)) {
    nextDb = postNote(nextDb, 'res.company', 1,
      `Migration 35 retained company accounting values that could not be placed: ${[...new Set(reportKeys)].join(', ')}. See the unplaced company accounting settings in General Settings data.`);
  }
  return nextDb;
} });

MIGRATIONS.push({ version: 36, name: 'Explicit company currency from legacy settings', up: (db) => {
  // Legacy databases stored a company's currency only as its code in settings; resolve it to the one currency record with that code.
  const legacySetting = db.settings?.currency;
  const legacyCompanies = db.settings?.companies ?? [];
  const currencies = db.records['res.currency'] ?? [];
  const unresolved = [];
  const companies = (db.records['res.company'] ?? []).map((company) => {
    if (company.currency_id != null) return company;
    const code = legacyCompanies.find((c) => c.id === company.id)?.currency ?? legacySetting;
    if (!code) return company;
    const matches = currencies.filter((currency) => currency.name === code);
    if (matches.length === 1) return { ...company, currency_id: matches[0].id };
    unresolved.push([company.id, code]);
    return company;
  });
  return unresolved.reduce((next, [id, code]) => postNote(next, 'res.company', id,
    `Upgrade: no single currency with code ${code} was found, so this company has no currency. Set the company currency in the company settings.`),
  { ...db, messages: db.messages ?? [], records: { ...db.records, 'res.company': companies } });
} });

MIGRATIONS.push({ version: 37, name: 'Move fiscal position tax mappings onto taxes', up: (db) => {
  const taxesById = new Map((db.records['account.tax'] ?? []).map((t) => [t.id, {
    ...t,
    fiscal_position_ids: [...(t.fiscal_position_ids ?? [])],
    original_tax_ids: [...(t.original_tax_ids ?? [])],
  }]));
  const removed = [];
  const positions = (db.records['account.fiscal.position'] ?? []).map((fp) => {
    for (const row of fp.tax_ids ?? []) {
      if (row?.tax_dest_id) {
        const dest = taxesById.get(row.tax_dest_id);
        if (dest) {
          if (!dest.fiscal_position_ids.includes(fp.id)) dest.fiscal_position_ids.push(fp.id);
          if (row.tax_src_id && !dest.original_tax_ids.includes(row.tax_src_id)) dest.original_tax_ids.push(row.tax_src_id);
        }
      } else if (row?.tax_src_id) {
        const src = taxesById.get(row.tax_src_id);
        removed.push([fp.id, src?.name || `#${row.tax_src_id}`]);
      }
    }
    const { tax_ids, ...rest } = fp;
    return rest;
  });
  const next = {
    ...db,
    messages: db.messages ?? [],
    records: {
      ...db.records,
      'account.tax': [...taxesById.values()],
      'account.fiscal.position': positions,
    },
  };
  return removed.reduce(
    (acc, [fpId, srcName]) => postNote(acc, 'account.fiscal.position', fpId, `Upgrade: tax removal rule for "${srcName}" cannot be expressed in the new model; please redo it on the tax records.`),
    next,
  );
} });

MIGRATIONS.push({ version: 38, name: 'Mark stored accounts without an active flag as active', up: (db) => ({
  ...db,
  records: {
    ...db.records,
    'account.account': (db.records['account.account'] ?? []).map((a) => (a.active === undefined ? { ...a, active: true } : a)),
  },
}) });

const M37_REMOVAL_NOTE_RE = /^Upgrade: tax removal rule for "(.+)" cannot be expressed in the new model; please redo it on the tax records\.$/;

MIGRATIONS.push({ version: 39, name: 'Recover fiscal position exclusions, keep direct destination taxes usable, and store per-position tax mappings', up: (db) => {
  const taxes = db.records['account.tax'] ?? [];
  const taxById = new Map(taxes.map((t) => [t.id, t]));
  const fps = db.records['account.fiscal.position'] ?? [];
  const fpById = new Map(fps.map((fp) => [fp.id, fp]));

  // 1. Recover tax removal rules from migration 37 chatter notes into explicit fp.excluded_tax_ids.
  const excludedByFp = new Map(fps.map((fp) => [fp.id, new Set(fp.excluded_tax_ids ?? [])]));
  for (const msg of db.messages ?? []) {
    if (msg?.model !== 'account.fiscal.position' || msg?.kind !== 'note') continue;
    const match = M37_REMOVAL_NOTE_RE.exec(msg.body ?? '');
    if (!match) continue;
    const fp = fpById.get(msg.res_id);
    if (!fp) continue;
    const srcName = match[1];
    const compatible = taxes.filter((t) => !fp.company_id || !t.company_id || t.company_id === fp.company_id);
    let matches = compatible.filter((t) => t.name === srcName);
    if (!matches.length && /^#(\d+)$/.test(srcName)) {
      const id = Number(srcName.slice(1));
      matches = compatible.filter((t) => t.id === id);
    }
    // The note names the tax; recover it only when that name identifies exactly one tax, otherwise the note stays for manual follow-up.
    if (matches.length === 1) excludedByFp.get(fp.id).add(matches[0].id);
  }
  const nextPositions = fps.map((fp) => ({
    ...fp,
    excluded_tax_ids: [...(excludedByFp.get(fp.id) ?? [])],
  }));

  // 2. Collect taxes referenced directly so mapping destinations remain directly usable.
  const directlyUsedTaxIds = new Set();
  for (const p of db.records.product ?? []) {
    if (p.tax_id) directlyUsedTaxIds.add(p.tax_id);
    if (p.supplier_tax_id) directlyUsedTaxIds.add(p.supplier_tax_id);
  }
  for (const c of db.records['res.company'] ?? []) {
    if (c.account_sale_tax_id) directlyUsedTaxIds.add(c.account_sale_tax_id);
    if (c.account_purchase_tax_id) directlyUsedTaxIds.add(c.account_purchase_tax_id);
  }
  for (const t of taxes) {
    for (const childId of t.children_tax_ids ?? []) directlyUsedTaxIds.add(childId);
  }
  for (const a of db.records['account.account'] ?? []) {
    for (const taxId of a.tax_ids ?? []) directlyUsedTaxIds.add(taxId);
  }

  // 3. Move directly-used or multi-position replacement mappings onto per-position fiscal_position_mapping_ids.
  const nextTaxes = taxes.map((t) => {
    const posIds = t.fiscal_position_ids ?? [];
    const origIds = t.original_tax_ids ?? [];
    const existing = t.fiscal_position_mapping_ids ?? [];
    if (!origIds.length || !posIds.length) {
      return existing.length ? t : { ...t, fiscal_position_mapping_ids: [] };
    }
    const needsPerPosition = directlyUsedTaxIds.has(t.id) || posIds.length > 1 || existing.length > 0;
    if (!needsPerPosition) {
      return { ...t, fiscal_position_mapping_ids: [...existing] };
    }
    const byFp = new Map(existing.map((m) => [m.fiscal_position_id, new Set(m.original_tax_ids ?? [])]));
    for (const fpId of posIds) {
      const fp = fpById.get(fpId);
      const compatibleOrigs = origIds.filter((id) => {
        const src = taxById.get(id);
        return !fp?.company_id || !src?.company_id || src.company_id === fp.company_id;
      });
      if (!compatibleOrigs.length) continue;
      const set = byFp.get(fpId) ?? new Set();
      for (const id of compatibleOrigs) set.add(id);
      byFp.set(fpId, set);
    }
    const fiscal_position_mapping_ids = [...byFp.entries()].map(([fiscal_position_id, set]) => ({
      fiscal_position_id,
      original_tax_ids: [...set],
    }));
    return {
      ...t,
      fiscal_position_ids: [],
      original_tax_ids: [],
      fiscal_position_mapping_ids,
    };
  });

  return {
    ...db,
    records: {
      ...db.records,
      'account.tax': nextTaxes,
      'account.fiscal.position': nextPositions,
    },
  };
} });

MIGRATIONS.push({ version: 40, name: 'journal-parity', up(db) {
  const journals = db.records['account.journal'] ?? [];
  if (!journals.length) return db;
  const nextJournals = journals.map((j, idx) => {
    const invoiced = j.type === 'sale' || j.type === 'purchase';
    const liquidity = j.type === 'bank' || j.type === 'cash' || j.type === 'credit';
    const hasDistinctRefund = Boolean(
      j.refund_sequence_prefix && j.refund_sequence_prefix !== j.invoice_sequence_prefix,
    );
    return {
      ...j,
      sequence: j.sequence ?? (idx + 1) * 10,
      active: j.active === undefined ? true : j.active,
      refund_sequence: typeof j.refund_sequence === 'boolean'
        ? j.refund_sequence
        : (invoiced && hasDistinctRefund),
      payment_sequence: typeof j.payment_sequence === 'boolean'
        ? j.payment_sequence
        : liquidity,
      ...(j.type === 'bank' && j.bank_statements_source === undefined
        ? { bank_statements_source: 'undefined' }
        : {}),
      ...(j.type === 'sale' ? {
        invoice_reference_type: j.invoice_reference_type ?? 'invoice',
        invoice_reference_model: j.invoice_reference_model ?? 'odoo',
      } : {}),
    };
  });
  return { ...db, records: { ...db.records, 'account.journal': nextJournals } };
} });

MIGRATIONS.push({ version: 41, name: 'Reconciliation model Odoo 20 parity', up: (db) => {
  const existing = db.records['account.reconcile.model'];
  if (!existing?.length) return db;
  return {
    ...db,
    records: {
      ...db.records,
      'account.reconcile.model': existing.map(normalizeReconcileRule),
    },
  };
} });

// Statement lines show amounts and running balances in their journal's currency; older lines stored none.
MIGRATIONS.push({ version: 42, name: 'Statement line currency from journal', up: (db) => {
  const lines = db.records['account.bank.statement.line'];
  if (!lines?.length) return db;
  const journals = new Map((db.records['account.journal'] ?? []).map((j) => [j.id, j]));
  const companies = new Map((db.records['res.company'] ?? []).map((c) => [c.id, c]));
  const next = lines.map((line) => {
    if (line.currency_id != null || !line.journal_id) return line;
    const journal = journals.get(line.journal_id);
    const currencyId = journal?.currency_id ?? companies.get(journal?.company_id ?? line.company_id ?? 1)?.currency_id ?? null;
    return currencyId == null ? line : { ...line, currency_id: currencyId };
  });
  return { ...db, records: { ...db.records, 'account.bank.statement.line': next } };
} });

MIGRATIONS.push({ version: 43, name: 'currency-parity', up(db) {
  const currencies = db.records['res.currency'] ?? [];
  if (!currencies.length) return db;
  const nextCurrencies = currencies.map(({ unit_name: unitName, ...c }) => ({
    ...c,
    currency_unit_label: c.currency_unit_label ?? unitName ?? null,
    active: c.active === undefined ? true : c.active,
    position: c.position ?? 'before',
  }));
  return { ...db, records: { ...db.records, 'res.currency': nextCurrencies } };
} });

MIGRATIONS.push({ version: 44, name: 'payment-terms-parity', up(db) {
  const terms = db.records['account.payment.term'] ?? [];
  if (!terms.length) return db;
  const nextTerms = terms.map((t) => ({
    ...t,
    active: t.active === undefined ? true : t.active,
    display_on_invoice: t.display_on_invoice === undefined ? true : t.display_on_invoice,
  }));
  return { ...db, records: { ...db.records, 'account.payment.term': nextTerms } };
} });

/** Backfill company_id (from owning taxes, else main company) and sequence on tax groups, plus sequence/active/currency_ids on cash roundings. */
MIGRATIONS.push({ version: 45, name: 'tax-groups-and-cash-rounding-parity', up(db) {
  const companies = db.records['res.company'] ?? [];
  const mainCompanyId = companies.find((c) => !c.parent_id)?.id ?? companies[0]?.id ?? 1;
  const taxes = db.records['account.tax'] ?? [];
  const groups = db.records['account.tax.group'] ?? [];
  const roundings = db.records['account.cash.rounding'] ?? [];

  let nextGroupSeq = Math.max(0, ...groups.map((g) => Number(g.sequence) || 0));
  let nextGroupId = Math.max(0, db.seq?.['account.tax.group'] ?? 0, ...groups.map((g) => g.id ?? 0));
  // A company-less group used by several companies' taxes becomes one group per company, so each keeps seeing its own.
  const taxGroupFor = new Map();
  const nextGroups = groups.flatMap((g) => {
    const sequence = g.sequence ?? (nextGroupSeq += 10);
    if (g.company_id != null) return [{ ...g, sequence }];
    const owners = [...new Set(taxes.filter((t) => t.tax_group_id === g.id).map((t) => t.company_id ?? 1))];
    if (owners.length <= 1) return [{ ...g, company_id: owners[0] ?? mainCompanyId, sequence }];
    const [keep, ...rest] = owners.includes(mainCompanyId) ? [mainCompanyId, ...owners.filter((c) => c !== mainCompanyId)] : owners;
    return [{ ...g, company_id: keep, sequence }, ...rest.map((companyId) => {
      const id = ++nextGroupId;
      taxGroupFor.set(`${g.id}:${companyId}`, id);
      return { ...g, id, company_id: companyId, sequence };
    })];
  });
  const nextTaxes = taxes.map((t) => {
    const id = taxGroupFor.get(`${t.tax_group_id}:${t.company_id ?? 1}`);
    return id ? { ...t, tax_group_id: id } : t;
  });

  let nextRoundingSeq = Math.max(0, ...roundings.map((r) => Number(r.sequence) || 0));
  const nextRoundings = roundings.map((r) => ({
    ...r,
    active: r.active === undefined ? true : r.active,
    sequence: r.sequence ?? (nextRoundingSeq += 10),
    currency_ids: Array.isArray(r.currency_ids) ? r.currency_ids : [],
  }));

  return {
    ...db,
    records: {
      ...db.records,
      ...(groups.length ? { 'account.tax.group': nextGroups } : {}),
      ...(taxGroupFor.size ? { 'account.tax': nextTaxes } : {}),
      ...(roundings.length ? { 'account.cash.rounding': nextRoundings } : {}),
    },
    ...(taxGroupFor.size ? { seq: { ...(db.seq ?? {}), 'account.tax.group': nextGroupId } } : {}),
  };
} });

MIGRATIONS.push({ version: 46, name: 'analytic-plans-sequence-backfill', up(db) {
  const plans = db.records['account.analytic.plan'] ?? [];
  if (!plans.length) return db;
  let nextSeq = Math.max(0, ...plans.map((p) => Number(p.sequence) || 0));
  const nextPlans = plans.map((p) => ({
    ...p,
    sequence: p.sequence ?? (nextSeq += 10),
    ...(!p.parent_id && !p.default_applicability ? { default_applicability: 'optional' } : {}),
  }));
  return {
    ...db,
    records: { ...db.records, 'account.analytic.plan': nextPlans },
  };
} });

MIGRATIONS.push({ version: 47, name: 'followup-levels-parity', up(db) {
  const levels = db.records['account.followup.level'] ?? [];
  if (!levels.length) return db;
  const nextLevels = levels.map((l) => {
    const rawDelay = Number(l.delay) || 0;
    const displayDelay = l.display_delay != null ? Math.max(0, Math.trunc(Number(l.display_delay) || 0)) : Math.abs(Math.trunc(rawDelay));
    const timing = l.reminder_timing ?? (rawDelay < 0 ? 'before' : 'after');
    return {
      ...l,
      display_delay: displayDelay,
      reminder_timing: timing,
      delay: l.delay != null ? Math.trunc(rawDelay) : followUpSignedDelay(displayDelay, timing),
      send_email: l.send_email ?? (l.channel === 'email'),
      send_sms: l.send_sms ?? false,
      create_activity: l.create_activity ?? false,
      activity_default_responsible_type: l.activity_default_responsible_type ?? 'followup',
    };
  });
  return {
    ...db,
    records: { ...db.records, 'account.followup.level': nextLevels },
  };
} });

const LEGACY_CATEGORY_ACCOUNT_CONFLICT_NOTE = 'Upgrade: both legacy and canonical income/expense accounts were set on this category; both values were kept so you can choose which account to retain.';

/** Migrate legacy product.category income/expense fields while preserving differing values with a chatter note. */
function migrateCategoryAccounts(db) {
  const categories = db.records['product.category'] ?? [];
  if (!categories.length) return db;
  const byId = new Map(categories.map((c) => [c.id, c]));
  const inheritedCosting = (cat) => {
    const seen = new Set();
    for (let cur = cat; cur && !seen.has(cur.id); cur = byId.get(cur.parent_id)) {
      seen.add(cur.id);
      if (cur.property_cost_method) return cur.property_cost_method;
    }
    return 'standard';
  };
  const conflictIds = [];
  const nextCategories = categories.map((c) => {
    const {
      property_account_income_id: legacyIncome,
      property_account_expense_id: legacyExpense,
      ...rest
    } = c;
    const incomeConflict = legacyIncome != null && c.property_account_income_categ_id != null && c.property_account_income_categ_id !== legacyIncome;
    const expenseConflict = legacyExpense != null && c.property_account_expense_categ_id != null && c.property_account_expense_categ_id !== legacyExpense;
    if (incomeConflict || expenseConflict) conflictIds.push(c.id);
    return {
      ...rest,
      property_cost_method: c.property_cost_method || inheritedCosting(byId.get(c.parent_id)),
      ...(c.property_account_income_categ_id == null && legacyIncome != null ? { property_account_income_categ_id: legacyIncome } : {}),
      ...(c.property_account_expense_categ_id == null && legacyExpense != null ? { property_account_expense_categ_id: legacyExpense } : {}),
      ...(incomeConflict ? { property_account_income_id: legacyIncome } : {}),
      ...(expenseConflict ? { property_account_expense_id: legacyExpense } : {}),
    };
  });
  let next = {
    ...db,
    records: { ...db.records, 'product.category': nextCategories },
  };
  if (conflictIds.length) {
    next = { ...next, messages: next.messages ?? [] };
    for (const id of conflictIds) {
      const alreadyNoted = next.messages.some((m) => m.model === 'product.category' && m.res_id === id && m.body === LEGACY_CATEGORY_ACCOUNT_CONFLICT_NOTE);
      if (!alreadyNoted) next = postNote(next, 'product.category', id, LEGACY_CATEGORY_ACCOUNT_CONFLICT_NOTE);
    }
  }
  return next;
}

MIGRATIONS.push({ version: 48, name: 'product-category-canonical-accounts', up: migrateCategoryAccounts });

const JOURNAL_ACCOUNT_FIELDS = [
  'default_account_id',
  'suspense_account_id',
  'non_deductible_account_id',
  'profit_account_id',
  'loss_account_id',
  'outstanding_receipts_account_id',
  'outstanding_payments_account_id',
];

const UNRESOLVED_JOURNAL_COMPANY_NOTE = 'Upgrade: this journal\'s company could not be proved from its accounts or posted entries; set the company on the journal.';

/** Derive a unique owning company for an unscoped journal from its accounts and posted moves, or null if ambiguous or contradicted. */
function provableJournalCompany(journal, accountById, postedMoves, companyIds) {
  const soleCompany = companyIds.size === 1 ? [...companyIds][0] : null;
  const accountCompanies = new Set();
  for (const field of JOURNAL_ACCOUNT_FIELDS) {
    const acc = accountById.get(journal[field]);
    if (acc?.company_id != null) accountCompanies.add(acc.company_id);
  }
  if (accountCompanies.size > 1) return null;
  const fromAccounts = accountCompanies.size === 1 ? [...accountCompanies][0] : null;
  const hasUnscopedMove = postedMoves.some((m) => m.company_id == null);
  const moveCompanies = new Set(postedMoves.map((m) => m.company_id).filter((id) => id != null));
  if (soleCompany != null) {
    if (fromAccounts != null && fromAccounts !== soleCompany) return null;
    if ([...moveCompanies].some((id) => id !== soleCompany)) return null;
    return soleCompany;
  }
  if (postedMoves.length && (hasUnscopedMove || moveCompanies.size !== 1)) return null;
  const fromMoves = postedMoves.length ? [...moveCompanies][0] : null;
  if (fromAccounts != null && fromMoves != null && fromAccounts !== fromMoves) return null;
  const resolved = fromAccounts ?? fromMoves;
  if (resolved == null) return null;
  return !companyIds.size || companyIds.has(resolved) ? resolved : null;
}

/** Resolve provable company ownership for unscoped liquidity journals and post a chatter note on ambiguous ones. */
function resolveLiquidityJournalsCompany(db) {
  const journals = db.records['account.journal'] ?? [];
  if (!journals.length) return db;
  const accountById = new Map((db.records['account.account'] ?? []).map((a) => [a.id, a]));
  const postedMovesByJournal = new Map();
  for (const move of db.records['account.move'] ?? []) {
    if (move.state !== 'posted' || move.journal_id == null) continue;
    const list = postedMovesByJournal.get(move.journal_id) ?? [];
    list.push(move);
    postedMovesByJournal.set(move.journal_id, list);
  }
  const companyIds = new Set((db.records['res.company'] ?? []).map((c) => c.id));
  const unresolvedIds = [];
  let changed = false;
  const nextJournals = journals.map((j) => {
    if (j.company_id != null || !isLiquidityJournal(j)) return j;
    const resolved = provableJournalCompany(j, accountById, postedMovesByJournal.get(j.id) ?? [], companyIds);
    if (resolved == null) {
      unresolvedIds.push(j.id);
      return j;
    }
    changed = true;
    return { ...j, company_id: resolved };
  });
  let next = changed ? { ...db, records: { ...db.records, 'account.journal': nextJournals } } : db;
  if (unresolvedIds.length) {
    next = { ...next, messages: next.messages ?? [] };
    for (const id of unresolvedIds) {
      const alreadyNoted = next.messages.some((m) => m.model === 'account.journal' && m.res_id === id && m.body === UNRESOLVED_JOURNAL_COMPANY_NOTE);
      if (!alreadyNoted) next = postNote(next, 'account.journal', id, UNRESOLVED_JOURNAL_COMPANY_NOTE);
    }
  }
  return next;
}

/** Bank, cash and credit journals belong to one company; shared document journals stay shared. */
MIGRATIONS.push({ version: 49, name: 'journal-company-from-accounts-or-moves', up: resolveLiquidityJournalsCompany });

MIGRATIONS.push({ version: 50, name: 'seed-standard-statement-reports', up: (db) => ensureStatementReports(db) });
MIGRATIONS.push({ version: 51, name: 'per-kind-deferred-settings', up: (db) => {
  const journalsById = new Map((db.records['account.journal'] ?? []).map((j) => [j.id, j]));
  const companies = (db.records['res.company'] ?? []).map((c) => {
    const mappedGen = c.deferred_generation_method === 'manual'
      ? null
      : (mapLegacyDeferredGenerationMethod(c.deferred_generation_method) ?? 'on_validation');
    const mappedComp = normalizeDeferredComputationMethod(c.deferred_amount_computation_method || 'days');
    const defGen = c.default_general_journal_id ? journalsById.get(c.default_general_journal_id) : null;
    const defaultJournalId = defGen && defGen.active !== false && defGen.type === 'general' && (!defGen.company_id || defGen.company_id === c.id)
      ? defGen.id
      : null;
    return {
      ...c,
      generate_deferred_revenue_entries_method: c.generate_deferred_revenue_entries_method !== undefined ? c.generate_deferred_revenue_entries_method : mappedGen,
      generate_deferred_expense_entries_method: c.generate_deferred_expense_entries_method !== undefined ? c.generate_deferred_expense_entries_method : mappedGen,
      deferred_revenue_amount_computation_method: c.deferred_revenue_amount_computation_method ?? mappedComp,
      deferred_expense_amount_computation_method: c.deferred_expense_amount_computation_method ?? mappedComp,
      deferred_revenue_periodicity: c.deferred_revenue_periodicity ?? 'month',
      deferred_expense_periodicity: c.deferred_expense_periodicity ?? 'month',
      deferred_revenue_journal_id: c.deferred_revenue_journal_id ?? defaultJournalId,
      deferred_expense_journal_id: c.deferred_expense_journal_id ?? defaultJournalId,
    };
  });
  const kindByMoveId = new Map();
  for (const d of db.records['account.deferral'] ?? []) {
    const kind = d.kind;
    if (!kind) continue;
    for (const line of d.board ?? []) {
      if (line.move_id) kindByMoveId.set(line.move_id, kind);
      if (line.reversal_move_id) kindByMoveId.set(line.reversal_move_id, kind);
    }
    for (const adj of d.credit_adjustments ?? []) {
      for (const mid of adj.move_ids ?? []) kindByMoveId.set(mid, kind);
    }
  }
  let movesChanged = false;
  const moves = (db.records['account.move'] ?? []).map((m) => {
    if (m.deferred_entry_type) return m;
    const kind = m.deferral_kind || kindByMoveId.get(m.id);
    if (!kind) return m;
    movesChanged = true;
    return { ...m, deferred_entry_type: deferredEntryTypeForKind(kind) };
  });
  return {
    ...db,
    records: {
      ...db.records,
      'res.company': companies,
      ...(movesChanged ? { 'account.move': moves } : {}),
    },
  };
} });

/** Copy tax groups for any tax whose tax_group_id points to another company's group after an older v45 migration. */
MIGRATIONS.push({ version: 52, name: 'repair-tax-group-company-splits', up(db) {
  const taxes = db.records['account.tax'] ?? [];
  const groups = db.records['account.tax.group'] ?? [];
  if (!taxes.length || !groups.length) return db;
  const groupById = new Map(groups.map((g) => [g.id, g]));
  let nextGroupId = Math.max(0, db.seq?.['account.tax.group'] ?? 0, ...groups.map((g) => g.id ?? 0));
  let nextGroupSeq = Math.max(0, ...groups.map((g) => Number(g.sequence) || 0));
  const copyFor = new Map();
  const extraGroups = [];
  const nextTaxes = taxes.map((t) => {
    const group = t.tax_group_id ? groupById.get(t.tax_group_id) : null;
    const taxCompanyId = t.company_id ?? 1;
    if (!group?.company_id || group.company_id === taxCompanyId) return t;
    const key = `${group.id}:${taxCompanyId}`;
    let copyId = copyFor.get(key);
    if (!copyId) {
      copyId = ++nextGroupId;
      copyFor.set(key, copyId);
      extraGroups.push({
        ...group,
        id: copyId,
        company_id: taxCompanyId,
        sequence: group.sequence ?? (nextGroupSeq += 10),
      });
    }
    return { ...t, tax_group_id: copyId };
  });
  if (!copyFor.size) return db;
  return {
    ...db,
    records: {
      ...db.records,
      'account.tax.group': [...groups, ...extraGroups],
      'account.tax': nextTaxes,
    },
    seq: { ...(db.seq ?? {}), 'account.tax.group': nextGroupId },
  };
/** Single-company journal scoping, conflicting legacy category notes, and in_refund analytic category alignment. */
MIGRATIONS.push({ version: 53, name: 'qodo-117-upgrade-fixes', up(db) {
  let next = migrateCategoryAccounts(db);
  next = resolveLiquidityJournalsCompany(next);
  const moveTypes = new Map((next.records['account.move'] ?? []).map((m) => [m.id, m.move_type]));
  const analyticLines = next.records['account.analytic.line'] ?? [];
  let analyticChanged = false;
  const nextAnalyticLines = analyticLines.map((line) => {
    if (line.move_id && line.category === 'invoice' && moveTypes.get(line.move_id) === 'in_refund') {
      analyticChanged = true;
      return { ...line, category: 'vendor_bill' };
    }
    return line;
  });
  return analyticChanged
    ? { ...next, records: { ...next.records, 'account.analytic.line': nextAnalyticLines } }
    : next;
} });

export const SCHEMA_VERSION = MIGRATIONS.at(-1).version;

/** Bring a database up to SCHEMA_VERSION. Returns the same object when nothing ran. */
export function migrate(db, toVersion = SCHEMA_VERSION) {
  if (!db?.records) return db;
  const from = db.schema_version ?? 0;
  if (from > toVersion) throw new Error(`Database schema ${from} is newer than this version of Mizan (${toVersion})`);
  const pending = MIGRATIONS.filter((m) => m.version > from && m.version <= toVersion);
  if (!pending.length) return db;
  return { ...pending.reduce((acc, m) => m.up(acc), db), schema_version: toVersion };
}
