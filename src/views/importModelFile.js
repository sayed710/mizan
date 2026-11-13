import { models } from '../models/index.js';
import { fromCsv, importCsvRows } from '../csv.js';
import { read } from '../orm.js';
import { statementImportDefaults } from '../models/statements.js';
import { commit, getDb } from '../store.js';
import { t } from '../i18n.js';

/** Accepted file extensions/MIME types for importing records of `model`. */
export function importAccept(model) {
  const def = models[model];
  return ['.csv,text/csv', def?.importFile?.accept].filter(Boolean).join(',');
}

/** Parse and commit a CSV or model-specific statement file, reporting success or failure. */
export async function importModelFile(model, defaults, file, listLabels = null) {
  const def = models[model];
  try {
    const text = await file.text();
    const db = getDb();
    const rowDefaults = model === 'account.bank.statement.line' && defaults?.journal_id && defaults.company_id == null
      ? statementImportDefaults(read(db, 'account.journal', defaults.journal_id), defaults)
      : defaults;
    const res = def.importFile && !/\.csv$/i.test(file.name)
      ? def.importFile.run(db, file.name, text, rowDefaults)
      : importCsvRows(db, model, rowDefaults, fromCsv(text), listLabels);
    // Report the import only once the server has accepted it (a refusal shows its own message).
    if ((await commit(res.db)).ok) alert(t('{n} record(s) imported.', { n: res.count }));
  } catch (e) {
    alert(e instanceof Error ? e.message : t('Import failed'));
  }
}
