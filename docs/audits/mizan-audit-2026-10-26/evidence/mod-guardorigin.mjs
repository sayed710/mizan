import fs from 'node:fs';
const root = process.argv[2];
const { models } = await import(root + '/src/models/index.js');
const raw = {};
for (const f of fs.readdirSync(root + '/src/models').filter((f) => f.endsWith('.js') && f !== 'index.js')) {
  const mod = await import(root + '/src/models/' + f);
  for (const v of Object.values(mod)) if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, d] of Object.entries(v)) if (d && typeof d === 'object' && d.fields && d.label && typeof d.guard === 'function') raw[k] = true;
}
raw['hr.leave'] = true; // assigned in index.js
const g = Object.entries(models).filter(([, m]) => m.guard);
const companyOnly = g.filter(([k]) => !raw[k]).map(([k]) => k);
console.log('guards total', g.length, 'own business guard', g.length - companyOnly.length, 'company-check only', companyOnly.length);
console.log('company-only:', companyOnly.join(' '));
