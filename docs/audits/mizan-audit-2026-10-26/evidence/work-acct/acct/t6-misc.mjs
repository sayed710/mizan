import { seed } from '../src/seed.js';
import { read, search, create } from '../src/orm.js';
import { applyDiff, diffDb } from '../src/sync.js';
import { modelsForApps } from '../src/models/index.js';
import { startSession, payOrder, priceLines } from '../src/models/pos.js';
import { postEntry, profitAndLoss } from '../src/models/ledger.js';
import { closeFiscalYear } from '../src/models/closing.js';
import { invariants, button } from './lib.mjs';
const base = seed();
const tryApply = (label, prev, next, opts) => { try { const s = applyDiff(prev, diffDb(prev, next), opts); console.log('ACCEPTED', label); return s; } catch (e) { console.log('REJECTED', label, '->', e.message); return null; } };
// POS-only user sells
let db = startSession(base, 100).db;
const prod = search(db, 'product').find((p) => p.available_in_pos || p.sale_ok !== false);
const sold = payOrder(db, { lines: priceLines(db, [{ product_id: prod.id, qty: 1 }]), method: 'cash' }).db;
tryApply('POS-only user: pay an order (creates POS journal entry)', db, sold, { isAdmin: false, allowed: modelsForApps(['pos']) });
// Payroll-only user confirms a payslip
const slip = search(base, 'hr.payslip').find((s) => s.state === 'draft');
if (slip) {
  const confirmed = button('hr.payslip', 'Confirm').run(base, read(base, 'hr.payslip', slip.id)).db;
  tryApply('Payroll-only user: confirm payslip (posts SAL entry)', base, confirmed, { isAdmin: false, allowed: modelsForApps(['payroll']) });
} else console.log('no draft payslip in seed');
// Unknown account code in an automated posting
const e = postEntry(base, { journal: 'SAL', ref: 'rule account typo', lines: [{ account: '620000', debit: 500 }, { account: '24O000', credit: 500 }] });
const m = read(e.db, 'account.move', e.id);
console.log('postEntry with unknown code 24O000 -> posted', m.state, 'lines', JSON.stringify(m.line_ids.map((l) => [l.account_id, l.debit, l.credit])));
console.log('   invariants', JSON.stringify({ tb: invariants(e.db).trialBalanceTotals, bs: invariants(e.db).BS, unknown: invariants(e.db).linesWithUnknownAccount }));
// Fiscal-year closing round-trip through the server (cleanRecord strips undeclared fields)
const y = create(base, 'account.fiscal.year', { name: 'FY2026', date_from: '2026-01-01', date_to: '2026-12-31' });
let draftsGone = y.db;
for (const d of search(draftsGone, 'account.move').filter((x) => x.state === 'draft')) draftsGone = button('account.move', 'Cancel').run(draftsGone, read(draftsGone, 'account.move', d.id)).db;
const prev = draftsGone;
const closed = closeFiscalYear(prev, y.id);
const p = { from: '2026-01-01', to: '2026-12-31' };
console.log('Client after close: P&L net FY2026 =', profitAndLoss(closed, p).net, '| closing move is_closing =', closed.records['account.move'].at(-1).is_closing);
const server = applyDiff(prev, diffDb(prev, closed), { isAdmin: true });
console.log('Server copy after /api/diff: P&L net FY2026 =', profitAndLoss(server, p).net, '| closing move is_closing =', server.records['account.move'].at(-1).is_closing, '| lock_date', server.settings.lock_date);
const nonAdminSrv = applyDiff(prev, diffDb(prev, closed), { isAdmin: false, allowed: modelsForApps(['accounting']) });
console.log('Non-admin accountant closes year: server lock_date =', nonAdminSrv.settings.lock_date, '| fiscal year state', read(nonAdminSrv, 'account.fiscal.year', y.id).state);
