import { accountJournalItemsHref } from '../models/configurableReports.js';

/** Build a journal-item link using the period and review mode displayed by a report. */
export function reportJournalItemsHref({ accountId, accountIds, partnerId, period = {}, companyId, column = 'balance', accountType, unreconciledOnly, taxId, taxKind, taxSide, trialOpening, cashFlowAccount, agedKind, agedBucket, agingInterval, agingBasedOn }) {
  const before = period.from ? new Date(`${period.from}T00:00:00Z`) : null;
  if (before) before.setUTCDate(before.getUTCDate() - 1);
  const normalizedAccountIds = Array.isArray(accountIds)
    ? [...new Set(accountIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b)
    : [];
  const singleAccountId = accountId ?? (normalizedAccountIds.length === 1 ? normalizedAccountIds[0] : null);
  return accountJournalItemsHref(singleAccountId, {
    ...(singleAccountId == null && normalizedAccountIds.length > 1 ? { accounts: normalizedAccountIds.join(',') } : {}),
    ...(partnerId !== undefined ? { partner: partnerId ?? 'none' } : {}),
    ...(companyId && companyId !== 'all' ? { company: companyId } : {}),
    ...(accountType ? { accountType } : {}),
    ...(unreconciledOnly ? { unreconciled: '1' } : {}),
    ...(taxId != null ? { tax: taxId, taxKind, ...(taxSide ? { taxSide } : {}) } : {}),
    ...(trialOpening && period.from ? { trialOpening: period.from } : {}),
    ...(cashFlowAccount ? { cashFlowAccount } : {}),
    ...(agedKind ? { agedKind, agedBucket, agingInterval, agingBasedOn } : {}),
    ...(period.journalIds?.length ? { journals: period.journalIds.join(',') } : {}),
    ...(period.analyticAccountIds?.length ? { analytics: period.analyticAccountIds.join(',') } : {}),
    ...(column !== 'initial' && column !== 'end' ? { from: period.from } : {}),
    to: column === 'initial' ? before?.toISOString().slice(0, 10) : period.to,
    reviewMode: period.reviewMode === 'all' ? 'all' : 'posted',
  });
}
