const JOURNAL_LISTS = {
  sale: 'invoices',
  purchase: 'bills',
  bank: 'bank',
  cash: 'entries',
  general: 'entries',
};

/** Build the list action opened from a journal card. */
export function journalCardListUrl(card) {
  const route = `#/accounting/${JOURNAL_LISTS[card.kind]}`;
  return ['sale', 'purchase', 'bank'].includes(card.kind)
    ? `${route}?view=list&rel=journal_id:${card.journal.id}`
    : route;
}
