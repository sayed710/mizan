import { create, getActiveCompany, read, write, writeMany } from '../orm.js';
import { commercialPartnerId, today, validDate } from './common.js';
import { syncPartnerBankAccounts, validatePartnerBankLines } from './partnerbank.js';
import { creditLimitEnabled, isPartnerFollowUpPostponed, partnerFollowUpStatus, updatePartnerFollowUp } from './finance.js';
import { appOpen } from '../access.js';
import { LANGUAGES } from '../i18n.js';
import { countryIdFor, countryReferenceError, stateIdFor } from './country.js';
import { isMethodLineJournal, preferredPaymentMethodLineError } from './paymentmethod-helpers.js';
import { models } from '../registry.js';

const INVOICE_SENDING_METHODS = [['email', 'Email'], ['manual', 'Download']];
const VALID_INVOICE_SENDING_METHODS = new Set(INVOICE_SENDING_METHODS.map(([k]) => k));

const ADDRESS_TYPE_LABELS = { invoice: 'Invoice', delivery: 'Delivery', other: 'Other' };
const ADDRESS_TYPE_OPTIONS = [['contact', 'Contact'], ['invoice', 'Invoice'], ['delivery', 'Delivery'], ['other', 'Other']];
const VALID_ADDRESS_TYPES = new Set(ADDRESS_TYPE_OPTIONS.map(([k]) => k));
const ADDRESS_TYPE_ERROR = 'Address Type must be Contact, Invoice, Delivery, or Other';
const CHILD_LINE_FIELDS = ['type', 'name', 'email', 'phone', 'function', 'street', 'city', 'state_id', 'zip', 'country_id', 'comment'];

// Standard Odoo partner industries (odoo/addons/base/data/res_partner_data.xml)
export const STANDARD_PARTNER_INDUSTRIES = [
  ['Agriculture', 'A - AGRICULTURE, FORESTRY AND FISHING'],
  ['Mining', 'B - MINING AND QUARRYING'],
  ['Manufacturing', 'C - MANUFACTURING'],
  ['Energy supply', 'D - ELECTRICITY, GAS, STEAM AND AIR CONDITIONING SUPPLY'],
  ['Water supply', 'E - WATER SUPPLY; SEWERAGE, WASTE MANAGEMENT AND REMEDIATION ACTIVITIES'],
  ['Construction', 'F - CONSTRUCTION'],
  ['Wholesale/Retail', 'G - WHOLESALE AND RETAIL TRADE; REPAIR OF MOTOR VEHICLES AND MOTORCYCLES'],
  ['Transportation/Logistics', 'H - TRANSPORTATION AND STORAGE'],
  ['Food/Hospitality', 'I - ACCOMMODATION AND FOOD SERVICE ACTIVITIES'],
  ['IT/Communication', 'J - INFORMATION AND COMMUNICATION'],
  ['Finance/Insurance', 'K - FINANCIAL AND INSURANCE ACTIVITIES'],
  ['Real Estate', 'L - REAL ESTATE ACTIVITIES'],
  ['Scientific', 'M - PROFESSIONAL, SCIENTIFIC AND TECHNICAL ACTIVITIES'],
  ['Administrative/Utilities', 'N - ADMINISTRATIVE AND SUPPORT SERVICE ACTIVITIES'],
  ['Public Administration', 'O - PUBLIC ADMINISTRATION AND DEFENCE; COMPULSORY SOCIAL SECURITY'],
  ['Education', 'P - EDUCATION'],
  ['Health/Social', 'Q - HUMAN HEALTH AND SOCIAL WORK ACTIVITIES'],
  ['Entertainment', 'R - ARTS, ENTERTAINMENT AND RECREATION'],
  ['Other Services', 'S - OTHER SERVICE ACTIVITIES'],
  ['Households', 'T - ACTIVITIES OF HOUSEHOLDS AS EMPLOYERS; UNDIFFERENTIATED GOODS- AND SERVICES-PRODUCING ACTIVITIES OF HOUSEHOLDS FOR OWN USE'],
  ['Extraterritorial', 'U - ACTIVITIES OF EXTRATERRITORIAL ORGANISATIONS AND BODIES'],
];

/** Seed any missing standard `res.partner.industry` records (idempotent, matching by name). */
export function ensurePartnerIndustries(db) {
  if (!db) return db;
  const existing = db.records?.['res.partner.industry'] ?? [];
  const maxId = Math.max(db.seq?.['res.partner.industry'] ?? 0, 0, ...existing.map((r) => Number(r?.id) || 0));
  let next = {
    ...db,
    records: db.records ?? {},
    seq: maxId > (db.seq?.['res.partner.industry'] ?? 0) ? { ...(db.seq ?? {}), 'res.partner.industry': maxId } : (db.seq ?? {}),
    messages: db.messages ?? [],
  };
  const existingNames = new Set(
    existing.map((r) => String(r?.name ?? '').trim().toLowerCase()).filter(Boolean),
  );
  for (const [name, full_name] of STANDARD_PARTNER_INDUSTRIES) {
    if (existingNames.has(name.toLowerCase())) continue;
    next = create(next, 'res.partner.industry', { name, full_name }).db;
    existingNames.add(name.toLowerCase());
  }
  return next;
}

const EMPTY_LIST = [];
const EMPTY_SET = new Set();
const EMPTY_MOVE_SUMMARY = { customerMoves: EMPTY_LIST, supplierMoves: EMPTY_LIST, postedCustomerMoves: EMPTY_LIST, totalInvoiced: 0 };

const partnerIndexCache = new WeakMap();
function partnerIndex(db) {
  const records = db?.records;
  if (!records || typeof records !== 'object') {
    return { byId: new Map(), childrenByParent: new Map(), activeChildrenByParent: new Map(), descendantsById: new Map() };
  }
  let index = partnerIndexCache.get(records);
  if (!index) {
    const byId = new Map();
    const childrenByParent = new Map();
    const activeChildrenByParent = new Map();
    for (const p of records['res.partner'] ?? []) {
      if (!p) continue;
      if (p.id != null) byId.set(p.id, p);
      if (p.parent_id != null) {
        const all = childrenByParent.get(p.parent_id);
        if (all) all.push(p);
        else childrenByParent.set(p.parent_id, [p]);
        if (p.active !== false) {
          const act = activeChildrenByParent.get(p.parent_id);
          if (act) act.push(p);
          else activeChildrenByParent.set(p.parent_id, [p]);
        }
      }
    }
    index = { byId, childrenByParent, activeChildrenByParent, descendantsById: new Map() };
    partnerIndexCache.set(records, index);
  }
  return index;
}

const partnerBanksCache = new WeakMap();
function banksByPartner(db) {
  const records = db?.records;
  if (!records || typeof records !== 'object') return new Map();
  let index = partnerBanksCache.get(records);
  if (!index) {
    index = new Map();
    for (const b of records['res.partner.bank'] ?? []) {
      if (b && b.partner_id != null && b.active !== false) {
        const arr = index.get(b.partner_id);
        if (arr) arr.push(b);
        else index.set(b.partner_id, [b]);
      }
    }
    partnerBanksCache.set(records, index);
  }
  return index;
}

/** Display name including the parent company for non-company child contacts, matching Odoo's res.partner.complete_name. */
export function partnerCompleteName(db, r) {
  if (!r) return '';
  let name = r.name || '';
  if (r.parent_id) {
    if (!name && ADDRESS_TYPE_LABELS[r.type]) name = ADDRESS_TYPE_LABELS[r.type];
    if (!r.is_company) {
      const { byId } = partnerIndex(db);
      let cur = byId.get(r.parent_id);
      const seen = new Set();
      while (cur?.parent_id && !seen.has(cur.id)) {
        seen.add(cur.id);
        const next = byId.get(cur.parent_id);
        if (!next) break;
        cur = next;
      }
      if (cur?.name) name = name ? `${cur.name}, ${name}` : `${cur.name},`;
    }
  }
  return name.trim();
}

