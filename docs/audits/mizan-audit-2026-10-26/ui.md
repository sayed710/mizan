# Mizan audit, workstream "ui" (Frontend, UX, Arabic/RTL, Accessibility)

Audited commit 0e9f748 (read-only). Dynamic work ran only in my copy (`scratchpad/work-ui`): `vite preview` (browser-only demo mode) on port 48496, and the copy's own server (`node server/index.js`, its own SQLite file in the scratchpad) on port 49082. Both are stopped now. Scripts are in `scratchpad/ui-scripts/`, and raw outputs, screenshots and crawl JSON are in `scratchpad/audit/ui-*`.

## Summary
- **Two P0 sync defects in `src/store.js`:** (1) one failed network request, either a 15 s background poll or a save, permanently stops all later saves and polls. Nothing is shown, and the UI still looks saved. (2) If `GET /api/db` fails once at startup, the app quietly loads the demo seed data while in server mode, and the next save overwrites real server records with demo values. Both were reproduced in Chromium against the real server.
- **P0: Kanban drag-and-drop skips business logic.** Grouping by Status and dragging a card writes `state` directly. A non-admin dragged a draft invoice into "Posted", and the server stored `state: posted`, `name "/"` with 0 journal items. In node, the server accepted 107 of 108 drag transitions across 16 workflow models (30 models expose this).
- **Amounts in a foreign currency are shown in the company currency and added together with company-currency amounts.** This affects the form, list totals, kanban, dashboard KPIs, top customers and the printed customer invoice. Example: a SAR 37,500 invoice, booked as a $10,000 receivable, shows and prints as "$37,500.00 / USD", and the dashboard "Receivable" is overstated by $27,500.
- **Simulated or disconnected actions:** subscriptions "Automatic Payment" books bank receipts without charging anyone; Barcode "Apply Count" changes on-hand quantity without any valuation entry; timesheet "Validate" stores a free-text validator name, and "Reset to Draft" is admin-only in the UI only; General Settings "Company Name" and "Currency" change nothing on documents.
- **Destructive one-click actions:** "Reset demo" wipes a production database after one confirm. "Restore backup" is open to non-admins, has no confirm, reports success before the server answers, and a non-admin restore can delete about 91% of the records. Restoring an unmodified backup is itself rejected because of seed and schema drift.
- **Error UX:** a 400 from `/api/diff` produces a native `alert()` with a raw English message such as "Invalid value for documents.document.tag_ids", and the user's edit is silently reverted.
- **Arabic:** RTL is well built: 101 logical CSS properties and 0 physical ones, with `dir`/`lang` set. Gaps: 226 of the 2,371 strings that reach `t()` are untranslated (9.5%), and so are 73 native prompts/alerts, 23 chatter templates and 579 of 641 error messages. Negative amounts render as "$1,800.00-" in RTL, and Arabic-Indic digits are silently rejected.
- **A11y:** list rows cannot be opened from the keyboard; menus and panels lack Escape, arrow-key and focus handling; required fields carry no `required` attribute (0 of 55); there are 269 orphan labels; `--warn`, `--success` and `--border` fail contrast, as does dark-mode white on `--brand`.
- **Mobile, performance and bundle:** below 640 px the app sub-menus are hidden with no replacement, and form views overflow at 375 px. There is no pagination: 5,000 contacts produce 40k DOM nodes in about 1.3 s. The whole app ships as one 1.10 MB chunk (321 KB gzip) with no code splitting and no loading state. 22 models crash in Kanban once they have one record.

## What I verified / what I could not verify
Verified dynamically (scripts were run and their output is quoted below):
- In Chromium with the copy's server: sync stall after a failed poll or save, demo fallback with overwrite at startup, a real-mouse Kanban drag to Posted by a non-admin, the 400 alert and revert, a >5 MB diff rejecting the fetch, non-admin settings being silently discarded, Reset demo wiping data.
- In Chromium, browser-only demo mode: a crawl of all 270 menu routes and 106 first-record forms in Arabic; the SAR invoice display (form, list, dashboard, print); bidi of negative numbers; the payment prompt with Arabic digits and with "1,000"; keyboard tests; mobile overflow; a 5,000-record performance test; EN and AR screenshots.
- In node, against the copy's modules: i18n coverage, contrast ratios, drag transitions through `applyDiff`, restore-backup effects, timesheet admin reset, auto-payment, barcode count against valuation, FX amounts.

Not verified:
- Firefox and Safari behaviour (Arabic-Indic digits in number inputs may differ there).
- Screen-reader output. No axe-core was installed (no network); I used manual DOM checks instead.
- Real SMTP, AI or WhatsApp actions.
- Multi-user concurrency beyond the scenarios above.
- Whether `payment_state` drag-drops have any effect (it is probably a computed field).
- Whether the ZATCA QR uses a foreign-currency total (only read in code, qr.js:27; labelled as a hypothesis).

---

### MIZAN-UI-001 One failed request permanently stops all saving and polling, with nothing shown to the user
- Severity: P0
- Category / Component: Client sync / `src/store.js`
- Evidence:
  - `store.js:83`: `setInterval(() => { if (document.visibilityState === 'visible') inflight = inflight.then(pull); }, POLL_MS);`
  - `store.js:110-115`: `inflight = inflight.then(async () => { ... const r = await api('/api/diff', diff); ... })`
  - `api()` (`store.js:58-65`) does not catch `fetch` rejections. A rejected `inflight` skips every later `.then(fn)`, so every later save and poll is dropped. There is no `.catch` anywhere in the chain and no `unhandledrejection` handler.
  - The server makes this easy to trigger: an oversized body is answered with `req.destroy()` (`server/index.js:183`). My 6 MB `/api/diff` produced `fetch rejected: TypeError: Failed to fetch`.
  - Run output, `ui-scripts/pollfail.cjs` (one `/api/db` poll aborted, then a name edit and Save):
    ```
    requests: ["GET db @15s","GET db @34s"]      <- no POST /api/diff was ever issued; the @34s GET is my verification fetch
    UI shows: "Delta Office Supplies after-blip" | server has: "Delta Office Supplies" | dialogs: []
    ```
  - `ui-scripts/server-ux.cjs` part C (first `/api/diff` aborted, then 3 saves): `/api/diff requests issued after the failure: 1`, server has none of X1–X3, the UI shows "X3", and `/api/db polls in next 16 s: 0`.
- Reproduction:
  1. Log in.
  2. Toggle Wi-Fi or sleep the laptop for a moment while the tab is visible. Alternatively, attach files totalling more than 5 MB to one record, or import a large CSV.
  3. Keep editing.
  4. Reload the page: every edit made after the failure is gone.
