/** Resolve field editability for a record across forms, imports, copies, and API metadata. */
export const fieldReadonly = (field, record, db) => !!(
  field?.compute
  || (typeof field?.readonly === 'function' ? field.readonly(record, db) : field?.readonly)
);
