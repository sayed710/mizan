// Workflow actions layered on the shared Sign document models.
import { create, read, search, write } from '../orm.js';
import { addDays, today } from './common.js';
import { signPlusModels, createShare, lockDocument, moveToFolder, requestDocument as requestUpload } from './signplus.js';

const base = signPlusModels['documents.document'];
const folder = signPlusModels['documents.folder'];
const relation = (relation, label) => ({ type: 'many2one', relation, label });
const tags = (label) => ({ ...base.fields.tag_ids, label });
const tagFields = ['required_tags', 'excluded_tags', 'set_tags', 'remove_tags'];
const tagIds = (lines = []) => [...new Set(lines.filter((line) => Number.isInteger(line?.tag_id)).map((line) => line.tag_id))];
const document = (db, id) => {
  const r = read(db, 'documents.document', id);
  if (!r) throw new Error('Document not found');
  return r;
};
const validDate = (date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
const matches = (r, rule) => (!rule.folder_id || rule.folder_id === r.folder_id)
  && tagIds(rule.required_tags).every((id) => tagIds(r.tag_ids).includes(id))
  && !tagIds(rule.excluded_tags).some((id) => tagIds(r.tag_ids).includes(id));

/** Matching actions in sequence order, excluding locked documents. */
export function applicableRules(db, documentId) {
  const r = document(db, documentId);
  return r.locked ? [] : search(db, 'documents.workflow.rule').filter((rule) => matches(r, rule))
    .sort((a, b) => Number(a.sequence ?? 10) - Number(b.sequence ?? 10) || a.id - b.id);
}

function linkDocument(db, r, rule) {
  if (!rule.create_model || rule.create_model === 'none' || r.res_model || r.res_id) return db;
  if (!r.file || r.is_request) throw new Error('Upload the requested document before creating a linked record');
  const model = rule.create_model === 'account.move.in_invoice' ? 'account.move' : rule.create_model;
  const vals = model === 'account.move'
    ? { move_type: 'in_invoice', state: 'draft', partner_id: r.partner_id ?? null, ref: r.name, invoice_date: today(), invoice_line_ids: [] }
    : model === 'hr.expense'
      ? { name: r.name, employee_id: r.owner_id, receipt: r.file, notes: r.description ?? '' }
      : { name: r.name, partner_id: r.partner_id, attachment: r.file, body: r.description ?? '' };
  const made = create(db, model, { ...vals, company_id: r.company_id ?? 1 });
  const linked = write(made.db, 'documents.document', r.id, { res_model: model, res_id: made.id });
  return lockDocument(linked, r.id, db.settings?.user_id ?? 1);
}

function actionValues(r, rule) {
  const existing = tagIds(r.tag_ids);
  const added = tagIds(rule.set_tags).filter((id) => !existing.includes(id)).map((tag_id) => ({ tag_id }));
  const removed = tagIds(rule.remove_tags);
  const tag_ids = [...(r.tag_ids ?? []), ...added].filter((line) => !removed.includes(line?.tag_id));
  return {
    ...(JSON.stringify(tag_ids) !== JSON.stringify(r.tag_ids ?? []) ? { tag_ids } : {}),
    ...(rule.set_owner_id && rule.set_owner_id !== r.owner_id ? { owner_id: rule.set_owner_id } : {}),
  };
}

/** Apply actions without replacing existing links or bypassing Sign's document locks. */
export function runRule(db, ruleId, documentIds) {
  const rule = read(db, 'documents.workflow.rule', ruleId);
  if (!rule) throw new Error('Workflow action not found');
  if (rule.move_to_folder_id && !read(db, 'documents.folder', rule.move_to_folder_id)) throw new Error('Workspace not found');
  if (rule.set_owner_id && !read(db, 'hr.employee', rule.set_owner_id)) throw new Error('Owner not found');
  const days = Number(rule.activity_deadline_days ?? 0);
  if (!Number.isInteger(days) || days < 0) throw new Error('Activity deadline must be a non-negative number of days');
  if (!['none', 'account.move.in_invoice', 'hr.expense', 'sign.request'].includes(rule.create_model ?? 'none')) throw new Error('Select a supported linked record type');
  let next = db;
  for (const id of new Set(documentIds)) {
    const r = document(next, id);
    if (!matches(r, rule)) throw new Error(`Workflow action does not apply to ${r.name}`);
    const vals = actionValues(r, rule);
    const move = rule.move_to_folder_id && rule.move_to_folder_id !== r.folder_id;
    if (r.locked) {
      if (r.res_model && r.res_id && !Object.keys(vals).length && !move && !rule.activity_summary?.trim()) continue;
      throw new Error('Unlock the document before running a workflow action');
    }
    if (move) next = moveToFolder(next, id, rule.move_to_folder_id);
    if (Object.keys(vals).length) next = write(next, 'documents.document', id, vals);
    next = linkDocument(next, document(next, id), rule);
    if (rule.activity_summary?.trim()) next = create(next, 'mail.activity', {
      summary: rule.activity_summary.trim(), date_deadline: addDays(today(), days), user_id: rule.set_owner_id || r.owner_id,
      res_model: 'documents.document', res_id: id, res_name: r.name, company_id: r.company_id ?? 1,
    }).db;
  }
  return next;
}

/** Adapt workspace request arguments to Sign's validated upload request API. */
export function requestDocument(db, { folder_id, name, owner_id, partner_id, deadline }) {
  if (owner_id != null && !read(db, 'hr.employee', owner_id)) throw new Error('Owner not found');
  const made = requestUpload(db, { folderId: folder_id, partnerId: partner_id, name, deadline });
  return owner_id == null ? made : { ...made, db: write(made.db, 'documents.document', made.id, { owner_id }) };
}

/** Unfulfilled requests strictly before the supplied date. */
export function overdueRequests(db, date = today()) {
  if (!validDate(date)) throw new Error('Enter a valid date (YYYY-MM-DD)');
  return search(db, 'documents.document').filter((r) => r.is_request && !r.file && r.request_deadline && r.request_deadline < date);
}

/** Named form buttons for the document's currently applicable workflow actions. */
export function ruleButtons(db, documentId) {
  return applicableRules(db, documentId).map((rule) => ({ label: rule.name, run: (db, r) => ({ db: runRule(db, rule.id, [r.id]) }) }));
}

export const documentsPlusModels = {
  'documents.folder': {
    ...folder, label: 'Workspaces',
    fields: {
      ...folder.fields, company_id: relation('res.company', 'Company'),
      tag_categories: { type: 'one2many', label: 'Tag Categories', fields: { category: { type: 'char', label: 'Category' }, tags: { type: 'char', label: 'Tags (comma-separated)' } }, newLine: () => ({ category: '', tags: '' }) },
    },
    form: { ...folder.form, groups: [...folder.form.groups, ['company_id']], tabs: [...(folder.form.tabs ?? []), { label: 'Tag Categories', fields: ['tag_categories'] }] },
  },
  'documents.workflow.rule': {
    label: 'Workflow Actions',
    fields: {
      name: { type: 'char', label: 'Action Name', required: true }, folder_id: relation('documents.folder', 'Workspace'),
      required_tags: tags('Required Tags'), excluded_tags: tags('Excluded Tags'), sequence: { type: 'integer', label: 'Sequence' },
      set_tags: tags('Add Tags'), remove_tags: tags('Remove Tags'), move_to_folder_id: relation('documents.folder', 'Move to Workspace'), set_owner_id: relation('hr.employee', 'Set Owner'),
      create_model: { type: 'selection', label: 'Create Record', options: [['none', 'None'], ['account.move.in_invoice', 'Vendor Bill'], ['hr.expense', 'Expense'], ['sign.request', 'Signature Request']] },
      activity_summary: { type: 'char', label: 'Activity Summary' }, activity_deadline_days: { type: 'integer', label: 'Activity Deadline (days)' },
    },
    guard: (db, before, after) => tagFields.some((key) => !Array.isArray(after[key]) || after[key].some((line) => !Number.isInteger(line?.tag_id) || !read(db, 'documents.tag', line.tag_id))) ? 'Select existing document tags for workflow conditions and actions' : null,
    defaults: () => ({ sequence: 10, required_tags: [], excluded_tags: [], set_tags: [], remove_tags: [], create_model: 'none', activity_deadline_days: 0 }),
    list: ['sequence', 'name', 'folder_id', 'create_model'], kanban: { title: 'name', lines: ['folder_id', 'create_model'] },
    form: { title: 'name', groups: [['folder_id', 'sequence', 'required_tags', 'excluded_tags'], ['set_tags', 'remove_tags', 'move_to_folder_id', 'set_owner_id', 'create_model'], ['activity_summary', 'activity_deadline_days']] },
  },
  'documents.document': {
    ...base,
    form: {
      ...base.form, ruleButtons,
      buttons: [...base.form.buttons, { label: 'Share', run: (db, r) => {
        const shared = createShare(db, { documentIds: [r.id] });
        return { db: shared.db, go: `#/open/documents.share/${shared.id}` };
      } }],
    },
  },
};
