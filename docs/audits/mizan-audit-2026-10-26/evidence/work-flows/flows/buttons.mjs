import { models } from '../src/models/index.js';
for (const m of ['sale.order','purchase.order','stock.picking','account.move','account.payment','mrp.production','mrp.bom','pos.order','pos.session','sale.subscription','res.company','stock.valuation.layer','mrp.workorder']) {
  const d = models[m];
  if (!d) { console.log(m, 'MISSING'); continue; }
  console.log(m, '| guard:', !!d.guard, '| protectDelete:', !!d.protectDelete, '| buttons:', (d.form?.buttons??[]).map(b=>b.label).join(', '));
}
console.log('models with guard', Object.values(models).filter(m=>m.guard).length, 'of', Object.keys(models).length);
