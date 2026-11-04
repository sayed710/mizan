// Timings of the whole-db operations on the seeded db and on inflated copies.
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import os from 'node:os';
const W = process.argv[2];
const SIZES = (process.argv[3] ?? '0,50000').split(',').map(Number);
const { seed } = await import(W + '/src/seed.js');
const { applyDiff, diffDb } = await import(W + '/src/sync.js');
const { read, search, write, create } = await import(W + '/src/orm.js');
const { openStorage } = await import(W + '/server/storage.js');
const { runScheduledJobs } = await import(W + '/src/models/scheduler.js');
const { modelsForApps } = await import(W + '/src/models/index.js');
const t = (fn, n = 1) => { const a = performance.now(); let r; for (let i = 0; i < n; i++) r = fn(); return [((performance.now() - a) / n), r]; };
const ms = (x) => x.toFixed(1) + 'ms';
console.log(`machine: ${os.cpus()[0].model} x${os.cpus().length}, ${(os.totalmem()/1e9).toFixed(1)} GB RAM, node ${process.version}`);
function require_heap() { return process.memoryUsage().heapTotal / 1e6; }

function inflate(db, n) {
  if (!n) return db;
  const inv = db.records['account.move'].find((m) => m.name === 'INV/2026/00002');
  const lead = db.records['crm.lead'][0];
  const partner = db.records['res.partner'][0];
  const recs = { ...db.records };
  const moves = [...recs['account.move']], leads = [...recs['crm.lead']], partners = [...recs['res.partner']], msgs = [...db.messages];
  let mid = db.seq['account.move'], lid = db.seq['crm.lead'], pid = db.seq['res.partner'];
  for (let i = 0; i < n; i++) {
    const k = i % 10;
    if (k < 6) { mid++; moves.push({ ...inv, id: mid, name: `INV/2025/${String(mid).padStart(6, '0')}`, invoice_line_ids: inv.invoice_line_ids.map((l) => ({ ...l })), line_ids: (inv.line_ids ?? []).map((l) => ({ ...l })) }); msgs.push({ id: `m-${i}`, model: 'account.move', res_id: mid, body: 'Invoice: record created', kind: 'tracking', author: 'Admin', date: '2025-01-01T00:00:00.000Z' }); }
    else if (k < 9) { lid++; leads.push({ ...lead, id: lid, name: `Lead ${lid}` }); msgs.push({ id: `m-${i}`, model: 'crm.lead', res_id: lid, body: 'Lead: record created', kind: 'tracking', author: 'Admin', date: '2025-01-01T00:00:00.000Z' }); }
    else { pid++; partners.push({ ...partner, id: pid, name: `Partner ${pid}`, email: `p${pid}@example.test` }); }
  }
  recs['account.move'] = moves; recs['crm.lead'] = leads; recs['res.partner'] = partners;
  return { ...db, records: recs, messages: msgs, seq: { ...db.seq, 'account.move': mid, 'crm.lead': lid, 'res.partner': pid } };
}

for (const N of SIZES) {
  global.gc?.();
  const db = inflate(seed(), N);
  const total = Object.values(db.records).reduce((s, r) => s + r.length, 0);
  const [tj, json] = t(() => JSON.stringify(db), 3);
  console.log(`\n== added ${N} records: ${total} records, ${db.messages.length} messages, JSON ${(json.length / 1e6).toFixed(2)} MB (${json.length} chars), heapUsed ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB`);
  console.log(`JSON.stringify(db) (done once per applyDiff, per GET /api/db, per /api/diff response): ${ms(tj)}`);
  const [tp] = t(() => JSON.parse(json), 3);
  console.log(`JSON.parse of that payload (each client, every 15 s poll): ${ms(tp)}`);
  // one-record edit through applyDiff
  const lead = db.records['crm.lead'].at(-1);
  const d1 = diffDb(db, write(db, 'crm.lead', lead.id, { priority: 2 }));
  const [ta, next] = t(() => applyDiff(db, d1, { isAdmin: false }), 5);
  console.log(`applyDiff, 1 crm.lead edit: ${ms(ta)}`);
  const inv = db.records['account.move'].at(-1);
  const d2 = diffDb(db, write(db, 'account.move', inv.id, { narration: 'x' }));
  const [tm] = t(() => applyDiff(db, d2, { isAdmin: false }), 5);
  console.log(`applyDiff, 1 account.move edit (guard runs): ${ms(tm)}`);
  const [tdd] = t(() => diffDb(db, next), 5);
  console.log(`diffDb(prev,next) as run inside storage.save on every commit: ${ms(tdd)}`);
  // bulk diff: 1000 leads
  const bulk = { upserts: { 'crm.lead': db.records['crm.lead'].slice(-1000).map((l) => ({ ...l, priority: 3 })) }, deletes: {}, messages: [], removedMessages: [] };
  const [tb] = t(() => applyDiff(db, bulk, { isAdmin: false }));
  console.log(`applyDiff, 1000-lead bulk edit: ${ms(tb)}`);
  // visibleDb for an app-restricted user
  const allowed = modelsForApps(['crm']);
  const [tv] = t(() => JSON.stringify({ ...db, records: Object.fromEntries(Object.entries(db.records).filter(([m]) => allowed.has(m))), messages: db.messages.filter((m) => allowed.has(m.model)) }), 3);
  console.log(`visibleDb+stringify for a CRM-only user: ${ms(tv)}`);
  // ORM primitives
  const [ts, list] = t(() => search(db, 'account.move'), 5);
  console.log(`search(account.move) -> ${list.length} rows with computed fields: ${ms(ts)}`);
  const ids = db.records['account.move'].slice(-1000).map((m) => m.id);
  const [tr] = t(() => ids.forEach((id) => read(db, 'account.move', id)));
  console.log(`1000 x read(account.move, id) (linear find): ${ms(tr)}`);
  const [tc] = t(() => create(db, 'crm.lead', { name: 'x' }), 5);
  console.log(`orm.create (copies model array and messages array): ${ms(tc)}`);
  // SQLite: full write, load, incremental save
  const file = `${W}/../perf-${N}.sqlite`;
  for (const f of [file, file + '-wal', file + '-shm']) rmSync(f, { force: true });
  const sql = new DatabaseSync(file); sql.exec('PRAGMA journal_mode = WAL');
  const st = openStorage(sql);
  const [tw] = t(() => st.save(null, db));
  const [tl, loaded] = t(() => st.load());
  const [ti] = t(() => st.save(db, next));
  console.log(`SQLite: full write ${ms(tw)}, load (startup) ${ms(tl)} (${Object.values(loaded.records).reduce((s, r) => s + r.length, 0)} records), incremental save of 1 edit ${ms(ti)}; synchronous=${sql.prepare('PRAGMA synchronous').get().synchronous}`);
  sql.close(); for (const f of [file, file + '-wal', file + '-shm']) rmSync(f, { force: true });
  const [tj2] = process.env.SKIP_JOBS ? [NaN] : t(() => runScheduledJobs(db, "2026-10-26"));
  console.log(`runScheduledJobs(db) (hourly, blocks the event loop): ${ms(tj2)}`);
  console.log(`commit path estimate for 1 edit = applyDiff + diffDb in save + JSON.stringify for response: ${ms(ta + tdd + tj)}`);
}
