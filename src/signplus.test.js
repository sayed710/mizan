import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { today, addDays } from './models/common.js';
import { signPlusModels, requestFromTemplate, signFields, refuse, dueReminders, sendReminders, expireRequests, signingLink, verifyToken, certificate, moveToFolder, lockDocument, unlockDocument, createShare, shareDocuments, requestDocument, fulfillRequest } from './models/signplus.js';

const get = (db, id) => read(db, 'sign.request', id);
const button = (db, model, id, label) => signPlusModels[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;
const templateItems = [
  { type: 'signature', role: 'customer', page: 1, required: true },
  { type: 'date', role: 'customer', page: 1, required: true },
  { type: 'email', role: 'customer', page: 1, required: true },
  { type: 'checkbox', role: 'customer', page: 1, required: true },
  { type: 'initial', role: 'employee', page: 2, required: true },
];
const values = () => ({ 0: 'Customer Signature', 1: today(), 2: 'customer@example.com', 3: false });
function fixture() {
  const base = seed();
  const template = create(base, 'sign.template', { name: 'Agreement', attachment: 'agreement.pdf', item_ids: templateItems });
  const result = requestFromTemplate(template.db, template.id, { signers: [{ role: 'customer', partner_id: 1 }, { role: 'employee', partner_id: 2 }], deadline: addDays(today(), 30) });
  return { ...result, templateId: template.id, draft: result.db, db: button(result.db, 'sign.request', result.id, 'Send') };
}

test('templates create one signer per role, snapshot items, and reject missing or duplicate partners', () => {
  const { db, id, templateId } = fixture();
  const r = get(db, id);
  assert.deepEqual(r.signer_ids.map((s) => [s.role, s.partner_id]), [['customer', 1], ['employee', 2]]);
  assert.equal(r.template_id, templateId);
  assert.equal(r.attachment, 'agreement.pdf');
  assert.equal(r.sent_date, today());
  const changed = write(db, 'sign.template', templateId, { item_ids: [] });
  assert.deepEqual(get(changed, id).item_ids, templateItems);
  assert.throws(() => requestFromTemplate(db, templateId, { signers: [{ role: 'customer', partner_id: 1 }] }), /partner.*employee/);
  assert.throws(() => requestFromTemplate(db, templateId, { signers: [{ role: 'customer', partner_id: 999 }, { role: 'employee', partner_id: 2 }] }), /partner/);
  assert.throws(() => requestFromTemplate(db, templateId, { signers: [{ role: 'customer', partner_id: 1 }, { role: 'customer', partner_id: 2 }] }), /one partner/);
  assert.throws(() => requestFromTemplate(write(db, 'sign.template', templateId, { active: false }), templateId), /active/);
});

test('required fields validate role ownership, ISO dates, email and boolean checkboxes without mutation', () => {
  const { db, id, draft } = fixture();
  const before = structuredClone(db), r = get(db, id);
  assert.throws(() => signFields(draft, r, 0, values()), /Send/);
  assert.throws(() => signFields(db, r, 0, {}), /Required/);
  assert.throws(() => signFields(db, r, 0, { ...values(), 1: '2026-02-30' }), /ISO date/);
  assert.throws(() => signFields(db, r, 0, { ...values(), 2: 'invalid' }), /email/);
  assert.throws(() => signFields(db, r, 0, { ...values(), 3: 'true' }), /boolean/);
  assert.throws(() => signFields(db, r, 0, { ...values(), 4: 'forged' }), /belonging/);
  const next = signFields(db, r, 0, values());
  assert.equal(get(next, id).field_values.find((v) => v.item_index === 3).value, false);
  assert.deepEqual(db, before);
});

test('sequential signing blocks later signers and stale records cannot sign twice', () => {
  const { db, id } = fixture(), r = get(db, id);
  assert.throws(() => signFields(db, r, 1, { 4: 'ES' }), /signing order/);
  const first = signFields(db, r, 0, values());
  assert.equal(get(first, id).state, 'sent');
  assert.throws(() => signFields(first, r, 0, values()), /unsigned/);
  const done = signFields(first, r, 1, [{ item_index: 4, value: 'ES' }]);
  assert.equal(get(done, id).state, 'signed');
  assert.equal(get(done, id).progress, '2 / 2');
  assert.equal(get(done, id).signature, 'Customer Signature, ' + read(db, 'res.partner', 2).name);
});

test('parallel signing accepts either signer while retaining signer order, tokens and field values', () => {
  const setup = fixture(), db = write(setup.db, 'sign.request', setup.id, { signing_order: false });
  const r = get(db, setup.id);
  const first = signFields(db, r, 1, { 4: 'ES' });
  assert.deepEqual(get(first, r.id).signer_ids.map((s) => s.signed), [false, true]);
  const done = signFields(first, r, 0, values());
  assert.equal(get(done, r.id).state, 'signed');
  assert.deepEqual(get(done, r.id).signer_ids.map((s) => s.token), r.signer_ids.map((s) => s.token));
  assert.equal(get(done, r.id).field_values.length, 5);
});

test('refusal stores a trimmed reason, posts a note and prevents further signing', () => {
  const { db, id } = fixture(), r = get(db, id);
  assert.throws(() => refuse(db, r, 0, '  '), /reason/);
  assert.throws(() => refuse(db, r, 9, 'No'), /unsigned/);
  const next = refuse(db, r, 1, ' Terms need revision ');
  assert.equal(get(next, id).state, 'refused');
  assert.equal(get(next, id).refusal_reason, 'Terms need revision');
  assert.ok(next.messages.some((m) => m.res_id === id && m.kind === 'note' && m.body.includes('Terms need revision')));
  assert.throws(() => signFields(next, r, 0, values()), /Send/);
});

test('reminders use sent or last reminder date, are idempotent, and expiry respects the deadline', () => {
  const setup = fixture(), id = setup.id;
  const db = write(setup.db, 'sign.request', id, { sent_date: '2030-01-01', deadline: '2030-01-31', reminder_days: 3 });
  assert.ok(!dueReminders(db, '2030-01-03').some((r) => r.id === id));
  assert.ok(dueReminders(db, '2030-01-04').some((r) => r.id === id));
  const reminded = sendReminders(db, '2030-01-04');
  assert.equal(get(reminded, id).last_reminder_date, '2030-01-04');
  assert.ok(reminded.messages.some((m) => m.res_id === id && m.kind === 'note' && m.body.includes('2030-01-04')));
  assert.deepEqual(sendReminders(reminded, '2030-01-04'), reminded);
  assert.ok(dueReminders(reminded, '2030-01-07').some((r) => r.id === id));
  assert.ok(!dueReminders(db, '2030-02-01').some((r) => r.id === id));
  assert.equal(get(expireRequests(db, '2030-01-31'), id).state, 'sent');
  assert.equal(get(expireRequests(db, '2030-02-01'), id).state, 'expired');
  for (const state of ['signed', 'refused', 'canceled']) {
    const terminal = write(db, 'sign.request', id, { state });
    assert.ok(!dueReminders(terminal, '2030-01-04').some((r) => r.id === id));
    assert.equal(get(expireRequests(terminal, '2030-02-01'), id).state, state);
  }
  assert.throws(() => dueReminders(db, 'bad'), /ISO date/);
});

test('signing tokens are distinct and verifiable; certificates expose only SHA-256 prefixes', () => {
  const { db, id } = fixture(), r = get(db, id);
  assert.notEqual(r.signer_ids[0].token, r.signer_ids[1].token);
  assert.equal(signingLink(r, 0), `/sign/${id}/${r.signer_ids[0].token}`);
  assert.equal(verifyToken(r, 0, r.signer_ids[0].token), true);
  for (const value of ['', null, r.signer_ids[1].token, r.signer_ids[0].token + 'x']) assert.equal(verifyToken(r, 0, value), false);
  assert.equal(verifyToken(r, 99, 'x'), false);
  assert.throws(() => signingLink(r, 99), /token/);
  assert.equal(certificate(db, r).completed, false);
  const first = signFields(db, r, 0, values()), done = signFields(first, r, 1, { 4: 'ES' });
  const cert = certificate(done, r);
  assert.equal(cert.completed, true);
  assert.equal(cert.name, 'Agreement');
  assert.deepEqual(cert.signers, r.signer_ids.map((s) => ({ name: read(db, 'res.partner', s.partner_id).name, signed_on: today(), token_hash: createHash('sha256').update(s.token).digest('hex').slice(0, 8) })));
  assert.ok(!JSON.stringify(cert).includes(r.signer_ids[0].token));
});

function folders() {
  const root = create(seed(), 'documents.folder', { name: 'Legal' });
  const child = create(root.db, 'documents.folder', { name: 'Contracts', parent_id: root.id });
  const grandchild = create(child.db, 'documents.folder', { name: 'Signed', parent_id: child.id });
  const one = create(grandchild.db, 'documents.document', { name: 'Root File', folder_id: root.id });
  const two = create(one.db, 'documents.document', { name: 'Nested File', folder_id: grandchild.id });
  return { db: two.db, root: root.id, child: child.id, one: one.id, two: two.id };
}

test('folders support moves and cycle protection; tags retain facets and legacy seeded tags', () => {
  const { db, root, child, one } = folders();
  const next = moveToFolder(db, one, child);
  assert.equal(read(next, 'documents.document', one).folder_id, child);
  assert.equal(read(db, 'documents.document', one).folder_id, root);
  assert.throws(() => moveToFolder(db, one, 999), /Folder/);
  assert.throws(() => write(db, 'documents.folder', root, { parent_id: child }), /itself/);
  const tag = create(db, 'documents.tag', { name: 'Approved', facet: 'Status' });
  const tagged = write(tag.db, 'documents.document', one, { tag_ids: [{ tag_id: tag.id }] });
  assert.equal(read(tagged, 'documents.tag', tag.id).facet, 'Status');
  assert.deepEqual(read(tagged, 'documents.document', one).tag_ids, [{ tag_id: tag.id }]);
  const legacy = search(db, 'documents.document').find((d) => d.legacy_tags.length);
  assert.deepEqual(legacy.legacy_tags, legacy.tag_ids);
});

test('locks reject another user unlocking or taking over and prevent moving locked files', () => {
  const { db, child, one } = folders(), before = structuredClone(db);
  const locked = lockDocument(db, one, 1);
  assert.equal(read(locked, 'documents.document', one).locked_by, 1);
  assert.throws(() => unlockDocument(locked, one, 2), /locker/);
  assert.throws(() => lockDocument(locked, one, 2), /another user/);
  assert.throws(() => moveToFolder(locked, one, child), /Unlock/);
  const unlocked = unlockDocument(locked, one, 1);
  assert.equal(read(unlocked, 'documents.document', one).locked, false);
  assert.equal(read(unlocked, 'documents.document', one).locked_by, null);
  assert.deepEqual(db, before);
});

test('shares include descendants, isolate explicit documents and reject invalid or expired links', () => {
  const { db, root, one, two } = folders();
  const share = createShare(db, { folderId: root, expiration: '2030-01-31', canUpload: true });
  assert.deepEqual(shareDocuments(share.db, share.token, '2030-01-31').map((d) => d.id), [one, two]);
  assert.equal(read(share.db, 'documents.share', share.id).can_upload, true);
  assert.throws(() => shareDocuments(share.db, share.token, '2030-02-01'), /expired/);
  assert.throws(() => shareDocuments(share.db, 'invalid', '2030-01-01'), /invalid/);
  const explicit = createShare(share.db, { documentIds: [two, two] });
  assert.notEqual(explicit.token, share.token);
  assert.deepEqual(shareDocuments(explicit.db, explicit.token, '2031-01-01').map((d) => d.id), [two]);
  assert.throws(() => createShare(db, { folderId: root, documentIds: [one] }), /either/);
  assert.throws(() => createShare(db, { documentIds: [] }), /Select documents/);
  assert.throws(() => createShare(db, { documentIds: [999] }), /not found/);
});

test('document requests retain contact, folder and deadline and require a file to fulfill', () => {
  const { db, root } = folders();
  const request = requestDocument(db, { partnerId: 1, name: 'Identity', folderId: root, deadline: '2030-01-31' });
  const r = read(request.db, 'documents.document', request.id);
  assert.equal(r.is_request, true);
  assert.equal(r.partner_id, 1);
  assert.equal(r.folder_id, root);
  assert.equal(r.request_deadline, '2030-01-31');
  assert.throws(() => fulfillRequest(request.db, r.id, ''), /Upload/);
  assert.throws(() => fulfillRequest(lockDocument(request.db, r.id, 1), r.id, 'id.pdf'), /Unlock/);
  const done = fulfillRequest(request.db, r.id, 'id.pdf');
  assert.equal(read(done, 'documents.document', r.id).is_request, false);
  assert.equal(read(done, 'documents.document', r.id).file, 'id.pdf');
  assert.equal(r.is_request, true);
  assert.throws(() => fulfillRequest(done, r.id, 'again.pdf'), /pending/);
  assert.throws(() => requestDocument(db, { partnerId: 999, name: 'Invalid' }), /contact/);
});

test('seed and legacy Sign Now prompt, document conversion and form metadata remain usable', (t) => {
  const db = seed(), r = search(db, 'sign.request').find((s) => s.state === 'sent');
  assert.ok(search(db, 'documents.document').length);
  assert.equal(verifyToken(r, 0, r.token), true);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'prompt');
  globalThis.prompt = () => 'Legacy Signer';
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'prompt', previous); else delete globalThis.prompt; });
  assert.throws(() => button(db, 'sign.request', r.id, 'Sign Now'), /own signing link/);
  const company = write(db, 'sign.request', r.id, { signer_ids: [{ partner_id: r.partner_id, role: 'company', signed: false, token: r.token }] });
  const signed = button(company, 'sign.request', r.id, 'Sign Now');
  assert.equal(get(signed, r.id).state, 'signed');
  assert.equal(get(signed, r.id).signature, 'Legacy Signer');
  const file = create(db, 'documents.document', { name: 'Contract', partner_id: 1, file: 'contract.pdf' });
  const linked = button(file.db, 'documents.document', file.id, 'Request Signature');
  const d = read(linked, 'documents.document', file.id);
  assert.equal(d.res_model, 'sign.request');
  assert.equal(get(linked, d.res_id).name, 'Contract');
  assert.deepEqual(signPlusModels['sign.template'].form.tabs[0].fields, ['item_ids']);
  for (const label of ['Send', 'Sign', 'Refuse', 'Send Reminder', 'Cancel']) assert.ok(signPlusModels['sign.request'].form.buttons.some((b) => b.label === label));
});