function getDescendantIds(db, partnerId) {
  if (!partnerId || !db?.records?.['res.partner']) return EMPTY_SET;
  const idx = partnerIndex(db);
  let ids = idx.descendantsById.get(partnerId);
  if (!ids) {
    ids = new Set();
    const queue = [partnerId];
    while (queue.length) {
      const cur = queue.shift();
      if (ids.has(cur)) continue;
      ids.add(cur);
      for (const child of idx.childrenByParent.get(cur) ?? []) {
        if (child?.id != null && !ids.has(child.id)) queue.push(child.id);
      }
    }
    idx.descendantsById.set(partnerId, ids);
  }
  return ids;
}

/** All partner IDs in the subtree rooted at `partnerId` (including archived child contacts, cycle-safe). */
export function partnerDescendantIds(db, partnerId) {
  return new Set(getDescendantIds(db, partnerId));
}

const isVisibleMove = (db, move) => {
  if (!move || move.active === false) return false;
  const activeCo = getActiveCompany();
  if (activeCo && (move.company_id ?? 1) !== activeCo) return false;
  const allowed = db?.settings?.allowed_company_ids;
  return !Array.isArray(allowed) || !allowed.length || allowed.includes(move.company_id ?? 1);
};

const partnerMovesCache = new WeakMap();
function moveScopeKey(db) {
  const activeCo = getActiveCompany() ?? '';
  const allowed = db?.settings?.allowed_company_ids;
  const allowedKey = Array.isArray(allowed) && allowed.length ? [...allowed].sort((a, b) => a - b).join(',') : '';
  return `${activeCo}|${allowedKey}|${db?.settings?.currency ?? ''}`;
}

function partnerMovesIndex(db) {
  const records = db?.records;
  if (!records || typeof records !== 'object') {
    return { customerByPartner: new Map(), vendorByPartner: new Map(), moveOrder: new Map(), summaryByPartner: new Map() };
  }
  let byScope = partnerMovesCache.get(records);
  if (!byScope) {
    byScope = new Map();
    partnerMovesCache.set(records, byScope);
  }
  const key = moveScopeKey(db);
  let index = byScope.get(key);
  if (!index) {
    const customerByPartner = new Map();
    const vendorByPartner = new Map();
    const moveOrder = new Map();
    const moves = records['account.move'] ?? [];
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      if (!isVisibleMove(db, m) || m.partner_id == null) continue;
      if (m.move_type === 'out_invoice' || m.move_type === 'out_refund') {
        moveOrder.set(m, i);
        const list = customerByPartner.get(m.partner_id);
        if (list) list.push(m);
        else customerByPartner.set(m.partner_id, [m]);
      } else if (m.move_type === 'in_invoice' || m.move_type === 'in_refund') {
        moveOrder.set(m, i);
        const list = vendorByPartner.get(m.partner_id);
        if (list) list.push(m);
        else vendorByPartner.set(m.partner_id, [m]);
      }
    }
    index = { customerByPartner, vendorByPartner, moveOrder, summaryByPartner: new Map() };
    byScope.set(key, index);
  }
  return index;
}

function collectPartnerMoves(byPartner, moveOrder, ids) {
  const chunks = [];
  for (const id of ids) {
    const list = byPartner.get(id);
    if (list?.length) chunks.push(list);
  }
  if (!chunks.length) return EMPTY_LIST;
  if (chunks.length === 1) return chunks[0];
  return chunks.flat().sort((a, b) => (moveOrder.get(a) ?? 0) - (moveOrder.get(b) ?? 0));
}

function partnerMoveSummary(db, partner) {
  if (!db || !partner?.id) return EMPTY_MOVE_SUMMARY;
  const index = partnerMovesIndex(db);
  let summary = index.summaryByPartner.get(partner.id);
  if (!summary) {
    const { childrenByParent } = partnerIndex(db);
    let customerMoves;
    let supplierMoves;
    if (!childrenByParent.has(partner.id)) {
      customerMoves = index.customerByPartner.get(partner.id) ?? EMPTY_LIST;
      supplierMoves = index.vendorByPartner.get(partner.id) ?? EMPTY_LIST;
    } else {
      const ids = getDescendantIds(db, partner.id);
      customerMoves = collectPartnerMoves(index.customerByPartner, index.moveOrder, ids);
      supplierMoves = collectPartnerMoves(index.vendorByPartner, index.moveOrder, ids);
    }
    summary = { customerMoves, supplierMoves, postedCustomerMoves: null, totalInvoiced: null };
    index.summaryByPartner.set(partner.id, summary);
  }
  return summary;
}

/** Customer invoices and credit notes belonging to `partner` or any of its child contacts. */
export function partnerCustomerInvoices(db, partner, { postedOnly = false } = {}) {
  const summary = partnerMoveSummary(db, partner);
  if (!postedOnly) return summary.customerMoves.slice();
  if (!summary.postedCustomerMoves) {
    summary.postedCustomerMoves = summary.customerMoves.filter((m) => m.state === 'posted');
  }
  return summary.postedCustomerMoves.slice();
}

/** Signed company-currency total of posted customer invoices and credit notes for `partner` and its child contacts. */
export function partnerTotalInvoiced(db, partner) {
  const summary = partnerMoveSummary(db, partner);
  if (summary.totalInvoiced == null) {
    if (!summary.customerMoves.length) {
      summary.totalInvoiced = 0;
    } else {
      const computeSigned = models['account.move']?.fields?.amount_total_signed?.compute;
      let sum = 0;
      for (const m of summary.customerMoves) {
        if (m.state !== 'posted') continue;
        const val = computeSigned ? computeSigned(m, db) : m.amount_total_signed;
        sum += Number.isFinite(val) ? val : 0;
      }
      summary.totalInvoiced = sum;
    }
  }
  return summary.totalInvoiced;
}

/** Vendor bills and vendor refunds belonging to `partner` or any of its child contacts. */
export function partnerSupplierBills(db, partner) {
  return partnerMoveSummary(db, partner).supplierMoves.slice();
}

function partnerMoveTarget(invoiceRoute, refundRoute, invoiceMoveType, moves, partner) {
  const hasInvoice = moves.some((m) => m.move_type === invoiceMoveType);
  const hasRefund = moves.some((m) => m.move_type !== invoiceMoveType);
  if (hasInvoice && hasRefund) {
    return `accounting/entries?view=list&rel=id:${moves.map((m) => m.id).join(',')}`;
  }
  const route = moves.length && !hasInvoice ? refundRoute : invoiceRoute;
  const partnerIds = new Set(moves.map((m) => m.partner_id));
  if (!moves.length || (partnerIds.size === 1 && partnerIds.has(partner.id))) {
    return `${route}?view=list&rel=partner_id:${partner.id}`;
  }
  return `${route}?view=list&rel=id:${moves.map((m) => m.id).join(',')}`;
}

