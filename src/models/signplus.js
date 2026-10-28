// Signature templates, evidence, workspaces and scoped document sharing.
import { create, read, search, write, postNote } from '../orm.js';
import { today, addDays } from './common.js';
import { extraModels, applySignature, nextSigner } from './extra.js';

const token = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
const roles = [['customer', 'Customer'], ['employee', 'Employee'], ['company', 'Company']];
const relation = (model, label) => ({ type: 'many2one', relation: model, label });
const lines = (label, fields, newLine) => ({ type: 'one2many', label, fields, newLine });

/**
 * Turn plain-text document tags (older data) into tag lines, creating the missing documents.tag records. The server
 * only accepts tag lines, so documents still holding text tags could not be saved at all.
 */
export function migrateDocumentTags(db) {
  const docs = db?.records?.['documents.document'] ?? [];
  if (!docs.some((d) => (d.tag_ids ?? []).some((t) => typeof t === 'string'))) return db;
  const tags = [...(db.records['documents.tag'] ?? [])];
  let seq = Math.max(db.seq?.['documents.tag'] ?? 0, ...tags.map((t) => t.id));
  const tagFor = (name) => tags.find((t) => t.name === name) ?? (tags.push({ id: ++seq, name, facet: '' }), tags.at(-1));
  const documents = docs.map((d) => (!(d.tag_ids ?? []).some((t) => typeof t === 'string') ? d : {
    ...d, tag_ids: d.tag_ids.map((t) => (typeof t === 'string' ? { tag_id: tagFor(t).id, name: t } : t)),
  }));
  return { ...db, records: { ...db.records, 'documents.document': documents, 'documents.tag': tags }, seq: { ...db.seq, 'documents.tag': seq } };
}
export const signersOf = (r) => r.signer_ids?.length ? r.signer_ids : [{ partner_id: r.partner_id, role: 'signer', signed: r.state === 'signed', signature: r.signature, sign_date: r.sign_date, token: r.token }];
const validDate = (date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
const requireDate = (date) => { if (!validDate(date)) throw new Error('Enter a valid ISO date (YYYY-MM-DD)'); };
const current = (db, r) => {
  const found = read(db, 'sign.request', r.id);
  if (!found) throw new Error('Signature request not found');
  return found;
};
const requireFolder = (db, id) => { if (id != null && !read(db, 'documents.folder', id)) throw new Error('Folder not found'); };
const document = (db, id) => {
  const found = read(db, 'documents.document', id);
  if (!found) throw new Error('Document not found');
  return found;
};

// Synchronous SHA-256 keeps certificate generation compatible with the browser registry.
function hash(value) {
  const bytes = new TextEncoder().encode(value);
  const data = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  data.set(bytes);
  data[bytes.length] = 128;
  const view = new DataView(data.buffer);
  view.setUint32(data.length - 4, bytes.length * 8);
  const primes = [];
  for (let n = 2; primes.length < 64; n++) if (!primes.some((p) => n % p === 0)) primes.push(n);
  const h = primes.slice(0, 8).map((p) => (Math.sqrt(p) % 1 * 2 ** 32) | 0);
  const k = primes.map((p) => (Math.cbrt(p) % 1 * 2 ** 32) | 0);
  const rotate = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < data.length; offset += 64) {
    const w = Array.from({ length: 64 }, (_, i) => i < 16 ? view.getInt32(offset + i * 4) : 0);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      w[i] = (w[i - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + w[i - 7] + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) | 0;
    }
    let [a, b, c, d, e, f, g, z] = h;
    for (let i = 0; i < 64; i++) {
      const t = (z + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i]) | 0;
      const u = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      [a, b, c, d, e, f, g, z] = [(t + u) | 0, a, b, c, (d + t) | 0, e, f, g];
    }
    [a, b, c, d, e, f, g, z].forEach((v, i) => { h[i] = (h[i] + v) | 0; });
  }
  return h.map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

