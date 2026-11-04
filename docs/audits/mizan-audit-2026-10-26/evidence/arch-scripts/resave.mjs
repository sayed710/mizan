// Load a db produced by an older version and try to re-save every record unchanged through the current applyDiff.
import { readFileSync } from 'node:fs';
const { applyDiff } = await import(process.cwd() + '/src/sync.js');
const { models } = await import(process.cwd() + '/src/models/index.js');
const db = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let ok = 0, bad = 0, unknown = 0; const errs = new Map();
for (const [model, recs] of Object.entries(db.records)) {
  if (!models[model]) { unknown++; continue; }
  for (const r of recs) {
    try { applyDiff(db, { upserts: { [model]: [r] }, deletes: {}, messages: [], removedMessages: [], seq: {}, settings: null }, { author: 'u', isAdmin: false }); ok++; }
    catch (e) { bad++; const k = model + ': ' + e.message.slice(0, 90); errs.set(k, (errs.get(k) ?? 0) + 1); }
  }
}
console.log(`records re-saved ok=${ok} rejected=${bad} unknownModels=${unknown}`);
for (const [k, n] of [...errs].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log('  ', n, k);
