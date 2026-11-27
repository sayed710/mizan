// Repro: one failing subscription silently blocks recurring invoicing for every subscription (scheduler tolerant() swallows the error).
const root = process.argv[2];
const { search, write, read } = await import(root + '/src/orm.js');
const { seed } = await import(root + '/src/seed.js');
const { runScheduledJobs } = await import(root + '/src/models/scheduler.js');
const { today, addDays } = await import(root + '/src/models/common.js');
let db = seed();
const subs = search(db, 'sale.subscription');
console.log('subscriptions', subs.length, subs.map((s) => `${s.id}:${s.stage}:${s.next_invoice_date}`).join(' '));
const prog = subs.filter((s) => s.stage === 'progress');
if (prog.length < 2) { console.log('need 2 in-progress subscriptions'); process.exit(0); }
const [a, b] = prog;
db = write(db, 'sale.subscription', a.id, { next_invoice_date: addDays(today(), -40) });
db = write(db, 'sale.subscription', b.id, { next_invoice_date: today() });
const movesBefore = db.records['account.move'].length;
// Control: no lock date
const ctl = runScheduledJobs(db);
console.log('control: new moves', ctl.records['account.move'].length - movesBefore, 'B next date', read(ctl, 'sale.subscription', b.id).next_invoice_date);
// Lock the period that contains A's overdue invoice date only
const locked = { ...db, settings: { ...db.settings, lock_date: addDays(today(), -30) } };
const out = runScheduledJobs(locked);
console.log('with lock: new moves', out.records['account.move'].length - movesBefore, 'B next date', read(out, 'sale.subscription', b.id).next_invoice_date, 'A next date', read(out, 'sale.subscription', a.id).next_invoice_date);
const notes = out.messages.length - locked.messages.length;
console.log('new chatter messages explaining failure:', out.messages.slice(locked.messages.length).filter((m) => m.model === 'sale.subscription').length);
