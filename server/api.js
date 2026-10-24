// External REST API (/api/v1) authenticated with personal API keys (Authorization: Bearer <key>).
import { models } from '../src/models/index.js';
import { create, matches, read, search, unlink, write } from '../src/orm.js';
import { applyDiff, diffDb } from '../src/sync.js';

const MAX_LIMIT = 500;

/** Public shape of a model for API discovery. */
const describe = (name) => ({
  model: name,
  label: models[name].label,
  fields: Object.fromEntries(Object.entries(models[name].fields).map(([k, f]) => [k, {
    type: f.type, label: f.label, required: !!f.required, readonly: !!(f.readonly || f.compute), ...(f.relation ? { relation: f.relation } : {}), ...(f.options ? { options: f.options.map((o) => o[0]) } : {}),
  }])),
});

/**
 * @param {{ method: string, path: string, query: URLSearchParams, body: unknown, db: object, user: {name: string, isAdmin: boolean} }} req
 * @returns {{ status: number, body: unknown, db?: object }} db is set when the request changed data.
 */
export function handleApi({ method, path, query, body, db, user }) {
  const [, , , model, rawId] = path.split('/'); // "", "api", "v1", model, id
  if (model === 'models' && method === 'GET') return { status: 200, body: Object.keys(models).map(describe) };
  if (!model || !models[model]) return { status: 404, body: { error: `Unknown model ${model ?? ''}` } };
  const id = rawId === undefined ? null : Number(rawId);
  if (rawId !== undefined && !(Number.isInteger(id) && id > 0)) return { status: 400, body: { error: 'Invalid id' } };

  // Writes go through the same validation as the web client (applyDiff strips undeclared fields).
  const commit = (next) => ({ db: applyDiff(db, diffDb(db, next), { author: user.name, isAdmin: user.isAdmin }) });
  const vals = body && typeof body === 'object' && !Array.isArray(body) ? body : null;

  try {
    if (id === null && method === 'GET') {
      const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.get('limit')) || 80));
      const offset = Math.max(0, Number(query.get('offset')) || 0);
      const terms = (query.get('q') ?? '').split(/\s+/).filter(Boolean);
      const all = search(db, model).filter((r) => matches(db, model, r, terms));
      return { status: 200, body: { total: all.length, offset, limit, records: all.slice(offset, offset + limit) } };
    }
    if (id === null && method === 'POST') {
      if (!vals) return { status: 400, body: { error: 'JSON object expected' } };
      const res = create(db, model, vals);
      const { db: saved } = commit(res.db);
      return { status: 201, body: read(saved, model, res.id), db: saved };
    }
    const rec = read(db, model, id);
    if (!rec) return { status: 404, body: { error: `${model} #${id} not found` } };
    if (method === 'GET') return { status: 200, body: rec };
    if (method === 'PATCH') {
      if (!vals) return { status: 400, body: { error: 'JSON object expected' } };
      const { id: _ignored, ...changes } = vals;
      const { db: saved } = commit(write(db, model, id, changes));
      return { status: 200, body: read(saved, model, id), db: saved };
    }
    if (method === 'DELETE') {
      const { db: saved } = commit(unlink(db, model, [id]));
      return { status: 200, body: { ok: true }, db: saved };
    }
  } catch (e) {
    return { status: 400, body: { error: e instanceof Error ? e.message : 'Invalid request' } };
  }
  return { status: 405, body: { error: 'Method not allowed' } };
}
