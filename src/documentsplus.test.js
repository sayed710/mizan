import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { addDays, today } from './models/common.js';
import { signPlusModels, createShare, shareDocuments, lockDocument, unlockDocument, moveToFolder, fulfillRequest } from './models/signplus.js';
import { documentsPlusModels, applicableRules, runRule, requestDocument, overdueRequests, ruleButtons } from './models/documentsplus.js';


const doc = (db, id) => read(db, 'documents.document', id);
const folder = (db, name) => create(db, 'documents.folder', { name });
const rule = (db, vals = {}) => create(db, 'documents.workflow.rule', { name: 'File Document', ...vals });
const upload = (db, vals = {}) => create(db, 'documents.document', { name: 'Receipt', file: 'receipt.pdf', ...vals });
const refs = (...ids) => ids.map((tag_id) => ({ tag_id }));
const freeze = (r) => {
  if (r && typeof r === 'object' && !Object.isFrozen(r)) {
    Object.values(r).forEach(freeze);
    Object.freeze(r);
  }
  return r;
};
function taggedDb() {
  const review = create(seed(), 'documents.tag', { name: 'Review', facet: 'Status' });
  const approved = create(review.db, 'documents.tag', { name: 'Approved', facet: 'Status' });
  const paid = create(approved.db, 'documents.tag', { name: 'Paid', facet: 'Accounting' });
  return { db: paid.db, review: review.id, approved: approved.id, paid: paid.id };
}

test('workflow conditions match tag references, require all tags, exclude any forbidden tag and sort by sequence', () => {
  const tags = taggedDb();
  const workspace = folder(tags.db, 'Finance');
  const made = upload(workspace.db, { folder_id: workspace.id, tag_ids: refs(tags.review, tags.approved) });
  const matching = rule(made.db, { sequence: 20, folder_id: workspace.id, required_tags: refs(tags.review, tags.approved), excluded_tags: refs(tags.paid) });
  const first = rule(matching.db, { sequence: 1, required_tags: refs(tags.review) });
  const missing = rule(first.db, { required_tags: refs(tags.paid) });
  const excluded = rule(missing.db, { excluded_tags: refs(tags.approved) });
  const elsewhere = folder(excluded.db, 'HR');
  const other = rule(elsewhere.db, { folder_id: elsewhere.id });
  assert.deepEqual(applicableRules(other.db, made.id).map((r) => r.id), [first.id, matching.id]);
  assert.throws(() => runRule(other.db, missing.id, [made.id]), /does not apply/);
  assert.throws(() => runRule(other.db, excluded.id, [made.id]), /does not apply/);
  assert.throws(() => applicableRules(other.db, -1), /Document not found/);
});

test('workflow adds/removes tag references, preserves legacy tags, moves, assigns and schedules immutably', () => {
  const tags = taggedDb();
  const destination = folder(tags.db, 'Archive');
  const made = upload(destination.db, { tag_ids: [{ name: 'legacy' }, ...refs(tags.review, tags.paid)] });
  const action = rule(made.db, { set_tags: refs(tags.approved, tags.approved, tags.paid), remove_tags: refs(tags.review), move_to_folder_id: destination.id, set_owner_id: 2, activity_summary: 'Check receipt', activity_deadline_days: 3 });
  const snapshot = structuredClone(action.db);
  const next = runRule(freeze(action.db), action.id, [made.id, made.id]);
  assert.notEqual(next, action.db);
  assert.deepEqual(action.db, snapshot);
  assert.deepEqual(doc(next, made.id).tag_ids, [{ name: 'legacy' }, ...refs(tags.paid, tags.approved)]);
  assert.deepEqual(doc(next, made.id).legacy_tags, ['legacy']);
  assert.equal(doc(next, made.id).folder_id, destination.id);
  assert.equal(doc(next, made.id).owner_id, 2);
  const activities = search(next, 'mail.activity').filter((r) => r.res_model === 'documents.document' && r.res_id === made.id);
  assert.equal(activities.length, 1);
  assert.equal(activities[0].date_deadline, addDays(today(), 3));
  assert.equal(activities[0].user_id, 2);
  assert.equal(activities[0].summary, 'Check receipt');
  const buttons = ruleButtons(action.db, made.id);
  assert.equal(buttons[0].label, 'File Document');
  assert.deepEqual(doc(buttons[0].run(action.db, doc(action.db, made.id)).db, made.id).tag_ids, doc(next, made.id).tag_ids);
});

