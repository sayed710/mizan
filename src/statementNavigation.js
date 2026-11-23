/** Link a report row or selected partners to the customer statement report. */
export function statementUrl(ids, { companyId, from, to } = {}) {
  const params = new URLSearchParams();
  params.set('partners', ids.join(','));
  if (companyId && companyId !== 'all') params.set('company', String(companyId));
  if (from != null) params.set('from', from);
  if (to) params.set('to', to);
  return `#/accounting/customer-statement?${params}`;
}
