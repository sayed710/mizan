export function toggleReportFold(open, key) {
  const next = new Set(open);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function toggleAllReportFolds(open, keys) {
  return keys.length && keys.every((key) => open.has(key)) ? new Set() : new Set(keys);
}

export function reportPrintFooters(companies) {
  return companies.map((company) => company?.report_footer).filter(Boolean);
}
