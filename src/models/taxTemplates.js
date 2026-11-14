// Data-driven tax return template definitions shared by models and export helpers.

/** Explicit tax return template options stored on company or return records. */
export const TAX_RETURN_TEMPLATE_OPTIONS = [
  ['generic', 'Generic VAT Return'],
  ['eg_vat', 'Egypt VAT (Form 10)'],
  ['sa_vat', 'Saudi Arabia VAT (ZATCA)'],
];

/**
 * Data-driven tax return box template registry keyed by explicit template key.
 * Each template maps `taxesByTax` items strictly using explicit fields (`side`, `tax_scope`),
 * never guessing from record names.
 */
export const TAX_RETURN_TEMPLATES = {
  generic: {
    label: 'Generic VAT Return',
    mode: 'by_tax',
  },
  eg_vat: {
    label: 'Egypt VAT (Form 10)',
    mode: 'boxes',
    boxes: [
      { code: 'BOX-1', label: 'Standard Sales - Goods', side: 'sale', tax_scope: 'consu' },
      { code: 'BOX-2', label: 'Standard Sales - Services', side: 'sale', tax_scope: 'service' },
      { code: 'BOX-3', label: 'Other Output VAT', side: 'sale', isDefault: true },
      { code: 'BOX-4', label: 'Total Output Tax', kind: 'total_output' },
      { code: 'BOX-5', label: 'Purchases - Goods', side: 'purchase', tax_scope: 'consu' },
      { code: 'BOX-6', label: 'Purchases - Services', side: 'purchase', tax_scope: 'service' },
      { code: 'BOX-7', label: 'Other Input VAT', side: 'purchase', isDefault: true },
      { code: 'BOX-8', label: 'Total Input Tax', kind: 'total_input' },
      { code: 'BOX-9', label: 'Net Tax Payable', kind: 'net_payable' },
    ],
  },
  sa_vat: {
    label: 'Saudi Arabia VAT (ZATCA)',
    mode: 'boxes',
    boxes: [
      { code: '1', label: 'Standard Rated Sales - Goods', side: 'sale', tax_scope: 'consu' },
      { code: '2', label: 'Standard Rated Sales - Services', side: 'sale', tax_scope: 'service' },
      { code: '3', label: 'Other Standard Rated Sales', side: 'sale', isDefault: true },
      { code: '5', label: 'Total Sales and Output VAT', kind: 'total_output' },
      { code: '6', label: 'Standard Rated Domestic Purchases - Goods', side: 'purchase', tax_scope: 'consu' },
      { code: '7', label: 'Standard Rated Domestic Purchases - Services', side: 'purchase', tax_scope: 'service' },
      { code: '8', label: 'Other Standard Rated Purchases', side: 'purchase', isDefault: true },
      { code: '12', label: 'Total Purchases and Input VAT', kind: 'total_input' },
      { code: '13', label: 'Net VAT Due (or Reclaimable)', kind: 'net_payable' },
    ],
  },
};
