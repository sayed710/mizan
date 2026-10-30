// Settings > "Restore backup" does commit(data) (Settings.jsx restore), i.e. diffDb(current, file) -> /api/diff.
// What does the server keep if a non-admin, all-apps user restores a near-empty but shape-valid backup?
const W = process.argv[2];
const { seed } = await import(`${W}/src/seed.js`);
const { applyDiff, diffDb } = await import(`${W}/src/sync.js`);
const db = seed();
const count = (d) => Object.values(d.records).reduce((s, r) => s + r.length, 0);
const backup = { records: {}, seq: {}, messages: [], settings: db.settings };
const diff = diffDb(db, backup);
console.log('records before:', count(db), '| models in delete set:', Object.keys(diff.deletes).length);
try {
  const after = applyDiff(db, diff, { author: 'clerk', isAdmin: false, allowed: null });
  console.log('ACCEPTED: records after restore =', count(after), 'messages after =', after.messages.length);
} catch (e) {
  console.log('rejected whole diff:', e.message);
  // the attacker-free path: a stale backup (same db minus protected models) — try dropping only unprotected models
  const { models } = await import(`${W}/src/models/index.js`);
  const keep = Object.fromEntries(Object.entries(db.records).filter(([m]) => models[m].protectDelete));
  const after = applyDiff(db, diffDb(db, { ...backup, records: keep }), { author: 'clerk', isAdmin: false, allowed: null });
  console.log('Backup that keeps only the', Object.keys(keep).length, 'protectDelete models: ACCEPTED, records after =', count(after));
}
