import { create, read, search, write } from '../orm.js';
import { addDays, subtotal, today } from './common.js';
import { dueDate } from './terms.js';
import { accountId } from './ledger.js';
import { rateAt } from './currency.js';
import { purchasePlusModels } from './purchaseplus.js';
import { valuationModels } from './valuation.js';
import { round } from '../money.js';

const number = (n) => Number(n) || 0;
// Services never get a receipt, so they are always billed on ordered quantities.
const method = (p) => (p?.type === 'service' ? 'purchase' : p?.purchase_method ?? 'receive');
const quantities = (l, policy) => {
  const ordered = number(l.qty), received = number(l.qty_delivered), billed = number(l.qty_invoiced);
  return { product_id: l.product_id, ordered, received, billed, toBill: Math.max(0, (policy === 'receive' ? received : ordered) - billed) };
};
const orderFor = (db, bill) => bill.purchase_id ? read(db, 'purchase.order', bill.purchase_id)
  : search(db, 'purchase.order').find((p) => p.name === (bill.origin || bill.invoice_origin));
const previousBills = (db, bill, po) => search(db, 'account.move').filter((m) => m.id !== bill.id && m.move_type === 'in_invoice'
  && m.state === 'posted' && orderFor(db, m)?.id === po.id);
const totalQty = (lines, id) => lines.filter((l) => l.product_id === id).reduce((s, l) => s + number(l.qty), 0);

/** Return each PO line's quantities eligible for billing under its product policy. */
export function billableLines(db, poId) {
  const po = read(db, 'purchase.order', poId);
  if (!po) throw new Error('Purchase order not found');
  return (po.order_line ?? []).map((l) => quantities(l, method(read(db, 'product', l.product_id))));
}

const status = (r, db) => {
  if (r.state !== 'purchase' || !r.order_line?.length) return 'no';
  const lines = r.order_line.map((l) => quantities(l, db ? method(read(db, 'product', l.product_id)) : l.purchase_method ?? 'receive'));
  if (lines.some((l) => l.toBill > 0)) return 'to_invoice';
  return lines.every((l) => l.billed >= l.ordered) ? 'invoiced' : 'no';
};
const policyLines = (db, r) => (r.order_line ?? []).map((l) => ({ ...l, purchase_method: method(read(db, 'product', l.product_id)) }));

function createBill(db, r) {
  const po = read(db, 'purchase.order', r.id);
  if (po?.state !== 'purchase') throw new Error('Confirm the purchase order before creating a bill');
  const eligible = billableLines(db, po.id);
  const lines = po.order_line.map(({ qty_delivered, qty_invoiced, purchase_method, ...l }, i) => ({ ...l, qty: eligible[i].toBill })).filter((l) => l.qty > 0);
  if (!lines.length) throw new Error('Nothing is eligible for billing');
  const term = read(db, 'account.payment.term', po.payment_term_id);
  const out = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: po.partner_id, purchase_id: po.id, invoice_origin: po.name,
    invoice_date: today(), invoice_payment_term_id: term?.id ?? null,
    invoice_date_due: term ? dueDate(term, today()) : addDays(today(), 30),
    currency_id: po.currency_id ?? null, fiscal_position_id: po.fiscal_position_id ?? null, invoice_line_ids: lines,
  });
  const next = write(out.db, 'purchase.order', po.id, { order_line: policyLines(db, po).map((l, i) => ({ ...l, qty_invoiced: number(l.qty_invoiced) + eligible[i].toBill })) });
  return { db: next, go: `#/accounting/bills/${out.id}` };
}

function matches(db, bill) {
  if (bill.move_type !== 'in_invoice') throw new Error('Select a vendor bill');
  const po = orderFor(db, bill);
  if (!po) throw new Error('Link the vendor bill to a purchase order');
  const used = new Map();
  const prior = previousBills(db, bill, po).flatMap((m) => m.invoice_line_ids ?? []);
  return (bill.invoice_line_ids ?? []).map((l) => {
    const source = (po.order_line ?? []).filter((p) => p.product_id === l.product_id);
    const billedQty = number(l.qty);
    const receivedQty = source.reduce((s, p) => s + number(p.qty_delivered), 0);
    const orderedQty = totalQty(source, l.product_id);
    const offset = (used.get(l.product_id) ?? 0) + totalQty(prior, l.product_id);
    let skip = offset, left = billedQty, expected = 0;
    for (const p of source) {
      const available = Math.max(0, number(p.qty) - skip);
      skip = Math.max(0, skip - number(p.qty));
      const take = Math.min(left, available);
      expected += take * number(p.price_unit) * (1 - number(p.discount) / 100);
      left -= take;
    }
    const priceDifference = round(subtotal(l) - expected);
    used.set(l.product_id, (used.get(l.product_id) ?? 0) + billedQty);
    return { product_id: l.product_id, billedQty, receivedQty, orderedQty, priceDifference,
      status: offset + billedQty > receivedQty + 1e-8 ? 'qty_exceeds_received' : Math.abs(priceDifference) >= 0.01 ? 'price_differs' : 'ok' };
  });
}

