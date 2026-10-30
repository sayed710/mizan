// Which models expose a draggable Kanban grouped by a 'state'-like selection field (via groupBys or default kanban.groupBy or a menu groupBy)?
const W = process.argv[2];
const { models, viewsOf, apps, leavesOf } = await import(`${W}/src/models/index.js`);
const DROP = ['selection', 'many2one', 'char', 'boolean'];
const rows = [];
const menuGroup = new Map();
for (const a of apps) for (const l of leavesOf(a)) if (l.model && l.groupBy?.length) menuGroup.set(l.model, [...(menuGroup.get(l.model) ?? []), ...l.groupBy]);
for (const [name, def] of Object.entries(models)) {
  if (!viewsOf(name).includes('kanban') || !def.kanban) continue;
  const cands = new Set([...(def.groupBys ?? []), def.kanban.groupBy, ...(menuGroup.get(name) ?? [])].filter(Boolean));
  const st = [...cands].filter((g) => ['state', 'status', 'payment_state'].includes(g) && DROP.includes(def.fields[g]?.type));
  if (st.length && def.form?.buttons?.length) rows.push(`${name}: groupable by ${st.join(',')}; form has ${def.form.buttons.length} workflow buttons (${def.form.buttons.slice(0, 4).map((b) => b.label).join(' / ')})`);
}
console.log(`${rows.length} models with workflow buttons whose Kanban can be grouped by state and dragged:`);
console.log(rows.slice(0, 40).join('\n'));
