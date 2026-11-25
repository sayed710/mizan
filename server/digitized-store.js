import { applyDiff, diffDb } from '../src/sync.js';

// Only the digitization action calls this server-side path. All other changes still pass diff validation.
export function applyDigitizedBill(current, base, next, id, opts) {
  const before = base.records['account.move']?.find((m) => m.id === id);
  const now = current.records['account.move']?.find((m) => m.id === id);
  const filled = next.records['account.move']?.find((m) => m.id === id);
  if (!before || !now || !filled || before.state !== 'draft' || now.state !== 'draft' ||
      JSON.stringify(before) !== JSON.stringify(now)) throw new Error('The bill changed while digitizing; reload and try again');
  const fields = ['digitized_document', 'digitized_vendor_id', 'digitized_unedited'];
  const safe = { ...filled };
  for (const key of fields) {
    if (Object.hasOwn(before, key)) safe[key] = before[key];
    else delete safe[key];
  }
  if (before.digitized_unedited) safe.digitized_unedited = false;
  const sanitized = { ...next, records: { ...next.records, 'account.move': next.records['account.move'].map((m) => m.id === id ? safe : m) } };
  const applied = applyDiff(current, diffDb(base, sanitized), opts);
  return { ...applied, records: { ...applied.records, 'account.move': applied.records['account.move'].map((m) => m.id === id
    ? { ...m, digitized_document: true, digitized_vendor_id: filled.partner_id, digitized_unedited: true } : m) } };
}
