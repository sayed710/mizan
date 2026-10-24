import { useState } from 'react';
import { models } from '../models/index.js';
import { aggregate, groupRecords } from '../orm.js';
import { t } from '../i18n.js';
import { display, isNumeric, money } from '../ui.jsx';

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

const Totals = ({ cols, fields, records }) =>
  cols.map((f) => (
    <td key={f} className="num">{fields[f].type === 'monetary' ? money(aggregate(records, f)) : ''}</td>
  ));

export function List({ db, model, records, open, selected, setSelected, groupBy }) {
  const def = models[model];
  const cols = def.list;
  const fields = def.fields;
  const [sort, setSort] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const allOn = records.length > 0 && records.every((r) => selected.has(r.id));
  const toggleRow = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const row = (r, depth) => (
    <tr key={r.id} onClick={() => open(r.id)} className={`${selected.has(r.id) ? 'selected' : ''} ${def.listDecoration?.(r) ?? ''}`}>
      <td className="check" onClick={(e) => e.stopPropagation()} style={{ paddingInlineStart: 10 + depth * 18 }}>
        <input type="checkbox" aria-label={r.name} checked={selected.has(r.id)} onChange={() => toggleRow(r.id)} />
      </td>
      {cols.map((f) => <td key={f} className={isNumeric(fields[f]) ? 'num' : ''}>{display(db, fields[f], r[f])}</td>)}
    </tr>
  );

  // Recursive grouped rows: header row per group, children only when expanded.
  const groupRows = (recs, levels, path, depth) => {
    if (!levels.length) return sortRecords(db, fields, recs, sort).map((r) => row(r, depth));
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
          <tr key={id} className="group-row" onClick={toggle} aria-expanded={isOpen}>
            <td colSpan={2} style={{ paddingInlineStart: 10 + depth * 18 }}>
              <span className="caret">{isOpen ? '▾' : '▸'}</span> {t(g.label)} <span className="count">({g.records.length})</span>
            </td>
            <Totals cols={cols.slice(1)} fields={fields} records={g.records} />
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
                onChange={() => setSelected(allOn ? new Set() : new Set(records.map((r) => r.id)))} />
            </th>
            {cols.map((f) => (
              <th key={f} className={isNumeric(fields[f]) ? 'num' : ''} aria-sort={sort?.[0] === f ? (sort[1] > 0 ? 'ascending' : 'descending') : 'none'}>
                <button type="button" onClick={() => setSort(sort?.[0] === f ? [f, -sort[1]] : [f, 1])}>
                  {t(fields[f].label)} {sort?.[0] === f ? (sort[1] > 0 ? '▲' : '▼') : ''}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groupRows(records, groupBy, '', 0)}
          {!records.length && <tr><td colSpan={cols.length + 1} className="empty">{t('No record found. Create one with “New”.')}</td></tr>}
        </tbody>
        <tfoot>
          <tr>
            <td />
            <Totals cols={cols} fields={fields} records={records} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
