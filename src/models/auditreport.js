// Annual Report model and body generation (Odoo parity).
import { read, write } from '../orm.js';
import { round } from '../money.js';
import { today } from './common.js';
import { balanceSheet, profitAndLoss } from './ledger.js';
import { currentCompany } from './company.js';

function formatMoney(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Render HTML tables for Balance Sheet and Profit and Loss scoped to the given period and company. */
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderAnnualReportHtml(db, { start_date, end_date, company_id }) {
  const company = company_id ?? 1;
  const from = start_date || `${today().slice(0, 4)}-01-01`;
  const to = end_date || `${today().slice(0, 4)}-12-31`;

  const pnl = profitAndLoss(db, { from, to, company_id: company });
  const bs = balanceSheet(db, { to, company_id: company });

  const renderRows = (items) => (items && items.length > 0
    ? items.map((r) => `<tr><td>${escapeHtml(r.account?.code ?? '')} ${escapeHtml(r.account?.name ?? '')}</td><td class="text-right">${formatMoney(r.balance)}</td></tr>`).join('\n')
    : '<tr><td colspan="2" class="empty-row">No items</td></tr>');

  return `<div class="annual-report-body">
  <h2>Balance Sheet</h2>
  <table class="report-table balance-sheet-table">
    <thead>
      <tr>
        <th class="text-left">Account</th>
        <th class="text-right">Balance</th>
      </tr>
    </thead>
    <tbody>
      <tr class="section-header"><td colspan="2"><strong>Assets</strong></td></tr>
      ${renderRows(bs.assets)}
      <tr class="total-row"><td>Total Assets</td><td class="text-right">${formatMoney(bs.totalAssets)}</td></tr>
      <tr class="section-header"><td colspan="2"><strong>Liabilities</strong></td></tr>
      ${renderRows(bs.liabilities)}
      <tr class="total-row"><td>Total Liabilities</td><td class="text-right">${formatMoney(bs.totalLiabilities)}</td></tr>
      <tr class="section-header"><td colspan="2"><strong>Equity</strong></td></tr>
      ${renderRows(bs.equity)}
      <tr><td>Current Year Earnings</td><td class="text-right">${formatMoney(bs.earnings)}</td></tr>
      <tr class="total-row"><td>Total Equity</td><td class="text-right">${formatMoney(bs.totalEquity)}</td></tr>
      <tr class="grand-total-row"><td>Total Liabilities &amp; Equity</td><td class="text-right">${formatMoney(round(bs.totalLiabilities + bs.totalEquity))}</td></tr>
    </tbody>
  </table>

  <h2>Profit and Loss</h2>
  <table class="report-table pnl-table">
    <thead>
      <tr>
        <th class="text-left">Account</th>
        <th class="text-right">Total</th>
      </tr>
    </thead>
    <tbody>
      <tr class="section-header"><td colspan="2"><strong>Income</strong></td></tr>
      ${renderRows(pnl.detail.revenue)}
      <tr class="total-row"><td>Total Income</td><td class="text-right">${formatMoney(pnl.revenue)}</td></tr>
      <tr class="section-header"><td colspan="2"><strong>Cost of Goods Sold</strong></td></tr>
      ${renderRows(pnl.detail.cost)}
      <tr class="total-row"><td>Gross Profit</td><td class="text-right">${formatMoney(pnl.gross)}</td></tr>
      <tr class="section-header"><td colspan="2"><strong>Expenses</strong></td></tr>
      ${renderRows(pnl.detail.expense)}
      <tr class="total-row"><td>Total Expenses</td><td class="text-right">${formatMoney(pnl.expense)}</td></tr>
      <tr class="total-row"><td>Net Operating Income</td><td class="text-right">${formatMoney(pnl.operating)}</td></tr>
      <tr class="section-header"><td colspan="2"><strong>Other Income</strong></td></tr>
      ${renderRows(pnl.detail.otherIncome)}
      <tr class="total-row"><td>Total Other Income</td><td class="text-right">${formatMoney(pnl.otherIncome)}</td></tr>
      <tr class="section-header"><td colspan="2"><strong>Other Expenses</strong></td></tr>
      ${renderRows(pnl.detail.otherExpense)}
      <tr class="total-row"><td>Total Other Expenses</td><td class="text-right">${formatMoney(pnl.otherExpense)}</td></tr>
      <tr class="grand-total-row"><td>Net Income</td><td class="text-right">${formatMoney(pnl.net)}</td></tr>
    </tbody>
  </table>
</div>`;
}

export const auditReportModels = {
  'audit.report': {
    label: 'Annual Report',
    fields: {
      title: { type: 'char', label: 'Title', required: true },
      start_date: { type: 'date', label: 'Start Date', required: true },
      end_date: { type: 'date', label: 'End Date', required: true },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company', required: true },
      responsible_user_ids: { type: 'many2many', relation: 'hr.employee', label: 'Responsible Users' },
      status: {
        type: 'selection',
        label: 'Status',
        tracking: true,
        options: [
          ['draft', 'Draft'],
          ['done', 'Done'],
        ],
      },
      body: { type: 'html', label: 'Body' },
    },
    defaults: (id, db) => ({
      title: `Annual Report ${today().slice(0, 4)}`,
      start_date: `${today().slice(0, 4)}-01-01`,
      end_date: `${today().slice(0, 4)}-12-31`,
      status: 'draft',
      responsible_user_ids: [],
      company_id: db ? currentCompany(db) : 1,
    }),
    createDefaults: (db, vals) => {
      const companyId = vals?.company_id ?? (db ? currentCompany(db) : 1);
      const startDate = vals?.start_date || `${today().slice(0, 4)}-01-01`;
      const endDate = vals?.end_date || `${today().slice(0, 4)}-12-31`;
      const body = vals?.body ?? renderAnnualReportHtml(db, { start_date: startDate, end_date: endDate, company_id: companyId });
      return {
        start_date: startDate,
        end_date: endDate,
        company_id: companyId,
        status: vals?.status ?? 'draft',
        body,
      };
    },
    guard: (db, before, after) => {
      if (before?.status === 'done' && after.status === 'done') {
        const LOCKED = ['title', 'start_date', 'end_date', 'company_id', 'responsible_user_ids', 'body'];
        if (LOCKED.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))) {
          return 'Done reports are read-only';
        }
      }
      if (!['draft', 'done'].includes(after.status)) {
        return 'Invalid status for annual report';
      }
      if (after.start_date && after.end_date && after.start_date > after.end_date) {
        return 'Start date must be before or equal to end date';
      }
      return null;
    },
    list: ['title', 'start_date', 'end_date', 'company_id', 'status'],
    kanban: { title: 'title', lines: ['start_date', 'end_date', 'company_id'], badge: 'status' },
    filters: [
      [
        { id: 'draft', label: 'Draft', fn: (r) => r.status === 'draft' },
        { id: 'done', label: 'Done', fn: (r) => r.status === 'done' },
      ],
    ],
    form: {
      statusbar: 'status',
      statusbarClickable: false,
      lockedWhen: (r) => r.status === 'done',
      title: 'title',
      groups: [
        ['start_date', 'end_date', 'company_id'],
        ['status', 'responsible_user_ids'],
      ],
      tabs: [
        {
          label: 'Report',
          fields: ['body'],
        },
      ],
      buttons: [
        {
          label: 'Refresh',
          when: (r) => r.status === 'draft',
          run: (db, r) => {
            const currentReport = read(db, 'audit.report', r.id) ?? r;
            const body = renderAnnualReportHtml(db, {
              start_date: currentReport.start_date,
              end_date: currentReport.end_date,
              company_id: currentReport.company_id ?? 1,
            });
            return { db: write(db, 'audit.report', r.id, { body }) };
          },
        },
        {
          label: 'Mark as Done',
          primary: true,
          when: (r) => r.status === 'draft',
          run: (db, r) => ({ db: write(db, 'audit.report', r.id, { status: 'done' }) }),
        },
        {
          label: 'Reset to Draft',
          when: (r) => r.status === 'done',
          run: (db, r) => ({ db: write(db, 'audit.report', r.id, { status: 'draft' }) }),
        },
      ],
      chatter: true,
    },
  },
};
