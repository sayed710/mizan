// Repro: Barcode page "Apply Count" (src/views/Pages.jsx:33-36) writes product.qty_available directly; compare with product "Update Quantity" (adjustQuantity).
const root = process.argv[2];
const { write, search, read } = await import(root + '/src/orm.js');
const { seed } = await import(root + '/src/seed.js');
const { valuationReport, adjustQuantity } = await import(root + '/src/models/valuation.js');
const { applyDiff, diffDb } = await import(root + '/src/sync.js');
const { modelsForApps } = await import(root + '/src/models/index.js');
let db = seed();
const p = search(db, 'product').find((x) => x.type === 'goods' && x.qty_available > 0);
// give it at least one valuation layer so valuationReport follows layers
db = adjustQuantity(db, p.id, p.qty_available + 1);
const before = valuationReport(db)[p.id];
const layersBefore = (db.records['stock.valuation.layer'] ?? []).length, movesBefore = db.records['account.move'].length;
console.log('product', p.id, p.name, 'qty_available', read(db, 'product', p.id).qty_available, 'valued qty', before.qty, 'value', before.value);
// Barcode page path
const barcode = write(db, 'product', p.id, { qty_available: 0 });
const vr = valuationReport(barcode)[p.id];
console.log('after Barcode apply: qty_available', read(barcode, 'product', p.id).qty_available, 'valued qty', vr.qty, 'value', vr.value,
  'new layers', (barcode.records['stock.valuation.layer'] ?? []).length - layersBefore, 'new moves', barcode.records['account.move'].length - movesBefore);
// Server acceptance of the same change from a Barcode-only user
const srv = applyDiff(db, diffDb(db, barcode), { author: 'barcode-user', isAdmin: false, allowed: modelsForApps(['barcode']) });
console.log('server accepted barcode-only diff:', read(srv, 'product', p.id).qty_available);
// Proper path
const proper = adjustQuantity(db, p.id, 0);
const vp = valuationReport(proper)[p.id];
console.log('after Update Quantity: qty_available', read(proper, 'product', p.id).qty_available, 'valued qty', vp.qty, 'value', vp.value, 'new moves', proper.records['account.move'].length - movesBefore);
