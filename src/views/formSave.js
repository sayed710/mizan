import { create, read, validate, write } from '../orm.js';

/** Apply values entered on a form: ORM write validation plus every requirement the form shows. */
export function saveFormRecord(db, model, id, values) {
  if (id == null) return create(db, model, values);
  const next = write(db, model, id, values);
  // A form save enforces every requirement, including conditional ones a programmatic update leaves as stored.
  const err = validate(model, read(next, model, id), next);
  if (err) throw new Error(err);
  return { db: next, id };
}
