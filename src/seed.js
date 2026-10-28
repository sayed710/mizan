import { create, emptyDb, postNote, read, search, write } from './orm.js';
import { ensureUoms } from './models/uom.js';
import { ensureMainCompany } from './models/company.js';
import { ensureMainWarehouse } from './models/warehouse.js';
import { addDays, today } from './models/common.js';
import { generateVariants, moveStock } from './models/sales.js';
import { CHART, JOURNALS, accountId, postEntry } from './models/ledger.js';
import { payMove, postMove } from './models/accounting.js';
import { moveValued, postOpeningStock } from './models/valuation.js';

const partners = [
  { name: 'Nile Furniture Co.', is_company: true, email: 'sales@nilefurniture.example', phone: '+20 2 2345 6789', city: 'Cairo', country: 'Egypt', tag_ids: ['VIP'] },
  { name: 'Delta Office Supplies', is_company: true, email: 'info@deltaoffice.example', phone: '+20 3 456 7890', city: 'Alexandria', country: 'Egypt', tag_ids: ['Vendor'] },
  { name: 'Sara Hassan', email: 'sara.h@mail.example', phone: '+20 100 123 4567', city: 'Giza', country: 'Egypt', tag_ids: ['Retail'] },
  { name: 'Gulf Interiors', is_company: true, email: 'contact@gulfinteriors.example', phone: '+971 4 555 0101', city: 'Dubai', country: 'UAE', tag_ids: ['Wholesale'] },
  { name: 'Omar Khaled', email: 'omar.k@mail.example', phone: '+966 55 123 4567', city: 'Riyadh', country: 'Saudi Arabia', tag_ids: [] },
  { name: 'Atlas Workspace', is_company: true, email: 'hello@atlasws.example', phone: '+212 522 000 111', city: 'Casablanca', country: 'Morocco', tag_ids: ['Wholesale'] },
  { name: 'Pharos Wood Industries', is_company: true, email: 'orders@pharoswood.example', phone: '+20 2 3333 4444', city: 'Damietta', country: 'Egypt', tag_ids: ['Vendor'] },
];

const leads = [
  ['Office chairs for new HQ', 1, 42000, 'new', 1, ['Product']],
  ['Reception desk redesign', 3, 8500, 'new', 0, ['Design']],
  ['Conference room setup', 2, 15600, 'qualified', 2, ['Consulting']],
  ['200 ergonomic desks', 4, 61000, 'qualified', 1, ['Product']],
  ['Annual maintenance contract', 6, 12000, 'proposition', 2, ['Services']],
  ['Showroom lighting', 5, 4300, 'proposition', 0, ['Design']],
  ['Co-working fit-out', 6, 27500, 'proposition', 3, ['Consulting', 'Product']],
  ['Distributor agreement', 4, 19800, 'won', 2, ['Other']],
];

const products = [
  { name: 'Ergonomic Chair', default_code: 'FURN-001', categ: 'Furniture', type: 'goods', list_price: 210, cost: 120, qty_available: 85, reorder_min: 20 },
  { name: 'Standing Desk', default_code: 'FURN-002', categ: 'Furniture', type: 'goods', list_price: 540, cost: 310, qty_available: 32, reorder_min: 10 },
  { name: 'Meeting Table (8 seats)', default_code: 'FURN-003', categ: 'Furniture', type: 'goods', list_price: 1250, cost: 700, qty_available: 4, reorder_min: 5 },
  { name: 'LED Desk Lamp', default_code: 'LIGHT-001', categ: 'Lighting', type: 'goods', list_price: 35, cost: 14, qty_available: 140, reorder_min: 30 },
  { name: 'Office Design Consultation', default_code: 'SRV-001', categ: 'Services', type: 'service', list_price: 150, cost: 0, qty_available: 0, reorder_min: 0 },
  { name: 'Installation (per hour)', default_code: 'SRV-002', categ: 'Services', type: 'service', list_price: 45, cost: 20, qty_available: 0, reorder_min: 0 },
  { name: 'Oak Desk Top', default_code: 'COMP-001', categ: 'Components', type: 'goods', list_price: 0, cost: 90, qty_available: 40, reorder_min: 10 },
  { name: 'Steel Desk Frame', default_code: 'COMP-002', categ: 'Components', type: 'goods', list_price: 0, cost: 120, qty_available: 25, reorder_min: 10 },
  { name: 'Screw Kit', default_code: 'COMP-003', categ: 'Components', type: 'goods', list_price: 0, cost: 4, qty_available: 300, reorder_min: 50 },
  { name: 'Espresso', default_code: 'CAFE-001', categ: 'Cafeteria', type: 'goods', list_price: 2.5, cost: 0.6, qty_available: 500, reorder_min: 0 },
  { name: 'Croissant', default_code: 'CAFE-002', categ: 'Cafeteria', type: 'goods', list_price: 3, cost: 1, qty_available: 60, reorder_min: 20 },
  { name: 'Software Support Plan', default_code: 'SUB-001', categ: 'Services', type: 'service', list_price: 99, cost: 0, qty_available: 0, reorder_min: 0 },
  { name: 'Shipping', default_code: 'SHIP', categ: 'Services', type: 'service', list_price: 0, cost: 0, qty_available: 0, reorder_min: 0, website_published: false },
  { name: 'Smart Desk Controller', default_code: 'ELEC-001', categ: 'Electronics', type: 'goods', list_price: 89, cost: 40, qty_available: 0, reorder_min: 0, tracking: 'serial', weight: 0.4 },
];

const departments = ['Management', 'Sales', 'Operations', 'Support'];
const employees = [
  ['Admin', 'Chief Executive Officer', 1, null, 'office'],
  ['Mona Adel', 'Sales Manager', 2, 1, 'office'],
  ['Youssef Nabil', 'Account Executive', 2, 2, 'home'],
  ['Hana Mostafa', 'Operations Lead', 3, 1, 'office'],
  ['Karim Fathy', 'Support Engineer', 4, 4, 'home'],
  ['Laila Samir', 'Support Engineer', 4, 4, 'office'],
];

