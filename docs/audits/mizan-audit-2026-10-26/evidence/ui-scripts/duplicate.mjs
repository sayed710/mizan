// FormView ActionsMenu "Duplicate" (FormView.jsx:123-129) on posted/paid documents: what state does the copy have?
const W = process.argv[2];
const { seed } = await import(`${W}/src/seed.js`);
const { create, read, search, nextId } = await import(`${W}/src/orm.js`);
const { models } = await import(`${W}/src/models/index.js`);
const { applyDiff, diffDb } = await import(`${W}/src/sync.js`);
const db = seed();
const dup = (model, rec) => {
  const { id: _id, name, ...vals } = rec;
  const copy = { ...vals, ...(models[model].fields.name?.readonly ? {} : { name: `${name ?? ''} (copy)` }) };
  return create(db, model, models[model].fields.name?.readonly ? { ...copy, ...models[model].defaults?.(nextId(db, model)) } : copy);
};
for (const [model, pick] of [['account.move', (r) => r.state === 'posted' && r.move_type === 'out_invoice'], ['account.payment', (r) => r.state === 'posted'], ['sale.order', (r) => r.state === 'sale'], ['stock.picking', () => true], ['hr.expense', (r) => r.state && r.state !== 'draft']]) {
  const rec = search(db, model).find(pick);
  if (!rec) { console.log(model, 'no sample'); continue; }
  const res = dup(model, rec);
  const c = read(res.db, model, res.id);
  let server; try { applyDiff(db, diffDb(db, res.db), { author: 'u', isAdmin: false }); server = 'accepted'; } catch (e) { server = 'rejected: ' + e.message; }
  console.log(`${model}#${rec.id} (${rec.state}) -> copy#${res.id} state=${c.state} name=${c.name} lines=${(c.line_ids ?? []).length} amount_paid=${c.amount_paid ?? '-'} payment_state=${c.payment_state ?? '-'} | server ${server}`);
}
