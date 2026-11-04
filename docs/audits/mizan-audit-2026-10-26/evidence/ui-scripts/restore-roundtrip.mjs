const W = process.argv[2];
const { seed } = await import(`${W}/src/seed.js`);
const { applyDiff, diffDb } = await import(`${W}/src/sync.js`);
const { search } = await import(`${W}/src/orm.js`);
const server = seed();
console.log('seed documents.document tag_ids sample:', JSON.stringify(search(server, 'documents.document').slice(0, 2).map((d) => d.tag_ids)));
const file = JSON.parse(JSON.stringify(server)); // Download backup -> Restore backup of the SAME data
const d = diffDb(server, file);
console.log('upserted records in the diff:', Object.values(d.upserts).reduce((s, r) => s + r.length, 0), 'diff JSON bytes:', JSON.stringify(d).length);
try { applyDiff(server, d, { author: 'admin', isAdmin: true }); console.log('restore accepted'); } catch (e) { console.log('restore of an unmodified backup REJECTED:', e.message); }
