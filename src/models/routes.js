// Procurement routes (make-to-order buy/manufacture, dropship), storage locations and landed costs.
import { create, read, search, write } from '../orm.js';
import { today } from './common.js';
import { postEntry, postedBillLine } from './ledger.js';
import { costMethod } from './valuation.js';
import { productProperty } from './productconfig-helpers.js';
import { allocateCents, round } from '../money.js';
import { getForecast, orderOrderpoints } from './orderpoint.js';
import { rateAt } from './currency.js';
import { convert, convertPrice, lineToStockQty, uomForLegacy } from './uom.js';

const stableValue = (value) => JSON.stringify(value ?? null, (key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);


/** Select a route by sale line, package, product, then nearest product category. */
export function routeAction(db, product, line = {}) {
  if (['stock', 'mto_buy', 'mto_make', 'dropship'].includes(line.procurement_route)) return line.procurement_route;
  const pkg = line.package_id && read(db, 'stock.quant.package', line.package_id);
  if (line.package_id && !pkg) throw new Error('Select an existing package');
  let category = read(db, 'product.category', product.categ_id);
  const seen = new Set();
  let categoryRoute;
  while (category && !seen.has(category.id)) {
    seen.add(category.id);
    if (category.route_id) { categoryRoute = category.route_id; break; }
    category = read(db, 'product.category', category.parent_id);
  }
  const id = line.route_id || pkg?.route_id || product.route_id || categoryRoute;
  if (!id) return product.route || 'stock';
  const route = read(db, 'stock.route', id);
  if (!route || route.active === false) throw new Error('Select an active route');
  const categoryIds = new Set();
  for (let c = read(db, 'product.category', product.categ_id); c && !categoryIds.has(c.id); c = read(db, 'product.category', c.parent_id)) categoryIds.add(c.id);
  const rule = [...(route.rule_ids ?? [])].filter((r) => (!r.product_id || r.product_id === product.id) && (!r.categ_id || categoryIds.has(r.categ_id)) && (!r.package_id || r.package_id === line.package_id)).sort((a, b) => Number(a.sequence ?? 10) - Number(b.sequence ?? 10))[0];
  if (!rule || !['stock', 'mto_buy', 'mto_make', 'dropship'].includes(rule.action)) throw new Error('The selected route has no applicable rule');
  return rule.action;
}

/**
 * On sale confirmation, apply each product's route:
 * - stock (default): served from stock by the delivery order;
 * - mto_buy: an RFQ to the product vendor for the ordered quantity;
 * - mto_make: a manufacturing order (with the product's BoM) for the ordered quantity;
 * - dropship: an RFQ to the vendor shipped straight to the customer (no delivery from our stock).
 * Returns { db, stockLines } where stockLines still go through our warehouse.
 */
export function procure(db, order) {
  let next = db;
  const stockLines = [];
  const rfqs = new Map(); // vendor → lines, for MTO buy and dropship (kept separate)
  for (const [lineIndex, line] of (order.order_line ?? []).entries()) {
    const p = read(next, 'product', line.product_id);
    if (!p || p.type !== 'goods') { stockLines.push(line); continue; }
    const route = routeAction(next, p, line);
    const demand = Number(line.qty) || 0;
    const stockUnit = p.uom_id ?? uomForLegacy(next, p.uom || 'unit')?.id;
    const purchasePrice = line.uom_id && stockUnit ? convertPrice(next, Number(p.cost) || 0, stockUnit, line.uom_id) : Number(p.cost) || 0;
    if (route === 'dropship') {
      if (!p.vendor_id) throw new Error(`${p.name}: set a vendor to dropship`);
      const key = `drop:${p.vendor_id}`;
      rfqs.set(key, [...(rfqs.get(key) ?? []), { product_id: p.id, qty: line.qty, price_unit: purchasePrice, tax: 14, so_line: lineIndex, ...(line.uom_id ? { uom_id: line.uom_id } : {}) }]);
      continue;
    }
    stockLines.push(line);
    if (!(demand > 0)) continue;
    if (route === 'mto_buy') {
      if (!p.vendor_id) throw new Error(`${p.name}: set a vendor to buy on order`);
      const key = `buy:${p.vendor_id}`;
      rfqs.set(key, [...(rfqs.get(key) ?? []), { product_id: p.id, qty: demand, price_unit: purchasePrice, tax: 14, so_line: lineIndex, ...(line.uom_id ? { uom_id: line.uom_id } : {}) }]);
    } else if (route === 'mto_make') {
      const bom = search(next, 'mrp.bom').find((b) => b.product_id === p.id);
      if (!bom) throw new Error(`${p.name}: create a bill of materials to manufacture on order`);
      next = create(next, 'mrp.production', { product_id: p.id, bom_id: bom.id, product_qty: lineToStockQty(next, line, p), state: 'draft', origin: order.name, sale_id: order.id, so_line: lineIndex, company_id: order.company_id }).db;
    }
  }
  for (const [key, lines] of rfqs) {
    const [kind, vendor] = key.split(':');
    next = create(next, 'purchase.order', {
      partner_id: Number(vendor), order_line: lines, origin: order.name,
      dropship_partner_id: kind === 'drop' ? (order.partner_shipping_id ?? order.partner_id) : null, sale_id: order.id,
      company_id: order.company_id,
    }).db;
  }
  return { db: next, stockLines };
}

/** Best vendor pricelist line for a product: valid dates, min quantity, then sequence and price. */
export function vendorPrice(db, productId, { partnerId, qty = 1, date = today(), currencyId = null, companyId = null, uomId = null } = {}) {
  const product = read(db, 'product', productId);
  const orderUnit = uomId ?? product?.uom_po_id ?? product?.uom_id ?? uomForLegacy(db, product?.uom ?? 'unit')?.id;
  const info = search(db, 'product.supplierinfo').filter((s) => s.product_id === productId && (!partnerId || s.partner_id === partnerId)
    && Number(s.min_qty ?? 0) <= (s.uom_id && orderUnit ? convert(db, qty, orderUnit, s.uom_id, { round: false }) : qty)
    && (!s.date_start || s.date_start <= date) && (!s.date_end || s.date_end >= date))
    .sort((a, b) => Number(a.sequence ?? 10) - Number(b.sequence ?? 10) || Number(a.price) - Number(b.price) || a.id - b.id)[0];
  if (!info) return null;
  const legacyCurrency = info.currency && search(db, 'res.currency').find((c) => c.name === info.currency);
  const sourceCurrency = info.currency_id ?? legacyCurrency?.id ?? null;
  if (info.currency && !sourceCurrency && info.currency !== (db.settings?.currency ?? 'USD')) throw new Error(`Currency ${info.currency} not found`);
  const unitPrice = info.uom_id && orderUnit ? convertPrice(db, info.price, info.uom_id, orderUnit) : Number(info.price);
  const price = unitPrice / rateAt(db, sourceCurrency, date, companyId) * rateAt(db, currencyId, date, companyId);
  return { price, delay: Number(info.delay ?? 0), partner_id: info.partner_id };
}

/**
 * Reordering rules: order active auto-triggered rules whose forecast quantity
 * falls below the rule's minimum, bringing forecast up to the maximum.
 */
export function replenish(db, at = today()) {
  const orderpoints = search(db, 'stock.warehouse.orderpoint').filter(
    (op) => op.active !== false && op.trigger === 'auto' && (!op.snoozed_until || op.snoozed_until <= at),
  );

  const toOrder = orderpoints.filter(
    (op) => getForecast(db, op) < op.product_min_qty || (op.qty_to_order_manual != null && Number(op.qty_to_order_manual) > 0),
  );
  if (!toOrder.length) return db;

  return orderOrderpoints(db, toOrder.map((op) => op.id));
}

/** Cost reclassification, difference and capitalization lines shared across periodic and perpetual landed costs. */
function landedCostEntryLines(db, lc, group, { stock, expense, capitalized, expensed, isPeriodic }) {
  const entryLines = [];
  for (const c of group.costs) {
    if (!isPeriodic && !lc.bill_id && !c.recognized_account_id) continue;
    const costAccount = read(db, 'account.account', c.account_id);
    const costCode = costAccount?.code;
    const isExpense = ['expense', 'expense_direct_cost', 'expense_other'].includes(costAccount?.account_type);
    // Bill-linked costs reclassify the posted amount to the selected account,
    // regardless of its type. Manual costs retain their existing expense treatment.
    const debitAccount = c.recognized_account_id ? costCode : (isPeriodic ? (isExpense ? costCode : expense) : (costCode || expense));
    const originalCode = read(db, 'account.account', c.recognized_account_id)?.code;
    if (c.recognized && originalCode && originalCode !== debitAccount) {
      entryLines.push({ account: originalCode, credit: c.recognized }, { account: debitAccount, debit: c.recognized });
    }
    const difference = round(c.amount - c.recognized);
    if (!difference) continue;
    const creditAccount = !lc.bill_id && !c.recognized_account_id && !isExpense && costCode && costCode !== '110200' ? costCode : '211000';
    const value = Math.abs(difference);
    entryLines.push(
      difference > 0 ? { account: debitAccount, debit: value } : { account: debitAccount, credit: value },
      difference > 0 ? { account: creditAccount, credit: value } : { account: creditAccount, debit: value },
    );
  }
  if (!isPeriodic) {
    const credits = group.costs.filter((c) => c.amount).map((c) => ({
      account: read(db, 'account.account', c.account_id)?.code || (lc.bill_id ? expense : '211000'),
      credit: c.amount,
    }));
    entryLines.push(
      ...(capitalized ? [{ account: stock, debit: capitalized }] : []),
      ...(expensed ? [{ account: expense, debit: expensed }] : []),
      ...credits,
    );
  }
  return entryLines;
}

/** Allocate each cost line to receipt-specific layers, recognizing the consumed share as expense. */
export function applyLandedCost(db, lc) {
  if (lc.state === 'done') throw new Error('These landed costs are already posted');
  const ids = [...new Set([...(lc.picking_ids ?? []), lc.picking_id].filter(Boolean))];
  const pickings = ids.map((id) => read(db, 'stock.picking', id));
  if (!pickings.length || pickings.some((p) => !p || p.state !== 'done' || p.picking_type !== 'incoming' || (p.company_id ?? 1) !== (lc.company_id ?? 1))) throw new Error('Select validated receipts in the same company');
  const groups = new Map();
  for (const picking of pickings) for (const move of picking.move_ids ?? []) {
    const product = read(db, 'product', move.product_id);
    if (!product || product.type !== 'goods') continue;
    const key = `${picking.id}:${product.id}`;
    const group = groups.get(key) ?? { picking, product, qty: 0, amount: 0, costs: [] };
    group.qty += Number(move.qty) || 0; groups.set(key, group);
  }
  const targets = [...groups.values()];
  if (!targets.length || !(lc.cost_lines ?? []).length) throw new Error('Nothing to allocate');
  for (const group of targets) {
    const isPeriodic = ['manual_periodic', 'periodic'].includes(productProperty(db, group.product, 'property_valuation'));
    group.isPeriodic = isPeriodic;
    group.layers = isPeriodic ? [] : (db.records['stock.valuation.layer'] ?? []).filter((l) => l.picking_id === group.picking.id && l.product_id === group.product.id && l.kind === 'in' && l.quantity > 0);
    if (!isPeriodic && !group.layers.length) throw new Error('The selected receipt has no valuation history');
  }
  let total = 0;
  const bill = lc.bill_id && read(db, 'account.move', lc.bill_id);
  const sources = new Set();
  for (const cost of lc.cost_lines) {
    let recognized = 0;
    let recognizedAccount = null;
    if (cost.source_bill_line != null) {
      const index = cost.source_bill_line;
      const line = Number.isInteger(index) && index >= 0 ? bill?.invoice_line_ids?.[index] : null;
      const posted = line && postedBillLine(bill, index);
      if (!posted || cost.source_bill_amount !== posted.amount || cost.source_bill_account_id !== posted.account) throw new Error('Invalid landed cost bill-line source');
      const { account, amount: original } = posted;
      if (bill?.state !== 'posted' || bill.move_type !== 'in_invoice' || (bill.company_id ?? 1) !== (lc.company_id ?? 1) || !line || sources.has(index)) throw new Error('Invalid or duplicate landed cost bill-line source');
      const alreadyUsed = (db.records['stock.landed.cost'] ?? []).some((other) => other.id !== lc.id && other.state === 'done' && other.bill_id === lc.bill_id && (other.cost_lines ?? []).some((item) => item.source_bill_line === index));
      if (alreadyUsed) throw new Error('Bill-line source already recognized by another landed cost');
      sources.add(index);
      if (!cost.account_id || !read(db, 'account.account', cost.account_id)) throw new Error('Select an account for each bill-linked cost line');
      recognized = original;
      recognizedAccount = account;
    }
    const amount = Number(cost.amount);
    if (!Number.isFinite(amount) || (amount < 0 && cost.source_bill_line == null)) throw new Error('Enter a nonnegative cost unless it is linked to a bill line');
    total = round(total + amount);
    const method = cost.split_method || 'quantity';
    const weights = targets.map(({ product, qty, layers, isPeriodic }) => method === 'equal' ? 1 : method === 'quantity' ? qty
      : method === 'value' ? (isPeriodic ? qty * (Number(product.cost) || 0) : layers.reduce((sum, layer) => sum + layer.value, 0))
        : method === 'weight' ? qty * (Number(product.weight) || 0) : method === 'volume' ? qty * (Number(product.volume) || 0) : NaN);
    const shares = allocateCents(amount, weights);
    const recognizedShares = allocateCents(recognized, weights);
    for (const [i, group] of targets.entries()) {
      group.amount = round(group.amount + shares[i]);
      group.costs.push({ amount: shares[i], recognized: recognizedShares[i], recognized_account_id: recognizedAccount, account_id: cost.account_id });
    }
  }
  const receiptTotals = new Map();
  for (const group of targets) receiptTotals.set(group.picking.id, round((receiptTotals.get(group.picking.id) ?? 0) + group.amount));
  if ([...receiptTotals.values()].some((amount) => amount < 0)) throw new Error('Landed cost net for each receipt must be nonnegative');
  if (!total && !targets.some((g) => g.costs.some((c) => c.amount || c.recognized))) throw new Error('Nothing to allocate');
  let next = db;
  for (const group of targets) {
    const { picking, product: p, amount, layers, isPeriodic } = group;
    const method = costMethod(next, p.id);
    const received = isPeriodic ? group.qty : layers.reduce((sum, l) => sum + l.quantity, 0);
    const remaining = isPeriodic ? 0 : layers.reduce((sum, l) => sum + l.remaining_qty, 0);
    const capitalized = isPeriodic || method === 'standard' ? 0 : round(amount * remaining / received);
    const expensed = round(amount - capitalized);
    const active = layers.filter((l) => l.remaining_qty > 0);
    const layerShares = active.length ? allocateCents(capitalized, active.map((l) => l.remaining_qty)) : [];
    if (active.some((layer, index) => round(layer.remaining_value + layerShares[index]) < 0)) throw new Error('Landed cost would make a valuation layer negative');
    const qty = (next.records['stock.quant'] ?? []).filter((q) => q.product_id === p.id && (q.company_id ?? 1) === (lc.company_id ?? 1)).reduce((sum, q) => sum + q.quantity, 0);
    if (!isPeriodic && method === 'average' && capitalized && qty > 0 && round((Number(p.cost) || 0) + capitalized / qty) < 0) throw new Error('Landed cost would make inventory value negative');
    for (const [index, layer] of active.entries()) {
      const share = layerShares[index];
      if (share) next = write(next, 'stock.valuation.layer', layer.id, { remaining_value: round(layer.remaining_value + share) });
    }
    if (!isPeriodic && method === 'average' && capitalized && qty > 0) next = write(next, 'product', p.id, { cost: round((Number(p.cost) || 0) + capitalized / qty) });
    let entryId = null;
    if (group.costs.some((c) => c.amount || c.recognized)) {
      const stock = read(next, 'account.account', productProperty(next, p, 'property_stock_valuation_account_id'))?.code || '110100';
      const expense = read(next, 'account.account', productProperty(next, p, 'property_account_expense_id'))?.code || '500000';
      const journal = read(next, 'account.journal', lc.journal_id || productProperty(next, p, 'property_stock_journal'))?.code || 'MISC';
      const entryLines = landedCostEntryLines(next, lc, group, { stock, expense, capitalized, expensed, isPeriodic });
      if (entryLines.length) {
        const entry = postEntry(next, { journal, date: lc.date || today(), company: lc.company_id ?? 1, ref: `Landed costs ${picking.name}`, lines: entryLines });
        next = entry.db; entryId = entry.id;
      }
    }
    if (!isPeriodic && capitalized) next = create(next, 'stock.valuation.layer', { company_id: lc.company_id ?? 1, product_id: p.id, date: lc.date || today(), reference: `Landed costs ${picking.name}`, description: `Landed costs ${picking.name}`, quantity: 0, value: capitalized, unit_cost: 0, kind: 'landed', picking_id: picking.id, move_id: entryId }).db;
  }
  return write(next, 'stock.landed.cost', lc.id, { state: 'done', amount_total: total });
}

/** On-hand per location from validated transfers that carry locations (incoming adds to dest, outgoing removes from source). */
export function locationStock(db, productId) {
  const by = new Map();
  for (const p of search(db, 'stock.picking').filter((x) => x.state === 'done')) {
    for (const m of (p.move_ids ?? []).filter((x) => x.product_id === productId)) {
      if (p.location_dest_id) by.set(p.location_dest_id, (by.get(p.location_dest_id) ?? 0) + Number(m.qty));
      if (p.location_id) by.set(p.location_id, (by.get(p.location_id) ?? 0) - Number(m.qty));
    }
  }
  return [...by].filter(([, q]) => q !== 0).map(([location_id, qty]) => ({ location_id, qty }));
}

export const routeModels = {
  'stock.route': {
    label: 'Routes', fields: {
      name: { type: 'char', label: 'Name', required: true }, active: { type: 'boolean', label: 'Active' },
      rule_ids: { type: 'one2many', label: 'Rules', fields: {
        sequence: { type: 'integer', label: 'Sequence' }, product_id: { type: 'many2one', relation: 'product', label: 'Product' },
        categ_id: { type: 'many2one', relation: 'product.category', label: 'Product Category' }, package_id: { type: 'many2one', relation: 'stock.quant.package', label: 'Package' },
        action: { type: 'selection', label: 'Route', options: [['stock', 'From Stock'], ['mto_buy', 'Buy on Order'], ['mto_make', 'Manufacture on Order'], ['dropship', 'Dropship']] },
      }, newLine: () => ({ sequence: 10, action: 'stock' }) },
    }, defaults: () => ({ active: true, rule_ids: [] }), list: ['name', 'active'], form: { title: 'name', groups: [['active']], tabs: [{ label: 'Rules', fields: ['rule_ids'] }] },
  },
  'stock.location': {
    label: 'Locations',
    fields: {
      name: { type: 'char', label: 'Location Name', required: true },
      parent_id: { type: 'many2one', relation: 'stock.location', label: 'Parent Location' },
      usage: { type: 'selection', label: 'Location Type', options: [['internal', 'Internal'], ['view', 'View'], ['transit', 'Transit'], ['inventory', 'Inventory Adjustment']] },
      barcode: { type: 'char', label: 'Barcode' },
    },
    defaults: () => ({ usage: 'internal' }),
    kanban: { title: 'name', lines: ['parent_id', 'usage'] },
    list: ['name', 'parent_id', 'usage', 'barcode'],
    form: { title: 'name', groups: [['parent_id', 'usage'], ['barcode']], chatter: true },
  },

  'stock.landed.cost': {
    label: 'Landed Costs',
    fields: {
      name: { type: 'char', label: 'Reference', required: true },
      picking_id: { type: 'many2one', relation: 'stock.picking', label: 'Receipt' },
      picking_ids: { type: 'many2many', relation: 'stock.picking', label: 'Receipts' },
      bill_id: { type: 'many2one', relation: 'account.move', label: 'Vendor Bill', readonly: true },
      source_warning: { type: 'text', label: 'Bill Source Warning', readonly: true },
      date: { type: 'date', label: 'Date' },
      journal_id: { type: 'many2one', relation: 'account.journal', label: 'Journal' },
      cost_lines: {
        type: 'one2many',
        label: 'Additional Costs',
        fields: { name: { type: 'char', label: 'Description' }, amount: { type: 'monetary', label: 'Cost' }, account_id: { type: 'many2one', relation: 'account.account', label: 'Account' }, source_bill_line: { type: 'integer', label: 'Bill Line Index (starting at 0)' }, source_bill_amount: { type: 'monetary', label: 'Bill Line Amount', readonly: true, hidden: true }, source_bill_account_id: { type: 'many2one', relation: 'account.account', label: 'Bill Line Account', readonly: true, hidden: true }, split_method: { type: 'selection', label: 'Split Method', options: [['quantity', 'By Quantity'], ['equal', 'Equal'], ['value', 'By Value'], ['weight', 'By Weight'], ['volume', 'By Volume']] } },
        newLine: () => ({ name: 'Freight', amount: 0, split_method: 'quantity' }),
      },
      amount_total: { type: 'monetary', label: 'Total', readonly: true },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['done', 'Posted']] },
    },
    defaults: () => ({ date: today(), state: 'draft', cost_lines: [] }),
    guard: (db, before, after) => before?.state === 'done' && ['state', 'company_id', 'picking_id', 'picking_ids', 'bill_id', 'date', 'journal_id', 'cost_lines', 'amount_total'].some((key) => stableValue(before[key]) !== stableValue(after[key])) ? 'Posted landed costs cannot be changed' : null,
    protectDelete: (db, r) => r.state === 'done' ? 'Posted landed costs cannot be deleted' : null,
    kanban: { title: 'name', lines: ['picking_id', 'amount_total'], badge: 'state' },
    list: ['date', 'name', 'picking_id', 'amount_total', 'state'],
    form: {
      statusbar: 'state',
      lockedWhen: (r) => r.state === 'done',
      buttons: [{ label: 'Validate', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: applyLandedCost(db, r) }) }],
      title: 'name',
      groups: [['picking_id', 'picking_ids', 'journal_id'], ['date', 'amount_total'], ['source_warning']],
      tabs: [{ label: 'Additional Costs', fields: ['cost_lines'] }],
      chatter: true,
    },
  },
};
