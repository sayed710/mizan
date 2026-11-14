const root = process.argv[2];
const { read, create } = await import(root + '/src/orm.js');
const { seed } = await import(root + '/src/seed.js');
const { models } = await import(root + '/src/models/index.js');
let db = seed();
const btn = (l) => models['approval.request'].form.buttons.find((b) => b.label === l);
const cat = create(db, 'approval.category', { name: 'Big purchase', approver_ids: [{ employee_id: 4, required: true, sequence: 1 }], approval_minimum: 1 });
db = cat.db;
const r = create(db, 'approval.request', { name: 'Self-approve test', category_id: cat.id, request_owner_id: 5, amount: 50000 });
db = r.db;
const catField = Object.keys(models['approval.request'].fields).filter((k) => /categ/.test(k));
console.log('category fields on request:', catField.join(','));
try { db = btn('Submit').run(db, read(db, 'approval.request', r.id)).db; } catch (e) { console.log('submit error:', e.message); }
let x = read(db, 'approval.request', r.id);
console.log('after submit:', x.state ?? x.request_status, JSON.stringify(x.approver_ids));
const prompts = []; globalThis.prompt = (q, d) => { prompts.push([q, d]); return d; };
try { db = btn('Approve').run(db, x).db; } catch (e) { console.log('approve error:', e.message); }
x = read(db, 'approval.request', r.id);
console.log('prompt shown to the clicking user:', JSON.stringify(prompts));
console.log('final:', x.state ?? x.request_status, JSON.stringify(x.approver_ids));