- Expected / Actual: Expected: retry with a visible "offline / not saved" state. Actual: the session keeps going, every later edit stays only in memory, polling is dead, and there is no message.
- Impact: Silent data loss of every change after one transient network error. In a multi-user system the user also stops seeing everyone else's changes.
- Root cause: Verified. The promise chain is used as a mutex without rejection handling, and pull and commit share that chain.
- Recommended correction:
  - Wrap each queued task in `try/catch`, e.g. `inflight = inflight.then(task).catch(report)`.
  - Mark the UI as "unsaved / offline", keep a queue of pending diffs and retry with backoff.
  - Add a global `unhandledrejection` reporter.
  - On the server, answer 413 instead of destroying the socket.
- Dependencies: UI-008 (error UX).
- Verification plan: Re-run `pollfail.cjs` and `server-ux.cjs`. After the fix, POST `/api/diff` must appear after the blip, the server must hold the edit, and the user must see a status if the retry still fails.
- Confidence: Confirmed

### MIZAN-UI-002 A failed `/api/db` at startup loads demo data in server mode, and the next save overwrites real records
- Severity: P0
- Category / Component: Client bootstrap / `src/store.js`
- Evidence:
  - `store.js:76-91`: `mode = 'server'` is set and `await pull()` runs inside `try`. On any throw, the `catch` falls through to `db = loadLocal()` (`store.js:90`), which returns the localStorage demo copy or `seed()` (`store.js:48-56`). `mode` stays `'server'` and polling is never registered, because `setInterval` comes after `await pull()`.
  - `commit()` then diffs from the demo snapshot and upserts whole records (`sync.js:21-23`, last-writer-wins).
  - Run output, `ui-scripts/initfail.cjs`:
    ```
    server before: {"name":"Nile Furniture Co.","phone":"+20 2 REAL-PHONE","city":"Cairo"}
    partner 1 phone shown in UI: "+20 2 2345 6789"          <- seed value
    server after a save from that session: {"name":"Nile Furniture Co. (renamed)","phone":"+20 2 2345 6789",...} | dialogs: []
    ```
- Reproduction: Log in, then reload while `/api/db` fails once (network blip or proxy reset). Open any record and save a small change: the server record's other fields revert to demo values.
- Expected / Actual: Expected: an error screen with Retry, and never local data in server mode. Actual: demo data is shown as if it were real, and real data is overwritten.
- Impact: Silent corruption of shared data. Users also make decisions on demo figures.
- Root cause: Verified. A single `try` covers both "no backend" detection and the "backend reachable but `/api/db` failed" case.
- Recommended correction:
  - Only fall back to local mode when `/api/session` is non-JSON.
  - Once `mode === 'server'`, show a blocking "cannot load data — retry" state.
  - Never call `loadLocal()` in server mode.
  - Consider per-record version checks on the server (see the brief: there is no version check).
- Dependencies: UI-001; server last-writer-wins (ARCH/DB workstreams).
- Verification plan: Re-run `initfail.cjs`. The UI must show an error, and the server record must be unchanged.
- Confidence: Confirmed

### MIZAN-UI-003 Kanban drag-and-drop changes document state without running business logic (e.g., a draft invoice becomes "Posted" with no journal entries)
- Severity: P0
- Category / Component: Kanban view / `src/views/Kanban.jsx` + server guard gap
- Evidence:
  - `Kanban.jsx:68`: `const DROPPABLE = ['selection', 'many2one', 'char', 'boolean'];`
  - `Kanban.jsx:101`: `if (id && canDrop) commit(write(getDb(), model, id, { [groupBy]: value }));`
  - `orm.js:156` creates a column for every selection option, including "Posted", "Cancelled", "Approved" and "Done". `ControlPanel.jsx:68-70` offers "Status" in Group By.
  - `ui-scripts/drag-surface.mjs`: 30 models with workflow buttons can be grouped by state and dragged. Examples: account.move, account.payment, sale.order, purchase.order, stock.picking, hr.payslip, hr.expense, hr.leave, approval.request, account.asset, account.loan.
  - Run output, real mouse drag as the non-admin user `clerk` (`ui-scripts/drag-browser.cjs`):
    ```
    server before: [... "6:/:draft:lines=0"]
    columns: Draft(1) Posted(2) Cancelled(0)  ->  after drag: Draft(0) Posted(3)
    server after:  [... "6:/:posted:lines=0"] | dialogs: []
    ```
  - `ui-scripts/drag-all.mjs`, the same write sent through `applyDiff` as a non-admin: `TOTAL drops tried=108 accepted by server=107`. Examples: account.move posted→draft and posted→cancel; hr.leave confirm→validate; approval.request pending→approved; hr.expense submitted→approved; pos.order draft→paid; stock.picking ready→done; account.payment posted→draft.
  - `moveGuard` (`src/models/finance.js:40-47`) only checks lock dates and the audit-trail numbering.
- Reproduction: Accounting > Invoices > Kanban > search panel > Group By "Status" > drag a Draft card onto "Posted". Screenshot: `audit/ui-shots/kanban-drag-posted.png`.
- Expected / Actual: Expected: state changes only through workflow actions (or drag disabled on state fields), and the server rejects direct state edits. Actual: a "posted" invoice with no number and no ledger lines; it is counted in the dashboard and invoice analysis but missing from the GL. Any user can also approve their own leave or approvals.
- Impact: Forged or inconsistent posted financial data and approvals through an ordinary UI gesture. Reports stop reconciling.
- Root cause: Verified. The UI allows writes to state fields, and the server has no state-transition guards (only 56 of 180 models have a guard, and those mostly validate shape).
- Recommended correction:
  - Exclude `state`/`status` fields from `DROPPABLE`, or map drops to the model's own workflow actions.
  - On the server, reject `state` changes that do not come from an allowed transition (state machine per model, with permission checks).
- Dependencies: ACCT/FLOWS/SEC findings on missing server-side guards; UI-010.
- Verification plan: Re-run `drag-browser.cjs` and `drag-all.mjs`; accepted transitions should be 0 for illegal ones.
- Confidence: Confirmed

