// Model registry + application menus. Every view is rendered from these definitions.
import { crmModels } from './crm.js';
import { salesModels } from './sales.js';
import { accountingModels } from './accounting.js';
import { workModels } from './work.js';

export { today } from './common.js';

export const models = { ...crmModels, ...salesModels, ...accountingModels, ...workModels };

export const viewsOf = (model) => models[model].views ?? ['kanban', 'list'];

const customers = { key: 'customers', label: 'Customers', model: 'res.partner' };
const vendors = { key: 'vendors', label: 'Vendors', model: 'res.partner' };
const products = { key: 'products', label: 'Products', model: 'product' };

/**
 * A menu leaf is { key, label, model, view?, domain?, defaults? } or { key, label, type } for custom pages.
 * Top-level menus may group leaves under `children`.
 */
export const apps = [
  {
    id: 'crm', name: 'CRM', color: ['#14b8a6', '#0e7490'],
    menus: [
      { label: 'Sales', children: [
        { key: 'pipeline', label: 'My Pipeline', model: 'crm.lead' },
        { key: 'quotations', label: 'Quotations', model: 'sale.order' },
        customers,
      ] },
      { label: 'Reporting', children: [
        { key: 'analysis', label: 'Pipeline Analysis', model: 'crm.lead', view: 'graph' },
        { key: 'forecast', label: 'Forecast', model: 'crm.lead', view: 'pivot' },
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
      { label: 'Products', children: [products] },
      { key: 'report', label: 'Reporting', model: 'sale.order', view: 'graph' },
    ],
  },
  {
    id: 'accounting', name: 'Invoicing', color: ['#ec4899', '#7c3aed'],
    menus: [
      { key: 'dashboard', label: 'Dashboard', type: 'dashboard' },
      { label: 'Customers', children: [
        { key: 'invoices', label: 'Invoices', model: 'account.move', domain: (r) => r.move_type === 'out_invoice', defaults: { move_type: 'out_invoice' } },
        customers,
      ] },
      { label: 'Vendors', children: [
        { key: 'bills', label: 'Bills', model: 'account.move', domain: (r) => r.move_type === 'in_invoice', defaults: { move_type: 'in_invoice' } },
        vendors,
      ] },
      { label: 'Reporting', children: [
        { key: 'invoice-analysis', label: 'Invoice Analysis', model: 'account.move', view: 'pivot' },
      ] },
    ],
  },
  {
    id: 'purchase', name: 'Purchase', color: ['#64748b', '#0f766e'],
    menus: [
      { label: 'Orders', children: [
        { key: 'rfq', label: 'Requests for Quotation', model: 'purchase.order' },
        { key: 'po', label: 'Purchase Orders', model: 'purchase.order', domain: (r) => r.state === 'purchase' },
        vendors,
      ] },
      { label: 'Products', children: [products] },
      { key: 'report', label: 'Reporting', model: 'purchase.order', view: 'graph' },
    ],
  },
  {
    id: 'inventory', name: 'Inventory', color: ['#a855f7', '#be185d'],
    menus: [
      { key: 'products', label: 'Products', model: 'product' },
      { key: 'stock', label: 'Stock', model: 'product', view: 'list', domain: (r) => r.type === 'goods' },
      { key: 'report', label: 'Reporting', model: 'product', view: 'pivot', domain: (r) => r.type === 'goods' },
    ],
  },
  { id: 'contacts', name: 'Contacts', color: ['#6366f1', '#4338ca'], menus: [{ key: 'contacts', label: 'Contacts', model: 'res.partner' }] },
  { id: 'calendar', name: 'Calendar', color: ['#0ea5e9', '#1d4ed8'], menus: [{ key: 'meetings', label: 'Meetings', model: 'calendar.event' }] },
  {
    id: 'project', name: 'Project', color: ['#22c55e', '#15803d'],
    menus: [
      { key: 'projects', label: 'Projects', model: 'project.project' },
      { key: 'tasks', label: 'All Tasks', model: 'project.task' },
      { key: 'report', label: 'Reporting', model: 'project.task', view: 'pivot' },
    ],
  },
  {
    id: 'helpdesk', name: 'Helpdesk', color: ['#f97316', '#b91c1c'],
    menus: [
      { key: 'tickets', label: 'Tickets', model: 'helpdesk.ticket' },
      { key: 'report', label: 'Reporting', model: 'helpdesk.ticket', view: 'graph' },
    ],
  },
  {
    id: 'employees', name: 'Employees', color: ['#06b6d4', '#4f46e5'],
    menus: [
      { key: 'employees', label: 'Employees', model: 'hr.employee' },
      { key: 'departments', label: 'Departments', model: 'hr.department' },
    ],
  },
  { id: 'settings', name: 'Settings', color: ['#94a3b8', '#475569'], menus: [{ key: 'general', label: 'General Settings', type: 'settings' }] },
];

export const leavesOf = (app) => app.menus.flatMap((m) => m.children ?? [m]);
export const findLeaf = (app, key) => leavesOf(app).find((l) => l.key === key) ?? leavesOf(app)[0];
