import test from 'node:test';
import assert from 'node:assert/strict';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { create, read, search, write } from './orm.js';
import { accountId } from './models/ledger.js';

const press = (db, model, id, label) => models[model].form.buttons.find((button) => button.label === label).run(db, read(db, model, id)).db;

for (const [type, code, sign] of [['out_invoice', '410000', 1], ['in_invoice', '600000', -1]]) {
  test(`deferred ${type} analytics follow recognition and reverse on reset`, () => {
    const analytic = create(seed(), 'account.analytic.account', { name: 'Deferral project' });
    let db = write(analytic.db, 'res.company', 1, { deferred_generation_method: 'manual' });
    const invoice = create(db, 'account.move', {
      move_type: type, partner_id: 1, invoice_date: '2025-01-01',
      invoice_line_ids: [{ qty: 1, price_unit: 60, tax: 0, account_id: accountId(db, code), analytic_distribution: { [analytic.id]: 100 }, deferred_start_date: '2025-01-01', deferred_end_date: '2025-02-28' }],
    });
    db = press(invoice.db, 'account.move', invoice.id, 'Confirm');
    const balance = () => Math.round(search(db, 'account.analytic.line').filter((line) => line.account_id === analytic.id).reduce((sum, line) => sum + line.amount, 0) * 100) / 100;
    const schedule = search(db, 'account.deferral').find((item) => item.source_move_id === invoice.id);
    assert.ok(schedule);
    assert.equal(balance(), 0);
    const actions = models['account.deferral'].actions;
    db = actions.postCompanyDeferrals(db, 1, '2025-01-31');
    assert.equal(balance(), sign * schedule.board[0].amount);
    const partial = db;
    db = actions.postCompanyDeferrals(db, 1, '2025-02-28');
    assert.equal(balance(), sign * 60);
    db = press(db, 'account.move', invoice.id, 'Reset to Draft');
    assert.equal(balance(), 0);
    db = press(partial, 'account.move', invoice.id, 'Reset to Draft');
    assert.equal(balance(), 0);
  });
}
