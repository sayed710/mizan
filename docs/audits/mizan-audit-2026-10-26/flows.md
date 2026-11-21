# Mizan audit: D1, end-to-end ERP business workflows (id: flows)

## Summary
- I drove all 7 workflows through the real `seed()`, the ORM and the form-button `run` handlers (`models[m].form.buttons`). After each step I passed the client's change set through the server's `applyDiff(..., {isAdmin:false})` to check what the server keeps. Scripts and outputs are in `scratchpad/work-flows/flows/` (`w1_sales.mjs` … `w7_company.mjs`, `t4`–`t11`; outputs in `flows/out/*.txt`).
- **The happy paths mostly work and post correct double entry.** Sales: Dr Bank 1299.6, Cr VAT 159.6, Cr Revenue 1140, COGS 600 against stock, and the receivable clears to 0. Purchase: the 110200 interim nets to 0 and the price difference goes to 600000. POS sale plus refund nets to {}. MRP posts the operation cost to stock.
- **Biggest problem:** every workflow rule (state transitions, quantities, amounts, posting) lives only in browser `run()` code. The server accepts any forged transition from a non-admin, so posted invoices, payments, stock and MOs can be rewritten (FLOW-001, P0).
- Concurrent use from the same 15-second snapshot can ship the same stock twice and silently overwrites a posted journal entry, because IDs collide and the last writer wins (FLOW-002, P0).
- The server's sanitizer drops fields the logic depends on. Gift cards can be reused, POS refunds are valued at the wrong cost, and a product that has been rented can no longer be delivered (FLOW-004). Work orders cannot be started at all in server mode (FLOW-005).
- Multi-company is mostly cosmetic. Generated documents always get `company_id` 1. Company selection is one global setting that any user can change. The server and the Reports page do not filter by company. The inter-company PO puts sales VAT on the purchase bill (FLOW-009/010/011).
- Some problems are reachable from the normal UI without any forging: unlimited, unlinked credit notes (FLOW-008), over-delivery and repeated returns (FLOW-006), the subscription "Automatic Payment" box booking fake bank receipts (FLOW-012), and service lines on POs that can never be billed (FLOW-015).
- Tests: 69 workflow tests pass (`node --test` on 10 files). None of the workflow tests send results through `applyDiff`. The company tests exercise helpers (`createForCompany`, `defaults(id, db)`) that the app never calls.

