// index.js:282-284 replayed with the real ingestIot: `db` is read before `await readJson(req)`.
const W = process.argv[2];
const { seed } = await import(W + '/src/seed.js');
const { applyDiff, diffDb } = await import(W + '/src/sync.js');
const { create, read } = await import(W + '/src/orm.js');
const { ingestIot, hashToken } = await import(W + '/server/integrations.js');
let db = seed();
const dev = create(db, 'iot.device', { name: 'Scale', token_hash: hashToken('iot_aaaaaaaaaaaaaaaaaaaaaaaa') });
db = applyDiff(db, diffDb(db, dev.db));
const captured = db;                                    // ingestIot(db, token, ...) argument evaluated here
const p = create(db, 'res.partner', { name: 'Saved during the await' });
db = applyDiff(db, diffDb(db, p.db));                   // another request commits meanwhile
const next = ingestIot(captured, 'iot_aaaaaaaaaaaaaaaaaaaaaaaa', { value: 42 });  // after the body arrives
db = applyDiff(db, diffDb(db, next), { author: 'IoT', isAdmin: false });           // index.js:284
console.log('partner', p.id, 'still present after IoT ingest:', !!read(db, 'res.partner', p.id), '| device last_value', read(db, 'iot.device', dev.id).last_value);
