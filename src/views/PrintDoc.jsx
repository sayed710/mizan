import { useEffect } from 'react';
import { models } from '../models/index.js';
import { read } from '../orm.js';
import { useDb } from '../store.js';
import { t } from '../i18n.js';
import { display, formatDate } from '../ui.jsx';
import { checkAmountDisplay } from '../models/payments.js';
import { subtotal } from '../models/common.js';
import { invoiceQrPayload, invoiceQrSettingsForCompany, qrMatrix } from '../models/qr.js';
import { documentCompany } from '../models/company.js';
import { documentCurrency } from '../money.js';

/** Payment QR (settings decide the standard); a misconfiguration shows a note instead of breaking the print. */
function PaymentQr({ db, company, settings, move }) {
  let payload;
  try {
    payload = invoiceQrPayload(settings, company, move, documentCurrency(db, move)?.name ?? null);
  } catch (e) {
    return <p className="muted no-print">{t(e.message)}</p>;
  }
  if (!payload) return null;
  const grid = qrMatrix(payload);
  return (
    <figure className="paper-qr">
      <svg viewBox={`0 0 ${grid.length + 4} ${grid.length + 4}`} width="120" height="120" role="img" aria-label={t('Payment QR code')} shapeRendering="crispEdges">
        <rect width="100%" height="100%" fill="#fff" />
        {grid.flatMap((row, r) => row.map((dark, c) => (dark ? <rect key={`${r}-${c}`} x={c + 2} y={r + 2} width="1" height="1" fill="#000" /> : null)))}
      </svg>
      <figcaption className="muted">{t(settings.invoice_qr === 'zatca' ? 'Scan to verify this invoice' : 'Scan to pay')}</figcaption>
    </figure>
  );
}

// Document layouts per model: which fields form the header block and which one2many holds the lines.
const LAYOUTS = {
  'account.move': { title: (r) => t(models['account.move'].form.subtitle(r)), lines: 'invoice_line_ids', info: ['invoice_date', 'invoice_date_due', 'invoice_origin', 'payment_reference', 'incoterm_id', 'incoterm_location'], totals: ['amount_untaxed', 'amount_tax', 'amount_total', 'amount_residual'] },
  'sale.order': { title: (r) => t(r.state === 'sale' ? 'Sales Order' : 'Quotation'), lines: 'order_line', info: ['date_order', 'validity_date', 'user'], totals: ['amount_untaxed', 'amount_tax', 'amount_total'] },
  'purchase.order': { title: (r) => t(r.state === 'purchase' ? 'Purchase Order' : 'Request for Quotation'), lines: 'order_line', info: ['date_order', 'date_planned'], totals: ['amount_untaxed', 'amount_tax', 'amount_total'] },
  'hr.payslip': { title: () => t('Payslip'), lines: 'line_ids', info: ['date_from', 'date_to'], totals: ['gross_wage', 'net_wage'], partner: 'employee_id', partnerModel: 'hr.employee' },
};

export const printable = (model) => model in LAYOUTS || model === 'account.batch.payment';

/** One cheque per batch line: payee, date, number, amount in figures and in words. */
function Checks({ db, batch }) {
  const company = documentCompany(db, batch);
  if (!company) return <main className="print-page"><p role="alert">{t('Configure the batch company before printing checks.')}</p></main>;
  return (
    <main className="print-page">
      <div className="no-print print-toolbar">
        <button type="button" className="btn primary" onClick={() => window.print()}>{t('Print')}</button>
        <button type="button" className="btn" onClick={() => history.back()}>{t('Back')}</button>
      </div>
      {(batch.lines ?? []).filter((l) => !l.cancelled && l.payment_id && read(db, 'account.payment', l.payment_id)?.state === 'posted').map((l) => {
        const move = read(db, 'account.move', l.move_id);
        const payment = read(db, 'account.payment', l.payment_id);
        const number = payment?.check_number ?? l.check_number;
        let amounts;
        try {
          amounts = checkAmountDisplay(db, payment, move, l.amount);
        } catch (e) {
          amounts = { numeric: t(e.message), words: t(e.message) };
        }
        return (
          <article key={number ?? l.move_id} className="paper check">
            <header className="paper-head"><b className="paper-company">{company.name}</b><span>{t('Check')} #{number}</span></header>
            <p>{t('Date')}: {formatDate(batch.date)}</p>
            <p>{t('Pay to the order of')} <b>{read(db, 'res.partner', move?.partner_id)?.name ?? '—'}</b> <span className="num">{amounts.numeric}</span></p>
            <p className="check-words">{amounts.words}</p>
            <footer className="paper-foot muted">{t('Memo')}: {move?.name}</footer>
          </article>
        );
      })}
    </main>
  );
}

