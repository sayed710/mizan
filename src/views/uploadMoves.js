import { create, read } from '../orm.js';
import { currentCompany } from '../models/company.js';
import { models } from '../models/index.js';
import { resolveDocumentJournal } from '../models/ledger.js';
import { diffDb } from '../sync.js';
import { cleanValue } from '../validate.js';

export const MAX_SERVER_DIFF_BYTES = 5 * 1024 * 1024;
export const MAX_UPLOAD_BATCH_BYTES = 4.5 * 1024 * 1024;
const MAX_SINGLE_DIFF_BYTES = MAX_SERVER_DIFF_BYTES - 16 * 1024;
const MAX_RAW_FOR_ENCODED = Math.floor((3 * 1024 * 1024 - 'data:;base64,'.length) / 4) * 3;
const encoder = new TextEncoder();
const utf8Bytes = (value) => encoder.encode(JSON.stringify(value)).length;
const formatFileError = (file, message) => (file?.name ? `${file.name}: ${message}` : message);

function resolveUploadTarget(db, { moveType, companyId, journalId }) {
  if (!['in_invoice', 'out_invoice'].includes(moveType)) throw new Error('Invalid document type');
  const expectedType = moveType === 'in_invoice' ? 'purchase' : 'sale';
  const allowedCompanies = db.settings?.allowed_company_ids ?? [currentCompany(db)];
  const explicitJournal = journalId !== undefined && journalId !== null;
  let journal = null;
  let targetCompanyId = companyId;

  if (explicitJournal) {
    if (Array.isArray(journalId)) throw new Error('Select an active journal for this company and document type');
    if (!Number.isSafeInteger(journalId) || journalId < 1) throw new Error('Selected journal does not exist');
    journal = read(db, 'account.journal', journalId);
    if (!journal) throw new Error('Selected journal does not exist');
    if (journal.company_id && !allowedCompanies.includes(journal.company_id)) throw new Error('No access to that company');
    targetCompanyId = targetCompanyId ?? journal.company_id ?? currentCompany(db);
  } else {
    targetCompanyId = targetCompanyId ?? currentCompany(db);
  }

  if (!Number.isSafeInteger(targetCompanyId) || targetCompanyId < 1) throw new Error('Select an existing active company');
  if (!allowedCompanies.includes(targetCompanyId)) throw new Error('No access to that company');
  const companies = db.records?.['res.company'] ?? [];
  if (companies.length) {
    const company = read(db, 'res.company', targetCompanyId);
    if (!company || company.active === false) throw new Error('Select an existing active company');
  }

  if (!explicitJournal) {
    journal = resolveDocumentJournal(db, { move_type: moveType, company_id: targetCompanyId }, { required: true });
  }
  if (journal.type !== expectedType || (journal.company_id && journal.company_id !== targetCompanyId) || journal.active === false) {
    throw new Error('Select an active journal for this company and document type');
  }
  return { companyId: targetCompanyId, journal };
}

function validateUploadedFile(file) {
  if (!file || typeof file !== 'object') throw new Error('Could not read file');
  if (!String(file.name ?? '').trim()) throw new Error('Name is required');
  cleanValue(models['documents.document'].fields.file, file, 'documents.document.file');
}

/** Create linked drafts in one ordinary, diff-validated transition. */
export function createUploadedMoves(db, files, options) {
  const { companyId, journal } = resolveUploadTarget(db, options);
  const ids = [];
  let next = db;
  for (const file of files) {
    const made = create(next, 'account.move', { move_type: options.moveType, company_id: companyId, journal_id: journal.id, state: 'draft' });
    next = create(made.db, 'documents.document', { name: file.name, file, folder: 'finance', company_id: companyId, res_model: 'account.move', res_id: made.id }).db;
    ids.push(made.id);
  }
  return { db: next, ids };
}

export const uploadedMovesUrl = (moveType, ids) => {
  if (!ids.length) return null;
  const base = `#/accounting/${moveType === 'in_invoice' ? 'bills' : 'invoices'}`;
  return ids.length === 1 ? `${base}/${ids[0]}` : `${base}?view=list&rel=id:${ids.join(',')}`;
};

