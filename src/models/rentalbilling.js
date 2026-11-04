const hasLegacyBilling = (r) => Boolean(r.invoiced || Number(r.late_fee_invoiced));

/**
 * Flag rentals that already have legacy billing counters for administrator review,
 * keeping counters exactly as recorded. Never reconstruct legacy data by inference.
 */
export function migrateLegacyRentalBilling(db) {
  const rentals = db.records['sale.rental'] ?? [];
  const records = rentals.map((rental) => {
    if (rental.legacy_billing_review_note || !hasLegacyBilling(rental)) return rental;
    return { ...rental, legacy_billing_review: true };
  });
  return { ...db, records: { ...db.records, 'sale.rental': records } };
}
