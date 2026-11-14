import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, write } from './orm.js';
import { categoryProperty } from './models/productconfig-helpers.js';
import { productConfigModels } from './models/productconfig.js';
import { postMove } from './models/accounting.js';
import { followUps, followUpLevel, runFollowUps } from './models/finance.js';

test('Finding 3: legacy category account remains effective until deliberately cleared', () => {
  let db = seed();
  const cat = create(db, 'product.category', { name: 'Conflict', property_account_income_categ_id: 1 });
  db = { ...cat.db, records: { ...cat.db.records, 'product.category': cat.db.records['product.category'].map((c) => c.id === cat.id ? { ...c, property_account_income_id: 2 } : c) } };
  assert.equal(categoryProperty(db, cat.id, 'property_account_income_id'), 2);
  assert.equal(productConfigModels['product.category'].fields.property_account_income_id.label, 'Legacy Income Account');
  db = write(db, 'product.category', cat.id, { name: 'Renamed' });
  assert.equal(read(db, 'product.category', cat.id).property_account_income_id, 2);
  assert.equal(categoryProperty(db, cat.id, 'property_account_income_id'), 2);
  const def = productConfigModels['product.category'];
  assert.equal(def.fields.property_account_income_id.readonly, true);
  assert.match(def.fields.property_account_income_id.help, /used for posting.*until cleared/);
  assert.match(def.fields.property_account_expense_id.help, /used for posting.*until cleared/);
  assert.equal(def.fields.property_account_income_id.hideWhen(read(db, 'product.category', cat.id)), false);
  const clear = def.form.buttons.find((b) => b.label === 'Clear Legacy Income Account');
  db = write(db, 'product.category', cat.id, clear.vals);
  assert.equal(read(db, 'product.category', cat.id).property_account_income_id, null);
  assert.equal(categoryProperty(db, cat.id, 'property_account_income_id'), 1);
});

test('Finding 5: excess credit carries into upcoming reminders', () => {
  for (const credit of [150, 250, 50]) {
    let db = seed();
    db = { ...db, records: { ...db.records, 'account.followup.level': [] } };
    const before = create(db, 'account.followup.level', { display_delay: 5, reminder_timing: 'before' });
    const after = create(before.db, 'account.followup.level', { display_delay: 0, reminder_timing: 'after' });
    const partner = create(after.db, 'res.partner', { name: 'Credit customer', email: 'credit@example.test' });
    db = partner.db;
    for (const [type, due, amount] of [['out_invoice', '2026-05-01', 100], ['out_invoice', '2026-05-18', 100], ['out_refund', '2026-05-15', credit]]) {
      const move = create(db, 'account.move', { move_type: type, partner_id: partner.id, invoice_date: '2026-04-01', invoice_date_due: due, invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: amount }] });
      db = postMove(move.db, move.id);
    }
    const row = followUps(db, '2026-05-15').find((f) => f.partner_id === partner.id);
    if (credit === 250) assert.equal(row, undefined);
    else {
      assert.ok(row);
      assert.equal(row.total, 50);
      assert.equal(followUpLevel(db, row, '2026-05-15')?.id, credit === 150 ? before.id : after.id);
      assert.equal(!!row.upcoming, credit === 150);
      if (credit === 150) {
        const result = runFollowUps(db, '2026-05-15');
        const notes = (result.messages ?? []).filter((m) => m.model === 'res.partner' && m.res_id === partner.id).map((m) => m.body).join('\n');
        assert.doesNotMatch(notes, /overdue/i);
      }
    }
  }
});
