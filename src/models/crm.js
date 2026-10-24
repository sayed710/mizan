import { today } from './common.js';

export const crmModels = {
  'res.partner': {
    label: 'Contacts',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      is_company: { type: 'boolean', label: 'Company' },
      email: { type: 'char', label: 'Email' },
      phone: { type: 'char', label: 'Phone' },
      city: { type: 'char', label: 'City' },
      country: { type: 'char', label: 'Country' },
      vat: { type: 'char', label: 'Tax ID' },
      pricelist_id: { type: 'many2one', relation: 'product.pricelist', label: 'Pricelist' },
      tag_ids: { type: 'tags', label: 'Tags' },
    },
    defaults: () => ({ tag_ids: [] }),
    filters: [[
      { id: 'companies', label: 'Companies', fn: (r) => r.is_company },
      { id: 'individuals', label: 'Individuals', fn: (r) => !r.is_company },
    ]],
    groupBys: ['country', 'city', 'is_company'],
    kanban: { title: 'name', lines: ['email', 'city', 'country'], tags: 'tag_ids', avatar: true },
    list: ['name', 'email', 'phone', 'city', 'country'],
    form: {
      title: 'name',
      smart: [
        { label: 'Opportunities', model: 'crm.lead', field: 'partner_id', target: 'crm/pipeline' },
        { label: 'Sales', model: 'sale.order', field: 'partner_id', target: 'sales/quotations' },
        { label: 'Invoiced', model: 'account.move', field: 'partner_id', target: 'accounting/invoices', sum: 'amount_total' },
      ],
      groups: [['is_company', 'email', 'phone', 'vat'], ['city', 'country', 'pricelist_id', 'tag_ids']],
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
      create_date: { type: 'date', label: 'Created on', readonly: true },
      priority: { type: 'priority', label: 'Priority' },
      tag_ids: { type: 'tags', label: 'Tags' },
      description: { type: 'text', label: 'Notes' },
    },
    onchange: (r, key, db) => {
      if (key === 'stage_id') return { probability: { new: 10, qualified: 30, proposition: 60, won: 100 }[r.stage_id] ?? r.probability };
      if (key !== 'partner_id' || !r.partner_id) return {};
      const p = (db.records['res.partner'] ?? []).find((x) => x.id === r.partner_id);
      return p ? { email: r.email || p.email || '', phone: r.phone || p.phone || '' } : {};
    },
    defaults: () => ({ stage_id: 'new', probability: 10, user: 'Admin', priority: 0, tag_ids: [], create_date: today() }),
    filters: [
      [{ id: 'mine', label: 'My Pipeline', fn: (r) => r.user === 'Admin' }, { id: 'unassigned', label: 'Unassigned', fn: (r) => !r.user }],
      [
        { id: 'won', label: 'Won', fn: (r) => r.stage_id === 'won' },
        { id: 'ongoing', label: 'Ongoing', fn: (r) => r.stage_id !== 'won' },
        { id: 'overdue', label: 'Overdue', fn: (r) => r.stage_id !== 'won' && r.date_deadline && r.date_deadline < today() },
      ],
    ],
    groupBys: ['stage_id', 'user', 'partner_id', 'date_deadline', 'create_date'],
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
    graph: { groupBy: 'stage_id', measure: 'expected_revenue' },
    pivot: { row: 'create_date', col: 'stage_id', measure: 'expected_revenue' },
    calendar: { date: 'date_deadline' },
    views: ['kanban', 'list', 'graph', 'pivot', 'calendar'],
    form: {
      statusbar: 'stage_id',
      statusbarClickable: true,
      buttons: [
        { label: 'Won', primary: true, vals: { stage_id: 'won', probability: 100 }, when: (r) => r.stage_id !== 'won' },
        { label: 'Lost', vals: { active: false, probability: 0 }, when: (r) => r.active !== false },
        { label: 'Restore', vals: { active: true }, when: (r) => r.active === false },
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
};