## What I verified / what I could not verify
- Verified by running scripts on a copy (`work-flows`), outputs quoted below: all 7 workflows; forged non-admin diffs (`w1b_forge.mjs`); sync loss (`serverSync` in `flows/lib.mjs`); concurrency (applying two diffs from the same base, in the same way as `server/index.js:432-435`).
- Not run: the HTTP server or a browser. The double-click race (the UI evaluates `when` on render, `run` does not re-check) is a **hypothesis**. The underlying "`run()` has no state check" is confirmed. I did not test the REST `/api/v1` write paths (sec agent's area). I did not check currencies or multi-currency IC.
- I assume `seed()` is representative. Seed specifics are flagged where they matter (FLOW-015, FLOW-016).

## Workflow results (steps; ✔ works, ✖ missing/wrong)
| # | Workflow | Working | Missing / wrong |
|---|---|---|---|
|1|Sales|customer → quotation → Confirm (1 routed delivery `WH/OUT`, ready) → Validate (chair 135→130; Dr 500000 600 / Cr 110100 600) → Create Invoice (2nd click refused "Nothing left to invoice") → Confirm `INV/2026/00003` (121000 +1299.6 / 251000 −159.6 / 400000 −1140) → Register Payment (101401 +1299.6 / 121000 −1299.6; partner 121000 = 0)|✖ no cancel of a confirmed SO (`sales.js:399`); ✖ credit notes unlimited and unlinked (FLOW-008); ✖ returns don't reduce `qty_delivered` (FLOW-006); ✖ `run()` lacks state checks (FLOW-003)|
|2|Purchasing|vendor → RFQ → Confirm Order (receipt `WH/IN`; 2nd confirm refused by purchaseplus `confirmOrder`, `purchaseplus.js:86`) → receive 6/10 (backorder of 4; Dr 110100 540, Dr 600000 60, Cr 110200 600) → bill 6 (Dr 110200 600, 131000 84 / Cr 211000 684) → pay → 211000 = 0 → backorder → bill 4; 3rd bill refused; billing above received refused (client side)|✖ the service line (Installation) is never billed (FLOW-015); ✖ the "billed > received" check is client-only (FLOW-001)|
|3|Inventory|receipt (Mark as Todo → Validate), FIFO layers [10@10, 10@12], delivery of 15 valued at 160 (FIFO correct), partial delivery + backorder, delivery beyond on-hand refused for real-time products|✖ "ready" is not a reservation; waiting pickings can be validated; periodic products go negative (FLOW-007); ✖ concurrent deliveries consume the same stock (FLOW-002); ✖ valuation report ≠ GL (FLOW-016)|
|4|Manufacturing|BoM → MO Confirm (move_raw scaled) → Plan Work Orders → Produce blocked until WOs done → Produce (components −2 each, desk +2, operation cost 45.83 capitalised: Dr 110100 / Cr 600000); partial produce → backorder MO; shortage refused|✖ WO Start refused by the server (FLOW-005); ✖ a done MO can be re-confirmed and produced again; standard cost overwritten; consumed=0 accepted (FLOW-003, FLOW-014); ✖ MO availability is not a reservation (FLOW-007)|
|5|POS|session open (2nd refused) → payOrder (stock out; Dr Cash 245.1 / Cr 400000 215, 251000 30.1; COGS 121.2) → Refund (stock back, entry reversed, net {}) → 2nd refund refused → close with −5 difference (Dr 690000 5 / Cr Cash 5); split tender posts Cash + Bank|✖ refund cost is lost after sync (FLOW-004); ✖ out-of-stock items cannot be sold; fractional split quantities (FLOW-017); ✖ server accepts rewriting paid orders or deleting refunds (FLOW-001)|
|6|Subscriptions|Start → scheduler `runScheduledJobs` posts due periods; idempotent on re-run; fixed-term sub billed Jul/Aug and closed at `end_date`; Renew drafts a successor; Close/Reopen|✖ "Automatic Payment" books fake bank receipts (FLOW-012); ✖ back-dated catch-up, same-run auto-close, Reopen bills the closed gap (FLOW-013)|
|7|Multi-/inter-company|`interCompanyRules` runs inside the quoteplus Confirm: draft PO in company 2, vendor = seller partner 8, `auto_purchase_id` set, idempotent PO on re-confirm|✖ every generated document gets company 1 (FLOW-009); ✖ no isolation and a global selection (FLOW-010); ✖ VAT side wrong on the IC bill; errors swallowed; SO cancel leaves the PO (FLOW-011)|

### Client-only vs server-enforced (applyDiff with `isAdmin:false`, `w1b_forge.mjs`)
The server enforces only the following: field types and select options (`validate.js:11-47`); `required` (`orm.js:37-42`); the company consistency of partner/product/journal links (`company.js:34-48,60`); lock dates and the audit-trail number (`finance.js:40-56`); and a few per-model guards (product UoM, warehouse code, plan interval, and so on).

Everything listed below is **client-only**. Each forge was ACCEPTED, except one run with a lock date and the audit trail enabled. I did not check whether such a guard is commonly enabled:

`posted invoice -> cancel` (partner 121000 1688.8 → 1210) · `amount_paid = total, no payment entry` (shows "paid", 121000 unchanged) · `posted invoice price_unit -> 1` (total 2.28, journal still 478.8) · `unbalanced posted line_ids` (−477.8) · `new POSTED entry Dr Bank 1,000,000, no credit` (101401 158366 → 1158366) · `re-number posted invoice` · `SO qty_invoiced -> 0` (then Create Invoice works again: new invoice 12) · `SO draft -> sale` (no picking) · `done picking -> ready` (re-validated: chair 133 → 131) · `product.qty_available -> 1e6` · `product.cost -> 0.01` · `posted payment amount -> 999999` · delete posted invoice / done picking / valuation layer / confirmed SO (with no `onUnlink`, so the SO stays "invoiced") · `MO done -> confirmed` · rewrite a paid `pos.order` · delete a POS refund and refund again · `sale.subscription.payment_token = true` · `account.move.company_id` reassigned · global company selection changed by a user restricted to `sale.order`.

Refused: `with lock_date+audit_trail: cancel posted invoice -> REFUSED The period up to 2026-12-31 is locked`.

### Test coverage per workflow (grep `src/*.test.js`)
| Workflow | Test files | What they assert |
|---|---|---|
|Sales|`sales-invoicing.test.js` (2), `quoteplus`, `orm`, `uom-flows`, `valuation-wiring`|state, quantities, invoice lines; one assertion that an income account is credited (`sales-invoicing.test.js` "posted … line_ids.some(credit>0)"); no receivable or payment assertion|
|Purchasing|`billcontrol` (8), `purchaseplus` (9), `valuation-wiring` (12), `uom-flows`|`valuation-wiring`/`billcontrol` do assert accounts (interim, price difference)|
|Inventory|`picking` (6), `warehouse` (10), `routes`, `valuation`|state and quantities only (`picking.test.js`: 0 account assertions); no concurrency test|
|MRP|`mrp` (3), `workorder` (8), `more`|quantities; `workorder.test.js:94` asserts one balanced MISC entry; **no applyDiff**, so the date-type bug (FLOW-005) is invisible|
|POS|`pos` (1), `posplus` (10)|session totals and cash difference; a few account checks; no sync of `stock_costs`|
|Subscriptions|`subscription` (5), `subscriptionplus` (10), `review-fixes3`|invoice counts and balance; `subscriptionplus.test.js:46` *expects* "mock tokens pay through the ledger"|
|Multi-company|`company` (9), `companyView` (6)|helpers `createForCompany` and `defaults(99, db)` (`company.test.js:69-89`), not the `orm.create`/FormView path; IC test only checks `auto_sale_id` linkage (`company.test.js:156-163`)|
|Server enforcement|`sync`, `security`, `finance`, `review-fixes*`|shape stripping (`security.test.js:20` asserts unknown keys are dropped), lock dates; **no workflow-transition test**|

---

### MIZAN-FLOW-001 Workflow state machines exist only in the browser; the server accepts forged postings, stock and state from non-admins
- Severity: P0
- Category / Component: Integrity / `src/sync.js` applyDiff, all workflow models
- Evidence: `src/sync.js:57-62`: `const rec = cleanRecord(model, raw); … const err = validate(model, rec) ?? models[model].guard?.(seen, current.get(rec.id) ?? null, rec, { isAdmin }); … current.set(rec.id, rec);`. The only accounting guard is `src/models/finance.js:40-48` (`moveGuard`: audit-trail name, plus `lockDateFor`… `return changed ? 'The period … is locked' : null`). `mrp.production`, `pos.order`, `pos.session`, `sale.subscription` and `stock.valuation.layer` have no guard (`flows/buttons.mjs` output: `mrp.production | guard: false`, `pos.order | guard: false`, `sale.subscription | guard: false`, `stock.valuation.layer | guard: false`). The scoped-model guard wrapper keeps only company checks and drops the `{isAdmin}` argument: `company.js:60` `guard: (db, before, r) => model.guard?.(db, before, r) ?? checkCompany(...)`. Output of `w1b_forge.mjs`: the list of ACCEPTED forges in the section above.
- Reproduction: `node flows/w1b_forge.mjs` (the copy's `src/`). Each forge is a single-record upsert, which is exactly what `POST /api/diff` takes (`server/index.js:432-435` → `applyDiff(db, diff, {isAdmin: user.isAdmin, allowed})`).
- Expected / Actual: The server should re-derive or validate state transitions, totals, `line_ids`, `amount_paid`, stock quantities and layer values. Actually, a non-admin can cancel or reprice posted invoices, mark them paid without a payment, post unbalanced entries, inflate stock, re-open done pickings and MOs, and delete posted documents.
- Impact: The general ledger, receivables, stock and valuation can be falsified by any logged-in user with access to the app (or a compromised browser session). Reports (`ledger.js:106-110` reads `state === 'posted'` and `line_ids`) will show the forged figures.
- Root cause: Verified. The architecture trusts client-computed records. Server validation is shape-only, plus lock dates.
- Recommended correction: Move transitions to server actions (POST `/api/action {model,id,button}` that runs the same `run()` on the authoritative db and checks `when`). Then make protected fields (`state`, `line_ids`, `amount_paid`, `payments`, `qty_*`, `qty_available`, `cost`, valuation layers, posted `invoice_line_ids`) read-only in applyDiff, with a per-model guard that rejects changes to them outside actions. Posted `account.move` records need an immutability guard (only `amount_paid`/`payments` changed by the payment action), plus a server-side balance check.
- Dependencies: Same root cause as accounting/security findings by the acct and sec agents (dedupe there if they report posted-entry forging). FLOW-003, FLOW-012.
- Verification plan: For each forge in `w1b_forge.mjs`, expect a refusal. Add a test that runs every button through the new server action and asserts `when` is enforced.
- Confidence: Confirmed

### MIZAN-FLOW-002 Two users working from the same snapshot ship the same stock twice and overwrite each other's posted journal entries (ID collision + last-writer-wins)
- Severity: P0
- Category / Component: Concurrency / `src/orm.js` nextId, `src/sync.js`, `src/store.js`
- Evidence: `orm.js:7` `export const nextId = (db, model) => (db.seq[model] ?? 0) + 1;` (client-allocated). `sync.js:62` `current.set(rec.id, rec);` (no existence or version check). The client polls every 15 s (`store.js:11 POLL_MS = 15000`). `w3_inventory.mjs` output:
  `concurrent deliveries of the same 10 units: second diff ACCEPTED` / `pickings done,done | on hand 0 (20 units shipped from 10)` / `layer ids created by A [ 6 ] by B [ 6 ] | server layers for item [[5,10,2],[6,-10,4]]` / `journal entry ids A [ 11 ] B [ 11 ] | server entry WH/OUT/00004 | A's entry survived? false`.
  `t8.mjs`: `A id 4 B id 4` / `A's quotation (partner 1) survives? false`.
- Reproduction: In the copy, `node flows/w3_inventory.mjs` (last block) and `node flows/t8.mjs`. Each user validates a different delivery of the same 10 units, and the two diffs are applied in sequence by the same `applyDiff` the server uses.
- Expected / Actual: The second validation should fail ("not enough stock") or be rejected as stale. Actually both deliveries are done, `qty_available` ends at 0 (not −10), user A's valuation layer and COGS entry are replaced by user B's, and a new quotation from A is silently replaced by B's.
- Impact: Silent loss of posted journal entries and documents. Stock is physically shipped twice while the system shows 0. Valuation and COGS become understated.
- Root cause: Verified. IDs come from the client's seq; upserts overwrite by id; the product's `qty_available` is an absolute value written by each client.
- Recommended correction: Allocate IDs on the server (or use UUIDs) and reject an upsert of a non-existent id that collides. Add per-record versions (optimistic locking) and reject stale writes. Better still, run stock and posting actions server-side (see FLOW-001) so quantities are decremented atomically.
- Dependencies: db agent (LWW and ID allocation; dedupe there). FLOW-001.
- Verification plan: Re-run the concurrency block and expect the second diff to be refused, or a new non-colliding ID with the stock check failing.
- Confidence: Confirmed (the in-process `applyDiff` sequence is the same code path as `/api/diff`; I did not test against the HTTP server)

### MIZAN-FLOW-003 Button `run()` handlers do not re-check state, so hidden transitions run when invoked (double Confirm, cancelling a paid invoice, paying a draft, producing a done MO twice)
- Severity: P1
- Category / Component: Workflow / sales.js, accounting.js, more.js
- Evidence: `sales.js:388-396`: Confirm's `when` is `['draft','sent']`, but `run` writes `state:'sale'` and creates a picking with no state check. `accounting.js:296` Cancel and `:295` Reset to Draft check nothing in `run`. `payMove` (`accounting.js:65-67`) does not check `state === 'posted'`. `more.js` Confirm → `confirmMo` has no state check. The UI evaluates `when` on the rendered record and then calls `run(getDb(), read(...))` (`FormView.jsx:282-286, 299`). Server code calls `run()` directly too (`server/api.js:241-242`). Output of `w1_sales.mjs`:
  `Confirm again: visible= false pickings now 2` · `Cancel paid+posted invoice via run(): … state cancel receivable for partner after -1299.6 SO invoice_status to_invoice` · `Create Invoice after cancelling the paid invoice: new invoice 13` · `Register Payment on DRAFT invoice via run(): … invoice state draft amount_paid 51.3 bank delta {"101401":51.3,"121000":-51.3}` · `Cancel confirmed+invoiced SO via run(): … state cancel done pickings untouched [ 'done' ]`.
  Output of `t4.mjs`: `re-confirm done MO then Produce: ACCEPTED desk 22 -> 24, oak 38 -> 36`. Output of `w7_company.mjs`: `IC Confirm twice (run): 1 POs; 2 pickings`. The purchase Confirm does check state (`purchaseplus.js:86`: "Only draft quotations can be confirmed"), which shows the pattern is inconsistent.
- Reproduction: `node flows/w1_sales.mjs` and `node flows/t4.mjs` (calls with `{force:true}` skip `when`, the same way a stale form or a direct call would).
- Expected / Actual: Each `run` should refuse when its precondition fails. Actually, duplicate deliveries are created, paid invoices are cancelled (leaving a credit receivable and a re-invoiceable SO), payments are booked against draft invoices, and an MO produces twice.
- Impact: Double shipments, double invoicing and corrupted receivables, if a stale tab, a double-click (hypothesis, not reproduced in a browser) or a server/API caller invokes the action.
- Root cause: Verified. `when` is used only to render buttons.
- Recommended correction: Make every action function assert its own precondition (reuse `when` inside the runner: `if (b.when && !b.when(record)) throw …`, centrally in FormView and in any server action dispatcher). Add explicit checks to `payMove`, `confirmMo` and the sale Confirm.
- Dependencies: FLOW-001 (the server must enforce the same).
- Verification plan: Unit tests that call each `run` in a disallowed state and expect a throw.
- Confidence: Confirmed (code path); the double-click race is a hypothesis

### MIZAN-FLOW-004 The server's record sanitizer silently drops workflow fields the models write but do not declare: gift cards become reusable, POS refunds are mis-valued, rented products can no longer be delivered
- Severity: P1
- Category / Component: Data loss / `src/validate.js` cleanRecord vs model schemas
- Evidence: `validate.js:61-64` keeps only declared fields (`if (f && !f.compute) out[k] = …`), and one2many lines keep only declared sub-fields (`validate.js:40-41`). This is intentional: `security.test.js:20` asserts unknown keys are dropped. The models write undeclared keys:
  - `sales.js:365` `write(db,'sale.order',r.id,{ order_line: applied.lines, loyalty_uses: [...] })`. `models['sale.order'].fields.loyalty_uses` does not exist (`SO loyalty_uses false`). Output of `t7.mjs`: `server copy loyalty_uses undefined` / `gift card points after Confirm: from client copy 0 used | after reload from server 100 active` / `apply the same gift card to another order: ACCEPTED discount line -100`.
  - `pos.js:55` `write(stocked,'pos.order',id,{ stock_costs: costs })`, read back at `pos.js:51` for refunds. Output of `w5_pos.mjs`: `stock_costs client [{"index":0,"unit_cost":120}] server undefined` / `refund stock value booked: from server copy {…"110100":999,…"500000":-999} | from client copy {…"110100":120,…"500000":-120}`.
  - `extra.js:41` writes `product.qty_rented`, which `valuation.js:26` uses (`owned = qty_available + qty_rented`). Output of `t10.mjs`: `server product qty_rented undefined` / `after server round trip, deliver 1 chair: Stock changed outside valuation; reconcile quantities first` / `same on the client copy: ok`.
  - Lower impact: `billcontrol.js:35` `purchase_method` on PO lines (lost in `w2` sync); `stock.valuation.layer.counterpart` (lost in `w4`/`w5` sync); the `name` of SO reward lines (`t7`).
  - Same drift elsewhere: 3 seed `documents.document` records fail `cleanRecord` (`tag_ids` strings vs one2many), so any later edit to them is refused. Outside my scope; I only ran the check.
- Reproduction: `node flows/t7.mjs`, `node flows/w5_pos.mjs`, `node flows/t10.mjs`.
- Expected / Actual: Data written by a workflow should survive the save. Actually, after the next poll or reload the client gets the stripped server copy, and later steps behave differently.
- Impact: Unlimited reuse of gift cards and coupons (revenue loss). Refunds post stock at today's cost (inventory overstated by 879 in the test). After any rental, deliveries of that product are blocked until someone fixes it by hand.
- Root cause: Verified. Schema and logic drift; there is no test that round-trips workflow output through `applyDiff`.
- Recommended correction: Declare these fields (`loyalty_uses` one2many, `stock_costs` one2many, `qty_rented` float, `purchase_method` sub-field, `counterpart` char, reward-line `name`). Add a CI test that runs each workflow and asserts `serverSync(...).lost` is empty (the helper in `flows/lib.mjs` does exactly this).
- Dependencies: FLOW-005 (same class: client output rejected by the server).
- Verification plan: Re-run the three scripts; the server copy should equal the client copy.
- Confidence: Confirmed

### MIZAN-FLOW-005 Work orders cannot be started in server mode, so MOs with planned operations can never be produced
- Severity: P1
- Category / Component: Manufacturing / `src/models/workorder.js`
- Evidence: `workorder.js:14-17` `const stamp = (at = new Date().toISOString()) => … return new Date(at).toISOString();` writes full timestamps. The fields are `date`: `workorder.js:196` `date_start: { type: 'date' … }` and `:203` `time_ids … date_start: { type: 'date' }, date_end: { type: 'date' }`. `validate.js:29-31` requires `^\d{4}-\d{2}-\d{2}$`. Produce requires all WOs done (`workorder.js:240-241`). Output of `w4_mrp.mjs`: `WO Start (button) client state progress date_start 2026-10-26T07:49:16.553Z` / `server applyDiff of WO Start: REFUSED -> Invalid value for mrp.workorder.time_ids[0].date_start`. Also: `Start without operator: Record not found`, because `run` passes `r.employee_id`, which is empty by default (`workorder.js:216`).
- Reproduction: `node flows/w4_mrp.mjs`.
- Expected / Actual: Start is saved and time is tracked. Actually, the whole diff is rejected (the client shows "Could not save changes" and reverts on the next pull), so the WO never leaves "ready" on the server.
- Impact: The manufacturing workflow with routings is unusable in a real deployment. The only workaround is skipping "Plan Work Orders".
- Root cause: Verified. A timestamp is written into date fields; `workorder.test.js` never passes through `applyDiff`.
- Recommended correction: Use `datetime`-typed fields (and add that type to `cleanValue`), or store dates only. Default the operator to the current user's employee, or show a clear error.
- Dependencies: FLOW-004
- Verification plan: Start, finish and Produce, each passed through `applyDiff`, should succeed.
- Confidence: Confirmed

### MIZAN-FLOW-006 Deliveries can exceed the order, and the same delivery can be returned again and again; returns don't reduce delivered quantities
- Severity: P1
- Category / Component: Inventory / sales.js Validate, picking.js returnPicking
- Evidence: The demand check exists only for routed or internal pickings: `warehouse.js:142` (`'Done quantities must be finite and cannot exceed demand'`). The base Validate (`sales.js:175-212`) never compares with the SO, and the picking's `move_ids.qty` is editable while ready (`t9`: `picking form locked while ready? false | move_ids readonly? false`). `picking.js:66-75` `returnPicking` has no check for prior returns and does not copy `sale_id`/`purchase_id`. Outputs:
  - `t9.mjs`: `SO for 2, user edits delivery demand to 10 and validates: ACCEPTED lamp 128 -> 118, qty_delivered 2` / `return picking WH/00003 ready sale_id undefined` / `after return validated: lamp 128 SO qty_delivered 2` / `Return the same delivery twice: ACCEPTED lamp -> 130 (2 delivered, 4 returned)`.
  - `w1_sales.mjs`: `manual delivery qty 2 done 10: ACCEPTED lamp on hand 128 -> 118, SO qty_delivered 2` / `then validate the routed delivery too: ACCEPTED lamp on hand -> 116, SO qty_delivered 2`.
- Reproduction: `node flows/t9.mjs`, `node flows/w1_sales.mjs`.
- Expected / Actual: The quantity delivered against an SO should be capped (or warned), and returns limited to the quantity delivered minus quantity already returned and linked to the order. Actually, 12 units shipped for an order of 2, and 4 units returned for a delivery of 2 (stock inflated, COGS reversed twice).
- Impact: Stock and COGS misstated through normal UI actions. The SO shows delivered = ordered, so the discrepancy is hidden. Invoicing by delivered quantity ignores returns.
- Root cause: Verified
- Recommended correction: Validate the done quantity against the SO/PO remaining quantity for every outgoing or incoming picking linked to an order. Track returned quantity per move, and refuse returns beyond it. Copy `sale_id`/`purchase_id` onto returns and decrement `qty_delivered`.
- Dependencies: FLOW-001 (server must enforce)
- Verification plan: The three repro lines should be refused, and the return should reduce `qty_delivered`.
- Confidence: Confirmed

### MIZAN-FLOW-007 Reservation is not enforced, waiting pickings can consume reserved stock, and periodic-valued products go negative silently
- Severity: P2
- Category / Component: Inventory / warehouse.js, picking.js, valuation.js, more.js
- Evidence: `warehouse.js:98` `state: previous ? 'waiting' : 'ready'`: every routed delivery is created "ready" whatever the stock. `picking.js:12-18` `freeQty` counts all ready outgoing pickings as reserved. `sales.js:175` Validate is offered for `['ready','waiting']`. `valuation.js:131` `if (p.valuation === 'manual_periodic') return moveStock(next, [l], sign);` (no quantity check; `moveStock` at `sales.js:16-22`). MO availability is just an on-hand check (`more.js` `availability`). Output of `w3_inventory.mjs`: `two deliveries of 15 vs 20 on hand: states ready ready | availability d1 partial d2 partial | freeQty excluding nothing -10` / `Check Availability visible on d2? false` / `manual delivery of 1 after Mark as Todo: waiting …` / `validate that WAITING delivery anyway …: ACCEPTED on hand 19` / `validate d1 (15) with 5 left: REFUSED Not enough stock to deliver` / `periodic product: deliver 50 with 0 on hand -> ACCEPTED on hand -50`. Output of `w4_mrp.mjs`: `2nd MO for 25 (frames on hand 25): avail available | 1st MO still available`.
- Reproduction: `node flows/w3_inventory.mjs`, `node flows/w4_mrp.mjs`.
- Expected / Actual: "Ready" should mean reserved. A waiting picking should need availability first. Negative stock should need an explicit allowance. Actually, reservations are advisory, and periodic products go to −50 with no warning. Real-time products are protected only at validation (`valuation.js:88`), which is good, so two deliveries cannot both complete sequentially; they can concurrently (FLOW-002).
- Impact: Wrong availability information for shipping and planning. Negative stock for periodic products.
- Root cause: Verified
- Recommended correction: Create order deliveries through `reservePicking` (as backorders already do, `picking.js:59`). Hide or deny Validate for waiting pickings unless forced. Count MO components in `freeQty`. Add a quantity check for periodic products, or a company setting to allow negative stock.
- Dependencies: FLOW-002
- Verification plan: The script lines should show waiting/none for the second delivery, and refusals.
- Confidence: Confirmed

### MIZAN-FLOW-008 Credit notes are unlimited and never reconciled with the invoice; the invoice stays fully due after it is credited
- Severity: P1
- Category / Component: Accounting / `accounting.js` creditNote
- Evidence: `accounting.js:111-118` creates a draft refund that only references `invoice_origin`, with no link or reconciliation. The button stays visible while the invoice is posted (`accounting.js:293`). Output of `t11.mjs`: `Credit Note click 1 visible true` / `Credit Note click 2 visible true` / `invoice total 450 after 2 posted credit notes: invoice payment_state not_paid residual 450 | partner receivable 450 -> -450` / `Register Payment still offered: true -> partner receivable after paying -900`.
- Reproduction: `node flows/t11.mjs`.
- Expected / Actual: The credit note should reduce the invoice's residual (reconcile), and total credits should be capped at the invoice amount. Actually, two full credit notes post, the invoice still shows 450 due, and a payment can still be registered, leaving the customer at −900.
- Impact: Through the normal UI: over-refunding, wrong aged receivables and follow-ups, and customers dunned for credited invoices.
- Root cause: Verified
- Recommended correction: Store `reversed_entry_id` on the refund. On posting, apply it to the origin invoice (`amount_paid`/residual, or a reconciliation record). Refuse credit notes beyond the uncredited residual.
- Dependencies: acct agent (reconciliation model)
- Verification plan: After one full credit note, the invoice should be paid/reversed and Credit Note hidden; a second should be refused.
- Confidence: Confirmed

### MIZAN-FLOW-009 Multi-company: new and generated records always get company 1, so company-2 sales, deliveries, invoices, payments and journal entries land in company 1's books
- Severity: P1
- Category / Component: Multi-company / `src/orm.js` create, `src/store.js`, `FormView.jsx`, `company.js`
- Evidence: `orm.js:67` `...(SHARED_MODELS.has(model) ? {} : { company_id: activeCompany ?? 1 })`, and the app always sets `setActiveCompany(null)` (`store.js:39`). The scoped defaults read the company only if `db` is passed (`company.js:59` `company_id: db ? currentCompany(db) : 1`), but both `orm.create` (`orm.js:66` `defaults?.(id)`) and the form (`FormView.jsx:47` `def.defaults?.(nextId(db, model))`) omit it. Output of `w7_company.mjs`: `form defaults for a new SO while in company 2 …: 1` / `orm.create(sale.order) while current company = 2 -> company_id 1` / `company-2 SO 4 company 2 -> picking 1 | invoice 1 | payment 1 | entries [["WH/OUT/00002",1],["Payment INV/2026/00003",1]] | valuation layer 1` / `company-2 list of account.move includes its own invoice? false` / `IC PO receipt company 1 (PO company 2)` / `IC bill company 1`. The passing test uses `createForCompany` and `defaults(99, db)` (`company.test.js:78-87`), which the app never calls (`grep` shows no non-test caller).
- Reproduction: `node flows/w7_company.mjs`.
- Expected / Actual: Documents inherit the company of their source order or of the current company. Actually, everything is company 1, and company 2 cannot see its own invoice.
- Impact: Per-company P&L, VAT and inventory are wrong. Inter-company flows book both sides in the seller's company.
- Root cause: Verified
- Recommended correction: Pass `db` to `defaults(id, db)` in `orm.create` and `FormView`. Propagate `company_id` from the source record in `createOrderTransfers`, `invoiceFrom`, `postEntry` (take it from the move) and `addLayer`. Add a test that runs the button chain for a company-2 SO.
- Dependencies: FLOW-010, FLOW-011
- Verification plan: The `w7` line should show 2 for every generated document.
- Confidence: Confirmed

### MIZAN-FLOW-010 No company isolation: the server returns all companies, the company selection is a single global setting any user can change, and the Reports page mixes companies
- Severity: P1 (P0 if a deployment relies on separating users by company)
- Category / Component: Multi-company / `server/index.js`, `src/sync.js`, `src/views/Reports.jsx`
- Evidence:
  - `server/index.js:146-154`: `visibleDb` filters only by the app allow-list, never by company.
  - `sync.js:88-92` applies `current_company_id`/`allowed_company_ids` from any user into the shared `db.settings`. They sit outside the `isAdmin` block. `users` has no company column (`server/index.js:96-98`).
  - Isolation is a client display filter (`companyView.js:5`, `company.js:29-32`).
  - `Reports.jsx:320` `const db = useDb();` is unfiltered.
  - `product` and `account.journal` are shared (`orm.js:11-12`), so stock is one figure for all companies.
  - Output of `w7_company.mjs`: `non-admin (restricted to sale.order) changes the GLOBAL company selection: {"current":2,"allowed":[1,2]}` / `non-admin re-assigns a posted invoice to another company: ACCEPTED` / `P&L (Reports page uses raw useDb): … "revenue":8820 …` vs `P&L through companyViewDb (company 2 only) {"revenue":0 …}`.
- Reproduction: `node flows/w7_company.mjs`. Read `server/index.js:146-154`.
- Expected / Actual: Company access should be per user, filtered and enforced server-side; the selection per session; reports per company. Actually, every user receives every company's data, one user's switch changes the view for everyone on their next poll, and financial reports aggregate all companies.
- Impact: Cross-company data exposure (by design today; no control exists). Wrong statutory reports in multi-company setups.
- Root cause: Verified
- Recommended correction: Add `users.company_ids`. Filter `/api/db` and the REST API by allowed companies. Validate `company_id` on writes (and refuse changing `company_id` on posted moves). Keep the current/allowed companies in the session or per user, not in `db.settings`. Apply `companyViewDb` in Reports.
- Dependencies: FLOW-009; sec agent (authorization)
- Verification plan: A user restricted to company 2 should get no company-1 records from `/api/db`, and a settings switch by one user should not affect another.
- Confidence: Confirmed (code reading plus script; HTTP not exercised)

### MIZAN-FLOW-011 Inter-company purchase copies the seller's sales taxes: the buyer's bill debits output VAT (251000); rule errors are swallowed and the PO is not kept in sync
- Severity: P1
- Category / Component: Multi-company / `company.js` interCompanyRules, `quoteplus.js`
- Evidence: `company.js:132` `order_line: (sale.order_line ?? []).map(({ qty_delivered, qty_invoiced, ...line }) => ({ ...line }))` copies `tax_id`, `tax_name` and `tax_account_id` of the *sales* tax. `ledger.js` `invoiceLines` uses `l.tax_account_id || taxAcc`. `quoteplus.js:31` `try { … interCompanyRules(res.db, r.id) } catch { return res; }`. Output of `w7_company.mjs`: `IC SO line tax [[1,"VAT 14%","251000"]]` / `IC Confirm: PO P00003 company 2 partner 8 state draft lines [[1,3,210,1,"VAT 14%"]]` / `IC bill journal items [["211000",0,718.2],["110200",630,0],["251000",88.2,0]]` / `after cancelling the IC SO, PO state purchase` / `IC rule error when seller has no contact: swallowed; SO state sale, PO created: false`.
- Reproduction: `node flows/w7_company.mjs`.
- Expected / Actual: The buyer's lines should get the buyer's purchase taxes (`productTax(db, product, 'purchase')`, as in `common.js:61`), and input VAT 131000 should be debited. Actually, Tax Payable is debited, which understates the VAT liability. A misconfigured rule fails silently.
- Impact: Wrong VAT returns in both companies (input VAT recorded as a reduction of output VAT). Orphan IC POs.
- Root cause: Verified
- Recommended correction: Rebuild IC lines through the purchase-line onchange (`productLines(...,'cost').onchange(…,'product_id')`) and keep only the price and quantity. Surface rule errors as a chatter note or warning. Cancel or flag the IC PO when the SO is cancelled.
- Dependencies: FLOW-009
- Verification plan: The IC bill should show a 131000 debit, and a rule error should leave a visible note.
- Confidence: Confirmed

### MIZAN-FLOW-012 Subscription "Automatic Payment" posts fictitious bank receipts: the scheduler marks invoices paid with no payment provider
- Severity: P1
- Category / Component: Subscriptions / `subscriptionplus.js`, `scheduler.js`, `server/index.js` job loop
- Evidence: `subscriptionplus.js:209` `payment_token: { type: 'boolean', label: 'Automatic Payment' }`; `:68` and `:88` `if (sub.payment_token) next = payMove(next, billed.id, …amount_residual, …)`; the flag is copied to renewals (`:142`). The server runs this hourly (`server/index.js:542-551`). The code comment calls it "optional mock auto-payment" and `subscriptionplus.test.js:46` asserts "mock tokens pay through the ledger". Output of `w6_subs.mjs`: `non-admin can set payment_token via server: ACCEPTED` / `auto-pay sub: invoices 2026-10-01:posted:1128.6:paid GL {"101401":1128.6,"251000":-138.6,"400000":-990} payments PBNK1/2026/00004:1128.6:3`.
- Reproduction: `node flows/w6_subs.mjs`.
- Expected / Actual: Automatic payment should charge a stored payment method through a provider and record the payment only on success. Actually, ticking a checkbox books bank receipts for every period.
- Impact: The cash and bank balance is overstated, receivables are cleared without collection, and dunning and auto-close never trigger for those customers.
- Root cause: Verified
- Recommended correction: Remove the mock from production paths (gate it like `demoPaymentsAllowed` in `server/api.js:26`), or integrate a provider that returns a transaction. Do not call `payMove` without one.
- Dependencies: FLOW-001
- Verification plan: With the flag set and no provider, the invoices should remain `not_paid`.
- Confidence: Confirmed

### MIZAN-FLOW-013 Subscription catch-up billing back-dates invoices, auto-closes in the same run, and Reopen bills the closed months
- Severity: P2
- Category / Component: Subscriptions / `subscriptionplus.js` invoiceDue, autoClose, Reopen
- Evidence: `subscriptionplus.js:73-96` (loop bills every due period with `invoice_date = at`); `:99-107` (autoClose on the oldest unpaid invoice); `:230` `Reopen … vals: { stage: 'progress', close_reason: null, closed_date: null, end_date: null }` (no reset of `next_invoice_date`). The base form has `statusbarClickable: true` (`more.js:577`, `sale.subscription.form`), so the stage can be set without running the button logic. `scheduler.js:25-31` swallows job errors. Output of `w6_subs.mjs`: `after scheduler: invoices 2026-08-01:posted… | 2026-09-01:posted… | 2026-10-01:posted… | stage closed unpaid`, and `Reopen on 2026-10-26 then scheduler: s4 invoices 2026-06-01… | 2026-07-01… | 2026-08-01… | 2026-09-01… | 2026-10-01…` (closed on 2026-10-26 with next date 2026-07-01).
- Reproduction: `node flows/w6_subs.mjs`.
- Expected / Actual: Catch-up invoices should be dated at the run date (or need confirmation), the grace period should count from issue or due date, and Reopen should resume from the reopen date. Actually, back-dated invoices are posted (and may fall into locked periods, where `tolerant()` silently skips *all* subscription billing), the customer is closed as unpaid immediately, and the closed gap is billed.
- Impact: Wrong revenue periods. Customers are billed for months they had cancelled. Silent scheduler failures.
- Root cause: Verified (the lock-date skip is inferred from `tolerant()`; I did not run it with a lock date)
- Recommended correction: Measure grace days from `invoice_date_due` and the run date. On Reopen, set `next_invoice_date` to the reopen date. Log or notify on scheduler exceptions instead of swallowing them. Make the stage statusbar read-only.
- Dependencies: FLOW-012
- Verification plan: Re-run `w6`; expect no auto-close in the catch-up run and no invoices for the closed gap.
- Confidence: Confirmed

### MIZAN-FLOW-014 Manufacturing and refunds overwrite the cost of "Standard Price" products, and MOs accept zero component consumption without a warning
- Severity: P2
- Category / Component: Valuation / `valuation.js` receive; `more.js` produce
- Evidence: `valuation.js:74-79` `const cost = method === 'standard' && !actualCost ? … : unitCost; … if (method !== 'standard' || actualCost) next = write(next,'product',productId,{ cost: … (valueOf(layers)+value)/(onHand+qty) … })`. Produce passes `actualCost: true` (`more.js` produce `moveValued(…, { … actualCost: true })`), and so do POS refunds and returns. `more.js` `used = moves.map(… recorded(m) ? Number(m.consumed) …)` accepts 0. Output of `w4_mrp.mjs`: `desk cost now 303.36 (standard)` (it was 310), and `MO of 3 with consumed=0 typed on every component: desk 22 -> 25 oak 38 -> 38 | GL {}`. Output of `t4.mjs`: `MO 20 desks consuming nothing: desk cost 301.27… -> 157.80…`.
- Reproduction: `node flows/w4_mrp.mjs`, `node flows/t4.mjs`.
- Expected / Actual: A standard-cost product keeps its standard cost, and the actual-cost difference goes to a variance account. Zero or under-consumption should need confirmation. Actually, the standard cost drifts with every MO, refund or return, and free finished goods dilute it.
- Impact: COGS and margin are wrong for standard-costed items. Inventory can be created without consuming components.
- Root cause: Verified
- Recommended correction: For `standard`, value receipts at standard cost and post `actual − standard` to a production or price variance account. Warn (or require a manager) when consumed is below the BoM quantity.
- Dependencies: none
- Verification plan: After an MO, the desk cost should stay at 310 and a variance entry should exist.
- Confidence: Confirmed

### MIZAN-FLOW-015 Purchased services can never be billed from the purchase order
- Severity: P2
- Category / Component: Purchasing / `billcontrol.js`
- Evidence: `billcontrol.js:140` `defaults: (id) => ({ ...product.defaults?.(id), purchase_method: 'receive' })`. The type-based switch happens only in onchange (`billcontrol.js:141`), which `create()` and `seed()` do not run. Services never get receipts (`warehouse.js:108` keeps goods only). Output of `t2.mjs`: `product 6 purchase_method receive type service` / `service-only PO: pickings 0 invoice_status no Create Bill: Nothing is eligible for billing`. Output of `w2_purchase.mjs`: the PO had oak and an installation service, but the bills contained only `[[7,6,100]]` and `[[7,4]]`.
- Reproduction: `node flows/t2.mjs`.
- Expected / Actual: The service line is billable on ordered quantity. Actually, it is never billable, so it must be keyed in by hand on a bill not linked to the PO (which then fails bill matching).
- Impact: Services are missing from PO-based bills. AP is understated, or there is manual rework.
- Root cause: Verified
- Recommended correction: Default `purchase_method` from `type` in `defaults` (or compute it), and migrate existing service products.
- Dependencies: FLOW-004 (`purchase_method` on PO lines is also stripped by the server)
- Verification plan: A service-only PO should show "To Invoice" and produce a bill line.
- Confidence: Confirmed

### MIZAN-FLOW-016 The stock valuation report does not reconcile with the stock account: opening stock is never posted
- Severity: P2
- Category / Component: Valuation / `valuation.js` prepare and postValuation, seed
- Evidence: `valuation.js:28-34` creates an `opening: true` layer from `qty_available × cost`. `valuation.js:47` `if (l.move_id || l.opening || …) return db;` never posts it. `valuationReport` counts it (`valuation.js:180-188`). Output of `w3_inventory.mjs`: `ALL products: valuation report total 35852 vs GL 110100 balance 8100`. Per-flow changes do reconcile (`w4`: `valuation report change 45.83 vs GL 110100 change 45.83`).
- Reproduction: `node flows/w3_inventory.mjs`.
- Expected / Actual: Inventory valuation equals the 110100 balance. Actually, there is a 27,752 gap in the seed. Any product whose `qty_available` is set outside an inventory adjustment (seed, import, API, or the forge in FLOW-001) is likewise unvalued in the GL.
- Impact: The balance sheet understates inventory against the stock report. Reconciliation fails from day one.
- Root cause: Verified
- Recommended correction: Post opening layers against an opening-balance or equity account (or make the seed use `adjustQuantity`). Refuse direct `qty_available` writes on the server.
- Dependencies: FLOW-001
- Verification plan: The valuation report total should equal the 110100 balance after seed.
- Confidence: Confirmed

### MIZAN-FLOW-017 Missing steps and minor workflow gaps
- Severity: P3
- Category / Component: Sales, Purchase, Accounting, POS UX
- Evidence:
  - A confirmed SO can never be cancelled: `sales.js:399` `when: (r) => !['cancel', 'sale'].includes(r.state)`. The PO is the same (`purchase.order` Cancel `when: !['cancel','purchase']`).
  - Posted payments cannot be cancelled or reversed: `pay.js:29` Cancel is draft-only. Reset to Draft is hidden once paid (`accounting.js:295`), so a mistaken payment needs a manual entry.
  - POS refuses to sell out-of-stock items (`pos.js:47` → `valuation.js:88`): `w5`: `POS sale of an item with 0 on hand: REFUSED Not enough stock to deliver`.
  - A split tender splits line quantities fractionally (`posplus.js:165-168`): `w5`: `settlements [["POS/00005","cash",5,[1.4619…]],["POS/00006","card",5.26,[1.5380…]]]`.
  - A manual receipt without a PO leaves its value on 110200 Stock Interim with nothing to clear it (`w3`: `interim 110200 delta -220`).
- Reproduction: `w5_pos.mjs`, `w3_inventory.mjs`, code lines above.
- Expected / Actual: Odoo-equivalent flows include order cancel (cancelling open pickings), payment reversal, and an optional negative-stock POS sale.
- Impact: Users work around these with manual entries and edits, which also feed FLOW-001-style inconsistencies.
- Root cause: Verified (design gaps)
- Recommended correction: Add Cancel for confirmed orders (cancel non-done pickings and draft invoices). Add a payment reversal entry. Add a POS setting for negative stock. Allocate split tenders by amount, not by quantity.
- Dependencies: none
- Verification plan: Manual check of each new button.
- Confidence: Confirmed
