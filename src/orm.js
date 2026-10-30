// @ts-check
// Pure ORM over a plain db object: { records: {model: [rec]}, seq: {model: n}, messages: [] }.
// Every function returns a new db; nothing is mutated.
import { models } from './registry.js';
import { distributionError } from './analytic_distribution.js';

export const emptyDb = () => ({ records: {}, seq: {}, messages: [], settings: { company: 'My Company', currency: 'USD' } });

export const nextId = (db, model) => (db.seq[model] ?? 0) + 1;

// ---- multi-company: records of company-scoped models carry company_id (missing = company 1) ----
/** Master data shared by all companies (Odoo shares these by default). */
export const SHARED_MODELS = new Set(['res.partner', 'product', 'account.account', 'account.journal', 'res.currency', 'product.pricelist', 'discuss.channel',
  'mail.activity', 'hr.department', 'website.page', 'mailing.list', 'mailing.contact', 'lunch.product', 'room.room', 'appointment.type',
  'account.tax', 'uom.category', 'uom.uom', 'product.packaging', 'account.payment.term', 'account.fiscal.position', 'delivery.carrier', 'crm.team', 'hr.payroll.structure', 'hr.payslip.input.type', 'product.public.category',
  'account.incoterm', 'account.account.tag', 'account.asset.model']);
let activeCompany = null; // null = no filtering (server, tests)
export const setActiveCompany = (id) => { activeCompany = Number(id) || null; };
export const getActiveCompany = () => activeCompany;
const inCompany = (model, r) => !activeCompany || SHARED_MODELS.has(model) || (r.company_id ?? 1) === activeCompany;

const withComputed = (fields, r, db) => {
  const computed = Object.entries(fields).filter(([, f]) => f.compute);
  return computed.length ? { ...r, ...Object.fromEntries(computed.map(([k, f]) => [k, f.compute(r, db)])) } : r;
};

/** Records of a model in the active company, with computed fields. Archived (active === false) hidden by default. */
export function search(db, model, { includeArchived = false } = {}) {
  const fields = models[model].fields;
  return (db.records[model] ?? [])
    .filter((r) => (includeArchived || r.active !== false) && inCompany(model, r))
    .map((r) => withComputed(fields, r, db));
}

// id -> position per records array. Arrays are never mutated (writes copy them), so an index stays valid for the
// array it was built from; it is built on the second lookup so one-off reads after a write stay a plain scan.
const positions = new WeakMap();
function locate(list, id) {
  const seen = positions.get(list);
  if (seen instanceof Map) {
    const at = seen.get(id);
    // The position is checked against the array, so even an in-place change can only cost a scan, never a wrong record.
    if (at !== undefined && list[at]?.id === id) return list[at];
    return list.find((x) => x.id === id);
  }
  if (seen) positions.set(list, new Map(list.map((x, i) => [x.id, i])));
  else positions.set(list, true);
  return list.find((x) => x.id === id);
}

/** One record by id regardless of company (cross-company links still display). */
export function read(db, model, id) {
  const r = locate(db.records[model] ?? [], id);
  return r && withComputed(models[model].fields, r, db);
}

/** @returns {string|null} error message when a required field is empty */
export function validate(model, vals, db) {
  const missing = Object.entries(models[model].fields).find(
    ([k, f]) => f.required && (vals[k] == null || vals[k] === ''),
  );
  return missing ? `${missing[1].label} is required` : distributionError(models[model].fields, vals, db);
}

/**
 * Field paths in `rec` that the server's sanitizer (validate.js cleanRecord) would silently drop: keys the model does
 * not declare, top level or inside one2many lines. Logic must only write declared fields, or client and server diverge.
 */
export function undeclaredFields(model, rec) {
  const fields = models[model].fields;
  const out = Object.keys(rec).filter((k) => !['id', 'active', 'company_id'].includes(k) && !fields[k]);
  for (const [k, f] of Object.entries(fields)) {
    if (f.type !== 'one2many' || !Array.isArray(rec[k]) || !f.fields) continue;
    for (const line of rec[k]) out.push(...Object.keys(line ?? {}).filter((sub) => !f.fields[sub]).map((sub) => `${k}.${sub}`));
  }
  return [...new Set(out)];
}
const STRICT_FIELDS = globalThis.process?.env?.MIZAN_STRICT_FIELDS;
const checkDeclared = (model, rec) => {
  if (!STRICT_FIELDS) return;
  const bad = undeclaredFields(model, rec);
  if (!bad.length) return;
  if (STRICT_FIELDS === 'log') globalThis.process.stderr.write(`UNDECLARED ${model}: ${bad.join(',')} @ ${new Error().stack.split('\n').slice(3).find((l) => !l.includes('orm.js'))?.trim()}\n`);
  else throw new Error(`Undeclared fields on ${model}: ${bad.join(', ')}`);
};

