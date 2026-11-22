import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { diffDb, applyDiff } from './sync.js';
import { autoReconcile } from './models/reconcile.js';

const model = 'account.reconcile.model';
const line = 'account.bank.statement.line';
const rawChange = (db, id, vals) => ({ ...db, records: { ...db.records, [model]: db.records[model].map((r) => r.id === id ? { ...r, ...vals } : r) } });

test('partner mappings validate regex through plain diffs and run before matching rules', () => {
  const rule = create(seed(), model, { name: 'Mapping', trigger: 'auto_reconcile', partner_mapping_line_ids: [{ payment_ref_regex: '^ABC', narration_regex: 'invoice', partner_id: 5 }] });
  assert.throws(() => applyDiff(rule.db, diffDb(rule.db, rawChange(rule.db, rule.id, { partner_mapping_line_ids: [{ payment_ref_regex: '(', partner_id: 5 }] }))), /invalid regular expression/i);
  const journal = search(rule.db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const st = create(rule.db, line, { journal_id: journal.id, date: '2026-10-01', state: 'to_check', payment_ref: 'ABC 123', narration: 'invoice', amount: 12 });
  assert.equal(read(autoReconcile(st.db), line, st.id).partner_id, 5);
});