test('template prompts gather typed fields; cancellation and refusal preserve their expected state', (t) => {
  const customer = fixture();
  globalThis.prompt = () => 'x';
  assert.throws(() => button(customer.db, 'sign.request', customer.id, 'Sign'), /own signing link/);
  assert.throws(() => button(customer.db, 'sign.request', customer.id, 'Refuse'), /own signing link/);
  // A company signer signs in the app.
  const base = seed();
  const template = create(base, 'sign.template', { name: 'Agreement', item_ids: templateItems.map((i) => ({ ...i, role: i.role === 'customer' ? 'company' : i.role })) });
  const draft = requestFromTemplate(template.db, template.id, { signers: [{ role: 'company', partner_id: 1 }, { role: 'employee', partner_id: 2 }], deadline: addDays(today(), 30) });
  const { id } = draft;
  const db = button(draft.db, 'sign.request', id, 'Send');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'prompt');
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'prompt', previous); else delete globalThis.prompt; });
  globalThis.prompt = () => null;
  assert.equal(button(db, 'sign.request', id, 'Sign'), db);
  assert.equal(button(db, 'sign.request', id, 'Refuse'), db);
  const answers = ['Customer Signature', today(), 'customer@example.com', 'false'];
  globalThis.prompt = () => answers.shift();
  const signed = button(db, 'sign.request', id, 'Sign');
  assert.equal(get(signed, id).signer_ids[0].signed, true);
  globalThis.prompt = () => 'Please amend';
  assert.equal(get(button(db, 'sign.request', id, 'Refuse'), id).refusal_reason, 'Please amend');
});