function stripComputed(model, vals) {
  const fields = models[model].fields;
  return Object.fromEntries(Object.entries(vals).filter(([k]) => !fields[k]?.compute || fields[k]?.type === 'one2many'));
}

let author = 'Admin';
/** Name stamped on chatter messages created by this client/process. */
export const setAuthor = (name) => { author = name; };

const message = (model, resId, body, kind, record, source) => ({
  id: crypto.randomUUID(),
  model,
  res_id: resId,
  body,
  kind,
  author,
  date: new Date().toISOString(),
  ...(source ? { source_model: source.model, source_id: source.id, company_id: source.company_id ?? 1 } : record && !SHARED_MODELS.has(model) ? { company_id: record.company_id || 1 } : {}),
});

export function create(db, model, vals) {
  const id = nextId(db, model);
  const rec = {
    ...(models[model].defaults?.(id) ?? {}),
    ...(models[model].createDefaults?.(db, vals) ?? {}),
    ...(SHARED_MODELS.has(model) ? {} : { company_id: activeCompany ?? 1 }),
    ...stripComputed(model, vals),
    id,
  };
  const err = validate(model, rec, db) ?? models[model].guard?.(db, null, rec);
  if (err) throw new Error(err);
  checkDeclared(model, rec);
  const res = {
    db: {
      ...db,
      records: { ...db.records, [model]: [...(db.records[model] ?? []), rec] },
      seq: { ...db.seq, [model]: id },
      messages: [...db.messages, message(model, id, `${models[model].label}: record created`, 'tracking', rec)],
    },
    id,
  };
  return model === 'res.partner' ? { ...res, db: models[model].onWrite?.(res.db, rec, null, vals) ?? res.db } : res;
}

function trackingMessages(db, model, before, vals) {
  const fields = models[model].fields;
  const audited = models[model].audited?.(db);
  return Object.entries(vals)
    .filter(([k, v]) => fields[k] && (fields[k].tracking || audited) && JSON.stringify(before[k]) !== JSON.stringify(v))
    .map(([k, v]) => {
      if (typeof v === 'object' && v !== null) return message(model, before.id, `${fields[k].label}: updated`, 'tracking', before);
      const label = (x) => {
        if (fields[k].options) return fields[k].options.find((o) => o[0] === x)?.[1] ?? x;
        if (fields[k].type === 'many2one' && fields[k].relation) {
          const relRec = (db.records[fields[k].relation] ?? []).find((r) => r.id === x || r.name?.toLowerCase() === String(x).toLowerCase());
          if (relRec?.name) return relRec.name;
        }
        return x;
      };
      return message(model, before.id, `${fields[k].label}: ${label(before[k])} → ${label(v)}`, 'tracking', before);
    });
}

/** Apply onchange without mutating the original record. */
function writeValues(db, model, before, vals) {
  const base = stripComputed(model, vals);
  // Model onchange also runs for programmatic writes (kanban drag, status bar), so dependent fields stay consistent.
  const clean = { ...base, ...Object.fromEntries(Object.keys(base).flatMap((k) => Object.entries(models[model].onchange?.({ ...before, ...base }, k, db) ?? {})).filter(([k]) => !(k in base))) };
  return { after: { ...before, ...clean }, clean };
}

/** Onchange, validation and guard for one write; returns the updated record and the values actually written. */
function prepareWrite(db, model, before, vals) {
  const result = writeValues(db, model, before, vals);
  const err = validate(model, result.after, db) ?? models[model].guard?.(db, before, result.after);
  if (err) throw new Error(err);
  checkDeclared(model, result.after);
  return result;
}

export function write(db, model, id, vals) {
  const before = (db.records[model] ?? []).find((r) => r.id === id);
  if (!before) throw new Error(`${model} #${id} not found`);
  const { after, clean } = prepareWrite(db, model, before, vals);
  const next = {
    ...db,
    records: { ...db.records, [model]: db.records[model].map((r) => (r.id === id ? after : r)) },
    messages: [...db.messages, ...trackingMessages(db, model, before, clean)],
  };
  return models[model].onWrite?.(next, after, before, clean) ?? next;
}

