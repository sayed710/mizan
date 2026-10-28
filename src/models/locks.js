// MOD-008: a record the form shows as locked (form.lockedWhen) stays locked on the server, not only in the form.
// For non-admin users, the editable fields of a locked record cannot change; workflow fields (status, links and
// amounts that buttons set, which the form shows read-only or not at all) still can.

/** Fields a user can type into on the form: its title, groups and tabs, minus read-only, computed and hidden ones. */
export function editableFields(model, record = {}, db) {
  const list = (v) => (Array.isArray(v) ? v : []);
  const tabs = typeof model.form?.tabs === 'function' ? model.form.tabs(record, db) : model.form?.tabs;
  const listed = [model.form?.title, ...list(model.form?.groups).flat(), ...list(tabs).flatMap((t) => list(t?.fields))].filter((f) => typeof f === 'string');
  return [...new Set(listed)].filter((name) => {
    const f = model.fields?.[name];
    return f && typed(f) && !['state', 'stage', 'stage_id'].includes(name) && name !== model.form.statusbar;
  });
}

const typed = (f) => !f.readonly && !f.compute && !f.hidden;

/** A field's user-entered content: for lines, only their editable columns (buttons maintain the others, e.g. qty_invoiced). */
function content(field, value) {
  if (field.type !== 'one2many' || !Array.isArray(value) || !field.fields) return value ?? null;
  const columns = Object.entries(field.fields).filter(([, f]) => typed(f)).map(([k]) => k);
  return value.map((line) => Object.fromEntries(columns.map((k) => [k, line?.[k] ?? null])));
}

const same = (field, a, b) => JSON.stringify(content(field, a)) === JSON.stringify(content(field, b));

// Fields that workflow buttons fill in on records the form already shows as locked.
const MAINTAINED = {
  'hr.expense.sheet': ['accounting_date', 'manager_id'], // set when the report is approved and posted
  'sign.request': ['field_values'], // populated by the signer workflow; request configuration stays locked
  'documents.document': ['locked_by'], // Lock / Unlock
  'mailing.mailing': ['ab_testing_winner_selection'], // the A/B winner is chosen after sending
  'account.move': ['ref'], // the reference stays editable on posted entries
};

export function withLocks(models) {
  return Object.fromEntries(Object.entries(models).map(([name, model]) => {
    const locked = model.form?.lockedWhen;
    if (!locked) return [name, model];
    return [name, {
      ...model,
      guard: (db, before, r, ctx) => {
        // The model's own rule speaks first (it gives the more specific message, e.g. "Reopen the fiscal year…").
        const own = model.guard?.(db, before, r, ctx);
        if (own) return own;
        // Enforced for non-admin users on the server (applyDiff passes ctx); administrators may correct records.
        if (ctx?.isAdmin !== false || !before || !locked(before, db)) return null;
        const maintained = (name === 'sign.request' && before.state !== 'sent') || (name === 'hr.expense.sheet' && before.state === r.state) ? [] : MAINTAINED[name] ?? [];
        const fields = editableFields(model, before, db).filter((f) => !maintained.includes(f));
        const changed = fields.filter((f) => !same(model.fields[f], before[f], r[f]));
        if (name === 'sign.request' && before.state !== 'sent') {
          for (const f of ['signature', 'sign_date', 'signer_ids', 'field_values']) {
            if (JSON.stringify(before[f] ?? null) !== JSON.stringify(r[f] ?? null) && !changed.includes(f)) changed.push(f);
          }
        }
        return changed.length ? `This record is locked: ${changed.map((f) => model.fields[f].label ?? f).join(', ')} cannot change` : null;
      },
    }];
  }));
}
