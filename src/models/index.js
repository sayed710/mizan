// Model registry + application menus. Every view is rendered from these definitions.
import { read } from '../orm.js';
import { registerModels } from '../registry.js';
import { crmModels } from './crm.js';
import { salesModels } from './sales.js';
import { accountingModels } from './accounting.js';
import { assetModels } from './assets.js';
import { taxModels } from './taxes.js';
import { payModels } from './pay.js';
import { elearningModels } from './elearning.js';
import { surveyModels } from './surveys.js';
import { smsModels } from './sms.js';
import { automationModels } from './automation.js';
import { socialModels } from './social.js';
import { spreadsheetModels } from './spreadsheet.js';
import { loanModels } from './loans.js';
import { mrpModels } from './mrp.js';
import { crmTeamModels } from './crmteams.js';
import { projectPlusModels } from './projectplus.js';
import { fsmModels } from './fsm.js';
import { fleetPlusModels } from './fleetplus.js';
import { qualityPlusModels } from './qualityplus.js';
import { maintPlusModels } from './maintplus.js';
import { timesheetPlusModels } from './timesheetplus.js';
import { eventsPlusModels } from './eventsplus.js';
import { recruitPlusModels } from './recruitplus.js';
import { rentalPlusModels } from './rentalplus.js';
import { loyaltyModels } from './loyalty.js';
import { approvalsPlusModels } from './approvalsplus.js';
import { posPlusModels } from './posplus.js';
import { planningPlusModels } from './planningplus.js';
import { signPlusModels } from './signplus.js';
import { analyticPlusModels } from './analyticplus.js';
import { appraisalPlusModels } from './appraisalplus.js';
import { workorderModels } from './workorder.js';
import { expensePlusModels } from './expenseplus.js';
import { purchasePlusModels } from './purchaseplus.js';
import { subscriptionPlusModels } from './subscriptionplus.js';
import { valuationModels } from './valuation.js';
import { attendancePlusModels } from './attendanceplus.js';
import { skillsPlusModels } from './skillsplus.js';
import { closingModels } from './closing.js';
import { websitePlusModels } from './websiteplus.js';
import { repairPlusModels } from './repairplus.js';
import { billControlModels } from './billcontrol.js';
import { frontdeskPlusModels } from './frontdeskplus.js';
import { quotePlusModels } from './quoteplus.js';
import { uomModels } from './uom.js';
import { reconcileModels } from './reconcile.js';
import { workModels } from './work.js';
import { moreModels } from './more.js';
import { mailModels } from './mail.js';
import { payrollModels } from './payroll.js';
import { extraModels } from './extra.js';
import { mailingModels } from './mailing.js';
import { apps2Models } from './apps2.js';
import { apps3Models } from './apps3.js';
import { bankModels } from './bank.js';
import { pricelistModels } from './pricelist.js';
import { apps4Models } from './apps4.js';
import { logisticsModels } from './logistics.js';
import { routeModels } from './routes.js';
import { financeModels } from './finance.js';
import { currencyModels } from './currency.js';
import { batchModels } from './batch.js';
import { termModels } from './terms.js';
import { deferredModels } from './deferred.js';
import { paymentModels } from './payments.js';
import { helpdeskModels } from './helpdesk.js';
import { leaveGuard, timeoffModels } from './timeoff.js';
import { posModels } from './pos.js';
import { knowledgeModels } from './knowledge.js';
import { livechatModels } from './livechat.js';
import { lunchModels } from './lunch.js';
import { ecommerceModels } from './ecommerce.js';
import { blogModels } from './blog.js';
import { appointmentModels } from './appointments.js';
import { whatsappModels } from './whatsapp.js';
import { today } from './common.js';
import { companyModels, withCompany } from './company.js';
import { withLocks } from './locks.js';
import { composeModels } from './compose.js';
import { warehouseModels } from './warehouse.js';
import { quantModels } from './quant.js';
import { consolidationModels } from './consolidation.js';
import { documentsPlusModels } from './documentsplus.js';
import { calendarModels } from './calendar.js';
import { declareWorkflowFields } from './workflowFields.js';
import { appAnalyses } from './analysis.js';
import { orderpointModels } from './orderpoint.js';
import { productConfigModels } from './productconfig.js';

export { today } from './common.js';

/** Model modules in composition order: a later module's definition of a model replaces (and should extend) an earlier one. */
export const MODEL_MODULES = { crmModels, salesModels, accountingModels, workModels, moreModels, mailModels, payrollModels, extraModels, mailingModels, apps2Models, apps3Models, bankModels, pricelistModels, apps4Models, logisticsModels, routeModels, financeModels, currencyModels, batchModels, termModels, deferredModels, paymentModels, helpdeskModels, timeoffModels, posModels, assetModels, reconcileModels, taxModels, payModels, elearningModels, surveyModels, smsModels, automationModels, socialModels, spreadsheetModels, loanModels, mrpModels, crmTeamModels, projectPlusModels, fsmModels, fleetPlusModels, qualityPlusModels, maintPlusModels, eventsPlusModels, recruitPlusModels, rentalPlusModels, loyaltyModels, approvalsPlusModels, posPlusModels, planningPlusModels, signPlusModels, documentsPlusModels, analyticPlusModels, timesheetPlusModels, appraisalPlusModels, workorderModels, expensePlusModels, purchasePlusModels, subscriptionPlusModels, valuationModels, attendancePlusModels, skillsPlusModels, closingModels, websitePlusModels, repairPlusModels, billControlModels, frontdeskPlusModels, uomModels, knowledgeModels, lunchModels, livechatModels, ecommerceModels, quotePlusModels, blogModels, appointmentModels, whatsappModels, companyModels, warehouseModels, consolidationModels, quantModels, calendarModels, orderpointModels, productConfigModels };
export const models = registerModels(withLocks(withCompany(composeModels(MODEL_MODULES))));

// A button's `when` is its precondition, not just whether it is shown: every caller (a stale form, a double click,
// a server action) runs through this check, so a hidden transition cannot run.
// The record is judged as stored, so a stale copy cannot pass for its old state.
for (const [name, model] of Object.entries(models)) {
  for (const b of model.form?.buttons ?? []) {
    if (!b.when || !b.run || b.run.checked) continue;
    const run = b.run;
    b.run = Object.assign((db, rec, ...rest) => {
      const current = (rec?.id && read(db, name, rec.id)) || rec;
      if (!b.when(current, db)) throw new Error(`${b.label} is not available for this record in its current state`);
      return run(db, current, ...rest);
    }, { checked: true });
  }
}
models['hr.leave'].guard = leaveGuard;
declareWorkflowFields(models);