const tasks = [
  ['Site survey', 1, 4, 'done', -6, 4, 1],
  ['Floor plan draft', 1, 4, 'progress', 3, 8, 2],
  ['Order furniture', 1, 2, 'todo', 10, 2, 0],
  ['Kick-off meeting', 2, 1, 'done', -2, 1, 0],
  ['Lighting simulation', 2, 4, 'review', 1, 6, 3],
  ['Install workstations', 2, 5, 'todo', 14, 16, 1],
];

const tickets = [
  ['Chair armrest broken', 3, 5, 'issue', 'new', 2],
  ['Invoice copy request', 1, 6, 'request', 'progress', 0],
  ['How to adjust desk height?', 5, null, 'question', 'new', 0],
  ['Late delivery to Dubai', 4, 5, 'issue', 'hold', 3],
  ['Warranty extension', 6, 6, 'request', 'solved', 1],
];

/** Builds a fresh demo database through the ORM so seed data obeys the same rules as user data. */
export function seed() {
  let db = emptyDb();
  const add = (model, vals) => {
    const res = create(db, model, vals);
    db = res.db;
    return res.id;
  };
  const set = (model, id, vals) => { db = write(db, model, id, vals); };
  const lines = (pairs) => pairs.map(([product_id, qty]) => ({ product_id, qty, price_unit: read(db, 'product', product_id).list_price, tax: 14 }));
  const costLines = (pairs) => pairs.map(([product_id, qty]) => ({ product_id, qty, price_unit: read(db, 'product', product_id).cost, tax: 14 }));

  CHART.forEach(([code, name, account_type]) => add('account.account', { code, name, account_type, reconcile: ['asset_receivable', 'liability_payable'].includes(account_type) }));
  JOURNALS.forEach(([code, name, type, account]) => add('account.journal', { code, name, type, default_account_id: account ? accountId(db, account) : null }));
  const tax = (name, type_tax_use, amount, account, vals = {}) => add('account.tax', { name, type_tax_use, amount, amount_type: 'percent', account_id: account ? accountId(db, account) : null, tax_exigibility: 'on_invoice', price_include: false, active: true, tax_group: 'VAT', ...vals });
  const vatSale = tax('VAT 14%', 'sale', 14, '251000');
  const vatPurchase = tax('VAT 14%', 'purchase', 14, '131000');
  const zeroExport = tax('0% Exports', 'sale', 0, null);
  const zeroImport = tax('0% Imports', 'purchase', 0, null);
  tax('VAT 14% Included', 'sale', 14, '251000', { price_include: true });
  tax('VAT 14% (Cash Basis)', 'sale', 14, '251000', { tax_exigibility: 'on_payment' });
  tax('Stamp Duty', 'sale', 5, '251000', { amount_type: 'fixed', tax_group: 'Stamp' });
  add('account.fiscal.position', { name: 'Domestic', auto_apply: false, country: 'Egypt', tax_ids: [], account_ids: [] });
  add('account.fiscal.position', {
    name: 'Export', auto_apply: false, note: 'Export of goods: zero-rated VAT.',
    tax_ids: [{ tax_src_id: vatSale, tax_dest_id: zeroExport }, { tax_src_id: vatPurchase, tax_dest_id: zeroImport }], account_ids: [],
  });
  db = postEntry(db, {
    // Start of the year, but never after the seeded history (invoices go back 45 days).
    journal: 'MISC', date: [`${today().slice(0, 4)}-01-01`, addDays(today(), -60)].sort()[0], ref: 'Opening balance',
    lines: [{ account: '101401', debit: 150000 }, { account: '101501', debit: 5000 }, { account: '301000', credit: 155000 }],
  }).db;
  const wholesale = add('product.pricelist', { name: 'Wholesale', items: [{ product_id: null, min_qty: 10, fixed_price: 0, percent: 10 }, { product_id: 1, min_qty: 50, fixed_price: 180, percent: 0 }] });
  partners.forEach((p) => add('res.partner', { ...p, pricelist_id: (p.tag_ids ?? []).includes('Wholesale') ? wholesale : null }));
  leads.forEach(([name, partner_id, expected_revenue, stage_id, priority, tag_ids], i) => {
    const partner = partners[partner_id - 1];
    add('crm.lead', {
      name, partner_id, expected_revenue, stage_id, priority, tag_ids,
      email: partner.email, phone: partner.phone,
      probability: { new: 10, qualified: 30, proposition: 60, won: 100 }[stage_id],
      date_deadline: addDays(today(), i * 4 - 6),
      create_date: addDays(today(), -40 + i * 5),
    });
  });
  const weights = { 'FURN-001': 14, 'FURN-002': 32, 'FURN-003': 60, 'LIGHT-001': 1.2, 'COMP-001': 12, 'COMP-002': 18, 'COMP-003': 0.3 };
  products.forEach((p) => add('product', { weight: weights[p.default_code] ?? 0, tracking: 'none', ...p }));
  add('delivery.carrier', { name: 'Standard Delivery', delivery_type: 'fixed', fixed_price: 25, free_over: 2000 });
  add('delivery.carrier', { name: 'Freight by weight', delivery_type: 'rules', rules: [{ max_weight: 50, price: 40 }, { max_weight: 300, price: 120 }, { max_weight: 2000, price: 450 }] });
  add('delivery.carrier', { name: 'Aramex Express', delivery_type: 'api', api_url: '', tracking_url: 'https://www.aramex.com/track/results?ShipmentNumber={ref}' });

  departments.forEach((name) => add('hr.department', { name }));
  employees.forEach(([name, job_title, department_id, parent_id, work_location], i) =>
    add('hr.employee', {
      name, job_title, department_id, parent_id, work_location, wage: [9000, 6000, 4200, 5500, 3800, 3600][i],
      work_email: `${name.split(' ')[0].toLowerCase()}@mycompany.example`,
      join_date: addDays(today(), -900 + i * 120),
    }));
  [[1, 1], [2, 2], [3, 4], [4, 5]].forEach(([dep, mgr]) => set('hr.department', dep, { manager_id: mgr }));
  const egypt = add('hr.payroll.structure', { name: 'Egypt — Employees' });
  add('hr.payroll.structure', { name: 'Interns', rules: [
    { sequence: 1, code: 'BASIC', name: 'Stipend', category: 'basic', amount_type: 'wage', base: '', value: 0, account: '' },
    { sequence: 2, code: 'TRANS', name: 'Transport', category: 'allowance', amount_type: 'fixed', base: '', value: 300, account: '' },
    { sequence: 3, code: 'GROSS', name: 'Gross', category: 'gross', amount_type: 'wage', base: '', value: 0, account: '' },
    { sequence: 4, code: 'NET', name: 'Net', category: 'net', amount_type: 'wage', base: '', value: 0, account: '' },
  ] });
  [[2, 6000], [3, 4500]].forEach(([employee_id, wage]) => add('hr.contract', { name: 'Contract ' + employee_id, employee_id, structure_id: egypt, wage, state: 'running', date_start: addDays(today(), -365) }));

  // Sales: one quotation, one confirmed + invoiced + paid, one confirmed not invoiced.
  add('sale.order', { partner_id: 1, order_line: lines([[1, 40], [6, 8]]) });
  const so2 = add('sale.order', { partner_id: 4, date_order: addDays(today(), -20), order_line: lines([[2, 12], [4, 12]]) });
  const so3 = add('sale.order', { partner_id: 6, date_order: addDays(today(), -8), order_line: lines([[3, 2], [5, 6]]) });
  for (const id of [so2, so3]) {
    const so = read(db, 'sale.order', id);
    db = moveStock(db, so.order_line, -1);
    set('sale.order', id, { state: 'sale' });
  }

  // Invoices: posted+paid from so2, posted overdue, draft.
  const so2rec = read(db, 'sale.order', so2);
  const inv1 = add('account.move', {
    move_type: 'out_invoice', partner_id: 4, sale_id: so2, invoice_origin: so2rec.name,
    invoice_date: addDays(today(), -18), invoice_date_due: addDays(today(), 12), invoice_line_ids: so2rec.order_line,
  });
  db = postMove(db, inv1);
  db = payMove(db, inv1, read(db, 'account.move', inv1).amount_total, addDays(today(), -5));
  const inv2 = add('account.move', {
    move_type: 'out_invoice', partner_id: 3, invoice_date: addDays(today(), -45), invoice_date_due: addDays(today(), -15),
    invoice_line_ids: lines([[5, 10]]),
  });
  db = postMove(db, inv2);
  db = payMove(db, inv2, 500, addDays(today(), -10));
  add('account.move', { move_type: 'out_invoice', partner_id: 5, invoice_date: today(), invoice_date_due: addDays(today(), 30), invoice_line_ids: lines([[1, 4]]) });

  // Purchases: received PO + its posted bill, open RFQ.
  const po1 = add('purchase.order', { partner_id: 7, date_order: addDays(today(), -12), order_line: costLines([[1, 50], [3, 3]]) });
  const po1rec = read(db, 'purchase.order', po1);
  // Received through stock valuation at the PO price, so the bill clears the interim account.
  db = moveValued(db, po1rec.order_line.map((l) => ({ ...l, unit_cost: l.price_unit })), 1, { reference: po1rec.name, date: addDays(today(), -11) });
  set('purchase.order', po1, { state: 'purchase', receipt_done: true, order_line: po1rec.order_line.map((l) => ({ ...l, qty_delivered: l.qty })) });
  const bill = add('account.move', {
    move_type: 'in_invoice', partner_id: 7, purchase_id: po1, invoice_origin: po1rec.name,
    invoice_date: addDays(today(), -10), invoice_date_due: addDays(today(), 20), invoice_line_ids: po1rec.order_line,
  });
  db = postMove(db, bill);
  add('purchase.order', { partner_id: 2, order_line: costLines([[4, 100]]) });
  const sara = search(db, 'account.move').find((m) => m.move_type === 'out_invoice' && m.partner_id === 3);
  add('account.bank.statement.line', { date: today(), payment_ref: 'TRF SARA HASSAN INV', partner_id: 3, amount: sara.amount_residual });
  add('account.bank.statement.line', { date: today(), payment_ref: 'Office rent October', amount: -1800, counterpart: '630000' });
  add('account.bank.statement.line', { date: addDays(today(), -1), payment_ref: 'Bank charges', amount: -12.5, counterpart: '690000' });
  add('stock.picking', { picking_type: 'outgoing', partner_id: 6, origin: read(db, 'sale.order', so3).name, sale_id: so3, state: 'ready', move_ids: [{ product_id: 3, qty: 2 }] });

  add('project.project', { name: 'HQ Office Fit-out', partner_id: 1, user_id: 4, tag_ids: ['Interior'], date: addDays(today(), 45) });
  add('project.project', { name: 'Co-working Space Atlas', partner_id: 6, user_id: 4, tag_ids: ['Consulting'], date: addDays(today(), 60) });
  tasks.forEach(([name, project_id, user_id, stage_id, d, planned_hours, priority]) =>
    add('project.task', { name, project_id, user_id, stage_id, planned_hours, priority, date_start: addDays(today(), d - Math.ceil(planned_hours / 4)), date_deadline: addDays(today(), d) }));

  tickets.forEach(([name, partner_id, user_id, ticket_type, stage_id, priority], i) =>
    add('helpdesk.ticket', { name, partner_id, user_id, ticket_type, stage_id, priority, create_date: addDays(today(), -i * 3) }));

  add('calendar.event', { name: 'Demo with Nile Furniture', start: addDays(today(), 1), start_time: '11:00', duration: 1, partner_id: 1, location: 'Cairo office' });
  add('calendar.event', { name: 'Weekly sales review', start: addDays(today(), 3), start_time: '09:30', duration: 0.5, location: 'Meeting room' });
  add('calendar.event', { name: 'Supplier visit — Pharos Wood', start: addDays(today(), -2), start_time: '14:00', duration: 2, partner_id: 7, location: 'Damietta' });

  // Manufacturing: standing desk BoM + one confirmed and one done order.
  const bom = add('mrp.bom', { name: 'Standing Desk BoM', product_id: 2, product_qty: 1, components: [{ product_id: 7, qty: 1 }, { product_id: 8, qty: 1 }, { product_id: 9, qty: 1 }] });
  add('mrp.production', { product_id: 2, bom_id: bom, product_qty: 5, state: 'confirmed', user_id: 4 });
  add('mrp.production', { product_id: 2, bom_id: bom, product_qty: 3, state: 'done', user_id: 4, date_deadline: addDays(today(), -3), date_finished: addDays(today(), -3) });

  [['Taxi to client site', 3, 'travel', 18, 'submitted', -2], ['Team lunch', 2, 'meals', 64, 'approved', -6], ['Printer paper', 4, 'office', 22, 'draft', 0], ['Flight to Dubai', 2, 'travel', 420, 'paid', -20]]
    .forEach(([name, employee_id, category, total_amount, state, d]) => add('hr.expense', { name, employee_id, category, total_amount, state, date: addDays(today(), d) }));

  (db.records['hr.employee'] ?? []).forEach((e) => add('hr.leave.allocation', { name: `Annual leave ${today().slice(0, 4)}`, employee_id: e.id, leave_type: 'paid', number_of_days: 21, state: 'validate' }));
  [['Family visit', 3, 'paid', 5, 8, 'confirm'], ['Flu', 5, 'sick', -4, -3, 'validate'], ['Summer holiday', 2, 'paid', 20, 29, 'validate']]
    .forEach(([name, employee_id, leave_type, a, b, state]) => add('hr.leave', { name, employee_id, leave_type, date_from: addDays(today(), a), date_to: addDays(today(), b), state }));

  const job1 = add('hr.job', { name: 'Sales Representative', department_id: 2, no_of_recruitment: 2 });
  const job2 = add('hr.job', { name: 'Support Engineer', department_id: 4, no_of_recruitment: 1 });
  [['Ahmed Tarek', job1, 'interview', 2], ['Nour Ali', job1, 'new', 1], ['Mariam Fouad', job2, 'contract', 3], ['Hassan Reda', job2, 'screening', 0]]
    .forEach(([name, job_id, stage_id, priority]) => add('hr.applicant', { name, job_id, stage_id, priority, email: `${name.split(' ')[0].toLowerCase()}@mail.example`, expected_salary: 1500 + priority * 300 }));

  [[0, 4, 1, 1, 'Survey report', 3], [-1, 4, 1, 2, 'Draft floor plan', 5], [-2, 4, 2, 5, 'Lighting model', 4], [0, 5, 2, 6, 'Workstation prep', 2]]
    .forEach(([d, employee_id, project_id, task_id, name, unit_amount]) => add('account.analytic.line', { date: addDays(today(), d), employee_id, project_id, task_id, name, unit_amount }));

  const ev = add('event.event', { name: 'Office Design Expo', date_begin: addDays(today(), 12), date_end: addDays(today(), 13), location: 'Cairo International Convention Center', seats_max: 200, stage_id: 'announced', user_id: 2, tag_ids: ['Expo'] });
  add('event.event', { name: 'Ergonomics Workshop', date_begin: addDays(today(), 30), location: 'Mizan HQ', seats_max: 25, stage_id: 'new', user_id: 3, tag_ids: ['Workshop'] });
  [['Rania Saleh', 'open'], ['Tamer Hosny', 'open'], ['Dina Magdy', 'cancel']]
    .forEach(([name, st]) => add('event.registration', { name, event_id: ev, state: st, email: `${name.split(' ')[0].toLowerCase()}@mail.example` }));

  add('sale.subscription', { partner_id: 1, product_id: 12, plan: 'monthly', recurring_amount: 99, stage: 'progress', start_date: addDays(today(), -60), next_invoice_date: addDays(today(), -1) });
  add('sale.subscription', { partner_id: 4, product_id: 12, plan: 'yearly', recurring_amount: 990, stage: 'progress', start_date: addDays(today(), -100), next_invoice_date: addDays(today(), 265) });
  add('sale.subscription', { partner_id: 6, product_id: 12, plan: 'monthly', recurring_amount: 99, stage: 'draft' });

  [['Call Gulf Interiors about delivery', 'today', 2], ['Prepare Q4 sales review', 'week', 1], ['Renew office insurance', 'later', 0], ['Send expo invitations', 'inbox', 0]]
    .forEach(([name, stage, priority]) => add('todo.task', { name, stage, priority }));

  const kb = add('knowledge.article', { name: 'Company Handbook', category: 'workspace', is_favorite: true, body: 'Welcome to the team! This handbook covers our values, working hours and tools.' });
  add('knowledge.article', { name: 'Sales Playbook', parent_id: kb, category: 'workspace', body: 'Qualify leads within 48 hours. Send quotations from the Sales app.' });
  add('knowledge.article', { name: 'Support Escalation Process', parent_id: kb, category: 'shared', body: 'Urgent tickets (3 stars) go to the on-call engineer.' });

  add('pos.order', { partner_id: 3, payment_method: 'card', lines: [{ product_id: 10, qty: 2, price_unit: 2.5, tax: 14 }, { product_id: 11, qty: 2, price_unit: 3, tax: 14 }] });

  const general = add('discuss.channel', { name: 'general', description: 'Company-wide announcements' });
  add('discuss.channel', { name: 'sales', description: 'Deals and quotations' });
  [['crm.lead', 1, 'call', 'Discuss chair models', 0], ['crm.lead', 3, 'email', 'Send room layout', -2], ['sale.order', 1, 'todo', 'Follow up on quotation', 3], ['helpdesk.ticket', 1, 'call', 'Confirm replacement part', 1]]
    .forEach(([res_model, res_id, activity_type, summary, d]) =>
      add('mail.activity', { res_model, res_id, res_name: read(db, res_model, res_id).name, activity_type, summary, date_deadline: addDays(today(), d), user_id: 2 }));

  // Email marketing
  const list = add('mailing.list', { name: 'Newsletter' });
  [['Rania Saleh', 'rania@mail.example', '+20 100 200 3001'], ['Karim Adel', 'karim.a@mail.example', '+20 100 200 3002'], ['Salma Nabil', 'salma@mail.example', '+20 100 200 3003', true]]
    .forEach(([name, email, phone, opt_out]) => add('mailing.contact', { name, email, phone, list_id: list, opt_out: !!opt_out }));
  add('mailing.mailing', { subject: 'Autumn collection is here', list_id: list, body: 'Discover our new ergonomic chairs and desks.', state: 'sent', sent_date: addDays(today(), -6), sent: 2, delivered: 2, opened: 2, clicked: 1, replied: 0 });
  add('mailing.mailing', { subject: 'Invitation: Office Design Expo', list_id: list, body: 'Join us at the expo next month.', state: 'draft' });

  add('sign.request', { name: 'Distributor Agreement — Gulf Interiors', partner_id: 4, state: 'sent', body: 'The parties agree on exclusive distribution in the UAE for 12 months.' });
  add('sign.request', { name: 'NDA — Atlas Workspace', partner_id: 6, state: 'signed', signature: 'Atlas Workspace', sign_date: addDays(today(), -3) });

  const docTag = Object.fromEntries(['Tax', 'Policy', 'Contract'].map((name) => [name, add('documents.tag', { name, facet: '' })]));
  [['Q3 VAT return.pdf', 'finance', ['Tax']], ['Employee handbook.pdf', 'hr', ['Policy']], ['Brand guidelines.pdf', 'marketing', []], ['Lease contract.pdf', 'legal', ['Contract']]]
    .forEach(([name, folder, tags]) => add('documents.document', { name, folder, tag_ids: tags.map((tag) => ({ tag_id: docTag[tag], name: tag })) }));

  [[2, 'sales', 0, 8], [3, 'sales', 1, 8], [5, 'support', 0, 6], [6, 'support', 2, 8], [null, 'install', 3, 4]]
    .forEach(([employee_id, role, d, allocated_hours]) => add('planning.slot', { name: role === 'install' ? 'Install at Atlas' : 'Shift', employee_id, role, start: addDays(today(), d), end: addDays(today(), d + (role === 'install' ? 2 : 4)), allocated_hours, state: employee_id ? 'published' : 'draft' }));

  add('sale.rental', { partner_id: 6, product_id: 3, qty: 1, price_per_day: 60, state: 'picked', pickup_date: addDays(today(), -5), return_date: addDays(today(), -1) });
  add('sale.rental', { partner_id: 1, product_id: 2, qty: 4, price_per_day: 15, state: 'reserved', pickup_date: today(), return_date: addDays(today(), 7) });
  add('sale.rental', { partner_id: 5, product_id: 1, qty: 10, price_per_day: 5, state: 'quotation', pickup_date: addDays(today(), 3), return_date: addDays(today(), 10) });

  const weekdays = (start, end) => ['0', '1', '2', '3', '4'].map((weekday) => ({ weekday, start, end }));
  const demo = add('appointment.type', {
    name: 'Showroom Visit', duration: 60, slot_interval: 30, location: 'Mizan Showroom, Cairo', description: 'Book a guided tour of our showroom.',
    staff_ids: [{ employee_id: 2 }, { employee_id: 3 }], slot_ids: weekdays('09:00', '17:00'), capacity: 1,
  });
  add('appointment.type', {
    name: 'Online Consultation', duration: 30, location: 'Online', is_online: true, price: 150, assign_method: 'chosen',
    description: 'A video call with an office design consultant.', staff_ids: [{ employee_id: 4 }, { employee_id: 3 }], slot_ids: weekdays('10:00', '15:00'),
    questions: [{ label: 'What would you like to discuss?', required: true }],
  });
  const at = (days, time) => `${addDays(today(), days)}T${time}`;
  add('appointment.booking', { name: 'Hany Samir', type_id: demo, staff_id: 2, start: at(2, '11:00'), end: at(2, '12:00') });
  add('appointment.booking', { name: 'Mai Ezzat', type_id: demo, staff_id: 3, start: at(4, '15:30'), end: at(4, '16:30') });

  add('website.page', { name: 'Home', slug: 'home', sequence: 1, is_published: true, content: '# Workspaces people love\n\nWe design and furnish modern offices across the region.\n\n## Why us\n\nErgonomic products, fast installation and local support.' });
  add('website.page', { name: 'About Us', slug: 'about', sequence: 2, is_published: true, content: '# Our story\n\nFounded in Cairo, we have equipped more than 200 offices.' });
  add('website.page', { name: 'Contact', slug: 'contact', sequence: 3, is_published: true, content: '# Contact us\n\nsales@mycompany.example · +20 2 1234 5678' });

  const press = add('maintenance.equipment', { name: 'CNC Router', category: 'machine', serial_no: 'CNC-2291', technician_id: 4, location: 'Workshop', next_maintenance: addDays(today(), 20) });
  add('maintenance.equipment', { name: 'Delivery laptop', category: 'computer', serial_no: 'LT-7781', technician_id: 5 });
  add('maintenance.request', { name: 'Spindle vibration', equipment_id: press, technician_id: 4, priority: 2, stage_id: 'progress' });
  add('maintenance.request', { name: 'Quarterly lubrication', equipment_id: press, maintenance_type: 'preventive', schedule_date: addDays(today(), 20) });
  add('quality.check', { product_id: 2, test_type: 'measure', measure: 75, norm_min: 72, norm_max: 76, user_id: 4 });
  add('quality.check', { product_id: 1, test_type: 'pass_fail', result: 'pass', user_id: 4 });
  add('quality.alert', { name: 'Scratched desk tops from supplier', product_id: 7, user_id: 4, priority: 2 });
  const van = add('fleet.vehicle', { name: 'Toyota Hiace', license_plate: 'ق ط ر 1234', driver_id: 4, fuel_type: 'diesel', odometer: 48200, stage_id: 'registered' });
  add('fleet.vehicle', { name: 'Hyundai Elantra', license_plate: 'س ص ع 5678', driver_id: 2, fuel_type: 'gasoline', odometer: 21000, stage_id: 'registered' });
  add('fleet.service', { name: 'Oil change', vehicle_id: van, service_type: 'maintenance', amount: 85, date: addDays(today(), -15), vendor_id: 2, stage_id: 'done' });
  add('fleet.service', { name: 'Fuel', vehicle_id: van, service_type: 'fuel', amount: 60, date: addDays(today(), -2), stage_id: 'done' });
  [[2, -1, '08:55', '17:05'], [3, -1, '09:10', '16:40'], [4, 0, '08:30', null]]
    .forEach(([employee_id, d, check_in, check_out]) => add('hr.attendance', { employee_id, date: addDays(today(), d), check_in, check_out }));
  add('hr.appraisal', { employee_id: 3, manager_id: 2, stage_id: 'pending' });
  add('hr.appraisal', { employee_id: 5, manager_id: 4 });
  add('survey.survey', { name: 'Customer Satisfaction', user_id: 2, stage_id: 'open', questions: [
    { question: 'How satisfied are you with our products?', kind: 'rating', choices: '' },
    { question: 'Which product did you buy?', kind: 'choice', choices: 'Chair, Desk, Table, Other' },
    { question: 'Any suggestions?', kind: 'text', choices: '' },
  ] });
  ['Chicken Shawarma', 'Margherita Pizza', 'Greek Salad', 'Fresh Lemon Mint'].forEach((name, i) =>
    add('lunch.product', { name, vendor: i === 1 ? 'Pizza Corner' : 'Cairo Kitchen', price: [6, 9, 5, 2][i], category: ['sandwich', 'pizza', 'salad', 'drink'][i] }));
  add('lunch.order', { product_id: 1, employee_id: 2, stage_id: 'ordered' });
  add('lunch.order', { product_id: 3, employee_id: 4 });
  add('approval.request', { name: 'New laptop for support', category: 'purchase', request_owner_id: 5, approver_id: 4, amount: 1200, request_status: 'pending' });
  add('approval.request', { name: 'Trip to Dubai expo', category: 'travel', request_owner_id: 2, approver_id: 1, amount: 900, request_status: 'approved' });
  add('repair.order', { product_id: 1, partner_id: 3, user_id: 5, state: 'confirmed', parts: [{ product_id: 9, qty: 1, price_unit: 10, tax: 14 }] });
  add('fsm.task', { name: 'Install 12 workstations', partner_id: 6, address: 'Atlas Workspace, Casablanca', technician_id: 4, date: addDays(today(), 2), stage_id: 'planned' });
  add('fsm.task', { name: 'Fix desk motor', partner_id: 3, address: 'Giza', technician_id: 5, date: today(), stage_id: 'progress', hours: 1.5 });
  add('frontdesk.visitor', { name: 'Ali Mansour', company: 'Delta Office Supplies', host_id: 2, stage_id: 'planned' });
  add('slide.channel', { name: 'Ergonomics 101', user_id: 3, members: 14, stage_id: 'published', tag_ids: ['Health'], lessons: [
    { title: 'Why posture matters', kind: 'video', duration: 8 }, { title: 'Setting up your desk', kind: 'doc', duration: 12 }, { title: 'Check your knowledge', kind: 'quiz', duration: 5 },
  ] });

  add('livechat.channel', { name: 'Website Support', operator_ids: [{ operator_id: 5 }, { operator_id: 6 }], session_count: 2, rating_avg: 3 });
  add('livechat.canned', { shortcut: 'hello', substitution: 'Hello! Thank you for contacting us. How can I help you today?' });
  add('livechat.session', { name: 'Visitor #1042', channel_id: 1, operator_id: 5, country: 'Egypt', stage_id: 'closed', rating: 3, transcript: 'Asked about delivery times to Giza.' });
  add('livechat.session', { name: 'Visitor #1043', channel_id: 1, operator_id: 6, country: 'UAE', stage_id: 'open' });
  add('sms.campaign', { name: 'Weekend promo', list_id: 1, body: 'Mizan: 15% off ergonomic chairs this weekend only!' });
  const [fbPage] = [['Mizan Furniture', 'facebook', '@mizanfurniture', 4200], ['Mizan', 'linkedin', 'mizan-co', 1800], ['Mizan', 'x', '@mizan', 950]]
    .map(([name, media, handle, followers]) => add('social.account', { name, media, handle, followers, active: true }));
  add('spreadsheet.document', {
    name: 'Sales Overview', folder: 'Finance', rows: 20, cols: 6,
    cells: JSON.stringify({
      A1: 'Metric', B1: 'Value', A2: 'Customers', B2: '=MIZAN.COUNT("res.partner")', A3: 'Posted invoices', B3: '=MIZAN.COUNT("account.move","","move_type=out_invoice")',
      A4: 'Invoiced total', B4: '=MIZAN.SUM("account.move","amount_total","move_type=out_invoice")', A5: 'Average invoice', B5: '=IF(B3>0,ROUND(B4/B3,2),0)',
    }),
  });
  add('crm.team', { name: 'Egypt Sales', leader: 'Mona Adel', auto_assign: true, country: 'Egypt', member_ids: [{ name: 'Mona Adel', capacity: 20 }, { name: 'Omar Fathy', capacity: 20 }] });
  add('crm.team', { name: 'Gulf Sales', leader: 'Laila Samir', auto_assign: true, country: 'UAE', member_ids: [{ name: 'Laila Samir', capacity: 15 }] });
  add('social.post', { name: 'Expo announcement', message: 'Meet us at the Office Design Expo!', stage_id: 'scheduled', accounts: ['LinkedIn'] });
  add('social.post', {
    name: 'New desk launch', message: 'Our new standing desk is here.', stage_id: 'posted', scheduled_date: addDays(today(), -4), published_date: addDays(today(), -4),
    account_ids: [{ account_id: fbPage }], live_post_ids: [{ account_id: fbPage, media: 'facebook', state: 'posted', published_date: addDays(today(), -4), likes: 128, comments: 9, shares: 14, clicks: 41 }],
  });
  add('marketing.campaign', { name: 'Welcome series', list_id: 1, steps: [{ action: 'email', detail: 'Welcome email', delay_days: 0 }, { action: 'wait', detail: '', delay_days: 3 }, { action: 'email', detail: 'Product tips', delay_days: 0 }] });
  add('mrp.eco', { name: 'Thicker oak top for standing desk', bom_id: 1, user_id: 4, stage_id: 'progress', priority: 1 });
  const room = add('room.room', { name: 'Nile Room', capacity: 8, location: '1st floor', equipment: ['Screen', 'Whiteboard'] });
  add('room.room', { name: 'Focus Booth', capacity: 2, location: '2nd floor', equipment: [] });
  add('room.booking', { name: 'Sales weekly', room_id: room, organizer_id: 2, date: addDays(today(), 1), start: '09:30', end: '10:30' });
  add('hr.referral', { name: 'Omar Sherif', job_id: 1, referrer_id: 3, stage_id: 'interview', email: 'omar.s@mail.example' });
  [[3, 'English', 'language', 'advanced'], [3, 'Negotiation', 'soft', 'intermediate'], [5, 'Electronics', 'tech', 'expert']]
    .forEach(([employee_id, name, skill_type, level]) => add('hr.skill', { employee_id, name, skill_type, level }));
  add('esg.emission', { name: 'Office electricity', scope: '2', source: 'electricity', quantity: 5200, factor: 0.45, date: addDays(today(), -10) });
  add('esg.emission', { name: 'Delivery van diesel', scope: '1', source: 'diesel', quantity: 380, factor: 2.68, date: addDays(today(), -8) });
  add('esg.emission', { name: 'Business flights', scope: '3', source: 'flight', quantity: 4200, factor: 0.15, date: addDays(today(), -20) });

  [['Founders shares', 'issuance', null, 1, 60000], ['Seed round', 'issuance', null, 4, 25000], ['Employee pool', 'issuance', null, 6, 15000], ['Secondary sale', 'transfer', 4, 6, 5000]]
    .forEach(([name, kind, from_id, to_id, shares], i) => add('equity.transaction', { name, kind, from_id, to_id, shares, price_per_share: [0.01, 2, 0.01, 2.5][i], state: 'posted', date: addDays(today(), -400 + i * 90) }));
  add('data.recycle', { name: 'Archive solved tickets older than a year', res_model: 'helpdesk.ticket', date_field: 'create_date', days: 365 });
  set('hr.job', 1, { is_published: true, description: 'Grow our B2B furniture sales across Egypt and the Gulf.' });

  add('stock.lot', { name: 'SDC-0001', product_id: read(db, 'product', 14) ? 14 : null, qty: 1 });
  add('phone.call', { name: 'Follow-up on HQ chairs', partner_id: 1, phone: '+20 2 2345 6789', direction: 'out', duration: 6 });
  const wh = add('stock.location', { name: 'WH', usage: 'view' });
  ['WH/Stock', 'WH/Stock/Shelf A', 'WH/Stock/Shelf B'].forEach((name) => add('stock.location', { name, parent_id: wh, usage: 'internal' }));
  set('product', 4, { route: 'mto_buy', vendor_id: 2 });
  set('product', 2, { route: 'mto_make' });
  add('iot.device', { name: 'Warehouse scale', device_type: 'scale', location: 'Warehouse A', unit: 'kg' });
  add('marketplace.connector', { name: 'Amazon.eg store', platform: 'amazon' });
  const office = add('account.analytic.account', { name: 'Office Projects', code: 'PRJ-OFF', plan: 'project' });
  add('account.analytic.account', { name: 'Cairo Branch', code: 'REG-CAI', plan: 'region' });
  add('account.budget', { name: `Budget ${today().slice(0, 4)}`, state: 'confirmed', lines: [{ analytic_account_id: office, planned: 50000 }] });
  set('res.partner', 1, { credit_limit: 100000 });
  const assembly = add('mrp.workcenter', { name: 'Assembly Line', code: 'ASM', capacity: 2, costs_hour: 25 });
  (db.records['mrp.bom'] ?? []).forEach((b) => set('mrp.bom', b.id, { operations: [{ name: 'Cut and assemble', workcenter_id: assembly, duration: 45 }, { name: 'Quality check', workcenter_id: assembly, duration: 10 }] }));
  add('account.followup.level', { name: 'First reminder', delay: 15, message: 'Friendly reminder: please settle the amount below.' });
  add('account.followup.level', { name: 'Second reminder', delay: 30, message: 'Your account is overdue; please pay within 7 days.' });
  const support = add('helpdesk.team', { name: 'Customer Care', email: 'support@mizan.example', assignment: 'balanced', use_sla: true, use_fsm: true });
  (db.records['appointment.type'] ?? []).forEach((a) => set('appointment.type', a.id, { is_published: true }));
  add('helpdesk.sla', { name: 'Standard: 3 days', team_id: support, priority: '0', days: 3 });
  add('helpdesk.sla', { name: 'Urgent: same day', team_id: support, priority: '3', days: 0 });
  (db.records['helpdesk.ticket'] ?? []).forEach((t) => set('helpdesk.ticket', t.id, { team_id: support }));
  const line = (value, nb_days, value_type = 'percent') => ({ value, value_type, nb_days, delay_type: 'days_after' });
  add('account.payment.term', { name: 'Immediate Payment', line_ids: [line(100, 0)] });
  const t30 = add('account.payment.term', { name: '30 Days', line_ids: [line(100, 30)] });
  add('account.payment.term', { name: '30% Now, Balance 60 Days', line_ids: [line(30, 0), line(70, 60)] });
  add('account.payment.term', { name: '2/7 Net 30', early_discount: true, discount_percent: 2, discount_days: 7, line_ids: [line(100, 30)] });
  set('res.partner', 3, { property_payment_term_id: t30 });
  add('res.currency', { name: 'EUR', symbol: '€', rate_ids: [{ date: addDays(today(), -60), rate: 0.92 }, { date: addDays(today(), -1), rate: 0.9 }] });
  add('res.currency', { name: 'SAR', symbol: '﷼', rate_ids: [{ date: addDays(today(), -60), rate: 3.75 }] });

  // eCommerce: payment providers, website categories, published carriers, a selectable pricelist and desk variants.
  add('payment.provider', { name: 'Wire Transfer', code: 'wire', state: 'enabled', pending_msg: 'Please transfer the amount to IBAN EG00 0000 0000 0000 0000 0000 0000, using your order number as the reference.', done_msg: 'Your order will ship once we receive the transfer.' });
  add('payment.provider', { name: 'Cash on Delivery', code: 'cod', state: 'enabled', pending_msg: 'Pay the courier in cash when your order arrives.', done_msg: '' });
  add('payment.provider', { name: 'Demo', code: 'demo', state: 'disabled', pending_msg: 'Test payment: the order is confirmed and marked as paid.', done_msg: 'Your payment has been received.' });
  const desks = add('product.public.category', { name: 'Desks', sequence: 1 });
  const chairs = add('product.public.category', { name: 'Chairs', sequence: 2 });
  [[1, chairs], [2, desks], [3, desks]].forEach(([id, category_id]) => set('product', id, { public_categ_ids: [{ category_id }] }));
  set('product', 1, { ribbon: 'sale', website_description: 'Breathable mesh back, adjustable lumbar support and 4D armrests.' });
  set('product', 2, { ribbon: 'new', attributes: 'Color: White, Black; Legs: Steel, Aluminium', website_description: 'Electric height adjustment from 65 to 130 cm with two memory presets.' });
  db = generateVariants(db, read(db, 'product', 2));
  search(db, 'product').filter((p) => p.variant_of === 2 && p.variant_values.includes('Aluminium')).forEach((p) => set('product', p.id, { list_price: 590 }));
  set('product', 13, { is_published: false });
  (db.records['delivery.carrier'] ?? []).filter((c) => c.delivery_type !== 'api').forEach((c) => set('delivery.carrier', c.id, { is_published: true }));
  add('product.pricelist', { name: 'Online Promotion', selectable: true, items: [{ product_id: null, min_qty: 1, fixed_price: 0, percent: 5 }] });

  // Blog and Forum: one blog with two published posts, one forum with a validated question and its accepted answer.
  const news = add('blog.blog', { name: 'Mizan News', subtitle: 'Tips and stories from our team' });
  add('blog.post', { blog_id: news, name: 'Setting up an ergonomic office', subtitle: 'Five quick wins', author_id: 1, tag_ids: ['Ergonomics', 'Office'], is_published: true, published_date: addDays(today(), -12),
    website_meta_description: 'Five quick wins for a healthier office.',
    content: '# Small changes, big comfort\n\nA good chair and desk height make **all** the difference:\n\n- Keep the screen at eye level\n- Feet flat on the floor\n- Take a short break every hour\n\nRead the [occupational health guide](https://www.who.int/health-topics/occupational-health) for *more* advice.' });
  add('blog.post', { blog_id: news, name: 'Standing desks: our new collection', author_id: 1, tag_ids: ['Products'], is_published: true, published_date: addDays(today(), -3),
    content: 'Our electric standing desks now come in **white** and **black**, with steel or aluminium legs.\n\nVisit the shop to configure yours.' });
  const help = add('forum.forum', { name: 'Help', description: 'Questions and answers about our products.', mode: 'questions' });
  const question = add('forum.post', { forum_id: help, name: 'How do I adjust the lumbar support?', content: 'My new ergonomic chair has a knob behind the back rest. What does it do?', author_name: 'Hala Adel', author_email: 'hala@example.com', tag_ids: ['Chairs'], state: 'active', votes: 2 });
  const answer = add('forum.post', { forum_id: help, parent_id: question, name: 'Re: How do I adjust the lumbar support?', content: 'Turn the knob clockwise to push the support forward, and counter-clockwise to release it.', author_name: 'Mizan Support', state: 'active', votes: 1 });
  set('forum.post', answer, { accepted: true });

  // WhatsApp: an approved order confirmation template and a short conversation with Nile Furniture.
  add('whatsapp.template', {
    name: 'order_confirmation', language: 'en', category: 'utility', model: 'sale.order', status: 'approved',
    body: 'Hello {{1}}, your order {{2}} of {{3}} is confirmed.', footer: 'Reply to this message for any question.',
    variables: [{ index: 1, field: 'partner_id.name' }, { index: 2, field: 'name' }, { index: 3, field: 'amount_total' }],
  });
  const waPhone = '20223456789';
  const hourAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  add('whatsapp.message', { partner_id: 1, phone: waPhone, body: 'Hi, can you confirm the delivery date of our chairs?', direction: 'incoming', state: 'received', wa_message_id: 'seed-in-1', res_model: 'res.partner', res_id: 1, date: hourAgo(2) });
  add('whatsapp.message', { partner_id: 1, phone: waPhone, body: 'Hello! Your chairs ship on Thursday.', direction: 'outgoing', state: 'read', wa_message_id: 'seed-out-1', res_model: 'res.partner', res_id: 1, date: hourAgo(1) });

  const seeded = { ...db, messages: [] };
  // Seeded quantities are opening stock: value them and post them against equity so stock reports match the ledger.
  const opened = postOpeningStock(seeded, today().slice(0, 4) + '-01-01');
  return postNote(ensureMainWarehouse(ensureMainCompany(ensureUoms(opened))), 'discuss.channel', general, 'Welcome to Mizan! Use this channel for team-wide news.');
}