/** Create a draft with one tokenized signer per template role. */
export function requestFromTemplate(db, templateId, { signers = [], deadline } = {}) {
  const template = read(db, 'sign.template', templateId);
  if (!template || template.active === false) throw new Error('Select an active signature template');
  if (deadline) requireDate(deadline);
  const signer_ids = [...new Set((template.item_ids ?? []).map((i) => i.role))].map((role) => {
    const matches = signers.filter((s) => s.role === role);
    if (matches.length !== 1 || !read(db, 'res.partner', matches[0].partner_id)) throw new Error(`Select one partner for role ${role}`);
    return { role, partner_id: matches[0].partner_id, signed: false, token: token() };
  });
  if (!signer_ids.length) throw new Error('Add template items with signing roles');
  return create(db, 'sign.request', { name: template.name, template_id: templateId, attachment: template.attachment, item_ids: (template.item_ids ?? []).map((i) => ({ ...i })), partner_id: signer_ids[0].partner_id, signer_ids, ...(deadline ? { deadline } : {}) });
}

function eligible(db, request, index) {
  const r = current(db, request);
  if (r.state !== 'sent') throw new Error('Send the document before signing or refusing');
  if (r.deadline && r.deadline < today()) throw new Error('This signature request has expired');
  const signer = signersOf(r)[index];
  if (!Number.isInteger(index) || !signer || signer.signed) throw new Error('Select an unsigned signer');
  return r;
}

