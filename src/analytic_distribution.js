export function analyticAccountKey(id) {
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('Select a valid analytic account');
  return Number(id);
}

/** Validate analytic account allocations against their independent plan totals. */
export function normalizeDistribution(distribution, db) {
  if (distribution == null) return {};
  if (typeof distribution !== 'object' || Array.isArray(distribution) || (Object.getPrototypeOf(distribution) !== Object.prototype && Object.getPrototypeOf(distribution) !== null)) throw new Error('Analytic distribution must be an object');
  const totals = new Map();
  const entries = Object.entries(distribution).map(([id, percent]) => {
    analyticAccountKey(id);
    if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) throw new Error('Analytic percentages must be non-negative numbers');
    const account = db && (db.records['account.analytic.account'] ?? []).find((r) => r.id === Number(id));
    if (db && !account) throw new Error('Analytic account not found');
    const plan = db ? (account.plan_id ? `plan:${account.plan_id}` : `legacy:${account.plan || 'project'}`) : 'all';
    totals.set(plan, (totals.get(plan) ?? 0) + percent);
    return [id, percent];
  });
  if ([...totals.values()].some((n) => n > 100 + 1e-9)) throw new Error('Analytic distribution cannot exceed 100% per plan');
  return Object.fromEntries(entries);
}

/** Invalid editor text marks the pending value invalid so the normal save path rejects it. */
export function parseDistributionInput(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : NaN;
  } catch { return NaN; }
}

/** Check every declared distribution, including invoice and journal item subfields. */
export function distributionError(fields, record, db) {
  for (const [key, field] of Object.entries(fields ?? {})) {
    const value = record?.[key];
    if (key === 'analytic_distribution' && value != null) {
      try { normalizeDistribution(value, db); } catch (e) { return e.message; }
    }
    if (field.type === 'one2many' && Array.isArray(value)) {
      for (const line of value) {
        const error = distributionError(field.fields, line, db);
        if (error) return error;
      }
    }
  }
  return null;
}
