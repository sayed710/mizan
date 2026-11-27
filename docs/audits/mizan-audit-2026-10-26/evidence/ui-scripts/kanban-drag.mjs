// Kanban drag-and-drop writes {[groupBy]: value} directly (Kanban.jsx:101). Can that jump a document's state
// past its business action, and does the server-side applyDiff accept it?
const W = process.argv[2];
const { seed } = await import(`${W}/src/seed.js`);
const { applyDiff, diffDb } = await import(`${W}/src/sync.js`);
const { write, search, read } = await import(`${W}/src/orm.js`);
const { models, viewsOf } = await import(`${W}/src/models/index.js`);
const db = seed();
const targets = [
  ['account.move', (r) => r.state === 'draft' && r.move_type === 'out_invoice', 'posted'],
  ['sale.order', (r) => r.state === 'draft', 'sale'],
  ['purchase.order', (r) => r.state === 'draft', 'purchase'],
  ['stock.picking', (r) => r.state !== 'done' && r.state !== 'cancel', 'done'],
  ['hr.payslip', (r) => r.state === 'draft', 'done'],
  ['hr.expense.sheet', (r) => r.state === 'draft' || r.state === 'submit', 'approve'],
  ['account.payment', (r) => r.state === 'draft', 'posted'],
];
for (const [model, pick, to] of targets) {
  if (!models[model]) { console.log(model, 'missing model'); continue; }
  const st = models[model].fields.state;
  const views = viewsOf(model);
  const rec = search(db, model).find(pick);
  if (!rec) { console.log(`${model}: views=${views} no seed record matching; skipped`); continue; }
  const next = write(db, model, rec.id, { state: to });
  let verdict;
  try { applyDiff(db, diffDb(db, next), { author: 'u', isAdmin: false }); verdict = 'ACCEPTED by server applyDiff'; } catch (e) { verdict = `rejected: ${e.message}`; }
  const after = read(next, model, rec.id);
  console.log(`${model}#${rec.id} views=[${views}] state type=${st?.type} ${rec.state} -> ${to}: ${verdict}${model === 'account.move' ? ` | line_ids after drag: ${(after.line_ids ?? []).length}` : ''}`);
}
