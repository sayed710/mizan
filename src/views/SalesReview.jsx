import { read } from '../orm.js';
import { viewRecords } from '../companyView.js';
import { useDb } from '../store.js';
import { t } from '../i18n.js';
import { round } from '../money.js';
import { lineUntaxed } from '../models/taxes.js';
import { money } from '../ui.jsx';

/** Compare the recorded delivery and invoice quantities on each sales line. */
export function SalesReview({ leaf }) {
  const db = useDb();
  const deliveredFirst = leaf.report === 'invoicesToBeIssued';
  const rows = viewRecords(db, 'sale.order').flatMap((order) => {
    if (order.state === 'cancel') return [];
    return (order.order_line ?? []).flatMap((line, index) => {
      if (line.down_payment_key) return [];
      const delivered = Number(line.qty_delivered) || 0;
      const invoiced = Number(line.qty_invoiced) || 0;
      const difference = deliveredFirst ? delivered - invoiced : invoiced - delivered;
      if (difference <= 0) return [];
      const unitPrice = Number(line.price_unit) || 0;
      const amount = round(lineUntaxed({ ...line, qty: difference }));
      return [{ order, line, index, delivered, invoiced, difference, unitPrice, amount }];
    });
  });
  return <main className="action report-page">
    <div className="control-panel"><h1 className="cp-title">{t(leaf.label)}</h1></div>
    <div className="list-wrap"><table className="list report">
      <thead><tr>{['Order', 'Customer', 'Product', 'Description', 'Delivered', 'Invoiced', 'Difference', 'Unit Price', 'Amount'].map((label) => <th key={label}>{t(label)}</th>)}</tr></thead>
      <tbody>{rows.map(({ order, line, index, delivered, invoiced, difference, unitPrice, amount }) => <tr key={`${order.id}-${index}`}>
        <td><a href={`#/sales/orders/${order.id}`}>{order.name}</a></td>
        <td>{read(db, 'res.partner', order.partner_id)?.name ?? ''}</td>
        <td>{read(db, 'product', line.product_id)?.name ?? ''}</td>
        <td>{line.name}</td><td>{delivered}</td><td>{invoiced}</td><td>{Number(difference.toPrecision(12))}</td>
        <td className="num">{money(unitPrice)}</td><td className="num">{money(amount)}</td>
      </tr>)}</tbody>
    </table></div>
  </main>;
}
