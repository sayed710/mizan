// Fresh process: a stored record still carries a value for a field the schema no longer declares.
const W = process.argv[2];
const { seed } = await import(W + '/src/seed.js');
const { applyDiff, diffDb } = await import(W + '/src/sync.js');
const { read, write } = await import(W + '/src/orm.js');
let s = seed();
s = { ...s, records: { ...s.records, 'crm.lead': s.records['crm.lead'].map((l) => (l.id === 1 ? { ...l, x_region: 'north', legacy_code: 'L-1' } : l)) } };
const next = applyDiff(s, diffDb(s, write(s, 'crm.lead', 1, { priority: 3 })));
const r = read(next, 'crm.lead', 1);
console.log('before edit: x_region', read(s, 'crm.lead', 1).x_region, 'legacy_code', read(s, 'crm.lead', 1).legacy_code, '| after an unrelated edit: x_region', r.x_region, 'legacy_code', r.legacy_code, 'priority', r.priority);
