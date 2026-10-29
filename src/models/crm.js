import { create, read, write } from '../orm.js';
import { today } from './common.js';
import { syncPartnerBankAccounts, validatePartnerBankLines } from './partnerbank.js';

export function isRotting(db, model, r) {
  if (!r) return false;
  const stageModel = model === 'crm.lead' ? 'crm.stage' : model === 'project.task' ? 'project.task.type' : null;
  if (!stageModel || !r.stage_id) return false;
  const stages = db?.records?.[stageModel] ?? [];
  const stage = typeof r.stage_id === 'number'
    ? stages.find((s) => s.id === r.stage_id)
    : stages.find((s) => s.name?.toLowerCase() === String(r.stage_id).toLowerCase());
  if (!stage || !stage.rotting_threshold_days || stage.rotting_threshold_days <= 0) return false;
  if (stage.is_won || stage.fold || r.active === false || r.state === 'done' || r.state === 'canceled') return false;
  const stageDate = r.date_last_stage_update || r.create_date || r.date_start || today();
  const diffDays = Math.floor((Date.parse(today()) - Date.parse(stageDate)) / (1000 * 60 * 60 * 24));
  return diffDays > stage.rotting_threshold_days;
}

export function stageColumnsFor(db, model, context = {}) {
  const stageModel = model === 'crm.lead' ? 'crm.stage' : model === 'project.task' ? 'project.task.type' : null;
  if (!stageModel) return [];
  let stages = db?.records?.[stageModel] ?? [];
  if (model === 'crm.lead' && context.team_id) {
    stages = stages.filter((s) => !s.team_ids?.length || s.team_ids.includes(context.team_id));
  } else if (model === 'project.task' && context.project_id) {
    stages = stages.filter((s) => !s.project_ids?.length || s.project_ids.includes(context.project_id));
  }
  return [...stages].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.id - b.id).map((s) => ({
    key: s.id,
    label: s.name,
    fold: !!s.fold,
    requirements: s.requirements ?? '',
    rotting_threshold_days: s.rotting_threshold_days ?? 0,
    is_won: !!s.is_won,
  }));
}

export function isWonLead(db, r) {
  if (!r) return false;
  if (r.stage_id === 'won' || r.stage_id === 4) return true;
  if (db?.records?.['crm.stage']) {
    const s = (db.records['crm.stage'] ?? []).find((x) => x.id === r.stage_id || x.name?.toLowerCase() === String(r.stage_id).toLowerCase());
    if (s?.is_won) return true;
  }
  return r.probability === 100;
}

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

