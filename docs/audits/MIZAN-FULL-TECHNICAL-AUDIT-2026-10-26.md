# Mizan ERP: Full Independent Technical Audit (2026-10-26)

| | |
|---|---|
| Repository | `sayed710/mizan` (public) |
| Audited revision | `main` @ `0e9f74820706083ba6e94dd414a63053348e1d3d` (2026-10-26 08:53 +0300) |
| Audit type | Read-only. No application code, configuration, branch or setting was changed. |
| Report location | `docs/audits/MIZAN-FULL-TECHNICAL-AUDIT-2026-10-26.md`, with detailed workstream reports, the module matrix data and reproduction scripts in `docs/audits/mizan-audit-2026-10-26/` |

---

## A. Executive summary

Mizan presents a very wide Odoo-like surface. The registry holds 63 apps and 180 models with list, kanban, form, pivot and gantt views. The README describes it as 56 apps. The suite runs 762 tests, all passing once the frontend is built.

**The underlying system is not a trustworthy ERP yet.** The core reason is architectural, not cosmetic:

- **Business logic runs in the browser.** Form buttons compute the next database state on the client. The server receives a record-level diff (`POST /api/diff`) and checks little more than record shape. It runs an optional guard on 56 of 180 models. As a result, any logged-in user who can see a model can write any state into it. This audit confirmed, with scripts run against the real `applyDiff` and a live server, that a non-admin can:
  - post an unbalanced journal entry;
  - mark an invoice paid with no payment;
  - edit or delete posted invoices;
  - set stock on hand to any number;
  - create a "paid" payslip.
- **The permission model over-grants.** An app allow-list automatically includes every model that its menus' fields point to. A user restricted to the To-do app can therefore read and rewrite employee salaries, bank accounts, passport numbers and attendance PINs. Users of ten non-accounting apps can write posted invoices.
- **Concurrency is unsafe.** Record ids and document numbers are chosen by the browser, and the server keeps the last write with no version check. The consequences:
  - Two users posting at the same time overwrite each other's posted journal entries.
  - The same stock ships twice.
  - Invoice numbers repeat.
  - Eight public website endpoints commit a copy of the database taken before awaiting the request body, so a slow anonymous request silently reverts everyone else's changes.
- **The client can lose data silently.** One failed network request permanently stops all later saves without telling the user. A failed initial load swaps in demo data, which the next save writes over real records.

When the browser functions are driven honestly, the core accounting flows produce balanced double entry. Sale → invoice → payments → credit note → bill payment closes at 218,214.80 debit = credit, and the balance sheet balances. **The engine's arithmetic is largely sound; what is missing is a server that enforces it.** Many correctness defects remain reachable through the normal UI without any forging:

- Credit notes never offset their invoice.
- Deliveries can exceed the order.
- Foreign-currency invoices are displayed and summed in the company currency.
- POS adds VAT on top of tax-included prices.
- Subscription "Automatic Payment" books fictitious bank receipts.

**Verdict: NOT READY FOR PRODUCTION. Architecture: requires architecture reconsideration** (section Q).

**Findings:** 116 findings were filed by seven workstreams. After deduplication by root cause there are **100 unique findings: P0 9, P1 37, P2 42, P3 12.** The lead auditor independently re-checked all nine P0s against the source code.

**Most critical risks (P0):**

| ID | Risk |
|---|---|
| MIZAN-SEC-001 | No server-side workflow or field authorization: forged postings, payments, payroll and stock |
| MIZAN-MOD-001 | App allow-list grants every restricted user read/write on HR private data and, for 10 apps, on posted invoices |
| MIZAN-DB-002 | Client-chosen record ids: concurrent creates overwrite each other, including posted journal entries |
| MIZAN-DB-006 | Any user can poison a model's id counter so every later record overwrites the previous one (persistent) |
| MIZAN-DB-001 | Public endpoints commit a stale database snapshot and revert concurrent changes |
| MIZAN-ACC-002 | Hard lock date bypass: paid status, archive flag, company and journal of locked entries stay writable |
| MIZAN-UI-001 | One failed request permanently stops saving and polling, silently |
| MIZAN-UI-002 | A failed startup load puts demo data into server mode; the next save overwrites real records |
| MIZAN-UI-003 | Kanban drag-and-drop writes `state` directly: a draft invoice becomes "Posted" with no journal items |

---

## B. Audit scope and evidence

**Revision and repository state (verified from GitHub):**
- Default branch `main`, HEAD `0e9f748`. It is the only branch.
- Pull requests ever opened: 0. Issues: 0.
- GitHub Actions workflows: 0. Branch protection: none. Releases and tags: none.
- 149 commits between 2026-10-24 23:59 and 2026-10-26 08:53 (+0300), all by one author (`sayed710`) and all pushed directly to `main`. 37 commit messages name an AI agent: Codex 16, Pi 16, OpenCode 5.

**Local / unpushed state: NOT VERIFIED.** Development happens on the owner's Windows PC (`C:\Users\hp\mizan`), driven by local Codex, Pi, OpenCode and Gemini agents. A read-only status request (git status, unpushed commits, worktrees, running agent processes) was sent to the Remote Control session on that PC, but the session went offline without answering. This audit therefore covers only the GitHub revision above. Any uncommitted work, local worktrees or results of agents still running on the PC are not covered.

**Workstreams.** These were independent read-only reviewers inside this audit session, each working in its own copy of the repository:

| Stream | Scope | Raw findings | Detailed report |
|---|---|---|---|
| sec | Security (authn, authz, API, public endpoints, secrets, supply chain) | 9 | `mizan-audit-2026-10-26/sec.md` |
| acct | Accounting and financial integrity | 20 | `mizan-audit-2026-10-26/acct.md` |
| db | Database, data integrity, concurrency, performance | 19 | `mizan-audit-2026-10-26/db.md` |
| flows | End-to-end business workflows | 17 | `mizan-audit-2026-10-26/flows.md` |
| modules | Module inventory and maturity matrix | 9 | `mizan-audit-2026-10-26/modules.md` (+ `evidence/mod-out/`) |
| ui | Frontend, UX, Arabic/RTL, accessibility | 22 | `mizan-audit-2026-10-26/ui.md` |
| arch | Architecture, tests/CI, dependencies/licensing, governance | 20 | `mizan-audit-2026-10-26/arch.md` |

The local Codex, Pi, OpenCode and Gemini agents on the owner's PC were **not** used: they are not reachable from the cloud environment where this audit ran.