### MIZAN-UI-004 Settings "Restore backup": open to non-admins, no confirm, success shown before the server answers; unmodified backups are rejected
- Severity: P1
- Category / Component: Settings / `src/views/Settings.jsx`
- Evidence:
  - `Settings.jsx:119-124`: `const data = JSON.parse(await file.text()); if (!isDb(data)) throw ...; commit(data); setStatus(t('Backup restored.'));`
  - The Settings page is always available to every user. `Home.jsx` keeps `settings` for everyone, and the Restore button has no admin check (`Settings.jsx:219-223`). `commit()` sends `diffDb(current, file)`: deletes for every record missing from the file and full upserts for the rest.
  - `ui-scripts/restore-wipe.mjs` (non-admin, `allowed=null`, a backup that keeps only the 4 `protectDelete` models): `records before: 344 ... records after = 30`.
  - `ui-scripts/restore-roundtrip.mjs` (Download backup, then Restore the same file as admin): `upserted records in the diff: 344 ... restore of an unmodified backup REJECTED: Invalid value for documents.document.tag_ids`. Seed documents store tags as strings, while `signplus.js:304` redefines `tag_ids` as one2many lines.
  - The live server's `MAX_BODY` is 5 MB (`server/index.js:49`). A realistic backup larger than that triggers UI-001.
- Reproduction:
  1. Log in as a non-admin user.
  2. Settings > Restore backup with an older file: everyone's newer records are deleted or reverted.
  3. With an unmodified backup: you get the alert "Invalid value for documents.document.tag_ids", while "Backup restored." stays on screen.
- Expected / Actual: Expected: admin-only, a server-side restore endpoint, an explicit confirmation with record counts, and success shown after the server confirms. Actual: none of these.
- Impact: Mass deletion or revert of shared data by any user. The feature also fails for real use.
- Root cause: Verified. Restore is implemented as a client-side whole-db commit, and the server has no per-model write or delete permission for non-admins.
- Recommended correction: Move restore to an admin-only server endpoint, with a validation and migration step for older schemas, a dry-run summary and a typed confirmation.
- Dependencies: SEC (missing per-model write/delete permissions); DB/MODULES (seed vs schema drift on `documents.document.tag_ids`); UI-001.
- Verification plan: Re-run both scripts. A non-admin must get 403. A round-trip restore must succeed.
- Confidence: Confirmed

### MIZAN-UI-005 Foreign-currency documents are shown with the company currency symbol and summed with company-currency amounts (form, list, kanban, dashboard, printed invoice)
- Severity: P1
- Category / Component: Formatting / `src/ui.jsx`, `Dashboard.jsx`, `List.jsx`, `Kanban.jsx`, `PrintDoc.jsx`, `models/accounting.js`, `models/finance.js`
- Evidence:
  - `ui.jsx:10-16`: one global `moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: <company> })` is used for every amount. Document `currency_id` (`accounting.js:239`) is never consulted.
  - `accounting.js:24`: `const money = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });`. It is used in the payment prompt (`:149`) and in persisted chatter notes (`:92`, `:144`), so USD is used even for EGP companies.
  - Places that sum document-currency amounts:
    - Dashboard: `Dashboard.jsx:43,47-48`, which sums `amount_total` and `amount_residual`.
    - List totals: `List.jsx:19-22`.
    - Kanban: `Kanban.jsx:116`.
    - Aged balance, journal cards and follow-ups: `finance.js:96-97,118,135`.
    - Printed invoice: `PrintDoc.jsx:92` shows the company currency code, and `:113,120` show `money(...)`.
  - Run output, `ui-scripts/fx-display.mjs`: SAR invoice `amount_total 37500`, receivable journal line `{"debit":10000}`, rendered as `$37,500.00`.
  - Run output, `ui-scripts/fx-browser.cjs` (in browser):
    ```
    FORM  currency "SAR" | totals "Tax Excluded | $37,500.00 | ... | Total | $37,500.00 | Amount Due | $37,500.00"
    DASHBOARD Invoiced this month: $45,366.00 | Receivable: $38,710.00   (true: $17,866 / $11,210)
    ```
  - `print-fx.cjs`: the printed invoice header shows "Mizan Demo Co / USD" and every amount is "$37,500.00". Screenshot: `audit/ui-shots/print-sar-invoice.png`.
- Reproduction: Create an invoice with Currency = SAR (or EUR), post it, then open the form, Dashboard and Print.
- Expected / Actual: Expected: document amounts in the document currency (ISO code or symbol). Aggregates converted to company currency using the booked rates, or using company-currency fields. Actual: the wrong symbol, plus mixed-currency sums.
- Impact: Misleading KPIs (receivable overstated by $27,500 in the test), a wrong currency on customer-facing invoices, and USD in audit-trail notes. This misleads business decisions and could have legal effect.
- Root cause: Verified. There is no currency-aware formatter, and aggregates use document-currency fields.
- Recommended correction:
  - Add `formatMoney(amount, currencyCode, locale)`.
  - Store or compute company-currency amounts (`amount_total_signed`) for aggregates.
  - Remove the USD `money` in accounting.js.
  - Print the document currency on invoices.
  - Hypothesis to check: the ZATCA QR (`qr.js:27`) also encodes `amount_total` without a SAR check.
- Dependencies: ACCT (reports and aging on `amount_residual`).
- Verification plan: Re-run `fx-browser.cjs` and `print-fx.cjs`. Expect "SAR 37,500.00" on the document and a $11,210 receivable.
- Confidence: Confirmed

### MIZAN-UI-006 Barcode app "Apply Count" changes on-hand quantity with no valuation entry (the product form path creates one)
- Severity: P1
- Category / Component: Inventory UI / `src/views/Pages.jsx`
- Evidence:
  - `Pages.jsx:35-36`: `const next = write(getDb(), 'product', product.id, { qty_available: counted }); commit(postNote(next, ..., \`Inventory adjustment: ...\`));`
  - Compare the product form's "Update Quantity" (`sales.js:285-291`), which calls `adjustQuantity()` ("so stock valuation follows the new quantity").
  - Run output, `ui-scripts/barcode.mjs`:
    ```
    before           {"moves":0,"layers":4,"entries":9}
    Barcode app      {"moves":0,"layers":4,"entries":9} qty 145
    Update Quantity  {"moves":0,"layers":5,"entries":10} qty 145
    ```
- Reproduction: Barcode app > scan a product > set the count > Apply Count. Then compare the stock valuation report with quantity × cost.
- Expected / Actual: Expected: the same inventory adjustment as the product form, with a valuation layer and a journal entry. Actual: only the quantity changes, and the chatter note claims "Inventory adjustment".
- Impact: Inventory value in the GL drifts from quantity on hand, and there is no stock-move audit trail.
- Root cause: Verified. The view writes the field directly instead of calling the model action.
- Recommended correction: Call `adjustQuantity(db, id, counted, {reference})`, and make `qty_available` readonly for direct writes on the server.
- Dependencies: ACCT/MODULES (valuation).
- Verification plan: Re-run `barcode.mjs` against the Barcode path. The layer and entry counts must increase.
- Confidence: Confirmed