// Views that need their own spec are offered only when the model has one (a missing kanban spec used to crash the screen).
const SPEC_VIEWS = ['kanban', 'calendar', 'gantt'];
export const viewsOf = (model) => {
  const def = models[model];
  const views = (def.views ?? ['kanban', 'list']).filter((v) => !SPEC_VIEWS.includes(v) || def[v]);
  return views.length ? views : ['list'];
};

const customers = { key: 'customers', label: 'Customers', model: 'res.partner' };
const vendors = { key: 'vendors', label: 'Vendors', model: 'res.partner' };
const products = { key: 'products', label: 'Products', model: 'product' };

/**
 * A menu leaf is { key, label, model, view?, domain?, defaults? } or { key, label, type } for custom pages.
 * Top-level menus may group leaves under `children`.
 */
const allApps = [
  {
    id: 'discuss', name: 'Discuss', color: ['#f97316', '#db2777'],
    menus: [
      { key: 'channels', label: 'Channels', type: 'discuss' },
      { key: 'activities', label: 'Activities', model: 'mail.activity' },
    ],
  },
  {
    id: 'crm', name: 'CRM', color: ['#14b8a6', '#0e7490'],
    menus: [
      { label: 'Sales', children: [
        { key: 'pipeline', label: 'My Pipeline', model: 'crm.lead', domain: (r) => r.type !== 'lead' },
        { key: 'leads', label: 'Leads', model: 'crm.lead', domain: (r) => r.type === 'lead', defaults: { type: 'lead' } },
        { key: 'quotations', label: 'Quotations', model: 'sale.order' },
        customers,
      ] },
      { label: 'Reporting', children: [
        { key: 'analysis', label: 'Pipeline Analysis', model: 'crm.lead', view: 'graph' },
        { key: 'forecast', label: 'Forecast', model: 'crm.lead', view: 'pivot' },
      ] },
      { label: 'Configuration', children: [
        { key: 'stages', label: 'Stages', model: 'crm.stage' },
        { key: 'teams', label: 'Sales Teams', model: 'crm.team' },
        { key: 'lost-reasons', label: 'Lost Reasons', model: 'crm.lost.reason' },
      ] },
    ],
  },
  {
    id: 'sales', name: 'Sales', color: ['#f59e0b', '#dc2626'],
    menus: [
      { label: 'Orders', children: [
        { key: 'quotations', label: 'Quotations', model: 'sale.order' },
        { key: 'orders', label: 'Orders', model: 'sale.order', domain: (r) => r.state === 'sale' },
        customers,
      ] },
      { key: 'to-invoice', label: 'To Invoice', model: 'sale.order', domain: (r) => r.state === 'sale' },
      { label: 'Products', children: [products, { key: 'pricelists', label: 'Pricelists', model: 'product.pricelist' }, { key: 'quote-templates', label: 'Quotation Templates', model: 'sale.order.template' }, { key: 'loyalty', label: 'Discount & Loyalty', model: 'loyalty.program' }, { key: 'cards', label: 'Coupons & Cards', model: 'loyalty.card' }] },
      { key: 'marketplaces', label: 'Marketplaces', model: 'marketplace.connector' },
      { label: 'Configuration', children: [{ key: 'attributes', label: 'Attributes', model: 'product.attribute' }, { key: 'attribute-values', label: 'Attribute Values', model: 'product.attribute.value' }, { key: 'product-categories', label: 'Product Categories', model: 'product.category' }, { key: 'product-tags', label: 'Product Tags', model: 'product.tag' }] },
      { key: 'report', label: 'Reporting', model: 'sale.order', view: 'graph' },
    ],
  },
  {
    id: 'accounting', name: 'Accounting', color: ['#ec4899', '#7c3aed'],
    menus: [
      { key: 'dashboard', label: 'Dashboard', type: 'dashboard' },
      { label: 'Customers', children: [
        { key: 'invoices', label: 'Invoices', model: 'account.move', domain: (r) => r.move_type === 'out_invoice', defaults: { move_type: 'out_invoice' } },
        { key: 'credit-notes', label: 'Credit Notes', model: 'account.move', domain: (r) => r.move_type === 'out_refund', defaults: { move_type: 'out_refund' } },
        { key: 'payments', label: 'Payments', model: 'account.payment', domain: (r) => r.partner_type === 'customer', defaults: { partner_type: 'customer', payment_type: 'inbound' } },
        customers,
      ] },
      { label: 'Vendors', children: [
        { key: 'bills', label: 'Bills', model: 'account.move', domain: (r) => r.move_type === 'in_invoice', defaults: { move_type: 'in_invoice' } },
        { key: 'refunds', label: 'Refunds', model: 'account.move', domain: (r) => r.move_type === 'in_refund', defaults: { move_type: 'in_refund' } },
        { key: 'vendor-payments', label: 'Payments', model: 'account.payment', domain: (r) => r.partner_type === 'supplier', defaults: { partner_type: 'supplier', payment_type: 'outbound' } },
        vendors,
      ] },
      { label: 'Accounting', children: [
        { key: 'bank', label: 'Bank Transactions', model: 'account.bank.statement.line' },
        { key: 'entries', label: 'Journal Entries', model: 'account.move' },
        { key: 'batch-payments', label: 'Batch Payments', model: 'account.batch.payment' },
        { key: 'assets', label: 'Assets', model: 'account.asset' },
        { key: 'loans', label: 'Loans', model: 'account.loan' },
        { key: 'deferrals', label: 'Deferrals', model: 'account.deferral' },
        { key: 'consolidations', label: 'Consolidations', model: 'consolidation.chart' },
        { key: 'consolidation-periods', label: 'Consolidation Periods', model: 'consolidation.period' },
        { key: 'misc', label: 'Miscellaneous Entries', model: 'account.move', domain: (r) => r.move_type === 'entry', defaults: { move_type: 'entry' } },
        { label: 'Closing', children: [
          { key: 'secure-entries', label: 'Secure Entries', model: 'account.secure.entries.wizard' },
        ] },
      ] },
      { label: 'Reporting', children: [
        { key: 'pnl', label: 'Profit and Loss', type: 'report', report: 'pnl' },
        { key: 'balance-sheet', label: 'Balance Sheet', type: 'report', report: 'balance' },
        { key: 'cash-flow', label: 'Cash Flow Statement', type: 'report', report: 'cashflow' },
        { key: 'executive-summary', label: 'Executive Summary', type: 'report', report: 'executive' },
        { key: 'trial-balance', label: 'Trial Balance', type: 'report', report: 'trial' },
        { key: 'general-ledger', label: 'General Ledger', type: 'report', report: 'ledger' },
        { key: 'depreciation-schedule', label: 'Depreciation Schedule', type: 'report', report: 'depreciation' },
        { key: 'partner-ledger', label: 'Partner Ledger', type: 'report', report: 'partnerReceivable' },
        { key: 'partner-ledger-payable', label: 'Partner Ledger (Payable)', type: 'report', report: 'partnerPayable' },
        { key: 'tax-report', label: 'Tax Return', type: 'report', report: 'tax' },
        { key: 'aged-receivable', label: 'Aged Receivable', type: 'report', report: 'agedReceivable' },
        { key: 'aged-payable', label: 'Aged Payable', type: 'report', report: 'agedPayable' },
        { key: 'follow-ups', label: 'Follow-up Reports', type: 'report', report: 'followups' },
        { key: 'budget-report', label: 'Budget vs Actual', type: 'report', report: 'budget' },
        { key: 'analytic-report', label: 'Analytic Report', type: 'report', report: 'analytic' },
        { key: 'audit-trail', label: 'Audit Trail', type: 'report', report: 'audit' },
        { key: 'invoice-analysis', label: 'Invoice Analysis', model: 'account.move', view: 'pivot', domain: (r) => r.move_type !== 'entry' },
      ] },
      { label: 'Review', children: [
        { label: 'Control', children: [
          { key: 'journal-audit', label: 'Journal Audit', type: 'report', report: 'journalAudit' },
          { key: 'inalterability-check', label: 'Data Inalterability Check', type: 'report', report: 'inalterability' },
        ] },
      ] },
      { label: 'Configuration', children: [
        { label: 'Invoicing', children: [
          { key: 'incoterms', label: 'Incoterms', model: 'account.incoterm' },
        ] },
        { label: 'Accounting', children: [
          { key: 'accounts', label: 'Chart of Accounts', model: 'account.account' },
          { key: 'journals', label: 'Journals', model: 'account.journal' },
          { key: 'taxes', label: 'Taxes', model: 'account.tax' },
          { key: 'tax-units', label: 'Tax Units', model: 'account.tax.unit' },
          { key: 'account-tags', label: 'Account Tags', model: 'account.account.tag' },
          { key: 'depreciation-models', label: 'Depreciation Models', model: 'account.asset.model' },
          { key: 'fiscal-positions', label: 'Fiscal Positions', model: 'account.fiscal.position' },
          { key: 'reconcile-models', label: 'Reconciliation Models', model: 'account.reconcile.model' },
          { key: 'fiscal-years', label: 'Fiscal Years', model: 'account.fiscal.year' },
          { key: 'analytic-plans', label: 'Analytic Plans', model: 'account.analytic.plan' },
          { key: 'analytic', label: 'Analytic Accounts', model: 'account.analytic.account' },
          { key: 'analytic-items', label: 'Analytic Items', model: 'account.analytic.line', domain: (r) => !!r.move_id || (r.category && r.category !== 'timesheet') },
          { key: 'budgets', label: 'Budgets', model: 'account.budget' },
          { key: 'currencies', label: 'Currencies', model: 'res.currency' },
          { key: 'payment-terms', label: 'Payment Terms', model: 'account.payment.term' },
          { key: 'cash-roundings', label: 'Cash Roundings', model: 'account.cash.rounding' },
          { key: 'followup-levels', label: 'Follow-up Levels', model: 'account.followup.level' },
        ] },
      ] },
    ],
  },
  {
    id: 'purchase', name: 'Purchase', color: ['#64748b', '#0f766e'],
    menus: [
      { label: 'Orders', children: [
        { key: 'rfq', label: 'Requests for Quotation', model: 'purchase.order' },
        { key: 'po', label: 'Purchase Orders', model: 'purchase.order', domain: (r) => r.state === 'purchase' },
        { key: 'agreements', label: 'Purchase Agreements', model: 'purchase.requisition' },
        vendors,
      ] },
      { label: 'Products', children: [products, { key: 'vendor-pricelists', label: 'Vendor Pricelists', model: 'product.supplierinfo' }] },
      { key: 'report', label: 'Reporting', model: 'purchase.order', view: 'graph' },
    ],
  },
  {
    id: 'inventory', name: 'Inventory', color: ['#a855f7', '#be185d'],
    menus: [
      { label: 'Operations', children: [
        { key: 'transfers', label: 'Transfers', model: 'stock.picking' },
        { key: 'replenishment', label: 'Replenishment', model: 'stock.warehouse.orderpoint' },
        { key: 'scrap', label: 'Scrap', model: 'stock.scrap' },
        { key: 'receipts', label: 'Receipts', model: 'stock.picking', domain: (r) => r.picking_type === 'incoming', defaults: { picking_type: 'incoming' } },
        { key: 'deliveries', label: 'Deliveries', model: 'stock.picking', domain: (r) => r.picking_type === 'outgoing', defaults: { picking_type: 'outgoing' } },
        { key: 'internal', label: 'Internal', model: 'stock.picking', domain: (r) => r.picking_type === 'internal', defaults: { picking_type: 'internal' } },
        { key: 'physical-inventory', label: 'Physical Inventory', model: 'stock.quant' },
        { key: 'inventory-counts', label: 'Inventory Counts', model: 'stock.inventory.count' },
      ] },
      { key: 'products', label: 'Products', model: 'product' },
      { key: 'stock', label: 'Stock', model: 'product', view: 'list', domain: (r) => r.type === 'goods' },
      { key: 'lots', label: 'Lots/Serial Numbers', model: 'stock.lot' },
      { key: 'batches', label: 'Batch Transfers', model: 'stock.picking.batch' },
      { key: 'packages', label: 'Packages', model: 'stock.quant.package' },
      { key: 'landed', label: 'Landed Costs', model: 'stock.landed.cost' },
      { key: 'valuation', label: 'Inventory Valuation', model: 'stock.valuation.layer' },
      { label: 'Configuration', children: [{ key: 'attributes', label: 'Attributes', model: 'product.attribute' }, { key: 'attribute-values', label: 'Attribute Values', model: 'product.attribute.value' }, { key: 'product-categories', label: 'Product Categories', model: 'product.category' }, { key: 'product-tags', label: 'Product Tags', model: 'product.tag' }, { key: 'carriers', label: 'Delivery Methods', model: 'delivery.carrier' }, { key: 'warehouses', label: 'Warehouses', model: 'stock.warehouse' }, { key: 'locations', label: 'Locations', model: 'stock.location' }, { key: 'uom-categories', label: 'UoM Categories', model: 'uom.category' }, { key: 'uoms', label: 'Units of Measure', model: 'uom.uom' }, { key: 'packagings', label: 'Packagings', model: 'product.packaging' }] },
      { label: 'Reporting', children: [
        { key: 'report', label: 'Stock', model: 'product', view: 'pivot', domain: (r) => r.type === 'goods' },
        { key: 'valuation', label: 'Valuation', type: 'report', report: 'valuation' },
      ] },
    ],
  },
  { id: 'contacts', name: 'Contacts', color: ['#6366f1', '#4338ca'], menus: [{ key: 'contacts', label: 'Contacts', model: 'res.partner' }] },
  { id: 'calendar', name: 'Calendar', color: ['#0ea5e9', '#1d4ed8'], menus: [{ key: 'meetings', label: 'Meetings', model: 'calendar.event' }] },
  {
    id: 'project', name: 'Project', color: ['#22c55e', '#15803d'],
    menus: [
      { key: 'projects', label: 'Projects', model: 'project.project' },
      { key: 'tasks', label: 'All Tasks', model: 'project.task' },
      { key: 'milestones', label: 'Milestones', model: 'project.milestone' },
      { key: 'updates', label: 'Project Updates', model: 'project.update' },
      { key: 'recurring', label: 'Recurring Tasks', model: 'project.recurrence' },
      { key: 'report', label: 'Reporting', model: 'project.task', view: 'pivot' },
      { label: 'Configuration', children: [
        { key: 'stages', label: 'Task Stages', model: 'project.task.type' },
        { key: 'tags', label: 'Tags', model: 'project.tags' },
      ] },
    ],
  },
  {
    id: 'helpdesk', name: 'Helpdesk', color: ['#f97316', '#b91c1c'],
    menus: [
      { key: 'tickets', label: 'Tickets', model: 'helpdesk.ticket' },
      { key: 'report', label: 'Reporting', model: 'helpdesk.ticket', view: 'graph' },
      { label: 'Configuration', children: [{ key: 'teams', label: 'Helpdesk Teams', model: 'helpdesk.team' }, { key: 'sla', label: 'SLA Policies', model: 'helpdesk.sla' }] },
    ],
  },
  {
    id: 'employees', name: 'Employees', color: ['#06b6d4', '#4f46e5'],
    menus: [
      { key: 'employees', label: 'Employees', model: 'hr.employee' },
      { key: 'departments', label: 'Departments', model: 'hr.department' },
      { label: 'Configuration', children: [
        { key: 'calendars', label: 'Working Schedules', model: 'resource.calendar' },
        { key: 'public-holidays', label: 'Public Holidays', model: 'resource.calendar.leaves' },
      ] },
    ],
  },
  {
    id: 'manufacturing', name: 'Manufacturing', color: ['#10b981', '#0e7490'],
    menus: [
      { key: 'orders', label: 'Manufacturing Orders', model: 'mrp.production' },
      { key: 'workorders', label: 'Work Orders', model: 'mrp.workorder' },
      { key: 'boms', label: 'Bills of Materials', model: 'mrp.bom' },
      { key: 'workcenters', label: 'Work Centers', model: 'mrp.workcenter' },
      { key: 'unbuild', label: 'Unbuild Orders', model: 'mrp.unbuild' },
      { key: 'scrap', label: 'Scrap Orders', model: 'stock.scrap' },
      { key: 'products', label: 'Products', model: 'product' },
    ],
  },
  { id: 'kitchen', name: 'Kitchen Display', color: ['#f97316', '#b91c1c'], menus: [{ key: 'display', label: 'Kitchen Display', type: 'kitchen' }] },
  {
    id: 'pos', name: 'Point of Sale', color: ['#fbbf24', '#ea580c'],
    menus: [
      { key: 'register', label: 'Register', type: 'pos' },
      { key: 'orders', label: 'Orders', model: 'pos.order' },
      { key: 'sessions', label: 'Sessions', model: 'pos.session' },
      { key: 'report', label: 'Reporting', model: 'pos.order', view: 'graph' },
      { label: 'Configuration', children: [
        { key: 'pos-config', label: 'Point of Sale', model: 'pos.config' },
        { key: 'payment-methods', label: 'Payment Methods', model: 'pos.payment.method' },
        { key: 'pos-categories', label: 'PoS Product Categories', model: 'pos.category' },
        { key: 'presets', label: 'Presets', model: 'pos.preset' },
        { key: 'cash-roundings', label: 'Cash Roundings', model: 'account.cash.rounding' },
        { key: 'floors', label: 'Floors', model: 'restaurant.floor' },
      ] },
    ],
  },
  {
    id: 'expenses', name: 'Expenses', color: ['#38bdf8', '#7c3aed'],
    menus: [
      { key: 'mine', label: 'My Expenses', model: 'hr.expense' },
      { key: 'sheets', label: 'My Reports', model: 'hr.expense.sheet' },
      { key: 'sheets-to-approve', label: 'Reports to Approve', model: 'hr.expense.sheet', domain: (r) => r.state === 'submit' },
      { key: 'to-approve', label: 'To Approve', model: 'hr.expense', domain: (r) => r.state === 'submitted' },
      { key: 'report', label: 'Reporting', model: 'hr.expense', view: 'pivot' },
    ],
  },
  {
    id: 'timeoff', name: 'Time Off', color: ['#f472b6', '#0284c7'],
    menus: [
      { key: 'leaves', label: 'My Time Off', model: 'hr.leave' },
      { key: 'to-approve', label: 'To Approve', model: 'hr.leave', view: 'list', domain: (r) => r.state === 'confirm' },
      { key: 'allocations', label: 'Allocations', model: 'hr.leave.allocation' },
      { key: 'report', label: 'Reporting', model: 'hr.leave', view: 'pivot' },
      { label: 'Configuration', children: [
        { key: 'types', label: 'Time Off Types', model: 'hr.work.entry.type' },
        { key: 'public-holidays', label: 'Public Holidays', model: 'resource.calendar.leaves' },
      ] },
    ],
  },
  {
    id: 'recruitment', name: 'Recruitment', color: ['#2dd4bf', '#4338ca'],
    menus: [
      { key: 'jobs', label: 'Job Positions', model: 'hr.job' },
      { key: 'applications', label: 'Applications', model: 'hr.applicant' },
    ],
  },
  {
    id: 'timesheets', name: 'Timesheets', color: ['#0f766e', '#1e3a8a'],
    menus: [
      { key: 'timesheets', label: 'My Timesheets', model: 'account.analytic.line', domain: (r) => !r.move_id && (r.category ?? 'timesheet') === 'timesheet' },
      { key: 'to-validate', label: 'To Validate', model: 'account.analytic.line', domain: (r) => !r.move_id && (r.category ?? 'timesheet') === 'timesheet' && !r.validated },
      { key: 'report', label: 'Reporting', model: 'account.analytic.line', view: 'pivot', domain: (r) => !r.move_id && (r.category ?? 'timesheet') === 'timesheet' },
    ],
  },
  {
    id: 'events', name: 'Events', color: ['#fb7185', '#f59e0b'],
    menus: [
      { key: 'events', label: 'Events', model: 'event.event' },
      { key: 'attendees', label: 'Attendees', model: 'event.registration' },
      { key: 'talks', label: 'Talks', model: 'event.track' },
      { label: 'Exhibitors', children: [{ key: 'sponsors', label: 'Sponsors', model: 'event.sponsor' }, { key: 'booths', label: 'Booths', model: 'event.booth' }] },
      { key: 'questions', label: 'Questions', model: 'event.question' },
    ],
  },
  {
    id: 'subscriptions', name: 'Subscriptions', color: ['#f97316', '#16a34a'],
    menus: [
      { key: 'subscriptions', label: 'Subscriptions', model: 'sale.subscription' },
      { key: 'report', label: 'Reporting', model: 'sale.subscription', view: 'pivot' },
      { label: 'Configuration', children: [{ key: 'plans', label: 'Recurring Plans', model: 'sale.subscription.plan' }] },
    ],
  },
  {
    id: 'payroll', name: 'Payroll', color: ['#a3e635', '#0f766e'],
    menus: [
      { key: 'batches', label: 'Payslip Batches', model: 'hr.payslip.run' },
      { key: 'payslips', label: 'Payslips', model: 'hr.payslip' },
      { key: 'contracts', label: 'Contracts', model: 'hr.contract' },
      { label: 'Configuration', children: [{ key: 'structures', label: 'Salary Structures', model: 'hr.payroll.structure' }, { key: 'input-types', label: 'Other Input Types', model: 'hr.payslip.input.type' }] },
      { key: 'report', label: 'Reporting', model: 'hr.payslip', view: 'pivot' },
    ],
  },
  {
    id: 'marketing', name: 'Email Marketing', color: ['#8b5cf6', '#2563eb'],
    menus: [
      { key: 'mailings', label: 'Mailings', model: 'mailing.mailing' },
      { label: 'Recipients', children: [
        { key: 'lists', label: 'Mailing Lists', model: 'mailing.list' },
        { key: 'contacts', label: 'Mailing Contacts', model: 'mailing.contact' },
        { key: 'blacklist', label: 'Blacklist', model: 'mail.blacklist' },
      ] },
      { label: 'Reporting', children: [{ key: 'traces', label: 'Mailing Traces', model: 'mailing.trace' }] },
    ],
  },
  { id: 'sign', name: 'Sign', color: ['#0ea5e9', '#0f172a'], menus: [{ key: 'documents', label: 'Documents to Sign', model: 'sign.request' }, { key: 'templates', label: 'Templates', model: 'sign.template' }] },
  { id: 'documents', name: 'Documents', color: ['#f59e0b', '#be123c'], menus: [{ key: 'all', label: 'Documents', model: 'documents.document' }, { key: 'requests', label: 'Request Document', model: 'documents.document', domain: (r) => r.is_request, defaults: { is_request: true } }, { label: 'Configuration', children: [{ key: 'folders', label: 'Workspaces', model: 'documents.folder' }, { key: 'workflow-actions', label: 'Workflow Actions', model: 'documents.workflow.rule' }, { key: 'tags', label: 'Tags', model: 'documents.tag' }, { key: 'shares', label: 'Share Links', model: 'documents.share' }] }] },
  {
    id: 'planning', name: 'Planning', color: ['#facc15', '#0d9488'],
    menus: [
      { key: 'schedule', label: 'Schedule', model: 'planning.slot' },
      { key: 'report', label: 'Reporting', model: 'planning.slot', view: 'pivot' },
      { label: 'Configuration', children: [{ key: 'templates', label: 'Shift Templates', model: 'planning.template' }] },
    ],
  },
  {
    id: 'rental', name: 'Rental', color: ['#ef4444', '#7c2d12'],
    menus: [
      { key: 'orders', label: 'Rental Orders', model: 'sale.rental' },
      { key: 'schedule', label: 'Schedule', model: 'sale.rental', view: 'gantt' },
      { key: 'deposits', label: 'Security Deposits', model: 'rental.deposit' },
      { key: 'report', label: 'Reporting', model: 'sale.rental', view: 'pivot' },
      { label: 'Configuration', children: [{ key: 'pricing', label: 'Rental Pricing', model: 'rental.pricing' }] },
    ],
  },
  {
    id: 'appointments', name: 'Appointments', color: ['#22d3ee', '#7c3aed'],
    menus: [
      { key: 'bookings', label: 'Bookings', model: 'appointment.booking' },
      { key: 'types', label: 'Appointment Types', model: 'appointment.type' },
      { key: 'report', label: 'Reporting', model: 'appointment.booking', view: 'pivot' },
    ],
  },
  {
    id: 'website', name: 'Website', color: ['#14b8a6', '#2563eb'],
    menus: [
      { key: 'site', label: 'Site', type: 'website' },
      { key: 'pages', label: 'Pages', model: 'website.page' },
      { key: 'menus', label: 'Menus', model: 'website.menu' },
      { key: 'redirects', label: 'Redirects', model: 'website.redirect' },
      { key: 'snippets', label: 'Building Blocks', model: 'website.snippet' },
      { label: 'eCommerce', children: [
        { key: 'shop_products', label: 'Products', model: 'product', view: 'kanban', domain: (r) => r.sale_ok !== false, defaults: { sale_ok: true, is_published: true } },
        { key: 'shop_categories', label: 'Product Categories', model: 'product.public.category' },
        { key: 'providers', label: 'Payment Providers', model: 'payment.provider' },
        { key: 'orders', label: 'Orders', model: 'sale.order', domain: (r) => r.source === 'website' },
      ] },
      { label: 'Blog', children: [
        { key: 'blog_posts', label: 'Posts', model: 'blog.post' },
        { key: 'blogs', label: 'Blogs', model: 'blog.blog' },
      ] },
      { label: 'Forum', children: [
        { key: 'forum_posts', label: 'Posts', model: 'forum.post' },
        { key: 'forums', label: 'Forums', model: 'forum.forum' },
      ] },
    ],
  },
  { id: 'barcode', name: 'Barcode', color: ['#334155', '#0f172a'], menus: [{ key: 'scan', label: 'Inventory Count', type: 'barcode' }] },
  { id: 'shopfloor', name: 'Shop Floor', color: ['#0891b2', '#065f46'], menus: [{ key: 'operations', label: 'Operations', type: 'shopfloor' }] },
  { id: 'dashboards', name: 'Dashboards', color: ['#6366f1', '#db2777'], menus: [{ key: 'overview', label: 'Overview', type: 'overview' }] },
  {
    id: 'maintenance', name: 'Maintenance', color: ['#f59e0b', '#475569'],
    menus: [
      { key: 'requests', label: 'Maintenance Requests', model: 'maintenance.request' },
      { key: 'equipment', label: 'Equipment', model: 'maintenance.equipment' },
    ],
  },
  {
    id: 'quality', name: 'Quality', color: ['#22c55e', '#1e40af'],
    menus: [
      { key: 'points', label: 'Control Points', model: 'quality.point' },
      { key: 'checks', label: 'Quality Checks', model: 'quality.check' },
      { key: 'alerts', label: 'Quality Alerts', model: 'quality.alert' },
    ],
  },
  {
    id: 'fleet', name: 'Fleet', color: ['#64748b', '#0ea5e9'],
    menus: [
      { key: 'vehicles', label: 'Vehicles', model: 'fleet.vehicle' },
      { key: 'services', label: 'Services', model: 'fleet.service' },
      { key: 'contracts', label: 'Contracts', model: 'fleet.contract' },
      { key: 'odometer', label: 'Odometer', model: 'fleet.odometer' },
      { key: 'fuel', label: 'Fuel Logs', model: 'fleet.fuel.log' },
    ],
  },
  {
    id: 'attendances', name: 'Attendances', color: ['#10b981', '#f97316'],
    menus: [
      { key: 'kiosk', label: 'Kiosk Mode', type: 'kiosk' },
      { key: 'attendances', label: 'Attendances', model: 'hr.attendance' },
      { key: 'overtime', label: 'Overtime to Approve', model: 'hr.attendance', domain: (r) => r.overtime_status === 'to_approve' },
      { label: 'Configuration', children: [{ key: 'overtime-rules', label: 'Overtime Rules', model: 'hr.attendance.overtime.rule' }] },
    ],
  },
  { id: 'appraisals', name: 'Appraisals', color: ['#e879f9', '#4f46e5'], menus: [{ key: 'appraisals', label: 'Appraisals', model: 'hr.appraisal' }, { key: 'goals', label: 'Goals', model: 'hr.appraisal.goal' }, { label: 'Configuration', children: [{ key: 'templates', label: 'Appraisal Templates', model: 'hr.appraisal.template' }] }] },
  {
    id: 'surveys', name: 'Surveys', color: ['#06b6d4', '#ea580c'],
    menus: [
      { key: 'surveys', label: 'Surveys', model: 'survey.survey' },
      { key: 'take', label: 'Take a Survey', type: 'surveytake' },
      { key: 'answers', label: 'Participations', model: 'survey.answer' },
      { key: 'results', label: 'Results', type: 'surveyresults' },
    ],
  },
  {
    id: 'lunch', name: 'Lunch', color: ['#fb923c', '#16a34a'],
    menus: [
      { key: 'orders', label: 'My Orders', model: 'lunch.order' },
      { key: 'products', label: 'Products', model: 'lunch.product', view: 'kanban' },
      { label: 'Manager', children: [
        { key: 'today', label: "Today's Orders", model: 'lunch.order', view: 'list', domain: (r) => r.date === today() },
        { key: 'vendors', label: 'Vendors', model: 'lunch.supplier' },
        { key: 'cashmoves', label: 'Cash Moves', model: 'lunch.cashmove' },
        { key: 'accounts', label: 'Control Accounts', model: 'lunch.cashmove', view: 'pivot' },
        { key: 'alerts', label: 'Alerts', model: 'lunch.alert' },
      ] },
    ],
  },
  { id: 'approvals', name: 'Approvals', color: ['#84cc16', '#0f766e'], menus: [{ key: 'requests', label: 'Approvals', model: 'approval.request' }, { label: 'Configuration', children: [{ key: 'approval-types', label: 'Approval Types', model: 'approval.category' }] }] },
  { id: 'repairs', name: 'Repairs', color: ['#78716c', '#dc2626'], menus: [{ key: 'orders', label: 'Repair Orders', model: 'repair.order' }] },
  { id: 'fieldservice', name: 'Field Service', color: ['#0d9488', '#ca8a04'], menus: [{ key: 'tasks', label: 'Field Service Tasks', model: 'fsm.task' }] },
  { id: 'frontdesk', name: 'Frontdesk', color: ['#a78bfa', '#0369a1'], menus: [{ key: 'visitors', label: 'Visitors', model: 'frontdesk.visitor' }, { label: 'Configuration', children: [{ key: 'stations', label: 'Stations', model: 'frontdesk.station' }] }] },
  { id: 'elearning', name: 'eLearning', color: ['#f43f5e', '#1d4ed8'], menus: [{ key: 'courses', label: 'Courses', model: 'slide.channel' }, { key: 'attendees', label: 'Attendees', model: 'slide.channel.partner' }] },
  {
    id: 'livechat', name: 'Live Chat', color: ['#38bdf8', '#7c3aed'],
    menus: [
      { key: 'sessions', label: 'Sessions', model: 'livechat.session' },
      { label: 'Configuration', children: [
        { key: 'channels', label: 'Channels', model: 'livechat.channel' },
        { key: 'canned', label: 'Canned Responses', model: 'livechat.canned' },
        { key: 'chatbots', label: 'Chatbots', model: 'livechat.chatbot' },
      ] },
      { key: 'report', label: 'Report', model: 'livechat.session', view: 'pivot' },
    ],
  },
  { id: 'sms', name: 'SMS Marketing', color: ['#a855f7', '#f43f5e'], menus: [{ key: 'campaigns', label: 'SMS Campaigns', model: 'sms.campaign' }, { key: 'traces', label: 'SMS Traces', model: 'sms.trace' }, { key: 'blacklist', label: 'Blacklisted Numbers', model: 'phone.blacklist' }] },
  {
    id: 'whatsapp', name: 'WhatsApp', color: ['#22c55e', '#0f766e'],
    menus: [
      { key: 'messages', label: 'Messages', model: 'whatsapp.message' },
      { key: 'templates', label: 'Templates', model: 'whatsapp.template' },
      { key: 'conversations', label: 'Conversations', model: 'whatsapp.message', view: 'list', groupBy: ['phone'] },
    ],
  },
  { id: 'social', name: 'Social Marketing', color: ['#3b82f6', '#ec4899'], menus: [{ key: 'posts', label: 'Posts', model: 'social.post' }, { key: 'accounts', label: 'Social Accounts', model: 'social.account' }] },
  { id: 'automation', name: 'Marketing Automation', color: ['#f97316', '#4f46e5'], menus: [{ key: 'campaigns', label: 'Campaigns', model: 'marketing.campaign' }, { key: 'participants', label: 'Participants', model: 'marketing.participant' }] },
  { id: 'plm', name: 'PLM', color: ['#16a34a', '#334155'], menus: [{ key: 'changes', label: 'Engineering Changes', model: 'mrp.eco' }, { key: 'boms', label: 'Bills of Materials', model: 'mrp.bom' }] },
  {
    id: 'rooms', name: 'Meeting Rooms', color: ['#0891b2', '#a21caf'],
    menus: [{ key: 'bookings', label: 'Room Bookings', model: 'room.booking' }, { key: 'rooms', label: 'Meeting Rooms', model: 'room.room' }],
  },
  { id: 'referral', name: 'Referrals', color: ['#facc15', '#9333ea'], menus: [{ key: 'referrals', label: 'Referrals', model: 'hr.referral' }, { label: 'Configuration', children: [{ key: 'rewards', label: 'Rewards', model: 'hr.referral.reward' }] }] },
  { id: 'skills', name: 'Skills', color: ['#14b8a6', '#9333ea'], menus: [{ key: 'employee-skills', label: 'Employee Skills', model: 'hr.employee.skill' }, { key: 'resume', label: 'Resume', model: 'hr.resume.line' }, { key: 'skills', label: 'Skills', model: 'hr.skill' }, { label: 'Configuration', children: [{ key: 'skill-types', label: 'Skill Types', model: 'hr.skill.type' }] }] },
  { id: 'esg', name: 'ESG', color: ['#22c55e', '#15803d'], menus: [{ key: 'emissions', label: 'Emissions', model: 'esg.emission' }, { key: 'report', label: 'Carbon Footprint', model: 'esg.emission', view: 'pivot' }] },
  {
    id: 'equity', name: 'Equity', color: ['#0f766e', '#a16207'],
    menus: [{ key: 'captable', label: 'Cap Table', type: 'captable' }, { key: 'transactions', label: 'Transactions', model: 'equity.transaction' }],
  },
  { id: 'recycle', name: 'Data Recycle', color: ['#65a30d', '#334155'], menus: [{ key: 'rules', label: 'Recycle Rules', model: 'data.recycle' }] },
  { id: 'phone', name: 'Phone', color: ['#22c55e', '#0369a1'], menus: [{ key: 'calls', label: 'Calls', model: 'phone.call' }] },
  { id: 'iot', name: 'IoT', color: ['#475569', '#0ea5e9'], menus: [{ key: 'devices', label: 'IoT Devices', model: 'iot.device' }] },
  { id: 'studio', name: 'Studio', color: ['#0ea5e9', '#9333ea'], menus: [{ key: 'fields', label: 'Custom Fields', type: 'studio' }] },
  { id: 'apps', name: 'Apps', color: ['#ef4444', '#3b82f6'], menus: [{ key: 'store', label: 'Apps', type: 'appstore' }] },
  { id: 'todo', name: 'To-do', color: ['#14b8a6', '#334155'], menus: [{ key: 'tasks', label: 'To-do', model: 'todo.task' }] },
  { id: 'spreadsheet', name: 'Spreadsheet', color: ['#16a34a', '#0f766e'], menus: [{ key: 'sheet', label: 'Spreadsheet', type: 'spreadsheet' }, { key: 'all', label: 'All Spreadsheets', model: 'spreadsheet.document' }] },
  { id: 'knowledge', name: 'Knowledge', color: ['#e11d48', '#7e22ce'], menus: [{ key: 'articles', label: 'Articles', type: 'knowledge' }, { key: 'all', label: 'All Articles', model: 'knowledge.article' }] },
  { id: 'settings', name: 'Settings', color: ['#94a3b8', '#475569'], menus: [{ key: 'general', label: 'General Settings', type: 'settings' }, { key: 'companies', label: 'Companies', model: 'res.company' }] },
];

