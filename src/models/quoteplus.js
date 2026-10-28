// Quotation templates, optional products, validity, online signature and prepayment.
import { create, postNote, read, search, write } from '../orm.js';
import { addDays, amounts, nextName, productLines, today } from './common.js';
import { interCompanyRules } from './company.js';
import { ecommerceModels } from './ecommerce.js';
import { paymentJournal, postEntry } from './ledger.js';
import { round } from '../money.js';

const order = ecommerceModels['sale.order'];
const editable = (r) => ['draft', 'sent'].includes(r.state);
const expired = (r, date) => editable(r) && !!r.validity_date && r.validity_date < date;
const present = (line, r) => (r.order_line ?? []).some((l) => l.product_id === line.product_id);
const optionsFor = (r) => (r.option_ids ?? []).map((l) => ({ ...l, is_present: present(l, r) }));
const percent = (r) => {
  const value = Number(r.prepayment_percent ?? 0);
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('Prepayment percentage must be between 0 and 100');
  return value;
};

function quotation(db, id) {
  const r = read(db, 'sale.order', id);
  if (!r) throw new Error('Quotation not found');
  if (!editable(r)) throw new Error('Only draft or sent quotations can be accepted or changed');
  if (expired(r, today()) || expired(r, r.expiry_checked_date)) throw new Error('This quotation has expired');
  return r;
}

// Confirm also drafts the inter-company purchase; a misconfigured rule must not block the sale itself.
const orderButtons = order.form.buttons.map((b) => b.label === 'Confirm' ? { ...b, run: (db, r) => {
  const res = b.run(db, r);
  try { return { ...res, db: interCompanyRules(res.db, r.id) }; } catch { return res; }
} } : b);
const confirm = (db, id) => orderButtons.find((b) => b.label === 'Confirm').run(db, read(db, 'sale.order', id)).db;
const lineFields = {
  product_id: { type: 'many2one', relation: 'product', label: 'Product', required: true },
  name: { type: 'char', label: 'Description' },
  qty: { type: 'float', label: 'Quantity' },
  discount: { type: 'float', label: 'Disc.%' },
};
const templateLines = (label) => ({ type: 'one2many', label, fields: lineFields, newLine: () => ({ product_id: null, name: '', qty: 1, discount: 0 }) });
const acceptanceFields = {
  require_signature: { type: 'boolean', label: 'Online Signature' },
  require_payment: { type: 'boolean', label: 'Online Payment' },
  prepayment_percent: { type: 'float', label: 'Prepayment %' },
};

/** Replace quotation lines and options with a template priced for the customer. */
export function applyTemplate(db, orderId, templateId) {
  const r = quotation(db, orderId);
  const t = read(db, 'sale.order.template', templateId);
  if (!t || t.active === false) throw new Error('Select an active quotation template');
  const days = Number(t.number_of_days ?? 30);
  if (!Number.isInteger(days) || days < 0) throw new Error('Validity must be a non-negative number of days');
  percent(t);
  const partner = read(db, 'res.partner', r.partner_id);
  const pricedOrder = { ...r, pricelist_id: partner?.pricelist_id ?? r.pricelist_id };
  const price = (l) => {
    const p = read(db, 'product', l.product_id);
    if (!p) throw new Error('Select an existing product on every template line');
    return productLines('Lines', 'list_price').onchange({ ...l, name: l.name || p.name, qty: l.qty ?? 1, discount: l.discount ?? 0 }, 'product_id', db, pricedOrder);
  };
  const order_line = (t.line_ids ?? []).map(price);
  return write(db, 'sale.order', orderId, {
    sale_order_template_id: templateId, pricelist_id: pricedOrder.pricelist_id ?? null,
    order_line, option_ids: optionsFor({ order_line, option_ids: (t.option_ids ?? []).map(price) }),
    note: t.note ?? '', require_signature: !!t.require_signature, require_payment: !!t.require_payment,
    prepayment_percent: percent(t), validity_date: addDays(today(), days),
    signed_by: '', signed_on: null, signature: '', expiry_checked_date: null, expiry_notified_for: null,
  });
}

