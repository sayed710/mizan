# Mizan audit: Accounting and Financial Integrity (Agent E, id "acct")

Audited commit: 0e9f74820706083ba6e94dd414a63053348e1d3d. Work copy: evidence/work-acct (src/ identical to the clone, checked with diff -rq).
Scripts: evidence/work-acct/acct/t1-invariants.mjs … t12-taxrep.mjs. All outputs: evidence/work-acct/acct/outputs.txt

## Summary
- The browser accounting logic gets the happy path right. After seed and a full sale → invoice → 2 payments → credit note → bill payment flow, debits equal credits (218,214.80 each). The trial balance closes, the balance sheet balances (gap 0), cash flow sections equal net cash, and the AR/AP subledgers equal the GL (t1).
- None of this is enforced on the server. `applyDiff` checks only the record's shape, plus `moveGuard`, and `moveGuard` acts only when a lock date or the audit trail is set. Any user whose app set contains `account.move` can do all of the following through POST /api/diff: rewrite a posted entry's lines (unbalanced), set `amount_paid`, change a posted move's state or date, create one-sided posted entries, archive moves out of every report, or delete them. That app set includes Inventory, Expenses, Rental, Repairs, Field Service, Events, Timesheets, Subscriptions, Appointments and Manufacturing users, not only accountants. (P0)
- The hard lock does not make data immutable. `amount_paid`, `payments`, `active`, `company_id` and `journal_id` are outside `LOCKED_FIELDS`, so a hard-locked invoice can still be marked paid or archived out of the books. (P0)
- Client-chosen record ids plus last-writer-wins: two users posting payments at the same time silently overwrite each other's posted bank entry and payment record. The invoice still shows the payment, but the cash is gone from the GL (gap 100 reproduced). (P0)
- Document numbers are `count(prefix)+1`. Duplicate invoice numbers occur under concurrency and after any deletion. (P1)
- `amount_paid` is a stored counter, not reconciliation. It drifts from the GL when payment entries are reset or cancelled, on overpayment, and on bank reconciliation, which can book the wrong amount or the wrong sign. Credit notes are never offset against invoices, so the aged receivable and follow-ups chase customers who have already been credited. (P1)
- Missing or unknown accounts are dropped silently from reports, so the trial balance and balance sheet stop closing. Every app user can edit, delete or retype the chart of accounts and taxes. (P1)
- Fiscal-year closing breaks after sync: the server strips `is_closing`, and the closed year's P&L then shows 0. The audit trail is written by the client, and the server forges nothing but also verifies nothing. (P1)
- Consolidation does not balance: there is no CTA, prior-year earnings are dropped, the equity method is one-sided and there is no NCI. Companies whose currency is not the base currency are translated twice (120.78 instead of 108.70). POS ignores configured taxes: an item priced 114 including VAT is charged 129.96. (P1)
- Country items: ZATCA phase-1 TLV QR only, EPC QR present, and nothing for Egypt (ETA) or the UAE. These are gaps, not compliance.

