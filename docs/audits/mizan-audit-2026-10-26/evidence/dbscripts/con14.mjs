import { DatabaseSync } from 'node:sqlite';
const W = process.argv[2];
const { seed } = await import(W + '/src/seed.js');
const { openStorage } = await import(W + '/server/storage.js');
const { migrateAppointments } = await import(W + '/src/models/appointments.js');
const { write } = await import(W + '/src/orm.js');
const sql = new DatabaseSync(':memory:');
const st = openStorage(sql);
const s = seed();
const legacy = { ...s, records: { ...s.records, 'appointment.type': [{ id: 1, name: 'Legacy consult', duration: 1.5, user_id: 2 }] } };
st.save(null, legacy);
const db = migrateAppointments(st.load());                 // index.js:71
console.log('in memory after migrate:', JSON.stringify(db.records['appointment.type'][0]));
st.save(db, write(db, 'crm.lead', 1, { priority: 2 }));   // an unrelated commit (index.js:73)
console.log('row in SQLite after a commit:', sql.prepare("SELECT data FROM records WHERE model = 'appointment.type'").get().data);