// Home-screen order: communication, sales, finance, services, supply chain, HR, settings.
const ORDER = ['discuss', 'calendar', 'appointments', 'todo', 'knowledge', 'contacts', 'crm', 'sales', 'dashboards', 'subscriptions', 'rental',
  'pos', 'kitchen', 'accounting', 'documents', 'spreadsheet', 'project', 'timesheets', 'planning', 'helpdesk', 'website', 'marketing', 'events', 'purchase', 'inventory',
  'manufacturing', 'shopfloor', 'barcode', 'quality', 'maintenance', 'repairs', 'fieldservice', 'sign', 'employees', 'attendances',
  'recruitment', 'timeoff', 'appraisals', 'payroll', 'expenses', 'fleet', 'lunch', 'approvals', 'frontdesk', 'surveys', 'elearning', 'livechat', 'whatsapp', 'sms', 'social', 'automation', 'plm', 'rooms', 'referral', 'skills', 'esg', 'equity', 'recycle', 'phone', 'iot', 'studio', 'apps', 'settings'];

/** App-store category and one-line summary. */
export const APP_INFO = {
  discuss: ['Productivity', 'Chat, channels and activities'], calendar: ['Productivity', 'Schedule meetings'], appointments: ['Productivity', 'Let people book time with you'],
  todo: ['Productivity', 'Organize your work'], knowledge: ['Productivity', 'Centralize your knowledge'], contacts: ['Sales', 'Centralize your address book'],
  crm: ['Sales', 'Track leads and close opportunities'], sales: ['Sales', 'From quotations to invoices'], dashboards: ['Productivity', 'Key figures across apps'],
  subscriptions: ['Sales', 'Recurring revenue and renewals'], rental: ['Sales', 'Rental contracts, pickups and returns'], pos: ['Sales', 'Shop checkout and payments'], kitchen: ['Sales', 'Send POS orders to the kitchen screen'],
  accounting: ['Accounting', 'Invoices, payments and financial reports'], documents: ['Productivity', 'Collect and organize documents'], spreadsheet: ['Productivity', 'Spreadsheets on live business data'],
  project: ['Services', 'Tasks and projects'], timesheets: ['Services', 'Track time on tasks'], planning: ['Services', 'Employee schedules'],
  helpdesk: ['Services', 'Solve customer tickets'], website: ['Website', 'Website builder and online shop'], marketing: ['Marketing', 'Design, send and track emails'],
  events: ['Marketing', 'Organize events and registrations'], purchase: ['Supply Chain', 'Purchase orders and vendor bills'], inventory: ['Supply Chain', 'Stock and logistics'],
  manufacturing: ['Supply Chain', 'Manufacturing orders and BoMs'], shopfloor: ['Supply Chain', 'Operator workstation'], barcode: ['Supply Chain', 'Scan and count stock'],
  quality: ['Supply Chain', 'Control the quality of your products'], maintenance: ['Supply Chain', 'Equipment and maintenance requests'], repairs: ['Supply Chain', 'Repair damaged products'],
  fieldservice: ['Services', 'Plan on-site interventions'], sign: ['Productivity', 'Electronic signatures'], employees: ['Human Resources', 'Employee directory'],
  attendances: ['Human Resources', 'Track employee attendance'], recruitment: ['Human Resources', 'Recruitment pipeline'], timeoff: ['Human Resources', 'Leave requests'],
  appraisals: ['Human Resources', 'Assess your employees'], payroll: ['Human Resources', 'Payslips and salary entries'], expenses: ['Human Resources', 'Employee expenses'],
  fleet: ['Human Resources', 'Vehicles and their costs'], lunch: ['Human Resources', 'Lunch orders'], approvals: ['Human Resources', 'Approval requests'],
  frontdesk: ['Productivity', 'Visitor management'], studio: ['Customizations', 'Add fields to any app without code'],
  phone: ['Productivity', 'Click-to-call and call log'], iot: ['Administration', 'Connect scales, sensors and devices'],
  equity: ['Accounting', 'Shareholders and cap table'], recycle: ['Administration', 'Archive old records automatically'],
  livechat: ['Website', 'Chat with your website visitors'], sms: ['Marketing', 'Design, send and track SMS'], whatsapp: ['Marketing', 'Templates and conversations on WhatsApp'], social: ['Marketing', 'Manage your social media posts'],
  automation: ['Marketing', 'Automated multi-step campaigns'], plm: ['Supply Chain', 'Engineering change orders'], rooms: ['Productivity', 'Book meeting rooms'],
  referral: ['Human Resources', 'Employees refer candidates'], skills: ['Human Resources', 'Employee skills and levels'], esg: ['ESG', 'Measure your carbon footprint'], surveys: ['Marketing', 'Create and run surveys'], elearning: ['Website', 'Online courses'],
};
// Read-only analyses get an "Analysis" menu in their app (see analysis.js).
const withAnalyses = (app) => {
  const own = appAnalyses.filter((a) => a.app === app.id);
  if (!own.length) return app;
  return { ...app, menus: [...app.menus, { label: 'Analysis', children: own.map((a) => ({ key: a.key, label: a.label, type: 'analysis', analysis: a.key })) }] };
};
export const apps = [...allApps].map(withAnalyses).sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));

