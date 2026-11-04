// For every model whose Kanban can be grouped by state: take each seed record and try "dropping" it into every other
// state column (the exact write Kanban.jsx:101 makes), then submit it through the server's applyDiff as a non-admin.
const W = process.argv[2];
const { seed } = await import(`${W}/src/seed.js`);
const { applyDiff, diffDb } = await import(`${W}/src/sync.js`);
const { write, search } = await import(`${W}/src/orm.js`);
const { models, viewsOf } = await import(`${W}/src/models/index.js`);
const db = seed();
const list = ['stock.picking','sale.order','purchase.order','account.move','mrp.production','hr.expense','hr.leave','pos.order','hr.payslip','sign.request','sale.rental','approval.request','repair.order','account.bank.statement.line','account.asset','account.payment','account.loan','stock.scrap','hr.leave.allocation','whatsapp.template'];
let tot = 0, acc = 0;
for (const m of list) {
  const key = models[m].fields.state ? 'state' : 'status';
  const opts = models[m].fields[key].options.map((o) => o[0]);
  const recs = search(db, m).slice(0, 3);
  let a = 0, n = 0; const ex = [];
  for (const r of recs) for (const to of opts) {
    if (to === r[key]) continue;
    n++;
    try { applyDiff(db, diffDb(db, write(db, m, r.id, { [key]: to })), { author: 'u', isAdmin: false }); a++; if (ex.length < 2) ex.push(`${r[key]}->${to}`); } catch (e) { /* rejected */ }
  }
  tot += n; acc += a;
  console.log(`${m.padEnd(28)} seed=${search(db, m).length} tried=${n} accepted=${a} ${ex.join(' ')}`);
}
console.log(`TOTAL drops tried=${tot} accepted by server=${acc}`);
