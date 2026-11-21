const W = process.argv[2];
const { seed } = await import(W + '/src/seed.js');
const { models, modelsForApps } = await import(W + '/src/models/index.js');
const db = seed();
const counts = Object.entries(db.records).map(([m,r])=>[m,r.length]).filter(([,n])=>n).sort((a,b)=>b[1]-a[1]);
console.log('models with records', counts.length, 'total', counts.reduce((s,[,n])=>s+n,0));
console.log(counts.slice(0,15).map(x=>x.join(':')).join(' '));
console.log('settings keys', Object.keys(db.settings).join(','));
console.log('companies', JSON.stringify(db.settings.companies), 'allowed', JSON.stringify(db.settings.allowed_company_ids), 'current', db.settings.current_company_id);
const am = db.records['account.move']?.[0]; console.log('move fields', am && Object.keys(am).join(','));
console.log('move state opts', JSON.stringify(models['account.move'].fields.state?.options));
console.log('hr.employee fields', Object.keys(models['hr.employee'].fields).join(','));
// which shared models relate to hr.employee/account.account
for (const m of ['mail.activity','discuss.channel','res.partner','product']) for (const [k,f] of Object.entries(models[m].fields)) if (['hr.employee','account.account','account.move'].includes(f.relation)) console.log(m,k,'->',f.relation);
const inv = modelsForApps(['inventory']); for (const m of inv) for (const [k,f] of Object.entries(models[m].fields)) if (f.relation==='account.move') console.log('inv', m, k);
