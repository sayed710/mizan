import { create, emptyDb } from './orm.js';

const partners = [
  { name: 'Nile Furniture Co.', is_company: true, email: 'sales@nilefurniture.example', phone: '+20 2 2345 6789', city: 'Cairo', country: 'Egypt', tag_ids: ['VIP'] },
  { name: 'Delta Office Supplies', is_company: true, email: 'info@deltaoffice.example', phone: '+20 3 456 7890', city: 'Alexandria', country: 'Egypt', tag_ids: [] },
  { name: 'Sara Hassan', email: 'sara.h@mail.example', phone: '+20 100 123 4567', city: 'Giza', country: 'Egypt', tag_ids: ['Retail'] },
  { name: 'Gulf Interiors', is_company: true, email: 'contact@gulfinteriors.example', phone: '+971 4 555 0101', city: 'Dubai', country: 'UAE', tag_ids: ['Wholesale'] },
  { name: 'Omar Khaled', email: 'omar.k@mail.example', phone: '+966 55 123 4567', city: 'Riyadh', country: 'Saudi Arabia', tag_ids: [] },
  { name: 'Atlas Workspace', is_company: true, email: 'hello@atlasws.example', phone: '+212 522 000 111', city: 'Casablanca', country: 'Morocco', tag_ids: ['Wholesale'] },
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
  { name: 'Ergonomic Chair', type: 'goods', list_price: 210, cost: 120, qty_available: 85 },
  { name: 'Standing Desk', type: 'goods', list_price: 540, cost: 310, qty_available: 32 },
  { name: 'Meeting Table (8 seats)', type: 'goods', list_price: 1250, cost: 700, qty_available: 6 },
  { name: 'Office Design Consultation', type: 'service', list_price: 150, cost: 0, qty_available: 0 },
  { name: 'Installation (per hour)', type: 'service', list_price: 45, cost: 20, qty_available: 0 },
];

const addDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

/** Builds a fresh demo database through the ORM so seed data obeys the same rules as user data. */
export function seed() {
  let db = emptyDb();
  const add = (model, vals) => {
    const res = create(db, model, vals);
    db = res.db;
    return res.id;
  };
  partners.forEach((p) => add('res.partner', p));
  leads.forEach(([name, partner_id, expected_revenue, stage_id, priority, tag_ids], i) => {
    const partner = partners[partner_id - 1];
    add('crm.lead', {
      name, partner_id, expected_revenue, stage_id, priority, tag_ids,
      email: partner.email, phone: partner.phone,
      probability: { new: 10, qualified: 30, proposition: 60, won: 100 }[stage_id],
      date_deadline: addDays(7 + i * 4),
    });
  });
  products.forEach((p) => add('product', p));
  add('sale.order', { partner_id: 1, order_line: [{ product_id: 1, qty: 40, price_unit: 210 }, { product_id: 5, qty: 8, price_unit: 45 }] });
  add('sale.order', { partner_id: 4, state: 'sale', order_line: [{ product_id: 2, qty: 12, price_unit: 540 }] });
  return { ...db, messages: [] };
}
