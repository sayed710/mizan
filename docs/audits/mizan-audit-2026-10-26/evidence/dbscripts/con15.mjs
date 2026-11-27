import { DatabaseSync } from 'node:sqlite';
const W = process.argv[2];
const { seed } = await import(W + '/src/seed.js');
const { openStorage } = await import(W + '/server/storage.js');
const { applyDiff, diffDb } = await import(W + '/src/sync.js');
const { create } = await import(W + '/src/orm.js');
const sql = new DatabaseSync(':memory:'); const st = openStorage(sql);
let db = seed(); st.save(null, db);
let next = applyDiff(db, { upserts: {}, deletes: {}, messages: [], removedMessages: [], seq: { 'account.move': 1e300 } }, { isAdmin: false });
st.save(db, next); db = next;
for (const ref of ['first', 'second']) { const c = create(db, 'account.move', { move_type: 'entry', ref, line_ids: [] }); next = applyDiff(db, diffDb(db, c.db)); st.save(db, next); db = next; }
console.log('SQLite rows with the poisoned id:', sql.prepare("SELECT id, typeof(id) t, json_extract(data,'$.ref') ref FROM records WHERE model='account.move' AND id > 1e9").all());
console.log('seq after reload:', st.load().seq['account.move']);
