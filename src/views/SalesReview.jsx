import { useRef, useState } from 'react';
import { read } from '../orm.js';
import { viewRecords } from '../companyView.js';
import { useDb } from '../store.js';
import { t } from '../i18n.js';
import { round } from '../money.js';
import { lineUntaxed } from '../models/taxes.js';
import { qtyToInvoice } from '../models/sales.js';
import { downloadCsv, tableToRows } from '../csv.js';
import { downloadXlsx } from '../xlsx.js';
import { money } from '../ui.jsx';

export function SalesReview({ leaf }) {
  const db = useDb();
  const tableRef = useRef(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [company, setCompany] = useState('');
  const [groupBy, setGroupBy] = useState('');
  const deliveredFirst = leaf.report === 'invoicesToBeIssued';
  const rows = viewRecords(db, 'sale.order').flatMap((order) => {
    if ((deliveredFirst ? order.state !== 'sale' : order.state === 'cancel') || (from && (!order.date_order || order.date_order.slice(0, 10) < from)) || (to && (!order.date_order || order.date_order.slice(0, 10) > to)) || (company && (order.company_id ?? 1) !== Number(company))) return [];
    return (order.order_line ?? []).flatMap((line, index) => {
      if (line.down_payment_key) return [];
      const delivered = Number(line.qty_delivered) || 0;
      const invoiced = Number(line.qty_invoiced) || 0;
      const difference = deliveredFirst ? qtyToInvoice(db, line) : invoiced - delivered;
      if (difference <= 0) return [];
      const unitPrice = Number(line.price_unit) || 0;
      const amount = round(lineUntaxed({ ...line, qty: difference }));
      return [{ order, line, index, delivered, invoiced, difference, unitPrice, amount }];
    });
  });
  const groups = new Map();
  for (const row of rows) {
    const key = groupBy === 'customer' ? row.order.partner_id : groupBy === 'order' ? row.order.id : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const name = leaf.report || 'sales_review';
  const exportXlsx = () => {
    if (!tableRef.current) return;
    const columnTypes = ['text', 'text', 'text', 'text', 'quantity', 'quantity', 'quantity', 'number', 'number'];
    downloadXlsx(`${leaf.report || 'sales_review'}.xlsx`, tableRef.current, { sheetName: t(leaf.label), columnTypes });
  };
  return <main className="action report-page">
    <div className="control-panel"><h1 className="cp-title">{t(leaf.label)}</h1></div>
    <div className="control-panel">
      <label>{t('From')} <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>{t('To')} <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      <label>{t('Company')} <select value={company} onChange={(e) => setCompany(e.target.value)}><option value="">{t('All')}</option>{viewRecords(db, 'res.company').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>{t('Group By')} <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}><option value="">{t('None')}</option><option value="customer">{t('Customer')}</option><option value="order">{t('Order')}</option></select></label>
      <button type="button" className="btn sm" onClick={() => window.print()}>{t('Print')}</button>
      <button type="button" className="btn sm" onClick={() => downloadCsv(`${name}.csv`, tableToRows(tableRef.current))}>{t('Download CSV')}</button>
      <button type="button" className="btn sm" onClick={exportXlsx}>{t('Export XLSX')}</button>
    </div>
    <div className="list-wrap"><table className="list report" ref={tableRef}>
      <thead><tr>{['Order', 'Customer', 'Product', 'Description', 'Delivered', 'Invoiced', 'Difference', 'Unit Price', 'Amount'].map((label, i) => <th key={label} className={i >= 4 ? 'num' : undefined}>{t(label)}</th>)}</tr></thead>
      <tbody>{[...groups.entries()].map(([key, group]) => <ReactGroup key={String(key)} group={group} groupBy={groupBy} db={db} />)}</tbody>
    </table></div>
  </main>;
}

function ReactGroup({ group, groupBy, db }) {
  const first = group[0];
  return <>
    {groupBy && <tr><th colSpan={9}>{groupBy === 'customer' ? read(db, 'res.partner', first.order.partner_id)?.name ?? '' : first.order.name}</th></tr>}
    {group.map(({ order, line, index, delivered, invoiced, difference, unitPrice, amount }) => <tr key={`${order.id}-${index}`}>
      <td><a href={`#/sales/orders/${order.id}`}>{order.name}</a></td>
      <td>{read(db, 'res.partner', order.partner_id)?.name ?? ''}</td>
      <td>{read(db, 'product', line.product_id)?.name ?? ''}</td>
      <td>{line.name}</td><td className="num qty">{delivered}</td><td className="num qty">{invoiced}</td><td className="num qty">{Number(difference.toPrecision(12))}</td>
      <td className="num">{money(unitPrice)}</td><td className="num">{money(amount)}</td>
    </tr>)}
  </>;
}
