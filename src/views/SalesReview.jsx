import { read } from '../orm.js';
import { viewRecords } from '../companyView.js';
import { useDb } from '../store.js';
import { t } from '../i18n.js';

/** Compare the recorded delivery and invoice quantities on each sales line. */
export function SalesReview({ leaf }) {
  const db = useDb();
  const deliveredFirst = leaf.report === 'invoicesToBeIssued';
  const rows = viewRecords(db, 'sale.order').flatMap((order) => (order.order_line ?? []).flatMap((line, index) => {
    const delivered = Number(line.qty_delivered) || 0;
    const invoiced = Number(line.qty_invoiced) || 0;
    const difference = deliveredFirst ? delivered - invoiced : invoiced - delivered;
    return difference > 0 ? [{ order, line, index, delivered, invoiced, difference }] : [];
  }));
  return <main className="action report-page">
    <div className="control-panel"><h1 className="cp-title">{t(leaf.label)}</h1></div>
    <div className="list-wrap"><table className="list report">
      <thead><tr>{['Order', 'Customer', 'Product', 'Description', 'Delivered', 'Invoiced', 'Difference'].map((label) => <th key={label}>{t(label)}</th>)}</tr></thead>
      <tbody>{rows.map(({ order, line, index, delivered, invoiced, difference }) => <tr key={`${order.id}-${index}`}>
        <td><a href={`#/sales/orders/${order.id}`}>{order.name}</a></td>
        <td>{read(db, 'res.partner', order.partner_id)?.name ?? ''}</td>
        <td>{read(db, 'product', line.product_id)?.name ?? ''}</td>
        <td>{line.name}</td><td>{delivered}</td><td>{invoiced}</td><td>{Number(difference.toPrecision(12))}</td>
      </tr>)}</tbody>
    </table></div>
  </main>;
}
