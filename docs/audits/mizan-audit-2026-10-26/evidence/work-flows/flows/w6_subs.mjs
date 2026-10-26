import { seed, models, orm, btn, tryIt, serverSync, ledger, ledgerDelta, newIds, prompts, log } from './lib.mjs';
const { create, read, search, write } = orm;
const { runScheduledJobs } = await import('../src/models/scheduler.js');
let db = seed();
const step = (name, prev, next) => { const s = serverSync(prev, next); log(`[sync ${name}] lost: ${s.lost.length}`, s.lost.slice(0, 3).join(' ; ')); return s.db; };
const invs = (d, id) => search(d, 'account.move').filter((m) => m.subscription_id === id).map((m) => `${m.invoice_date}:${m.state}:${m.amount_total}:${m.payment_state}`);
log('seed subscriptions', JSON.stringify(search(db, 'sale.subscription').map((s) => [s.id, s.stage, s.next_invoice_date, s.payment_token])));
const plan = create(db, 'sale.subscription.plan', { name: 'Monthly', interval: 1, unit: 'month', auto_close_days: 15 }); db = plan.db;
let r = create(db, 'sale.subscription', { partner_id: 3, plan_id: plan.id, start_date: '2026-08-01', next_invoice_date: '2026-08-01', order_line: [{ product_id: 12, qty: 1, price_unit: 99, tax: 14 }] });
let prev = db; db = step('create', prev, r.db); const sub = r.id;
prev = db; db = btn(db, 'sale.subscription', sub, 'Start').db; db = step('start', prev, db);
log('started', read(db, 'sale.subscription', sub).stage);
// scheduler run at 2026-10-26 (catch-up of 3 monthly periods), then again
prev = db; const L1 = ledger(db); db = runScheduledJobs(db, '2026-10-26'); db = step('scheduler#1', prev, db);
const s1 = read(db, 'sale.subscription', sub);
log('after scheduler: invoices', invs(db, sub).join(' | '), '| stage', s1.stage, s1.close_reason, '| next', s1.next_invoice_date);
log('GL', JSON.stringify(ledgerDelta(L1, ledger(db))));
prev = db; db = runScheduledJobs(db, '2026-10-26'); log('scheduler#2 same day new invoices:', newIds(prev, db, 'account.move').filter((id) => read(db, 'account.move', id).subscription_id === sub).length);
// a fresh, current subscription: manual Generate Invoice twice
r = create(db, 'sale.subscription', { partner_id: 5, plan_id: plan.id, start_date: '2026-10-26', next_invoice_date: '2026-10-26', order_line: [{ product_id: 12, qty: 1, price_unit: 99, tax: 14 }], stage: 'progress' }); db = r.db; const s2 = r.id;
db = btn(db, 'sale.subscription', s2, 'Generate Invoice').db; db = btn(db, 'sale.subscription', s2, 'Generate Invoice').db;
log('Generate Invoice clicked twice:', invs(db, s2).join(' | '), 'next', read(db, 'sale.subscription', s2).next_invoice_date);
prev = db; db = runScheduledJobs(db, '2026-11-26'); log('scheduler 2026-11-26 billed again for s2:', newIds(prev, db, 'account.move').filter((id) => read(db, 'account.move', id).subscription_id === s2).length, '| s2', invs(db, s2).join(' | '));
// pay one invoice
const first = search(db, 'account.move').find((m) => m.subscription_id === s2);
prompts.push(String(first.amount_total)); db = btn(db, 'account.move', first.id, 'Register Payment').db;
log('paid first s2 invoice:', read(db, 'account.move', first.id).payment_state);
// automatic payment flag: scheduler books bank receipts with no payment provider
r = create(db, 'sale.subscription', { partner_id: 6, plan_id: plan.id, start_date: '2026-10-01', next_invoice_date: '2026-10-01', payment_token: true, order_line: [{ product_id: 12, qty: 10, price_unit: 99, tax: 14 }], stage: 'progress' }); db = r.db; const s3 = r.id;
const fsync = serverSync(db, write(db, 'sale.subscription', s3, { payment_token: true })); log('non-admin can set payment_token via server:', fsync.lost.length ? 'stripped' : 'ACCEPTED');
prev = db; const L3 = ledger(db); db = runScheduledJobs(db, '2026-10-26');
log('auto-pay sub: invoices', invs(db, s3).join(' | '), 'GL', JSON.stringify(ledgerDelta(L3, ledger(db))), 'payments', search(db, 'account.payment').filter((p) => read(db, 'account.move', p.invoice_id)?.subscription_id === s3).map((p) => `${p.name}:${p.amount}:${p.journal_id}`).join(','));
// close (cancel) then reopen months later
r = create(db, 'sale.subscription', { partner_id: 1, plan_id: plan.id, start_date: '2026-06-01', next_invoice_date: '2026-06-01', payment_token: true, order_line: [{ product_id: 12, qty: 1, price_unit: 99, tax: 14 }], stage: 'progress' }); db = r.db; const s4 = r.id;
db = runScheduledJobs(db, '2026-06-01'); log('s4 billed June:', invs(db, s4).join(' | '));
prompts.push('4'); db = btn(db, 'sale.subscription', s4, 'Close').db;
log('closed s4:', read(db, 'sale.subscription', s4).stage, read(db, 'sale.subscription', s4).close_reason, 'end_date', read(db, 'sale.subscription', s4).end_date, 'next', read(db, 'sale.subscription', s4).next_invoice_date);
prev = db; db = runScheduledJobs(db, '2026-09-15'); log('scheduler while closed bills s4:', newIds(prev, db, 'account.move').filter((id) => read(db, 'account.move', id).subscription_id === s4).length);
prev = db; db = btn(db, 'sale.subscription', s4, 'Reopen').db; db = runScheduledJobs(db, '2026-10-26');
log('Reopen on 2026-10-26 then scheduler: s4 invoices', invs(db, s4).join(' | '));
// expiry
r = create(db, 'sale.subscription', { partner_id: 2, plan_id: plan.id, start_date: '2026-07-01', next_invoice_date: '2026-07-01', end_date: '2026-09-01', payment_token: true, order_line: [{ product_id: 12, qty: 1, price_unit: 50, tax: 0 }], stage: 'progress' }); db = r.db; const s5 = r.id;
db = runScheduledJobs(db, '2026-10-26');
log('fixed-term (end 2026-09-01) sub: invoices', invs(db, s5).join(' | '), 'stage', read(db, 'sale.subscription', s5).stage, 'closed_date', read(db, 'sale.subscription', s5).closed_date);
// renew
const rn = tryIt(() => btn(db, 'sale.subscription', s5, 'Renew'));
log('renew s5:', rn.ok ? `new sub ${newIds(db, rn.value.db, 'sale.subscription')} stage ${read(rn.value.db, 'sale.subscription', newIds(db, rn.value.db, 'sale.subscription')[0]).stage} start ${read(rn.value.db, 'sale.subscription', newIds(db, rn.value.db, 'sale.subscription')[0]).start_date}` : rn.error);
// statusbar is clickable: stage can be written freely (draft -> closed -> progress) without the button logic
log('statusbarClickable on sale.subscription:', models['sale.subscription'].form.statusbarClickable);
// cancel an auto-billed invoice then scheduler: re-bills the period?
const anyInv = search(db, 'account.move').find((m) => m.subscription_id === s2 && m.payment_state !== 'paid' && m.state === 'posted');
if (anyInv) { let c = write(db, 'account.move', anyInv.id, { state: 'draft' }); c = btn(c, 'account.move', anyInv.id, 'Cancel').db; const s2r = write(c, 'sale.subscription', s2, { next_invoice_date: anyInv.invoice_date }); const again = runScheduledJobs(s2r, '2026-12-26'); log('after cancelling', anyInv.invoice_date, 'invoice and rewinding next date, scheduler re-bills:', invs(again, s2).join(' | ')); }
// what made the scheduler silently skip?
const { subscriptionJobs } = await import('../src/models/subscriptionplus.js');
if (anyInv) { let c = write(db, 'account.move', anyInv.id, { state: 'draft' }); c = btn(c, 'account.move', anyInv.id, 'Cancel').db; const s2r = write(c, 'sale.subscription', s2, { next_invoice_date: anyInv.invoice_date });
  log('subscriptionJobs direct:', tryIt(() => subscriptionJobs(s2r, '2026-12-26')).error ?? 'ok');
  for (const s of search(s2r, 'sale.subscription')) { const one = { ...s2r, records: { ...s2r.records, 'sale.subscription': s2r.records['sale.subscription'].filter((x) => x.id === s.id) } }; const e = tryIt(() => subscriptionJobs(one, '2026-12-26')).error; if (e) log('   sub', s.id, s.name, s.stage, 'plan', s.plan, s.plan_id, '->', e); }
}
{ const { invoiceDue, autoClose } = await import('../src/models/subscriptionplus.js');
  let c = write(db, 'account.move', anyInv.id, { state: 'draft' }); c = btn(c, 'account.move', anyInv.id, 'Cancel').db; const s2r = write(c, 'sale.subscription', s2, { next_invoice_date: anyInv.invoice_date });
  log('s2 in context:', JSON.stringify((({ stage, next_invoice_date, end_date, close_reason }) => ({ stage, next_invoice_date, end_date, close_reason }))(read(s2r, 'sale.subscription', s2))));
  const x = tryIt(() => invoiceDue(s2r, '2026-12-26')); log('invoiceDue:', x.ok ? invs(x.value, s2).join(' | ') : x.error);
}
