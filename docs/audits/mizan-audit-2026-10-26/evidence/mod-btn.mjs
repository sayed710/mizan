const { models } = await import(process.argv[2] + '/src/models/index.js');
const bk = {}; const types = {};
for (const m of Object.values(models)) for (const b of m.form?.buttons ?? []) { for (const key of Object.keys(b)) bk[key] = (bk[key] ?? 0) + 1; }
console.log(JSON.stringify(bk));
for (const m of Object.values(models)) { const s=m.form?.smart; if (s) { console.log('smart sample', JSON.stringify(Object.keys(s[0]??{}))); break; } }
for (const m of Object.values(models)) { const s=m.form?.ruleButtons; if (s) { console.log('ruleButtons', typeof s); } }
const t = {}; for (const m of Object.values(models)) for (const f of Object.values(m.fields)) t[f.type]=(t[f.type]??0)+1; console.log(JSON.stringify(t));
