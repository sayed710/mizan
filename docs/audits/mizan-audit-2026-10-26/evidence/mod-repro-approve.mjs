// Repro: Approvals "Approve" asks the clicking user to type an approver employee ID (prefilled); nothing ties the session user to that employee.
const root = process.argv[2];
const { read, search } = await import(root + '/src/orm.js');
const { seed } = await import(root + '/src/seed.js');
const { models } = await import(root + '/src/models/index.js');
let db = seed();
const btn = (l) => models['approval.request'].form.buttons.find((b) => b.label === l);
let req = search(db, 'approval.request').find((r) => r.request_status === 'pending');
if (!req) { console.log('no seeded request with approvers'); process.exit(0); }

req = read(db, 'approval.request', req.id);
console.log('request', req.id, 'owner', req.request_owner_id, 'status', req.request_status, 'approver_id', req.approver_id, 'approvers', JSON.stringify((req.approver_ids ?? []).map((a) => [a.employee_id, a.status])));
const prompts = []; globalThis.prompt = (q, d) => { prompts.push([q, d]); return d; };
for (let i = 0; i < 5 && btn('Approve').when(read(db, 'approval.request', req.id)); i++) db = btn('Approve').run(db, read(db, 'approval.request', req.id)).db;
const out = read(db, 'approval.request', req.id);
console.log('prompts shown:', JSON.stringify(prompts));
console.log('final status', out.request_status, 'approvers', JSON.stringify((out.approver_ids ?? []).map((a) => [a.employee_id, a.status])));
