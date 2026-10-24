// Model registry: every view (kanban/list/form) is rendered from these definitions.
// Adding an app = adding a model here + an entry in `apps`.

export const today = () => new Date().toISOString().slice(0, 10);

const lineTotal = (lines = []) =>
  lines.reduce((sum, l) => sum + (Number(l.qty) || 0) * (Number(l.price_unit) || 0), 0);

export const models = {
  'res.partner': {
    label: 'Contacts',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      is_company: { type: 'boolean', label: 'Company' },
      email: { type: 'char', label: 'Email' },
      phone: { type: 'char', label: 'Phone' },
      city: { type: 'char', label: 'City' },
      country: { type: 'char', label: 'Country' },
      tag_ids: { type: 'tags', label: 'Tags' },
    },
    defaults: () => ({ tag_ids: [] }),
    kanban: { title: 'name', lines: ['email', 'city'], tags: 'tag_ids', avatar: true },
    list: ['name', 'email', 'phone', 'city', 'country'],
    form: {
      title: 'name',
      groups: [['is_company', 'email', 'phone'], ['city', 'country', 'tag_ids']],
      chatter: true,
    },
  },

  'crm.lead': {
    label: 'Pipeline',
    fields: {
      name: { type: 'char', label: 'Opportunity', required: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Contact' },
      email: { type: 'char', label: 'Email' },
      phone: { type: 'char', label: 'Phone' },
      expected_revenue: { type: 'monetary', label: 'Expected Revenue' },
      probability: { type: 'float', label: 'Probability (%)' },
      stage_id: {
        type: 'selection',
        label: 'Stage',
        tracking: true,
        options: [['new', 'New'], ['qualified', 'Qualified'], ['proposition', 'Proposition'], ['won', 'Won']],
      },
      user: { type: 'char', label: 'Salesperson' },
      date_deadline: { type: 'date', label: 'Expected Closing' },
      priority: { type: 'priority', label: 'Priority' },
      tag_ids: { type: 'tags', label: 'Tags' },
      description: { type: 'text', label: 'Notes' },
    },
    defaults: () => ({ stage_id: 'new', probability: 10, user: 'Admin', priority: 0, tag_ids: [] }),
    kanban: {
      groupBy: 'stage_id',
      title: 'name',
      lines: ['expected_revenue', 'partner_id'],
      tags: 'tag_ids',
      priority: 'priority',
      badge: 'user',
      sum: 'expected_revenue',
      quickCreate: true,
    },
    list: ['name', 'partner_id', 'email', 'user', 'expected_revenue', 'stage_id'],
    form: {
      statusbar: 'stage_id',
      buttons: [
        { label: 'Won', primary: true, vals: { stage_id: 'won', probability: 100 }, when: (r) => r.stage_id !== 'won' },
        { label: 'Lost', vals: { active: false, probability: 0 } },
      ],
      title: 'name',
      groups: [
        ['expected_revenue', 'probability', 'partner_id', 'email', 'phone'],
        ['user', 'date_deadline', 'priority', 'tag_ids'],
      ],
      tabs: [{ label: 'Notes', fields: ['description'] }],
      chatter: true,
    },
  },

  product: {
    label: 'Products',
    fields: {
      name: { type: 'char', label: 'Product Name', required: true },
      type: { type: 'selection', label: 'Product Type', options: [['goods', 'Goods'], ['service', 'Service']] },
      list_price: { type: 'monetary', label: 'Sales Price' },
      cost: { type: 'monetary', label: 'Cost' },
      qty_available: { type: 'float', label: 'On Hand' },
    },
    defaults: () => ({ type: 'goods', list_price: 0, cost: 0, qty_available: 0 }),
    kanban: { title: 'name', lines: ['list_price', 'qty_available'], avatar: true },
    list: ['name', 'type', 'list_price', 'cost', 'qty_available'],
    form: { title: 'name', groups: [['type', 'list_price', 'cost'], ['qty_available']], chatter: true },
  },

  'sale.order': {
    label: 'Quotations',
    views: ['list', 'kanban'],
    fields: {
      name: { type: 'char', label: 'Number', readonly: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Customer', required: true },
      date_order: { type: 'date', label: 'Order Date' },
      state: {
        type: 'selection',
        label: 'Status',
        tracking: true,
        options: [['draft', 'Quotation'], ['sent', 'Quotation Sent'], ['sale', 'Sales Order'], ['cancel', 'Cancelled']],
      },
      order_line: {
        type: 'one2many',
        label: 'Order Lines',
        fields: {
          product_id: { type: 'many2one', relation: 'product', label: 'Product' },
          qty: { type: 'float', label: 'Quantity' },
          price_unit: { type: 'monetary', label: 'Unit Price' },
        },
      },
      amount_total: { type: 'monetary', label: 'Total', compute: (r) => lineTotal(r.order_line) },
    },
    defaults: (id) => ({ name: 'S' + String(id).padStart(5, '0'), date_order: today(), state: 'draft', order_line: [] }),
    kanban: { title: 'name', lines: ['partner_id', 'amount_total'], badge: 'state' },
    list: ['name', 'date_order', 'partner_id', 'amount_total', 'state'],
    form: {
      statusbar: 'state',
      statusbarHide: ['cancel'],
      buttons: [
        { label: 'Send by Email', vals: { state: 'sent' }, when: (r) => r.state === 'draft' },
        { label: 'Confirm', primary: true, vals: { state: 'sale' }, when: (r) => ['draft', 'sent'].includes(r.state) },
        { label: 'Cancel', vals: { state: 'cancel' }, when: (r) => r.state !== 'cancel' },
      ],
      title: 'name',
      groups: [['partner_id'], ['date_order']],
      tabs: [{ label: 'Order Lines', fields: ['order_line'] }],
      footer: 'amount_total',
      chatter: true,
    },
  },
};

export const apps = [
  {
    id: 'crm',
    name: 'CRM',
    color: ['#14b8a6', '#0e7490'],
    menus: [
      { label: 'Pipeline', model: 'crm.lead' },
      { label: 'Customers', model: 'res.partner' },
    ],
  },
  {
    id: 'sales',
    name: 'Sales',
    color: ['#f59e0b', '#dc2626'],
    menus: [
      { label: 'Quotations', model: 'sale.order' },
      { label: 'Products', model: 'product' },
      { label: 'Customers', model: 'res.partner' },
    ],
  },
  { id: 'contacts', name: 'Contacts', color: ['#6366f1', '#4338ca'], menus: [{ label: 'Contacts', model: 'res.partner' }] },
  { id: 'inventory', name: 'Inventory', color: ['#a855f7', '#be185d'], menus: [{ label: 'Products', model: 'product' }] },
];

export const viewsOf = (model) => models[model].views ?? ['kanban', 'list'];
