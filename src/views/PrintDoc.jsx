import { useEffect, Fragment } from 'react';
import { models } from '../models/index.js';
import { read } from '../orm.js';
import { useDb } from '../store.js';
import { t } from '../i18n.js';
import { display, formatDate } from '../ui.jsx';
import { batchCurrency, checkAmountDisplay } from '../models/payments.js';
import { paymentRemittanceLines } from '../models/pay.js';
import { subtotal, today, validDate } from '../models/common.js';
import { invoiceTaxTotals } from '../models/ledger.js';
import { invoiceQrPayload, invoiceQrSettingsForCompany, qrMatrix } from '../models/qr.js';
import { documentCompany, addressLines, documentTaxBreakdown } from '../models/company.js';
import { taxInvoiceLabel } from '../models/taxes.js';
import { documentCurrency, formatCurrency } from '../money.js';
import { dueTermLinesError, installments, invoiceInstallments, invoiceTermNote, termScheduleError } from '../models/terms.js';
import { SafeHtml } from '../HtmlEditor.jsx';
import { ReportPrintView } from './ReportPrintView.jsx';

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
  'account.move': { title: (r) => t(({ draft: { out_invoice: 'Draft Invoice', out_refund: 'Draft Credit Note', in_invoice: 'Draft Bill', in_refund: 'Draft Refund' }, cancel: { out_invoice: 'Cancelled Invoice', out_refund: 'Cancelled Credit Note', in_invoice: 'Cancelled Bill', in_refund: 'Cancelled Refund' } })[r.state]?.[r.move_type] ?? models['account.move'].form.subtitle(r)), lines: 'invoice_line_ids', info: ['invoice_date', 'invoice_date_due', 'ref', 'invoice_origin', 'payment_reference', 'incoterm_id', 'incoterm_location'], totals: ['amount_untaxed', 'amount_tax', 'amount_total', 'amount_residual'] },
  'sale.order': { title: (r) => t(r.state === 'sale' ? 'Sales Order' : 'Quotation'), lines: 'order_line', info: ['date_order', 'validity_date', 'user'], totals: ['amount_untaxed', 'amount_tax', 'amount_total'] },
  'purchase.order': { title: (r) => t(r.state === 'purchase' ? 'Purchase Order' : 'Request for Quotation'), lines: 'order_line', info: ['date_order', 'date_planned'], totals: ['amount_untaxed', 'amount_tax', 'amount_total'] },
  'hr.payslip': { title: () => t('Payslip'), lines: 'line_ids', info: ['date_from', 'date_to'], totals: ['gross_wage', 'net_wage'], partner: 'employee_id', partnerModel: 'hr.employee' },
};

export const printable = (model) => model in LAYOUTS || model === 'account.batch.payment' || model === 'account.payment' || model === 'audit.report';

export const STUB_LINES_PER_SHEET = 8;

