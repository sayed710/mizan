const W = process.argv[2];
const { apps, modelsForApps, models } = await import(W + '/src/models/index.js');
console.log('total models', Object.keys(models).length, 'apps', apps.length);
const sens = ['account.move','hr.payslip','hr.employee','stock.move','stock.picking','account.payment','hr.contract','res.users','website.page','account.account','account.journal','hr.leave'];
for (const id of ['crm','sales','contacts','project','helpdesk','website','discuss','inventory','pos','livechat','iot']) {
  if (!apps.find(a=>a.id===id)) { console.log(id,'(no such app)'); continue; }
  const s = modelsForApps([id]);
  console.log(id, s.size, 'sensitive:', sens.filter(m=>s.has(m)).join(','));
}
