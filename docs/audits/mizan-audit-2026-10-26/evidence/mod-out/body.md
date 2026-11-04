# Mizan audit: D2 Module Inventory and Maturity Matrix (id: modules, prefix MIZAN-MOD-)

Audited commit 0e9f748 (copy at evidence/work-modules). No file under /home/claude/mizan was changed.

## Summary
- The registry holds **63 apps and 180 models**; the README says "56 apps" (README.md:17). The 7 apps the README leaves out are Kitchen (mentioned only), WhatsApp, Equity, Data Recycle, Phone, IoT and Spreadsheet.
- 85 models have form buttons (230 `run` buttons, 61 plain `vals` state buttons, 8 `server` buttons). 47 models have computed fields. 57 models have no business logic of any kind: no compute, button, onchange, guard or protectDelete.
- Server-side rules: 56 models have a `guard`, but **8 of those are only the multi-company wrapper** (crm.lead, stock.picking, purchase.order, account.payment, account.journal, hr.employee, project.project, helpdesk.ticket). That leaves 48 models with a business guard. 7 models have `protectDelete`. **57 of the 85 workflow models have no guard at all**, among them mrp.production, pos.order, hr.payslip, sale.subscription, approval.request, sign.request, repair.order and account.asset. Impact: MIZAN-SEC-001.
- Tests: 113 files with 760 static `test(` blocks; the runtime count of 762 includes a 3-iteration loop in rentalplus.test.js:72. 313 blocks hold an explicit negative assertion. Only 10 files go through `applyDiff`, the server write path, and no test renders a React view.
- 86 exported business functions are covered by tests but have no production caller. Examples: POS restaurant flows, the Sign signer link, rental pickup and deposit, fleet renewals. Test counts therefore overstate what users can reach.
- **Matrix result (63 apps):** UI only 7; Partially functional 24; Functional but insufficiently tested 32; Verified for defined workflows 0; Production-ready 0; Not implemented 0. No app rates above "Functional but insufficiently tested", because workflow rules run in the browser and the server accepts forged states (SEC-001, ACC-001).
- Top findings: MOD-001 (P0), the app allow-list grants read and write on employee PII and invoices to every restricted user; MOD-002 (P1), approvers identify themselves by typing an employee ID; MOD-003 (P1), Sign is simulated; MOD-004 (P1), Barcode counts bypass valuation; MOD-005 (P1), the scheduler silently drops whole jobs.

## What I verified / what I could not verify
- Verified by running scripts on the copy (Node 22; model code only, no server started):
  - registry enumeration: mod-enum.mjs, mod-keys.mjs, mod-btn.mjs, mod-btnlabels.mjs
  - guard origin: mod-guardorigin.mjs
  - modelsForApps reach: mod-perm.mjs, mod-reach.mjs
  - test mapping: mod-tests.mjs, mod-agg.mjs
  - unwired exports: mod-unwired.mjs
  - five reproductions: mod-repro-perm.mjs, mod-repro-barcode.mjs, mod-repro-sched.mjs, mod-repro-sign.mjs, mod-repro-approve2.mjs
  - All scripts are in evidence/, and their outputs are in that folder's mod-out/.
- Verified by reading code: every file:line cited below.
- Not verified:
  - I did not run the UI in a browser, so view behaviour comes from reading the JSX.
  - I did not start the HTTP server. The /api/diff behaviour is inferred from server/index.js:432-440 calling the same `applyDiff` that I ran directly.
  - The Odoo Enterprise comparisons are functional descriptions from product knowledge, not checked against a live Odoo instance.
- Heuristics: per-app test counts match model-name strings (plus header constants) inside each test block, so they are approximate. The per-file counts are exact. "Negative" means the block contains `assert.throws` or `assert.rejects`, a 4xx status assertion, or `assert.match` on a refusal message.

## Method
1. I imported `src/models/index.js` (`models`, `apps`, `leavesOf`, `modelsForApps`) and every `src/models/*.js` export to find which file defines each model. Per model I recorded fields, sub-fields, computes, onchange, buttons (run, vals, server), guard, protectDelete, onUnlink, lockedWhen and menu apps.
2. I split each `*.test.js` into `test(` blocks and mapped each block to models and negative assertions, and noted whether it calls `applyDiff`, fetch or `/api/`.
3. For each app, I ran `modelsForApps([id])` and traced the relation fields that pull in sensitive models.
4. I listed exported functions in src/models that nothing outside tests references.

