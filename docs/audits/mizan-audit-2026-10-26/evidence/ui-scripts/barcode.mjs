// Barcode "Apply Count" (Pages.jsx:35 write qty_available) vs product "Update Quantity" (adjustQuantity): what is booked?
const W = process.argv[2];
const { seed } = await import(`${W}/src/seed.js`);
const { write, search, read } = await import(`${W}/src/orm.js`);
const mod = await import(`${W}/src/models/index.js`);
const { models } = mod;
const files = ['valuation.js', 'inventory.js', 'stock.js', 'sales.js'];
let adjustQuantity;
for (const f of files) { try { const m = await import(`${W}/src/models/${f}`); if (m.adjustQuantity) { adjustQuantity = m.adjustQuantity; break; } } catch {} }
const db = seed();
const p = search(db, 'product').find((x) => x.type === 'goods' && (x.qty_available ?? 0) > 0);
const count = (d) => ({ moves: (d.records['stock.move'] ?? []).length, layers: (d.records['stock.valuation.layer'] ?? []).length, entries: (d.records['account.move'] ?? []).length });
const target = (p.qty_available ?? 0) + 10;
const viaBarcode = write(db, 'product', p.id, { qty_available: target });
console.log(`product ${p.name}: qty ${p.qty_available} -> ${target}`);
console.log('before          ', JSON.stringify(count(db)));
console.log('Barcode app     ', JSON.stringify(count(viaBarcode)), 'qty', read(viaBarcode, 'product', p.id).qty_available);
if (adjustQuantity) { const viaForm = adjustQuantity(db, p.id, target, { reference: 'x' }); console.log('Update Quantity ', JSON.stringify(count(viaForm)), 'qty', read(viaForm, 'product', p.id).qty_available); }