/** Save in bounded sequential batches before invoking the existing optional bill digitizer. */
export async function uploadMoves(files, options, { getDb, commit, ai, digitize, maxBatchBytes, readFile }) {
  resolveUploadTarget(getDb(), options);
  const list = Array.from(files ?? []);
  if (!list.length) return { ids: [], errors: [], go: null };

  const batchLimit = Math.min(maxBatchBytes ?? MAX_UPLOAD_BATCH_BYTES, MAX_SINGLE_DIFF_BYTES);
  const tryCommit = async (nextDb) => {
    try {
      const saved = await commit(nextDb, { quiet: true });
      if (!saved?.ok) return { ok: false, error: saved?.error || 'Could not save changes' };
      return { ok: true, saved };
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not save changes' };
    }
  };

  const createdIds = [];
  const errors = [];
  let batch = [];
  let batchBytes = 0;

  const flush = async () => {
    if (!batch.length) return;
    const queue = batch;
    batch = [];
    batchBytes = 0;

    while (queue.length) {
      // Build from the freshest store db and diff synchronously right before commit (no await in between).
      const freshDb = getDb();
      const first = queue[0];
      let chunk = [first];
      let chunkCreated = createUploadedMoves(freshDb, chunk, options);
      let chunkBytes = utf8Bytes(diffDb(freshDb, chunkCreated.db));
      if (chunkBytes > MAX_SINGLE_DIFF_BYTES) {
        queue.shift();
        errors.push(formatFileError(first, 'Request too large'));
        continue;
      }

      while (chunk.length < queue.length) {
        const candidateFile = queue[chunk.length];
        if (chunkBytes + utf8Bytes(candidateFile) > batchLimit) break;
        const candidate = createUploadedMoves(freshDb, [...chunk, candidateFile], options);
        const candidateBytes = utf8Bytes(diffDb(freshDb, candidate.db));
        if (candidateBytes > batchLimit) break;
        chunk.push(candidateFile);
        chunkCreated = candidate;
        chunkBytes = candidateBytes;
      }
      queue.splice(0, chunk.length);

      // Never replay a failed commit: store.commit also returns ok:false when the response is lost after persistence.
      const saved = await tryCommit(chunkCreated.db);
      if (!saved.ok) {
        for (const file of chunk) errors.push(formatFileError(file, saved.error));
        continue;
      }

      const chunkItems = [];
      for (let i = 0; i < chunk.length; i++) {
        const rawId = chunkCreated.ids[i];
        const id = saved.saved.remapped?.['account.move']?.[rawId] ?? rawId;
        createdIds.push(id);
        chunkItems.push({ id, file: chunk[i] });
      }
      if (ai && options.moveType === 'in_invoice') {
        for (const { id, file } of chunkItems) {
          try {
            const result = await digitize({ model: 'account.move', id, draft_only: true, file: { name: file.name, type: file.type, data: file.data.split(',')[1] } });
            if (result?.ok === false) throw new Error(result.error || 'Could not save changes');
          } catch (error) {
            errors.push(formatFileError(file, error?.message || 'Could not save changes'));
          }
        }
      }
    }
  };

  for (const rawFile of list) {
    if (readFile && Number.isFinite(rawFile?.size) && rawFile.size > MAX_RAW_FOR_ENCODED) {
      errors.push(formatFileError(rawFile, 'File is larger than 2 MB'));
      continue;
    }
    if (batch.length && Number.isFinite(rawFile?.size)) {
      const estimatedEncoded = Math.ceil((rawFile.size * 4) / 3);
      if (batchBytes + estimatedEncoded > batchLimit) await flush();
    }

    let file;
    try {
      file = readFile ? await readFile(rawFile) : rawFile;
      validateUploadedFile(file);
    } catch (error) {
      errors.push(formatFileError(rawFile, error?.message || 'Could not read file'));
      continue;
    }

    const baseDb = getDb();
    if (!batch.length) {
      const single = createUploadedMoves(baseDb, [file], options);
      const singleBytes = utf8Bytes(diffDb(baseDb, single.db));
      if (singleBytes > MAX_SINGLE_DIFF_BYTES) {
        errors.push(formatFileError(file, 'Request too large'));
        continue;
      }
      batch = [file];
      batchBytes = singleBytes;
      continue;
    }

    if (batchBytes + utf8Bytes(file) <= batchLimit) {
      const candidate = createUploadedMoves(baseDb, [...batch, file], options);
      const candidateBytes = utf8Bytes(diffDb(baseDb, candidate.db));
      if (candidateBytes <= batchLimit) {
        batch.push(file);
        batchBytes = candidateBytes;
        continue;
      }
    }

    await flush();
    const freshDb = getDb();
    const single = createUploadedMoves(freshDb, [file], options);
    const singleBytes = utf8Bytes(diffDb(freshDb, single.db));
    if (singleBytes > MAX_SINGLE_DIFF_BYTES) {
      errors.push(formatFileError(file, 'Request too large'));
      continue;
    }
    batch = [file];
    batchBytes = singleBytes;
  }
  await flush();

  return { ids: createdIds, errors, go: uploadedMovesUrl(options.moveType, createdIds) };
}