/** Add an optional product once, preserving its quoted price and discount. */
export function addOption(db, orderId, optionIndex) {
  const r = quotation(db, orderId);
  if (!Number.isInteger(optionIndex) || !r.option_ids?.[optionIndex]) throw new Error('Select a valid optional product index (starting at 0)');
  const option = r.option_ids[optionIndex];
  if (present(option, r)) return db;
  if (!read(db, 'product', option.product_id)) throw new Error('Select an existing optional product');
  const { is_present, ...line } = option;
  const next = { ...r, order_line: [...(r.order_line ?? []), line] };
  return write(db, 'sale.order', orderId, { order_line: next.order_line, option_ids: optionsFor(next) });
}

/** Record acceptance and use the existing confirmation workflow when no payment is required. */
export function signQuote(db, orderId, { name, signature, date = today() } = {}) {
  const r = quotation(db, orderId);
  if (typeof name !== 'string' || !name.trim()) throw new Error('Enter the signer name');
  if (typeof signature !== 'string' || !signature.trim()) throw new Error('Enter a signature');
  const next = write(db, 'sale.order', orderId, { signed_by: name.trim(), signed_on: date, signature: signature.trim() });
  return r.require_payment ? next : confirm(next, orderId);
}

/** Amount due upfront, rounded to cents; zero percent with required payment means full payment. */
export function prepaymentAmount(order) {
  const p = percent(order);
  const total = order.order_line ? amounts(order.order_line).total : Number(order.amount_total ?? 0);
  return round(total * (order.require_payment && p === 0 ? 100 : p) / 100);
}

/** Book a quotation-specific customer credit and confirm through the existing sales workflow. */
export function payQuote(db, orderId, amount, { date = today(), journal } = {}) {
  const r = quotation(db, orderId);
  const value = Number(amount);
  if (!Number.isFinite(value) || round(value) <= 0) throw new Error('The payment amount must be positive and finite');
  if (value < prepaymentAmount(r)) throw new Error(`The payment must cover the prepayment amount (${prepaymentAmount(r)})`);
  if (!read(db, 'res.partner', r.partner_id)) throw new Error('Set the customer before registering payment');
  const journalId = typeof journal === 'string' ? search(db, 'account.journal').find((j) => j.code === journal)?.id : journal;
  if (journal != null && (!journalId || !['bank', 'cash'].includes(read(db, 'account.journal', journalId)?.type))) throw new Error('Select a bank or cash journal');
  const via = paymentJournal(db, journalId);
  const name = nextName(db, 'account.payment', `P${via.code}/${date.slice(0, 4)}/`);
  const booked = postEntry(db, { journal: via.code, date, ref: `Prepayment ${r.name}`, lines: [
    { account: via.account, debit: round(value), partner_id: r.partner_id },
    { account: '121000', credit: round(value), partner_id: r.partner_id },
  ] });
  const payment = create(booked.db, 'account.payment', {
    name, state: 'posted', partner_type: 'customer', payment_type: 'inbound', partner_id: r.partner_id,
    sale_id: orderId, amount: round(value), unapplied: round(value), date, journal_id: journalId ?? null,
    memo: `Prepayment ${r.name}`, move_id: booked.id,
  });
  return confirm(postNote(payment.db, 'sale.order', orderId, `Prepayment ${name}: ${round(value)}`), orderId);
}

/** Mark expired quotations for a scheduler date and post one note per validity deadline. */
export function expireQuotes(db, date = today()) {
  return search(db, 'sale.order').filter((r) => expired(r, date)).reduce((next, r) => {
    const marked = write(next, 'sale.order', r.id, { expiry_checked_date: date });
    if (r.expiry_notified_for === r.validity_date) return marked;
    return postNote(write(marked, 'sale.order', r.id, { expiry_notified_for: r.validity_date }), 'sale.order', r.id, `Quotation expired on ${r.validity_date}`);
  }, db);
}

