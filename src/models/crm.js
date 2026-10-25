import { create, write } from '../orm.js';
import { today } from './common.js';

const LOST_REASONS = [['price', 'Too expensive'], ['competitor', 'We lost to a competitor'], ['timing', 'Not the right timing'], ['no_answer', 'No answer'], ['other', 'Other']];

/** Lead → opportunity; creates the customer from the lead's company/contact when none is set. */
export function convertLead(db, r) {
  if (r.partner_id || !(r.partner_name || r.contact_name)) return write(db, 'crm.lead', r.id, { type: 'opportunity' });
  const { db: withPartner, id } = create(db, 'res.partner', { name: r.partner_name || r.contact_name, is_company: !!r.partner_name, email: r.email ?? '', phone: r.phone ?? '', city: r.city ?? '', country: r.country ?? '' });
  return write(withPartner, 'crm.lead', r.id, { type: 'opportunity', partner_id: id });
}

/** Draft quotation for the opportunity's customer, linked back to it. */
function newQuotation(db, r) {
  if (!r.partner_id) throw new Error('Set a customer on the opportunity first');
  const { db: next, id } = create(db, 'sale.order', { partner_id: r.partner_id, opportunity_id: r.id, user: r.user, order_line: [] });
  return { db: next, go: `#/sales/quotations/${id}` };
}

function markLost(db, r) {
  const options = LOST_REASONS.map(([, label], i) => `${i + 1}. ${label}`).join('\n');
  const pick = prompt(`Lost reason:\n${options}`, '1');
  if (pick == null) return { db };
  const reason = LOST_REASONS[Number(pick) - 1]?.[0] ?? 'other';
  return { db: write(db, 'crm.lead', r.id, { active: false, probability: 0, lost_reason: reason }) };
}

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
      credit_limit: { type: 'monetary', label: 'Credit Limit' },
      property_payment_term_id: { type: 'many2one', relation: 'account.payment.term', label: 'Payment Terms' },
      property_account_position_id: { type: 'many2one', relation: 'account.fiscal.position', label: 'Fiscal Position' },
      followup_level_delay: { type: 'integer', label: 'Last Reminder Level (days)', readonly: true },
      followup_date: { type: 'date', label: 'Last Reminder', readonly: true },
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
      buttons: [{ label: 'WhatsApp', server: '/api/integrations/whatsapp', requires: 'whatsapp', when: (r) => r.phone, run: (db, r) => { window.open(`https://wa.me/${String(r.phone).replace(/[^\d]/g, '')}`, '_blank', 'noopener'); return { db }; } }],
      groups: [['is_company', 'email', 'phone', 'vat'], ['city', 'country', 'pricelist_id', 'property_payment_term_id', 'credit_limit', 'tag_ids']],
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
      type: { type: 'selection', label: 'Type', options: [['lead', 'Lead'], ['opportunity', 'Opportunity']] },
      lost_reason: { type: 'selection', label: 'Lost Reason', options: LOST_REASONS },
      partner_name: { type: 'char', label: 'Company Name' },
      contact_name: { type: 'char', label: 'Contact Name' },
      website: { type: 'char', label: 'Website' },
      street: { type: 'char', label: 'Street' },
      city: { type: 'char', label: 'City' },
      country: { type: 'char', label: 'Country' },
      campaign_id: { type: 'many2one', relation: 'marketing.campaign', label: 'Campaign' },
      medium: { type: 'selection', label: 'Medium', options: [['email', 'Email'], ['phone', 'Phone'], ['website', 'Website'], ['social', 'Social Media'], ['referral', 'Referral']] },
      source: { type: 'char', label: 'Source' },
    },
    onchange: (r, key, db) => {
      if (key === 'stage_id') return { probability: { new: 10, qualified: 30, proposition: 60, won: 100 }[r.stage_id] ?? r.probability };
      if (key !== 'partner_id' || !r.partner_id) return {};
      const p = (db.records['res.partner'] ?? []).find((x) => x.id === r.partner_id);
      return p ? { email: r.email || p.email || '', phone: r.phone || p.phone || '' } : {};
    },
    defaults: () => ({ type: 'opportunity', stage_id: 'new', probability: 10, user: 'Admin', priority: 0, tag_ids: [], create_date: today() }),
    filters: [
      [{ id: 'mine', label: 'My Pipeline', fn: (r) => r.user === 'Admin' }, { id: 'unassigned', label: 'Unassigned', fn: (r) => !r.user }],
      [
        { id: 'won', label: 'Won', fn: (r) => r.stage_id === 'won' },
        { id: 'ongoing', label: 'Ongoing', fn: (r) => r.stage_id !== 'won' },
        { id: 'overdue', label: 'Overdue', fn: (r) => r.stage_id !== 'won' && r.date_deadline && r.date_deadline < today() },
      ],
    ],
    groupBys: ['stage_id', 'user', 'partner_id', 'lost_reason', 'medium', 'date_deadline', 'create_date'],
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
        { label: 'Convert to Opportunity', primary: true, when: (r) => r.type === 'lead', run: (db, r) => ({ db: convertLead(db, r) }) },
        { label: 'New Quotation', primary: true, when: (r) => r.type !== 'lead' && r.active !== false, run: newQuotation },
        { label: 'Won', primary: true, vals: { stage_id: 'won', probability: 100 }, when: (r) => r.type !== 'lead' && r.stage_id !== 'won' },
        { label: 'Lost', when: (r) => r.active !== false, run: markLost },
        { label: 'Restore', vals: { active: true, lost_reason: null }, when: (r) => r.active === false },
      ],
      ribbon: (r) => (r.active === false ? 'Lost' : r.stage_id === 'won' ? 'Won' : null),
      smart: [{ label: 'Quotations', model: 'sale.order', field: 'opportunity_id', target: 'sales/quotations', sum: 'amount_total' }],
      title: 'name',
      groups: [
        ['expected_revenue', 'probability', 'partner_id', 'email', 'phone'],
        ['user', 'date_deadline', 'priority', 'tag_ids'],
      ],
      tabs: [
        { label: 'Notes', fields: ['description'] },
        { label: 'Extra Info', fields: ['partner_name', 'contact_name', 'website', 'street', 'city', 'country', 'campaign_id', 'medium', 'source', 'lost_reason'] },
      ],
      chatter: true,
    },
  },
};