/** Validate indexed role fields and record a sequential or parallel signature. */
export function signFields(db, request, signerIndex, values = {}, typedName = null) {
  const r = eligible(db, request, signerIndex);
  if (r.signing_order !== false && nextSigner(r) !== signerIndex) throw new Error('Wait for the next signer in signing order');
  const signers = signersOf(r), signer = signers[signerIndex];
  const items = r.item_ids ?? read(db, 'sign.template', r.template_id)?.item_ids ?? [];
  const entries = Array.isArray(values) ? values : Object.entries(values).map(([item_index, value]) => ({ item_index: Number(item_index), value }));
  if (entries.some((v) => !Number.isInteger(v.item_index) || !items[v.item_index] || items[v.item_index].role !== signer.role) || new Set(entries.map((v) => v.item_index)).size !== entries.length) throw new Error('Select distinct fields belonging to this signer');
  const stored = (r.field_values ?? []).filter((v) => v.signer_index === signerIndex);
  const fields = items.flatMap((item, item_index) => {
    if (item.role !== signer.role) return [];
    const value = entries.find((v) => v.item_index === item_index)?.value ?? stored.find((v) => v.item_index === item_index)?.value;
    const empty = value == null || (typeof value === 'string' && !value.trim());
    if (item.required && empty) throw new Error(`Required field ${item_index + 1} is missing`);
    if (!empty && item.type === 'date' && !validDate(value)) throw new Error('Enter a valid ISO date (YYYY-MM-DD)');
    if (!empty && item.type === 'email' && (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) throw new Error('Enter a valid email address');
    if (!empty && item.type === 'checkbox' && typeof value !== 'boolean') throw new Error('Checkbox values must be boolean');
    if (!empty && item.type !== 'checkbox' && typeof value !== 'string') throw new Error('Enter a text field value');
    return empty ? [] : [{ signer_index: signerIndex, item_index, value }];
  });
  const name = fields.find((v) => ['signature', 'name'].includes(items[v.item_index].type))?.value ?? typedName ?? read(db, 'res.partner', signer.partner_id)?.name;
  if (!name?.trim()) throw new Error('Enter the signer name');
  const order = [signerIndex, ...signers.map((_, i) => i).filter((i) => i !== signerIndex)];
  const next = applySignature(db, { ...r, signer_ids: order.map((i) => signers[i]) }, name);
  const signed = read(next, 'sign.request', r.id);
  const signer_ids = signers.map((_, i) => signed.signer_ids[order.indexOf(i)]);
  return write(next, 'sign.request', r.id, { signer_ids, field_values: [...(r.field_values ?? []).filter((v) => v.signer_index !== signerIndex), ...fields], ...(signed.state === 'signed' ? { signature: signer_ids.map((s) => s.signature).join(', ') } : {}) });
}

/** Refuse a sent request with a reason and chatter evidence. */
export function refuse(db, request, signerIndex, reason) {
  const r = eligible(db, request, signerIndex);
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('Enter a refusal reason');
  return postNote(write(db, 'sign.request', r.id, { state: 'refused', refusal_reason: reason.trim() }), 'sign.request', r.id, `Signer ${signerIndex + 1} refused: ${reason.trim()}`);
}

/** Return unfinished sent requests whose reminder interval elapsed. */
export function dueReminders(db, date) {
  requireDate(date);
  return search(db, 'sign.request').filter((r) => r.state === 'sent' && signersOf(r).some((s) => !s.signed) && (!r.deadline || r.deadline >= date) && Number.isInteger(r.reminder_days) && r.reminder_days > 0 && (r.last_reminder_date || r.sent_date) && addDays(r.last_reminder_date || r.sent_date, r.reminder_days) <= date);
}

/** Stamp all due reminders and post a note for each request. */
export function sendReminders(db, date) {
  return dueReminders(db, date).reduce((next, r) => postNote(write(next, 'sign.request', r.id, { last_reminder_date: date }), 'sign.request', r.id, `Signature reminder sent on ${date}`), db);
}

/** Expire sent requests strictly after their deadline. */
export function expireRequests(db, date) {
  requireDate(date);
  return search(db, 'sign.request').filter((r) => r.state === 'sent' && r.deadline && r.deadline < date).reduce((next, r) => write(next, 'sign.request', r.id, { state: 'expired' }), db);
}

/** Return a signer's private signing path. */
export function signingLink(request, signerIndex) {
  const value = signersOf(request)[signerIndex]?.token;
  if (!value) throw new Error('Send the request to generate a signing token');
  return `/sign/${request.id}/${value}`;
}

/** Compare fixed-size token digests without a prefix-dependent early exit. */
export function verifyToken(request, signerIndex, value) {
  const expected = signersOf(request)[signerIndex]?.token;
  if (!expected || typeof value !== 'string') return false;
  const a = hash(expected), b = hash(value);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/** Produce a certificate without exposing access tokens. */
export function certificate(db, request) {
  const r = current(db, request), signers = signersOf(r);
  return { name: r.name, signers: signers.map((s) => ({ name: read(db, 'res.partner', s.partner_id)?.name ?? s.signature ?? '', signed_on: s.sign_date ?? null, token_hash: s.token ? hash(s.token).slice(0, 8) : null })), completed: r.state === 'signed' && signers.every((s) => s.signed) };
}

/** Move an unlocked document into a workspace. */
export function moveToFolder(db, docId, folderId) {
  if (document(db, docId).locked) throw new Error('Unlock the document before moving it');
  requireFolder(db, folderId);
  return write(db, 'documents.document', docId, { folder_id: folderId });
}

/** Lock a document for an explicit user identity. */
export function lockDocument(db, docId, userId) {
  const d = document(db, docId);
  if (!userId) throw new Error('Select the locking user');
  if (d.locked && d.locked_by !== userId) throw new Error('This document is locked by another user');
  return write(db, 'documents.document', docId, { locked: true, locked_by: userId });
}

/** Only the locker may unlock a document. */
export function unlockDocument(db, docId, userId) {
  const d = document(db, docId);
  if (d.locked && (!userId || d.locked_by !== userId)) throw new Error('Only the locker may unlock this document');
  return write(db, 'documents.document', docId, { locked: false, locked_by: null });
}

/** Share a folder tree or an explicit set of documents. */
export function createShare(db, { folderId, documentIds, expiration, canUpload = false }) {
  if ((folderId != null) === (documentIds != null)) throw new Error('Select either a folder or documents to share');
  requireFolder(db, folderId);
  if (documentIds != null && (!Array.isArray(documentIds) || !documentIds.length)) throw new Error('Select documents to share');
  for (const id of documentIds ?? []) document(db, id);
  if (expiration) requireDate(expiration);
  const value = token();
  const result = create(db, 'documents.share', { name: folderId != null ? read(db, 'documents.folder', folderId).name : 'Shared Documents', folder_id: folderId ?? null, document_ids: [...new Set(documentIds ?? [])].map((document_id) => ({ document_id })), token: value, expiration, can_upload: !!canUpload });
  return { ...result, token: value };
}

/** Resolve an unexpired share, including all descendant folders. */
export function shareDocuments(db, value, date) {
  requireDate(date);
  const share = typeof value === 'string' && value && search(db, 'documents.share').find((s) => s.token === value);
  if (!share || (share.expiration && share.expiration < date)) throw new Error('This share link is invalid or expired');
  if (!share.folder_id) return (share.document_ids ?? []).map((l) => read(db, 'documents.document', l.document_id)).filter(Boolean);
  requireFolder(db, share.folder_id);
  const folders = new Set([share.folder_id]), all = search(db, 'documents.folder');
  let size;
  do { size = folders.size; all.filter((f) => folders.has(f.parent_id)).forEach((f) => folders.add(f.id)); } while (folders.size !== size);
  return search(db, 'documents.document').filter((d) => folders.has(d.folder_id));
}

/** Request an upload from a contact in a workspace. */
export function requestDocument(db, { partnerId, name, folderId, deadline }) {
  if (!read(db, 'res.partner', partnerId)) throw new Error('Select a contact for the document request');
  requireFolder(db, folderId);
  if (deadline) requireDate(deadline);
  return create(db, 'documents.document', { name, partner_id: partnerId, folder_id: folderId, request_deadline: deadline, is_request: true });
}

/** Fulfill an unlocked pending request with an uploaded file. */
export function fulfillRequest(db, docId, file) {
  const d = document(db, docId);
  if (!d.is_request) throw new Error('This document is not a pending request');
  if (d.locked) throw new Error('Unlock the document before uploading');
  if (!file) throw new Error('Upload a file to fulfill this request');
  return write(db, 'documents.document', docId, { file, is_request: false });
}

const baseSign = extraModels['sign.request'], baseDocument = extraModels['documents.document'];
const items = lines('Items', {
  type: { type: 'selection', label: 'Type', options: ['signature', 'initial', 'text', 'date', 'checkbox', 'name', 'email'].map((t) => [t, t]) },
  role: { type: 'selection', label: 'Role', options: roles }, page: { type: 'integer', label: 'Page' }, required: { type: 'boolean', label: 'Required' },
}, () => ({ type: 'signature', role: 'customer', page: 1, required: true }));

/** Draft → sent: every signer gets a private token. Signers sign through their link (see server/signing.js). */
export function sendRequest(db, request) {
  const r = current(db, request);
  if (r.state !== 'draft') throw new Error('Only draft requests may be sent');
  if (r.deadline && r.deadline < today()) throw new Error('Set a future signature deadline');
  const signer_ids = signersOf(r).map((s) => {
    if (!read(db, 'res.partner', s.partner_id)) throw new Error('Select a partner for every signer');
    return { ...s, token: s.token || token() };
  });
  return { db: write(db, 'sign.request', r.id, { state: 'sent', sent_date: today(), signer_ids }) };
}

// Staff sign here only for the company; customers and employees sign through their own link.
// With sequential signing it is the company's turn only when it is the next signer; otherwise any unsigned company signer may sign.
const companyIndex = (r) => {
  if (r.state !== 'sent') return -1;
  if (r.signing_order === false) return signersOf(r).findIndex((s) => s.role === 'company' && !s.signed);
  const next = nextSigner(r);
  return signersOf(r)[next]?.role === 'company' ? next : -1;
};
const companyTurn = (r) => companyIndex(r) >= 0;

/** Each unsigned signer's private link, to share by hand when email is not configured. */
function showLinks(db, r) {
  const origin = globalThis.location?.origin ?? '';
  const links = signersOf(r).map((s, i) => (s.signed || !s.token ? null : `${read(db, 'res.partner', s.partner_id)?.name ?? `Signer ${i + 1}`}: ${origin}${signingLink(r, i)}`)).filter(Boolean);
  prompt('Signing links: give each signer only their own link', links.join('  |  '));
  return { db };
}

const OWN_LINK = 'Customers and employees sign or refuse through their own signing link';

function signPrompt(db, r) {
  const index = companyIndex(r);
  if (index < 0) throw new Error(OWN_LINK);
  const name = prompt('Type your full name to sign for the company', '');
  if (name == null || !name.trim()) return { db };
  const values = {}, templateItems = r.item_ids ?? read(db, 'sign.template', r.template_id)?.item_ids ?? [];
  for (const [i, item] of templateItems.entries()) {
    if (item.role !== signersOf(r)[index]?.role) continue;
    const value = ['signature', 'name'].includes(item.type) ? name : prompt(`Enter ${item.type} for field ${i + 1}${item.type === 'checkbox' ? ' (true/false)' : ''}`, '');
    if (value == null) return { db };
    values[i] = item.type === 'checkbox' ? value === 'true' ? true : value === 'false' ? false : value : value;
  }
  return { db: templateItems.length ? signFields(db, r, index, values) : applySignature(db, current(db, r), name, today(), index) };
}

export const signPlusModels = {
  'sign.template': {
    label: 'Templates',
    fields: { name: { type: 'char', label: 'Name', required: true }, attachment: { type: 'binary', label: 'Attachment' }, item_ids: items, active: { type: 'boolean', label: 'Active' }, tag_ids: lines('Tags', { tag_id: relation('documents.tag', 'Tag') }, () => ({ tag_id: null })) },
    defaults: () => ({ active: true, item_ids: [], tag_ids: [] }), kanban: { title: 'name', lines: ['active'] }, list: ['name', 'active'],
    form: { title: 'name', groups: [['attachment', 'active', 'tag_ids']], tabs: [{ label: 'Items', fields: ['item_ids'] }] },
  },
  'sign.request': {
    ...baseSign,
    fields: {
      ...baseSign.fields, template_id: relation('sign.template', 'Template'), attachment: { type: 'binary', label: 'Attachment' }, item_ids: items,
      reminder_days: { type: 'integer', label: 'Reminder Interval (days)' }, sent_date: { type: 'date', label: 'Sent on', readonly: true }, last_reminder_date: { type: 'date', label: 'Last Reminder', readonly: true },
      refusal_reason: { type: 'text', label: 'Refusal Reason', readonly: true }, signing_order: { type: 'boolean', label: 'Sequential Signing' }, token: { type: 'char', label: 'Access Token', readonly: true },
      cc_partner_ids: lines('CC Contacts', { partner_id: relation('res.partner', 'Contact') }, () => ({ partner_id: null })),
      signer_ids: { ...baseSign.fields.signer_ids, fields: { ...baseSign.fields.signer_ids.fields, role: { type: 'selection', label: 'Role', options: [...baseSign.fields.signer_ids.fields.role.options, ['company', 'Company']] }, token: { type: 'char', label: 'Access Token', readonly: true } }, newLine: () => ({ ...baseSign.fields.signer_ids.newLine(), token: token() }) },
      field_values: lines('Field Values', { signer_index: { type: 'integer', label: 'Signer Index' }, item_index: { type: 'integer', label: 'Item Index' }, value: { type: 'char', label: 'Value' } }, () => ({ signer_index: 0, item_index: 0, value: '' })),
      state: { ...baseSign.fields.state, options: [['draft', 'Draft'], ['sent', 'To Sign'], ['signed', 'Signed'], ['refused', 'Refused'], ['canceled', 'Cancelled'], ['expired', 'Expired']] },
    },
    defaults: () => ({ ...baseSign.defaults(), token: token(), sent_date: today(), reminder_days: 7, signing_order: true, cc_partner_ids: [], field_values: [] }),
    form: {
      ...baseSign.form, lockedWhen: (r) => r.state !== 'draft', groups: [...baseSign.form.groups, ['template_id', 'attachment', 'signing_order', 'reminder_days', 'last_reminder_date', 'refusal_reason']],
      tabs: [...baseSign.form.tabs, { label: 'CC Contacts', fields: ['cc_partner_ids'] }, { label: 'Field Values', fields: ['field_values'] }],
      buttons: [
        // With email configured the server sends each signer their link; otherwise the links are shared by hand.
        { label: 'Send', primary: true, when: (r) => r.state === 'draft', server: '/api/sign/send', requires: 'smtp', run: (db, r) => sendRequest(db, r) },
        { label: 'Signing Links', when: (r) => r.state === 'sent', run: showLinks },
        { label: 'Sign', primary: true, when: companyTurn, run: signPrompt },
        { label: 'Sign Now', primary: true, when: companyTurn, run: signPrompt },
        { label: 'Refuse', when: companyTurn, run: (db, r) => { const index = companyIndex(r); if (index < 0) throw new Error(OWN_LINK); const reason = prompt('Reason for refusing', ''); return { db: reason == null ? db : refuse(db, r, index, reason) }; } },
        { label: 'Send Reminder', when: (r) => r.state === 'sent', server: '/api/sign/remind', requires: 'smtp', run: () => { throw new Error('Reminders are emailed: configure email (MIZAN_SMTP_HOST) first'); } },
        { label: 'Cancel', vals: { state: 'canceled' }, when: (r) => ['draft', 'sent'].includes(r.state) },
      ],
    },
  },
  'documents.tag': {
    label: 'Document Tags', fields: { name: { type: 'char', label: 'Name', required: true }, facet: { type: 'char', label: 'Facet' } }, list: ['name', 'facet'], form: { title: 'name', groups: [['facet']] },
  },
  'documents.folder': {
    label: 'Folders', fields: { name: { type: 'char', label: 'Name', required: true }, parent_id: relation('documents.folder', 'Parent Folder'), owner_id: relation('hr.employee', 'Owner') },
    guard: (db, before, after) => {
      const visited = new Set([after.id]);
      let id = after.parent_id;
      while (id != null) {
        if (visited.has(id)) return 'A folder cannot contain itself';
        visited.add(id);
        const parent = read(db, 'documents.folder', id);
        if (!parent) return 'Parent folder not found';
        id = parent.parent_id;
      }
      return null;
    },
    defaults: () => ({ owner_id: 1 }), kanban: { title: 'name', lines: ['parent_id', 'owner_id'] }, list: ['name', 'parent_id', 'owner_id'], form: { title: 'name', groups: [['parent_id', 'owner_id']], chatter: true },
  },
  'documents.document': {
    ...baseDocument,
    fields: {
      ...baseDocument.fields, folder_id: relation('documents.folder', 'Folder'), locked_by: relation('hr.employee', 'Locked By'),
      tag_ids: lines('Tags', { tag_id: relation('documents.tag', 'Tag'), name: { type: 'char', label: 'Tag Name', hidden: true } }, () => ({ tag_id: null })),
      legacy_tags: { type: 'tags', label: 'Legacy Tags', readonly: true, compute: (r, db) => (r.tag_ids ?? []).map((t) => (typeof t === 'string' ? t : (db?.records?.['documents.tag'] ?? []).find((x) => x.id === t?.tag_id)?.name ?? t?.name)).filter(Boolean) },
    },
    kanban: { ...baseDocument.kanban, tags: 'tag_ids' },
    form: { ...baseDocument.form, groups: [...baseDocument.form.groups, ['folder_id', 'locked_by', 'legacy_tags']], buttons: baseDocument.form.buttons.map((b) => ['Lock', 'Unlock'].includes(b.label) ? { label: b.label, when: b.when, run: (db, r) => ({ db: (b.label === 'Lock' ? lockDocument : unlockDocument)(db, r.id, db.settings?.user_id ?? 1) }) } : b) },
  },
  'documents.share': {
    simulated: 'Share links are not served yet: there is no public page that opens them.',
    label: 'Shares', fields: { name: { type: 'char', label: 'Name', required: true }, folder_id: relation('documents.folder', 'Folder'), document_ids: lines('Documents', { document_id: relation('documents.document', 'Document') }, () => ({ document_id: null })), token: { type: 'char', label: 'Token', readonly: true }, expiration: { type: 'date', label: 'Expiration' }, can_upload: { type: 'boolean', label: 'Allow Upload' } },
    defaults: () => ({ name: 'Shared Documents', token: token(), document_ids: [], can_upload: false }), list: ['name', 'folder_id', 'expiration', 'can_upload'],
    form: { title: 'name', groups: [['folder_id', 'expiration', 'can_upload', 'token']], tabs: [{ label: 'Documents', fields: ['document_ids'] }], chatter: true },
  },
};
