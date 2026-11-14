const { modelsForApps, apps } = await import(process.argv[2] + '/src/models/index.js');
const sensitive = ['account.move', 'account.payment', 'hr.payslip', 'hr.contract', 'hr.employee', 'res.company', 'account.account', 'account.journal', 'stock.picking', 'sale.order', 'purchase.order', 'hr.leave', 'approval.request', 'account.fiscal.year', 'stock.valuation.layer'];
console.log('baseline (no app):', [...modelsForApps([])].join(' '));
for (const a of apps) {
  const s = modelsForApps([a.id]);
  const hit = sensitive.filter((m) => s.has(m));
  console.log(a.id.padEnd(14), String(s.size).padStart(3), hit.join(' '));
}
