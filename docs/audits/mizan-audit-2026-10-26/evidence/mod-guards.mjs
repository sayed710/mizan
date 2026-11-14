import fs from 'node:fs';
const root = process.argv[2];
const { models } = await import(root + '/src/models/index.js');
const t = JSON.parse(fs.readFileSync(process.argv[3] + '/tests.json'));
const testSrc = Object.fromEntries(t.perFile.map((f) => [f.file, fs.readFileSync(root + '/' + f.file, 'utf8')]));
const rows = [];
for (const [k, m] of Object.entries(models)) {
  if (!m.guard && !m.protectDelete) continue;
  const gname = m.guard?.name || ''; const pname = m.protectDelete?.name || '';
  const named = (n) => n && n !== 'guard' && n !== 'protectDelete' && n.length > 3 ? Object.keys(testSrc).filter((f) => new RegExp('\\b' + n + '\\b').test(testSrc[f])) : [];
  const viaDiff = t.allBlocks.filter((b) => b.guardPath && b.models.includes(k)).map((b) => b.file);
  rows.push({ model: k, gname, pname, guardTests: [...new Set([...named(gname), ...viaDiff])], pdTests: named(pname) });
}
fs.writeFileSync(process.argv[3] + '/guards.json', JSON.stringify(rows, null, 1));
for (const r of rows) console.log(r.model, '|', r.gname, '|', r.pname, '|', r.guardTests.join(',') || 'NONE', '|', r.pdTests.join(','));
