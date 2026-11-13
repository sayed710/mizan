import { models } from '../models/index.js';
import { fromCsv, importCsvRows } from '../csv.js';
import { commit, getDb } from '../store.js';
import { t } from '../i18n.js';

/** Accepted file extensions/MIME types for importing records of `model`. */
export function importAccept(model) {
  const def = models[model];
  return ['.csv,text/csv', def?.importFile?.accept].filter(Boolean).join(',');
}

/** Parse and commit a CSV or model-specific statement file, reporting success or failure. */
export async function importModelFile(model, defaults, file) {
  const def = models[model];
  try {
    const text = await file.text();
    const res = def.importFile && !/\.csv$/i.test(file.name)
      ? def.importFile.run(getDb(), file.name, text, defaults)
      : importCsvRows(getDb(), model, defaults, fromCsv(text));
    // Report the import only once the server has accepted it (a refusal shows its own message).
    if ((await commit(res.db)).ok) alert(t('{n} record(s) imported.', { n: res.count }));
  } catch (e) {
    alert(e instanceof Error ? e.message : t('Import failed'));
  }
}
