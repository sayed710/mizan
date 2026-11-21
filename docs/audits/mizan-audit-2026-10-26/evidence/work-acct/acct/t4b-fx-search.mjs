import { seed } from '../src/seed.js';
import { read, search, create } from '../src/orm.js';
import { payMove, postMove } from '../src/models/accounting.js';
import { accountId } from '../src/models/ledger.js';
const r2 = (n) => Math.round(n * 100) / 100;
const base = seed();
const eur = search(base, 'res.currency').find((x) => x.name === 'EUR');
const sales = accountId(base, '400000'), other = accountId(base, '410000'), recvA = accountId(base, '121000');
let seedN = 7; const rnd = () => { seedN = (seedN * 16807) % 2147483647; return seedN / 2147483647; };
let found = 0, tries = 0;
while (found < 2 && tries < 500) {
  tries++;
  const lines = [0, 1].map((i) => ({ name: 'l' + i, qty: 1 + Math.floor(rnd() * 5), price_unit: r2(rnd() * 100), tax: 14, account_id: i ? other : sales }));
  const c = create(base, 'account.move', { move_type: 'out_invoice', partner_id: 3, currency_id: eur.id, invoice_date: '2026-10-01', invoice_line_ids: lines });
  let db = postMove(c.db, c.id);
  const m0 = read(db, 'account.move', c.id);
  db = payMove(db, c.id, m0.amount_total, '2026-10-01');
  const m = read(db, 'account.move', c.id);
  const left = r2(search(db, 'account.move').filter((x) => x.state === 'posted' && (x.id === c.id || x.ref === `Payment ${m.name}`)).flatMap((x) => x.line_ids).filter((l) => l.account_id === recvA).reduce((s, l) => s + l.debit - l.credit, 0));
  if (left !== 0) { found++; console.log('try', tries, 'lines', JSON.stringify(lines.map((l) => [l.qty, l.price_unit])), 'EUR total', m0.amount_total, 'state', m.payment_state, 'receivable residue (company ccy)', left); }
}
console.log('searched', tries);