export const quotePlusModels = {
  'sale.order.template': {
    label: 'Quotation Templates',
    fields: {
      name: { type: 'char', label: 'Template Name', required: true },
      number_of_days: { type: 'integer', label: 'Validity (days)' },
      line_ids: templateLines('Lines'), option_ids: templateLines('Optional Products'),
      note: { type: 'text', label: 'Terms and Conditions' },
      ...acceptanceFields,
      mail_template: { type: 'text', label: 'Confirmation Email' },
      active: { type: 'boolean', label: 'Active' },
    },
    defaults: () => ({ number_of_days: 30, line_ids: [], option_ids: [], active: true, require_signature: false, require_payment: false, prepayment_percent: 0 }),
    guard: (db, before, r) => !Number.isInteger(Number(r.number_of_days)) || Number(r.number_of_days) < 0 ? 'Validity must be a non-negative number of days'
      : !Number.isFinite(Number(r.prepayment_percent)) || Number(r.prepayment_percent) < 0 || Number(r.prepayment_percent) > 100 ? 'Prepayment percentage must be between 0 and 100' : null,
    list: ['name', 'number_of_days', 'require_signature', 'require_payment', 'active'],
    kanban: { title: 'name', lines: ['number_of_days'] },
    form: {
      title: 'name', groups: [['number_of_days', 'active'], ['require_signature', 'require_payment', 'prepayment_percent']],
      tabs: [{ label: 'Lines', fields: ['line_ids'] }, { label: 'Optional Products', fields: ['option_ids'] }, { label: 'Terms', fields: ['note', 'mail_template'] }], chatter: true,
    },
  },
  'sale.order': {
    ...order,
    fields: {
      ...order.fields,
      sale_order_template_id: { type: 'many2one', relation: 'sale.order.template', label: 'Quotation Template' },
      validity_date: { ...order.fields.validity_date },
      option_ids: {
        ...productLines('Optional Products', 'list_price'),
        fields: {
          ...productLines('Optional Products', 'list_price').fields, ...lineFields,
          is_present: { type: 'boolean', label: 'Added to Order', readonly: true, compute: (l, r) => r ? present(l, r) : !!l.is_present },
        },
      },
      ...acceptanceFields,
      signed_by: { type: 'char', label: 'Signed By', readonly: true },
      signed_on: { type: 'date', label: 'Signed On', readonly: true },
      signature: { type: 'text', label: 'Signature' },
      is_expired: { type: 'boolean', label: 'Expired', compute: (r) => expired(r, r.expiry_checked_date > today() ? r.expiry_checked_date : today()) },
    },
    defaults: (id) => ({ ...order.defaults(id), option_ids: [], require_signature: false, require_payment: false, prepayment_percent: 0 }),
    guard: (db, before, r) => order.guard?.(db, before, r) ?? (!Number.isFinite(Number(r.prepayment_percent ?? 0)) || Number(r.prepayment_percent ?? 0) < 0 || Number(r.prepayment_percent ?? 0) > 100 ? 'Prepayment percentage must be between 0 and 100' : null),
    onchange: (r, key, db) => ({ ...order.onchange?.(r, key, db), ...(['order_line', 'option_ids'].includes(key) ? { option_ids: optionsFor(r) } : {}) }),
    form: {
      ...order.form,
      groups: [...order.form.groups, ['sale_order_template_id', 'is_expired', 'require_signature', 'require_payment', 'prepayment_percent']],
      tabs: [...order.form.tabs, { label: 'Optional Products', fields: ['option_ids'] }, { label: 'Signature', fields: ['signed_by', 'signed_on', 'signature'] }],
      buttons: [...orderButtons,
        { label: 'Apply Template', when: editable, run: (db, r) => {
          const id = r.sale_order_template_id ?? prompt('Quotation template id');
          return id == null || id === '' ? { db } : { db: applyTemplate(db, r.id, Number(id)) };
        } },
        { label: 'Add Option', when: editable, run: (db, r) => {
          const index = prompt('Optional product index (starting at 0)');
          return index == null || index === '' ? { db } : { db: addOption(db, r.id, Number(index)) };
        } },
        { label: 'Sign', when: editable, run: (db, r) => {
          const name = prompt('Signer name');
          if (name == null) return { db };
          const signature = r.signature || prompt('Signature');
          return signature == null ? { db } : { db: signQuote(db, r.id, { name, signature }) };
        } },
        { label: 'Register Prepayment', when: (r) => editable(r) && r.require_payment, run: (db, r) => {
          const amount = prompt('Prepayment amount', String(prepaymentAmount(r)));
          return amount == null || amount === '' ? { db } : { db: payQuote(db, r.id, Number(amount)) };
        } },
      ],
    },
  },
};
