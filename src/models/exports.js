import { models } from '../registry.js';

export function exportFieldExists(resource, path) {
  if (typeof path !== 'string' || !path) return false;
  if (path === '.id') return true;
  const [first, second, ...rest] = path.split('/');
  const field = models[resource]?.fields[first];
  if (!field || rest.length || (path.includes('/') && !second)) return false;
  if (!second) return true;
  return Boolean(field.relation && models[field.relation]?.fields[second]);
}

const ownerError = (record, ctx) => ctx?.login && record.owner_login !== ctx.login ? 'You cannot change another user\'s export template' : null;

export const exportModels = {
  'ir.exports': {
    label: 'Export Templates',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      resource: { type: 'char', label: 'Model', required: true },
      owner_login: { type: 'char', label: 'Owner', required: true },
      export_fields: { type: 'one2many', label: 'Fields', fields: {
        name: { type: 'char', label: 'Field' },
        sequence: { type: 'integer', label: 'Sequence' },
      } },
    },
    guard: (_db, before, after, ctx) => ownerError(before ?? after, ctx) || ownerError(after, ctx)
      || (!String(after.name ?? '').trim() ? 'Export template name is required' : null)
      || (!models[after.resource] || (ctx?.allowed && !ctx.allowed.has(after.resource)) ? 'Invalid export model' : null)
      || (!Array.isArray(after.export_fields) || !after.export_fields.length || after.export_fields.some((line) => !exportFieldExists(after.resource, line.name)) ? 'Invalid export fields' : null),
    protectDelete: (_db, record, _next, ctx) => ownerError(record, ctx),
    list: ['name'],
  },
};
