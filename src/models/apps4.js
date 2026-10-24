// Equity (cap table), Data Recycle (archive stale records).
import { search, write } from '../orm.js';
import { addDays, today } from './common.js';
import { models } from './index.js';

/** Shares held per shareholder from the transaction log (issuances add, transfers move, buy-backs remove). */
export function capTable(db) {
  const held = new Map();
  const add = (id, n) => id && held.set(id, (held.get(id) ?? 0) + n);
  for (const tx of search(db, 'equity.transaction').filter((x) => x.state === 'posted')) {
    if (tx.kind === 'issuance') add(tx.to_id, tx.shares);
    if (tx.kind === 'transfer') { add(tx.from_id, -tx.shares); add(tx.to_id, tx.shares); }
    if (tx.kind === 'buyback') add(tx.from_id, -tx.shares);
  }
  const total = [...held.values()].reduce((s, n) => s + n, 0);
  return [...held].filter(([, n]) => n > 0).map(([partner_id, shares]) => ({ partner_id, shares, pct: total ? Math.round((shares / total) * 10000) / 100 : 0 }));
}

const fieldsOf = (model) => models[model]?.fields ?? {};

/** Records of the rule's model whose date field is older than the threshold (and still active). */
export function staleRecords(db, rule) {
  if (!models[rule.res_model] || fieldsOf(rule.res_model)[rule.date_field]?.type !== 'date') return [];
  const limit = addDays(today(), -(Number(rule.days) || 0));
  return search(db, rule.res_model).filter((r) => r[rule.date_field] && r[rule.date_field] < limit);
}

export const apps4Models = {
  'equity.transaction': {
    label: 'Equity Transactions',
    fields: {
      name: { type: 'char', label: 'Description', required: true },
      kind: { type: 'selection', label: 'Type', options: [['issuance', 'Issuance'], ['transfer', 'Transfer'], ['buyback', 'Buy-back']] },
      date: { type: 'date', label: 'Date' },
      from_id: { type: 'many2one', relation: 'res.partner', label: 'Seller' },
      to_id: { type: 'many2one', relation: 'res.partner', label: 'Buyer / Holder' },
      share_class: { type: 'selection', label: 'Share Class', options: [['ordinary', 'Ordinary'], ['preferred', 'Preferred']] },
      shares: { type: 'integer', label: 'Shares' },
      price_per_share: { type: 'monetary', label: 'Price per Share' },
      amount: { type: 'monetary', label: 'Amount', compute: (r) => (Number(r.shares) || 0) * (Number(r.price_per_share) || 0) },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['posted', 'Posted']] },
    },
    defaults: () => ({ kind: 'issuance', date: today(), share_class: 'ordinary', shares: 0, price_per_share: 1, state: 'draft' }),
    groupBys: ['kind', 'share_class', 'to_id', 'date'],
    kanban: { groupBy: 'kind', title: 'name', lines: ['to_id', 'shares', 'amount'] },
    list: ['date', 'name', 'kind', 'from_id', 'to_id', 'shares', 'amount', 'state'],
    views: ['list', 'kanban', 'pivot'],
    pivot: { row: 'to_id', col: 'kind', measure: 'shares' },
    form: {
      statusbar: 'state',
      lockedWhen: (r) => r.state === 'posted',
      buttons: [{
        label: 'Post', primary: true, when: (r) => r.state === 'draft',
        run: (db, r) => {
          if (!(r.shares > 0)) throw new Error('Shares must be positive');
          if (r.kind !== 'issuance') {
            const held = capTable(db).find((h) => h.partner_id === r.from_id)?.shares ?? 0;
            if (held < r.shares) throw new Error('The seller does not hold enough shares');
          }
          return { db: write(db, 'equity.transaction', r.id, { state: 'posted' }) };
        },
      }],
      title: 'name',
      groups: [['kind', 'date', 'share_class'], ['from_id', 'to_id', 'shares', 'price_per_share', 'amount']],
      chatter: true,
    },
  },

  'data.recycle': {
    label: 'Recycle Rules',
    fields: {
      name: { type: 'char', label: 'Rule', required: true },
      res_model: { type: 'char', label: 'Model (technical name)', required: true },
      date_field: { type: 'char', label: 'Date Field', required: true },
      days: { type: 'integer', label: 'Older than (days)' },
      last_run: { type: 'date', label: 'Last Run', readonly: true },
      last_count: { type: 'integer', label: 'Archived Last Run', readonly: true },
    },
    defaults: () => ({ days: 365 }),
    kanban: { title: 'name', lines: ['res_model', 'days', 'last_count'] },
    list: ['name', 'res_model', 'date_field', 'days', 'last_run', 'last_count'],
    views: ['list', 'kanban'],
    form: {
      buttons: [
        { label: 'Preview', run: (db, r) => { alert(`${staleRecords(db, r).length} record(s) match`); return { db }; } },
        {
          label: 'Archive Matching', primary: true,
          run: (db, r) => {
            const stale = staleRecords(db, r);
            const next = stale.reduce((acc, rec) => write(acc, r.res_model, rec.id, { active: false }), db);
            return { db: write(next, 'data.recycle', r.id, { last_run: today(), last_count: stale.length }) };
          },
        },
      ],
      title: 'name',
      groups: [['res_model', 'date_field', 'days'], ['last_run', 'last_count']],
      chatter: true,
    },
  },
};
