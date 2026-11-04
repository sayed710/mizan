// Read-only analyses for records and apps. Each entry calls an existing model function; the UI renders whatever
// rows or totals it returns (FormView's "Analysis" section and the 'analysis' menu page).
import { read, search } from '../orm.js';
import { addDays, today } from './common.js';
import { analyticBalance } from './analyticplus.js';
import { appraisalAnalysis, goalProgress } from './appraisalplus.js';
import { pendingFor } from './approvalsplus.js';
import { workedDaysForPayslip } from './attendanceplus.js';
import { stepStats } from './automation.js';
import { packageContents } from './batch.js';
import { matchBill } from './billcontrol.js';
import { overdueRequests } from './documentsplus.js';
import { eventDashboard } from './eventsplus.js';
import { expenseAnalysis } from './expenseplus.js';
import { contractsToRenew, fuelEfficiency, servicesDue, vehicleCosts } from './fleetplus.js';
import { visitorReport } from './frontdeskplus.js';
import { planTasks, technicianLoad } from './fsm.js';
import { teamStats } from './helpdesk.js';
import { activeAlerts, vendorSummary } from './lunch.js';
import { calendarLoad, equipmentStats } from './maintplus.js';
import { tableStatus, zReport } from './posplus.js';
import { qualityStats } from './qualityplus.js';
import { applicantScore, duplicateApplicants, jobPipeline } from './recruitplus.js';
import { bestPrice, rentalHours, rentalSchedule } from './rentalplus.js';
import { repairAnalysis, repairTotal } from './repairplus.js';
import { customerStatement } from './reports.js';
import { certificationsExpiring, employeesWithSkill, points, skillMatrix } from './skillsplus.js';
import { employeeUtilization, weeklyGrid } from './timesheetplus.js';
import { packagingSuggestion } from './uom.js';
import { warehouseQty } from './warehouse.js';
import { workcenterLoad } from './workorder.js';

const monthOf = (d = today()) => {
  const [y, m] = d.split('-').map(Number);
  return { from: `${d.slice(0, 7)}-01`, to: `${d.slice(0, 7)}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}` };
};
const yearOf = (d = today()) => ({ from: `${d.slice(0, 4)}-01-01`, to: `${d.slice(0, 4)}-12-31` });
const monday = (d = today()) => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
const boundedPeriod = ({ from, to }) => ({ from: from || '0001-01-01', to: to || '9999-12-31' });

