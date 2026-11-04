import { models } from '../src/models/index.js';
import { read, search } from '../src/orm.js';
import { journalItems, balanceSheet, profitAndLoss, accountId } from '../src/models/ledger.js';
import { trialBalance, cashFlow } from '../src/models/reports.js';
export const r2 = (n) => Math.round(n * 100) / 100;
export const button = (model, label) => models[model].form.buttons.find((b) => b.label === label);
export const press = (db, model, id, label) => {
  const b = button(model, label);
  if (!b) throw new Error('no button ' + label);
  return b.run(db, read(db, model, id)).db ?? b.run(db, read(db, model, id));
};
export function invariants(db, tag = '') {
  const posted = (db.records['account.move'] ?? []).filter((m) => m.state === 'posted');
  const unbalanced = posted.filter((m) => r2((m.line_ids ?? []).reduce((s, l) => s + (+l.debit || 0) - (+l.credit || 0), 0)) !== 0);
  const nullAcct = posted.flatMap((m) => (m.line_ids ?? []).filter((l) => !read(db, 'account.account', l.account_id)).map(() => m.name));
  const items = journalItems(db);
  const D = r2(items.reduce((s, l) => s + (+l.debit || 0), 0));
  const C = r2(items.reduce((s, l) => s + (+l.credit || 0), 0));
  const tb = trialBalance(db);
  const bs = balanceSheet(db, '2999-12-31');
  const cf = cashFlow(db, {});
  const recvGL = r2(items.filter((l) => l.account_id === accountId(db, '121000')).reduce((s, l) => s + (+l.debit || 0) - (+l.credit || 0), 0));
  const recvSub = r2(search(db, 'account.move').filter((m) => m.state === 'posted' && m.move_type === 'out_invoice').reduce((s, m) => s + m.amount_residual, 0)
    - search(db, 'account.move').filter((m) => m.state === 'posted' && m.move_type === 'out_refund').reduce((s, m) => s + m.amount_residual, 0));
  const payGL = r2(-items.filter((l) => l.account_id === accountId(db, '211000')).reduce((s, l) => s + (+l.debit || 0) - (+l.credit || 0), 0));
  const paySub = r2(search(db, 'account.move').filter((m) => m.state === 'posted' && m.move_type === 'in_invoice').reduce((s, m) => s + m.amount_residual, 0)
    - search(db, 'account.move').filter((m) => m.state === 'posted' && m.move_type === 'in_refund').reduce((s, m) => s + m.amount_residual, 0));
  const out = {
    tag, postedMoves: posted.length, unbalancedMoves: unbalanced.map((m) => m.name), linesWithUnknownAccount: nullAcct.length,
    sumDebit: D, sumCredit: C, diff: r2(D - C),
    trialBalanceTotals: tb.totals,
    BS: { assets: bs.totalAssets, liabilities: bs.totalLiabilities, equity: bs.totalEquity, earnings: bs.earnings, gap: r2(bs.totalAssets - bs.totalLiabilities - bs.totalEquity) },
    cashFlow: { net: cf.net, sections: r2(cf.operating + cf.investing + cf.financing), gap: r2(cf.net - (cf.operating + cf.investing + cf.financing)) },
    receivable: { GL: recvGL, subledger: recvSub, gap: r2(recvGL - recvSub) },
    payable: { GL: payGL, subledger: paySub, gap: r2(payGL - paySub) },
  };
  return out;
}