/** Paper-style document rendered from the record, then the browser print dialog (Save as PDF). */
export function PrintDoc({ model, id }) {
  const db = useDb();
  const def = models[model];
  const layout = LAYOUTS[model];
  const rec = read(db, model, Number(id));
  const recId = rec?.id;
  useEffect(() => {
    if (!recId) return undefined;
    const timer = setTimeout(() => window.print(), 300);
    return () => clearTimeout(timer);
  }, [recId]);
  if (rec && model === 'account.batch.payment') return <Checks db={db} batch={rec} />;
  if (!rec || !layout) return <main className="action"><p className="empty">{t('Record not found.')}</p></main>;

  const company = documentCompany(db, rec);
  if (!company) return <main className="action"><p className="empty" role="alert">{t('Configure the document company before printing.')}</p></main>;
  const qrSettings = invoiceQrSettingsForCompany(db, company);

  const partner = read(db, layout.partnerModel ?? 'res.partner', rec[layout.partner ?? 'partner_id']);
  const lineDef = def.fields[layout.lines];
  const cols = Object.entries(lineDef.fields).filter(([, f]) => !f.hidden);
  const priced = 'price_unit' in lineDef.fields;
  return (
    <main className="print-page">
      <div className="no-print print-toolbar">
        <button type="button" className="btn primary" onClick={() => window.print()}>{t('Print')}</button>
        <button type="button" className="btn" onClick={() => history.back()}>{t('Back')}</button>
      </div>
      <article className="paper">
        <header className="paper-head">
          <div><b className="paper-company">{company.name}</b><div className="muted">{company.currency ?? t('Company currency is not configured')}</div></div>
          {partner && (
            <address>
              <b>{partner.name}</b>
              {[partner.email ?? partner.work_email, partner.phone ?? partner.work_phone, [partner.city, partner.country].filter(Boolean).join(', '), partner.vat && `${t('Tax ID')}: ${partner.vat}`]
                .filter(Boolean).map((l) => <div key={l}>{l}</div>)}
            </address>
          )}
        </header>
        <h1>{layout.title(rec)} {rec.name && rec.name !== '/' ? rec.name : ''}</h1>
        <dl className="paper-info">
          {layout.info.filter((f) => rec[f]).map((f) => (
            <div key={f}><dt>{t(def.fields[f].label)}</dt><dd>{def.fields[f].type === 'date' ? formatDate(rec[f]) : display(db, def.fields[f], rec[f], rec)}</dd></div>
          ))}
        </dl>
        <table className="paper-lines">
          <thead><tr>{cols.map(([k, f]) => <th key={k}>{t(f.label)}</th>)}{priced && <th className="num">{t('Amount')}</th>}</tr></thead>
          <tbody>
            {(rec[layout.lines] ?? []).map((l, i) => (
              <tr key={i}>
                {cols.map(([k, f]) => <td key={k} className={['monetary', 'float'].includes(f.type) ? 'num' : ''}>{display(db, f, l[k], { ...l, company_id: l.company_id ?? rec.company_id, currency_id: l.currency_id ?? rec.currency_id })}</td>)}
                {priced && <td className="num">{display(db, { type: 'monetary' }, subtotal(l), rec)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="totals paper-totals">
          {layout.totals.map((f) => (
            <div key={f} className={f === 'amount_total' || f === 'net_wage' ? 'grand' : ''}><dt>{t(def.fields[f].label)}</dt><dd>{display(db, def.fields[f], rec[f], rec)}</dd></div>
          ))}
        </dl>
        {model === 'account.move' && <PaymentQr db={db} company={company} settings={qrSettings} move={rec} />}
        {rec.narration && <p className="paper-note">{rec.narration}</p>}
        <footer className="paper-foot muted">{company.name} · {t('Generated by Mizan')}</footer>
      </article>
    </main>
  );
}
