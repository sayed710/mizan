import { models } from '../models/index.js';

const DROPPABLE = ['selection', 'many2one', 'char', 'boolean'];

/**
 * Whether dragging a card between columns may write the grouped field. Workflow states only move
 * through their actions (posting, approving, validating), so a state column accepts drops only when
 * the form lets users click that status bar too, as with CRM or project stages.
 */
export function canDropOn(model, groupBy) {
  const def = models[model];
  const field = def?.fields[groupBy];
  if (!field || !DROPPABLE.includes(field.type) || field.readonly) return false;
  const statusbar = def.form?.statusbar;
  if (groupBy === statusbar) return Boolean(def.form.statusbarClickable);
  return groupBy !== 'state';
}