## What I verified / what I could not verify
Verified by running the real functions in node (seed.js, postMove, payMove, payOrder, closeFiscalYear, consolidate, reconcileWith, applyDiff, diffDb, modelsForApps): every "Actual" result below that quotes output.
Verified by reading code: every file:line cited, read in the work copy.
Not verified:
- I did not start the HTTP server. The findings exercise `applyDiff(db, diff, {isAdmin, allowed})` with `allowed = modelsForApps([...])`, which is exactly what server/index.js:435 calls. I did not test HTTP-level auth or CSRF (that is the sec workstream's area).
- The concurrency results simulate two diffs computed from the same snapshot and applied in sequence. That is the documented server behaviour. I did not race real HTTP requests.
- Loans, deferrals, expense posting, MRP/workorder costing and stock valuation entries were read only briefly, not tested.
- I did not check the ZATCA, ETA or UAE requirements against current official specifications, because the brief forbids network access. The gap list comes from known requirements and is labelled as such.

---

### MIZAN-ACC-001 Posted journal entries and invoices are fully mutable through /api/diff (no posted-entry immutability, no balance check, amount_paid is a free field)
- Severity: P0
- Category / Component: Financial integrity / src/sync.js applyDiff, src/models/finance.js moveGuard, src/models/index.js modelsForApps
- Evidence:
  - src/sync.js:57-62: each upserted record is `cleanRecord` (type checks only), then `validate` (required fields), then `models[model].guard?.(seen, before, rec, { isAdmin })`. There is no other server-side accounting rule.
  - src/models/finance.js:40-48 `moveGuard(db, before, after)`. Its only checks are the audit-trail renumbering check (l.41) and the lock date (l.42-47). `if (!lock) return null;` (l.43). The `isAdmin` option is never read, and nothing checks that lines balance or that `state==='posted'` records are immutable.
  - src/models/accounting.js:254 `amount_paid: { type: 'monetary', label: 'Paid', readonly: true }`. `readonly` is UI-only, and `cleanRecord` (src/validate.js:61-64) keeps every declared non-computed field. Residual and payment state are computed from it (accounting.js:18-23).
  - src/models/index.js:564-577: `modelsForApps` adds every relation target of every field. The output of evidence/work-acct/acct-apps.mjs shows `account.move` is writable by the appointments, subscriptions, rental, timesheets, events, inventory, manufacturing, repairs, fieldservice and expenses apps.
  - t2-forge.mjs, `applyDiff(base, forgedDiff, {isAdmin:false, allowed: modelsForApps(['accounting'])})` on INV/2026/00002 (total 1710, paid 500):
    ```
    ACCEPTED 1 set amount_paid=total on posted invoice  -> residual 0 paid | recv gap {"GL":1210,"subledger":0,"gap":1210}
    ACCEPTED 2 unbalance posted line_ids  -> debit-credit diff -1709 unbalanced [ 'INV/2026/00002' ] BS gap -1709 TB end total -1709
    ACCEPTED 3a state posted->cancel / ACCEPTED 3b state posted->draft
    ACCEPTED 4 move posted invoice to 2019-01-01
    ACCEPTED 5 create posted one-sided entry (+1,000,000 bank) -> sumD-sumC 1000000 BS gap 1000000
    ACCEPTED 6b inventory-only user sets amount_paid
    ACCEPTED 7 archive posted invoice (active:false)
    ACCEPTED 8 delete posted invoice (no lock, audit trail off)
    ACCEPTED 10b [audit trail] change line amounts
    ```
- Reproduction: `node acct/t2-forge.mjs` in the work copy. The diff is a plain JSON object that any logged-in user can POST to /api/diff (server/index.js:432-435).
- Expected / Actual: Expected: the server rejects any change to a posted move except a controlled reversal, rejects unbalanced posted entries, and derives `amount_paid` from posted reconciliations. Actual: every one of these forgeries is accepted (non-admin user). Only the sales-only user was refused (6a), because `account.move` is not in that app set.
- Impact: Anyone who can log in to one of about 11 apps can mark invoices paid without cash, inflate the bank balance by any amount, unbalance the books, backdate or erase posted documents, and so falsify financial statements. All reports read whatever is stored.
- Root cause: Verified. All business logic runs in the browser, and the server trusts the resulting records. The only guard covers lock dates.
- Recommended correction: Move posting to server-side actions (post, pay, reverse, reconcile) that compute journal items themselves. In `moveGuard`, reject any upsert where `before.state==='posted'`, except for an explicit list of non-accounting fields such as `narration`. Reject `state:'posted'` on create or write unless the server posts it, require `isBalanced` and valid accounts, and never accept `amount_paid` or `payments` from clients. Restrict `account.move` to accounting users and do not grant it through relation expansion.
- Dependencies: ACC-002, ACC-005, ACC-009. Overlaps with the sec workstream (modelsForApps relation expansion). The arch workstream reproduced the unbalanced-posted-entry case on its own and filed a test gap: src/ledger.test.js:31 "unbalanced manual entries cannot be posted" tests only the browser `postMove`, never `applyDiff`. That test gap belongs to arch; the P0 is this finding.
- Verification plan: Re-run t2-forge.mjs. Every forgery should be REJECTED. Add a test suite that applies forged diffs as non-admin and admin.
- Confidence: Confirmed

### MIZAN-ACC-002 Lock dates and the "hard lock" can be bypassed: paid status, archive, company and journal of locked entries stay writable
- Severity: P0
- Category / Component: Period locking / src/models/finance.js
- Evidence:
  - finance.js:24 `const LOCKED_FIELDS = ['name', 'invoice_line_ids', 'line_ids', 'invoice_date', 'state', 'partner_id', 'currency_id', 'move_type'];`. It leaves out `amount_paid`, `payments`, `payment_date`, `active`, `company_id`, `journal_id` and `fiscal_position_id`.
  - src/validate.js:53-56 copies `active` for every model, even undeclared, and src/orm.js:26 hides `active===false` records from `search`, which every report uses (ledger.js:107 `journalItems`).
  - Only `account.move` has the lock guard. `account.payment` (pay.js:49), `account.bank.statement.line` (bank.js:49), `account.asset` and `hr.payslip` have no guard at all (grep for `guard:` in src/models).
  - What does work: settings lock values are admin-only (sync.js:94-105), and the hard lock only moves forward (sync.js:105). Output 9g: a non-admin cannot clear it. Output 9h: an admin can clear the soft lock but not the hard lock.
  - t2-forge.mjs with `lock_date = hard_lock_date = 2026-12-31`:
    ```
    REJECTED 9a [hard lock 2026-12-31] change line_ids -> The period up to 2026-12-31 is locked
    ACCEPTED 9b [hard lock] set amount_paid=total
    ACCEPTED 9c [hard lock] archive active:false
    ACCEPTED 9d [hard lock] change company_id to 2
    ACCEPTED 9e [hard lock] change journal_id/fiscal_position_id/ref
    REJECTED 9f [hard lock] delete
    ACCEPTED 9j [hard lock] create posted unbalanced entry dated 2027-01-02
    ```
  - Archiving (9c) removed the invoice from the trial balance: in t2 item 7, TB debit fell from 190276 to 188566.
  - server/index.js:441-443: admin `/api/reset` replaces the whole database with seed data, including hard-locked periods.
- Reproduction: `node acct/t2-forge.mjs` (cases 9a-9k).
- Expected / Actual: Expected: nothing about an entry dated on or before the hard lock can change, and it cannot disappear. Actual: it can be marked paid, archived out of every report, or moved to another company.
- Impact: A closed and filed period can still be altered, including what the statements show (archive) and the receivables status (`amount_paid`). This defeats the purpose of a hard lock.
- Root cause: Verified. The guard uses a denylist of fields rather than freezing the record, and `active`/`company_id` are handled generically outside the model's fields.
- Recommended correction: When `moveDate(before) <= lock`, reject any difference at all (compare the whole cleaned record). Disallow `active:false` on posted moves. Apply the lock to payments, bank lines, assets and payslips. Make `/api/reset` refuse to run when any lock date is set, or require an offline backup.
- Dependencies: ACC-001.
- Verification plan: Re-run cases 9b-9e. All should be REJECTED.
- Confidence: Confirmed

### MIZAN-ACC-003 Concurrent postings silently overwrite each other's posted entries (client-assigned ids + last-writer-wins)
- Severity: P0
- Category / Component: Data integrity / src/orm.js nextId, src/sync.js applyDiff
- Evidence:
  - src/orm.js:7 `nextId = (db, model) => (db.seq[model] ?? 0) + 1`. The id is computed in the browser.
  - src/sync.js:55-62: the server `current.set(rec.id, rec)`. It does not check whether the id already exists with different content, and it does no version check.
  - t3-concurrency.mjs, part B: two users start from the same snapshot. User A pays 100 on INV/2026/00002 and user B pays 200 on BILL/2026/00001. Both diffs applied:
    ```
    B) payment move ids chosen by clients: A 12 BNK1/2026/00003  B 12 BNK1/2026/00003
       server keeps move 12 BNK1/2026/00003 Payment BILL/2026/00001 | invoice INV/2026/00002 amount_paid 600
       payments on server [ '3:PBNK1/2026/00003:200:move12' ]
       invariants {"GL":1210,"subledger":1110,"gap":100} ...
    ```
- Reproduction: `node acct/t3-concurrency.mjs`.
- Expected / Actual: Expected: both postings are kept, or the second is rejected with a conflict. Actual: A's posted bank entry and payment record are silently replaced by B's. A's invoice still shows the 100 as paid, but no cash entry exists for it.
- Impact: Silent loss of posted financial records during normal multi-user work, with no error. The receivable subledger and the GL diverge.
- Root cause: Verified. Ids are allocated in the browser, and upserts are last-writer-wins.
- Recommended correction: Allocate ids on the server, or reject an upsert of an id the client did not previously read (send a base version or hash per record). Treat a create as a create, and refuse it if the id exists.
- Dependencies: Overlaps with the db workstream (LWW / id allocation). ACC-004.
- Verification plan: Re-run part B. Expect two distinct moves and payments, or a 409 on the second diff.
- Confidence: Confirmed (simulated sequential application of two same-snapshot diffs)

### MIZAN-ACC-004 Duplicate invoice and entry numbers (count-based sequence, no uniqueness check)
- Severity: P1
- Category / Component: Sequences / src/models/common.js nextName
- Evidence:
  - common.js:73-74 `prefix + pad(records.filter(... r.name?.startsWith(prefix)).length + 1)`. The number is a count, not max+1, and nothing on the server checks uniqueness (moveGuard has no such check).
  - The count also runs across all companies (no company filter in common.js:74).
  - t3-concurrency.mjs:
    ```
    A) concurrent post -> INV/2026/00003 / INV/2026/00003
       after reset+delete+new post, INV names: [ 'INV/2026/00001', 'INV/2026/00002', 'INV/2026/00004', 'INV/2026/00004' ] duplicates: [ 'INV/2026/00004' ]
    ```
    The second case: post 00003 and 00004, Reset to Draft and delete 00003, then post a new invoice. It gets 00004 again.
- Reproduction: `node acct/t3-concurrency.mjs` (parts A and C).
- Expected / Actual: Expected: unique, gap-controlled numbers per journal, company and year. Actual: duplicates both under concurrency and after any deletion (deleting is allowed when the audit trail is off and the period is not locked, finance.js:51-55).
- Impact: Legally invalid invoice numbering in most jurisdictions (including KSA, Egypt and the EU), payment references that point to two documents, and broken reconciliation.
- Root cause: Verified.
- Recommended correction: A server-side sequence per journal, company and year (max+1 under a lock, or a stored counter), a uniqueness guard on `name` for posted moves, and no deletion of numbered moves.
- Dependencies: ACC-003.
- Verification plan: Re-run t3 parts A and C. The names should be unique.
- Confidence: Confirmed

### MIZAN-ACC-005 amount_paid is a stored counter, not derived from reconciled payments; the subledger drifts from the GL
- Severity: P1
- Category / Component: Receivables/payables, payments / src/models/accounting.js, pay.js
- Evidence:
  - accounting.js:91: payMove writes `amount_paid: (Number(r.amount_paid) || 0) + value` and `payments` onto the invoice. The receivable line on the payment entry is never matched to the invoice line. There is no reconciliation model for journal items.
  - accounting.js:67 `const value = Math.min(amount, residual(r));`: an overpayment is truncated silently, and no outstanding credit is recorded. pay.js:43 records `unapplied`, but nothing ever applies it later (grep: `unapplied` is only written in pay.js and quoteplus.js).
  - accounting.js:295 `Reset to Draft` is offered on any non-draft move without `amount_paid`, which includes the payment entries themselves. `Cancel` (l.296) then follows.
  - t5-cn-bank.mjs:
    ```
    Reset to Draft offered on payment entry? true
    After reset+cancel of payment entry: invoice amount_paid 600 | receivable {"GL":1210,"subledger":1110,"gap":100}
    ```
  - t9-misc2.mjs: `(d) pay 1710 on residual 1210 -> bank debit 1210 | payment record amount 1210 | excess recorded anywhere? no`
- Reproduction: `node acct/t5-cn-bank.mjs` and `node acct/t9-misc2.mjs`.
- Expected / Actual: Expected: the paid amount and residual are computed from reconciled receivable/payable lines, so cancelling a payment re-opens the invoice, and overpayments create an outstanding credit. Actual: the cancelled payment still counts as paid, and the extra 500 received simply disappears.
- Impact: Aged balances, follow-ups, credit limits, dunning and the "Paid" ribbon disagree with the ledger. Customer money can go unrecorded.
- Root cause: Verified (design).
- Recommended correction: Add reconciliation records (partial and full) linking the debit and credit lines. Compute `amount_residual` from them, refuse to reset or cancel a payment entry without unreconciling, and post the excess to an outstanding credit that can be matched later.
- Dependencies: ACC-001, ACC-006, ACC-007.
- Verification plan: Re-run t5 and t9(d). The GL and subledger gap should be 0 and the excess should show as a customer credit.
- Confidence: Confirmed

### MIZAN-ACC-006 Bank reconciliation marks statement lines reconciled with the wrong amount, the wrong sign, or no entry at all
- Severity: P1
- Category / Component: Bank reconciliation / src/models/bank.js
- Evidence: bank.js:25-30 `reconcileWith` calls `payMove(db, moveId, Math.abs(line.amount), ...)` and then always writes `state: 'reconciled'`. It does not check the direction against the move type, the amount booked against the line amount, or whether anything was booked at all. The "Match" button (bank.js:82) accepts any user-set `move_id`. t5-cn-bank.mjs:
  ```
  Bank line 5000 matched to invoice residual 1210 -> line state reconciled | bank debit booked 1210
  Outgoing line -300 matched to customer invoice -> bank line {"account_id":1,...,"debit":300,"credit":0} state reconciled
  Line 999 matched to already-paid invoice -> state reconciled | new moves 0
  ```
- Reproduction: `node acct/t5-cn-bank.mjs`.
- Expected / Actual: Expected: the bank GL equals the statement. A difference must be booked to a suspense or write-off account, or the match refused. Actual: the GL bank balance diverges from the statement (understated by 3,790, sign flipped, or missing 999) while every line shows "Reconciled".
- Impact: The bank account can no longer be proven against statements, and errors are hidden behind a reconciled status.
- Root cause: Verified.
- Recommended correction: Require the move type to match the direction, and require the booked amount to equal |line.amount|. Otherwise post the remainder to a suspense account or reject. Only mark a line reconciled when a bank journal item of that amount exists.
- Dependencies: ACC-005.
- Verification plan: Re-run t5. Each case should be rejected or fully booked.
- Confidence: Confirmed

### MIZAN-ACC-007 Credit notes never offset the invoice they reverse; unlimited credit notes per invoice
- Severity: P1
- Category / Component: Credit notes / refunds / accounting.js creditNote, finance.js agedBalance/followUps/receivableOf
- Evidence:
  - accounting.js:112-119: a credit note copies the lines and references the origin only as text (`invoice_origin: r.name`). The button list (accounting.js:287-297) has no "apply credit note" action.
  - finance.js:12, 90, 132: `receivableOf`, `agedBalance` and `followUps` count only `out_invoice` and ignore open `out_refund`.
  - The Credit Note button (l.293) can be pressed repeatedly.
  - t5-cn-bank.mjs, 1,140 invoice fully credited:
    ```
    CN RINV/2026/00001 residual 1140 | invoice INV/2026/00003 residual 1140 not_paid
    customer statement closing (GL, partner 5): 0
    aged receivable row partner 5: {"partner_id":5,"total":1140,...,"31_60":1140,...}
    follow-ups partner 5: ["INV/2026/00003"]
    credit-limit exposure partner 5 (receivableOf): 1140
    CN has Register Payment button? true
    ```
  - t9-misc2.mjs: `(b) invoice INV/2026/00001 total 7866 -> posted credit notes 3 credited total 23598`
- Reproduction: `node acct/t5-cn-bank.mjs` and `node acct/t9-misc2.mjs`.
- Expected / Actual: Expected: posting a credit note against an invoice reconciles the two, and the total credited cannot exceed what was invoiced. Actual: the GL shows the customer owes 0, yet the aged receivable and automatic reminders chase 1,140. "Register Payment" on the credit note would pay cash out while the invoice stays open, and the invoice can be credited three times over.
- Impact: Wrong dunning to customers, overstated receivables, and a path to refund the same amount twice.
- Root cause: Verified.
- Recommended correction: Link refunds to the original (`reversed_entry_id`) and auto-reconcile on post. Cap total credited at the invoice total. Include open refunds in the aged, follow-up and credit-limit figures.
- Dependencies: ACC-005.
- Verification plan: Re-run t5 and t9(b). The aged row should be 0 and the second credit note refused.
- Confidence: Confirmed

### MIZAN-ACC-008 Journal items with a missing or unknown account are accepted and silently dropped from every report, so the trial balance and balance sheet stop closing
- Severity: P1
- Category / Component: Double-entry / ledger.js, reports.js
- Evidence:
  - ledger.js:40-41 `isBalanced` checks amounts only. ledger.js:87-88 `postEntry` maps an unknown code to `account_id: null` and still posts. accounting.js:33 posts manual entries whenever `isBalanced`.
  - ledger.js:116 `balances(...).filter((b) => b.account)` and reports.js:27 `.filter((r) => r.account)` drop unknown accounts. The balance sheet ignores accounts whose `account_type` is outside its type lists (ledger.js:141-143).
  - `account.account` has no guard or protectDelete (accounting.js:177-194), and `accountId` takes the first account with a matching code (ledger.js:36).
  - Outputs:
    ```
    t6: postEntry with unknown code 24O000 -> posted posted lines [[23,500,0],[null,0,500]]
        invariants {"tb":{"initial":0,"debit":190776,"credit":190276,"end":500},"bs":{...,"gap":500},"unknown":1}
    t9: (a) entry with account-less line posted: posted | TB {...,"end":700} BS gap 700
    t9: (c) ACCEPTED sales user deletes 400000 -> TB {"initial":0,"debit":190276,"credit":181876,"end":8400} BS gap 8400 orphan lines 2
    t9: (c2) ACCEPTED duplicate account code 121000 created by sales user; accounts with code 121000: 2
    ```
- Reproduction: `node acct/t6-misc.mjs` and `node acct/t9-misc2.mjs`.
- Expected / Actual: Expected: posting needs a valid account on every line, accounts with posted items cannot be deleted, and codes are unique. Actual: all of these are accepted, and the reports no longer balance without any warning.
- Impact: Statements that are not internally consistent, and an easy way to make revenue "vanish" (deleting 400000 removed 8,400 of income).
- Root cause: Verified.
- Recommended correction: Validate `account_id` exists on every line, both in `postEntry`/`postMove` and in the server guard. Add `protectDelete` on `account.account` when it has journal items, plus a unique-code guard. Show unknown or untyped accounts as a "suspense" line rather than filtering them out.
- Dependencies: ACC-009.
- Verification plan: Re-run t6 and t9. Each case should be rejected.
- Confidence: Confirmed

### MIZAN-ACC-009 Chart of accounts and taxes are writable and deletable by users of every app
- Severity: P1
- Category / Component: Access control on financial master data / src/models/index.js modelsForApps
- Evidence:
  - index.js:564-577: relation expansion. `product` is in SHARED (index.js:561) and has relations to `account.account` and `account.tax`, so every app grants them.
  - acct-apps.mjs output: all 63 apps grant `account.account` and `account.tax`.
  - t2-forge.mjs:
    ```
    ACCEPTED 6c sales-only user retypes 121000 Receivable as income  -> BS gap 0 P&L/BS earnings 7190 (was 8400)
    ACCEPTED 6d sales-only user changes VAT 14% to 0%
    ```
  - t9 (c), (c2) above (delete 400000, duplicate code).
- Reproduction: `node acct-apps.mjs`, `node acct/t2-forge.mjs`, `node acct/t9-misc2.mjs`.
- Expected / Actual: Expected: only accounting managers can change the chart, account types and tax rates. Actual: any user can.
- Impact: Misstated P&L and balance sheet (receivables re-classified as revenue), and wrong VAT charged on later documents.
- Root cause: Verified.
- Recommended correction: Do not grant write access through relation targets (read-only for related models), and give account/tax/journal/fiscal-position models an accounting-manager-only write rule.
- Dependencies: ACC-001, ACC-008. Overlaps with the sec workstream.
- Verification plan: Re-run 6c and 6d. Both should be REJECTED.
- Confidence: Confirmed

### MIZAN-ACC-010 Fiscal-year closing breaks after server sync: `is_closing` is stripped, and a non-admin close does not lock the year
- Severity: P1
- Category / Component: Closing / src/models/closing.js, src/validate.js
- Evidence:
  - closing.js:57 `write(entry.db, 'account.move', entry.id, { is_closing: true })`. `is_closing` (and `revaluation_date`, `reversal_move_id`, closing.js:171) are not declared fields of `account.move` (accounting.js:229-266), and `cleanRecord` keeps declared fields only (validate.js:61-64). ledger.js:123 relies on the flag to exclude closing entries from P&L.
  - closing.js:58-60 sets `lock_date` through settings, which the server applies only for admins (sync.js:94, 101).
  - t6-misc.mjs:
    ```
    Client after close: P&L net FY2026 = 8400 | closing move is_closing = true
    Server copy after /api/diff: P&L net FY2026 = 0 | closing move is_closing = undefined | lock_date 2026-12-31
    Non-admin accountant closes year: server lock_date = undefined | fiscal year state closed
    ```
- Reproduction: `node acct/t6-misc.mjs`.
- Expected / Actual: Expected: the closed year's P&L still reports its result, and closing locks the period. Actual: after any reload from the server, the closed year's P&L is 0 (the closing entry is netted in). When an accountant who is not an admin closes the year, it shows "closed" but is not locked.
- Impact: Wrong historical P&L and comparatives, and closed years that stay editable.
- Root cause: Verified.
- Recommended correction: Declare `is_closing`, `revaluation_date` and `reversal_move_id` as (readonly) fields. Perform closing and its lock-date update server-side with a manager permission.
- Dependencies: ACC-002.
- Verification plan: Re-run t6. The server P&L should be 8400 and lock_date 2026-12-31 for both users.
- Confidence: Confirmed

### MIZAN-ACC-011 The audit trail is written by the client: changes can be made without a trace, and backdated entries can be injected
- Severity: P1
- Category / Component: Audit trail / src/orm.js trackingMessages, src/sync.js, src/views/Reports.jsx AuditTrail
- Evidence:
  - Tracking messages are produced only in the browser (orm.js:84-94, 108). The server accepts `d.messages` as sent (sync.js:82-85). It overwrites only `author` and keeps the client's `date` and `body` (validate.js:68-71). It never generates a message for a change it applies.
  - Reports.jsx:235-238 builds the audit trail from `db.messages`.
  - What works: with `audit_trail` on, existing messages of audited models cannot be removed (sync.js:80-81). The setting cannot be turned off (sync.js:106).
  - t10-audit.mjs:
    ```
    honest diff carries 1 tracking message(s): [ 'Reference: undefined → PO-123' ]
    server messages for move after honest diff: 1 | after forged diff without messages: 0 | ref on server: PO-123
    audited message removable? no (kept)
    audit trail OFF: message removable? yes (removed)
    ```
  - t2 10e: `stored {"author":"mallory","date":"2020-01-01T00:00:00Z","body":"Status: Draft → Posted (approved by CFO)"}`
- Reproduction: `node acct/t10-audit.mjs` and `node acct/t2-forge.mjs`.
- Expected / Actual: Expected: the server records who changed what and when, for every accepted change. Actual: the trail contains whatever the client chose to send, with client-chosen timestamps.
- Impact: The audit trail cannot be relied on as evidence, so it gives no detective control against ACC-001 and ACC-002.
- Root cause: Verified.
- Recommended correction: Generate tracking server-side inside `applyDiff` from the before/after records, use the server clock, ignore client tracking messages for audited models, and keep an append-only log table.
- Dependencies: ACC-001.
- Verification plan: A forged diff without messages should still produce a server-side audit row.
- Confidence: Confirmed

### MIZAN-ACC-012 Consolidation output does not balance (no CTA, prior-year earnings dropped, one-sided equity method, no NCI)
- Severity: P1
- Category / Component: Consolidation / src/models/consolidation.js
- Evidence:
  - consolidation.js:103 skips P&L lines dated before the period, and no retained-earnings line replaces them.
  - l.105: balance-sheet lines at the closing rate and P&L at the average rate, with no translation-difference (CTA) line, and equity is translated at the closing rate instead of the historical rate.
  - l.95: `full` uses factor 1 even at 60% ownership, and no non-controlling interest is computed.
  - l.106-108, 120: the equity method adds an "Investment in" line with no counterpart.
  - t8-consol.mjs (the sum of all group balances should be 0):
    ```
    full 100% -> ... | sum of all group balances (should be 0): 50
    full 60% -> [same as 100%] ... 50
    proportional 60% -> ... 30
    equity 30% -> ... ["EQUITY:3",112.5] ... 112.5
    ```
- Reproduction: `node acct/t8-consol.mjs`.
- Expected / Actual: Expected: the consolidated trial balance closes (debits equal credits). Actual: it is off by 50, 30 or 112.5 in these small fixtures.
- Impact: Group statements are unusable without manual adjustment, and closed consolidation periods freeze the wrong numbers (consolidation.js:142-144).
- Root cause: Verified.
- Recommended correction: Add CTA and retained-earnings (opening equity) lines, use historical rates for equity, add an NCI calculation for full consolidation below 100%, and book the equity-method counterpart (share of result or equity). Assert that the result sums to zero before closing.
- Dependencies: ACC-013.
- Verification plan: t8 should show 0 for all methods.
- Confidence: Confirmed

### MIZAN-ACC-013 Multi-currency: every ledger is booked in the global `settings.currency`, so non-base companies are translated twice; journal items carry no currency amounts
- Severity: P1
- Category / Component: Multi-currency, multi-company / ledger.js invoiceLines, currency.js, consolidation.js
- Evidence:
  - ledger.js:49 `rateAt(db, move.currency_id, ...)` converts against the single base currency (currency.js:7-17). The company's own `currency_id` (company.js) is not used.
  - consolidation.js:65 then converts each company's balances from `company.currency_id` to the group currency again.
  - Journal lines have only debit and credit (accounting.js:163-174), with no `amount_currency` or `currency_id`, so foreign-currency open items cannot be tracked.
  - currency.js:12 falls back to the earliest future rate when no rate exists on or before the date (`?? rates[0]`).
  - t11-mc.mjs:
    ```
    EUR 100 invoice in EUR-functional company booked as [["INV/2026/00003",108.7,0],["Sales",0,108.7]]
    consolidated AR in USD (expected 100/0.92 = 108.70): 120.78
    ```
- Reproduction: `node acct/t11-mc.mjs`.
- Expected / Actual: Expected: the EUR company's ledger holds 100 EUR, and consolidation shows 108.70 USD. Actual: the ledger holds 108.70 (USD amounts in a EUR company), and consolidation shows 120.78.
- Impact: Wrong local books for every company whose currency is not the base currency, and wrong group figures.
- Root cause: Verified for this path. Hypothesis: other paths that call `toCompany` (payMove, unrealizedExchange) behave the same way.
- Recommended correction: Convert to the move's company currency, store `amount_currency` and `currency_id` per line, and require a rate on or before the date.
- Dependencies: ACC-012, ACC-015.
- Verification plan: Re-run t11. The ledger should be 100 and consolidation 108.70.
- Confidence: Confirmed (invoice + consolidation path)

### MIZAN-ACC-014 POS ignores configured tax records: price-included VAT is added on top, and fiscal positions and product accounts are ignored
- Severity: P1
- Category / Component: Tax computation / src/models/pos.js
- Evidence:
  - pos.js:26 `priceLines` sets `tax: p?.sale_tax ?? 14` with no `tax_include`, `tax_type`, `tax_id`, cash basis or fiscal position.
  - pos.js:56-63 always posts to 400000 and 251000.
  - t9-misc2.mjs: `(e) POS sale of product priced 114 incl. 14% VAT -> cash debit 129.96 revenue 114 VAT 15.96`
- Reproduction: `node acct/t9-misc2.mjs`.
- Expected / Actual: Expected: 114 charged, of which 100.00 is revenue and 14.00 VAT. Actual: 129.96 charged, revenue 114 and VAT 15.96.
- Impact: Customers are overcharged and VAT is overstated on every POS sale of a product with a price-included or non-default tax. Zero-rated or exempt POS sales still get 14%.
- Root cause: Verified.
- Recommended correction: Use `productTax(db, product, 'sale', fp)` and the line snapshot like invoices do, and post through `invoiceLines`-style grouping by account.
- Dependencies: ACC-016.
- Verification plan: Re-run t9(e). The cash debit should be 114.00.
- Confidence: Confirmed

### MIZAN-ACC-015 Rounding: the receivable line can differ from the document total, leaving cent residues after "paid"; the same happens for FX and cash-basis taxes
- Severity: P2
- Category / Component: Journal generation / ledger.js invoiceLines, common.js amounts, accounting.js payMove/releaseCashBasis
- Evidence:
  - ledger.js:63, 71-73 round per account and per tax account, and the counterpart is the sum of the rounded parts. common.js:22-27 `amounts` rounds the document as a whole, and payments clear `amount_total` (accounting.js:67-76).
  - Cash-basis release is proportional to each payment, with no final true-up (accounting.js:101).
  - accounting.js:91 does not round `amount_paid` (t1: `paid 9986.400000000001`).
  - Outputs:
    ```
    t4 1) amount_total 22.81 receivable line 22.82 -> mismatch 0.01 ... after full payment: payment_state paid residual 0 receivable GL left on this invoice 0.01
    t4b try 2 ... EUR total 414.39 state paid receivable residue (company ccy) 0.01
    t4b try 5 ... EUR total 237.94 state paid receivable residue (company ccy) -0.01
    t4 6) cash-basis tax 14.00 paid in 3 parts -> residue on transition account 251100: 0.01
    ```
    The t4b residues come from same-day payments at the same rate, so no exchange difference should arise.
- Reproduction: `node acct/t4-rounding-fx.mjs` and `node acct/t4b-fx-search.mjs`.
- Expected / Actual: Expected: a fully paid invoice leaves zero on the receivable and the transition accounts. Actual: ±0.01 remains (2 of 5 random EUR invoices).
- Impact: Receivable and partner-ledger balances that never reach zero, and a reconciliation burden. Small per document, but it accumulates.
- Root cause: Verified.
- Recommended correction: Build the counterpart from the rounded document total and push the rounding difference to the largest base line. On the final payment, clear the exact remaining receivable and transition balances.
- Dependencies: ACC-005, ACC-013.
- Verification plan: Re-run t4 and t4b. The residues should be 0.
- Confidence: Confirmed

### MIZAN-ACC-016 VAT return halves disagree: the per-tax table comes from documents in their own currency, the totals from the journal
- Severity: P2
- Category / Component: Tax reporting / finance.js taxReport, taxesByTax; Reports.jsx Tax
- Evidence:
  - finance.js:59-68 `taxReport` sums only accounts 251000 and 131000 from journal items, in company currency.
  - finance.js:73-86 `taxesByTax` sums invoice lines with no currency conversion, counts cash-basis tax at the invoice date, and excludes `entry` moves (so POS is excluded).
  - Reports.jsx:138-159 shows both halves on one page.
  - t12-taxrep.mjs:
    ```
    + EUR 1000 invoice @0.92 | journal output VAT 1118.17 | per-tax table sale tax sum 1106
    + unpaid cash-basis 1000 invoice | journal output VAT 1118.17 | per-tax table sale tax sum 1246
    + POS sale (dated today) | journal output VAT 1139.17 | per-tax table sale tax sum 1246
    ```
- Reproduction: `node acct/t12-taxrep.mjs`.
- Expected / Actual: Expected: the base and tax per tax reconcile to the output and input totals. Actual: three independent discrepancies.
- Impact: The VAT return cannot be filed from this screen without manual reconciliation. Taxes posted to any account other than 251000/131000 are missing from "Tax Payable".
- Root cause: Verified.
- Recommended correction: Derive both halves from tax journal items tagged with the tax id and base amount (tax grids). Convert to company currency, and include POS and cash-basis releases by exigibility date.
- Dependencies: ACC-014, ACC-013.
- Verification plan: t12 should show equal totals.
- Confidence: Confirmed

### MIZAN-ACC-017 POS-only and payroll-only users cannot complete sales or payslips (the whole diff is rejected)
- Severity: P2
- Category / Component: Permissions vs posting flows / index.js modelsForApps, pos.js, payroll.js
- Evidence: POS posts through `postEntry` (pos.js:56) and payroll through `postEntry` (payroll.js:146, 160), both of which create `account.move`. That model is not in `modelsForApps(['pos'])` or `modelsForApps(['payroll'])` (acct-apps.mjs output). applyDiff is all-or-nothing (sync.js:48, 61). Outputs:
  ```
  t6: REJECTED POS-only user: pay an order (creates POS journal entry) -> No access to account.move
  t7: REJECTED payroll confirm payslip -> No access to account.move
  ```
- Reproduction: `node acct/t6-misc.mjs` and `node acct/t7-payroll.mjs`.
- Expected / Actual: Expected: the cashier's sale and the payroll officer's confirmation are posted. Actual: they are rejected. In the UI the change is applied optimistically and then reverted with an alert (store.js:100-114).
- Impact: Cashiers and payroll staff must be given broader access, which worsens ACC-001, or the flows fail.
- Root cause: Verified.
- Recommended correction: Server-side posting services that run with system rights after checking the user's right to the business document.
- Dependencies: ACC-001.
- Verification plan: Re-run t6 and t7. Both should be ACCEPTED, with entries created by the server.
- Confidence: Confirmed

### MIZAN-ACC-018 Negative amounts are accepted: negative debits and credits, and a negative-total customer invoice is shown as "Paid"
- Severity: P2
- Category / Component: Journal generation / ledger.js invoiceLines, accounting.js residual
- Evidence:
  - ledger.js:74 `side()` keeps the sign. The comment at ledger.js:43 says "positive amounts only", but nothing enforces it.
  - accounting.js:18 `Math.max(0, …)` turns a negative total into residual 0, which reads as "paid".
  - t4-rounding-fx.mjs:
    ```
    4) invoice with net-negative account bucket: total -57 lines [[3,-57,0],[17,0,100],[18,0,-150],[9,0,-7]] balanced? true
    5) negative-total invoice posted: total -114 residual 0 payment_state paid lines [[3,-114,0],[17,0,-100],[9,0,-14]]
    ```
  - t9: `(a2) entry with negative debit/credit posted: posted`
- Reproduction: `node acct/t4-rounding-fx.mjs` and `node acct/t9-misc2.mjs`.
- Expected / Actual: Expected: negative buckets flip to the opposite side, and a negative invoice is refused (use a credit note). Actual: negative debits are posted, and a -114 "invoice" shows as Paid while the customer has a 114 credit balance.
- Impact: Confusing ledgers and hidden customer credits. Reports that sum debits and credits separately are misstated.
- Root cause: Verified.
- Recommended correction: Normalise each line to a non-negative debit or credit. Reject `out_invoice`/`in_invoice` with a total ≤ 0.
- Dependencies: ACC-007.
- Verification plan: Re-run t4 cases 4 and 5.
- Confidence: Confirmed

### MIZAN-ACC-019 Country-specific e-invoicing: ZATCA phase-1 QR only; no Egypt ETA or UAE e-invoicing. These are gaps, not compliance.
- Severity: P2
- Category / Component: Localisation / src/models/qr.js, Settings
- Evidence:
  - qr.js:10-14: the ZATCA payload is TLV tags 1-5 only (seller, VAT number, timestamp, total, VAT).
  - qr.js:27 uses `timestamp: ${move.invoice_date}T00:00:00Z` (midnight, not the issue time), and the amounts are `amount_total`/`amount_tax` in the invoice currency.
  - Only `out_invoice` gets a QR (qr.js:25). The VAT number is a free 40-character string (sync.js:108) with no format check.
  - EPC (qr.js:17-21) follows the BCD/002/1/SCT layout, is EUR-only, validates the IBAN shape only (no checksum), and needs the company currency to be EUR (qr.js:30).
  - A grep for egypt|uae|peppol|fatoora|e-invoic|withholding in src and server returns no tax feature. The only Egypt references are the "Domestic" fiscal position country (seed.js:98) and the 14% default rate (taxes.js:79, common.js:49).
- Reproduction: Code reading.
- Expected / Actual (based on known requirements; NOT VERIFIED against current official specs, no network):
  - ZATCA phase 2 is missing: UBL 2.1 XML, cryptographic stamp, invoice hash chain/ICV, UUID, QR tags 6-9, clearance/reporting API, standard vs simplified invoice types, credit/debit-note QR, and amounts in SAR.
  - Egypt ETA e-invoice and e-receipt submission (signed JSON or XML, ETA item codes) is missing.
  - UAE: no 5% VAT preset and no FTA e-invoicing (PINT-AE/Peppol) support.
- Impact: The product cannot be presented as compliant in KSA, Egypt or the UAE. The QR alone does not meet current KSA obligations for most taxpayers (hypothesis, based on the published phase-2 waves).
- Root cause: Verified (features absent).
- Recommended correction: Treat these as localisation modules with their own certification. In the meantime, label the QR as "phase 1 only" in the UI and docs.
- Dependencies: ACC-004 (unique sequential numbering is a prerequisite for any of these regimes).
- Verification plan: Check against the official specifications once network access is permitted.
- Confidence: Strongly supported (code facts confirmed; regulatory scope not verified)

### MIZAN-ACC-020 Minor accounting defects (bundle)
- Severity: P3
- Category / Component: Various
- Evidence (each read in code):
  - company.js:60: the scoped-model guard wrapper calls `model.guard?.(db, before, r)` and drops the `{isAdmin}` argument that sync.js:60 passes. A future admin-aware rule on `account.move` or `account.payment` would never see it.
  - common.js:74 `nextName` counts across all companies, so numbering is not per company.
  - accounting.js:115: a credit note keeps only the text `invoice_origin` and has no link to the reversed move.
  - common.js:34-47: the invoice line schema has no `analytic_distribution`, so the server strips the multi-plan distributions that analyticplus.js:34-36 reads.
  - accounting.js:295: Reset to Draft keeps the generated `line_ids` and the number on the draft. There is no report impact, because reports filter on posted (ledger.js:108).
  - server/api.js:240-244: the demo checkout marks the sale order `payment_state: 'paid'` with no payment entry.
  - Sale order → invoice does not copy `currency_id` (sales.js:73-83).
- Reproduction: Code reading.
- Expected / Actual: See each item.
- Impact: Low individually.
- Root cause: Verified by reading.
- Recommended correction: Pass the opts through the wrapper, number per company and journal, add `reversed_entry_id`, declare `analytic_distribution`, clear `line_ids` on reset, and copy the currency.
- Dependencies: ACC-004, ACC-007, ACC-013.
- Verification plan: Unit tests per item.
- Confidence: Confirmed (code reading)

---
## Positive controls observed (logic correct in the browser function, and where it is enforced)
- In the browser: invoices, bills, refunds, payments with FX gain/loss, early-payment discounts, cash-basis releases, depreciation and POS all produce balanced entries. After the full flow in t1, debits equal credits, the trial balance is zero, the balance sheet balances, cash flow sections equal net cash, and AR/AP subledgers equal the GL.
- Reports (trial balance, P&L, balance sheet, GL, cash flow, partner ledger) read posted journal items only (ledger.js:108) and reconcile with each other on consistent data.
- On the server:
  - Changing `name`, lines, date, state, partner, currency or type of a move dated inside a lock date is rejected, as are deleting it and creating posted moves inside the lock.
  - Lock settings are admin-only, and the hard lock cannot be moved back.
  - With the audit trail on, a posted number cannot change, numbered moves cannot be deleted, and audited messages cannot be removed.