/** Validate simultaneous updates against their complete final state, then apply them immutably. */
export function writeManyAtomic(db, model, updates) {
  if (!updates.size) return db;
  const list = db.records[model] ?? [];
  const byId = new Map(list.map((record) => [record.id, record]));
  const changes = new Map();
  for (const [id, vals] of updates) {
    const before = byId.get(id);
    if (!before) throw new Error(`${model} #${id} not found`);
    changes.set(id, { before, vals, ...writeValues(db, model, before, vals) });
  }
  let next = { ...db, records: { ...db.records, [model]: list.map((record) => changes.get(record.id)?.after ?? record) } };
  for (const { before, after } of changes.values()) {
    const error = validate(model, after, next) ?? models[model].guard?.(next, before, after);
    if (error) throw new Error(error);
    checkDeclared(model, after);
  }
  next = { ...next, messages: [...db.messages, ...[...changes.values()].flatMap(({ before, clean }) => trackingMessages(db, model, before, clean))] };
  for (const { before, after, vals } of changes.values()) {
    next = models[model].onWrite?.(next, after, before, vals) ?? next;
  }
  return next;
}

/**
 * Write several records of one model in one pass: `updates` maps id -> vals. Each record gets the same onchange,
 * validation, guard and tracking as write(), checked against `db`; the array and the chatter are copied once, so
 * batch jobs stay linear instead of copying everything per record.
 */
export function writeMany(db, model, updates) {
  if (!updates.size) return db;
  const list = db.records[model] ?? [];
  const byId = new Map(list.map((r) => [r.id, r]));
  const written = new Map();
  const tracked = [];
  for (const [id, vals] of updates) {
    const before = byId.get(id);
    if (!before) throw new Error(`${model} #${id} not found`);
    const { after, clean } = prepareWrite(db, model, before, vals);
    written.set(id, after);
    tracked.push(...trackingMessages(db, model, before, clean));
  }
  const next = {
    ...db,
    records: { ...db.records, [model]: list.map((r) => written.get(r.id) ?? r) },
    messages: tracked.length ? [...db.messages, ...tracked] : db.messages,
  };
  return [...written].reduce((acc, [id, after]) => models[model].onWrite?.(acc, after, byId.get(id), updates.get(id)) ?? acc, next);
}

/** Add several chatter notes at once: `notes` are [model, id, body]. */
export const postNotes = (db, notes) => (notes.length
  ? { ...db, messages: [...db.messages, ...notes.map(([model, id, body, source]) => message(model, id, body, 'note', (db.records[model] ?? []).find((r) => r.id === id), source))] } : db);

/**
 * The first record that still points at one of `ids` of `model` (a many2one, or a many2one inside one2many lines),
 * described for an error message, or null. Records being deleted themselves don't count.
 */
export function referenceTo(db, model, ids) {
  const drop = new Set(ids);
  for (const [source, def] of Object.entries(models)) {
    for (const [key, f] of Object.entries(def.fields)) {
      const direct = f.type === 'many2one' && f.relation === model && !f.compute;
      const multiple = f.type === 'many2many' && f.relation === model && !f.compute;
      const sub = f.type === 'one2many' && f.fields ? Object.keys(f.fields).filter((k) => ['many2one', 'many2many'].includes(f.fields[k].type) && f.fields[k].relation === model) : [];
      if (!direct && !multiple && !sub.length) continue;
      const hit = (db.records[source] ?? []).find((r) => !(source === model && drop.has(r.id))
        && (direct ? drop.has(r[key]) : multiple ? (r[key] ?? []).some((id) => drop.has(id)) : Array.isArray(r[key]) && r[key].some((l) => sub.some((k) => Array.isArray(l?.[k]) ? l[k].some((id) => drop.has(id)) : drop.has(l?.[k])))));
      if (hit) return `${def.label} ${hit.name ?? `#${hit.id}`}`;
    }
  }
  return null;
}

export function unlink(db, model, ids) {
  const drop = new Set(ids);
  const blocked = (db.records[model] ?? []).filter((r) => drop.has(r.id)).map((r) => models[model].protectDelete?.(db, r)).find(Boolean);
  if (blocked) throw new Error(blocked);
  const removed = (db.records[model] ?? []).filter((r) => drop.has(r.id));
  const next = {
    ...db,
    records: { ...db.records, [model]: (db.records[model] ?? []).filter((r) => !drop.has(r.id)) },
    messages: model === 'account.move' ? [...db.messages, ...removed.map((r) => message(model, r.id, 'Record deleted', 'tracking', r))] : db.messages.filter((m) => !(m.model === model && drop.has(m.res_id))),
  };
  const result = removed.reduce((acc, r) => models[model].onUnlink?.(acc, r) ?? acc, next);
  // Checked after onUnlink, so records it removes along with these don't block the delete.
  const used = referenceTo(result, model, ids);
  if (used) throw new Error(`This record is still used by ${used}; archive it instead`);
  return result;
}

