import { create, write } from '../orm.js';

/** Apply values entered on a form using the same validation as every ORM write. */
export function saveFormRecord(db, model, id, values) {
  return id == null ? create(db, model, values) : { db: write(db, model, id, values), id };
}