## Module Maturity Matrix (all 63 registered apps)
Status key: UI = UI only; PF = Partially functional; FIT = Functional but insufficiently tested. No app reached Verified or Production-ready. Logic counts are run/vals/server buttons; "guard" means a business guard. The test figure is mention-based: tests (negative). Gaps describe behaviour compared with the equivalent Odoo Enterprise app.

| App (id) | Status | Logic / server enforcement | Integration | Tests | Missing or simulated vs Odoo EE | Evidence |
|---|---|---|---|---|---|---|
| Spreadsheet (spreadsheet) | PF | Grid page plus spreadsheet.document (1 button); no guard | none | spreadsheet.test.js 4 (0) | No live pivots or lists from other apps, no collaborative editing; app is missing from ORDER and APP_INFO | models/spreadsheet.js; views/Spreadsheet.jsx (82 lines); index.js:529 |
| Discuss (discuss) | PF | Channel page; mail.activity Mark Done/Open; no guard | Activities on all models | 2 (0) | Whole-DB polling instead of a realtime bus; no notifications or presence, no calls; no inbound mail gateway | views/Discuss.jsx (70 lines); store.js:83 |
| Calendar (calendar) | UI | calendar.event: 7 fields, no buttons, no guard | none | 2 incidental | No attendees, invitations or RSVP, no recurrence, no reminders, no external calendar sync; time stored as text | mod-out/models.json `calendar.event` |
| Appointments (appointments) | FIT | Booking guard; public booking endpoint; invoicing | Invoice (account.move) | appointments.test.js 9 (3) + server 3 (2) | No online payment at booking, no calendar sync or video links | server/index.js:296; models/appointments.js:136 |
| To-do (todo) | UI | todo.task: 6 fields, no logic | none | 0 | No personal or private tasks, no conversion to project task | models/more.js `todo.task` |
| Knowledge (knowledge) | FIT | articleGuard; article tree page | none | knowledge.test.js 11 (3) | No per-article member or reader rights, no public sharing, no embedded views | views/Knowledge.jsx; models/knowledge.js |
| Contacts (contacts) | PF | res.partner: 16 fields, WhatsApp server button, no guard; shared with every user | WhatsApp | many incidental | No duplicate merge, no VAT or VIES validation, no partner bank accounts; any restricted user can edit any contact | index.js:561; models/crm.js:62 |
| CRM (crm) | FIT | crm.lead 3/2/0; company-only guard; lead assignment and scoring in the scheduler | Sales (quotation) | 77 (25); crmteams.test.js 3 (0) | Email alias configured but no mail gateway, no lead enrichment; stage and won changes are not enforced on the server | crmteams.js:75; scheduler.js:12 |
| Sales (sales) | FIT | sale.order 11/2/2, guard; portal sign and pay; loyalty, templates, marketplaces | Inventory, Accounting, Purchase (inter-company) | 65 (28); quoteplus 8 (6); loyalty 9 (4) | Payment providers are wire, COD and demo only; no card acquirer | ecommerce.js:56,95; server/portal.js:37-55 |
| Dashboards (dashboards) | UI | Fixed KPI tiles computed in the browser | reads Sales, CRM, Accounting, Helpdesk, Inventory | 0 | No configurable dashboards, no drill-down pivots | views/Pages.jsx:112-141 |
| Subscriptions (subscriptions) | FIT | sale.subscription 4/4/0, no guard; recurring invoicing in the scheduler | Accounting | subscriptionplus 10 (4); subscription 5 (1) | Auto-payment is a mock; one failing contract silently stops all invoicing (MOD-005) | subscriptionplus.js:72,180; scheduler.js:25-40 |
| Rental (rental) | FIT | sale.rental 5/1/0, no guard; rental.pricing guard | Inventory (qty_rented), Accounting | rentalplus 10 (6); rental 2 (1) | Pickup and return transfers, best price, deposit hold and schedule are unreachable (MOD-007) | rentalplus.js exports; mod-unwired output |
| Point of Sale (pos) | PF | POS screen (sessions, cart, pay); pos.order 3 buttons, no guard | Inventory, Accounting | posplus 10 (7); pos 1 (1) | Tables, transfer, merge, split bill, tips and Z report are tested but unreachable; no offline mode, no hardware or payment terminal; tax handling broken (ACC-014) | views/Pos.jsx:1-8; posplus.js:33-191 |
| Kitchen Display (kitchen) | PF | Writes pos.order.kitchen_state | POS | 1 (apps3) | No per-station routing, prep times or recall | views/Kitchen.jsx:11-12 |
| Accounting (accounting) | FIT | 36 models reachable; moveGuard covers lock dates only; reports; banks, assets, loans, deferrals, consolidation | everything | about 154; closing 12, finance 10, loans 10, assets 10 | Posted entries are mutable through diff (ACC-001, SEC-001); e-invoicing gaps (ACC-019) | finance.js:40-56 |
| Documents (documents) | PF | documents.document 6 run buttons; folder and workflow-rule guards | Accounting (bill), Sign, Project | documentsplus 10 (8); signplus 13 (10) | "Share" creates a token that no endpoint serves; no email-to-folder ingestion | documentsplus.js:129-132; signplus.js:311-313 |
| Project (project) | FIT | project.task guard; project company-only; recurrence in the scheduler; milestones | Timesheets, Helpdesk, FSM | projectplus 9 (3) | No customer portal for tasks, no dependency rescheduling; postUpdate is unreachable | scheduler.js:13; mod-unwired |
| Timesheets (timesheets) | FIT | timesheetGuard (validated lines locked); timers | Project, Sales (billing), Payroll | timesheetplus 8 (5) | Weekly grid and utilisation reports are unreachable | timesheetplus.test.js:76 |
| Planning (planning) | FIT | planning.slot guard; 6 run buttons (take, switch, repeat) | Employees | planningplus 9 (3) | autoPlan and publishPeriod are unreachable; no employee notifications | mod-unwired |
| Helpdesk (helpdesk) | FIT | SLA compute; assign, merge, rate; auto-assign and auto-close in the scheduler; ticket guard is company-only | FSM, Timesheets | helpdesk 8 (2) | "Email Alias" field exists but there is no inbound mail; no customer portal ticket form; teamStats unreachable | helpdesk.js:170; scheduler.js:20-22 |
| Website (website) | FIT | Page, menu and redirect guards; public site, cart, order and forum endpoints | Sales, Blog, Forum, Live Chat | websiteplus 12 (7); server/website 6 (4); server/shop 9 (3) | No real payment provider, no visual builder (renderSnippet unreachable), no multi-website | server/index.js:261-353; api.js:25-27 |
| Email Marketing (marketing) | FIT | mailing.mailing guard; SMTP send; tracking pixel, links, unsubscribe | Contacts, Automation | mailing 10 (2); mailtrack 5 (1) | Without SMTP every recipient is recorded as sent and delivered; no bounce handling (no inbound mail) | mailing.js:74-77; FormView.jsx:253-278 |
| Events (events) | FIT | Registration guard; public registration; booth and sponsor invoicing | Accounting | eventsplus 7 (2); events 5 (4) | Registration invoicing, badges and dashboard are unreachable; no paid online tickets | mod-unwired (eventsplus.js) |
| Purchase (purchase) | FIT | purchase.order 4/2/0; **company-only guard**; bill matching guard on the invoice side | Inventory, Accounting | billcontrol 8 (4); purchaseplus 9 (4) | No vendor portal or EDI; vendor price application and blanket expiry are unreachable | billcontrol.js; mod-guardorigin output |
| Inventory (inventory) | FIT | stock.picking 5 run buttons, **company-only guard**; valuation layers (no guard); replenishment in the scheduler | Sales, Purchase, MRP, Accounting | valuation 13 (3); valuation-wiring 12 (4); warehouse 10 (5) | resupplyTransfer and warehouseQty unreachable; barcode operations bypass moves (MOD-004) | scheduler.js:7; mod-unwired |
| Manufacturing (manufacturing) | FIT | mrp.production 4/2/0 with **no guard**; work orders; unbuild; scrap | Inventory, Accounting, PLM | workorder 8 (6); mrp 3 (2) | No MRP scheduling or capacity planning (workcenterLoad unreachable); no subcontracting | mod-out/models.json |
| Shop Floor (shopfloor) | PF | Page lists MOs and calls the Produce button | MRP | 0 for the page | No operator login, step instructions or embedded quality checks | views/Pages.jsx:68-110 |
| Barcode (barcode) | PF | Page sets product.qty_available directly | Inventory (bypassed) | 0 | Counts skip valuation and journal entries (MOD-004); no barcode-driven receipts, deliveries or transfers, no lots or locations | views/Pages.jsx:33-36 |
| Quality (quality) | FIT | quality.check Pass/Fail are vals buttons; measure, alert; no guard | Inventory (pickings) | qualityplus 8 (**0**) | qualityStats unreachable; checks do not block transfers on the server | mod-out/models.json |
| Maintenance (maintenance) | FIT | Equipment and request guards; preventive scheduling in the scheduler | Employees | maintplus 12 (5), 4 via applyDiff | MTBF statistics and calendar load unreachable | scheduler.js:6 |
| Repairs (repairs) | FIT | repair.order 6/1/0, no guard; invoice | Accounting, Inventory | repairplus 7 (3) | repairTotal and analysis unreachable; no warranty logic seen | mod-unwired |
| Field Service (fieldservice) | FIT | fsm.task 6 run buttons, no guard; timesheets, sign, invoice | Helpdesk, Accounting | fsm 6 (3) | planTasks and technicianLoad unreachable; no maps or route planning | mod-unwired |
| Sign (sign) | PF | sign.request 5/1/0, no guard | Documents | signplus 13 (10) | Simulated: nothing is sent, no signer portal, staff sign in the signer's name (MOD-003) | signplus.js:224-247,276; extra.js:21-35 |
| Employees (employees) | PF | hr.employee: 38 fields, company-only guard, no logic | every HR app | 25 (13) | Private fields (wage, IDs, bank) open to every restricted user (MOD-001); no user-to-employee link | work.js:43-76; server/index.js:56-59 |
| Attendances (attendances) | FIT | hr.attendance guard; kiosk; overtime; auto checkout in the scheduler | Payroll | attendanceplus 12 (7) | Kiosk PIN checked in the browser (see SEC); no geolocation or IP rules; workedDaysForPayslip unreachable | scheduler.js:16 |
| Recruitment (recruitment) | FIT | hr.applicant 5/1/0, no guard; public apply endpoint | Employees, Skills, Referrals | recruitplus 6 (2); recruitment 1 (0) | No CV inbox or parsing; pipeline, duplicate and score helpers unreachable | server/index.js:287 |
| Time Off (timeoff) | PF | leaveGuard (balance and dates); Approve is a vals state button; accrual in the scheduler | Payroll, Attendances | timeoff 3 (2) | No approver authority: anyone with the app approves any leave, own included (MOD-002) | timeoff.js:39-45,70 |
| Appraisals (appraisals) | FIT | hr.appraisal guard; 6 run buttons; scheduler jobs | Employees | appraisalplus 11 (9) | Manager or employee feedback is not tied to the logged-in user; goal analysis unreachable | scheduler.js:14 |
| Payroll (payroll) | FIT | Rule engine, batches, accounting entries; **hr.payslip has no guard** | Accounting, Attendances, Time Off | payroll 10 (**0 negative**) | No country localisation or bank payment files; paid state can be forged (SEC-001); payroll-only users blocked (ACC-017) | payroll.js; payroll.test.js |
| Expenses (expenses) | PF | hr.expense guard and protectDelete; sheets; posting and payment | Accounting, Sales (re-invoice) | expenseplus 12 (8); expense 3 (0) | Approve is a vals state button, with no manager check (MOD-002); no receipt OCR or email submission; re-invoicing unreachable | more.js:336; expenseplus.js |
| Fleet (fleet) | FIT | Odometer and fuel guards; services | Employees | fleetplus 10 (5) | Contract renewal, renewal alerts, services due and costs are unreachable | mod-unwired (fleetplus.js x5) |
| Lunch (lunch) | FIT | orderGuard, supplier guard, cash moves | Employees | lunch 9 (3) | "Send Orders" only flips order state; the supplier is never contacted | lunch.js:62-64,139 |
| Approvals (approvals) | PF | approval.request 5 run buttons, **no guard** | Purchase (follow-up) | approvalsplus 14 (9) | Approver typed as an employee ID (MOD-002); seeded legacy request cannot be approved | approvalsplus.js:113-116 |
| Frontdesk (frontdesk) | FIT | Visitor guard; check-in and check-out | Employees | frontdeskplus 8 (6) | No host notification, no self-service kiosk; planning and report helpers unreachable | mod-unwired |
| Surveys (surveys) | PF | Internal take and results pages; no guard | none | surveys 5 (1) | No public respondent link (no server route), no certifications or live sessions | grep: 0 survey routes in server/*.js |
| eLearning (elearning) | PF | Enrolment guard, quizzes, completion | Contacts | elearning 10 (7) | No learner-facing site (no server route); staff complete lessons for learners | grep: 0 slide routes in server/*.js |
| Live Chat (livechat) | FIT | Public start, message and poll endpoints; chatbots, canned replies | Website, Helpdesk | livechat 8 (5); server 4 (3) | No operator presence or routing beyond the chatbot (NOT VERIFIED) | server/livechat.js:15-75; server/index.js:306 |
| WhatsApp (whatsapp) | FIT | Cloud API send; HMAC webhook; template approval by an admin | Contacts, Sales | whatsapp 8 (5); server 4 (3) | Template "approval" is internal and never submitted to Meta | server/index.js:246-257; whatsapp.js:110-116,150-151 |
| SMS Marketing (sms) | PF | Twilio send when configured, otherwise marked sent | Contacts | sms 4 (1) | Inbound STOP or opt-out unreachable (handleInbound has no caller or route); fallback fakes "sent" | sms.js:38-44; mod-unwired |
| Social Marketing (social) | PF | Post and schedule; scheduler publishes due posts | none | social 4 (2) | Simulated: no network API or credentials; engagement never fed (MOD-006) | social.js:32-37,72-86,134 |
| Marketing Automation (automation) | PF | Campaign steps processed by the scheduler | Contacts | automation 4 (1) | Simulated: email and SMS steps are marked processed and nothing is sent; open and click triggers never fire (recordEvent unreachable) | automation.js:53-75,105 |
| PLM (plm) | UI | mrp.eco: 7 fields, no buttons, no guard | BoM (menu only) | 0 for mrp.eco | No ECO approvals, BoM versioning or applying changes | mod-out/models.json `mrp.eco` |
| Meeting Rooms (rooms) | UI | room.booking: 6 fields, times as text, no guard | none | 0 | No double-booking check, no availability view, no calendar link | mod-out/models.json `room.booking` |
| Referrals (referral) | PF | hr.referral guard plus 3 computes | Recruitment | 5 (4) | referralLink, referFromLink and buyReward unreachable, so employees cannot share links or redeem rewards | mod-unwired (skillsplus.js) |
| Skills (skills) | FIT | Skill, type and resume guards | Employees, Recruitment | 3 (2) | Skill matrix and expiring-certification reports unreachable | mod-unwired |
| ESG (esg) | PF | One compute (CO2e) plus a default-factor button | none | 1 (0) | No emission-factor library, no reports beyond a pivot, no links to purchases or fleet | apps3.test.js:17 |
| Equity (equity) | PF | Cap table plus Post check in the browser only; no guard | none | 1 (apps3) | No share classes or vesting, no legal documents; server accepts any posted transfer | apps4.js:7-60 |
| Data Recycle (recycle) | PF | Manual Preview and Archive buttons | any model | 1 (apps3) | Billed as "automatically" but not in the scheduler | index.js:552; scheduler.js:2-18 |
| Phone (phone) | UI | tel: link plus call log | Contacts | 0 | No softphone, VoIP provider or call recording | logistics.js `phone.call` |
| IoT (iot) | PF | Token issue (admin) plus ingest endpoint | none | integrations 1 | No device drivers (printers, scales, terminals), no triggers | server/index.js:38,279 |
| Studio (studio) | PF | Admin-only custom fields synced through settings | all models | studio 3 (0) | Custom fields only: no view, report or automation editing | sync.js:107 |
| Apps (apps) | UI | Toggles settings.uninstalled | Home screen | 0 | Uninstall only hides the icon; data, API and scheduled jobs keep running | AppStore.jsx:19-26; Home.jsx:11 |
| Settings (settings) | FIT | Companies (companyGuard), users, API keys, lock dates | all | company 9 (4) | No per-model access rights or record rules, no 2FA (see SEC) | sync.js:83-108 |

Status totals: **UI only (7):** calendar, todo, dashboards, plm, rooms, phone, apps. **Partially functional (24):** spreadsheet, discuss, contacts, pos, kitchen, documents, shopfloor, barcode, sign, employees, timeoff, expenses, approvals, surveys, elearning, sms, social, automation, referral, esg, equity, recycle, iot, studio. **Functional but insufficiently tested (32):** appointments, knowledge, crm, sales, subscriptions, rental, accounting, project, timesheets, planning, helpdesk, website, marketing, events, purchase, inventory, manufacturing, quality, maintenance, repairs, fieldservice, attendances, recruitment, appraisals, payroll, fleet, lunch, frontdesk, livechat, whatsapp, skills, settings.

Why nothing rates above FIT: business rules live in the button `run` functions that execute in the browser. The server checks only shape plus 48 business guards (sync.js:58-61). A non-admin can post the end state directly (SEC-001, ACC-001). Of 113 test files, only 10 test the server write path, and no test covers the generated views or the custom pages.

## Findings
