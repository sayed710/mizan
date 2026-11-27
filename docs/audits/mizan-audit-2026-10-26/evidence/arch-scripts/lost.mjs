// Compare the merged registry of a mutated index.js against the original: list lost fields/buttons/guards per model.
import { pathToFileURL } from 'node:url';
const [orig, mut] = process.argv.slice(2);
const A = (await import(pathToFileURL(orig + '/src/models/index.js'))).models;
const B = (await import(pathToFileURL(mut + '/src/models/index.js'))).models;
for (const k of Object.keys(A)) {
  const a = A[k], b = B[k]; if (a === b) continue;
  const lf = Object.keys(a.fields ?? {}).filter((f) => !(f in (b.fields ?? {})));
  const lb = (a.form?.buttons ?? []).map((x) => x.label).filter((l) => !(b.form?.buttons ?? []).some((y) => y.label === l));
  const g = a.guard && !b.guard ? ' GUARD DROPPED' : '';
  const pd = a.protectDelete && !b.protectDelete ? ' protectDelete DROPPED' : '';
  if (lf.length || lb.length || g || pd) console.log(`  ${k}: lost ${lf.length} fields [${lf.slice(0,6).join(',')}${lf.length>6?',…':''}], lost buttons [${lb.join('|')}]${g}${pd}`);
}