/** A tracking (audit) message, as `write` posts for a changed tracked field. */
export const postTracking = (db, model, id, body, by = author) => ({ ...db, messages: [...db.messages, { ...message(model, id, body, 'tracking', (db.records[model] ?? []).find((r) => r.id === id)), author: by }] });
export const postNote = (db, model, id, body, source) => ({ ...db, messages: [...db.messages, message(model, id, body, 'note', (db.records[model] ?? []).find((r) => r.id === id), source)] });

export const messagesOf = (db, model, id) =>
  db.messages.filter((m) => m.model === model && m.res_id === id).sort((a, b) => b.date.localeCompare(a.date));

export const updateSettings = (db, vals) => ({ ...db, settings: { ...db.settings, ...vals } });

const groupKey = (field, v) => {
  if (field.type === 'date' || field.type === 'datetime') return v ? v.slice(0, 7) : false;
  if (field.type === 'boolean') return !!v;
  return v ?? false;
};

export function groupLabel(db, field, key) {
  if (key === false || key == null || key === '') return field.type === 'boolean' ? 'No' : 'None';
  switch (field.type) {
    case 'date': case 'datetime': return new Date(key + '-01T00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    case 'selection': return field.options.find((o) => o[0] === key)?.[1] ?? key;
    case 'many2one': return read(db, field.relation, key)?.name ?? 'None';
    case 'boolean': return 'Yes';
    default: return String(key);
  }
}

/**
 * Group records by a field. Selection groups follow option order and include empty options;
 * dates group by month (chronological); others sort by label with "None" last.
 * @returns {{key: any, label: string, records: object[]}[]}
 */
export function groupRecords(db, model, records, name, context = {}) {
  const field = models[model].fields[name];
  const isStageRel = field.type === 'many2one' && ['crm.stage', 'project.task.type'].includes(field.relation);
  let stageList = isStageRel
    ? (db?.records?.[field.relation] ?? []).slice().sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.id - b.id)
    : null;
  if (isStageRel && stageList) {
    if (model === 'crm.lead' && context.team_id) {
      stageList = stageList.filter((s) => !s.team_ids?.length || s.team_ids.includes(context.team_id));
    } else if (model === 'project.task' && context.project_id) {
      stageList = stageList.filter((s) => !s.project_ids?.length || s.project_ids.includes(context.project_id));
    }
  }
  const buckets = new Map(
    field.type === 'selection'
      ? field.options.map(([k]) => [k, []])
      : isStageRel
        ? stageList.map((s) => [s.id, []])
        : [],
  );
  for (const r of records) {
    let k = groupKey(field, r[name]);
    if (isStageRel && typeof k === 'string') {
      const match = stageList.find((s) => s.name.toLowerCase() === k.toLowerCase() || (k === 'won' && s.is_won));
      if (match) k = match.id;
    }
    buckets.set(k, [...(buckets.get(k) ?? []), r]);
  }
  const groups = [...buckets].map(([key, recs]) => ({ key, label: groupLabel(db, field, key), records: recs }));
  if (field.type === 'selection' || isStageRel) return groups;
  const rank = (g) => (g.key === false ? '￿' : ['date', 'datetime'].includes(field.type) ? String(g.key) : g.label.toLowerCase());
  return groups.sort((a, b) => rank(a).localeCompare(rank(b)));
}

/** Sum of a numeric field, or the record count for the pseudo-measure "__count". */
export const aggregate = (records, measure) =>
  measure === '__count' ? records.length : records.reduce((s, r) => s + (Number(r[measure]) || 0), 0);

/** Filters in the same group are OR-ed, groups are AND-ed (search-panel semantics). */
export function applyFilters(model, records, activeIds) {
  const groups = (models[model].filters ?? [])
    .map((g) => g.filter((f) => activeIds.includes(f.id)))
    .filter((g) => g.length);
  return records.filter((r) => groups.every((g) => g.some((f) => f.fn(r))));
}

/** Text search: every term must match some char/text/many2one display value. */
export function matches(db, model, rec, terms) {
  const fields = models[model].fields;
  const haystack = Object.entries(fields)
    .map(([k, f]) => {
      if (f.type === 'many2one') return read(db, f.relation, rec[k])?.name ?? '';
      if (f.type === 'tags') return (rec[k] ?? []).join(' ');
      return ['char', 'text', 'selection'].includes(f.type) ? String(rec[k] ?? '') : '';
    })
    .join(' ')
    .toLowerCase();
  return terms.every((t) => haystack.includes(t.toLowerCase()));
}