function normalizePartnerVals(db, vals, before = null) {
  if (!vals || typeof vals !== 'object' || !db) return vals;
  const next = { ...vals };
  if ('country_id' in next && !('country' in next)) {
    const countryRec = next.country_id ? read(db, 'res.country', next.country_id) : null;
    next.country = countryRec?.name ?? '';
  } else if ('country' in next && !('country_id' in next)) {
    const cid = countryIdFor(db, next.country);
    if (cid != null) next.country_id = cid;
    else if (!next.country) next.country_id = null;
  }

  const effectiveCountryId = 'country_id' in next ? next.country_id : (before?.country_id ?? null);
  if ('country_id' in next && !('state_id' in next)) {
    if (!next.country_id) {
      if (before?.state_id != null || before?.state) {
        next.state_id = null;
        if (!('state' in next)) next.state = '';
      }
    } else if (before?.state_id) {
      const st = read(db, 'res.country.state', before.state_id);
      if (st && st.country_id !== next.country_id) {
        next.state_id = null;
        if (!('state' in next)) next.state = '';
      }
    }
  }

  if ('state_id' in next && !('state' in next)) {
    const st = next.state_id ? read(db, 'res.country.state', next.state_id) : null;
    next.state = st?.name ?? '';
    if (st && !effectiveCountryId && !('country_id' in next)) {
      next.country_id = st.country_id;
      if (!('country' in next)) next.country = read(db, 'res.country', st.country_id)?.name ?? '';
    }
  } else if ('state' in next && !('state_id' in next)) {
    const sid = stateIdFor(db, next.state, effectiveCountryId);
    if (sid != null) next.state_id = sid;
    else if (!next.state) next.state_id = null;
  }

  if ('parent_id' in next && next.parent_id && !('company_id' in next)) {
    const parent = read(db, 'res.partner', next.parent_id);
    if (parent?.company_id != null) next.company_id = parent.company_id;
  }
  return next;
}

/** Validate `child_ids` one2many lines submitted on a partner form or API write. */
export function validatePartnerChildLines(db, partnerId, childLines = []) {
  if (!Array.isArray(childLines)) return null;
  const { byId } = partnerIndex(db);
  const seenIds = new Set();
  for (const line of childLines) {
    if (!line || (line.id != null && (!Number.isSafeInteger(line.id) || line.id < 1))) {
      return 'The selected child contact is invalid';
    }
    if (line.id) {
      if (line.id === partnerId || seenIds.has(line.id)) return 'The selected child contact is invalid';
      const existing = byId.get(line.id);
      if (!existing || existing.parent_id !== partnerId) return 'The selected child contact is invalid';
      seenIds.add(line.id);
    }
    const addrType = line.type ?? 'contact';
    if (!VALID_ADDRESS_TYPES.has(addrType)) {
      return ADDRESS_TYPE_ERROR;
    }
    if (addrType === 'contact' && !String(line.name ?? '').trim()) {
      return 'Name is required for contact addresses';
    }
    const countryErr = countryReferenceError(db, line);
    if (countryErr) return countryErr;
    if (line.state_id != null) {
      const st = (db?.records?.['res.country.state'] ?? []).find((s) => s.id === line.state_id);
      if (!st) return 'Selected state does not exist';
      if (line.country_id != null && st.country_id !== line.country_id) return 'Select a state belonging to the selected country';
    }
  }
  return null;
}

/** Synchronize child `res.partner` records from a parent partner's `child_ids` lines. */
export function syncPartnerChildren(db, partnerId, childLines) {
  if (!Array.isArray(childLines)) return db;
  const err = validatePartnerChildLines(db, partnerId, childLines);
  if (err) throw new Error(err);
  const parent = read(db, 'res.partner', partnerId);
  const existingChildren = partnerIndex(db).activeChildrenByParent.get(partnerId) ?? [];
  const lineIds = new Set(childLines.map((l) => l.id).filter(Boolean));
  const valuesOf = (line) => Object.fromEntries(CHILD_LINE_FIELDS.filter((f) => Object.hasOwn(line, f) && line[f] !== undefined).map((f) => [f, line[f]]));
  let next = db;
  const updates = new Map(existingChildren.filter((c) => !lineIds.has(c.id)).map((c) => [c.id, { active: false }]));
  for (const line of childLines) {
    if (line.id) updates.set(line.id, { ...valuesOf(line), active: true });
  }
  if (updates.size) next = writeMany(next, 'res.partner', updates);
  for (const line of childLines) {
    if (!line.id) {
      next = create(next, 'res.partner', {
        ...valuesOf(line),
        parent_id: partnerId,
        is_company: false,
        ...(parent?.company_id != null ? { company_id: parent.company_id } : {}),
        ...(parent?.lang ? { lang: parent.lang } : {}),
        ...(parent?.user_id != null ? { user_id: parent.user_id } : {}),
      }).db;
    }
  }
  return next;
}

export function guardPartner(db, before, after, _ctx, vals) {
  if (after?.type != null && !VALID_ADDRESS_TYPES.has(after.type)) {
    return ADDRESS_TYPE_ERROR;
  }
  if (after?.invoice_sending_method != null && after.invoice_sending_method !== '' && !VALID_INVOICE_SENDING_METHODS.has(after.invoice_sending_method)) {
    return 'Invoice Sending must be Email or Download';
  }
  if (after?.credit_limit != null && after?.credit_limit !== '') {
    const n = Number(after.credit_limit);
    if (!Number.isFinite(n) || n < 0) return 'Credit Limit must be non-negative';
  }
  const countryErr = countryReferenceError(db, after ?? {});
  if (countryErr) return countryErr;
  if (after?.state_id != null) {
    const st = (db?.records?.['res.country.state'] ?? []).find((s) => s.id === after.state_id);
    if (!st) return 'Selected state does not exist';
    if (after.country_id != null && st.country_id !== after.country_id) return 'Select a state belonging to the selected country';
  }
  if (after?.industry_id != null && !(db?.records?.['res.partner.industry'] ?? []).some((i) => i.id === after.industry_id)) {
    return 'Selected industry does not exist';
  }
  if (after?.parent_id != null) {
    const targetId = before?.id ?? after.id;
    const seen = new Set(targetId ? [targetId] : []);
    const { byId } = partnerIndex(db);
    let cur = after.parent_id;
    while (cur) {
      if (seen.has(cur)) return 'Parent contact hierarchy cannot contain a cycle';
      seen.add(cur);
      cur = byId.get(cur)?.parent_id;
    }
  }
  for (const line of after?.followup_lines ?? []) {
    if (line?.followup_next_action_date != null && line.followup_next_action_date !== '' && !validDate(line.followup_next_action_date)) {
      return 'Next reminder date must be a valid date';
    }
  }
  const companyChanged = Boolean(before && (before.company_id ?? null) !== (after?.company_id ?? null));
  const methodFields = !before
    ? null
    : ['property_inbound_payment_method_line_id', 'property_outbound_payment_method_line_id']
        .filter((f) => companyChanged || (before[f] ?? null) !== (after?.[f] ?? null));
  return (methodFields === null || methodFields.length > 0 ? preferredPaymentMethodLineError(db, after, methodFields) : null)
    ?? (vals && !Object.hasOwn(vals, 'bank_ids') ? null : validatePartnerBankLines(db, after?.id, after?.bank_ids))
    ?? (vals && !Object.hasOwn(vals, 'child_ids') ? null : validatePartnerChildLines(db, after?.id, after?.child_ids));
}

export function partnerCategoryCompleteName(db, r) {
  if (!r?.name) return '';
  const names = [r.name];
  const seen = new Set(r.id ? [r.id] : []);
  const find = (key) => (db?.records?.['res.partner.category'] ?? []).find((c) => c.id === key);
  for (let c = find(r.parent_id); c && !seen.has(c.id); c = find(c.parent_id)) {
    seen.add(c.id);
    names.unshift(c.name);
  }
  return names.join(' / ');
}

// Reusable inverse index caches per records snapshot for partner tags and child categories
const categoryPartnerIndexCache = new WeakMap();
export function partnersByCategory(db) {
  if (!db?.records || typeof db.records !== 'object') return new Map();
  let index = categoryPartnerIndexCache.get(db.records);
  if (!index) {
    index = new Map();
    for (const p of db.records['res.partner'] ?? []) {
      const tags = p?.tag_ids;
      if (!tags) continue;
      const list = Array.isArray(tags) ? tags : [tags];
      for (const t of list) {
        const id = typeof t === 'object' && t !== null ? t.id : t;
        if (id != null) {
          const arr = index.get(id);
          if (arr) arr.push(p.id); else index.set(id, [p.id]);
        }
      }
    }
    categoryPartnerIndexCache.set(db.records, index);
  }
  return index;
}