**Evidence standard.** Every finding cites file:line references that were read, and most also cite a script that was run, with its output quoted. The scripts are in `mizan-audit-2026-10-26/evidence/`. Their paths inside the workstream reports were rewritten to that folder. Some scripts expect to run from a copy of the repository root, as the reports describe. Where two workstreams found the same root cause, one ID is primary and the others are marked as duplicates in the register (section O). A second agent agreeing was never treated as evidence on its own. The lead auditor re-verified all nine P0 findings directly against the source (see the register's "Lead check" column).

**Tests and builds**

| What | Result | Source |
|---|---|---|
| `npm ci` | OK (Node 22.22 in the audit container; Dockerfile targets Node 24) | executed in this audit |
| `npx vite build` | OK; one 1.10 MB JS chunk (321 KB gzip), chunk-size warning | executed in this audit |
| `npm test` after build | **762 tests, 762 pass, 0 fail** (≈14 s) | executed in this audit |
| `npm test` without `dist/` | 762 tests, 758 pass, **4 fail** (`server/website.test.js`, hidden build dependency) | executed in this audit |
| Coverage (`--experimental-test-coverage`) | src/models lines 99.0% / branches 84.5%; server 90.5% / 73.2%; **22% of source lines never loaded** (incl. `server/index.js`, `src/store.js`, all views) | arch stream, executed |
| `npm audit` | 2 advisories (esbuild/vite, dev server only); 0 with `--omit=dev` | executed in this audit |
| GitHub CI results | none exist | verified via GitHub API |
| Previously claimed results | 738 pass and 752 pass (earlier agent sessions on the owner's PC) | claimed by other agents, superseded by the run above |
| Docker build | not executed | not verified |
| Browsers other than Chromium, screen readers | not executed | not verified |

**Not verified at all:**
- Local or unpushed work.
- Docker image behaviour.
- Real SMTP, WhatsApp, Twilio and carrier/marketplace integrations (no third-party systems were contacted).
- Country tax rules against official specifications (no network).
- Odoo and OCA feature and licence statements: these come from auditor knowledge, not checked against their sources.
- The GitHub collaborators, webhooks, environments and vulnerability-alert endpoints (refused by the environment proxy).

---

## C. Current architecture (as verified)

```
Browser (React 18 SPA, src/)
  store.js ── GET /api/db (whole visible DB) every 15 s and after every save
     │
  views/*.jsx ── form buttons call models[m].form.buttons[i].run(db, record) → next db   (business logic runs HERE)
     │
  store.commit(next) ── diffDb(prev, next) ── POST /api/diff {upserts, deletes, seq, messages, settings}
                                                     │
Node server (server/index.js, single process, Node built-ins only)
  applyDiff(db, diff, {isAdmin, allowed})  (src/sync.js)
     ├─ allowed = modelsForApps(user.apps)   menu models + every relation target (src/models/index.js:564-576)
     ├─ cleanRecord (src/validate.js) + validate (src/orm.js) shape/type checks, strips computed fields
     ├─ models[m].guard?(…)   56 of 180 models; 8 of those only check company
     └─ protectDelete?(…)     7 models
  let db = <whole database as one JS object, in memory>
  commitDb(next) → storage.save(prev, next)  (server/storage.js)
     SQLite (node:sqlite, WAL): kv(meta: seq, settings) · records(model, id, data JSON) · messages(JSON) · users · sessions · api_keys
  Other entry points: /api/v1 REST (Bearer API keys) · /api/public/* website, shop, forms, livechat, blog/forum · portal · integrations · hourly scheduler
```

Consequences of this design, each traced to findings:

1. **The server is a record-shape validator, not the system of record for business rules** (ARCH-001, SEC-001, MOD-008). Every invariant that only a `run()` function establishes can be bypassed with a diff, or by the client's own generic write paths such as the Kanban drag (UI-003) and Barcode count (MOD-004).
2. **Identity, ids and numbers are client-asserted:**
   - record ids (DB-002);
   - sequence counters (DB-006);
   - document numbers (DB-004);
   - chatter and audit messages (DB-007);
   - company selection (SEC-002).
3. **There are no relational guarantees:**
   - no foreign keys or uniqueness (DB-005);
   - no version column (DB-003);
   - no migrations (DB-011);
   - fields the logic writes but the schema does not declare are silently stripped (DB-012).
4. **Scalability is bounded by the whole-database design:**
   - Every write costs O(database): `JSON.stringify` on each `applyDiff`, and the whole visible DB returned on each save and poll.
   - At 50k records (30.7 MB), a one-field save took 0.9–1.3 s and blocked the event loop for 0.7–1.1 s (PERF-001/002).
   - There is a hard 200 M-character ceiling (PERF-005).

---

## D. Module inventory and maturity

The full 63-row matrix is reproduced below. It gives status, logic and enforcement, integration, tests, gaps against the Odoo Enterprise app, and evidence. Per-model statistics for all 180 models and test counts per file are in `mizan-audit-2026-10-26/evidence/mod-out/`.

**Status counts (63 apps):**

| Status | Count |
|---|---|
| Not implemented | 0 |
| UI only | 7 |
| Partially functional | 24 |
| Functional but insufficiently tested | 32 |
| Verified for defined workflows | 0 |
| Production-ready for defined requirements | 0 |

No app rates above "Functional but insufficiently tested", for these reasons:
- Workflow rules run only in the browser, and the server accepts forged states (SEC-001).
- Only 10 of 113 test files exercise the server write path, and no test renders a React view (TEST-001).
- 86 exported business functions are tested but unreachable from any UI, route or job (MOD-007). Tests therefore overstate what users can do.
- Several apps are simulated without telling the user (MOD-003 Sign, MOD-006 Social, Marketing Automation, the SMS/email fallbacks, Documents share).

Legend: UI = UI only, PF = Partially functional, FIT = Functional but insufficiently tested.

| App (id) | Status | Logic / server enforcement | Tests (negative) | Missing or simulated vs Odoo EE |
|---|---|---|---|---|
| Spreadsheet (spreadsheet) | PF | Grid page plus spreadsheet.document (1 button); no guard | spreadsheet.test.js 4 (0) | No live pivots or lists from other apps, no collaborative editing; app is missing from ORDER and APP_INFO |
| Discuss (discuss) | PF | Channel page; mail.activity Mark Done/Open; no guard | 2 (0) | Whole-DB polling instead of a realtime bus; no notifications or presence, no calls; no inbound mail gateway |
| Calendar (calendar) | UI | calendar.event: 7 fields, no buttons, no guard | 2 incidental | No attendees, invitations or RSVP, no recurrence, no reminders, no external calendar sync; time stored as text |
| Appointments (appointments) | FIT | Booking guard; public booking endpoint; invoicing | appointments.test.js 9 (3) + server 3 (2) | No online payment at booking, no calendar sync or video links |
| To-do (todo) | UI | todo.task: 6 fields, no logic | 0 | No personal or private tasks, no conversion to project task |
| Knowledge (knowledge) | FIT | articleGuard; article tree page | knowledge.test.js 11 (3) | No per-article member or reader rights, no public sharing, no embedded views |
| Contacts (contacts) | PF | res.partner: 16 fields, WhatsApp server button, no guard; shared with every user | many incidental | No duplicate merge, no VAT or VIES validation, no partner bank accounts; any restricted user can edit any contact |
| CRM (crm) | FIT | crm.lead 3/2/0; company-only guard; lead assignment and scoring in the scheduler | 77 (25); crmteams.test.js 3 (0) | Email alias configured but no mail gateway, no lead enrichment; stage and won changes are not enforced on the server |
| Sales (sales) | FIT | sale.order 11/2/2, guard; portal sign and pay; loyalty, templates, marketplaces | 65 (28); quoteplus 8 (6); loyalty 9 (4) | Payment providers are wire, COD and demo only; no card acquirer |
| Dashboards (dashboards) | UI | Fixed KPI tiles computed in the browser | 0 | No configurable dashboards, no drill-down pivots |
| Subscriptions (subscriptions) | FIT | sale.subscription 4/4/0, no guard; recurring invoicing in the scheduler | subscriptionplus 10 (4); subscription 5 (1) | Auto-payment is a mock; one failing contract silently stops all invoicing (MOD-005) |
| Rental (rental) | FIT | sale.rental 5/1/0, no guard; rental.pricing guard | rentalplus 10 (6); rental 2 (1) | Pickup and return transfers, best price, deposit hold and schedule are unreachable (MOD-007) |
| Point of Sale (pos) | PF | POS screen (sessions, cart, pay); pos.order 3 buttons, no guard | posplus 10 (7); pos 1 (1) | Tables, transfer, merge, split bill, tips and Z report are tested but unreachable; no offline mode, no hardware or payment terminal; tax handling broken (ACC-014) |
| Kitchen Display (kitchen) | PF | Writes pos.order.kitchen_state | 1 (apps3) | No per-station routing, prep times or recall |
| Accounting (accounting) | FIT | 36 models reachable; moveGuard covers lock dates only; reports; banks, assets, loans, deferrals, consolidation | about 154; closing 12, finance 10, loans 10, assets 10 | Posted entries are mutable through diff (ACC-001, SEC-001); e-invoicing gaps (ACC-019) |
| Documents (documents) | PF | documents.document 6 run buttons; folder and workflow-rule guards | documentsplus 10 (8); signplus 13 (10) | "Share" creates a token that no endpoint serves; no email-to-folder ingestion |
| Project (project) | FIT | project.task guard; project company-only; recurrence in the scheduler; milestones | projectplus 9 (3) | No customer portal for tasks, no dependency rescheduling; postUpdate is unreachable |
| Timesheets (timesheets) | FIT | timesheetGuard (validated lines locked); timers | timesheetplus 8 (5) | Weekly grid and utilisation reports are unreachable |
| Planning (planning) | FIT | planning.slot guard; 6 run buttons (take, switch, repeat) | planningplus 9 (3) | autoPlan and publishPeriod are unreachable; no employee notifications |
| Helpdesk (helpdesk) | FIT | SLA compute; assign, merge, rate; auto-assign and auto-close in the scheduler; ticket guard is company-only | helpdesk 8 (2) | "Email Alias" field exists but there is no inbound mail; no customer portal ticket form; teamStats unreachable |
| Website (website) | FIT | Page, menu and redirect guards; public site, cart, order and forum endpoints | websiteplus 12 (7); server/website 6 (4); server/shop 9 (3) | No real payment provider, no visual builder (renderSnippet unreachable), no multi-website |
| Email Marketing (marketing) | FIT | mailing.mailing guard; SMTP send; tracking pixel, links, unsubscribe | mailing 10 (2); mailtrack 5 (1) | Without SMTP every recipient is recorded as sent and delivered; no bounce handling (no inbound mail) |
| Events (events) | FIT | Registration guard; public registration; booth and sponsor invoicing | eventsplus 7 (2); events 5 (4) | Registration invoicing, badges and dashboard are unreachable; no paid online tickets |
| Purchase (purchase) | FIT | purchase.order 4/2/0; **company-only guard**; bill matching guard on the invoice side | billcontrol 8 (4); purchaseplus 9 (4) | No vendor portal or EDI; vendor price application and blanket expiry are unreachable |
| Inventory (inventory) | FIT | stock.picking 5 run buttons, **company-only guard**; valuation layers (no guard); replenishment in the scheduler | valuation 13 (3); valuation-wiring 12 (4); warehouse 10 (5) | resupplyTransfer and warehouseQty unreachable; barcode operations bypass moves (MOD-004) |
| Manufacturing (manufacturing) | FIT | mrp.production 4/2/0 with **no guard**; work orders; unbuild; scrap | workorder 8 (6); mrp 3 (2) | No MRP scheduling or capacity planning (workcenterLoad unreachable); no subcontracting |
| Shop Floor (shopfloor) | PF | Page lists MOs and calls the Produce button | 0 for the page | No operator login, step instructions or embedded quality checks |
| Barcode (barcode) | PF | Page sets product.qty_available directly | 0 | Counts skip valuation and journal entries (MOD-004); no barcode-driven receipts, deliveries or transfers, no lots or locations |
| Quality (quality) | FIT | quality.check Pass/Fail are vals buttons; measure, alert; no guard | qualityplus 8 (**0**) | qualityStats unreachable; checks do not block transfers on the server |
| Maintenance (maintenance) | FIT | Equipment and request guards; preventive scheduling in the scheduler | maintplus 12 (5), 4 via applyDiff | MTBF statistics and calendar load unreachable |
| Repairs (repairs) | FIT | repair.order 6/1/0, no guard; invoice | repairplus 7 (3) | repairTotal and analysis unreachable; no warranty logic seen |
| Field Service (fieldservice) | FIT | fsm.task 6 run buttons, no guard; timesheets, sign, invoice | fsm 6 (3) | planTasks and technicianLoad unreachable; no maps or route planning |
| Sign (sign) | PF | sign.request 5/1/0, no guard | signplus 13 (10) | Simulated: nothing is sent, no signer portal, staff sign in the signer's name (MOD-003) |
| Employees (employees) | PF | hr.employee: 38 fields, company-only guard, no logic | 25 (13) | Private fields (wage, IDs, bank) open to every restricted user (MOD-001); no user-to-employee link |
| Attendances (attendances) | FIT | hr.attendance guard; kiosk; overtime; auto checkout in the scheduler | attendanceplus 12 (7) | Kiosk PIN checked in the browser (see SEC); no geolocation or IP rules; workedDaysForPayslip unreachable |
| Recruitment (recruitment) | FIT | hr.applicant 5/1/0, no guard; public apply endpoint | recruitplus 6 (2); recruitment 1 (0) | No CV inbox or parsing; pipeline, duplicate and score helpers unreachable |
| Time Off (timeoff) | PF | leaveGuard (balance and dates); Approve is a vals state button; accrual in the scheduler | timeoff 3 (2) | No approver authority: anyone with the app approves any leave, own included (MOD-002) |
| Appraisals (appraisals) | FIT | hr.appraisal guard; 6 run buttons; scheduler jobs | appraisalplus 11 (9) | Manager or employee feedback is not tied to the logged-in user; goal analysis unreachable |
| Payroll (payroll) | FIT | Rule engine, batches, accounting entries; **hr.payslip has no guard** | payroll 10 (**0 negative**) | No country localisation or bank payment files; paid state can be forged (SEC-001); payroll-only users blocked (ACC-017) |
| Expenses (expenses) | PF | hr.expense guard and protectDelete; sheets; posting and payment | expenseplus 12 (8); expense 3 (0) | Approve is a vals state button, with no manager check (MOD-002); no receipt OCR or email submission; re-invoicing unreachable |
| Fleet (fleet) | FIT | Odometer and fuel guards; services | fleetplus 10 (5) | Contract renewal, renewal alerts, services due and costs are unreachable |
| Lunch (lunch) | FIT | orderGuard, supplier guard, cash moves | lunch 9 (3) | "Send Orders" only flips order state; the supplier is never contacted |
| Approvals (approvals) | PF | approval.request 5 run buttons, **no guard** | approvalsplus 14 (9) | Approver typed as an employee ID (MOD-002); seeded legacy request cannot be approved |
| Frontdesk (frontdesk) | FIT | Visitor guard; check-in and check-out | frontdeskplus 8 (6) | No host notification, no self-service kiosk; planning and report helpers unreachable |
| Surveys (surveys) | PF | Internal take and results pages; no guard | surveys 5 (1) | No public respondent link (no server route), no certifications or live sessions |
| eLearning (elearning) | PF | Enrolment guard, quizzes, completion | elearning 10 (7) | No learner-facing site (no server route); staff complete lessons for learners |
| Live Chat (livechat) | FIT | Public start, message and poll endpoints; chatbots, canned replies | livechat 8 (5); server 4 (3) | No operator presence or routing beyond the chatbot (NOT VERIFIED) |
| WhatsApp (whatsapp) | FIT | Cloud API send; HMAC webhook; template approval by an admin | whatsapp 8 (5); server 4 (3) | Template "approval" is internal and never submitted to Meta |
| SMS Marketing (sms) | PF | Twilio send when configured, otherwise marked sent | sms 4 (1) | Inbound STOP or opt-out unreachable (handleInbound has no caller or route); fallback fakes "sent" |
| Social Marketing (social) | PF | Post and schedule; scheduler publishes due posts | social 4 (2) | Simulated: no network API or credentials; engagement never fed (MOD-006) |
| Marketing Automation (automation) | PF | Campaign steps processed by the scheduler | automation 4 (1) | Simulated: email and SMS steps are marked processed and nothing is sent; open and click triggers never fire (recordEvent unreachable) |
| PLM (plm) | UI | mrp.eco: 7 fields, no buttons, no guard | 0 for mrp.eco | No ECO approvals, BoM versioning or applying changes |
| Meeting Rooms (rooms) | UI | room.booking: 6 fields, times as text, no guard | 0 | No double-booking check, no availability view, no calendar link |
| Referrals (referral) | PF | hr.referral guard plus 3 computes | 5 (4) | referralLink, referFromLink and buyReward unreachable, so employees cannot share links or redeem rewards |
| Skills (skills) | FIT | Skill, type and resume guards | 3 (2) | Skill matrix and expiring-certification reports unreachable |
| ESG (esg) | PF | One compute (CO2e) plus a default-factor button | 1 (0) | No emission-factor library, no reports beyond a pivot, no links to purchases or fleet |
| Equity (equity) | PF | Cap table plus Post check in the browser only; no guard | 1 (apps3) | No share classes or vesting, no legal documents; server accepts any posted transfer |
| Data Recycle (recycle) | PF | Manual Preview and Archive buttons | 1 (apps3) | Billed as "automatically" but not in the scheduler |
| Phone (phone) | UI | tel: link plus call log | 0 | No softphone, VoIP provider or call recording |
| IoT (iot) | PF | Token issue (admin) plus ingest endpoint | integrations 1 | No device drivers (printers, scales, terminals), no triggers |
| Studio (studio) | PF | Admin-only custom fields synced through settings | studio 3 (0) | Custom fields only: no view, report or automation editing |
| Apps (apps) | UI | Toggles settings.uninstalled | 0 | Uninstall only hides the icon; data, API and scheduled jobs keep running |
| Settings (settings) | FIT | Companies (companyGuard), users, API keys, lock dates | company 9 (4) | No per-model access rights or record rules, no 2FA (see SEC) |

---

## E. Security findings

**Confirmed P0/P1:**

- **MIZAN-SEC-001 (P0): no server-side workflow or field-level authorization.**
  - `applyDiff` (src/sync.js) enforces only the allowed-model set, shape validation and a sparse guard set.
  - Readonly but non-computed fields such as `account.move.amount_paid` and `product.qty_available` are not stripped, and `state` transitions are never gated.
  - A live proof of concept as a non-admin, via both `/api/diff` and `/api/v1`, did all of the following:
    - forged a posted invoice with debit 1,000,000 and credit 0;
    - marked an invoice paid;
    - created a payslip in state "paid" with net 250k;
    - forced a picking to "done";
    - deleted a posted bill.
  - The lead auditor reproduced the forged posted entry and the posted-invoice edit independently.
  - Duplicates merged here: ACC-001, FLOW-001. Related: UI-003, ARCH-001, MOD-008, FLOW-003.
- **MIZAN-MOD-001 (P0): app allow-list over-grant.**
  - `modelsForApps` adds every relation target of the menu models (src/models/index.js:564-576).
  - Every app reaches `hr.employee` through `mail.activity.user_id`, which exposes wage, bank account, passport and PIN.
  - Ten apps reach `account.move`.
  - Reads go through `visibleDb`, writes through `applyDiff`.
  - Related: ACC-009 (chart of accounts and taxes writable by every app), ACC-017 (the reverse problem: POS-only and payroll-only users are under-granted and cannot post), ARCH-005 (fail-open defaults).
- **MIZAN-DB-006 (P0) / MIZAN-SEC-003: `seq` and `removedMessages` skip the `allowed` check** (src/sync.js:76-85).
  - A contacts-only user deleted 13 chatter messages of unrelated models.
  - The same user set `sale.order` seq to MAX_SAFE_INTEGER, and set seq to 1e300, after which every new record overwrites the last.
- **MIZAN-SEC-002 (P1): no server-side multi-company isolation.**
  - `allowed_company_ids` and `current_company_id` form one global setting that any user can overwrite.
  - `/api/db` and `/api/v1` return every company's records.
  - Duplicates merged: DB-008, FLOW-009, FLOW-010.
  - Rated P1, not P0: the companies belong to one organization, and the most sensitive exposure (HR private data) is already P0 under MOD-001.
- **MIZAN-MOD-002 (P1): segregation of duties is broken.**
  - Approvers type an employee ID into a prompt.
  - Time Off and Expense approvals are plain state writes.
  - No user is linked to an employee, so self-approval is possible.
  - Related: UI-010 (timesheet validator is free text).
- **MIZAN-SEC-008 (P1, raised from P2 because it duplicates UI-009 P1): `/api/reset` and "Reset demo" wipe all business records** after one confirm, with no backup.

**Confirmed P2/P3:**
- SEC-004: the brute-force limiter is in-memory, per IP, and reset by a restart.
- SEC-005: the generated admin password is printed to stdout on first start.
- SEC-006: a non-admin who sets a carrier Rate URL receives `MIZAN_SHIPPING_TOKEN` as a Bearer header. The SSRF filter misses some ranges and re-resolves DNS (TOCTOU).
- SEC-007: there is no password change and no session or API-key revocation; sessions last 14 days.
- SEC-009: dependency advisories affect the dev server only.

**Checked and found sound (negative results):**
- Blog and forum markdown is escaped before the only `dangerouslySetInnerHTML`.
- Public cart and order prices are recomputed on the server (no price tampering).
- The `return=` redirect and the static file server resist open redirect and path traversal.
- The WhatsApp webhook verifies the HMAC and deduplicates.
- Session tokens and API keys are stored only as SHA-256 hashes.
- Passwords use scrypt with a per-user salt and a constant-time compare.
- State-changing cookie requests require JSON plus a custom header (CSRF).

**Supply chain:**
- Runtime dependencies: `@anthropic-ai/sdk ^1.3.0` (an unbounded caret range), `qrcode-generator`, `react` and `react-dom`.
- All licences are permissive (LIC-003).
- There is no lockfile drift; `npm ci` succeeded.

---

## F. Accounting and financial integrity

**What works when the browser functions are used honestly (acct stream, scripts t1–t12):**
- Double entry is generated for invoices, bills, payments, credit notes, POS, payroll and expenses.
- The trial balance closes, and receivables and payables match the ledger on the normal flow.
- Reports (P&L, balance sheet, GL, VAT) are computed from posted journal items.

**What is not trustworthy:**

| Area | Status | Findings |
|---|---|---|
| Posted-entry immutability | **Absent on the server.** Posted moves can be edited, unbalanced, re-stated, archived or deleted by diff. | SEC-001 (=ACC-001), P0 |
| Lock dates / hard lock | Partial. Lines and deletes are protected, but `amount_paid`, `active`, `company_id` and `journal_id` are not (`LOCKED_FIELDS`, src/models/finance.js:24). | ACC-002, P0 |
| Concurrent posting | Unsafe: overwritten posted entries; a 100 gap between AR subledger and GL in the reproduction | DB-002 (=ACC-003), P0 |
| Document numbering | count+1 computed in the browser; duplicates under concurrency and after deletion | DB-004 (=ACC-004), P1 |
| Payment state | `amount_paid` is a stored counter, not derived from reconciliation; drifts from the GL; overpayment excess dropped | ACC-005, P1 |
| Bank reconciliation | Lines marked reconciled with the wrong amount or sign, or with no entry | ACC-006, P1 |
| Credit notes / refunds | Never offset their invoice; unlimited per invoice; the invoice stays fully due | ACC-007 (=FLOW-008), P1 |
| Chart of accounts and taxes | Writable and deletable by users of every app | ACC-009, P1 |
| Account integrity | Lines with missing or unknown accounts are accepted and silently dropped from reports, so the trial balance stops closing | ACC-008, P1 |
| Fiscal year close | `is_closing` is stripped by the server, so that year's P&L shows 0 after sync | ACC-010 (related DB-012), P1 |
| Audit trail | Written by the client; omittable, forgeable, backdatable | DB-007 (=ACC-011), P1 |
| Consolidation | Does not balance: no CTA, prior earnings dropped, one-sided equity method, no NCI | ACC-012, P1 |
| Multi-currency | Ledgers booked in the global currency; non-base companies translated twice (120.78 vs 108.70); items carry no currency | ACC-013, P1 |
| POS taxes | Configured taxes ignored; a price of 114 including VAT is charged 129.96 | ACC-014, P1 |
| Display of foreign currency | SAR 37,500 shown and printed as "$37,500.00" and summed into USD totals; dashboard receivable $38,710 vs a true $11,210 | UI-005, P1 |
| Rounding | Cent residues after "paid"; FX and cash-basis taxes affected the same way | ACC-015, P2 |
| VAT return | The two halves disagree (documents vs journal) | ACC-016, P2 |
| Negative amounts | Accepted; a negative-total invoice shows "Paid" | ACC-018, P2 |
| Subscription auto-payment | Fictitious bank receipts booked by the scheduler | FLOW-012 (=UI-007), P1 |
| Inventory valuation | Barcode count changes stock with no valuation entry; opening stock never posted; standard cost overwritten | MOD-004 (=UI-006), FLOW-016, FLOW-014 |

**Financial statements cannot be relied on** while any user can alter posted data and while concurrent postings can overwrite each other. A balance sheet that balances on seed data is not evidence of integrity. Once a forged diff is applied, the acct stream measured the balance sheet out by 1,000,000 (one-sided entry), 500 or 700 (line with no account) and 8,400 (deleted account).

**Country-specific (ACC-019, gaps only; no compliance is claimed):**
- Saudi Arabia: a ZATCA phase-1 style QR only. There is no phase-2 e-invoicing (XML, cryptographic stamp, clearance).
- Egypt: no ETA e-invoice or e-receipt integration.
- UAE: no e-invoicing.
- EPC QR (EU SEPA) is present.

Jurisdictional rules were not verified against official specifications.

---

## G. Database and concurrency

The persistence model is one JSON blob per record in SQLite, with the authoritative copy held in process memory. A single diff is applied atomically, WAL is on, and replaying a create diff is idempotent. These defects follow from the model:

- **DB-001 (P0): stale snapshot in public endpoints.**
  - `forumRoutes[path](db, await readJson(req), ip)` and seven similar call sites capture `db` before the await (server/index.js:275, 282, 291, 301, 310, 334).
  - JavaScript evaluates the arguments left to right, so the slower the request body, the more concurrent work is reverted when the result is committed.
  - Proven on a live server: an employee's new partner and a lead edit were reverted.
  - The lead auditor confirmed this by reading the code.
- **DB-002 (P0) client-chosen ids; DB-006 (P0) poisonable counters.**
  - `create` assigns `nextId(db, model)` in the browser (src/orm.js:64).
  - The server treats an existing id as an update.
  - The `seq` maximum (src/sync.js:76-77) accepts any integer from any user.
- **DB-003 (P1): no optimistic concurrency.**
  - Lost updates on the same record.
  - On-hand stock 132 instead of 130 after two deliveries.
  - A replayed old diff reverts newer edits.
  - "Send by Email" erased a colleague's note saved while the email was sending.
- **DB-005 (P1): no referential integrity.** A CRM-only user deleted a partner, leaving 14 dangling references, some on posted entries.
- **DB-009 (P1): no multi-process safety.** Two processes on one SQLite file overwrite each other.
- **DB-010 (P1): no backup or restore tooling.** The UI restore cannot handle more than 5 MB; at 20k records the restore failed. See also UI-004: restore is open to non-admins, has no confirm, and an unmodified backup is rejected because of seed and schema drift (ARCH-006).
- **DB-011 (P2): no schema evolution.** In-memory migrations are never persisted.
- **DB-012 (P1): fields the logic writes but the server strips** (`sale.order.loyalty_uses`, `pos.order.stock_costs`, `product.qty_rented`, `is_closing`). The consequences:
  - gift cards become reusable;
  - POS refunds are mis-valued (999 instead of 120);
  - deliveries fail after a rental.
  - Duplicate merged: FLOW-004.
- **DB-013 (P3): no idempotency keys or outbox.** Interrupted sends are recorded as delivered.

**Scenarios from the brief, mapped to evidence:**

| Scenario | Result | Finding |
|---|---|---|
| Two users create records at once | The second silently replaces the first | DB-002 |
| Two users update one record | The last full-record write wins; no conflict error | DB-003 |
| Simultaneous sales and stock | The same 10 units ship twice; stock shows 0 | DB-002 (=FLOW-002), DB-003 |
| Failed multi-step transaction | A single diff is atomic. Multi-request flows (integrations, mail) commit stale results; Expenses "Create Report" always fails in server mode because models are validated against a half-applied diff | DB-003, ARCH-002 |
| Partial payment | Works on the honest path; `amount_paid` drifts from the GL on reset or cancel | ACC-005 |
| Duplicate invoicing / repeated requests | Create replay is idempotent; concurrent numbering duplicates; a stale double payment took AR to -1210 | DB-002, DB-004 |
| Restart during a transaction | SQLite commits before `db = next`. A crash in between loses only the response. There is no outbox for external sends (NOT VERIFIED by fault injection) | DB-013 |
| Silent overwrite or corruption | Yes, through all of the above plus DB-001 and UI-002 | — |

---

## H. Business workflow verification (flows stream; real `run()` handlers, then each step through `applyDiff` as a non-admin)

| Workflow | Honest path | Main defects |
|---|---|---|
| Sales: quote → confirm → delivery → invoice → payment → entries | Works; correct entries | Deliveries can exceed the order and be returned repeatedly (FLOW-006); credit notes do not offset (ACC-007); double Confirm and hidden transitions run (FLOW-003); gift cards reusable after sync (DB-012) |
| Purchase: RFQ → PO → receipt → bill → payment | Works for goods | Purchased services can never be billed (FLOW-015) |
| Inventory: receipt → reservation → move → delivery → valuation | Partly | Reservation not enforced; waiting pickings consume reserved stock (FLOW-007); valuation report does not reconcile with the stock account (FLOW-016); Barcode count bypasses valuation (MOD-004) |
| Manufacturing: BoM → MO → consumption → finished goods → cost | Works without routings | MOs with work orders can never be produced in server mode, because Start writes timestamps into date fields (FLOW-005); standard cost overwritten; zero consumption accepted (FLOW-014) |
| POS: sale → payment → stock → posting → refund | Posts | Configured taxes ignored (ACC-014); refunds valued at current cost after sync (DB-012); POS-only users cannot post (ACC-017); 10 tested restaurant functions unreachable (MOD-007) |
| Subscriptions: activation → renewal → invoice → payment → end | Invoices are generated | "Automatic Payment" books fictitious receipts (FLOW-012); catch-up back-dates and Reopen bills closed months (FLOW-013); one failing record silently stops all recurring invoicing (MOD-005) |
| Multi-company: inter-company → separation → documents → accounting | Not trustworthy | Generated documents always get company 1; the selection is global; reports mix companies (SEC-002 cluster); the inter-company PO copies the seller's output VAT, so the buyer's bill debits 251000 (FLOW-011) |

None of the 69 workflow tests sends workflow results through `applyDiff`. The company tests use helpers that the app never calls.

---

## I. Frontend, UX, Arabic and accessibility

**Defects that can cause wrong business decisions or data loss:**
- UI-001, UI-002 and UI-003 (all P0, section A).
- UI-005: foreign currency shown and summed as company currency.
- UI-004: unsafe restore.
- SEC-008 (=UI-009): reset wipes production data.
- UI-008: on a 400 from `/api/diff` the user sees a raw English `alert()`, the edit is silently reverted, and imports, restores and settings changes report success before the server answers.
- UI-011: dead or misleading General Settings controls.
- UI-019: business inputs taken through native `prompt()`, in English, with raw ids.
- UI-020: dashboard KPIs ignore credit notes.

**Arabic and RTL:**
- RTL is done well: logical CSS properties, and `dir`/`lang` are set.
- 226 of 2,371 `t()` strings (9.5%) are untranslated, mostly selection options and field labels (UI-012).
- Native prompts, chatter notes and 579 of 641 error messages are English-only.
- Negative amounts render as "$1,800.00-", and Arabic-Indic digits are silently rejected (UI-013).

**Accessibility (UI-015; manual DOM checks, no real axe-core or screen-reader run):**
- List rows cannot be opened from the keyboard.
- Menus and the search panel lack Escape and focus handling.
- 0 of 55 required fields carry `required`.
- 269 labels point at nothing.
- Contrast fails for `--warn` (2.26), `--success` (3.49), `--border` (1.26) and dark-mode white on brand (2.89).

**Responsiveness (UI-014):** below 640 px the app sub-menus disappear, and forms overflow at 375 px.

**Robustness (UI-016):** 22 models default to Kanban without a card definition, and the screen crashes once a record exists (4 crash with seed data today).

**Scale (UI-017, UI-018):**
- No pagination: 5,000 contacts produce about 40k DOM nodes and a 1.3 s render.
- One uncompressed 1.10 MB bundle with no code splitting, no cache headers (PERF-006) and no startup loading or error state.

---

## J. Performance and scalability

Measured by the db stream on a 4 vCPU Xeon at 2.1 GHz, with Node 22 and a synthetic database. These are not production benchmarks.

| Measurement | Result |
|---|---|
| One-field save at 50k records (30.7 MB) | 0.9–1.3 s; response about 30 MB; blocks other requests for about 0.7–1.1 s (PERF-001) |
| `applyDiff` with one changed record | 20 ms at 10k extra records, 106 ms at 50k, 436 ms at 200k (arch stream) |
| 15 s poll of `/api/db` at 50k | about 0.6 s per poll per client (PERF-002) |
| Anonymous blog page at 50k | 388 ms, with no rate limit (PERF-001: anonymous requests can trigger whole-DB work) |
| Scheduler | Blocks the event loop for 8.9 s at boot and hourly at 50k; cost grows faster than the data (PERF-003) |
| Lookups | Linear scans; no indexes (PERF-004) |
| Hard ceiling | 200 M JSON characters; past that, every write fails; attachments count inline (PERF-005) |

Not measured: the saturation point under concurrent users (the stream gives arithmetic only), memory growth over time, and a real browser on low-end hardware.

---

## K. Automated tests and CI

- **Results:** 762/762 pass after a build, executed in this audit. 4 fail without `dist/` (TEST-003).
- **What the tests exercise.** Mostly the browser model functions:
  - Only 34 `applyDiff` calls appear, in 10 of 113 test files, and 4 of them run as non-admin.
  - No test calls `/api/diff`, `/api/db` or `/api/v1` over HTTP.
  - `server/index.js`, `src/store.js` and all views are never loaded.
  - `src/ledger.test.js:31` passes while the server accepts the same forged entry (TEST-001).
- **Assertion quality (TEST-004).** It is mostly real behaviour, but:
  - accounting invariants are checked only on seed data;
  - definition checks target module-local objects rather than the composed registry;
  - one test asserts the fictitious auto-payment as correct (subscriptionplus.test.js:46).
- **Coverage can mislead.** 99% line coverage of src/models coexists with 86 unreachable functions and no enforcement tests (TEST-005, MOD-007).
- **Date time bombs (TEST-002).** One test fails from 2026-12-02 and five from 2027-01-01. The Dockerfile runs `npm test`, so image builds will start failing on those dates.
- **CI (GOV-001):**
  - There is no CI; the Docker build is the only automated gate.
  - Nothing runs on pull requests, and no pull requests exist.
- **Not tested at all:**
  - concurrency;
  - authorization over HTTP;
  - database integrity (no referential checks);
  - accounting invariants after server sync.

---

## L. Architecture and technical debt

- **ARCH-001 (P1): browser-authoritative business logic.** 230 of 290 form buttons compute state on the client. This is the root of SEC-001, the UI-003 class and most FLOW and ACC enforcement gaps.
- **ARCH-002 (P1): validation against a half-applied diff.** The server validates a multi-model diff model by model, against partially applied state. Expenses "Create Report" always fails in server mode.
- **ARCH-003 (P2): fragile composition by spread order.**
  - Models are composed by object-spread order: 42 model keys are defined by several modules, all on one 1,534-character line (src/models/index.js:85).
  - Reordering one module silently drops fields and buttons while the suite stays green: `pos.order` loses 12 fields and the Pay button.
  - 13 base definitions (about 330 lines) are fully shadowed dead code.
- **ARCH-004 (P2): import cycles.** `src/orm.js` plus 85 of 89 model files form one cycle, with 12,989 elementary cycles. 82 of 93 core modules crash with a ReferenceError if imported first.
- **ARCH-005 (P2, latent): fail-open defaults.**
  - `applyDiff` defaults `isAdmin` to true (src/sync.js:44).
  - The company guard wrapper drops the guard's context argument (src/models/company.js:60).
  - Authorization is derived from UI menus.
  - None of these is exploitable today, because every user-facing call passes the flag.
- **ARCH-006 (P2): seed and schema drift.** Shipped seed data violates the current schema; 3 seeded documents cannot be re-saved.
- **ARCH-007 (P2): code hygiene.** No types, lint or formatting; extreme line lengths; divergent copy-pasted helpers.
- **ARCH-009 (P3): ad hoc engineering practices.** Error handling, logging, configuration and versioning are ad hoc.
- **Maintenance cost.** 149 commits in 33 hours by parallel agents, editing one hotspot line on `main` with no review (GOV-002), make regressions likely and hard to trace.

**Is the custom architecture appropriate for a large ERP? (ARCH-008)**

The defects found sit precisely in platform layers that mature ERP frameworks provide:
- server-side business methods and transactions;
- model × CRUD access rules, record rules and field groups;
- company isolation rules;
- database sequences;
- posted-entry constraints;
- a module dependency graph;
- versioned migrations.

Odoo Community (LGPL-3) plus OCA modules (mostly AGPL-3) would supply these layers. The trade-offs:
- a Python and PostgreSQL stack;
- yearly upgrade cost;
- Odoo's web client instead of Mizan's React views;
- several Enterprise-only apps that would need OCA equivalents or custom modules;
- licence obligations needing legal review, especially AGPL network-use terms.

**Statements about Odoo and OCA are auditor knowledge, not verified against their sources in this audit.** No migration or rewrite was started.

---

## M. Dependencies, licensing and legal

- **LIC-001 (P1): no licence.** The repository is public with no LICENSE file, while the README calls the project "open". By default this means all rights reserved, so others have no right to use it.
- **LIC-002 (P2, legal-review item): the clean-room claim.** README and SPEC say Mizan is clean-room, derived from browser observation ("REA captures") of a reference ERP. The audit found no Odoo code, assets or logos. Model and field names, however, match Odoo's (`account.move`, `sale.order`, `stock.picking`, `hr.payslip`, …), and the behaviour was deliberately derived from the reference product.
  - Professional review is recommended for naming and trade-dress, for the terms of service of any instance used for observation, and for whether the AI agents had access to Odoo Enterprise source.
  - The last point could not be verified. **No legal conclusion is drawn.**
- **LIC-003 (P3): dependency licences.** All dependency licences are permissive. Two follow-ups:
  - Apache-2.0 notices must be kept when redistributing.
  - The `@anthropic-ai/sdk` range should be pinned.

---

## N. GitHub and agent workflow

Measured against the project rules (never merge a PR, never push to main, never force push, never deploy):

| Rule / practice | Observed |
|---|---|
| Never push directly to `main` | **Deviated:** all 149 commits were pushed directly to `main` (GOV-002) |
| PR review | None; 0 PRs ever |
| Branch protection / rulesets | None (GOV-001) |
| CI checks | None (GOV-001) |
| Force pushes | None detectable from the shallow history; not fully verifiable via the REST API |
| Secrets in history | None found (GOV-003) |
| Worktree isolation / concurrent agents | Parallel agents edit the same hotspot (src/models/index.js:85 spread line) directly on `main`; local worktree state NOT VERIFIED |
| Issue tracking / releases | None; no tags or releases |
| Repository visibility | Public. Everything, including this audit once merged, is world-readable (GOV-003) |

---

## O. Complete findings register

- **Severity** is the consolidated severity.
- **Status** marks the primary record for a root cause, or names the primary it duplicates (`dup →`), or the finding it relates to (`rel →`).
- **Lead check ✔** means the lead auditor re-verified the finding against the source, independently of the workstream.

Full evidence, reproduction, expected and actual behaviour, impact, root cause, correction, dependencies, verification plan and confidence for every ID are in the workstream reports named in the "Stream" column.

**Unique findings: 100** (P0 9, P1 37, P2 42, P3 12). Merged duplicates: 16, listed at the end. Raw total: 116.

| ID | Severity | Title | Stream | Status | Lead check | Confidence |
|---|---|---|---|---|---|---|
| MIZAN-ACC-002 | P0 | Lock dates and the "hard lock" can be bypassed: paid status, archive, company and journal of locked entries stay writable | acct | primary · rel → SEC-001 | ✔ | Confirmed |
| MIZAN-DB-001 | P0 | Public endpoints commit a db captured before `await readJson`, silently reverting all concurrent changes | db | primary | ✔ | Confirmed |
| MIZAN-DB-002 | P0 | Client-chosen record ids: concurrent creates overwrite each other, corrupting posted ledgers | db | primary | ✔ | Confirmed |
| MIZAN-DB-006 | P0 | Sequence counters are client-asserted: any user can poison a model so every later create overwrites the previous one | db | primary | ✔ | Confirmed |
| MIZAN-MOD-001 | P0 | App allow-list over-grants: every restricted user can read and write employee PII and payroll data, and many apps grant write on invoices | modules | primary | ✔ | Confirmed |
| MIZAN-SEC-001 | P0 | No server-side workflow or field-level authorization: any user who can see a model forges posted financial/HR/stock state | sec | primary | ✔ | Confirmed |
| MIZAN-UI-001 | P0 | One failed request permanently stops all saving and polling, with nothing shown to the user | ui | primary | ✔ | Confirmed |
| MIZAN-UI-002 | P0 | A failed `/api/db` at startup loads demo data in server mode, and the next save overwrites real records | ui | primary | ✔ | Confirmed |
| MIZAN-UI-003 | P0 | Kanban drag-and-drop changes document state without running business logic (e.g., a draft invoice becomes "Posted" with no journal entries) | ui | primary · rel → SEC-001 | ✔ | Confirmed |
| MIZAN-ACC-005 | P1 | amount_paid is a stored counter, not derived from reconciled payments; the subledger drifts from the GL | acct | primary |  | Confirmed |
| MIZAN-ACC-006 | P1 | Bank reconciliation marks statement lines reconciled with the wrong amount, the wrong sign, or no entry at all | acct | primary |  | Confirmed |
| MIZAN-ACC-007 | P1 | Credit notes never offset the invoice they reverse; unlimited credit notes per invoice | acct | primary |  | Confirmed |
| MIZAN-ACC-008 | P1 | Journal items with a missing or unknown account are accepted and silently dropped from every report, so the trial balance and balance sheet stop closing | acct | primary |  | Confirmed |
| MIZAN-ACC-009 | P1 | Chart of accounts and taxes are writable and deletable by users of every app | acct | primary · rel → MOD-001 |  | Confirmed |
| MIZAN-ACC-010 | P1 | Fiscal-year closing breaks after server sync: `is_closing` is stripped, and a non-admin close does not lock the year | acct | primary · rel → DB-012 |  | Confirmed |
| MIZAN-ACC-012 | P1 | Consolidation output does not balance (no CTA, prior-year earnings dropped, one-sided equity method, no NCI) | acct | primary |  | Confirmed |
| MIZAN-ACC-013 | P1 | Multi-currency: every ledger is booked in the global `settings.currency`, so non-base companies are translated twice; journal items carry no currency amounts | acct | primary |  | Confirmed |
| MIZAN-ACC-014 | P1 | POS ignores configured tax records: price-included VAT is added on top, and fiscal positions and product accounts are ignored | acct | primary |  | Confirmed |
| MIZAN-ARCH-001 | P1 | Business logic and workflow authority live in the browser; the server is a record-shape validator | arch | primary · rel → SEC-001 |  | Confirmed |
| MIZAN-ARCH-002 | P1 | applyDiff validates a multi-model diff against partially applied state; Expenses "Create Report" always fails in server mode | arch | primary |  | Confirmed |
| MIZAN-DB-003 | P1 | No optimistic concurrency control: lost updates, stock races, stale replays and async handlers revert edits | db | primary |  | Confirmed |
| MIZAN-DB-004 | P1 | Document numbers computed client-side as count+1: duplicate invoice and payment numbers | db | primary |  | Confirmed |
| MIZAN-DB-005 | P1 | No referential integrity: deletes leave dangling references; references to missing ids are accepted | db | primary |  | Confirmed |
| MIZAN-DB-007 | P1 | Audit trail is asserted by the client, omittable, forgeable and deletable; no server-side change log or retention policy | db | primary |  | Confirmed |
| MIZAN-DB-009 | P1 | Single in-memory authority: a second process on the same SQLite file silently overwrites data | db | primary |  | Confirmed |
| MIZAN-DB-010 | P1 | Backup and restore: no server tooling, and the UI restore cannot restore more than 5 MB | db | primary |  | Confirmed |
| MIZAN-DB-012 | P1 | Business logic writes fields the server strips; the client and server diverge and flows break after sync | db | primary |  | Confirmed |
| MIZAN-FLOW-003 | P1 | Button `run()` handlers do not re-check state, so hidden transitions run when invoked (double Confirm, cancelling a paid invoice, paying a draft, producing a done MO twice) | flows | primary · rel → SEC-001 |  | Confirmed |
| MIZAN-FLOW-005 | P1 | Work orders cannot be started in server mode, so MOs with planned operations can never be produced | flows | primary |  | Confirmed |
| MIZAN-FLOW-006 | P1 | Deliveries can exceed the order, and the same delivery can be returned again and again; returns don't reduce delivered quantities | flows | primary |  | Confirmed |
| MIZAN-FLOW-011 | P1 | Inter-company purchase copies the seller's sales taxes: the buyer's bill debits output VAT (251000); rule errors are swallowed and the PO is not kept in sync | flows | primary |  | Confirmed |
| MIZAN-FLOW-012 | P1 | Subscription "Automatic Payment" posts fictitious bank receipts: the scheduler marks invoices paid with no payment provider | flows | primary |  | Confirmed |
| MIZAN-GOV-001 | P1 | No CI, no branch protection, no PR review: the Docker build is the only automated gate | arch | primary |  | Confirmed |
| MIZAN-LIC-001 | P1 | Public repository with no LICENSE while the README calls it "open" | arch | primary |  | Confirmed |
| MIZAN-MOD-002 | P1 | Approval authority is self-declared: approvers type an employee ID, and Time Off and Expense approvals are plain state writes | modules | primary |  | Confirmed |
| MIZAN-MOD-003 | P1 | Sign app is simulated: nothing reaches signers, staff "sign" in the signer's name, and reminders are logged as sent | modules | primary |  | Confirmed |
| MIZAN-MOD-004 | P1 | Barcode "Apply Count" changes on-hand stock without valuation or accounting | modules | primary |  | Confirmed |
| MIZAN-MOD-005 | P1 | Scheduler swallows job errors: one bad record silently stops a whole job (e.g. all recurring invoicing) | modules | primary |  | Confirmed |
| MIZAN-PERF-001 | P1 | Every write costs O(whole database) on the single event loop, and anonymous requests can trigger it | db | primary |  | Confirmed |
| MIZAN-PERF-002 | P1 | The whole database is replicated to every browser every 15 s and after every save | db | primary |  | Confirmed |
| MIZAN-SEC-002 | P1 | No server-side multi-company isolation; `allowed_company_ids` is a global, client-settable setting | sec | primary |  | Confirmed |
| MIZAN-SEC-008 | P1 | `/api/reset` silently wipes all business records (no confirmation, no backup) | sec | primary |  | Confirmed |
| MIZAN-TEST-001 | P1 | The tests exercise browser functions; the server enforcement path is barely tested | arch | primary |  | Confirmed |
| MIZAN-UI-004 | P1 | Settings "Restore backup": open to non-admins, no confirm, success shown before the server answers; unmodified backups are rejected | ui | primary · rel → DB-010 |  | Confirmed |
| MIZAN-UI-005 | P1 | Foreign-currency documents are shown with the company currency symbol and summed with company-currency amounts (form, list, kanban, dashboard, printed invoice) | ui | primary |  | Confirmed |
| MIZAN-UI-010 | P1 | Timesheet "Validate" stores a free-text validator name; "Reset to Draft" is admin-only only in the UI | ui | primary · rel → MOD-002 |  | Confirmed |
| MIZAN-ACC-015 | P2 | Rounding: the receivable line can differ from the document total, leaving cent residues after "paid"; the same happens for FX and cash-basis taxes | acct | primary |  | Confirmed |
| MIZAN-ACC-016 | P2 | VAT return halves disagree: the per-tax table comes from documents in their own currency, the totals from the journal | acct | primary |  | Confirmed |
| MIZAN-ACC-017 | P2 | POS-only and payroll-only users cannot complete sales or payslips (the whole diff is rejected) | acct | primary · rel → MOD-001 |  | Confirmed |
| MIZAN-ACC-018 | P2 | Negative amounts are accepted: negative debits and credits, and a negative-total customer invoice is shown as "Paid" | acct | primary |  | Confirmed |
| MIZAN-ACC-019 | P2 | Country-specific e-invoicing: ZATCA phase-1 QR only; no Egypt ETA or UAE e-invoicing. These are gaps, not compliance. | acct | primary |  | Strongly supported |
| MIZAN-ARCH-003 | P2 | Model composition by object-spread order is fragile: silent overrides, dead shadowed definitions, and regressions the tests do not catch | arch | primary |  | Confirmed |
| MIZAN-ARCH-004 | P2 | One giant import cycle: the ORM depends on every business module; most modules cannot be imported first | arch | primary |  | Confirmed |
| MIZAN-ARCH-005 | P2 | Fail-open authorization defaults at three layers (latent), and authorization derived from UI menus | arch | primary · rel → MOD-001 |  | Confirmed |
| MIZAN-ARCH-006 | P2 | Shipped seed data violates the current schema; data from earlier versions cannot be re-saved | arch | primary |  | Confirmed |
| MIZAN-ARCH-007 | P2 | Code quality: no types, lint or formatting; extreme line lengths; divergent copy-pasted helpers | arch | primary |  | Confirmed |
| MIZAN-ARCH-008 | P2 | Is this architecture appropriate for a large ERP? Evidence-based comparison with Odoo Community (LGPL-3) plus OCA (decision input only; nothing initiated) | arch | primary |  | Strongly supported |
| MIZAN-DB-011 | P2 | No schema-evolution strategy: in-memory migrations are never persisted, and schema changes lock or strip data | db | primary |  | Confirmed |
| MIZAN-FLOW-007 | P2 | Reservation is not enforced, waiting pickings can consume reserved stock, and periodic-valued products go negative silently | flows | primary |  | Confirmed |
| MIZAN-FLOW-013 | P2 | Subscription catch-up billing back-dates invoices, auto-closes in the same run, and Reopen bills the closed months | flows | primary |  | Confirmed |
| MIZAN-FLOW-014 | P2 | Manufacturing and refunds overwrite the cost of "Standard Price" products, and MOs accept zero component consumption without a warning | flows | primary |  | Confirmed |
| MIZAN-FLOW-015 | P2 | Purchased services can never be billed from the purchase order | flows | primary |  | Confirmed |
| MIZAN-FLOW-016 | P2 | The stock valuation report does not reconcile with the stock account: opening stock is never posted | flows | primary |  | Confirmed |
| MIZAN-GOV-002 | P2 | Commit hygiene and concurrent-agent risk: 149 unreviewed commits in 33 hours, parallel agents editing one hotspot line on main | arch | primary |  | Confirmed |
| MIZAN-LIC-002 | P2 | Clean-room claim: Odoo naming and behavioural derivation are legal-review items (no legal conclusion) | arch | primary |  | Strongly supported |
| MIZAN-MOD-006 | P2 | Features that look complete are simulated, and the UI never says so | modules | primary |  | Confirmed |
| MIZAN-MOD-007 | P2 | 86 tested business functions are unreachable from the UI and server, so tests overstate maturity | modules | primary |  | Confirmed |
| MIZAN-MOD-008 | P2 | Server-side rule coverage per module is thin: 57 of 85 workflow models have no guard, and 8 "guards" only check the company | modules | primary · rel → SEC-001 |  | Confirmed |
| MIZAN-PERF-003 | P2 | Scheduled jobs block the event loop at boot and hourly, with super-linear cost | db | primary |  | Confirmed |
| MIZAN-PERF-004 | P2 | No indexes: id lookups and text search are linear scans | db | primary |  | Confirmed |
| MIZAN-PERF-005 | P2 | Hard capacity ceiling: past 200 M JSON characters every write fails; attachments count inline | db | primary |  | Confirmed |
| MIZAN-SEC-004 | P2 | Brute-force / rate limiting is in-process memory only and keyed per client IP | sec | primary |  | Confirmed |
| MIZAN-SEC-005 | P2 | Generated admin password printed to stdout/logs on first start | sec | primary |  | Confirmed |
| MIZAN-SEC-006 | P2 | Outbound integrations: `MIZAN_SHIPPING_TOKEN` sent to a non-admin-set URL; SSRF guard misses ranges and has a DNS-rebinding/TOCTOU gap | sec | primary |  | Confirmed |
| MIZAN-SEC-007 | P2 | No password-change and no session/API-key revocation path for a user's own or others' sessions | sec | primary |  | Confirmed |
| MIZAN-TEST-002 | P2 | Date time bombs: the suite fails from 2026-12-02, so Docker builds will break; historical commits can no longer be re-verified | arch | primary |  | Confirmed |
| MIZAN-TEST-003 | P2 | Hidden ordering dependency: server/website.test.js needs a prior `vite build` | arch | primary |  | Confirmed |
| MIZAN-TEST-004 | P2 | Assertion quality: mostly real behaviour, but invariants are checked only on seed data, definition checks target module-local objects, and some asserts are tautologies | arch | primary |  | Confirmed |
| MIZAN-UI-008 | P2 | What users see on `/api/diff` errors: native English alert, the edit silently reverted, success shown before the server confirms | ui | primary |  | Confirmed |
| MIZAN-UI-011 | P2 | General Settings "Company Name" and "Currency" are dead or misleading controls; two company names shown at once | ui | primary |  | Confirmed |
| MIZAN-UI-012 | P2 | Arabic translation coverage: 226 of 2,371 `t()` strings untranslated; prompts, chatter notes and almost all errors are English-only | ui | primary |  | Confirmed |
| MIZAN-UI-013 | P2 | RTL and number formatting: negative amounts render as "$1,800.00-"; Arabic-Indic digits and thousands separators silently rejected | ui | primary |  | Confirmed |
| MIZAN-UI-014 | P2 | Mobile: app sub-menus hidden below 640 px with no replacement; form views overflow horizontally | ui | primary |  | Confirmed |
| MIZAN-UI-015 | P2 | Accessibility: keyboard, focus management, form semantics and contrast | ui | primary |  | Confirmed |
| MIZAN-UI-016 | P2 | 22 models default to Kanban without a kanban spec; the screen crashes once a record exists | ui | primary |  | Confirmed |
| MIZAN-UI-017 | P2 | Large lists: no pagination or virtualization; decorative pager; whole DB re-rendered and re-diffed on every change | ui | primary · rel → PERF-002 |  | Confirmed |
| MIZAN-UI-018 | P2 | Single 1.10 MB bundle, no code splitting, no loading or error state at startup | ui | primary |  | Confirmed |
| MIZAN-UI-019 | P2 | Business inputs collected through native `prompt()`, English-only, with raw IDs and silent failure | ui | primary |  | Confirmed |
| MIZAN-ACC-020 | P3 | Minor accounting defects (bundle) | acct | primary |  | Confirmed |
| MIZAN-ARCH-009 | P3 | Error handling, logging, configuration and versioning are ad hoc; docs misstate the dependency footprint | arch | primary |  | Confirmed |
| MIZAN-DB-013 | P3 | No idempotency or outbox: interrupted sends are recorded as delivered, and API retries duplicate records | db | primary |  | Strongly supported |
| MIZAN-FLOW-017 | P3 | Missing steps and minor workflow gaps | flows | primary |  | Confirmed |
| MIZAN-GOV-003 | P3 | Public exposure and secrets in history: no secrets found; notes on what the public repo reveals | arch | primary |  | Confirmed |
| MIZAN-LIC-003 | P3 | Dependency licences and audit: permissive, but Apache-2.0 notices and an unbounded SDK range need handling | arch | primary |  | Confirmed |
| MIZAN-MOD-009 | P3 | README, registry and app-store drift | modules | primary |  | Confirmed |
| MIZAN-SEC-009 | P3 | Dependency advisories (dev-time only) and dependency surface | sec | primary |  | Confirmed |
| MIZAN-TEST-005 | P3 | Coverage numbers overstate assurance; 22% of the source is never loaded by any test | arch | primary · rel → MOD-007 |  | Confirmed |
| MIZAN-UI-020 | P3 | Dashboard KPI semantics: credit notes ignored, tiles link to unfiltered lists | ui | primary |  | Strongly supported |
| MIZAN-UI-021 | P3 | Identity and shell inconsistencies: hard-coded "Admin" avatar, activities always assigned to user 1, logout buried | ui | primary |  | Confirmed |
| MIZAN-UI-022 | P3 | Minor simulated or cosmetic actions | ui | primary · rel → MOD-006 |  | Confirmed |
| MIZAN-ACC-001 | P0 (merged) | Posted journal entries and invoices are fully mutable through /api/diff (no posted-entry immutability, no balance check, amount_paid is a free field) | acct | dup → SEC-001 | ✔ | Confirmed |
| MIZAN-ACC-003 | P0 (merged) | Concurrent postings silently overwrite each other's posted entries (client-assigned ids + last-writer-wins) | acct | dup → DB-002 |  | Confirmed |
| MIZAN-FLOW-001 | P0 (merged) | Workflow state machines exist only in the browser; the server accepts forged postings, stock and state from non-admins | flows | dup → SEC-001 |  | Confirmed |
| MIZAN-FLOW-002 | P0 (merged) | Two users working from the same snapshot ship the same stock twice and overwrite each other's posted journal entries (ID collision + last-writer-wins) | flows | dup → DB-002 |  | Confirmed |
| MIZAN-ACC-004 | P1 (merged) | Duplicate invoice and entry numbers (count-based sequence, no uniqueness check) | acct | dup → DB-004 |  | Confirmed |
| MIZAN-ACC-011 | P1 (merged) | The audit trail is written by the client: changes can be made without a trace, and backdated entries can be injected | acct | dup → DB-007 |  | Confirmed |
| MIZAN-DB-008 | P1 (merged) | Multi-company isolation is absent at the data layer: company selection is global, and flows stamp company 1 | db | dup → SEC-002 |  | Confirmed |
| MIZAN-FLOW-004 | P1 (merged) | The server's record sanitizer silently drops workflow fields the models write but do not declare: gift cards become reusable, POS refunds are mis-valued, rented products can no longer be delivered | flows | dup → DB-012 |  | Confirmed |
| MIZAN-FLOW-008 | P1 (merged) | Credit notes are unlimited and never reconciled with the invoice; the invoice stays fully due after it is credited | flows | dup → ACC-007 |  | Confirmed |
| MIZAN-FLOW-009 | P1 (merged) | Multi-company: new and generated records always get company 1, so company-2 sales, deliveries, invoices, payments and journal entries land in company 1's books | flows | dup → SEC-002 |  | Confirmed |
| MIZAN-FLOW-010 | P1 (merged) | No company isolation: the server returns all companies, the company selection is a single global setting any user can change, and the Reports page mixes companies | flows | dup → SEC-002 |  | Confirmed |
| MIZAN-SEC-003 | P1 (merged) | `removedMessages` and `seq` bypass the per-model `allowed` set | sec | dup → DB-006 |  | Confirmed |
| MIZAN-UI-006 | P1 (merged) | Barcode app "Apply Count" changes on-hand quantity with no valuation entry (the product form path creates one) | ui | dup → MOD-004 |  | Confirmed |
| MIZAN-UI-007 | P1 (merged) | Subscriptions "Automatic Payment" books bank receipts without charging anyone | ui | dup → FLOW-012 |  | Confirmed |
| MIZAN-UI-009 | P1 (merged) | "Reset demo" wipes the production database after a single confirm | ui | dup → SEC-008 |  | Confirmed |
| MIZAN-PERF-006 | P3 (merged) | Client bundle served uncompressed and without cache headers | db | dup → UI-018 |  | Confirmed |

---

## P. Remediation roadmap (dependency-aware; nothing here has been started)

**Step 0: decide the architecture first (ARCH-008).** Phases 1 and 2 below are, in effect, building a server-authoritative ERP platform. Decide that before investing in incremental fixes. The two options:
- **(A)** Re-platform Mizan itself: server-side commands, ACLs and record rules, PostgreSQL with transactions and sequences, migrations.
- **(B)** Adopt Odoo Community plus OCA, with Mizan-specific modules, after a legal review.

A short spike that implements quotation → invoice → payment under both options, with the integrity tests from this report, is the recommended way to decide.

### P0: immediate blockers (before any real data or real users)

1. **Containment:**
   - Do not run Mizan with real financial or HR data.
   - Until P0 and P1-F1/F2 are fixed, give accounts only to fully trusted users. Every non-admin can forge records, and every restricted user can read HR private data.
   - Back up the SQLite file before every change.
2. **DB-001:** read the body before capturing `db` at the eight public endpoints, or re-read `db` after the await.
3. **UI-001 / UI-002:**
   - Add `catch` and retry with user-visible errors to the store chain.
   - Never fall back to demo data in server mode.
4. **DB-006 / SEC-003:** enforce `allowed` on `seq` and messages, and bound `seq` on the server. Recover any poisoned counters.
5. **DB-002:** let the server assign record ids, and refuse client-supplied ids for creates.
6. **UI-003:** forbid Kanban drag on workflow/state group-bys, or route the drag through the model's action.
7. **ACC-002:** extend `LOCKED_FIELDS` to `amount_paid`, `active`, `company_id`, `journal_id` and all accounting-relevant fields.
8. **MOD-001 interim:** replace relation closure with an explicit reviewed whitelist, so that restricted users lose HR and accounting models.
9. **SEC-001 interim:** strip or refuse client writes to readonly fields (`amount_paid`, `qty_available`, `state` on posted moves) in `cleanRecord`.

### P1: foundational corrections (each unlocks many findings)

| ID | Foundation | Fixes / unlocks |
|---|---|---|
| F1 | Server-authoritative business commands: post, confirm, validate, pay, approve, produce and so on run on the server; clients cannot write workflow state directly | SEC-001, ARCH-001, MOD-008, FLOW-003, ACC-005/006/007/008/018, FLOW-005/006/007/012/015 |
| F2 | Access model: per-app read/write ACLs, record rules, field groups for HR and finance, a user↔employee link, server-derived actor | MOD-001, ACC-009, ACC-017, MOD-002, UI-010, ARCH-005 |
| F3 | Server-side company isolation: per-user allowed companies, company stamping, filtered reads and reports | SEC-002 cluster, ACC-013, FLOW-011, ACC-012 |
| F4 | Concurrency: server ids, record versions with conflict errors, database sequences for numbers, idempotency keys | DB-002/003/004, DB-013, ACC-003/004 |
| F5 | Server-side audit log (who, when, before→after), immutable | DB-007, ACC-011 |
| F6 | Schema discipline: declare every written field, referential checks, a versioned migration framework, seed validated against the schema | DB-012, DB-005, DB-011, ARCH-006, ACC-010, FLOW-004 |
| F7 | Engineering gates: GitHub Actions running build and test on every PR, branch protection on `main`, PR-only agent workflow, HTTP-level authorization, concurrency and accounting-invariant tests, removal of the date bombs | GOV-001/002, TEST-001…005 |
| F8 | Scheduler and operations: per-record job isolation with failure logs, safe backup and restore (admin-only, streaming, verified), reset disabled in production | MOD-005, DB-010, UI-004, SEC-008 |
| F9 | Licence decision: add a LICENSE and commission the legal review | LIC-001, LIC-002 |

Order: F7 first, so that every later fix lands behind CI. Then F4 and F2 in parallel. F1 depends on F2 (actor and permissions) and F4 (ids and versions). F3 and F5 come next. F6 runs alongside F1. F8 can go in any time after F7.

### P2: important improvements

- Accounting correctness on the honest path (ACC-012…016, FLOW-013/014/016).
- Honest states for simulated features (MOD-003, MOD-006, MOD-007).
- Performance:
  - pagination and incremental sync instead of whole-DB replication (PERF-001…005, UI-017);
  - code splitting, compression and caching (UI-018).
- UX error handling (UI-008, UI-019).
- Arabic coverage and number formatting (UI-012, UI-013).
- Accessibility (UI-015).
- Mobile (UI-014).
- Kanban crashes (UI-016).
- Security hardening: persistent rate limiting (SEC-004), no password in logs (SEC-005), SSRF and token scoping (SEC-006), password change and revocation (SEC-007).
- Code structure (ARCH-002…004, ARCH-007).

### P3: optional and cosmetic

README and registry drift (MOD-009), shell inconsistencies (UI-021, UI-022), DB-013 hardening, PERF-006, ARCH-009, the LIC-003 notices, GOV-003 and the remaining P3s in the register.

---

## Q. Final technical verdict

**NOT READY FOR PRODUCTION.**

- **Data integrity cannot be guaranteed.** Any user can forge posted accounting, payroll and stock data (SEC-001), and concurrent normal use overwrites posted entries and duplicates numbers (DB-002, DB-004). Financial statements are therefore not trustworthy as a system of record.
- **Confidentiality is not enforced.** Every restricted user can read and modify HR private data (MOD-001), and companies are not isolated (SEC-002).
- **Silent data loss paths exist** in both the server (DB-001) and the client (UI-001, UI-002).
- **No engineering safeguards exist** to stop regressions: no CI, no review, no branch protection, and tests that do not exercise the enforcement path.

**Architecture: requires architecture reconsideration.**

The highest-severity findings are not local bugs. They follow directly from three design choices:
1. browser-authoritative business logic;
2. client-asserted identity, ids and numbers;
3. a whole-database in-memory store with last-writer-wins.

Fixing them means building server-side commands, ACLs and record rules, transactions, sequences, versioning and migrations: the core of an ERP platform. That is a re-architecture, not a refactor, and it should be decided deliberately (Step 0 in section P) before the remediation phase is authorized.

What is reusable:
- the domain modelling;
- the accounting computations, which are correct on honest inputs;
- the views and their RTL work;
- the large body of model-level tests, as executable specifications.

---

## What was and was not verified

**Verified in this audit:**
- The GitHub repository state at `0e9f748`.
- Build, tests and coverage, executed.
- All findings in the register:
  - most by scripts run against the real modules;
  - several by a live server instance on a random port with a temporary database;
  - the UI findings in Chromium via Playwright;
  - all nine P0s re-checked by the lead auditor against the source.

**Not verified:**
- Local or unpushed work on the owner's PC.
- Docker image behaviour.
- Real third-party integrations.
- Browsers other than Chromium, and screen readers.
- Load and saturation under concurrent users.
- Country tax rules against official specifications.
- Odoo and OCA facts (auditor knowledge only).
- Whether AI agents had access to proprietary source.
- Some GitHub settings (proxy-refused endpoints).