export function splitStubLines(lines, perSheet = STUB_LINES_PER_SHEET) {
  if (!lines || !lines.length) return [[]];
  const pages = [];
  for (let i = 0; i < lines.length; i += perSheet) {
    pages.push(lines.slice(i, i + perSheet));
  }
  return pages;
}

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
      {(batch.lines ?? []).filter((l) => !l.cancelled && l.payment_id && read(db, 'account.payment', l.payment_id)?.state === 'posted').flatMap((l) => {
        const move = read(db, 'account.move', l.move_id);
        const payment = read(db, 'account.payment', l.payment_id);
        const number = payment?.check_number ?? l.check_number;
        let amounts;
        try {
          amounts = checkAmountDisplay(db, payment, move, l.amount);
        } catch (e) {
          amounts = { numeric: t(e.message), words: t(e.message) };
        }
        const journal = (payment?.journal_id ?? batch.journal_id) ? read(db, 'account.journal', payment?.journal_id ?? batch.journal_id) : null;
        const layout = journal?.check_printing_layout || 'top';
        const stubLines = payment
          ? paymentRemittanceLines(db, payment)
          : (move ? [{ move, name: move.name || move.ref || '—', date: move.invoice_date || move.date, original_amount: move.amount_total, paid_amount: l.amount, currency: documentCurrency(db, move) }] : []);
        const totalsByCurrency = [];
        const seenCurrencies = new Map();
        for (const item of stubLines) {
          const curr = item.currency ?? (item.move ? documentCurrency(db, item.move) : null) ?? amounts.currency;
          const key = curr?.id ?? curr?.name ?? 'default';
          if (!seenCurrencies.has(key)) {
            const entry = { currency: curr, total: 0 };
            seenCurrencies.set(key, entry);
            totalsByCurrency.push(entry);
          }
          seenCurrencies.get(key).total += Number(item.paid_amount) || 0;
        }
        if (!totalsByCurrency.length) {
          totalsByCurrency.push({ currency: amounts.currency, total: payment?.amount ?? l.amount ?? 0 });
        }
        const stubPages = splitStubLines(stubLines);

        const checkBody = (isVoid = false) => (
          <section key="check-main" className={`check-main-area${isVoid ? ' void' : ''}`}>
            {isVoid ? (
              <div className="check-void-overlay">
                <header className="paper-head"><b className="paper-company">{company.name}</b><span>{t('Check')} #{number}</span></header>
                <div className="check-void-watermark">{t('VOID')}</div>
                <p>{t('Date')}: {formatDate(batch.date)}</p>
                <footer className="paper-foot muted">{t('VOID - KEEP FOR YOUR RECORDS')}</footer>
              </div>
            ) : (
              <>
                <header className="paper-head"><b className="paper-company">{company.name}</b><span>{t('Check')} #{number}</span></header>
                <p>{t('Date')}: {formatDate(batch.date)}</p>
                <p>{t('Pay to the order of')} <b>{read(db, 'res.partner', payment?.partner_id ?? move?.partner_id)?.name ?? '—'}</b> <span className="num">{amounts.numeric}</span></p>
                <p className="check-words">{amounts.words}</p>
                <footer className="paper-foot muted">{t('Memo')}: {move?.name || payment?.memo}</footer>
              </>
            )}
          </section>
        );

        const stubSection = (pageLines, key = 'remittance-stub') => (
          <section key={key} className="remittance-stub">
            <header className="stub-head"><b>{t('Remittance Advice')}</b></header>
            <table className="paper-lines stub-table">
              <thead>
                <tr>
                  <th>{t('Document')}</th>
                  <th>{t('Date')}</th>
                  <th className="num">{t('Original Amount')}</th>
                  <th className="num">{t('Net Payment')}</th>
                </tr>
              </thead>
              <tbody>
                {pageLines.length ? pageLines.map((item, idx) => {
                  const lineCurrency = item.currency ?? (item.move ? documentCurrency(db, item.move) : null) ?? amounts.currency;
                  return (
                    <tr key={item.move?.id ?? idx}>
                      <td>{item.name}</td>
                      <td>{formatDate(item.date)}</td>
                      <td className="num">{lineCurrency ? formatCurrency(item.original_amount, lineCurrency) : item.original_amount}</td>
                      <td className="num">{lineCurrency ? formatCurrency(item.paid_amount, lineCurrency) : item.paid_amount}</td>
                    </tr>
                  );
                }) : (
                  <tr>
                    <td>{move?.name || payment?.memo || '—'}</td>
                    <td>{formatDate(payment?.date || batch.date)}</td>
                    <td className="num">{amounts.numeric}</td>
                    <td className="num">{amounts.numeric}</td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                {totalsByCurrency.length <= 1 ? (
                  <tr>
                    <td colSpan="3"><b>{t('Net Total')}</b></td>
                    <td className="num"><b>{totalsByCurrency[0]?.currency ? formatCurrency(totalsByCurrency[0].total, totalsByCurrency[0].currency) : totalsByCurrency[0]?.total}</b></td>
                  </tr>
                ) : (
                  totalsByCurrency.map((tb) => (
                    <tr key={tb.currency?.id ?? tb.currency?.name}>
                      <td colSpan="3"><b>{t('Net Total')} ({tb.currency?.name || tb.currency?.symbol || ''})</b></td>
                      <td className="num"><b>{formatCurrency(tb.total, tb.currency)}</b></td>
                    </tr>
                  ))
                )}
              </tfoot>
            </table>
          </section>
        );

        return stubPages.map((pageLines, pageIdx) => {
          const isVoid = pageIdx > 0;
          return (
            <article key={`${number ?? l.move_id}-page-${pageIdx}`} className={`paper check check-layout-${layout}`}>
              {layout === 'bottom' && [stubSection(pageLines, 'stub-top'), checkBody(isVoid)]}
              {layout === 'middle' && [stubSection(pageLines, 'stub-top'), checkBody(isVoid), stubSection(pageLines, 'stub-bottom')]}
              {layout === 'top' && [checkBody(isVoid), stubSection(pageLines, 'stub-bottom')]}
            </article>
          );
        });
      })}
    </main>
  );
}

