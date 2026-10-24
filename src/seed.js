import { create, emptyDb, postNote, read, search, write } from './orm.js';
import { addDays, today } from './models/common.js';
import { moveStock } from './models/sales.js';
import { CHART, JOURNALS, accountId, postEntry } from './models/ledger.js';
import { payMove, postMove } from './models/accounting.js';

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
  db = postEntry(db, {
    journal: 'MISC', date: today().slice(0, 4) + '-01-01', ref: 'Opening balance',
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
  products.forEach((p) => add('product', p));

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
  db = moveStock(db, po1rec.order_line, 1);
  set('purchase.order', po1, { state: 'purchase', receipt_done: true });
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
  [['Rania Saleh', 'rania@mail.example'], ['Karim Adel', 'karim.a@mail.example'], ['Salma Nabil', 'salma@mail.example', true]]
    .forEach(([name, email, opt_out]) => add('mailing.contact', { name, email, list_id: list, opt_out: !!opt_out }));
  add('mailing.mailing', { subject: 'Autumn collection is here', list_id: list, body: 'Discover our new ergonomic chairs and desks.', state: 'sent', sent_date: addDays(today(), -6), sent: 2, delivered: 2, opened: 2, clicked: 1, replied: 0 });
  add('mailing.mailing', { subject: 'Invitation: Office Design Expo', list_id: list, body: 'Join us at the expo next month.', state: 'draft' });

  add('sign.request', { name: 'Distributor Agreement — Gulf Interiors', partner_id: 4, state: 'sent', body: 'The parties agree on exclusive distribution in the UAE for 12 months.' });
  add('sign.request', { name: 'NDA — Atlas Workspace', partner_id: 6, state: 'signed', signature: 'Atlas Workspace', sign_date: addDays(today(), -3) });

  [['Q3 VAT return.pdf', 'finance', ['Tax']], ['Employee handbook.pdf', 'hr', ['Policy']], ['Brand guidelines.pdf', 'marketing', []], ['Lease contract.pdf', 'legal', ['Contract']]]
    .forEach(([name, folder, tag_ids]) => add('documents.document', { name, folder, tag_ids }));

  [[2, 'sales', 0, 8], [3, 'sales', 1, 8], [5, 'support', 0, 6], [6, 'support', 2, 8], [null, 'install', 3, 4]]
    .forEach(([employee_id, role, d, allocated_hours]) => add('planning.slot', { name: role === 'install' ? 'Install at Atlas' : 'Shift', employee_id, role, start: addDays(today(), d), end: addDays(today(), d + (role === 'install' ? 2 : 4)), allocated_hours, state: employee_id ? 'published' : 'draft' }));

  add('sale.rental', { partner_id: 6, product_id: 3, qty: 1, price_per_day: 60, state: 'picked', pickup_date: addDays(today(), -5), return_date: addDays(today(), -1) });
  add('sale.rental', { partner_id: 1, product_id: 2, qty: 4, price_per_day: 15, state: 'reserved', pickup_date: today(), return_date: addDays(today(), 7) });
  add('sale.rental', { partner_id: 5, product_id: 1, qty: 10, price_per_day: 5, state: 'quotation', pickup_date: addDays(today(), 3), return_date: addDays(today(), 10) });

  const demo = add('appointment.type', { name: 'Showroom Visit', duration: 1, location: 'Mizan Showroom, Cairo', user_id: 2, description: 'Book a guided tour of our showroom.' });
  add('appointment.type', { name: 'Online Consultation', duration: 0.5, location: 'Video call', user_id: 4 });
  add('appointment.booking', { name: 'Hany Samir', type_id: demo, date: addDays(today(), 2), time: '11:00' });
  add('appointment.booking', { name: 'Mai Ezzat', type_id: demo, date: addDays(today(), 4), time: '15:30' });

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

  add('livechat.session', { name: 'Visitor #1042', operator_id: 5, country: 'Egypt', stage_id: 'closed', rating: 3, transcript: 'Asked about delivery times to Giza.' });
  add('livechat.session', { name: 'Visitor #1043', operator_id: 6, country: 'UAE', stage_id: 'open' });
  add('sms.campaign', { name: 'Weekend promo', list_id: 1, body: 'Mizan: 15% off ergonomic chairs this weekend only!' });
  add('social.post', { name: 'Expo announcement', message: 'Meet us at the Office Design Expo!', stage_id: 'scheduled', accounts: ['LinkedIn'] });
  add('social.post', { name: 'New desk launch', message: 'Our new standing desk is here.', stage_id: 'posted', likes: 128, shares: 14, scheduled_date: addDays(today(), -4) });
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

  const seeded = { ...db, messages: [] };
  return postNote(seeded, 'discuss.channel', general, 'Welcome to Mizan! Use this channel for team-wide news.');
}
