const W = process.argv[2];
const { apps, leavesOf, models, viewsOf } = await import(`${W}/src/models/index.js`);
const out = [];
for (const a of apps) for (const l of leavesOf(a)) {
  out.push({ hash: `#/${a.id}/${l.key}`, app: a.id, type: l.type ?? 'action', model: l.model ?? null, views: l.model && models[l.model] ? viewsOf(l.model) : [] });
}
console.log(JSON.stringify(out));
