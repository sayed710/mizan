import { create } from '../orm.js';
import { resolveDocumentJournal } from '../models/ledger.js';

/** Create linked drafts in one ordinary, diff-validated transition. */
export function createUploadedMoves(db, files, { moveType, companyId, journalId }) {
  if (!['in_invoice', 'out_invoice'].includes(moveType)) throw new Error('Invalid document type');
  const journal = resolveDocumentJournal(db, { move_type: moveType, company_id: companyId, journal_id: journalId }, { required: true });
  if (journal.type !== (moveType === 'in_invoice' ? 'purchase' : 'sale') || (journal.company_id ?? 1) !== companyId || journal.active === false) throw new Error('Select an active journal for this company and document type');
  const ids = [];
  let next = db;
  for (const file of files) {
    const made = create(next, 'account.move', { move_type: moveType, company_id: companyId, journal_id: journal.id, state: 'draft' });
    next = create(made.db, 'documents.document', { name: file.name, file, folder: 'finance', company_id: companyId, res_model: 'account.move', res_id: made.id }).db;
    ids.push(made.id);
  }
  return { db: next, ids };
}

export const uploadedMovesUrl = (moveType, ids) => {
  const base = `#/accounting/${moveType === 'in_invoice' ? 'bills' : 'invoices'}`;
  return ids.length === 1 ? `${base}/${ids[0]}` : `${base}?view=list&rel=id:${ids.join(',')}`;
};

/** Save before invoking the existing optional bill digitizer. */
export async function uploadMoves(files, options, { getDb, commit, ai, digitize }) {
  const created = createUploadedMoves(getDb(), files, options);
  const saved = await commit(created.db, { quiet: true });
  if (!saved.ok) throw new Error(saved.error || 'Could not save changes');
  const ids = created.ids.map((id) => saved.remapped?.['account.move']?.[id] ?? id);
  const errors = [];
  if (ai && options.moveType === 'in_invoice') {
    for (let i = 0; i < ids.length; i++) {
      const file = files[i];
      try {
        const result = await digitize({ model: 'account.move', id: ids[i], draft_only: true, file: { name: file.name, type: file.type, data: file.data.split(',')[1] } });
        if (result?.ok === false) throw new Error(result.error || 'Could not save changes');
      } catch (error) { errors.push(error.message); }
    }
  }
  return { ids, errors, go: uploadedMovesUrl(options.moveType, ids) };
}
