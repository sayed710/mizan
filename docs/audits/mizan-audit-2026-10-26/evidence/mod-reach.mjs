const { models, apps, leavesOf } = await import(process.argv[2] + '/src/models/index.js');
const targets = process.argv.slice(3);
const SHARED = ['mail.activity', 'discuss.channel', 'res.partner', 'product'];
for (const a of apps) {
  const base = new Set(SHARED); for (const l of leavesOf(a)) if (l.model) base.add(l.model);
  const paths = [];
  for (const m of base) for (const [fk, f] of Object.entries(models[m].fields)) {
    if (targets.includes(f.relation)) paths.push(`${m}.${fk}->${f.relation}`);
    for (const [sk, s] of Object.entries(f.fields ?? {})) if (targets.includes(s.relation)) paths.push(`${m}.${fk}.${sk}->${s.relation}`);
  }
  if (paths.length) console.log(a.id, ':', [...new Set(paths)].join(', '));
}
