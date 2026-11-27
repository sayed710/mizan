const W = process.argv[2]; const N = Number(process.argv[3] ?? 50000);
const { seed } = await import(W + '/src/seed.js');
const { search, matches, read } = await import(W + '/src/orm.js');
const { models } = await import(W + '/src/models/index.js');
const db0 = seed();
const inv = db0.records['account.move'].find((m) => m.name === 'INV/2026/00002');
const partner = db0.records['res.partner'][0];
const moves = [...db0.records['account.move']], partners = [...db0.records['res.partner']];
let mid = db0.seq['account.move'], pid = db0.seq['res.partner'];
for (let i = 0; i < N; i++) { if (i % 10 < 6) moves.push({ ...inv, id: ++mid, name: `INV/2025/${mid}`, partner_id: partners[(i * 7) % partners.length].id }); else if (i % 10 === 9) partners.push({ ...partner, id: ++pid, name: `Partner ${pid}` }); }
const db = { ...db0, records: { ...db0.records, 'account.move': moves, 'res.partner': partners } };
const m2o = Object.entries(models['account.move'].fields).filter(([, f]) => f.type === 'many2one').map(([k]) => k);
let a = performance.now();
const rows = search(db, 'account.move');
const hits = rows.filter((r) => matches(db, 'account.move', r, ['partner 4']));
console.log(`${rows.length} invoices, ${partners.length} partners, ${m2o.length} many2one fields on account.move: search-bar text filter took ${(performance.now() - a).toFixed(0)} ms (${hits.length} hits)`);
a = performance.now();
const byId = new Map(partners.map((p) => [p.id, p])); let x = 0; for (const r of rows) x += byId.get(r.partner_id) ? 1 : 0;
console.log(`same partner lookups through a Map: ${(performance.now() - a).toFixed(1)} ms`);