export const leavesOf = (app) => {
  const walk = (items) => (items ?? []).flatMap((m) => (m.children ? walk(m.children) : [m]));
  return walk(app?.menus);
};

const SHARED = ['mail.activity', 'discuss.channel', 'res.partner', 'product'];
/** Accounting, HR and company records: only an app that shows them in its menus may change them. */
const PROTECTED = ['account.move', 'account.payment', 'account.account', 'account.journal', 'account.tax', 'account.fiscal.position',
  'account.bank.statement.line', 'hr.employee', 'hr.contract', 'hr.payslip', 'hr.payslip.run', 'res.company'];
const HR_OWNERS = ['hr.employee', 'hr.contract', 'hr.payslip', 'hr.payslip.run'];
/** Private employee fields, and the menu models whose users may see them. */
const PRIVATE_FIELDS = {
  'hr.employee': {
    ...Object.fromEntries(['wage', 'private_email', 'private_phone', 'private_address', 'birthday', 'place_of_birth', 'gender', 'marital', 'children',
      'nationality', 'identification_id', 'passport_id', 'visa_no', 'permit_no', 'visa_expire', 'bank_account', 'emergency_contact', 'emergency_phone',
      'departure_reason'].map((f) => [f, HR_OWNERS])),
    // ponytail: the attendance kiosk still checks PINs in the browser; move that check to the server.
    pin: [...HR_OWNERS, 'hr.attendance'],
    badge_id: [...HR_OWNERS, 'hr.attendance'],
  },
};

