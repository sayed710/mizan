import fs from 'node:fs';
const dir = process.argv[2];
const apps = JSON.parse(fs.readFileSync(dir + '/apps.json')); const t = JSON.parse(fs.readFileSync(dir + '/tests.json'));
const res = [];
for (const a of apps) {
  const set = new Set(a.models.filter((m) => !['res.partner', 'product'].includes(m) || a.models.length <= 2));
  const bl = t.allBlocks.filter((b) => b.models.some((m) => set.has(m)));
  const files = {}; for (const b of bl) files[b.file] = (files[b.file] ?? 0) + 1;
  const top = Object.entries(files).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([f, n]) => f.replace(/^src\//, '') + '(' + n + ')').join(' ');
  res.push({ id: a.id, tests: bl.length, neg: bl.filter((b) => b.neg).length, server: bl.filter((b) => b.server).length, files: Object.keys(files).length, top });
}
fs.writeFileSync(dir + '/apptests.json', JSON.stringify(res, null, 1));
for (const r of res) console.log(r.id, r.tests, r.neg, r.server, r.files, r.top);