const categoryChildIndexCache = new WeakMap();
export function childrenByCategory(db) {
  if (!db?.records || typeof db.records !== 'object') return new Map();
  let index = categoryChildIndexCache.get(db.records);
  if (!index) {
    index = new Map();
    for (const c of db.records['res.partner.category'] ?? []) {
      if (c?.parent_id != null) {
        const arr = index.get(c.parent_id);
        if (arr) arr.push(c.id); else index.set(c.parent_id, [c.id]);
      }
    }
    categoryChildIndexCache.set(db.records, index);
  }
  return index;
}

export function partnerTagIds(db, names) {
  let currentDb = db;
  const ids = [];
  const list = Array.isArray(names) ? names : names ? [names] : [];
  for (const raw of list) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    const categories = currentDb?.records?.['res.partner.category'] ?? [];
    const existing = categories.find((c) => c.active !== false && String(c.name ?? '').trim().toLowerCase() === lower);
    if (existing) {
      if (!ids.includes(existing.id)) ids.push(existing.id);
    } else {
      const { db: nextDb, id } = create(currentDb, 'res.partner.category', { name: trimmed });
      currentDb = nextDb;
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return { db: currentDb, ids };
}

export function guardPartnerCategory(db, before, r) {
  let id = r.parent_id;
  const targetId = before?.id ?? r.id;
  const seen = new Set(targetId ? [targetId] : []);
  const find = (key) => (db?.records?.['res.partner.category'] ?? []).find((c) => c.id === key);
  while (id) {
    if (seen.has(id)) return 'Category hierarchy cannot contain a cycle';
    seen.add(id);
    id = find(id)?.parent_id;
  }
  return null;
}

/** Mark a commercial partner as a customer or vendor. Sets the rank to 1 only when it is 0 (activity flag), so concurrent postings never write conflicting ranks. */
export function incrementPartnerRank(db, partnerId, field) {
  const id = commercialPartnerId(db, partnerId);
  const partner = id == null ? null : read(db, 'res.partner', id);
  if (!partner || (Number(partner[field]) || 0) > 0) return db;
  return { ...db, records: { ...db.records, 'res.partner': db.records['res.partner'].map((row) => row.id === id ? { ...row, [field]: 1 } : row) } };
}

export function isRotting(db, model, r) {
  if (!r) return false;
  const stageModel = model === 'crm.lead' ? 'crm.stage' : model === 'project.task' ? 'project.task.type' : null;
  if (!stageModel || !r.stage_id) return false;
  const stages = db?.records?.[stageModel] ?? [];
  const stage = typeof r.stage_id === 'number'
    ? stages.find((s) => s.id === r.stage_id)
    : stages.find((s) => s.name?.toLowerCase() === String(r.stage_id).toLowerCase());
  if (!stage || !stage.rotting_threshold_days || stage.rotting_threshold_days <= 0) return false;
  if (stage.is_won || stage.fold || r.active === false || r.state === 'done' || r.state === 'canceled') return false;
  const stageDate = r.date_last_stage_update || r.create_date || r.date_start || today();
  const diffDays = Math.floor((Date.parse(today()) - Date.parse(stageDate)) / (1000 * 60 * 60 * 24));
  return diffDays > stage.rotting_threshold_days;
}

/** First active stage available to the selected team or project, or no stage. */
export function defaultStage(db, stageModel, scopeField, scopeId) {
  return (db.records?.[stageModel] ?? [])
    .filter((stage) => stage.active !== false && (!stage[scopeField]?.length || (scopeId && stage[scopeField].includes(scopeId))))
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.id - b.id)[0]?.id ?? null;
}

export function stageColumnsFor(db, model, context = {}) {
  const stageModel = model === 'crm.lead' ? 'crm.stage' : model === 'project.task' ? 'project.task.type' : null;
  if (!stageModel) return [];
  let stages = db?.records?.[stageModel] ?? [];
  if (model === 'crm.lead' && context.team_id) {
    stages = stages.filter((s) => !s.team_ids?.length || s.team_ids.includes(context.team_id));
  } else if (model === 'project.task' && context.project_id) {
    stages = stages.filter((s) => !s.project_ids?.length || s.project_ids.includes(context.project_id));
  }
  return [...stages].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.id - b.id).map((s) => ({
    key: s.id,
    label: s.name,
    fold: !!s.fold,
    requirements: s.requirements ?? '',
    rotting_threshold_days: s.rotting_threshold_days ?? 0,
    is_won: !!s.is_won,
  }));
}

export function isWonLead(db, r) {
  if (!r) return false;
  if (typeof r.stage_id === 'number') return !!(db?.records?.['crm.stage'] ?? []).find((s) => s.id === r.stage_id)?.is_won;
  if (r.stage_id === 'won') return true;
  if (db?.records?.['crm.stage']) {
    const s = (db.records['crm.stage'] ?? []).find((x) => x.id === r.stage_id || x.name?.toLowerCase() === String(r.stage_id).toLowerCase());
    if (s?.is_won) return true;
  }
  return r.probability === 100;
}

/** Lead → opportunity; creates the customer from the lead's company/contact when none is set. */
export function convertLead(db, r) {
  if (r.partner_id || !(r.partner_name || r.contact_name)) return write(db, 'crm.lead', r.id, { type: 'opportunity' });
  const { db: withPartner, id } = create(db, 'res.partner', { name: r.partner_name || r.contact_name, is_company: !!r.partner_name, email: r.email ?? '', phone: r.phone ?? '', city: r.city ?? '', country: r.country ?? '' });
  return write(withPartner, 'crm.lead', r.id, { type: 'opportunity', partner_id: id });
}

/** Draft quotation for the opportunity's customer, linked back to it. */
function newQuotation(db, r) {
  if (!r.partner_id) throw new Error('Set a customer on the opportunity first');
  const { db: next, id } = create(db, 'sale.order', { partner_id: r.partner_id, opportunity_id: r.id, user: r.user, order_line: [] });
  return { db: next, go: `#/sales/quotations/${id}` };
}