/** Accounting configuration: every app may read it (products and documents point to it), only Accounting users change it. */
export const ACCOUNTING_CONFIG = ['account.account', 'account.tax', 'account.journal', 'account.fiscal.position', 'account.fiscal.year',
  'account.incoterm', 'account.tax.unit', 'account.account.tag', 'account.asset.model'];

/** Models a user restricted to `appIds` may read but not write (null when nothing is held back). */
export const readOnlyForApps = (appIds) => (appIds.includes('accounting') ? null : new Set(ACCOUNTING_CONFIG));

/** Models on the menus of `appIds`, plus the shared basics. */
export function menuModelsForApps(appIds) {
  const base = new Set(SHARED);
  for (const app of apps.filter((a) => appIds.includes(a.id))) {
    for (const leaf of leavesOf(app)) if (leaf.model) base.add(leaf.model);
  }
  return base;
}

/** Models a user restricted to `appIds` may write: the readable ones, minus accounting, HR and company records their apps don't show. */
export function writableModelsForApps(appIds) {
  const base = menuModelsForApps(appIds);
  return new Set([...modelsForApps(appIds)].filter((m) => base.has(m) || !PROTECTED.includes(m)));
}

/** `db` without the private employee fields the apps in `appIds` may not see. */
export function redactForApps(db, appIds) {
  const base = menuModelsForApps(appIds);
  let records = db.records;
  for (const [model, fields] of Object.entries(PRIVATE_FIELDS)) {
    const hidden = Object.keys(fields).filter((f) => !fields[f].some((m) => base.has(m)));
    if (!hidden.length || !records[model]) continue;
    records = { ...records, [model]: records[model].map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !hidden.includes(k)))) };
  }
  return records === db.records ? db : { ...db, records };
}

