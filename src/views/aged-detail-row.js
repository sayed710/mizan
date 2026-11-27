import { createElement } from 'react';
import { read } from '../orm.js';
import { formatCurrency } from '../money.js';

/** One expanded aged-balance detail row, shared by invoice and unapplied payment entries. */
export function AgedDetailRow({ db, buckets, detail, money }) {
  const currency = db && detail.currency_id ? read(db, 'res.currency', detail.currency_id) : null;
  const account = db && detail.account_id ? read(db, 'account.account', detail.account_id) : null;
  return createElement('tr', { className: 'rep-detail' },
    createElement('td', null, createElement('a', { href: `#/open/account.move/${detail.move_id}` }, detail.name)),
    createElement('td', null, detail.invoice_date ?? detail.date ?? ''),
    createElement('td', null, currency?.name ?? ''),
    createElement('td', { className: 'num' }, currency && detail.amount_currency != null ? formatCurrency(detail.amount_currency, currency) : ''),
    createElement('td', null, account ? `${account.code ?? ''} ${account.name ?? ''}`.trim() : ''),
    createElement('td', null, detail.expected_date ?? ''),
    ...buckets.map(([key]) => createElement('td', { key, className: 'num' }, detail[key] ? money(detail[key]) : '')),
    createElement('td', { className: 'num' }, money(detail.total)));
}