### MIZAN-UI-007 Subscriptions "Automatic Payment" books bank receipts without charging anyone
- Severity: P1
- Category / Component: Simulated feature / `src/models/subscriptionplus.js`
- Evidence:
  - `subscriptionplus.js:209`: `payment_token: { type: 'boolean', label: 'Automatic Payment' }`.
  - `:68` and `:88`: `if (sub.payment_token) next = payMove(next, billed.id, ...amount_residual, date);`, with the code comment "optional mock auto-payment" (`:72`).
  - This runs hourly from the scheduler: `scheduler.js:40` calls `subscriptionJobs` (`subscriptionplus.js:180`).
  - Run output, `ui-scripts/autopay.mjs`:
    ```
    new moves: INV/2026/00003 ... state=posted paid=112.86/112.86 | BNK1/2026/00003 type=entry state=posted ref=Payment INV/2026/00003
    account.payment records created: 1
    ```
- Reproduction: Tick "Automatic Payment" on an in-progress subscription whose next invoice date is today, then wait for the hourly job or run Generate Invoice.
- Expected / Actual: Expected: a charge through a payment provider and a transaction record, or a label such as "Mark invoices as paid (no charge)". Actual: the invoice is marked paid and cash is booked to the bank journal.
- Impact: Bank balance and receivables are misstated, and overdue customers look paid. This misleads cash decisions and dunning.
- Root cause: Verified. A demo shortcut was left behind a production-looking label. Website demo payments are env-gated (`server/api.js:26`), but this one is not.
- Recommended correction: Gate it behind the same `demoPaymentsAllowed()`, rename it, or integrate a real provider token and charge flow.
- Dependencies: FLOWS/ACCT.
- Verification plan: Re-run `autopay.mjs`. No BNK entry should be created without a provider transaction.
- Confidence: Confirmed

