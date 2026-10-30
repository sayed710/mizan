// Fields that workflows write but no model declared. The server keeps only declared fields (validate.js cleanRecord),
// so without these the client and the server disagree after a sync: gift cards become reusable, POS refunds are
// valued at today's cost, fiscal-year closing entries count as P&L, rented goods vanish from valuation, and so on.
// Run `npm run test:fields` to find new ones.

const m2o = (relation, label) => ({ type: 'many2one', relation, label, readonly: true, hidden: true });
const hidden = (type, label, extra = {}) => ({ type, label, readonly: true, hidden: true, ...extra });
const PURCHASE_METHOD = [['purchase', 'On ordered quantities'], ['receive', 'On received quantities']];

/** Top-level fields per model. */
const FIELDS = {
  'account.move': {
    is_closing: hidden('boolean', 'Closing Entry'), // closing.js: year-end entries are excluded from the P&L
    force_post: hidden('boolean', 'Post Despite Quantity Mismatch'), // billcontrol.js
    revaluation_date: hidden('date', 'Revaluation Date'), // closing.js: one revaluation per date
    reversal_move_id: m2o('account.move', 'Reversal Entry'),
    repair_id: m2o('repair.order', 'Repair Order'),
  },
  'account.payment': { sale_id: m2o('sale.order', 'Sales Order') }, // quoteplus.js prepayments
  'approval.request': { leave_id: m2o('hr.leave', 'Time Off'), purchase_id: m2o('purchase.order', 'Purchase Order') },
  'calendar.event': { interviewer: hidden('char', 'Interviewer') }, // recruitplus.js double-booking check
  'hr.employee': { timesheet_cost: hidden('monetary', 'Timesheet Cost per Hour', { readonly: false }), hourly_cost: hidden('monetary', 'Hourly Cost', { readonly: false }) },
  'mrp.production': { operation_cost_move_id: m2o('account.move', 'Operation Cost Entry') }, // workorder.js: posted once
  'pos.order': {
    stock_costs: hidden('json', 'Stock Costs'),
    request_key: hidden('char', 'Reference'),
    request_fingerprint: hidden('char', 'Reference'),
    preset_snapshot: hidden('json', 'Preset Snapshot'),
    rounding_difference: hidden('monetary', 'Rounding Difference'),
    return_layers: {
      type: 'one2many', label: 'Return Layers', readonly: true, hidden: true,
      fields: {
        index: { type: 'integer', label: 'Line Index' },
        layer_id: { type: 'many2one', relation: 'stock.valuation.layer', ref: 'stock.valuation.layer', label: 'Valuation Layer' },
      },
      newLine: () => ({ index: 0, layer_id: null }),
    },
  },
  'pos.session': { config_id: m2o('pos.config', 'Point of Sale') },
  product: { qty_rented: hidden('float', 'Quantity Rented') }, // extra.js: rented stock stays in valuation
  'project.project': { last_update_status: hidden('selection', 'Last Update Status', { options: [['on_track', 'On Track'], ['at_risk', 'At Risk'], ['off_track', 'Off Track'], ['on_hold', 'On Hold'], ['done', 'Done']] }) },
  'purchase.requisition': { partner_id: m2o('res.partner', 'Partner') },
  'res.partner': { supplier_rank: hidden('integer', 'Supplier Rank') },
  'sale.order': {
    currency_id: m2o('res.currency', 'Currency'), // sales.js: invoices keep the order currency
    amount_paid: hidden('monetary', 'Prepaid'), // portal.js online prepayment
    expiry_checked_date: hidden('date', 'Expiry Checked On'), // quoteplus.js
    expiry_notified_for: hidden('date', 'Expiry Notified For'),
    loyalty_uses: hidden('json', 'Applied Loyalty Programs'), // sales.js: gift cards and points spent once
    warehouse_id: m2o('stock.warehouse', 'Warehouse'),
  },
  'sale.rental': { pickup_picking_id: m2o('stock.picking', 'Pickup'), return_picking_id: m2o('stock.picking', 'Return') },
  'stock.picking': { repair_id: m2o('repair.order', 'Repair Order') },
  'stock.valuation.layer': { counterpart: hidden('char', 'Counterpart Account'), reversed_layer_id: m2o('stock.valuation.layer', 'Reversed Layer') }, // valuation.js journal entry
  // Read by the helpdesk SLA "last change" and the sitemap's lastmod; kept when imported or set.
  'helpdesk.ticket': { write_date: hidden('char', 'Last Updated on') },
  'website.page': { write_date: hidden('char', 'Last Updated on') },
  'blog.post': { write_date: hidden('char', 'Last Updated on') },
};

/** Subfields of one2many lines: model → field → subfields. */
const LINE_FIELDS = {
  'account.move': { invoice_line_ids: { analytic_distribution: hidden('json', 'Analytic Distribution', { readonly: false }) } },
  'hr.appraisal': {
    employee_feedback: { type: hidden('selection', 'Answer Type', { options: [['text', 'Text'], ['rating', 'Rating']] }) },
    manager_feedback: { type: hidden('selection', 'Answer Type', { options: [['text', 'Text'], ['rating', 'Rating']] }) },
  },
  'purchase.order': { order_line: { purchase_method: hidden('selection', 'Bill Control', { options: PURCHASE_METHOD }) } },
  'repair.order': { operations: { tax: hidden('float', 'Tax %') } },
  'sale.order': { order_line: { name: hidden('char', 'Description', { readonly: false }), expense_id: m2o('hr.expense', 'Expense') } },
  'stock.picking': { move_ids: { lot_id: m2o('stock.lot', 'Lot/Serial Number') } },
};

/**
 * Add the fields above to the assembled registry (replacing its model entries, so the modules' own definitions are
 * untouched); a field a model already declares is left as it is.
 */
export function declareWorkflowFields(models) {
  const addFields = (model, fields) => { models[model] = { ...models[model], fields: { ...fields, ...models[model].fields } }; };
  for (const [model, fields] of Object.entries(FIELDS)) if (models[model]) addFields(model, fields);
  for (const [model, lines] of Object.entries(LINE_FIELDS)) {
    for (const [field, subfields] of Object.entries(lines)) {
      const line = models[model]?.fields[field];
      if (line?.type === 'one2many') models[model] = { ...models[model], fields: { ...models[model].fields, [field]: { ...line, fields: { ...subfields, ...line.fields } } } };
    }
  }
}
