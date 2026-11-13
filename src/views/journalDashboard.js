const JOURNAL_LISTS = {
  sale: 'invoices',
  purchase: 'bills',
  bank: 'bank',
  cash: 'entries',
  general: 'entries',
};

/** Build the list action opened from a journal card: always narrowed to that card's journal. */
export function journalCardListUrl(card) {
  return `#/accounting/${JOURNAL_LISTS[card.kind]}?view=list&rel=journal_id:${card.journal.id}`;
}
