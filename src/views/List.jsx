import { useState } from 'react';
import { models } from '../models/index.js';
import { groupRecords } from '../orm.js';
import { t } from '../i18n.js';
import { display, FieldInput, isNumeric, money } from '../ui.jsx';
import { write } from '../orm.js';
import { commit, getDb } from '../store.js';
import { companySum, unratedCount } from '../models/money.js';
import { PAGE_SIZE } from './paging.js';
import { RateNote } from './RateNote.jsx';

function sortRecords(db, fields, records, sort) {
  if (!sort) return records;
  const [f, dir] = sort;
  const text = (r) => display(db, fields[f], r[f]);
  return [...records].sort((a, b) => {
    const x = a[f];
    const y = b[f];
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : text(a).localeCompare(text(b));
    return c * dir;
  });
}

export const colLabel = (fields, f, listLabels) => t(listLabels?.[f] ?? fields[f].label);
const badgeClass = (map, value) => (map ? (map[value] ? `badge badge-${map[value]}` : 'badge') : null);

// Footer sums use the active company's reporting currency for monetary fields.
const Totals = ({ db, cols, fields, records }) =>
  cols.map((f) => {
    const monetary = fields[f].type === 'monetary';
    const companyBooked = fields[f].currency === 'company';
    const unrated = monetary ? unratedCount(db, records, undefined, { field: f, companyBooked }) : 0;
    return (
      <td key={f} className="num" title={unrated ? t('Excludes {n} documents in a currency with no exchange rate', { n: unrated }) : undefined}>
        {monetary ? <>{money(companySum(db, records, f, undefined, { companyBooked }))} <RateNote count={unrated} /></> : ''}
      </td>
    );
  });

export function List({ db, model, records, open, selected, setSelected, groupBy, page, listLabels = null, emptyHelp = null }) {
  const def = models[model];
  const cols = def.list;
  const fields = def.fields;
  const [sort, setSort] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [shown, setShown] = useState(() => ({}));
  // Ungrouped lists render one page (sorted across all records first); grouped lists cap each open group.
  const pageRecords = groupBy.length || !page ? null : sortRecords(db, fields, records, sort).slice(page.start, page.end);
  const visible = pageRecords ?? records;
  const allOn = visible.length > 0 && visible.every((r) => selected.has(r.id));
  const toggleRow = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const row = (r, depth) => (
    <tr key={r.id} tabIndex={0} onClick={() => open(r.id)} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(r.id); }} className={`${selected.has(r.id) ? 'selected' : ''} ${def.listDecoration?.(r) ?? ''}`}>
      <td className="check" onClick={(e) => e.stopPropagation()} style={{ paddingInlineStart: 10 + depth * 18 }}>
        <input type="checkbox" aria-label={r.name} checked={selected.has(r.id)} onChange={() => toggleRow(r.id)} />
      </td>
      {cols.map((f) => {
        const field = fields[f];
        const editable = def.editableList?.includes(f);
        const text = editable ? null : display(db, field, r[f], r);
        const badge = editable ? null : badgeClass(field.badge, r[f]);
        return (
          <td key={f} className={isNumeric(field) ? 'num' : ''}
            onClick={editable ? (e) => e.stopPropagation() : undefined}>
            {editable ? <FieldInput db={db} field={field} value={r[f]} label={colLabel(fields, f, listLabels)}
              onChange={(value) => { try { commit(write(getDb(), model, r.id, { [f]: value })); } catch (e) { alert(t(e.message)); } }} />
              : badge && text ? <span className={badge}>{text}</span> : text}
          </td>
        );
      })}
    </tr>
  );

  // Recursive grouped rows: header row per group, children only when expanded.
  const groupRows = (recs, levels, path, depth) => {
    if (!levels.length) {
      const limit = shown[path] ?? PAGE_SIZE;
      const rows = sortRecords(db, fields, recs, sort).slice(0, limit).map((r) => row(r, depth));
      if (recs.length <= limit) return rows;
      return [...rows,
        <tr key={`${path}/more`} className="more-row">
          <td colSpan={cols.length + 1} style={{ paddingInlineStart: 10 + depth * 18 }}>
            <button type="button" className="link" onClick={() => setShown({ ...shown, [path]: limit + PAGE_SIZE })}>
              {t('Load more ({n} remaining)', { n: recs.length - limit })}
            </button>
          </td>
        </tr>];
    }
    return groupRecords(db, model, recs, levels[0])
      .filter((g) => g.records.length)
      .flatMap((g) => {
        const id = `${path}/${String(g.key)}`;
        const isOpen = expanded.has(id);
        const toggle = () => {
          const next = new Set(expanded);
          if (next.has(id)) next.delete(id); else next.add(id);
          setExpanded(next);
        };
        return [
          <tr key={id} className="group-row" tabIndex={0} onClick={toggle} aria-expanded={isOpen}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}>
            <td colSpan={2} style={{ paddingInlineStart: 10 + depth * 18 }}>
              <span className="caret">{isOpen ? '▾' : '▸'}</span> {t(g.label)} <span className="count">({g.records.length})</span>
            </td>
            <Totals db={db} cols={cols.slice(1)} fields={fields} records={g.records} />
          </tr>,
          ...(isOpen ? groupRows(g.records, levels.slice(1), id, depth + 1) : []),
        ];
      });
  };

  return (
    <div className="list-wrap">
      <table className="list">
        <thead>
          <tr>
            <th className="check">
              <input type="checkbox" aria-label="Select all" checked={allOn}
                onChange={() => {
                  const next = new Set(selected);
                  for (const r of visible) if (allOn) next.delete(r.id); else next.add(r.id);
                  setSelected(next);
                }} />
            </th>
            {cols.map((f) => (
              <th key={f} className={isNumeric(fields[f]) ? 'num' : ''} aria-sort={sort?.[0] === f ? (sort[1] > 0 ? 'ascending' : 'descending') : 'none'}>
                <button type="button" onClick={() => setSort(sort?.[0] === f ? [f, -sort[1]] : [f, 1])}>
                  {colLabel(fields, f, listLabels)} {sort?.[0] === f ? (sort[1] > 0 ? '▲' : '▼') : ''}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pageRecords ? pageRecords.map((r) => row(r, 0)) : groupRows(records, groupBy, '', 0)}
          {!records.length && (
            <tr>
              <td colSpan={cols.length + 1} className="empty">
                {emptyHelp ? (
                  <div className="empty-help">
                    <p className="empty-title">{t(emptyHelp.title)}</p>
                    {emptyHelp.text && <p className="empty-text">{t(emptyHelp.text)}</p>}
                  </div>
                ) : t('No record found. Create one with “New”.')}
              </td>
            </tr>
          )}
        </tbody>
        {records.length > 0 && (
          <tfoot>
            <tr>
              <td />
              <Totals db={db} cols={cols} fields={fields} records={records} />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
