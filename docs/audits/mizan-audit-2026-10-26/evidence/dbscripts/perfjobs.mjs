const W = process.argv[2];
const N = Number(process.argv[3] ?? 50000);
const { seed } = await import(W + '/src/seed.js');
const mods = {
  subscriptionJobs: ['subscriptionplus.js'], schedulePreventive: ['maintplus.js'], replenish: ['routes.js'], runFollowUps: ['finance.js'], autoReconcile: ['reconcile.js'],
  processDue: ['automation.js'], publishDue: ['social.js'], assignAllTeams: ['crmteams.js'], refreshProbabilities: ['crmteams.js'], autoCloseStale: ['helpdesk.js'],
  generateRecurringTasks: ['projectplus.js'], appraisalJobs: ['appraisalplus.js'], expireQuotes: ['quoteplus.js'],
};
const db0 = seed();
const inv = db0.records['account.move'].find((m) => m.name === 'INV/2026/00002');
const lead = db0.records['crm.lead'][0];
const moves = [...db0.records['account.move']], leads = [...db0.records['crm.lead']];
let mid = db0.seq['account.move'], lid = db0.seq['crm.lead'];
for (let i = 0; i < N; i++) { if (i % 10 < 6) moves.push({ ...inv, id: ++mid, name: `INV/2025/${mid}` }); else leads.push({ ...lead, id: ++lid, name: `Lead ${lid}` }); }
const db = { ...db0, records: { ...db0.records, 'account.move': moves, 'crm.lead': leads }, seq: { ...db0.seq, 'account.move': mid, 'crm.lead': lid } };
for (const [fn, [file]] of Object.entries(mods)) {
  const m = await import(`${W}/src/models/${file}`);
  const a = performance.now();
  try { m[fn](db, '2026-10-26'); } catch (e) { console.log(fn, 'threw', e.message.slice(0, 60)); }
  console.log(fn.padEnd(24), (performance.now() - a).toFixed(0), 'ms');
}
