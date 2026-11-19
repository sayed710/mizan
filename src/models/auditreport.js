// Annual Report model and body generation (Odoo parity).
import { read, write } from '../orm.js';
import { today } from './common.js';
import { configurableReport, findStatementReport } from './configurableReports.js';
import { currentCompany } from './company.js';
import { t } from '../i18n.js';

function formatMoney(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Render HTML tables for Balance Sheet and Profit and Loss scoped to the given period and company. */
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const COLUMN_LABELS = { balance: 'Balance', debit: 'Debit', credit: 'Credit' };

const accountKey = (acc) => acc.account?.id ?? acc.account?.code ?? acc.account?.name;

function descendantAccountKeys(rows, index) {
  const parentDepth = Number(rows[index]?.depth) || 0;
  const keys = new Set();
  for (let j = index + 1; j < rows.length && (Number(rows[j].depth) || 0) > parentDepth; j += 1) {
    for (const acc of rows[j].accountRows ?? []) {
      const key = accountKey(acc);
      if (key != null) keys.add(key);
    }
  }
  return keys;
}

function renderReportTable(title, reportData, tableClass, valueHeader) {
  const columns = reportData.columns?.length ? reportData.columns : ['balance'];
  const headers = columns.map((col) => (columns.length === 1 && col === 'balance' ? valueHeader : COLUMN_LABELS[col] ?? col));
  const colCount = 1 + columns.length;
  const valueCells = (values) => columns
    .map((_, idx) => `<td class="text-right">${formatMoney(values?.[idx] ?? 0)}</td>`)
    .join('');

  const rows = reportData.rows || [];
  const bodyRows = rows.map((r, index) => {
    const depth = Math.max(0, Number(r.depth) || 0);
    const isLastStrong = Boolean(r.strong && index === rows.length - 1);
    const totalClass = isLastStrong ? 'grand-total-row' : (r.strong ? 'total-row' : '');
    const childKeys = descendantAccountKeys(rows, index);
    const visibleAccounts = (r.accountRows ?? []).filter((acc) => !childKeys.has(accountKey(acc)));
    if (visibleAccounts.length > 0) {
      const accRows = visibleAccounts.map((acc) =>
        `      <tr><td class="depth-${depth + 1}">${escapeHtml(acc.account?.code ?? '')} ${escapeHtml(acc.account?.name ?? '')}</td>${valueCells(acc.values)}</tr>`
      ).join('\n');
      const totClass = totalClass || 'total-row';
      return `      <tr class="section-header"><td colspan="${colCount}" class="depth-${depth}"><strong>${escapeHtml(t(r.name ?? ''))}</strong></td></tr>\n${accRows}\n      <tr class="${totClass}"><td class="depth-${depth}">${escapeHtml(t(r.name ?? ''))}</td>${valueCells(r.values)}</tr>`;
    }
    return `      <tr${totalClass ? ` class="${totalClass}"` : ''}><td class="depth-${depth}">${escapeHtml(t(r.name ?? ''))}</td>${valueCells(r.values)}</tr>`;
  }).join('\n');

  const headerCells = headers.map((h) => `<th class="text-right">${escapeHtml(t(h))}</th>`).join('\n        ');

  return `  <h2>${escapeHtml(t(title))}</h2>
  <table class="report-table ${tableClass}">
    <thead>
      <tr>
        <th class="text-left">${escapeHtml(t('Account'))}</th>
        ${headerCells}
      </tr>
    </thead>
    <tbody>
${bodyRows}
    </tbody>
  </table>`;
}

export function renderAnnualReportHtml(db, { start_date, end_date, company_id }) {
  const company = company_id ?? (db ? currentCompany(db) : 1);
  const from = start_date || `${today().slice(0, 4)}-01-01`;
  const to = end_date || `${today().slice(0, 4)}-12-31`;

  const bsReport = findStatementReport(db, 'balance', company);
  if (!bsReport) throw new Error('Configure the Balance Sheet report for this company');
  const pnlReport = findStatementReport(db, 'pnl', company);
  if (!pnlReport) throw new Error('Configure the Profit and Loss report for this company');

  const bsData = configurableReport(db, bsReport, { to }, null, { companyId: company });
  const pnlData = configurableReport(db, pnlReport, { from, to }, null, { companyId: company });

  const bsHtml = renderReportTable(bsReport.name || 'Balance Sheet', bsData, 'balance-sheet-table', 'Balance');
  const pnlHtml = renderReportTable(pnlReport.name || 'Profit and Loss', pnlData, 'pnl-table', 'Total');

  return `<div class="annual-report-body">\n${bsHtml}\n\n${pnlHtml}\n</div>`;
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
      title: `${t('Annual Report')} ${today().slice(0, 4)}`,
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