/** Models a user restricted to `appIds` may read: their menus' models, related models, shared basics. */
export function modelsForApps(appIds) {
  const base = menuModelsForApps(appIds);
  const out = new Set(base);
  // Barcode counts update located stock through the same quantity path as inventory operations.
  if (appIds.includes('barcode')) out.add('stock.quant');
  for (const m of base) {
    for (const f of Object.values(models[m].fields)) {
      if (f.relation) out.add(f.relation);
      for (const sub of Object.values(f.fields ?? {})) if (sub.relation) out.add(sub.relation);
    }
  }
  return out;
}

/** Models only uninstalled apps use (none of the installed apps reaches them); the REST API refuses them. */
export function uninstalledModels(uninstalled = []) {
  if (!uninstalled.length) return new Set();
  const reachable = modelsForApps(apps.map((a) => a.id).filter((id) => !uninstalled.includes(id)));
  return new Set(Object.keys(models).filter((m) => !reachable.has(m)));
}

/** "#/app/menu" of the first unfiltered menu showing `model` (used to open any record from anywhere). */
export function targetOf(model, uninstalled = []) {
  for (const app of apps) {
    if (uninstalled.includes(app.id)) continue;
    const leaf = leavesOf(app).find((l) => l.model === model && !l.domain);
    if (leaf) return `#/${app.id}/${leaf.key}`;
  }
  return '#/';
}
export const findLeaf = (app, key) => leavesOf(app).find((l) => l.key === key) ?? leavesOf(app)[0];
export const menusFor = (appId) => apps.find((a) => a.id === appId)?.menus ?? [];