### MIZAN-UI-008 What users see on `/api/diff` errors: native English alert, the edit silently reverted, success shown before the server confirms
- Severity: P2
- Category / Component: Form validation and error feedback / `store.js`, `FormView.jsx`, `ActionView.jsx`, `Settings.jsx`
- Evidence:
  - `store.js:113-114`: `if (r.ok || r.data?.db) { db = ...r.data.db; notify(); } if (!r.ok) alert(r.data?.error ?? 'Could not save changes');`. The text is not passed through `t()`, and non-JSON errors (502/413) keep the optimistic state until the next poll.
  - `FormView.jsx:232-249`: `save()` returns the id and clears `changes` right after the local commit. For new records it navigates to `/<id>` before the server answers. If the server then rejects, the record disappears ("Record not found") and the typed values are lost.
  - `FormView.jsx:361`: client errors are rendered raw. There is no `t()`, no `aria-invalid`, and no association with the failing field.
  - `ActionView.jsx:94-95` alerts "{n} record(s) imported." before the server answers.
  - `Settings.jsx:124` sets "Backup restored." the same way.
  - Non-admin settings changes are dropped server-side without an error (`sync.js:94-112`, the `...(isAdmin ? {...} : {})` spread).
  - Run output, `server-ux.cjs` A (edit a seeded document's name):
    ```
    dialogs: ["alert: Invalid value for documents.document.tag_ids"] | title before: "Q3 VAT return.pdf" after save+reject: "Q3 VAT return.pdf" | form error box: null
    ```
  - `nonadmin-settings.cjs`: the non-admin sees company, currency, lock_date and audit_trail all enabled. They confirm "The audit trail cannot be disabled once enabled. Continue?", and after the server reply `audit_trail checked=false`, with no message.
- Reproduction: Steps as in the scripts above. Screenshot: `audit/ui-shots/server-400-after.png`.
- Expected / Actual: Expected: an inline, translated error next to the field; the form keeps its unsaved values; success is shown only after the server ACKs; controls the user may not change are disabled. Actual: as above.
- Impact: Users lose typed work, cannot understand technical English errors (especially in Arabic), and believe imports or settings succeeded when they did not.
- Root cause: Verified. Commits are fire-and-forget and optimistic, with no per-commit promise returned to callers.
- Recommended correction:
  - Return a promise from `commit()`. Keep the form dirty until it resolves, then show `t(error)` inline (the server could return `{field, message}`).
  - Replace `alert` with a toast or banner using `role="alert"`.
  - Disable admin-only controls for non-admins.
- Dependencies: UI-001, UI-012.
- Verification plan: Re-run `server-ux.cjs` A and `nonadmin-settings.cjs`.
- Confidence: Confirmed

### MIZAN-UI-009 "Reset demo" wipes the production database after a single confirm
- Severity: P1
- Category / Component: Settings / `Settings.jsx:225`, `store.js:126-130`, `server/index.js:441-445`
- Evidence:
  - `Settings.jsx:225`: `onClick={() => { if (confirm(t('Reset all data to the demo database?'))) resetDemo(); }}`. It is shown in server mode to every user, and the server returns 403 for non-admins.
  - The server does `commitDb(seed(), { full: true })`.
  - Run output, `ui-scripts/reset.cjs` (admin, in my copy's server):
    ```
    before reset: {"records":346,"partners":9,"msgs":32}
    dialogs: ["Reset all data to the demo database?"] | after one click + OK: {"records":344,"partners":8,"msgs":28}
    ```
    The new customer and the chatter/audit messages are gone. For a non-admin the button produces the alert "Admins only".
- Reproduction: As admin in server mode: Settings > Reset demo > OK.
- Expected / Actual: Expected: disabled in production (env flag), with an automatic backup and a typed confirmation. Actual: one click deletes everything.
- Impact: Irrecoverable loss of all business data (unless external backups exist) through a demo button.
- Root cause: Verified. The demo feature is not gated by environment.
- Recommended correction: Hide the button and refuse `/api/reset` unless `MIZAN_DEMO=1`. Snapshot the SQLite file before any reset.
- Dependencies: SEC/ARCH.
- Verification plan: Re-run `reset.cjs`. It should return 403 or 404 without the demo flag.
- Confidence: Confirmed

### MIZAN-UI-010 Timesheet "Validate" stores a free-text validator name; "Reset to Draft" is admin-only only in the UI
- Severity: P1
- Category / Component: UI-only control / `src/models/timesheetplus.js`, `FormView.jsx:299`
- Evidence:
  - `timesheetplus.js:179`: `const user = prompt('Validating user', '');` is passed to `validateTimesheets(..., { user })`, and `:89` stores `validated_by: user`.
  - `:182`: `{ label: 'Reset to Draft', admin: true, ... }`. `FormView.jsx:299` only hides buttons with `admin` set. The guard (`:31-37`) allows a validated→draft reset regardless of `isAdmin`.
  - Run output, `ui-scripts/timesheet-admin.mjs`:
    ```
    validated_by stored: "The CFO (typed free text)"
    non-admin reset accepted by applyDiff; validated = false
    ```
- Reproduction: Open a timesheet line, click Validate, and type any name. As a non-admin, send the reset diff (or set `validated` to false through any write path).
- Expected / Actual: Expected: the validator is the authenticated user (stamped by the server), and reset is enforced as admin-only on the server. Actual: a spoofable name, and only a cosmetic restriction.
- Impact: Forged approval trail on billable hours, which flow into sales-order delivered quantities and invoices (`syncDelivered`).
- Root cause: Verified.
- Recommended correction: Stamp `validated_by` from the session user in `applyDiff` (`author`), and check `isAdmin` in `timesheetGuard`. More generally, enforce every `admin: true` button on the server.
- Dependencies: SEC.
- Verification plan: Re-run the script. The stored name must equal the session user, and the reset must be rejected for non-admins.
- Confidence: Confirmed

### MIZAN-UI-011 General Settings "Company Name" and "Currency" are dead or misleading controls; two company names shown at once
- Severity: P2
- Category / Component: Settings / `Settings.jsx:137,143`, `store.js:22-27`, `Navbar.jsx:62`, `PrintDoc.jsx:92`
- Evidence:
  - `companiesOf()` (`store.js:24`) takes name and currency from `res.company` and `res.currency` records when they exist, which is always the case in the seed. So `settings.company` and `settings.currency` only feed the navbar when there is a single company.
  - Run output, `ui-scripts/settings-dead.cjs` (company renamed to "Renamed Trading LLC", currency switched to EGP):
    ```
    navbar company now: "Renamed Trading LLC"
    printed invoice company/currency: "...Mizan Demo CoUSD..." | first amount: $150.00
    dashboard first KPI: $7,866.00
    ```
  - Screenshots `home-en.png` and `invoice-form-*` show "My Company" in the navbar, while print shows "Mizan Demo Co".
- Reproduction: Settings > change Company Name and Currency > open any invoice print.
- Expected / Actual: Expected: one source of truth, with edits reflected on documents and the ZATCA QR seller name. Actual: the navbar changes and the documents do not. If the currency setting did work, it would relabel amounts without converting them.
- Impact: Users believe they rebranded or switched currency when invoices still carry the old values.
- Root cause: Verified. A legacy `settings.company`/`currency` coexists with `res.company`.
- Recommended correction: Remove the legacy fields or bind them to the current `res.company`. Make a currency change a deliberate operation with conversion and a warning.
- Dependencies: UI-005.
- Verification plan: Re-run the script.
- Confidence: Confirmed

### MIZAN-UI-012 Arabic translation coverage: 226 of 2,371 `t()` strings untranslated; prompts, chatter notes and almost all errors are English-only
- Severity: P2
- Category / Component: i18n / `src/i18n.js` and callers
- Evidence: Run output, `ui-scripts/i18n-coverage.mjs`. It compares static `t('...')` literals and every model-driven label that the UI passes through `t()` (apps, menus, field labels, selection options, buttons, tabs, smart buttons) with the `ar` dictionary.
  ```
  Arabic dictionary entries: 2416; duplicate keys in literal: 90 (0 conflicting values, i18n-dups.mjs)
  Static t() literals: 402 distinct, 3 without Arabic (0.7%)       e.g. "Unknown" FinanceReports.jsx:28, "Results" Survey.jsx:95
  Model-driven labels: 2078 distinct, 224 without Arabic (10.8%)   {"menu":5,"selection":141,"field":72,"button":6,"tab":6}
  UNION of strings reaching t(): 2371 distinct, 226 untranslated (9.5%)
  Apps (home tiles) without Arabic name: 0/63
  ```
  The full list is in `audit/ui-i18n-missing.json`. Strings that never go through `t()`:
  - 42 `alert`/`confirm`/`prompt` calls with English literals (e.g., `crm.js:22` "Lost reason", `quoteplus.js:182-196`); 51 such calls in `src/models` overall.
  - 23 `postNote` English templates, persisted to the chatter.
  - 641 literal error or guard messages, of which only 62 have an Arabic entry. Even those are shown raw by `FormView.jsx:361` and `store.js:114` (`errors-i18n.mjs`).
  - Chart and group month labels: `orm.js:141` uses `toLocaleDateString('en-US', {month:'long'})`, giving "September 2026" in the Arabic dashboard (`accounting-dashboard-ar.png`). `reportCompare.js:4` hardcodes English month names.
  - Hardcoded aria-labels: `FormView.jsx:159` "Chatter", `:312` "Breadcrumb", `List.jsx:77` "Select all", `CalendarView.jsx:33-34`, `Gantt.jsx:110-111`.
  - `ar['Payment of {amount} registered']` and `ar['Payment amount']` exist, but `accounting.js:92,149` use English literals.
  - The browser crawl of 270 routes and 106 forms in Arabic found no crash from i18n. Remaining Latin text is mostly seed data (journal and account names, UoMs).
- Reproduction: `node ui-scripts/i18n-coverage.mjs <copy> <out.json>`, or switch Settings > Language to Arabic and open Accounting > Register Payment (the prompt is "Payment amount (due $1,210.00)").
- Expected / Actual: Expected: every user-visible string is localizable, and errors are mapped to translatable keys. Actual: as listed.
- Impact: Arabic users meet English in critical moments (errors, payment and signature prompts, audit notes).
- Root cause: Verified. Translation only covers strings explicitly wrapped in `t()`, and model-layer text bypasses it.
- Recommended correction:
  - Route all model messages through message keys with `t()` at render time.
  - Add a CI check (this script) that fails when coverage drops.
  - Translate the 224 labels.
  - Use `Intl.DateTimeFormat(lang)` in `orm.js` and `reportCompare.js`.
- Dependencies: UI-019.
- Verification plan: The script reports 0 missing; a manual pass in Arabic finds no Latin chrome.
- Confidence: Confirmed

### MIZAN-UI-013 RTL and number formatting: negative amounts render as "$1,800.00-"; Arabic-Indic digits and thousands separators silently rejected
- Severity: P2
- Category / Component: RTL / bidi / input parsing / `ui.jsx:8-25`, `styles.css .num`
- Evidence:
  - RTL infrastructure is good. `main.jsx:12-13` sets `lang` and `dir`. The CSS uses 101 logical properties and 0 physical left/right properties (grep of `styles.css`, `views.css` and `theme.css`; none inline in JSX). The crawl reported `dir/lang [ 'rtl/ar' ]` on all 270 routes.
  - Money and floats are always formatted in `en-US` (`ui.jsx:10,14,25`), while dates use `ar-EG-u-nu-latn` (`ui.jsx:8`). The result mixes LTR runs inside RTL paragraphs, with no `<bdi>` or `unicode-bidi: isolate`.
  - Run output, `ui-scripts/bidi.cjs` (Arabic, bank lines list):
    ```
    "-$1,800.00" ... => minus is RIGHT (trailing)
    "-$602.50"   ... => minus is RIGHT (trailing)
    ```
    Screenshot: `audit/ui-shots/bank-lines-ar.png`. The dashboard card shows "$602.50- · 3".
  - Arabic-digit input:
    - `arabic-digits.cjs`: a number input after typing "١٢٣" has the value "1" (unchanged).
    - `arabic-pay.cjs` (Register Payment prompt): answering "١٠٠" leaves the invoice unchanged, as does "1,000". No error dialog is shown. The code path is `accounting.js:150-152` (`Number(input)` gives NaN, then a silent return).
- Reproduction: Language = Arabic, then Accounting > Bank. Or Register Payment and type Arabic digits.
- Expected / Actual: Expected: amounts isolated as LTR (`<bdi dir="ltr">` or `.num { direction:ltr; unicode-bidi:isolate }`), Arabic digits normalized, and invalid input reported. Actual: the minus sign is displaced, and input is silently ignored.
- Impact: Outflows can be misread as inflows on financial screens, and Arabic keyboard users cannot enter amounts.
- Root cause: Verified.
- Recommended correction:
  - Isolate numeric runs.
  - Optionally format with `Intl.NumberFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US')`.
  - Normalize `[٠-٩۰-۹]` and strip grouping separators before `Number()`.
  - Show validation feedback.
- Dependencies: UI-019.
- Verification plan: Re-run `bidi.cjs` (the minus sign must be leading) and `arabic-pay.cjs` (a payment must be registered).
- Confidence: Confirmed

### MIZAN-UI-014 Mobile: app sub-menus hidden below 640 px with no replacement; form views overflow horizontally
- Severity: P2
- Category / Component: Responsiveness / `styles.css:198-206`
- Evidence:
  - `styles.css:203`: `.nav-menus, .company { display: none; }`. There is no hamburger or alternative navigation, so only the app's default menu leaf is reachable on phones.
  - Run output, `ui-scripts/mobile-form.cjs` (375 px): `ar ... "sw":423,"cw":375`, `en ... "sw":440,"cw":375`. The widest elements are `.form-main`, `.form-header`, `.sheet` and `.chatter` (407–424 px). The statusbar and the "Credit" column are clipped (`invoice-form-en-mobile.png`, `invoice-form-ar-mobile.png`; in RTL the clipped side is the start edge).
  - The list sample (45 routes) overflowed only on `#/dashboards/overview` (396 > 375).
- Reproduction: Open the app at 375 px wide. Accounting shows only "Accounting" in the navbar; there is no route to Vendors, Bills, Reporting or Configuration.
- Expected / Actual: Expected: a collapsible menu, and tables scrolling inside their wrappers. Actual: navigation is lost and the page scrolls sideways.
- Impact: The ERP is not usable on phones beyond each app's first screen.
- Root cause: Verified.
- Recommended correction: Add a menu toggle (`aria-expanded`) for `.nav-menus`, set `min-width: 0` on grid children, and give `.lines-wrap`, `.form-header .row` and `.statusbar` `overflow-x: auto` or wrapping.
- Dependencies: none.
- Verification plan: Re-run `mobile-form.cjs` (`scrollWidth == clientWidth`) and check that all leaves are reachable at 375 px.
- Confidence: Confirmed

### MIZAN-UI-015 Accessibility: keyboard, focus management, form semantics and contrast
- Severity: P2
- Category / Component: A11y / `List.jsx`, `Navbar.jsx`, `ControlPanel.jsx`, `FormView.jsx`, `ui.jsx`, `styles.css`/`theme.css`
- Evidence:
  - **Keyboard:**
    - List rows open only through `onClick` on `<tr>` (`List.jsx:38`). Group rows (`:60`) are the same.
    - `keyboard.cjs`: `focusable elements per list row: ["INPUT:checkbox"]`, `Enter on focused row checkbox -> navigated to form? false`.
    - Kanban cards are fine (`tabIndex=0` with Enter), but state changes by drag have no keyboard alternative.
  - **Menus and panels:**
    - Navbar `role="menu"` (`Navbar.jsx:22-26`): `still open after Escape: true`, and `ArrowDown moves focus into menu: null`.
    - The search panel `role="dialog"` (`ControlPanel.jsx:47`): `focus is in it: false | aria-modal: null`.
    - There are no other dialogs: 73 native `alert`/`confirm`/`prompt` calls are used instead (UI-019).
    - Only one `.focus()` call exists in all views (`Pages.jsx`).
  - **Form semantics** (crawl of 106 forms, `audit/ui-crawl-forms-ar.json`):
    - The required marker is `<span className="req" aria-hidden="true">*</span>` (`FormView.jsx:55`), and inputs get no `required` or `aria-required`: 55 markers, 0 attributes.
    - 269 orphan `label[for]` in 68 forms. Readonly spans, tags, priority and one2many fields get `htmlFor={id}` without an element carrying that id (`FormView.jsx:52-56`, `ui.jsx:163-194`).
    - The tabs (`FormView.jsx:382-387`) have no `aria-controls` and no arrow keys. Errors are not linked to fields.
  - **Contrast** (`ui-scripts/contrast.mjs`, WCAG ratios). Light theme: text 15.5, muted 4.83, brand 7.23, white-on-brand 7.23, danger 5.44 all pass. Failures:
    - `--success` #1f9d55 on white: 3.49 (used as text at `views.css:124,132`).
    - `--warn` #e3a008: 2.26.
    - `--border` #e2e5ee on white: 1.26 (input and button boundaries, WCAG 1.4.11).
    - Dark theme, white on `--brand` #7b93f0: 2.89 (`.statusbar [aria-current]` `styles.css:159`, `.chip.on`, shop pager and others).
  - **Other:** 119 unnamed controls on 5 routes (checkboxes without labels, e.g. `List.jsx:40` uses `aria-label={r.name}`, which is empty for records without a name).
- Reproduction: Keyboard-only navigation of Sales > Orders list; Tab and Escape on the navbar; the contrast script.
- Expected / Actual: WCAG 2.1 AA (2.1.1, 2.4.3, 1.3.1, 3.3.2, 1.4.3, 1.4.11) versus the gaps above.
- Impact: Keyboard and screen-reader users cannot use list views, and low-vision users miss field boundaries and status colours.
- Root cause: Verified.
- Recommended correction:
  - Render the first cell as a link, or add `tabIndex=0` with Enter/Space handlers on rows.
  - Add Escape and arrow-key handling plus focus return to the menu and panel.
  - Set `required`/`aria-required` and `aria-invalid` with `aria-describedby`.
  - Point labels only at real controls.
  - Darken `--border` to at least #8a91a3 for controls, `--success` text to #177a43 or darker, and `--warn` text; use a dark text colour on the dark-mode `--brand`.
  - Translate the aria-labels.
- Dependencies: UI-019.
- Verification plan: Re-run `keyboard.cjs`, `contrast.mjs` and the form crawl (0 orphan labels, required count equal to marker count).
- Confidence: Confirmed

### MIZAN-UI-016 22 models default to Kanban without a kanban spec; the screen crashes once a record exists
- Severity: P2
- Category / Component: Views / `Kanban.jsx:10-12`, `models/index.js:88`
- Evidence:
  - `viewsOf = (model) => models[model].views ?? ['kanban', 'list']` (`index.js:88`). `Card` reads `k.counter` with `k = models[model].kanban` undefined (`Kanban.jsx:12`).
  - `ui-scripts/nokanban.mjs`: 22 models, including uom.uom, stock.warehouse, stock.valuation.layer, pos.config, documents.tag, website.menu, product.supplierinfo, sale.subscription.plan and rental.pricing, on 22 menu routes.
  - Arabic crawl (`audit/ui-crawl-ar.json`): `ErrorBoundary screens: ... #/inventory/valuation | #/inventory/warehouses | #/inventory/uom-categories | #/inventory/uoms : Cannot read properties of undefined (reading 'counter')`. These four routes have seed data; the other 18 will crash as soon as a first record is created.
  - The raw JS error text is shown to users (`ui.jsx:283`).
- Reproduction: Open Inventory > Configuration > Warehouses.
- Expected / Actual: Expected: list view by default, or a generic card. Actual: an error screen.
- Impact: Configuration screens are broken by default. A user can work around it by switching to list view.
- Root cause: Verified.
- Recommended correction: Default `views` to `['list']` when `kanban` is undefined, give Kanban a generic fallback card, and add a test asserting every model in `viewsOf` has the needed spec.
- Dependencies: none.
- Verification plan: Re-run the crawl; expect 0 ErrorBoundary screens.
- Confidence: Confirmed

### MIZAN-UI-017 Large lists: no pagination or virtualization; decorative pager; whole DB re-rendered and re-diffed on every change
- Severity: P2
- Category / Component: Performance / `ActionView.jsx:76-77,105`, `List.jsx:90`, `Kanban.jsx:78,119`, `store.js`
- Evidence:
  - `ActionView.jsx:105`: `<span className="pager">{records.length ? \`1-${records.length}\` : '0'} / {records.length}</span>`. It always shows everything.
  - Every record is filtered and rendered on each store change. `useDb()` returns the whole db, and `diffDb` walks every model on each commit.
  - Settings text fields commit on every keystroke (`Settings.jsx:137,201,207`).
  - Run output, `ui-scripts/perf.cjs` (5,000 extra partners and 2,000 extra invoices in a 2.2 MB local db, Chromium):
    ```
    Contacts list: 1293 ms, DOM nodes 40153 | Contacts kanban: 798 ms, 30126 | Invoices list: 1429 ms, 22152
    typing 10 chars in a contact form: 271 ms | save (commit + whole-db localStorage write): 509 ms
    ```
  - Server mode loads the whole visible db through `GET /api/db` at login and every 15 s (`store.js:67-71,83`).
- Reproduction: Load `db-big.json` (generated by `make-dbs.mjs`) and open the Contacts list.
- Expected / Actual: Expected: paged or virtualized lists, a functional pager, and incremental sync. Actual: linear growth (about 10 s and 400k nodes at 50k records, extrapolated and NOT VERIFIED).
- Impact: The UI degrades sharply as data grows, and polling transfers the whole DB per user every 15 s.
- Root cause: Verified (architecture).
- Recommended correction: Page lists (80 rows by default), add server-side search and paging on `/api/v1`, provide a delta sync endpoint (since a sequence number), and debounce settings inputs.
- Dependencies: ARCH/DB.
- Verification plan: Re-run `perf.cjs`; render time below 200 ms at 5k records.
- Confidence: Confirmed (measurements); the 50k extrapolation is a hypothesis

### MIZAN-UI-018 Single 1.10 MB bundle, no code splitting, no loading or error state at startup
- Severity: P2
- Category / Component: Build / `vite.config.js`, `main.jsx`, `index.html`
- Evidence:
  - `dist/assets/index-DuMxlqpS.js` is 1,102,124 bytes, 320,635 bytes gzipped.
  - `grep "import("` over `src` finds no dynamic imports. `vite.config.js` has no `build.rollupOptions` or `manualChunks`.
  - The bundle includes seed data (`seed.js`, 41 KB), the full Arabic dictionary (`i18n.js`, 111 KB, shipped to English users too) and all 89 model modules.
  - The anonymous public shop (`main.jsx:22`, `PublicSite`) downloads the whole ERP.
  - `index.html` contains only an empty `<div id="root">`, so the page is blank until the bundle, `/api/session` and the full `/api/db` have loaded.
  - `main.jsx:17` has `initStore().then(...)` with no `.catch`.
  - Home, Login, PublicSite and PrintDoc are outside the only `ErrorBoundary` (`App.jsx:68-88`).
- Reproduction: `ls -la dist/assets`; load the site on a throttled connection.
- Expected / Actual: Expected: route- or app-level chunks (`React.lazy`), a separate public-site entry, lazily loaded language packs, a spinner, and a root error boundary. Actual: none of these.
- Impact: Slow first load on mobile, a white screen on any startup error, and a larger attack surface for public visitors.
- Root cause: Verified.
- Recommended correction: Use `React.lazy` per app and view, split the PublicSite entry, use `import('./i18n/ar.js')`, add a loading skeleton in `index.html`, and add a root `ErrorBoundary` plus a `.catch` in `main.jsx`.
- Dependencies: UI-002.
- Verification plan: The vite build report shows the main chunk below 300 KB; the network panel shows a lazy load per app.
- Confidence: Confirmed

### MIZAN-UI-019 Business inputs collected through native `prompt()`, English-only, with raw IDs and silent failure
- Severity: P2
- Category / Component: UX / models' form buttons
- Evidence:
  - 73 native `alert`/`confirm`/`prompt` calls across `src/*.jsx`, `views` and `models`.
  - Examples:
    - `accounting.js:149` "Payment amount (due $...)"
    - `quoteplus.js:182` `prompt('Quotation template id')`
    - `:186` `prompt('Optional product index (starting at 0)')`
    - `:190-192` signer name and a typed "Signature"
    - `work.js:258` "Ticket ids to merge into this one (comma separated)"
    - `extra.js:33` sign document by typed name
    - `fsm.js:82`
    - `timesheetplus.js:179` (UI-010)
  - Invalid input returns `{ db }` silently (`accounting.js:151-152`, `quoteplus.js:183,187`). Verified with `arabic-pay.cjs`: "1,000" and "١٠٠" do nothing and show no message.
  - If the user ticks Chrome's "prevent this page from creating additional dialogs", `prompt()` returns null, so actions silently no-op and error alerts disappear. This is browser behaviour and was NOT VERIFIED here.
- Reproduction: Sales > a quotation > Apply Template, when no template is set.
- Expected / Actual: Expected: accessible in-app dialogs with pickers (template or product selectors), validation messages and translation. Actual: free-text IDs and silent no-ops.
- Impact: Error-prone data entry and unusable flows for non-technical and Arabic users. Signatures are captured only as typed names.
- Root cause: Verified. UI interaction is embedded in model `run()` functions.
- Recommended correction: Let buttons declare a `wizard` schema (fields with types and relations) rendered by a shared modal component with focus trap, `t()` and validation, and remove `prompt` from models.
- Dependencies: UI-012, UI-013, UI-015.
- Verification plan: grep finds no `prompt(` in `src/models`; e2e tests of the payment, template and sign flows.
- Confidence: Confirmed

### MIZAN-UI-020 Dashboard KPI semantics: credit notes ignored, tiles link to unfiltered lists
- Severity: P3
- Category / Component: Dashboard / `Dashboard.jsx:37-52`
- Evidence:
  - `invoices = posted.filter((m) => m.move_type === 'out_invoice')`, so `out_refund` is never netted in "Invoiced this month", "Receivable" or "Top customers". "Payable" uses `in_invoice` only.
  - Every tile links to `#/accounting/invoices?view=list` without a filter (`:47-50`). For example, "Overdue invoices 1" opens all invoices.
  - `overdue` uses `payment_state !== 'paid'`.
- Reproduction: Post a credit note for a customer; the "Receivable" tile does not decrease.
- Expected / Actual: Expected: net figures, and tiles that open the matching filtered list. Actual: gross figures and generic links.
- Impact: KPIs are overstated whenever refunds exist. This is a code-reading finding; no credit-note scenario was run (Strongly supported).
- Root cause: Verified by reading the code.
- Recommended correction: Use signed residuals, or derive KPIs from the ledger (receivable account balance), and pass filters in the tile links.
- Dependencies: UI-005, ACCT.
- Verification plan: An e2e test with a credit note.
- Confidence: Strongly supported

### MIZAN-UI-021 Identity and shell inconsistencies: hard-coded "Admin" avatar, activities always assigned to user 1, logout buried
- Severity: P3
- Category / Component: Navigation and layout / `Navbar.jsx:63`, `Home.jsx:20`, `FormView.jsx:112`
- Evidence:
  - `<Avatar name="Admin" />` appears in both Navbar and Home, whatever the logged-in user is.
  - "Schedule Activity" defaults to `user_id: 1` (`FormView.jsx:112`), and there is no assignee picker in the inline form (`:100-110`).
  - The systray counter counts everyone's overdue activities (`Navbar.jsx:33`).
  - Logout exists only at the bottom of Settings (`Settings.jsx:234`); there is no user menu.
  - The App router renders any app route, even uninstalled or not allowed ones (`App.jsx:74`); Home only hides the tiles.
  - A record id opens under any menu: `#/accounting/invoices/1` shows journal entry MISC/2026/00001 with an "Invoices" breadcrumb (`invoice-form-en-mobile.png`).
- Reproduction: Log in as `clerk`: the avatar shows "A" (Admin).
- Expected / Actual: The current user is shown and used by default.
- Impact: Users get confused about whose session and whose activities they are seeing; activities are misassigned.
- Root cause: Verified.
- Recommended correction: Use `getUser()` for the avatar and the activity default, add a user menu with logout, and guard routes by `user.apps` and installed apps.
- Dependencies: none.
- Verification plan: Manual check as a non-admin.
- Confidence: Confirmed

### MIZAN-UI-022 Minor simulated or cosmetic actions
- Severity: P3
- Category / Component: Misc views
- Evidence:
  - Reports > Follow-ups "Send Reminder" is only a `mailto:` link (`Reports.jsx:189`). It logs nothing in the chatter and does not advance the follow-up level, and the amounts carry no currency (`:183`).
  - Pager "1-N / N" is decorative (UI-017).
  - App Store "Uninstall" only hides tiles (`AppStore.jsx:24-27`).
  - Duplicating a submitted expense creates a new "submitted" expense (`duplicate.mjs`: `hr.expense#1 (submitted) -> copy#5 state=submitted`), because `FormView.jsx:123-127` keeps `state` when `name` is editable.
  - In demo mode, `/api/session` against `vite preview` logs a 500 console error on every load (harmless).
- Reproduction: As described.
- Expected / Actual: Labels should match behaviour.
- Impact: Minor confusion; the duplicate case can skip the submit step.
- Root cause: Verified.
- Recommended correction: Log reminders and say "Open in mail app"; reset `state` and workflow fields on duplicate using model defaults.
- Dependencies: UI-003.
- Verification plan: Re-run `duplicate.mjs`.
- Confidence: Confirmed

## Artifacts
- Screenshots in `audit/ui-shots/`:
  - Home, EN and AR: `home-en.png`, `home-ar.png`
  - Invoice list and form, EN/AR, desktop and mobile: `invoices-list-*`, `invoice-form-*`
  - `accounting-dashboard-en.png`, `accounting-dashboard-ar.png`
  - `bank-lines-ar.png` (bidi)
  - `fx-invoice-form-en.png`, `print-sar-invoice.png`
  - `kanban-drag-posted.png`
  - `server-400-after.png`, `server-400-new-record.png`, `server-after-network-failure.png`
- Crawl data:
  - `audit/ui-crawl-ar.json`: 270 routes. Per route: render errors, Latin text in UI chrome, unnamed controls, timings, mobile overflow sample.
  - `audit/ui-crawl-forms-ar.json`: 106 forms.
  - `audit/ui-i18n-missing.json`: all untranslated keys.
- Scripts: `ui-scripts/*.mjs|.cjs`. Each takes the copy path or base URL as an argument.
