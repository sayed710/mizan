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
    const plan = db ? analyticPlanKey(account) : 'all';
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

/** A line's stored allocation: its distribution, else its legacy single analytic account at 100%. */
export function storedLineDistribution(line) {
  if (line?.analytic_distribution != null) return line.analytic_distribution;
  return line?.analytic_account_id ? { [line.analytic_account_id]: 100 } : null;
}

/** One plan key per analytic account: its plan record, else its legacy plan selection. */
export function analyticPlanKey(account) {
  return account.plan_id ? `plan:${account.plan_id}` : `legacy:${account.plan || 'project'}`;
}

/** Convert a distribution object { [accountId]: percent } to ordered editor rows. */
export function distributionToRows(distribution) {
  if (!distribution || typeof distribution !== 'object' || Array.isArray(distribution)) return [];
  return Object.entries(distribution).map(([id, percent]) => ({
    accountId: Number.isSafeInteger(Number(id)) ? Number(id) : id,
    percent,
  }));
}

/** Check editor rows for canonical validation errors before writing. */
export function distributionRowsError(rows, db = null) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const seenAccounts = new Set();
  const obj = {};
  for (const row of rows) {
    if (!row || row.accountId == null || row.accountId === '') {
      return 'Select a valid analytic account';
    }
    try {
      analyticAccountKey(String(row.accountId));
    } catch (e) {
      return e.message;
    }
    const accId = Number(row.accountId);
    if (seenAccounts.has(accId)) {
      return 'Select a valid analytic account';
    }
    seenAccounts.add(accId);

    const percent = typeof row.percent === 'string' ? (row.percent.trim() === '' ? NaN : Number(row.percent)) : row.percent;
    if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) {
      return 'Analytic percentages must be non-negative numbers';
    }
    obj[accId] = percent;
  }
  try {
    normalizeDistribution(obj, db);
  } catch (e) {
    return e.message;
  }
  return null;
}

/** Convert editor rows to a stored distribution object, or NaN on validation error. */
export function rowsToDistribution(rows, db = null) {
  if (!Array.isArray(rows) || rows.length === 0) return {};
  const error = distributionRowsError(rows, db);
  if (error) return NaN;
  const entries = rows.map((r) => [
    Number(r.accountId),
    typeof r.percent === 'string' ? Number(r.percent) : r.percent,
  ]);
  return normalizeDistribution(Object.fromEntries(entries), db);
}

/** Per-plan totals of the editor rows that have an account, in first-seen order; `account` names the plan. */
export function planTotals(rows, db) {
  const totals = new Map();
  for (const row of rows ?? []) {
    const account = (db.records['account.analytic.account'] ?? []).find((r) => r.id === Number(row.accountId));
    if (!account) continue;
    const key = analyticPlanKey(account);
    const current = totals.get(key) ?? { key, account, total: 0, rows: [] };
    current.total += Number.isFinite(row.percent) ? row.percent : 0;
    current.rows.push(row);
    current.over = current.total > 100 + 1e-9;
    totals.set(key, current);
  }
  return [...totals.values()];
}

/** What is left of `account`'s plan after the other rows: the default for a row that just picked it. */
export function remainingInPlan(otherRows, account, db) {
  const used = planTotals(otherRows, db).find((g) => g.key === analyticPlanKey(account))?.total ?? 0;
  return Math.max(0, Number((100 - used).toFixed(2)));
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