/** Batch deposit slip for inbound batches. */
function DepositSlip({ db, batch }) {
  const company = documentCompany(db, batch);
  if (!company) return <main className="print-page"><p role="alert">{t('Configure the batch company before printing.')}</p></main>;
  const journal = batch.journal_id ? read(db, 'account.journal', batch.journal_id) : null;
  const { currency, error: currencyError } = batchCurrency(db, batch);
  const lines = (batch.lines ?? []).filter((l) => !l.cancelled);
  const totalAmount = lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
  const formattedTotal = currencyError ? t(currencyError) : (currency ? formatCurrency(totalAmount, currency) : totalAmount);

  return (
    <main className="print-page">
      <div className="no-print print-toolbar">
        <button type="button" className="btn primary" onClick={() => window.print()}>{t('Print')}</button>
        <button type="button" className="btn" onClick={() => history.back()}>{t('Back')}</button>
      </div>
      <article className="paper deposit-slip">
        <header className="paper-head">
          <div>
            <b className="paper-company">{company.name}</b>
            {addressLines(company, t('Tax ID')).map((line, i) => <div key={`${i}-${line}`} className="muted">{line}</div>)}
          </div>
          <div>
            <h1>{t('Batch Deposit')}</h1>
            <p><b>{batch.name}</b></p>
          </div>
        </header>
        <dl className="paper-info">
          <div><dt>{t('Date')}</dt><dd>{formatDate(batch.date)}</dd></div>
          <div><dt>{t('Bank Journal')}</dt><dd>{journal?.name ?? '—'}</dd></div>
          <div><dt>{t('Number of Items')}</dt><dd>{lines.length}</dd></div>
          <div><dt>{t('Total Amount')}</dt><dd>{formattedTotal}</dd></div>
        </dl>
        <table className="paper-lines">
          <thead>
            <tr>
              <th>{t('Date')}</th>
              <th>{t('Customer')}</th>
              <th>{t('Payment Reference')}</th>
              <th className="num">{t('Amount')}</th>
            </tr>
          </thead>
          <tbody>
            {!lines.length ? (
              <tr><td colSpan={4} className="empty">{t('No payment lines in this batch.')}</td></tr>
            ) : lines.map((l, index) => {
              const payment = l.payment_id ? read(db, 'account.payment', l.payment_id) : null;
              const move = l.move_id ? read(db, 'account.move', l.move_id) : null;
              const partner = read(db, 'res.partner', payment?.partner_id ?? move?.partner_id);
              const date = payment?.date ?? move?.invoice_date ?? batch.date;
              const ref = payment?.memo || payment?.name || move?.name || '—';
              const lineCurrency = (payment ? documentCurrency(db, payment) : null) ?? (move ? documentCurrency(db, move) : null) ?? currency;
              return (
                <tr key={l.payment_id ?? l.move_id ?? index}>
                  <td>{formatDate(date)}</td>
                  <td>{partner?.name ?? '—'}</td>
                  <td>{ref}</td>
                  <td className="num">{lineCurrency ? formatCurrency(Number(l.amount) || 0, lineCurrency) : Number(l.amount) || 0}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}><b>{t('Total')}</b></td>
              <td className="num"><b>{formattedTotal}</b></td>
            </tr>
          </tfoot>
        </table>
      </article>
    </main>
  );
}

function printCell(db, model, k, f, l, rec) {
  if (model === 'account.move' && (k === 'tax_id' || k === 'tax_ids')) {
    if (Array.isArray(l.tax_ids) && l.tax_ids.length > 1 && Array.isArray(l.tax_breakdown) && l.tax_breakdown.length) {
      return l.tax_breakdown.map((t) => taxInvoiceLabel(t)).join(', ');
    }
    if (l.tax_invoice_label) return l.tax_invoice_label;
    if (l.tax_name) return l.tax_name;
  }
  const value = f.valueFallback && !(l[k]?.length) ? f.valueFallback(l) : l[k];
  return display(db, f, value, { ...l, company_id: l.company_id ?? rec.company_id, currency_id: l.currency_id ?? rec.currency_id });
}

/** Paper-style document rendered from the record, then the browser print dialog (Save as PDF). */
export function PrintDoc({ model, id }) {
  const db = useDb();
  const def = models[model];
  const layout = LAYOUTS[model];
  const rec = read(db, model, Number(id));
  const recId = rec?.id;
  const isDraftInboundBatch = Boolean(rec && model === 'account.batch.payment' && rec.batch_type === 'inbound' && rec.state !== 'posted');
  useEffect(() => {
    if (!recId || isDraftInboundBatch) return undefined;
    const timer = setTimeout(() => window.print(), 300);
    return () => clearTimeout(timer);
  }, [recId, isDraftInboundBatch]);
  if (rec && model === 'account.batch.payment') {
    if (rec.batch_type === 'inbound') {
      if (rec.state !== 'posted') {
        return (
          <main className="action">
            <p className="empty" role="alert">{t('Deposit slips can only be printed for posted batch payments.')}</p>
          </main>
        );
      }
      return <DepositSlip db={db} batch={rec} />;
    }
    return <Checks db={db} batch={rec} />;
  }
  if (rec && model === 'account.payment' && rec.state === 'posted' && rec.payment_type === 'outbound' && rec.check_number != null) {
    const batch = { company_id: rec.company_id, date: rec.date, lines: [{ move_id: rec.invoice_id, payment_id: rec.id, amount: rec.amount }] };
    return <Checks db={db} batch={batch} />;
  }
  if (rec && model === 'audit.report') {
    const company = documentCompany(db, rec);
    if (!company) return <main className="action"><p className="empty" role="alert">{t('Configure the document company before printing.')}</p></main>;
    return (
      <ReportPrintView
        company={company}
        title={rec.title}
        subtitle={`${rec.start_date} → ${rec.end_date}`}
        autoPrint={false}
      >
        <div className="annual-report-body"><SafeHtml html={rec.body} /></div>
      </ReportPrintView>
    );
  }
  if (!rec || !layout) return <main className="action"><p className="empty">{t('Record not found.')}</p></main>;

  const company = documentCompany(db, rec);
  if (!company) return <main className="action"><p className="empty" role="alert">{t('Configure the document company before printing.')}</p></main>;
  const qrSettings = invoiceQrSettingsForCompany(db, company);

  const partner = read(db, layout.partnerModel ?? 'res.partner', rec[layout.partner ?? 'partner_id']);
  const taxBreakdown = model === 'account.move' ? documentTaxBreakdown(db, rec, rec[layout.lines] ?? []) : [];
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
          <div>
            <b className="paper-company">{company.name}</b>
            {addressLines(company, t('Tax ID')).map((line, i) => <div key={`${i}-${line}`} className="muted">{line}</div>)}
            <div className="muted">{company.currency ?? t('Company currency is not configured')}</div>
          </div>
          {partner && (
            <address>
              <b>{partner.name}</b>
              {[partner.email ?? partner.work_email, partner.phone ?? partner.work_phone].filter(Boolean).map((l) => <div key={l}>{l}</div>)}
              {addressLines(partner, t('Tax ID')).map((line, i) => <div key={`${i}-${line}`}>{line}</div>)}
            </address>
          )}
        </header>
        <h1>{layout.title(rec)} {rec.name && rec.name !== '/' && !(model === 'account.move' && rec.state === 'draft' && ['out_invoice', 'out_refund', 'in_invoice', 'in_refund'].includes(rec.move_type)) ? rec.name : ''}</h1>
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
                {cols.map(([k, f]) => <td key={k} className={['monetary', 'float'].includes(f.type) ? 'num' : ''}>{printCell(db, model, k, f, l, rec)}</td>)}
                {priced && <td className="num">{display(db, { type: 'monetary' }, subtotal(l), rec)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
        {model === 'account.move' && taxBreakdown.length > 0 && (
          <table className="paper-lines paper-taxes">
            <thead><tr><th>{t('Tax')}</th><th className="num">{t('Base')}</th><th className="num">{t('Amount')}</th></tr></thead>
            <tbody>
              {taxBreakdown.map((row, i) => (
                <tr key={i}>
                  <td>{row.label}</td>
                  <td className="num">{display(db, { type: 'monetary' }, row.base, rec)}</td>
                  <td className="num">{display(db, { type: 'monetary' }, row.amount, rec)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <dl className="totals paper-totals">
          {(() => {
            const taxTotals = model === 'account.move' ? invoiceTaxTotals(db, rec) : null;
            if (!taxTotals) {
              return layout.totals.map((f) => (
                <div key={f} className={f === 'amount_total' || f === 'net_wage' ? 'grand' : ''}><dt>{t(def.fields[f].label)}</dt><dd>{display(db, def.fields[f], rec[f], rec)}</dd></div>
              ));
            }
            const hasTaxGroups = taxTotals.subtotals.some((s) => s.groups.length > 0);
            return (
              <>
                {taxTotals.subtotals.map((sub, si) => (
                  <Fragment key={`sub-${si}`}>
                    <div><dt>{t(sub.name)}</dt><dd>{display(db, { type: 'monetary' }, sub.amount, rec)}</dd></div>
                    {sub.groups.map((g) => (
                      <div key={`grp-${g.tax_group_id ?? 'none'}`}><dt>{g.tax_group_id ? g.name : t(g.name)}</dt><dd>{display(db, { type: 'monetary' }, g.amount, rec)}</dd></div>
                    ))}
                  </Fragment>
                ))}
                {!hasTaxGroups && <div><dt>{t(def.fields.amount_tax.label)}</dt><dd>{display(db, def.fields.amount_tax, rec.amount_tax, rec)}</dd></div>}
                {taxTotals.rounding_amount !== 0 && <div><dt>{t('Cash Rounding')}</dt><dd>{display(db, { type: 'monetary' }, taxTotals.rounding_amount, rec)}</dd></div>}
                {layout.totals.filter((f) => !['amount_untaxed', 'amount_tax'].includes(f)).map((f) => (
                  <div key={f} className={f === 'amount_total' || f === 'net_wage' ? 'grand' : ''}><dt>{t(def.fields[f].label)}</dt><dd>{display(db, def.fields[f], rec[f], rec)}</dd></div>
                ))}
              </>
            );
          })()}
        </dl>
        {model === 'account.move' && <PaymentQr db={db} company={company} settings={qrSettings} move={rec} />}
        {model === 'account.move' && (() => {
          const term = rec.invoice_payment_term_id && read(db, 'account.payment.term', rec.invoice_payment_term_id);
          const note = invoiceTermNote(db, rec) && <p className="paper-note">{invoiceTermNote(db, rec)}</p>;
          if (!term?.display_on_invoice) return note;
          const currency = documentCurrency(db, rec);
          const rows = rec.state === 'posted'
            ? invoiceInstallments(db, rec, term)
            : !termScheduleError(term, rec.amount_total, currency) && !dueTermLinesError(term)
              ? installments(term, rec.amount_total, validDate(rec.invoice_date) ? rec.invoice_date : today(), currency)
              : null;
          if (!rows?.length) return note;
          return <>{note}<table><thead><tr><th>{t('Due Date')}</th><th>{t('Amount')}</th></tr></thead><tbody>{rows.map((row, index) => <tr key={index}><td>{formatDate(row.date)}</td><td className="num">{formatCurrency(row.amount, currency)}</td></tr>)}</tbody></table></>;
        })()}
        {rec.narration && <p className="paper-note">{rec.narration}</p>}
        <footer className="paper-foot muted">{company.name} · {t('Generated by Mizan')}</footer>
      </article>
    </main>
  );
}
