import { useState } from 'react';
import { models } from '../models/index.js';
import { aggregate, groupRecords } from '../orm.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';

// Categorical slots in fixed order (validated reference palette). Series 1 = single-series color.
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#8a63d2', '#6b7280'];
const MAX_SLICES = SERIES.length - 1;

export const measuresOf = (model) => [
  ['__count', 'Count'],
  ...Object.entries(models[model].fields).filter(([, f]) => ['monetary', 'float'].includes(f.type)).map(([k, f]) => [k, f.label]),
];

export const formatMeasure = (model, measure, v) =>
  measure !== '__count' && models[model].fields[measure]?.type === 'monetary' ? money(v) : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });

export function MeasureSelect({ model, value, onChange, label = 'Measure' }) {
  return (
    <label className="inline-select">
      {t(label)}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {measuresOf(model).map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}
      </select>
    </label>
  );
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

/** Pure SVG bar/line chart with one value axis and hover tooltips. */
function Cartesian({ data, kind, fmt, onPick }) {
  const [hover, setHover] = useState(null);
  const W = 900, H = 360, L = 70, B = 40, T = 16;
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const step = (W - L - 10) / Math.max(1, data.length);
  const x = (i) => L + step * i + step / 2;
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const barW = Math.min(64, step * 0.6);
  return (
    <div className="chart-box">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="chart" className="chart">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - 10} y1={y(v)} y2={y(v)} className="grid" />
            <text x={L - 8} y={y(v) + 4} textAnchor="end" className="axis">{fmt(v)}</text>
          </g>
        ))}
        {kind === 'line' && data.length > 0 && (
          <polyline fill="none" stroke={SERIES[0]} strokeWidth="2" points={data.map((d, i) => `${x(i)},${y(d.value)}`).join(' ')} />
        )}
        {data.map((d, i) => (
          <g key={d.label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onClick={() => onPick?.(d)} className="mark">
            <rect x={x(i) - step / 2} y={T} width={step} height={H - T - B} fill="transparent" />
            {kind === 'bar'
              ? <path d={barPath(x(i) - barW / 2, y(d.value), barW, y(0) - y(d.value))} fill={SERIES[0]} opacity={hover == null || hover === i ? 1 : 0.55} />
              : <circle cx={x(i)} cy={y(d.value)} r={hover === i ? 6 : 4} fill={SERIES[0]} stroke="var(--surface)" strokeWidth="2" />}
            <text x={x(i)} y={H - B + 18} textAnchor="middle" className="axis">{truncate(d.label, step / 7)}</text>
          </g>
        ))}
        <line x1={L} x2={W - 10} y1={y(0)} y2={y(0)} className="baseline" />
      </svg>
      {hover != null && (
        <div className="tooltip" style={{ insetInlineStart: `${(x(hover) / W) * 100}%`, top: `${(y(data[hover].value) / H) * 100}%` }}>
          <b>{data[hover].label}</b>
          <span>{fmt(data[hover].value)}</span>
        </div>
      )}
    </div>
  );
}

// Bar with 4px rounded top, square baseline.
const barPath = (x0, y0, w, h) => {
  const r = Math.min(4, h, w / 2);
  if (h <= 0) return '';
  return `M${x0},${y0 + h}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x0 + w - r}Q${x0 + w},${y0} ${x0 + w},${y0 + r}V${y0 + h}Z`;
};
const truncate = (s, n) => (s.length > n ? s.slice(0, Math.max(3, n - 1)) + '…' : s);

function Pie({ data, fmt }) {
  const [hover, setHover] = useState(null);
  const sorted = [...data].filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  const slices = sorted.length > MAX_SLICES + 1
    ? [...sorted.slice(0, MAX_SLICES), { label: t('Other'), value: sorted.slice(MAX_SLICES).reduce((s, d) => s + d.value, 0) }]
    : sorted;
  const total = slices.reduce((s, d) => s + d.value, 0) || 1;
  let angle = -Math.PI / 2;
  const arcs = slices.map((d, i) => {
    const a0 = angle;
    angle += (d.value / total) * Math.PI * 2;
    return { ...d, a0, a1: angle, color: SERIES[i] };
  });
  const pt = (a, r) => [150 + r * Math.cos(a), 150 + r * Math.sin(a)];
  return (
    <div className="pie-box">
      <svg viewBox="0 0 300 300" className="pie" role="img" aria-label="pie chart">
        {arcs.map((s, i) => {
          const [x0, y0] = pt(s.a0, 130);
          const [x1, y1] = pt(s.a1, 130);
          const large = s.a1 - s.a0 > Math.PI ? 1 : 0;
          const d = arcs.length === 1
            ? 'M150,20A130,130 0 1 1 149.9,20Z'
            : `M150,150L${x0},${y0}A130,130 0 ${large} 1 ${x1},${y1}Z`;
          return (
            <path key={s.label} d={d} fill={s.color} stroke="var(--surface)" strokeWidth="2"
              opacity={hover == null || hover === i ? 1 : 0.6} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <title>{`${s.label}: ${fmt(s.value)}`}</title>
            </path>
          );
        })}
      </svg>
      <ul className="legend">
        {arcs.map((s, i) => (
          <li key={s.label} className={hover === i ? 'on' : ''} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <span className="swatch" style={{ background: s.color }} /> {s.label} <b>{fmt(s.value)}</b>
            <span className="muted"> ({Math.round((s.value / total) * 100)}%)</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Graph({ db, model, records, groupBy, onPickGroup }) {
  const def = models[model].graph ?? {};
  const [kind, setKind] = useState('bar');
  const [measure, setMeasure] = useState(def.measure ?? '__count');
  const [showTable, setShowTable] = useState(false);
  const by = groupBy[0] ?? def.groupBy;
  const data = by
    ? groupRecords(db, model, records, by).filter((g) => g.records.length).map((g) => ({ key: g.key, label: t(g.label), value: aggregate(g.records, measure) }))
    : [{ key: null, label: t('Total'), value: aggregate(records, measure) }];
  const fmt = (v) => formatMeasure(model, measure, v);
  return (
    <div className="graph-view">
      <div className="view-toolbar">
        <MeasureSelect model={model} value={measure} onChange={setMeasure} />
        <div className="seg" role="group">
          {['bar', 'line', 'pie'].map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{t(k[0].toUpperCase() + k.slice(1))}</button>
          ))}
        </div>
        <span className="spacer" />
        <button type="button" className="link" onClick={() => setShowTable(!showTable)}>{t(showTable ? 'Hide data table' : 'Show data table')}</button>
      </div>
      {kind === 'pie'
        ? <Pie data={data} fmt={fmt} />
        : <Cartesian data={data} kind={kind} fmt={fmt} onPick={by ? (d) => onPickGroup?.(by, d.key) : undefined} />}
      {showTable && (
        <table className="list data-table">
          <thead><tr><th>{by ? t(models[model].fields[by].label) : ''}</th><th className="num">{t(measuresOf(model).find((m) => m[0] === measure)[1])}</th></tr></thead>
          <tbody>{data.map((d) => <tr key={d.label}><td>{d.label}</td><td className="num">{fmt(d.value)}</td></tr>)}</tbody>
        </table>
      )}
    </div>
  );
}
