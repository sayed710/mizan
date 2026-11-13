/** Resolve field editability for a record across forms, imports, copies, and API metadata. */
export const fieldReadonly = (field, record, db) => !!(
  field?.compute
  || (typeof field?.readonly === 'function' ? field.readonly(record, db) : field?.readonly)
);

/** Resolve whether a field is required for a record across forms, imports, and ORM validation. */
export const fieldRequired = (field, record, db, isNew = false) => !!(
  typeof field?.required === 'function' ? field.required(record, db, { isNew }) : field?.required
);