test('vendor bill action links once and uses Sign lock ownership without a second lock mechanism', () => {
  const made = upload(seed(), { partner_id: 2 });
  const action = rule(made.db, { create_model: 'account.move.in_invoice' });
  const db = { ...action.db, settings: { ...action.db.settings, user_id: 2 } };
  const snapshot = structuredClone(db);
  const next = runRule(freeze(db), action.id, [made.id]);
  const linked = doc(next, made.id);
  assert.equal(linked.res_model, 'account.move');
  assert.equal(linked.locked, true);
  assert.equal(linked.locked_by, 2);
  assert.ok(!Object.hasOwn(linked, 'lock_rule_id'));
  const bill = read(next, 'account.move', linked.res_id);
  assert.equal(bill.move_type, 'in_invoice');
  assert.equal(bill.state, 'draft');
  assert.equal(bill.partner_id, 2);
  assert.equal(bill.ref, 'Receipt');
  assert.deepEqual(bill.invoice_line_ids, []);
  const again = runRule(next, action.id, [made.id]);
  assert.equal(again, next);
  assert.equal(search(again, 'account.move').length, search(next, 'account.move').length);
  assert.deepEqual(applicableRules(next, made.id), []);
  assert.throws(() => unlockDocument(next, made.id, 1), /locker/);
  assert.throws(() => lockDocument(next, made.id, 1), /another user/);
  const unlocked = unlockDocument(next, made.id, 2);
  assert.equal(doc(unlocked, made.id).locked_by, null);
  assert.equal(doc(runRule(unlocked, action.id, [made.id]), made.id).res_id, bill.id);
  assert.deepEqual(db, snapshot);
});

test('workflow changes respect inherited locks and remove tags before creating and locking a link', () => {
  const tags = taggedDb();
  const made = upload(tags.db, { tag_ids: refs(tags.review), partner_id: 2 });
  const action = rule(made.db, { create_model: 'account.move.in_invoice', set_tags: refs(tags.approved), remove_tags: refs(tags.review) });
  const locked = lockDocument(action.db, made.id, 1);
  assert.throws(() => runRule(locked, action.id, [made.id]), /Unlock/);
  const next = runRule(unlockDocument(locked, made.id, 1), action.id, [made.id]);
  assert.deepEqual(doc(next, made.id).tag_ids, refs(tags.approved));
  assert.equal(doc(next, made.id).locked_by, 1);
  const changedAction = write(next, 'documents.workflow.rule', action.id, { set_tags: refs(tags.paid) });
  assert.throws(() => runRule(changedAction, action.id, [made.id]), /Unlock/);
});

test('expense and signature actions carry the attachment and never replace an existing record link', () => {
  for (const model of ['hr.expense', 'sign.request']) {
    const made = upload(seed(), { partner_id: 1, description: 'Supporting evidence' });
    const action = rule(made.db, { create_model: model, set_owner_id: 2 });
    const next = runRule(action.db, action.id, [made.id]);
    const linked = doc(next, made.id);
    const target = read(next, model, linked.res_id);
    assert.equal(linked.res_model, model);
    assert.equal(target.name, 'Receipt');
    assert.equal(model === 'hr.expense' ? target.receipt : target.attachment, 'receipt.pdf');
    if (model === 'hr.expense') assert.equal(target.employee_id, 2);
    assert.equal(linked.locked_by, 1);
    const another = write(next, 'documents.workflow.rule', action.id, { create_model: 'account.move.in_invoice' });
    const rerun = runRule(another, action.id, [made.id]);
    assert.equal(doc(rerun, made.id).res_model, model);
    assert.equal(search(rerun, 'account.move').length, search(another, 'account.move').length);
  }
});

test('requests delegate contact and date validation to Sign, preserve owner and use inherited fulfilment', () => {
  const workspace = folder(seed(), 'Requested');
  const requested = requestDocument(workspace.db, { folder_id: workspace.id, name: 'Tax return', owner_id: 2, partner_id: 1, deadline: '2025-01-10' });
  assert.equal(doc(requested.db, requested.id).is_request, true);
  assert.equal(doc(requested.db, requested.id).owner_id, 2);
  assert.equal(doc(requested.db, requested.id).partner_id, 1);
  assert.equal(doc(requested.db, requested.id).folder_id, workspace.id);
  assert.ok(!overdueRequests(requested.db, '2025-01-10').some((r) => r.id === requested.id));
  assert.ok(overdueRequests(requested.db, '2025-01-11').some((r) => r.id === requested.id));
  const action = rule(requested.db, { create_model: 'account.move.in_invoice' });
  assert.throws(() => runRule(action.db, action.id, [requested.id]), /Upload/);
  assert.throws(() => fulfillRequest(lockDocument(requested.db, requested.id, 1), requested.id, 'tax.pdf'), /Unlock/);
  const next = fulfillRequest(requested.db, requested.id, 'tax.pdf');
  assert.equal(doc(next, requested.id).is_request, false);
  assert.ok(!overdueRequests(next, '2025-01-11').some((r) => r.id === requested.id));
  assert.equal(doc(requested.db, requested.id).is_request, true);
  const uploaded = write(requested.db, 'documents.document', requested.id, { file: 'tax.pdf' });
  assert.equal(doc(uploaded, requested.id).is_request, false);
  assert.throws(() => requestDocument(next, { partner_id: 1, name: 'Bad date', deadline: '2025-02-30' }), /ISO date/);
  assert.throws(() => requestDocument(next, { partner_id: 99999, name: 'Invalid' }), /contact/);
  assert.throws(() => requestDocument(next, { partner_id: 1, name: 'Invalid', owner_id: 99999 }), /Owner/);
  assert.throws(() => overdueRequests(next, 'bad'), /valid date/);
});