/** Match a PO-linked vendor bill, including quantities already posted on other bills. */
export function matchBill(db, billId) {
  const bill = read(db, 'account.move', billId);
  if (!bill) throw new Error('Vendor bill not found');
  return matches(db, bill);
}

/** Refuse excess received-policy quantities unless forced; return price warnings. */
export function checkBillMatch(db, bill) {
  if (bill.move_type !== 'in_invoice' || !orderFor(db, bill)) return [];
  const rows = matches(db, bill);
  if (!bill.force_post && rows.some((l) => l.status === 'qty_exceeds_received' && method(read(db, 'product', l.product_id)) === 'receive')) {
    throw new Error('Billed quantity exceeds received quantity; receive the goods or enable force post');
  }
  return rows.filter((l) => Math.abs(l.priceDifference) >= 0.01);
}

/** Balanced company-currency adjustments to append to invoiceLines, using receipt interim values. */
export function priceDifferenceLines(db, bill) {
  const po = bill.move_type === 'in_invoice' && orderFor(db, bill);
  if (!po) return [];
  const prior = previousBills(db, bill, po).flatMap((m) => m.invoice_line_ids ?? []);
  const used = new Map();
  const rate = rateAt(db, bill.currency_id, bill.invoice_date ?? today(), bill.company_id);
  const result = [];
  for (const l of bill.invoice_line_ids ?? []) {
    const p = read(db, 'product', l.product_id);
    if (p?.type !== 'goods' || p.valuation === 'manual_periodic' || (l.account_id && l.account_id !== accountId(db, '110200'))) continue;
    let skip = totalQty(prior, p.id) + (used.get(p.id) ?? 0), left = number(l.qty), value = 0;
    const layers = search(db, 'stock.valuation.layer').filter((v) => {
      const picking = read(db, 'stock.picking', v.picking_id);
      return v.product_id === p.id && v.kind === 'in' && v.quantity > 0 && picking?.state === 'done'
        && (picking.purchase_id ? picking.purchase_id === po.id : picking.origin === po.name);
    }).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    for (const layer of layers) {
      const take = Math.min(left, Math.max(0, layer.quantity - skip));
      const start = Math.min(layer.quantity, skip);
      const interim = number(layer.value) + number(layer.price_difference);
      value += round(interim * (start + take) / layer.quantity) - round(interim * start / layer.quantity);
      skip = Math.max(0, skip - layer.quantity);
      left -= take;
    }
    used.set(p.id, (used.get(p.id) ?? 0) + number(l.qty));
    const difference = round(round(subtotal(l) / rate) - round(value + (number(l.qty) ? subtotal(l) * left / number(l.qty) / rate : 0)));
    if (!difference) continue;
    if (!accountId(db, '110200') || !accountId(db, '600000')) throw new Error('Configure stock interim and expense accounts first');
    result.push(
      { account_id: accountId(db, '110200'), partner_id: bill.partner_id, name: 'Price Difference', debit: difference < 0 ? -difference : 0, credit: difference > 0 ? difference : 0 },
      { account_id: accountId(db, '600000'), partner_id: bill.partner_id, name: 'Price Difference', debit: difference > 0 ? difference : 0, credit: difference < 0 ? -difference : 0 },
    );
  }
  return result;
}

const BILL_POLICY = { type: 'selection', label: 'Bill Control', options: [['purchase', 'Ordered Quantities'], ['receive', 'Received Quantities']] };

export const billControlModels = {
  get product() {
    const product = valuationModels.product;
    return { ...product, fields: { ...product.fields,
      purchase_method: BILL_POLICY,
    }, defaults: (id) => ({ ...product.defaults?.(id), purchase_method: 'receive' }),
    onchange: (r, key, db) => ({ ...product.onchange?.(r, key, db), ...(key === 'type' ? { purchase_method: r.type === 'service' ? 'purchase' : 'receive' } : {}) }),
    form: { ...product.form, groups: [...product.form.groups, ['purchase_method']] } };
  },
  get 'purchase.order'() {
    const purchase = purchasePlusModels['purchase.order'];
    return { ...purchase,
      fields: { ...purchase.fields,
        invoice_status: { ...purchase.fields.invoice_status, compute: status },
        order_line: { ...purchase.fields.order_line, fields: { ...purchase.fields.order_line.fields, purchase_method: { ...BILL_POLICY, readonly: true, hidden: true } } },
      },
      onchange: (r, key, db) => ({ ...purchase.onchange?.(r, key, db), ...(['order_line', 'state'].includes(key) ? { order_line: policyLines(db, r) } : {}) }),
      form: { ...purchase.form, buttons: purchase.form.buttons.map((b) => b.label === 'Create Bill'
        ? { ...b, when: (r, db) => (r.invoice_status ?? status(r, db)) === 'to_invoice', run: createBill }
        : b.label === 'Confirm Order' ? { ...b, run: (db, r) => b.run(write(db, 'purchase.order', r.id, { order_line: policyLines(db, r) }), r) } : b) },
    };
  },
};
