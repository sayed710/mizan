const W = process.argv[2];
const { models, viewsOf, apps, leavesOf } = await import(`${W}/src/models/index.js`);
const bad = Object.keys(models).filter((m) => viewsOf(m).includes('kanban') && !models[m].kanban);
console.log('models whose views include kanban but define no kanban spec:', bad.length, bad.join(', '));
const reach = [];
for (const a of apps) for (const l of leavesOf(a)) if (l.model && bad.includes(l.model)) {
  const v = viewsOf(l.model); const def = v.includes(l.view) ? l.view : v[0];
  reach.push(`#/${a.id}/${l.key} default=${def}`);
}
console.log('menu routes:', reach.join(' | '));
