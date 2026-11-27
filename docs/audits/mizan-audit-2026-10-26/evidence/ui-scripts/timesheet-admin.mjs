// Is the UI-only "admin: true" Reset to Draft of a validated timesheet enforced by the server-side applyDiff?
const W = process.argv[2];
const { seed } = await import(`${W}/src/seed.js`);
const { applyDiff, diffDb } = await import(`${W}/src/sync.js`);
const { write, search } = await import(`${W}/src/orm.js`);
const { validateTimesheets } = await import(`${W}/src/models/timesheetplus.js`);
let db = seed();
const line = search(db, 'account.analytic.line').find((r) => !r.move_id && (!r.category || r.category === 'timesheet') && !r.timer_start);
console.log('timesheet line', line?.id);
const validated = validateTimesheets(db, [line.id], { user: 'The CFO (typed free text)' });
db = applyDiff(db, diffDb(db, validated), { author: 'emp', isAdmin: false });
console.log('validated_by stored:', JSON.stringify(search(db, 'account.analytic.line').find((r) => r.id === line.id).validated_by));
const reset = write(db, 'account.analytic.line', line.id, { validated: false, validated_by: '', validated_on: null });
try {
  db = applyDiff(db, diffDb(db, reset), { author: 'emp', isAdmin: false });
  console.log('non-admin reset accepted by applyDiff; validated =', search(db, 'account.analytic.line').find((r) => r.id === line.id).validated);
} catch (e) { console.log('rejected:', e.message); }
