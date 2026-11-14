import { create, read, search, write } from '../src/orm.js';
import { models } from '../src/models/index.js';
import { seed } from '../src/seed.js';
import { createCompany, ensureMainCompany } from '../src/models/company.js';
import { postEntry } from '../src/models/ledger.js';
import { consolidate } from '../src/models/consolidation.js';
const r2 = (n) => Math.round(n * 100) / 100;
function fixture(method = 'full', ownership = 100) {
  let db = ensureMainCompany(seed());
  const group = create(db, 'res.currency', { name: 'GROUP', rate_ids: [{ date: '2090-01-01', rate: 1 }] });
  const source = create(group.db, 'res.currency', { name: 'SOURCE', rate_ids: [{ date: '2090-01-01', rate: 2 }, { date: '2090-01-02', rate: 4 }] });
  db = createCompany(source.db, { name: 'Parent', currency_id: group.id }).db;
  const parent = search(db, 'res.company').at(-1).id;
  const sub = createCompany(db, { name: 'Subsidiary', currency_id: source.id });
  const child = sub.id;
  const chart = create(sub.db, 'consolidation.chart', { name: 'Group', currency_id: group.id,
    company_ids: [{ company_id: parent, ownership: 100, method: 'full' }, { company_id: child, ownership, method }],
    account_ids: [
      { code: 'CASH', name: 'Cash', account_type: 'asset_cash', source_codes: '101401, 101501' },
      { code: 'AR', name: 'Receivables', account_type: 'asset_receivable', source_codes: '121000' },
      { code: 'AP', name: 'Payables', account_type: 'liability_payable', source_codes: '211000' },
      { code: 'CAP', name: 'Capital', account_type: 'equity', source_codes: '301000' },
      { code: 'SALES', name: 'Sales', account_type: 'income', source_codes: '400000' },
      { code: 'COST', name: 'Expenses', account_type: 'expense', source_codes: '600000' },
    ] });
  const period = create(chart.db, 'consolidation.period', { name: 'Jan', chart_id: chart.id, date_from: '2090-01-01', date_to: '2090-01-02' });
  return { db: period.db, id: period.id, parent, child };
}
const entry = (db, company_id, date, lines) => { const p = postEntry(db, { journal: 'MISC', date, lines }); return write(p.db, 'account.move', p.id, { company_id }); };
for (const [method, own] of [['full', 100], ['full', 60], ['proportional', 60], ['equity', 30]]) {
  const f = fixture(method, own);
  let db = entry(f.db, f.child, '2089-06-30', [{ account: '101401', debit: 1000 }, { account: '301000', credit: 1000 }]); // capital, prior year
  db = entry(db, f.child, '2089-12-31', [{ account: '101401', debit: 300 }, { account: '400000', credit: 300 }]); // prior-year profit
  db = entry(db, f.child, '2090-01-01', [{ account: '101401', debit: 200 }, { account: '400000', credit: 200 }]); // current sale
  db = entry(db, f.parent, '2090-01-02', [{ account: '101401', debit: 50 }, { account: '400000', credit: 50 }]);
  const res = consolidate(db, f.id);
  const sum = r2(res.lines.reduce((s, l) => s + l.total, 0));
  console.log(method, own + '%', '-> lines', JSON.stringify(res.lines.map((l) => [l.group_code, l.total])), '| sum of all group balances (should be 0):', sum, '| unmapped', res.unmapped);
}
