import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';

const button = (model, label) => models[model].form.buttons.find((b) => b.label === label);

test('quotation buttons ask through a wizard and run with the entered values, never prompt()', () => {
  const saved = globalThis.prompt;
  globalThis.prompt = () => { throw new Error('prompt() must not be used'); };
  try {
    const made = create(seed(), 'sale.order.template', { name: 'Standard', number_of_days: 30, lines: [] });
    const db0 = made.db;
    const template = read(db0, 'sale.order.template', made.id);
    const { db, id } = create(db0, 'sale.order', { partner_id: 3, order_line: [] });
    const apply = button('sale.order', 'Apply Template');
    const spec = apply.wizard(db, read(db, 'sale.order', id));
    assert.deepEqual(spec.fields.map((f) => [f.name, f.type, f.required]), [['template_id', 'many2one', true]]);
    assert.throws(() => apply.run(db, read(db, 'sale.order', id), {}), /Choose a quotation template/);
    const applied = apply.run(db, read(db, 'sale.order', id), { template_id: template.id }).db;
    assert.equal(read(applied, 'sale.order', id).sale_order_template_id, template.id);
    // With a template already set, no question is asked.
    assert.equal(apply.wizard(applied, read(applied, 'sale.order', id)), null);
    const sign = button('sale.order', 'Sign');
    assert.deepEqual(sign.wizard(applied, read(applied, 'sale.order', id)).fields.map((f) => f.name), ['name', 'signature']);
    assert.throws(() => sign.run(applied, read(applied, 'sale.order', id), { name: '', signature: 'x' }), /signer name/);
    const signed = sign.run(applied, read(applied, 'sale.order', id), { name: 'Omar', signature: 'Omar K.' }).db;
    assert.equal(read(signed, 'sale.order', id).signed_by, 'Omar');
  } finally {
    if (saved === undefined) delete globalThis.prompt;
    else globalThis.prompt = saved;
  }
});

test('helpdesk merge offers open tickets to pick and rating is a 1-5 choice', () => {
  const base = seed();
  const target = search(base, 'helpdesk.ticket').find((x) => !['solved', 'cancelled'].includes(x.stage_id));
  const copy = create(base, 'helpdesk.ticket', { name: 'Same issue again', partner_id: target.partner_id, team_id: target.team_id, stage_id: target.stage_id });
  const db = copy.db;
  const other = read(db, 'helpdesk.ticket', copy.id);
  const merge = button('helpdesk.ticket', 'Merge Tickets');
  const field = merge.wizard(db, target).fields[0];
  assert.equal(field.type, 'many2many');
  assert.equal(field.domain(target), false);
  assert.equal(field.domain(other), true);
  assert.equal(field.domain({ ...other, partner_id: -1 }), false);
  assert.throws(() => merge.run(db, target, { ticket_ids: [] }), /Choose the tickets/);
  const merged = merge.run(db, target, { ticket_ids: [other.id] }).db;
  assert.equal(read(merged, 'helpdesk.ticket', other.id).stage_id, 'cancelled');
  const rate = button('helpdesk.ticket', 'Record Rating');
  assert.deepEqual(rate.wizard().fields.map((f) => f.name), ['rating', 'comment']);
  const solved = write(db, 'helpdesk.ticket', target.id, { stage_id: 'solved' });
  assert.throws(() => rate.run(solved, read(solved, 'helpdesk.ticket', target.id), { rating: '9' }), /1 to 5/);
});
