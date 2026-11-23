import { Fragment, useMemo, useRef, useState } from 'react';
import { read } from '../orm.js';
import { viewRecords } from '../companyView.js';
import { useDb } from '../store.js';
import { t } from '../i18n.js';
import { round } from '../money.js';
import { lineUntaxed } from '../models/taxes.js';
import { qtyToInvoice } from '../models/sales.js';
import { today } from '../models/common.js';
import { currentCompany, documentCompany } from '../models/company.js';
import { CompanySelect, reportCompanyScope, reportMoney } from './reportCompany.jsx';
import { DEFAULT_REPORT_PERIOD, PERIODS } from './reportNavigation.js';
import { downloadCsv, tableToRows } from '../csv.js';
import { downloadXlsx } from '../xlsx.js';
import { ReportPrintView } from './FinancialReportPrint.jsx';

/** Compare the recorded delivery and invoice quantities on each sales line. */
export function SalesReview({ leaf }) {
  const sourceDb = useDb();
  const tableRef = useRef(null);
  const deliveredFirst = leaf.report === 'invoicesToBeIssued';

  const [companyId, setCompanyId] = useState('all');
  const { companyDb, companies, selectedCompany } = useMemo(
    () => reportCompanyScope(sourceDb, companyId, { allowAll: true }),
    [sourceDb, companyId],
  );
  const fmtMoney = useMemo(() => reportMoney(companyDb, selectedCompany), [companyDb, selectedCompany]);

  const [periodKey, setPeriodKey] = useState(DEFAULT_REPORT_PERIOD);
  const [customPeriod, setCustomPeriod] = useState({ from: `${today().slice(0, 4)}-01-01`, to: today() });
  const period = periodKey === 'custom' ? customPeriod : (PERIODS[periodKey]?.() ?? PERIODS.all());

  const [groupBy, setGroupBy] = useState('');
  const [isPrinting, setIsPrinting] = useState(false);

  const rows = useMemo(() => {
    return viewRecords(companyDb, 'sale.order').flatMap((order) => {
      // Matching Odoo's sale.order.line list domains: only confirmed sales orders (state in ('sale', 'done'))
      if (!['sale', 'done'].includes(order.state)) return [];
      const orderCompanyId = order.company_id ?? 1;
      if (selectedCompany !== 'all' && orderCompanyId !== Number(selectedCompany)) return [];

      const rawDate = order.date_order ?? order.create_date;
      const orderDate = rawDate ? String(rawDate).slice(0, 10) : null;
      if (periodKey !== 'all') {
        if (!orderDate) return [];
        if (period.from && orderDate < period.from) return [];
        if (period.to && orderDate > period.to) return [];
      }

      return (order.order_line ?? []).flatMap((line, index) => {
        if (line.down_payment_key || line.is_downpayment || line.display_type) return [];
        const delivered = Number(line.qty_delivered) || 0;
        const invoiced = Number(line.qty_invoiced) || 0;
        const difference = deliveredFirst ? qtyToInvoice(companyDb, line) : invoiced - delivered;
        if (difference <= 0) return [];
        const unitPrice = Number(line.price_unit) || 0;
        const amount = round(lineUntaxed({ ...line, qty: difference }));
        const partner = read(companyDb, 'res.partner', order.partner_id);
        const product = read(companyDb, 'product', line.product_id);
        return [{ order, line, index, delivered, invoiced, difference, unitPrice, amount, partner, product }];
      });
    });
  }, [companyDb, deliveredFirst, selectedCompany, period, periodKey]);

  const groups = useMemo(() => {
    if (!groupBy) return null;
    const map = new Map();
    for (const row of rows) {
      const key = groupBy === 'customer'
        ? (row.order.partner_id ?? 'unknown')
        : row.order.id;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    return map;
  }, [rows, groupBy]);

  const exportCsv = () => {
    if (!tableRef.current) return;
    const rawRows = tableToRows(tableRef.current);
    const colCount = 9;
    const csvRows = rawRows.map((row) => (
      row.length < colCount ? [...row, ...Array(colCount - row.length).fill('')] : row
    ));
    downloadCsv(`${leaf.report || 'sales_review'}.csv`, csvRows);
  };

  const exportXlsx = () => {
    if (!tableRef.current) return;
    const columnTypes = ['text', 'text', 'text', 'text', 'quantity', 'quantity', 'quantity', 'number', 'number'];
    downloadXlsx(`${leaf.report || 'sales_review'}.xlsx`, tableRef.current, { sheetName: t(leaf.label), columnTypes });
  };

  const activeCompanyId = selectedCompany === 'all' ? currentCompany(companyDb) : Number(selectedCompany);
  const printCompany = isPrinting ? documentCompany(companyDb, { company_id: activeCompanyId }) : null;
  const printCompanies = isPrinting
    ? (selectedCompany === 'all'
        ? companies.map((c) => documentCompany(companyDb, { company_id: c.id }) || c)
        : (printCompany ? [printCompany] : []))
    : null;
  const subtitle = period.from ? `${period.from} → ${period.to}` : `≤ ${period.to}`;

  const renderRow = ({ order, line, index, delivered, invoiced, difference, unitPrice, amount, partner, product }) => (
    <tr key={`${order.id}-${index}`}>
      <td><a href={`#/sales/orders/${order.id}`}>{order.name}</a></td>
      <td>{partner?.name ?? ''}</td>
      <td>{product?.name ?? ''}</td>
      <td>{line.name}</td>
      <td className="num qty">{delivered}</td>
      <td className="num qty">{invoiced}</td>
      <td className="num qty">{Number(difference.toPrecision(12))}</td>
      <td className="num">{fmtMoney(unitPrice)}</td>
      <td className="num">{fmtMoney(amount)}</td>
    </tr>
  );

  const controls = (
    <div className="control-panel">
      <h1 className="cp-title">{t(leaf.label)}</h1>
      <label className="inline-select">
        {t('Period')}
        <select aria-label={t('Period')} value={periodKey} onChange={(e) => setPeriodKey(e.target.value)}>
          <option value="month">{t('This Month')}</option>
          <option value="quarter">{t('This Quarter')}</option>
          <option value="year">{t('This Year')}</option>
          <option value="all">{t('All Dates')}</option>
          <option value="custom">{t('Custom Period')}</option>
        </select>
      </label>
      {periodKey === 'custom' && <>
        <label>{t('From')}<input aria-label={t('From')} type="date" value={customPeriod.from} onChange={(e) => setCustomPeriod({ ...customPeriod, from: e.target.value })} /></label>
        <label>{t('To')}<input aria-label={t('To')} type="date" value={customPeriod.to} onChange={(e) => setCustomPeriod({ ...customPeriod, to: e.target.value })} /></label>
      </>}
      {companies.length > 1 && (
        <CompanySelect companies={companies} value={selectedCompany} onChange={setCompanyId} allowAll={true} />
      )}
      <label className="inline-select">
        {t('Group By')}
        <select aria-label={t('Group By')} value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
          <option value="">{t('None')}</option>
          <option value="customer">{t('Customer')}</option>
          <option value="order">{t('Order')}</option>
        </select>
      </label>
      <span className="muted">{subtitle}</span>
      <span className="spacer" />
      <button type="button" className="btn sm" onClick={() => setIsPrinting(true)}>{t('Print')}</button>
      <button type="button" className="btn sm" onClick={exportCsv}>{t('Download CSV')}</button>
      <button type="button" className="btn sm" onClick={exportXlsx}>{t('Export XLSX')}</button>
    </div>
  );

  return (
    <ReportPrintView
      active={isPrinting}
      company={printCompany}
      companies={printCompanies}
      title={t(leaf.label)}
      subtitle={subtitle}
      controls={controls}
      onBack={() => setIsPrinting(false)}
    >
      <div className="list-wrap"><table className="list report" ref={tableRef}>
        <thead><tr>{['Order', 'Customer', 'Product', 'Description', 'Delivered', 'Invoiced', 'Difference', 'Unit Price', 'Amount'].map((label, i) => <th key={label} className={i >= 4 ? 'num' : undefined}>{t(label)}</th>)}</tr></thead>
        <tbody>
          {groups ? (
            [...groups.entries()].map(([key, groupRows]) => {
              const first = groupRows[0];
              const groupTitle = groupBy === 'customer'
                ? (first.partner?.name ?? t('Undefined'))
                : `${first.order.name}${first.partner?.name ? ` — ${first.partner.name}` : ''}`;
              return (
                <Fragment key={String(key)}>
                  <tr className="group-row"><td colSpan={9}><strong>{groupTitle}</strong> <span className="count">({groupRows.length})</span></td></tr>
                  {groupRows.map(renderRow)}
                </Fragment>
              );
            })
          ) : (
            rows.map(renderRow)
          )}
          {!rows.length && (
            <tr><td colSpan={9} className="muted">{t('No records found.')}</td></tr>
          )}
        </tbody>
      </table></div>
    </ReportPrintView>
  );
}