export const crmModels = {
  'crm.stage': {
    label: 'Stages',
    fields: {
      name: { type: 'char', label: 'Stage Name', required: true },
      sequence: { type: 'integer', label: 'Sequence' },
      is_won: { type: 'boolean', label: 'Is Won Stage' },
      fold: { type: 'boolean', label: 'Folded in Pipeline' },
      requirements: { type: 'text', label: 'Requirements' },
      rotting_threshold_days: { type: 'integer', label: 'Rotting Threshold (Days)' },
      team_ids: { type: 'many2many', relation: 'crm.team', label: 'Sales Teams' },
    },
    defaults: (id) => ({ sequence: id ?? 10, is_won: false, fold: false, team_ids: [], rotting_threshold_days: 0 }),
    list: ['name', 'sequence', 'is_won', 'fold', 'rotting_threshold_days'],
    form: {
      title: 'name',
      groups: [
        ['name', 'sequence', 'team_ids'],
        ['is_won', 'fold', 'rotting_threshold_days'],
      ],
      tabs: [{ label: 'Requirements', fields: ['requirements'] }],
    },
  },

  'crm.lost.reason': {
    label: 'Lost Reasons',
    fields: {
      name: { type: 'char', label: 'Reason', required: true },
      active: { type: 'boolean', label: 'Active' },
    },
    defaults: () => ({ active: true }),
    list: ['name', 'active'],
    form: {
      title: 'name',
      groups: [['name', 'active']],
    },
  },

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
      bank_ids: {
        type: 'one2many',
        relation: 'res.partner.bank',
        label: 'Bank Accounts',
        compute: (r, db) => (db?.records?.['res.partner.bank'] ?? []).filter((b) => b.partner_id === r?.id && b.active !== false).map((b) => read(db, 'res.partner.bank', b.id)),
        fields: {
          account_number: { type: 'char', label: 'Account Number', required: true },
          bank_name: { type: 'char', label: 'Bank Name' },
          bank_bic: { type: 'char', label: 'Bank Identifier Code' },
          holder_name: { type: 'char', label: 'Account Holder' },
          allow_out_payment: { type: 'boolean', label: 'Send Money' },
        },
        newLine: () => ({ account_number: '', bank_name: '', bank_bic: '', allow_out_payment: true }),
      },
    },
    defaults: () => ({ tag_ids: [] }),
    guard: (db, before, after) => validatePartnerBankLines(db, after?.id, after?.bank_ids),
    afterCreate: (db, rec, vals) => syncPartnerBankAccounts(db, rec.id, vals?.bank_ids),
    afterWrite: (db, before, after, vals) => syncPartnerBankAccounts(db, after.id, vals?.bank_ids),
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
      tabs: [{ label: 'Bank Accounts', fields: ['bank_ids'] }],
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
      automated_probability: { type: 'float', label: 'Automated Probability (%)', readonly: true },
      team_id: { type: 'many2one', relation: 'crm.team', label: 'Sales Team' },
      assign_date: { type: 'date', label: 'Assigned on', readonly: true },
      stage_id: {
        type: 'many2one',
        relation: 'crm.stage',
        label: 'Stage',
        tracking: true,
      },
      lost_reason_id: {
        type: 'many2one',
        relation: 'crm.lost.reason',
        label: 'Lost Reason',
      },
      lost_feedback: {
        type: 'text',
        label: 'Closing Note',
      },
      date_last_stage_update: {
        type: 'date',
        label: 'Last Stage Update',
        readonly: true,
      },
      is_rotting: {
        type: 'boolean',
        label: 'Rotting',
        compute: (r, db) => isRotting(db, 'crm.lead', r),
      },
      user: { type: 'char', label: 'Salesperson' },
      date_deadline: { type: 'date', label: 'Expected Closing' },
      create_date: { type: 'date', label: 'Created on', readonly: true },
      priority: { type: 'priority', label: 'Priority' },
      tag_ids: { type: 'tags', label: 'Tags' },
      description: { type: 'text', label: 'Notes' },
      type: { type: 'selection', label: 'Type', options: [['lead', 'Lead'], ['opportunity', 'Opportunity']] },
      lost_reason: { type: 'char', label: 'Lost Reason (Legacy)', hidden: true },
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
      if (key === 'stage_id') {
        const stage = typeof r.stage_id === 'number'
          ? (db.records['crm.stage'] ?? []).find((s) => s.id === r.stage_id)
          : (db.records['crm.stage'] ?? []).find((s) => s.name?.toLowerCase() === String(r.stage_id).toLowerCase());
        const won = stage?.is_won || r.stage_id === 'won' || r.stage_id === 4;
        const legacyProbs = { new: 10, qualified: 30, proposition: 60, won: 100, 1: 10, 2: 30, 3: 60, 4: 100 };
        return {
          date_last_stage_update: today(),
          probability: won ? 100 : (legacyProbs[r.stage_id] ?? r.probability),
        };
      }
      if (key !== 'partner_id' || !r.partner_id) return {};
      const p = (db.records['res.partner'] ?? []).find((x) => x.id === r.partner_id);
      return p ? { email: r.email || p.email || '', phone: r.phone || p.phone || '' } : {};
    },
    defaults: () => ({ type: 'opportunity', stage_id: 1, probability: 10, user: 'Admin', priority: 0, tag_ids: [], create_date: today(), date_last_stage_update: today() }),
    filters: [
      [{ id: 'mine', label: 'My Pipeline', fn: (r) => r.user === 'Admin' }, { id: 'unassigned', label: 'Unassigned', fn: (r) => !r.user }],
      [
        { id: 'won', label: 'Won', fn: (r) => r.stage_id === 'won' || r.stage_id === 4 || r.probability === 100 },
        { id: 'ongoing', label: 'Ongoing', fn: (r) => r.active !== false && r.stage_id !== 'won' && r.stage_id !== 4 && r.probability !== 100 },
        { id: 'overdue', label: 'Overdue', fn: (r) => r.active !== false && r.date_deadline && r.date_deadline < today() },
        { id: 'rotting', label: 'Rotting', fn: (r) => !!r.is_rotting },
      ],
      [
        { id: 'lost', label: 'Lost', fn: (r) => r.active === false && !!r.lost_reason_id },
      ],
    ],
    groupBys: ['stage_id', 'user', 'partner_id', 'lost_reason_id', 'medium', 'date_deadline', 'create_date'],
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
        {
          label: 'Won',
          primary: true,
          when: (r, db) => r.type !== 'lead' && !isWonLead(db, r) && r.active !== false,
          run: (db, r) => {
            const stages = db.records['crm.stage'] ?? [];
            const wonStage = stages.find((s) => s.is_won && (!s.team_ids?.length || (r.team_id && s.team_ids.includes(r.team_id))))
              ?? stages.find((s) => s.is_won)
              ?? { id: 4 };
            return { db: write(db, 'crm.lead', r.id, { stage_id: wonStage.id, probability: 100, date_last_stage_update: today() }) };
          },
        },
        {
          label: 'Lost',
          when: (r) => r.active !== false,
          wizard: () => ({
            title: 'Lost Reason',
            fields: [
              { name: 'lost_reason_id', type: 'many2one', relation: 'crm.lost.reason', label: 'Lost Reason', required: true, domain: (x) => x.active !== false },
              { name: 'lost_feedback', type: 'text', label: 'Closing Note' },
            ],
          }),
          run: (db, r, v = {}) => {
            const reasonId = Number(v.lost_reason_id);
            if (!reasonId) throw new Error('Choose a lost reason');
            return {
              db: write(db, 'crm.lead', r.id, {
                active: false,
                probability: 0,
                lost_reason_id: reasonId,
                lost_feedback: v.lost_feedback ?? '',
              }),
            };
          },
        },
        { label: 'Restore', vals: { active: true, lost_reason_id: null, lost_feedback: '' }, when: (r) => r.active === false },
      ],
      ribbon: (r, db) => (r.active === false ? 'Lost' : isWonLead(db, r) ? 'Won' : null),
      smart: [{ label: 'Quotations', model: 'sale.order', field: 'opportunity_id', target: 'sales/quotations', sum: 'amount_total' }],
      title: 'name',
      groups: [
        ['expected_revenue', 'probability', 'automated_probability', 'partner_id', 'email', 'phone'],
        ['team_id', 'user', 'date_deadline', 'priority', 'tag_ids'],
      ],
      tabs: [
        { label: 'Notes', fields: ['description'] },
        { label: 'Extra Info', fields: ['partner_name', 'contact_name', 'website', 'street', 'city', 'country', 'campaign_id', 'medium', 'source', 'lost_reason_id', 'lost_feedback', 'date_last_stage_update'] },
      ],
      chatter: true,
    },
  },
};
