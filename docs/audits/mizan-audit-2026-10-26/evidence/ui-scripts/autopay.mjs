// Subscriptions "Automatic Payment" checkbox: does the scheduler book a bank receipt with no payment provider involved?
const W = process.argv[2];
const { seed } = await import(`${W}/src/seed.js`);
const { read, search, write } = await import(`${W}/src/orm.js`);
const { invoiceDue } = await import(`${W}/src/models/subscriptionplus.js`);
let db = seed();
const sub = search(db, 'sale.subscription').find((s) => s.stage === 'progress') ?? search(db, 'sale.subscription')[0];
if (!sub) { console.log('no subscription in seed'); process.exit(0); }
const date = new Date().toISOString().slice(0, 10);
db = write(db, 'sale.subscription', sub.id, { stage: 'progress', payment_token: true, next_invoice_date: date, end_date: null });
const beforeMoves = new Set(search(db, 'account.move').map((m) => m.id));
const beforePays = search(db, 'account.payment').length;
const after = invoiceDue(db, date);
const newMoves = search(after, 'account.move').filter((m) => !beforeMoves.has(m.id));
console.log('new moves:', newMoves.map((m) => `${m.name} type=${m.move_type} state=${m.state} paid=${m.amount_paid ?? 0}/${m.amount_total ?? ''} ref=${m.ref ?? ''}`).join(' | '));
console.log('account.payment records created:', search(after, 'account.payment').length - beforePays, '| payment_provider/transaction models involved: none (payMove only)');
