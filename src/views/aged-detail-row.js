import { createElement } from 'react';

/** One expanded aged-balance detail row, shared by invoice and unapplied payment entries. */
export function AgedDetailRow({ buckets, detail, money }) {
  return createElement('tr', { className: 'rep-detail' },
    createElement('td', null, createElement('a', { href: `#/open/account.move/${detail.move_id}` }, detail.name)),
    ...buckets.map(([key]) => createElement('td', { key, className: 'num' }, detail[key] ? money(detail[key]) : '')),
    createElement('td', { className: 'num' }, money(detail.total)));
}
