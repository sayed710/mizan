import { accountJournalItemsHref } from '../models/configurableReports.js';

/** Build a journal-item link using the period and review mode displayed by a report. */
export function reportJournalItemsHref({ accountId, partnerId, period = {}, companyId, column = 'balance', accountType, unreconciledOnly, taxId, taxKind, trialOpening, cashFlowAccount, agedKind, agedBucket, agingInterval, agingBasedOn }) {
  const before = period.from ? new Date(`${period.from}T00:00:00Z`) : null;
  if (before) before.setUTCDate(before.getUTCDate() - 1);
  return accountJournalItemsHref(accountId, {
    ...(partnerId !== undefined ? { partner: partnerId ?? 'none' } : {}),
    ...(companyId && companyId !== 'all' ? { company: companyId } : {}),
    ...(accountType ? { accountType } : {}),
    ...(unreconciledOnly ? { unreconciled: '1' } : {}),
    ...(taxId != null ? { tax: taxId, taxKind } : {}),
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
