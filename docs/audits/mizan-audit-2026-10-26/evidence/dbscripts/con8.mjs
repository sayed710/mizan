const W = process.argv[2];
const { seed } = await import(W + '/src/seed.js');
const { applyDiff, diffDb } = await import(W + '/src/sync.js');
const { read, write } = await import(W + '/src/orm.js');
const { models } = await import(W + '/src/models/index.js');
const E = { upserts: {}, deletes: {}, messages: [], removedMessages: [] };
let s = seed();
s = applyDiff(s, { ...E, settings: { ...s.settings, customFields: [{ model: 'crm.lead', label: 'Region', type: 'selection', options: 'North, South' }] } });
const fname = Object.keys(models['crm.lead'].fields).find((k) => models['crm.lead'].fields[k].custom);
const opt = models['crm.lead'].fields[fname].options[0][0];
s = applyDiff(s, diffDb(s, write(s, 'crm.lead', 1, { [fname]: opt })));
console.log('custom field', fname, 'options', JSON.stringify(models['crm.lead'].fields[fname].options), '| lead#1 value', read(s, 'crm.lead', 1)[fname]);
s = applyDiff(s, { ...E, settings: { ...s.settings, customFields: [{ model: 'crm.lead', label: 'Region', type: 'selection', options: 'East, West' }] } });
console.log('admin changes options ->', JSON.stringify(models['crm.lead'].fields[fname].options));
try { applyDiff(s, diffDb(s, write(s, 'crm.lead', 1, { priority: 3 }))); console.log('edit of lead#1 accepted'); } catch (e) { console.log('ordinary edit of lead#1 (priority) rejected:', e.message); }
s = applyDiff(s, { ...E, settings: { ...s.settings, customFields: [] } });
console.log('admin deletes the custom field -> still declared in this process:', !!models['crm.lead'].fields[fname]);
