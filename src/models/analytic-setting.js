export const analyticAccountingEnabled = (db, companyId = db?.settings?.current_company_id ?? 1) => Boolean(db?.records?.['res.company']?.find((company) => company.id === companyId)?.group_analytic_accounting);

const analyticMenuKeys = new Set(['analytic-items', 'analytic-report', 'analytic-distribution-models', 'analytic', 'analytic-plans']);
export function visibleAccountingMenus(menus, db) {
  if (analyticAccountingEnabled(db)) return menus;
  const filter = (items) => items.filter((item) => !analyticMenuKeys.has(item.key)).map((item) => item.children ? { ...item, children: filter(item.children) } : item).filter((item) => !item.children || item.children.length);
  return filter(menus);
}
