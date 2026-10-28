// Accounting invariants on generated scenarios (not only the seed), with every step applied through applyDiff,
// the path the server uses: random invoices, partial payments and credit notes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { create, search } from './orm.js';
import { applyDiff, diffDb } from './sync.js';
import { accountId, balanceSheet, balances, isBalanced, journalItems } from './models/ledger.js';
import { payMove, postMove } from './models/accounting.js';
import { models } from './models/index.js';
import { seed } from './seed.js';

const round = (n) => Math.round(n * 100) / 100 + 0; // + 0 turns -0 into 0
/** Small seeded PRNG (mulberry32) so a failing scenario can be replayed from its seed. */
const rng = (seedValue) => () => {
  let t = (seedValue += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const viaServer = (db, next) => applyDiff(db, diffDb(db, next), { author: 'test', isAdmin: true });
const open = (db, type) => search(db, 'account.move').filter((m) => m.move_type === type && m.state === 'posted' && m.amount_residual > 0.005);

function step(db, rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const roll = rand();
  if (roll < 0.5 || !open(db, 'out_invoice').length) {
    const lines = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => ({ product_id: 1, qty: 1 + Math.floor(rand() * 5), price_unit: round(10 + rand() * 990), tax: pick([0, 14]) }));
    const { db: drafted, id } = create(db, 'account.move', { move_type: 'out_invoice', partner_id: pick([3, 5]), invoice_line_ids: lines });
    return postMove(drafted, id);
  }
  const inv = pick(open(db, 'out_invoice'));
  if (roll < 0.85) return payMove(db, inv.id, round(Math.max(0.01, inv.amount_residual * (rand() < 0.5 ? 1 : rand()))));
  const credit = models['account.move'].form.buttons.find((b) => b.label === 'Credit Note').run(db, inv).db;
  return postMove(credit, search(credit, 'account.move').at(-1).id);
}

for (const scenario of [1, 2, 3, 4, 5]) {
  test(`posted entries stay balanced and the receivable ledger matches open invoices (seed ${scenario})`, () => {
    const rand = rng(scenario);
    let db = seed();
    for (let i = 0; i < 25; i += 1) db = viaServer(db, step(db, rand));
    // the scenario really mixes payments and credit notes in with the invoices
    assert.ok(search(db, 'account.payment').length > search(seed(), 'account.payment').length);
    assert.ok(search(db, 'account.move').some((m) => m.move_type === 'out_refund' && m.state === 'posted'));
    for (const m of search(db, 'account.move').filter((x) => x.state === 'posted')) assert.ok(isBalanced(m.line_ids), `${m.name} unbalanced`);
    const trial = balances(db, journalItems(db));
    assert.equal(round(trial.reduce((s, b) => s + b.balance, 0)), 0);
    const b = balanceSheet(db);
    assert.equal(round(b.totalAssets), round(b.totalLiabilities + b.totalEquity));
    const ar = trial.find((x) => x.account.id === accountId(db, '121000'))?.balance ?? 0;
    const residual = (type) => search(db, 'account.move').filter((m) => m.move_type === type && m.state === 'posted').reduce((s, m) => s + (m.amount_residual ?? 0), 0);
    assert.equal(round(ar), round(residual('out_invoice') - residual('out_refund')));
  });
}