/** Per model: analyses shown on its form. `when` limits them to some records. */
export const recordAnalyses = {
  'hr.employee': [
    { label: 'Goal Progress', run: (db, r) => goalProgress(db, r.id) },
    { label: 'Approvals Waiting', run: (db, r) => pendingFor(db, r.id) },
    { label: 'Worked Days This Month', run: (db, r) => workedDaysForPayslip(db, r.id, monthOf()) },
    { label: 'Timesheet This Week', run: (db, r) => weeklyGrid(db, r.id, monday()) },
    { label: 'Utilization This Month', run: (db, r) => employeeUtilization(db, r.id, monthOf()) },
    { label: 'Field Service Hours Today', run: (db, r) => ({ hours: technicianLoad(db, r.id, today()) }) },
    { label: 'Maintenance Load This Month', run: (db, r) => calendarLoad(db, r.id, monthOf()) },
    { label: 'Referral Points', run: (db, r) => points(db, r.id) },
  ],
  'marketing.campaign': [{ label: 'Activity Statistics', run: (db, r) => stepStats(db, r) }],
  'stock.quant.package': [{ label: 'Package Contents', run: (db, r) => packageContents(db, r.id) }],
  'event.event': [{ label: 'Event Dashboard', run: (db, r) => eventDashboard(db, r.id) }],
  'fleet.vehicle': [
    { label: 'Costs This Year', run: (db, r) => vehicleCosts(db, r.id, yearOf()) },
    { label: 'Fuel Efficiency', run: (db, r) => fuelEfficiency(db, r.id) },
  ],
  'helpdesk.team': [{ label: 'Team Statistics', run: (db, r) => teamStats(db, r.id) }],
  'maintenance.equipment': [{ label: 'Equipment Statistics', run: (db, r) => equipmentStats(db, r.id) }],
  'hr.job': [{ label: 'Recruitment Pipeline', run: (db, r) => jobPipeline(db, r.id) }],
  'hr.applicant': [{ label: 'Applicant Score', when: (r) => !!r.job_id, run: (db, r) => applicantScore(r, read(db, 'hr.job', r.job_id) ?? {}) }],
  'repair.order': [{ label: 'Repair Total', run: (db, r) => repairTotal(db, r.id) }],
  'res.partner': [{ label: 'Customer Statement This Year', run: (db, r) => customerStatement(db, r.id, yearOf()) }],
  'hr.skill.type': [
    { label: 'Skill Matrix', run: (db, r) => skillMatrix(db, r.id) },
    { label: 'Employees per Skill', run: (db, r) => (r.skill_ids ?? []).map((s) => ({ skill: s.name, employees: employeesWithSkill(db, { typeId: r.id, skill: s.name }).map((e) => e.name).join(', ') })) },
  ],
  'mrp.workcenter': [{ label: 'Load This Month', run: (db, r) => workcenterLoad(db, r.id, monthOf()) }],
  'pos.session': [{ label: 'Z Report', run: (db, r) => zReport(db, r.id) }],
  'sale.rental': [{ label: 'Best Price', run: (db, r) => bestPrice(db, r.product_id, rentalHours(r.pickup_date, r.return_date)) }],
  'restaurant.floor': [{ label: 'Table Status', run: (db, r) => tableStatus(db, r.id) }],
  'account.analytic.account': [{ label: 'Balance This Year', run: (db, r) => analyticBalance(db, r.id, yearOf()) }],
  'account.move': [{ label: 'Purchase Order Matching', when: (r) => r.move_type === 'in_invoice' && !!r.purchase_id, run: (db, r) => matchBill(db, r.id) }],
  product: [{
    label: 'Stock per Warehouse', when: (r) => r.type === 'goods',
    run: (db, r) => search(db, 'stock.warehouse').map((w) => ({ warehouse: w.name, quantity: warehouseQty(db, r.id, w.id) })),
  }, {
    label: 'On Hand in Packagings', when: (r) => r.type === 'goods',
    run: (db, r) => {
      const { packages, remainder } = packagingSuggestion(db, r.id, Number(r.qty_available) || 0);
      return [...packages.map((p) => ({ packaging: p.packaging.name, count: p.count })), ...(remainder ? [{ packaging: 'Loose units', count: remainder }] : [])];
    },
  }],
};

/** App-level analyses, listed under an "Analysis" menu; `period` is { from, to } from the page's period picker. */
export const appAnalyses = [
  {
    app: 'appraisals', key: 'appraisal-analysis', label: 'Appraisal Analysis',
    run: (db, period) => Object.entries(appraisalAnalysis(db, period)).map(([k, stats]) => ({
      manager_id: k === 'null' || !k || k === 'undefined' ? null : Number(k),
      ...stats,
    })),
  },
  { app: 'expenses', key: 'expense-analysis', label: 'Expense Analysis', run: (db, period) => expenseAnalysis(db, period) },
  { app: 'frontdesk', key: 'visitor-report', label: 'Visitor Report', run: (db, period) => visitorReport(db, boundedPeriod(period)) },
  { app: 'quality', key: 'quality-statistics', label: 'Quality Statistics', run: (db, period) => qualityStats(db, period) },
  { app: 'repairs', key: 'repair-analysis', label: 'Repair Analysis', run: (db, period) => repairAnalysis(db, period) },
  { app: 'rental', key: 'rental-schedule', label: 'Rental Schedule', run: (db, period) => rentalSchedule(db, boundedPeriod(period)) },
  { app: 'recruitment', key: 'duplicate-applicants', label: 'Duplicate Applicants', period: false, run: (db) => duplicateApplicants(db) },
  { app: 'lunch', key: 'vendor-summary', label: 'Orders per Vendor Today', period: false, run: (db) => vendorSummary(db, today()) },
  { app: 'lunch', key: 'active-alerts', label: 'Active Alerts', period: false, run: (db) => activeAlerts(db) },
  { app: 'fieldservice', key: 'dispatch', label: 'Dispatch Board Today', period: false, run: (db) => planTasks(db, { date: today() }) },
  { app: 'fleet', key: 'contracts-to-renew', label: 'Contracts to Renew (30 days)', period: false, run: (db) => contractsToRenew(db, today(), 30) },
  { app: 'fleet', key: 'services-due', label: 'Services Due', period: false, run: (db) => servicesDue(db, today()) },
  { app: 'skills', key: 'certifications-expiring', label: 'Certifications Expiring (90 days)', period: false, run: (db) => certificationsExpiring(db, today(), 90) },
  { app: 'documents', key: 'overdue-requests', label: 'Overdue Document Requests', period: false, run: (db) => overdueRequests(db, today()) },
];
