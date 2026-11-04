import { seed } from '../src/seed.js';
import { read, search, create } from '../src/orm.js';
import { applyDiff, diffDb } from '../src/sync.js';
import { modelsForApps } from '../src/models/index.js';
import { button } from './lib.mjs';
const base = seed();
const emp = search(base, 'hr.employee').find((e) => Number(e.wage) > 0) ?? search(base, 'hr.employee')[0];
const s = create(base, 'hr.payslip', { employee_id: emp.id, date_from: '2026-10-01', date_to: '2026-10-31', state: 'draft' });
let next;
try { next = button('hr.payslip', 'Confirm').run(s.db, read(s.db, 'hr.payslip', s.id)).db; } catch (e) { console.log('confirm failed', e.message); process.exit(); }
for (const apps of [['payroll'], ['employees'], ['expenses']]) {
  try { applyDiff(s.db, diffDb(s.db, next), { isAdmin: false, allowed: modelsForApps(apps) }); console.log('ACCEPTED', apps.join(), 'confirm payslip'); }
  catch (e) { console.log('REJECTED', apps.join(), 'confirm payslip ->', e.message); }
}