export const crmModels = {
  'crm.stage': {
    label: 'Stages',
    fields: {
      name: { type: 'char', label: 'Stage Name', required: true },
      sequence: { type: 'integer', label: 'Sequence' },
      is_won: { type: 'boolean', label: 'Is Won Stage' },
      fold: { type: 'boolean', label: 'Folded in Pipeline' },
      requirements: { type: 'text', label: 'Requirements' },
      rotting_threshold_days: { type: 'integer', label: 'Rotting Threshold (Days)' },
      team_ids: { type: 'many2many', relation: 'crm.team', label: 'Sales Teams' },
    },
    defaults: (id) => ({ sequence: id ?? 10, is_won: false, fold: false, team_ids: [], rotting_threshold_days: 0 }),
    list: ['name', 'sequence', 'is_won', 'fold', 'rotting_threshold_days'],
    form: {
      title: 'name',
      groups: [
        ['name', 'sequence', 'team_ids'],
        ['is_won', 'fold', 'rotting_threshold_days'],
      ],
      tabs: [{ label: 'Requirements', fields: ['requirements'] }],
    },
  },

  'crm.lost.reason': {
    label: 'Lost Reasons',
    fields: {
      name: { type: 'char', label: 'Reason', required: true },
      active: { type: 'boolean', label: 'Active' },
    },
    defaults: () => ({ active: true }),
    list: ['name', 'active'],
    form: {
      title: 'name',
      groups: [['name', 'active']],
    },
  },

  'res.partner.category': {
    label: 'Contact Tags',
    fields: {
      name: { type: 'char', label: 'Tag Name', required: true },
      color: { type: 'integer', label: 'Color' },
      parent_id: { type: 'many2one', relation: 'res.partner.category', label: 'Parent Category' },
      complete_name: {
        type: 'char',
        label: 'Complete Name',
        compute: (r, db) => partnerCategoryCompleteName(db, r),
      },
      display_name: {
        type: 'char',
        label: 'Complete Name',
        compute: (r, db) => partnerCategoryCompleteName(db, r),
      },
      active: { type: 'boolean', label: 'Active' },
      partner_ids: {
        type: 'many2many',
        relation: 'res.partner',
        label: 'Partners',
        readonly: true,
        compute: (r, db) => [...(partnersByCategory(db).get(r?.id) ?? [])],
      },
      child_ids: {
        type: 'many2many',
        relation: 'res.partner.category',
        label: 'Child Tags',
        readonly: true,
        compute: (r, db) => [...(childrenByCategory(db).get(r?.id) ?? [])],
      },
    },
    defaults: () => ({ active: true, color: 0 }),
    guard: guardPartnerCategory,
    searchFields: ['name', 'complete_name'],
    list: ['display_name', 'color'],
    listLabels: { display_name: 'Tag Name' },
    form: {
      title: 'name',
      groups: [
        ['name', 'parent_id', 'color', 'active'],
      ],
    },
  },

  'res.partner.industry': {
    label: 'Industries',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      full_name: { type: 'char', label: 'Full Name' },
      active: { type: 'boolean', label: 'Active' },
    },
    defaults: () => ({ active: true }),
    searchFields: ['name', 'full_name'],
    list: ['name', 'full_name'],
    form: {
      title: 'name',
      groups: [['name', 'full_name', 'active']],
    },
  },

  'res.partner': {
    label: 'Contacts',
    fields: {
      name: { type: 'char', label: 'Name', required: (r) => !r?.parent_id || (r?.type ?? 'contact') === 'contact' },
      complete_name: { type: 'char', label: 'Complete Name', readonly: true, avatar: true, compute: (r, db) => partnerCompleteName(db, r) },
      customer_rank: { type: 'integer', label: 'Customer Rank', readonly: true },
      supplier_rank: { type: 'integer', label: 'Vendor Rank', readonly: true },
      is_company: { type: 'boolean', label: 'Company' },
      type: { type: 'selection', label: 'Address Type', options: ADDRESS_TYPE_OPTIONS, default: 'contact' },
      parent_id: { type: 'many2one', relation: 'res.partner', label: 'Parent Contact', domain: (p, r) => p.id !== r?.id && !p.parent_id },
      email: { type: 'char', label: 'Email', optional: 'show' },
      phone: { type: 'char', label: 'Phone', optional: 'show' },
      street: { type: 'char', label: 'Street' },
      street2: { type: 'char', label: 'Street 2' },
      city: { type: 'char', label: 'City', optional: 'hide' },
      state: { type: 'char', label: 'State' },
      state_id: { type: 'many2one', relation: 'res.country.state', label: 'State', optional: 'hide', domain: (s, r) => !r?.country_id || s.country_id === r.country_id },
      zip: { type: 'char', label: 'Zip' },
      country: { type: 'char', label: 'Country' },
      country_id: { type: 'many2one', relation: 'res.country', label: 'Country', optional: 'show' },
      vat: { type: 'char', label: 'Tax ID', optional: 'hide' },
      function: { type: 'char', label: 'Job Position', placeholder: 'e.g. Sales Director' },
      website: { type: 'char', label: 'Website', placeholder: 'e.g. https://www.example.com' },
      lang: { type: 'selection', label: 'Language', options: LANGUAGES },
      ref: { type: 'char', label: 'Reference' },
      industry_id: { type: 'many2one', relation: 'res.partner.industry', label: 'Industry' },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company', multiCompanyOnly: true, optional: 'hide', placeholder: 'Visible to all', readonly: (r) => Boolean(r?.parent_id) },
      pricelist_id: { type: 'many2one', relation: 'product.pricelist', label: 'Pricelist' },
      use_partner_credit_limit: { type: 'boolean', label: 'Partner Limit', hideWhen: (_r, db) => !creditLimitEnabled(db) },
      credit_limit: {
        type: 'monetary',
        label: 'Credit Limit',
        hideWhen: (_r, db) => !creditLimitEnabled(db),
        readonly: (r) => !r?.use_partner_credit_limit,
      },
      property_payment_term_id: { type: 'many2one', relation: 'account.payment.term', label: 'Payment Terms' },
      property_inbound_payment_method_line_id: {
        type: 'many2one',
        relation: 'account.payment.method.line',
        label: 'Customer Payment Method',
        domain: (line, r, db) => {
          if (line.active === false || line.payment_type !== 'inbound') return false;
          const compId = r?.company_id ?? db?.settings?.current_company_id ?? 1;
          if (line.company_id && line.company_id !== compId) return false;
          const j = db ? read(db, 'account.journal', line.journal_id) : null;
          return !j || (j.active !== false && isMethodLineJournal(j) && (!j.company_id || j.company_id === compId));
        },
      },
      property_outbound_payment_method_line_id: {
        type: 'many2one',
        relation: 'account.payment.method.line',
        label: 'Vendor Payment Method',
        domain: (line, r, db) => {
          if (line.active === false || line.payment_type !== 'outbound') return false;
          const compId = r?.company_id ?? db?.settings?.current_company_id ?? 1;
          if (line.company_id && line.company_id !== compId) return false;
          const j = db ? read(db, 'account.journal', line.journal_id) : null;
          return !j || (j.active !== false && isMethodLineJournal(j) && (!j.company_id || j.company_id === compId));
        },
      },
      invoice_sending_method: {
        type: 'selection',
        label: 'Invoice Sending',
        options: INVOICE_SENDING_METHODS,
      },
      autopost_bills: { type: 'selection', label: 'Auto-post bills', options: [['always', 'Always'], ['ask', 'Ask after 3 validations without edits'], ['never', 'Never']], default: 'ask', hideWhen: (_r, db) => !read(db, 'res.company', db?.settings?.current_company_id ?? 1)?.autopost_bills },
      property_supplier_payment_term_id: { type: 'many2one', relation: 'account.payment.term', label: 'Supplier Payment Terms' },
      property_account_position_id: { type: 'many2one', relation: 'account.fiscal.position', label: 'Fiscal Position' },
      property_account_receivable_id: { type: 'many2one', relation: 'account.account', label: 'Receivable Account' },
      property_account_payable_id: { type: 'many2one', relation: 'account.account', label: 'Payable Account' },
      user_id: { type: 'many2one', relation: 'hr.employee', label: 'Salesperson', optional: 'hide' },
      total_invoiced: { type: 'monetary', label: 'Total Invoiced', currency: 'company', readonly: true, compute: (r, db) => partnerTotalInvoiced(db, r) },
      account_move_count: { type: 'integer', label: 'Customer Invoices Count', readonly: true, compute: (r, db) => partnerMoveSummary(db, r).customerMoves.length },
      supplier_invoice_count: { type: 'integer', label: 'Vendor Bills', readonly: true, compute: (r, db) => partnerMoveSummary(db, r).supplierMoves.length },
      followup_responsible_id: { type: 'many2one', relation: 'hr.employee', label: 'Follow-up Responsible' },
      followup_reminder_type: { type: 'selection', label: 'Reminders', options: [['automatic', 'Automatic'], ['manual', 'Manual']], default: 'automatic' },
      followup_next_action_date: {
        type: 'date',
        label: 'Next Reminder',
        editable: true,
        compute: (r, db) => r.followup_lines?.find((line) => line.company_id === (db?.settings?.current_company_id ?? 1))?.followup_next_action_date ?? null,
      },
      last_reminder: { type: 'date', label: 'Last Reminder Date', readonly: true, compute: (r, db) => r.followup_lines?.find((line) => line.company_id === (db.settings?.current_company_id ?? 1))?.followup_date ?? null },
      followup_line_id: { type: 'many2one', relation: 'account.followup.level', label: 'Reminder Level', readonly: true, compute: (r, db) => r.followup_lines?.find((line) => line.company_id === (db.settings?.current_company_id ?? 1))?.followup_last_level ?? null },
      followup_status: {
        type: 'selection',
        label: 'Follow-up Status',
        options: [
          ['in_need_of_action', 'In need of action'],
          ['with_overdue_invoices', 'With overdue invoices'],
          ['no_action_needed', 'No action needed'],
        ],
        badge: { in_need_of_action: 'warn', with_overdue_invoices: 'info', no_action_needed: 'ok' },
        hidden: true,
        // Scans every move and payment: evaluated only when a view or filter reads it, not on every partner lookup.
        lazy: true,
        compute: (r, db) => partnerFollowUpStatus(db, r, db?.settings?.current_company_id ?? 1),
      },
      followup_lines: {
        type: 'one2many',
        label: 'Follow-up Progress',
        hidden: true,
        fields: {
          company_id: { type: 'many2one', relation: 'res.company', label: 'Company' },
          followup_level_delay: { type: 'integer', label: 'Last Reminder Level (days)' },
          followup_date: { type: 'date', label: 'Last Reminder' },
          followup_oldest_date: { type: 'date', label: 'Oldest Overdue Date', hidden: true },
          followup_sms_level_delay: { type: 'integer', label: 'SMS Queued for Level (days)', hidden: true },
          followup_sms_oldest_date: { type: 'date', label: 'SMS Queued for Overdue Date', hidden: true },
          followup_level: { type: 'many2one', relation: 'account.followup.level', label: 'Level' },
          followup_last_level: { type: 'many2one', relation: 'account.followup.level', label: 'Level', hidden: true },
          followup_channel: { type: 'char', label: 'Channel', hidden: true },
          followup_delivery_state: { type: 'selection', label: 'Delivery State', options: [['sent', 'Sent'], ['not_sent', 'Not Sent'], ['not_configured', 'Not Configured']], hidden: true },
          followup_delivery_outcome: { type: 'selection', label: 'Delivery Outcome', options: [['sent', 'Sent'], ['outbox_only', 'Outbox Only'], ['failed', 'Failed']], hidden: true },
          followup_next_action_date: { type: 'date', label: 'Next Action Date' },
          followup_status: { type: 'selection', label: 'Status', options: [['in_need_of_action', 'In need of action'], ['with_overdue_invoices', 'With overdue invoices'], ['no_action_needed', 'No action needed']] },
          followup_responsible_id: { type: 'many2one', relation: 'hr.employee', label: 'Follow-up Responsible' },
          no_followup: { type: 'boolean', label: 'Exclude from Follow-ups', hidden: true },
        },
      },
      tag_ids: { type: 'many2many', relation: 'res.partner.category', label: 'Tags', widget: 'many2many_tags', optional: 'hide' },
      child_ids: {
        type: 'one2many',
        relation: 'res.partner',
        label: 'Contacts & Addresses',
        compute: (r, db) => (r?.id ? (partnerIndex(db).activeChildrenByParent.get(r.id) ?? [])
          .map((c) => ({
            id: c.id,
            type: c.type ?? 'contact',
            name: c.name ?? '',
            email: c.email ?? '',
            phone: c.phone ?? '',
            function: c.function ?? '',
            street: c.street ?? '',
            city: c.city ?? '',
            state_id: c.state_id ?? null,
            zip: c.zip ?? '',
            country_id: c.country_id ?? null,
            comment: c.comment ?? '',
          })) : []),
        fields: {
          id: { type: 'integer', label: 'ID', hidden: true, readonly: true },
          type: { type: 'selection', label: 'Address Type', options: ADDRESS_TYPE_OPTIONS },
          name: { type: 'char', label: 'Name' },
          email: { type: 'char', label: 'Email' },
          phone: { type: 'char', label: 'Phone' },
          function: { type: 'char', label: 'Job Position' },
          street: { type: 'char', label: 'Street', optional: 'hide' },
          city: { type: 'char', label: 'City', optional: 'hide' },
          state_id: { type: 'many2one', relation: 'res.country.state', label: 'State', optional: 'hide', domain: (s, r) => !r?.country_id || s.country_id === r.country_id },
          zip: { type: 'char', label: 'Zip', optional: 'hide' },
          country_id: { type: 'many2one', relation: 'res.country', label: 'Country', optional: 'hide' },
          comment: { type: 'text', label: 'Notes', optional: 'hide' },
        },
        newLine: (r) => ({
          type: 'contact',
          name: '',
          email: '',
          phone: '',
          function: '',
          street: r?.street ?? '',
          city: r?.city ?? '',
          state_id: r?.state_id ?? null,
          zip: r?.zip ?? '',
          country_id: r?.country_id ?? null,
          comment: '',
        }),
        onchange: (line, key) => {
          if (key === 'country_id' && line.state_id) return { ...line, state_id: null };
          return line;
        },
      },
      bank_ids: {
        type: 'one2many',
        relation: 'res.partner.bank',
        label: 'Bank Accounts',
        compute: (r, db) => (r?.id ? (banksByPartner(db).get(r.id) ?? []).map((b) => read(db, 'res.partner.bank', b.id)) : []),
        fields: {
          account_number: { type: 'char', label: 'Account Number', required: true },
          bank_id: { type: 'many2one', relation: 'res.bank', label: 'Bank' },
          bank_name: {
            type: 'char',
            label: 'Bank Name',
            placeholder: 'e.g. Bank of America',
            readonly: (r) => Boolean(r?.bank_id),
          },
          bank_bic: {
            type: 'char',
            label: 'BIC/SWIFT',
            readonly: (r) => Boolean(r?.bank_id),
          },
          holder_name: { type: 'char', label: 'Holder Name' },
          allow_out_payment: { type: 'boolean', label: 'Trust Bank Account', widget: 'toggle' },
        },
        newLine: () => ({ account_number: '', bank_id: null, bank_name: '', bank_bic: '', allow_out_payment: false }),
        onchange: (line, key, db) => {
          if (key === 'bank_id') {
            const bank = line.bank_id && db ? read(db, 'res.bank', line.bank_id) : null;
            return bank
              ? { ...line, bank_name: bank.name ?? '', bank_bic: bank.bic ?? '' }
              : { ...line, bank_name: '', bank_bic: '' };
          }
          return line;
        },
      },
    },
    defaults: () => ({ tag_ids: [], customer_rank: 0, supplier_rank: 0, type: 'contact', followup_reminder_type: 'automatic', autopost_bills: 'ask' }),
    onchange: (r, key, db) => {
      if (key === 'use_partner_credit_limit') {
        const comp = db ? read(db, 'res.company', db.settings?.current_company_id ?? 1) : null;
        return { credit_limit: r.use_partner_credit_limit ? (comp?.account_default_credit_limit ?? 0) : null };
      }
      if (key === 'followup_next_action_date') {
        const cId = db?.settings?.current_company_id ?? 1;
        return {
          followup_lines: updatePartnerFollowUp(r, cId, {
            followup_next_action_date: r.followup_next_action_date || null,
          }).followup_lines,
        };
      }
      if (key === 'country_id') {
        const countryRec = r.country_id && db ? read(db, 'res.country', r.country_id) : null;
        const curState = r.state_id && db ? read(db, 'res.country.state', r.state_id) : null;
        const clearState = !r.country_id
          ? Boolean(r.state_id || r.state)
          : Boolean(curState && curState.country_id !== r.country_id);
        return {
          country: countryRec?.name ?? '',
          ...(clearState ? { state_id: null, state: '' } : {}),
        };
      }
      if (key === 'state_id') {
        const st = r.state_id && db ? read(db, 'res.country.state', r.state_id) : null;
        const out = { state: st?.name ?? '' };
        if (st && !r.country_id && db) {
          out.country_id = st.country_id;
          out.country = read(db, 'res.country', st.country_id)?.name ?? '';
        }
        return out;
      }
      if (key === 'parent_id' && r.parent_id && db) {
        const parent = read(db, 'res.partner', r.parent_id);
        if (parent?.company_id != null) return { company_id: parent.company_id };
      }
      return {};
    },
    prepareWrite: (db, vals, before) => {
      let nextVals = normalizePartnerVals(db, vals, before);
      if (nextVals?.use_partner_credit_limit === false && nextVals.credit_limit !== null) {
        nextVals = { ...nextVals, credit_limit: null };
      }
      if (nextVals && 'followup_next_action_date' in nextVals) {
        const cId = db?.settings?.current_company_id ?? 1;
        const base = { ...before, ...nextVals };
        const nextPartner = updatePartnerFollowUp(base, cId, {
          followup_next_action_date: vals.followup_next_action_date || null,
        });
        return { db, vals: { ...nextVals, followup_lines: nextPartner.followup_lines } };
      }
      return { db, vals: nextVals };
    },
    prepareCreate: (db, vals) => {
      let nextVals = normalizePartnerVals(db, vals);
      if (nextVals && !nextVals.use_partner_credit_limit && 'credit_limit' in nextVals) {
        const { credit_limit: _cl, ...rest } = nextVals;
        nextVals = rest;
      }
      if (nextVals && 'followup_next_action_date' in nextVals) {
        const cId = db?.settings?.current_company_id ?? 1;
        const nextPartner = updatePartnerFollowUp(nextVals, cId, {
          followup_next_action_date: nextVals.followup_next_action_date || null,
        });
        return { db, vals: { ...nextVals, followup_lines: nextPartner.followup_lines } };
      }
      return { db, vals: nextVals };
    },
    guard: guardPartner,
    onWrite: (db, after, before, vals) => {
      let next = syncPartnerBankAccounts(db, after.id, vals?.bank_ids);
      next = syncPartnerChildren(next, after.id, vals?.child_ids);
      const rawPartner = (next.records?.['res.partner'] ?? []).find((p) => p.id === after.id);
      if (rawPartner && (Object.hasOwn(rawPartner, 'bank_ids') || Object.hasOwn(rawPartner, 'child_ids'))) {
        next = {
          ...next,
          records: {
            ...next.records,
            'res.partner': next.records['res.partner'].map((p) => {
              if (p.id !== after.id) return p;
              const { bank_ids: _b, child_ids: _c, ...rest } = p;
              return rest;
            }),
          },
        };
      }
      if (before && (before.company_id ?? null) !== (after.company_id ?? null)) {
        const childUpdates = new Map(
          (partnerIndex(next).childrenByParent.get(after.id) ?? [])
            .filter((p) => (p.company_id ?? null) !== (after.company_id ?? null))
            .map((p) => [p.id, { company_id: after.company_id ?? null }]),
        );
        if (childUpdates.size) next = writeMany(next, 'res.partner', childUpdates);
      }
      return next;
    },
    filters: [[
      { id: 'customers', label: 'Customers', fn: (r) => (r.customer_rank ?? 0) > 0 },
      { id: 'vendors', label: 'Vendors', fn: (r) => (r.supplier_rank ?? 0) > 0 },
      { id: 'companies', label: 'Companies', fn: (r) => r.is_company },
      { id: 'individuals', label: 'Individuals', fn: (r) => !r.is_company },
    ], [
      { id: 'in_need_of_action', label: 'In need of action', fn: (r, db) => partnerFollowUpStatus(db, r) === 'in_need_of_action' },
      { id: 'overdue_invoices', label: 'With overdue invoices', fn: (r, db) => ['in_need_of_action', 'with_overdue_invoices'].includes(partnerFollowUpStatus(db, r)) },
      { id: 'postponed', label: 'Postponed', fn: (r, db) => isPartnerFollowUpPostponed(db, r) },
    ]],
    groupBys: ['country_id', 'user_id', 'parent_id', 'city', 'is_company'],
    kanban: { title: 'name', lines: ['email', 'city', 'country_id'], tags: 'tag_ids', avatar: true },
    list: ['complete_name', 'email', 'phone', 'user_id', 'city', 'state_id', 'country_id', 'vat', 'tag_ids', 'company_id'],
    listLabels: { complete_name: 'Name' },
    form: {
      title: 'name',
      prepare: (r, db) => (!r?.use_partner_credit_limit && creditLimitEnabled(db) ? { ...r, credit_limit: read(db, 'res.company', db?.settings?.current_company_id ?? 1)?.account_default_credit_limit ?? 0 } : r),
      smart: [
        { label: 'Opportunities', model: 'crm.lead', field: 'partner_id', target: 'crm/pipeline' },
        { label: 'Sales', model: 'sale.order', field: 'partner_id', target: 'sales/quotations' },
        {
          label: 'Invoiced',
          app: 'accounting',
          valueField: 'total_invoiced',
          value: (db, r) => partnerTotalInvoiced(db, r),
          target: (r, db) => partnerMoveTarget('accounting/invoices', 'accounting/credit-notes', 'out_invoice', partnerCustomerInvoices(db, r), r),
        },
        {
          label: 'Vendor Bills',
          app: 'accounting',
          when: (r, db) => partnerSupplierBills(db, r).length > 0,
          value: (db, r) => partnerSupplierBills(db, r).length,
          target: (r, db) => partnerMoveTarget('accounting/bills', 'accounting/refunds', 'in_invoice', partnerSupplierBills(db, r), r),
        },
      ],
      buttons: [{
        label: 'Send Follow-up',
        app: 'accounting',
        when: (_r, db, user) => appOpen(db, user, 'accounting'),
        visible: (_r, db, user) => appOpen(db, user, 'accounting'),
        run: (db, r) => ({ db, go: `#/followup/send/${r.id}?company=${db.settings?.current_company_id ?? 1}` }),
      }, { label: 'WhatsApp', server: '/api/integrations/whatsapp', requires: 'whatsapp', when: (r) => r.phone, run: (db, r) => { window.open(`https://wa.me/${String(r.phone).replace(/[^\d]/g, '')}`, '_blank', 'noopener'); return { db }; } }],
      groups: [
        ['is_company', 'parent_id', 'email', 'phone', 'vat', 'function', 'website', 'lang'],
        ['street', 'street2', 'city', 'state_id', 'zip', 'country_id', 'tag_ids', 'credit_limit'],
      ],
      tabs: [
        {
          label: 'Accounting',
          fields: ['autopost_bills', 'property_account_position_id', 'property_payment_term_id', 'property_supplier_payment_term_id', 'property_account_receivable_id', 'property_account_payable_id', 'followup_responsible_id', 'followup_reminder_type', 'followup_next_action_date', 'last_reminder', 'followup_line_id'],
          groups: [
            { title: 'Customer Invoices', fields: [{ field: 'property_inbound_payment_method_line_id', label: 'Preferred Payment Method' }, 'invoice_sending_method'] },
            { title: 'Vendor Bills', fields: [{ field: 'property_outbound_payment_method_line_id', label: 'Preferred Payment Method' }] },
            ['use_partner_credit_limit'],
          ],
        },
        { label: 'Bank Accounts', fields: ['bank_ids'] },
        { label: 'Contacts & Addresses', fields: ['child_ids'] },
        {
          label: 'Sales & Purchase',
          groups: [
            { title: 'Sales', fields: ['user_id', 'property_payment_term_id', 'pricelist_id'] },
            { title: 'Purchase', fields: ['property_supplier_payment_term_id'] },
            { title: 'Misc', fields: ['ref', 'company_id', 'industry_id'] },
          ],
        },
      ],
      chatter: true,
    },
  },

  'crm.lead': {
    label: 'Pipeline',
    fields: {
      name: { type: 'char', label: 'Opportunity', required: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Contact' },
      email: { type: 'char', label: 'Email' },
      phone: { type: 'char', label: 'Phone' },
      expected_revenue: { type: 'monetary', label: 'Expected Revenue' },
      probability: { type: 'float', label: 'Probability (%)' },
      automated_probability: { type: 'float', label: 'Automated Probability (%)', readonly: true },
      team_id: { type: 'many2one', relation: 'crm.team', label: 'Sales Team' },
      assign_date: { type: 'date', label: 'Assigned on', readonly: true },
      stage_id: {
        type: 'many2one',
        relation: 'crm.stage',
        label: 'Stage',
        tracking: true,
      },
      lost_reason_id: {
        type: 'many2one',
        relation: 'crm.lost.reason',
        label: 'Lost Reason',
      },
      lost_feedback: {
        type: 'text',
        label: 'Closing Note',
      },
      date_last_stage_update: {
        type: 'date',
        label: 'Last Stage Update',
        readonly: true,
      },
      is_rotting: {
        type: 'boolean',
        label: 'Rotting',
        compute: (r, db) => isRotting(db, 'crm.lead', r),
      },
      is_won_stage: { type: 'boolean', label: 'Is Won Stage', hidden: true, compute: (r, db) => isWonLead(db, r) },
      user: { type: 'char', label: 'Salesperson' },
      date_deadline: { type: 'date', label: 'Expected Closing' },
      create_date: { type: 'date', label: 'Created on', readonly: true },
      priority: { type: 'priority', label: 'Priority' },
      tag_ids: { type: 'tags', label: 'Tags' },
      description: { type: 'text', label: 'Notes' },
      type: { type: 'selection', label: 'Type', options: [['lead', 'Lead'], ['opportunity', 'Opportunity']] },
      lost_reason: { type: 'char', label: 'Lost Reason (Legacy)', hidden: true },
      partner_name: { type: 'char', label: 'Company Name' },
      contact_name: { type: 'char', label: 'Contact Name' },
      website: { type: 'char', label: 'Website' },
      street: { type: 'char', label: 'Street' },
      city: { type: 'char', label: 'City' },
      country: { type: 'char', label: 'Country' },
      campaign_id: { type: 'many2one', relation: 'marketing.campaign', label: 'Campaign' },
      medium: { type: 'selection', label: 'Medium', options: [['email', 'Email'], ['phone', 'Phone'], ['website', 'Website'], ['social', 'Social Media'], ['referral', 'Referral']] },
      source: { type: 'char', label: 'Source' },
    },
    onchange: (r, key, db) => {
      if (key === 'stage_id') {
        const stage = typeof r.stage_id === 'number'
          ? (db.records['crm.stage'] ?? []).find((s) => s.id === r.stage_id)
          : (db.records['crm.stage'] ?? []).find((s) => s.name?.toLowerCase() === String(r.stage_id).toLowerCase());
        const won = stage?.is_won || r.stage_id === 'won';
        const legacyProbs = { new: 10, qualified: 30, proposition: 60, won: 100, 1: 10, 2: 30, 3: 60 };
        return {
          date_last_stage_update: today(),
          probability: won ? 100 : (legacyProbs[r.stage_id] ?? r.probability),
        };
      }
      if (key !== 'partner_id' || !r.partner_id) return {};
      const p = (db.records['res.partner'] ?? []).find((x) => x.id === r.partner_id);
      return p ? { email: r.email || p.email || '', phone: r.phone || p.phone || '' } : {};
    },
    defaults: () => ({ type: 'opportunity', probability: 10, user: 'Admin', priority: 0, tag_ids: [], create_date: today(), date_last_stage_update: today() }),
    createDefaults: (db, vals) => ({ stage_id: defaultStage(db, 'crm.stage', 'team_ids', vals.team_id) }),
    filters: [
      [{ id: 'mine', label: 'My Pipeline', fn: (r) => r.user === 'Admin' }, { id: 'unassigned', label: 'Unassigned', fn: (r) => !r.user }],
      [
        { id: 'won', label: 'Won', fn: (r) => r.is_won_stage },
        { id: 'ongoing', label: 'Ongoing', fn: (r) => r.active !== false && !r.is_won_stage },
        { id: 'overdue', label: 'Overdue', fn: (r) => r.active !== false && r.date_deadline && r.date_deadline < today() },
        { id: 'rotting', label: 'Rotting', fn: (r) => !!r.is_rotting },
      ],
      [
        { id: 'lost', label: 'Lost', fn: (r) => r.active === false && !!r.lost_reason_id },
      ],
    ],
    groupBys: ['stage_id', 'user', 'partner_id', 'lost_reason_id', 'medium', 'date_deadline', 'create_date'],
    kanban: {
      groupBy: 'stage_id',
      title: 'name',
      lines: ['expected_revenue', 'partner_id'],
      tags: 'tag_ids',
      priority: 'priority',
      badge: 'user',
      sum: 'expected_revenue',
      quickCreate: true,
    },
    list: ['name', 'partner_id', 'email', 'user', 'expected_revenue', 'stage_id'],
    graph: { groupBy: 'stage_id', measure: 'expected_revenue' },
    pivot: { row: 'create_date', col: 'stage_id', measure: 'expected_revenue' },
    calendar: { date: 'date_deadline' },
    views: ['kanban', 'list', 'graph', 'pivot', 'calendar'],
    form: {
      statusbar: 'stage_id',
      statusbarClickable: true,
      buttons: [
        { label: 'Convert to Opportunity', primary: true, when: (r) => r.type === 'lead', run: (db, r) => ({ db: convertLead(db, r) }) },
        { label: 'New Quotation', primary: true, when: (r) => r.type !== 'lead' && r.active !== false, run: newQuotation },
        {
          label: 'Won',
          primary: true,
          when: (r, db) => r.type !== 'lead' && !isWonLead(db, r) && r.active !== false,
          run: (db, r) => {
            const stages = db.records['crm.stage'] ?? [];
            const wonStage = stages.find((s) => s.is_won && (!s.team_ids?.length || (r.team_id && s.team_ids.includes(r.team_id))))
              ?? stages.find((s) => s.is_won);
            if (!wonStage) throw new Error('Configure a won stage first');
            return { db: write(db, 'crm.lead', r.id, { stage_id: wonStage.id, probability: 100, date_last_stage_update: today() }) };
          },
        },
        {
          label: 'Lost',
          when: (r) => r.active !== false,
          wizard: () => ({
            title: 'Lost Reason',
            fields: [
              { name: 'lost_reason_id', type: 'many2one', relation: 'crm.lost.reason', label: 'Lost Reason', required: true, domain: (x) => x.active !== false },
              { name: 'lost_feedback', type: 'text', label: 'Closing Note' },
            ],
          }),
          run: (db, r, v = {}) => {
            const reasonId = Number(v.lost_reason_id);
            if (!reasonId) throw new Error('Choose a lost reason');
            return {
              db: write(db, 'crm.lead', r.id, {
                active: false,
                probability: 0,
                lost_reason_id: reasonId,
                lost_feedback: v.lost_feedback ?? '',
              }),
            };
          },
        },
        { label: 'Restore', vals: { active: true, lost_reason_id: null, lost_feedback: '' }, when: (r) => r.active === false },
      ],
      ribbon: (r, db) => (r.active === false ? 'Lost' : isWonLead(db, r) ? 'Won' : null),
      smart: [{ label: 'Quotations', model: 'sale.order', field: 'opportunity_id', target: 'sales/quotations', sum: 'amount_total' }],
      title: 'name',
      groups: [
        ['expected_revenue', 'probability', 'automated_probability', 'partner_id', 'email', 'phone'],
        ['team_id', 'user', 'date_deadline', 'priority', 'tag_ids'],
      ],
      tabs: [
        { label: 'Notes', fields: ['description'] },
        { label: 'Extra Info', fields: ['partner_name', 'contact_name', 'website', 'street', 'city', 'country', 'campaign_id', 'medium', 'source', 'lost_reason_id', 'lost_feedback', 'date_last_stage_update'] },
      ],
      chatter: true,
    },
  },
};
