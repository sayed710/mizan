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
    ? items.map((r) => `<tr><td>${escapeHtml(r.account?.code ?? '')} ${escapeHtml(r.account?.name ?? '')}</td><td style="text-align: right;">${formatMoney(r.balance)}</td></tr>`).join('\n')
    : '<tr><td colspan="2" style="color: #666; font-style: italic;">No items</td></tr>');

  return `<div class="annual-report-body">
  <h2>Balance Sheet</h2>
  <table class="table report-table balance-sheet-table" border="1" cellpadding="6" cellspacing="0" style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
    <thead>
      <tr style="background: #f8fafc;">
        <th style="text-align: left;">Account</th>
        <th style="text-align: right;">Balance</th>
      </tr>
    </thead>
    <tbody>
      <tr style="background: #f1f5f9;"><td colspan="2"><strong>Assets</strong></td></tr>
      ${renderRows(bs.assets)}
      <tr style="font-weight: bold; background: #e2e8f0;"><td>Total Assets</td><td style="text-align: right;">${formatMoney(bs.totalAssets)}</td></tr>
      <tr style="background: #f1f5f9;"><td colspan="2"><strong>Liabilities</strong></td></tr>
      ${renderRows(bs.liabilities)}
      <tr style="font-weight: bold; background: #e2e8f0;"><td>Total Liabilities</td><td style="text-align: right;">${formatMoney(bs.totalLiabilities)}</td></tr>
      <tr style="background: #f1f5f9;"><td colspan="2"><strong>Equity</strong></td></tr>
      ${renderRows(bs.equity)}
      <tr><td>Current Year Earnings</td><td style="text-align: right;">${formatMoney(bs.earnings)}</td></tr>
      <tr style="font-weight: bold; background: #e2e8f0;"><td>Total Equity</td><td style="text-align: right;">${formatMoney(bs.totalEquity)}</td></tr>
      <tr style="font-weight: bold; background: #cbd5e1;"><td>Total Liabilities &amp; Equity</td><td style="text-align: right;">${formatMoney(round(bs.totalLiabilities + bs.totalEquity))}</td></tr>
    </tbody>
  </table>

  <h2>Profit and Loss</h2>
  <table class="table report-table pnl-table" border="1" cellpadding="6" cellspacing="0" style="width: 100%; border-collapse: collapse;">
    <thead>
      <tr style="background: #f8fafc;">
        <th style="text-align: left;">Account</th>
        <th style="text-align: right;">Total</th>
      </tr>
    </thead>
    <tbody>
      <tr style="background: #f1f5f9;"><td colspan="2"><strong>Income</strong></td></tr>
      ${renderRows(pnl.detail.revenue)}
      <tr style="font-weight: bold; background: #e2e8f0;"><td>Total Income</td><td style="text-align: right;">${formatMoney(pnl.revenue)}</td></tr>
      <tr style="background: #f1f5f9;"><td colspan="2"><strong>Cost of Goods Sold</strong></td></tr>
      ${renderRows(pnl.detail.cost)}
      <tr style="font-weight: bold; background: #e2e8f0;"><td>Gross Profit</td><td style="text-align: right;">${formatMoney(pnl.gross)}</td></tr>
      <tr style="background: #f1f5f9;"><td colspan="2"><strong>Expenses</strong></td></tr>
      ${renderRows(pnl.detail.expense)}
      <tr style="font-weight: bold; background: #e2e8f0;"><td>Total Expenses</td><td style="text-align: right;">${formatMoney(pnl.expense)}</td></tr>
      <tr style="font-weight: bold; background: #e2e8f0;"><td>Net Operating Income</td><td style="text-align: right;">${formatMoney(pnl.operating)}</td></tr>
      <tr style="font-weight: bold; background: #cbd5e1;"><td>Net Income</td><td style="text-align: right;">${formatMoney(pnl.net)}</td></tr>
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