test('sharing remains entirely Sign-owned with descendant scope, unique tokens and inclusive expiry', () => {
  assert.ok(!Object.hasOwn(documentsPlusModels, 'documents.share'));
  const workspace = folder(seed(), 'Shared');
  const child = create(workspace.db, 'documents.folder', { name: 'Child', parent_id: workspace.id });
  const made = upload(child.db, { folder_id: child.id });
  const outside = upload(made.db, { name: 'Private' });
  const snapshot = structuredClone(outside.db);
  const shared = createShare(freeze(outside.db), { folderId: workspace.id, expiration: '2030-04-10', canUpload: true });
  assert.equal(read(shared.db, 'documents.share', shared.id).can_upload, true);
  assert.deepEqual(shareDocuments(shared.db, shared.token, '2030-04-10').map((r) => r.id), [made.id]);
  assert.throws(() => shareDocuments(shared.db, shared.token, '2030-04-11'), /expired/);
  const explicit = createShare(shared.db, { documentIds: [made.id, made.id] });
  assert.notEqual(explicit.token, shared.token);
  assert.deepEqual(shareDocuments(explicit.db, explicit.token, '2031-01-01').map((r) => r.id), [made.id]);
  assert.deepEqual(outside.db, snapshot);
});

test('folder extension retains inherited guards and defaults and only adds workspace metadata', () => {
  const inherited = signPlusModels['documents.folder'];
  const extended = documentsPlusModels['documents.folder'];
  assert.equal(extended.guard, inherited.guard);
  assert.equal(extended.defaults, inherited.defaults);
  for (const [key, field] of Object.entries(inherited.fields)) assert.equal(extended.fields[key], field);
  assert.deepEqual(extended.form.groups.slice(0, inherited.form.groups.length), inherited.form.groups);
  const parent = folder(seed(), 'Parent');
  const child = create(parent.db, 'documents.folder', { name: 'Child', parent_id: parent.id });
  assert.equal(read(child.db, 'documents.folder', child.id).owner_id, 1);
  assert.throws(() => write(child.db, 'documents.folder', parent.id, { parent_id: child.id }), /contain itself/);
  const made = upload(child.db, { folder_id: parent.id });
  assert.equal(doc(moveToFolder(made.db, made.id, child.id), made.id).folder_id, child.id);
});

test('every inherited document field, filter, view and button survives, including owner-aware Lock/Unlock', () => {
  const inherited = signPlusModels['documents.document'];
  const extended = documentsPlusModels['documents.document'];
  assert.equal(extended.fields, inherited.fields);
  for (const key of ['filters', 'onchange', 'guard', 'kanban', 'list', 'groupBys', 'defaults']) assert.equal(extended[key], inherited[key]);
  assert.deepEqual(extended.form.groups, inherited.form.groups);
  for (const button of inherited.form.buttons) assert.ok(extended.form.buttons.includes(button));
  assert.equal(extended.form.ruleButtons, ruleButtons);
  for (const key of ['required_tags', 'excluded_tags', 'set_tags', 'remove_tags']) {
    const field = documentsPlusModels['documents.workflow.rule'].fields[key];
    assert.equal(field.type, 'one2many');
    assert.equal(field.fields.tag_id.relation, 'documents.tag');
  }
  const made = upload(seed(), { partner_id: 2 });
  const button = (db, label) => extended.form.buttons.find((b) => b.label === label).run(db, doc(db, made.id));
  const locked = button(made.db, 'Lock').db;
  assert.equal(doc(locked, made.id).locked_by, 1);
  assert.equal(doc(button(locked, 'Unlock').db, made.id).locked, false);
  const linked = button(made.db, 'Create Vendor Bill').db;
  assert.equal(doc(linked, made.id).res_model, 'account.move');
  assert.throws(() => button(linked, 'Create Vendor Bill'), /already linked/);
  assert.match(button(made.db, 'Share').go, /^#\/open\/documents.share\//);
});

test('invalid workflow configurations and missing targets fail without changing the input', () => {
  const made = upload(seed());
  const snapshot = structuredClone(made.db);
  for (const key of ['required_tags', 'excluded_tags', 'set_tags', 'remove_tags']) {
    for (const invalid of [['plain string'], [{ tag_id: 99999 }], 'comma,list']) {
      assert.throws(() => rule(made.db, { [key]: invalid }), /existing document tags/);
    }
  }
  for (const vals of [{ create_model: 'unknown' }, { activity_deadline_days: -1 }, { activity_deadline_days: 1.5 }, { move_to_folder_id: 99999 }, { set_owner_id: 99999 }]) {
    const action = rule(made.db, vals);
    assert.throws(() => runRule(action.db, action.id, [made.id]), /supported|deadline|Workspace|Owner/);
  }
  assert.throws(() => runRule(made.db, 99999, [made.id]), /not found/);
  const action = rule(made.db, { set_owner_id: 2 });
  assert.throws(() => runRule(action.db, action.id, [made.id, 99999]), /not found/);
  assert.deepEqual(made.db, snapshot);
});
