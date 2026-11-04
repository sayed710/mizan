# Mizan audit: workstream C (db). Database, data integrity, concurrency and performance

Audited commit 0e9f748 (copy at evidence/work-db). Every script cited below is in evidence/dbscripts/. Run each one as `node <script> <work-copy path> [args]`. Live tests start the real `server/index.js` on a random high port, with a throwaway SQLite file that is deleted afterwards.

## Summary
- The worst problem is silent data loss on the write path. Eight public (mostly unauthenticated) endpoints read `db` before `await readJson(req)` and then commit that stale whole-db object. Every change other users saved in the meantime is reverted, in memory and in SQLite. This was proven live (DB-001).
- Record ids are chosen in the browser (seq+1). When two clients create records in the same model from the same base, the second create overwrites the first. The server reports no error. This corrupts posted ledgers: an invoice was left "paid" but linked to a bill's payment entry, and AR went to -1210 (DB-002). Any user can also poison a sequence permanently (DB-006).
- There is no optimistic concurrency control. Writes replace whole records, last writer wins: lost updates, stock-quantity races, stale replays, and async handlers such as send-by-email reverting edits made while they waited (DB-003).
- Document numbers are count+1, computed in the browser, with no uniqueness check. Concurrent posting and a plain single-user delete both produce duplicate invoice numbers (DB-004).
- There is no referential integrity, the audit trail is asserted by the client, multi-company scoping is a single global setting, and records that flows create are stamped company 1 (DB-005, DB-007, DB-008).
- Operations: two processes on one SQLite file overwrite each other. The only backup tool is in the UI, and its restore fails above 5 MB. Migrations are ad hoc (DB-009 to DB-011). Business logic writes fields that the server strips, which breaks valuation after a rental pickup (DB-012).
- Performance: every write and every 15 s poll serializes the whole database. At 50k records (30.7 MB): a 1-field save takes about 0.9-1.3 s and returns 30 MB, a poll takes about 0.6 s, an anonymous blog GET takes 388 ms, the boot scheduler blocks for about 8 s, and the 200 M-char cap makes the system read-only (PERF-001 to PERF-005).
- What works: a single diff is applied atomically (applyDiff is pure, storage.save runs in one transaction), WAL is on with synchronous=FULL, message ids are UUIDs, a replayed create diff is idempotent, and WhatsApp inbound messages are deduplicated.

Counts: P0 3, P1 10, P2 4, P3 2.

## What I verified / what I could not verify
Verified by running code (outputs quoted in each finding):
- Live server: stale-snapshot revert through /api/public/livechat/start and /api/public/apply, checked in memory and after a restart (live1.mjs).
- Live server: send-by-email reverting a concurrent edit, using a local fake SMTP server on loopback (live4.mjs).
- Live server: two processes on one DB file (live5.mjs).
- Live server: UI backup restore at 20k records (live6.mjs).
- Live server: HTTP latencies at 50k records (live2.mjs, live3.mjs).
- applyDiff simulations with the real model functions:
  - two clients from one base, plus id collisions and payments (con1.mjs, con2.mjs)
  - replay, seq poisoning, audit, referential integrity and companies (con3.mjs to con5.mjs, con7.mjs, con13.mjs, con15.mjs)
  - schema changes (con8.mjs, con9.mjs, con14.mjs)
  - stripped keys (con10.mjs, con11.mjs)
  - IoT path (con12.mjs)
- Timings (perf.mjs, perf2.mjs, perfjobs.mjs).
- Machine caveat: 4 vCPU Intel Xeon @ 2.10 GHz, 16.9 GB RAM, Node v22.22.0 (the Dockerfile uses Node 24), in a sandboxed VM. Each figure is the mean of 1-5 iterations on synthetic records cloned from seed records. Treat them as orders of magnitude, not benchmarks. Live HTTP figures varied about 30-50% between runs.

Not verified:
- I did not hold a slow request for the full Node default requestTimeout. The 300 s figure comes from `http.createServer().requestTimeout` = 300000; my tests held the request for 300 ms.
- I did not run the IoT, forum, register/book and order routes live. They share the code pattern of the two live-proven routes. IoT was simulated with the real ingestIot.
- The browser-side cost of rendering a 30 MB db, and the exact saturation point under real load, are arithmetic extrapolations and are labelled as such.
- I did not test copying a live WAL-mode file as a backup. That limitation is known SQLite behaviour and is labelled as a hypothesis.
- Possible overlaps: posted-entry immutability (acct) and message/seq authorization (sec) are cross-referenced and not counted twice.

---

### MIZAN-DB-001 Public endpoints commit a db captured before `await readJson`, silently reverting all concurrent changes
- Severity: P0
- Category / Component: Concurrency / server/index.js public routes
- Evidence:
  - `db` is evaluated as an argument before the `await`. The handlers then commit a whole db built from that stale value:
    - index.js:275 `forumRoutes[path](db, await readJson(req), ip)`
    - :291 `publicApply(db, await readJson(req))`
    - :301 `publicForms[path](db, await readJson(req))` (register, book)
    - :310 `livechatStart(db, ...)`
    - :334 `publicOrder(db, ...)`
    - each followed by `if (out.db) commitDb(out.db);` (:276/:292/:302/:311/:335)
  - `commitDb` (:73) runs `storage.save(db, next); db = next`. `storage.save` diffs the current db against the stale object (storage.js:67-73). So:
    - records created meanwhile are DELETEd
    - records edited meanwhile are re-upserted with their old version
    - `seq` and settings are rewritten from the stale object
  - The public builders call `applyDiff(db, diffDb(db, next))` on the stale db (api.js:83, :131, :148, :245), so no rebase happens.
  - IoT (:282-284) applies `applyDiff(db, diffDb(db, next))` with a stale `next`. That diff treats newer records as deletions.
  - live1.mjs output (/api/public/livechat/start; identical for /api/public/apply):
    ```
    start: partners 8 seq 8 crm.lead#1 priority 1
    employee save status 200 | partner 9 present: true | lead priority 3
    slow public request -> 201 {"sessionId":3,...}
    after: partner 9 present in memory: false | seq res.partner 8 | lead priority 1
    after restart (SQLite): partner 9 present: false | lead priority 1
    ```
  - con12.mjs (real ingestIot with the index.js:284 expression): `partner 9 still present after IoT ingest: false`.
- Reproduction:
  1. Send the headers and the first 5 bytes of a public POST.
  2. Save any change as an employee.
  3. Send the rest of the body.
- Expected / Actual: Expected: concurrent saves survive. Actual: they are silently undone, even though the employee received a 200.
- Impact:
  - An anonymous visitor can roll back every write made while their request body is open. The window is up to Node's default requestTimeout of 300 s, since the server sets no timeout. The rolled-back writes include posted invoices, payments and deletions.
  - Normal traffic triggers it too: any request whose body arrives over more than one event-loop turn while another write lands.
  - The seq rollback then feeds DB-002, because the next creates reuse the ids.
- Root cause (verified): the snapshot is read before the await, and the whole db is committed without rebasing onto the current db.
- Recommended correction:
  1. Read the body first.
  2. Compute from the current `db`, synchronously.
  3. Commit only a diff applied to the db as it is at commit time: `commitDb(applyDiff(db, diffDb(base, next)))`.
  4. Make `commitDb` refuse a `next` that was not derived from the current `db`, for example with a version counter.
  5. Add request and body timeouts.
- Dependencies: DB-002, DB-003
- Verification plan: re-run live1.mjs for each route; add a test that interleaves a write between body chunks.
- Confidence: Confirmed (livechat/start, apply live; IoT simulated); Strongly supported (forum, register/book, order: same pattern)

### MIZAN-DB-002 Client-chosen record ids: concurrent creates overwrite each other, corrupting posted ledgers
- Severity: P0
- Category / Component: Concurrency, id allocation / src/orm.js, src/sync.js
- Evidence:
  - orm.js:7 `nextId = (db, model) => (db.seq[model] ?? 0) + 1` runs in the browser (orm.js:64).
  - applyDiff treats any id as an upsert: sync.js:60-62 `guard?.(seen, current.get(rec.id) ?? null, rec)` then `current.set(rec.id, rec)`. There is no "must be new" check.
  - Clients refresh only every 15 s while the tab is visible (store.js:11, :83).
  - con1.mjs/con2.mjs (two clients, same base, applied in sequence):
    ```
    [2] create collision: A id 9 B id 9 | server partners with id 9 => [ 'Bob Supplier GmbH' ] | any "Alice"? false | created msgs for that id [ 'Alice', 'Bob' ]
    [4] Alice pays INV/2026/00002 residual 1210 ; Bob pays BILL/2026/00001 residual 9234
        server: INV/2026/00002 amount_paid 1710 its payment move_id 10 -> that move ref "Payment BILL/2026/00001"
        account.payment for INV/2026/00002 : [ '2:500' ] | for BILL/2026/00001 : [ '3:9234' ]
        AR(121000) partner 3 : base 1210.00 | Alice alone 0.00 | server after both 1210.00 (invoice says residual 0.00 )
    [5] Bob draft id 10 -> now "Payment INV/2026/00002" posted (Bob's draft overwritten)
        posted bank moves for INV/2026/00002 : [ '5:500', '10:1210', '11:1210' ] | invoice amount_paid 1710 of 1710 | payment records [ '2:500', '3:1210' ]
        AR partner 3 base 1210.00 -> after -1210.00
    [6b] Validate button: ... valuation layers for product 2 -> 3 (A alone 3 , B alone 3 )
    ```
  - REST create also overwrites when seq lags behind the ids (con13.mjs): `seq after upsert of id 9 without d.seq: 8` then `REST create -> 201 id 9 | partner 9 now: Created via REST API`.
- Reproduction: con1.mjs, con2.mjs, con13.mjs.
- Expected / Actual:
  - Expected: each create gets a unique server-assigned id, or the second create is rejected.
  - Actual: the second create silently replaces the first record, including posted journal entries, payments and valuation layers. Both users see success.
- Impact:
  - Silent loss of business records.
  - A GL that no longer matches its subledgers: the invoice shows paid while AR stays open, or AR goes negative because two bank receipts exist for one invoice.
  - Stock valuation layers are lost.
  - Two users working in the same model within one 15 s window, or a background tab, is enough. The README claim that "concurrent edits ... merge on the server" (README.md:99) does not hold for creates.
- Root cause (verified): ids come from the client's possibly stale `seq`, and the server does not distinguish a create from an update.
- Recommended correction:
  1. Allocate ids on the server. Either make the client send temporary negative ids that the server remaps (including references inside the same diff), or have it reserve id blocks per session.
  2. In applyDiff, reject an upsert whose `before` exists when the client did not hold that record's current version (see DB-003).
- Dependencies: DB-003, DB-006
- Verification plan: re-run con1/con2/con13; add tests where two clients create from one base.
- Confidence: Confirmed

### MIZAN-DB-003 No optimistic concurrency control: lost updates, stock races, stale replays and async handlers revert edits
- Severity: P1
- Category / Component: Concurrency / src/sync.js, server/index.js, server/mail.js, server/integrations.js
- Evidence:
  - diffDb sends whole records (sync.js:21). applyDiff replaces them with no version or base check (sync.js:56-64).
  - qty_available is a stored field updated by read-modify-write in the browser: sales.js:20 `write(acc, 'product', p.id, { qty_available: (Number(p.qty_available) || 0) + sign * ... })`.
  - Async handlers capture `snapshot = db`, await network I/O, then commit full stale records:
    - index.js:397-401 ACTIONS: aiDraft, digitizeBill, quoteShipping, syncMarketplace
    - index.js:416-420 together with mail.js:37-41: `await sendMail(...)` then `write(db, model, rec.id, { state: nextState })`
  - con1.mjs and con3.mjs output:
    ```
    [1] lost update crm.lead#1: ... A set 777777, B set priority 3 => server has expected_revenue 42000 priority 3
    [6] stock Ergonomic Chair on hand 135 - 2 (Alice) - 3 (Bob) => server 132 (expected 130 )
    [6b] Validate button: pickings 2 3 states done done | qty 135 -> 132 (expected 130 )
    [a] priority after edit to 3 then replay of the old diff: 2 | create diff replayed twice -> leads named "Replay lead": 1
    ```
  - live4.mjs (live server, fake SMTP on loopback with a 1.5 s delay):
    ```
    S00001 before: state draft note null
    colleague edits note while the email is in flight -> 200 note now "Customer asked for delivery on Friday"
    send by email -> 200 {"ok":true} | S00001 after: state sent note null
    ```
- Reproduction: con1.mjs [1],[6]; con3.mjs [a]; live4.mjs.
- Expected / Actual:
  - Expected: a write based on an outdated version is rejected or merged per field.
  - Actual: the last writer silently wins. Stock movements are lost, so on-hand quantity drifts from the valuation layers. Any edit made while an email, AI call or carrier quote is in flight is reverted.
- Impact: silent lost updates on shared records (orders, invoices, products, stock). A replayed or retried old request reverts newer data.
- Root cause (verified): there is no per-record version or ETag, whole records are upserted, quantities are stored instead of derived from moves, and async handlers write records from their pre-await snapshot.
- Recommended correction:
  1. Add a `version` (or `write_date`) to each record. Have the client send the base version, and make applyDiff reject on mismatch (HTTP 409) so the client re-runs the action on fresh data.
  2. Send field-level patches.
  3. Derive qty_available from stock moves or quants, or apply deltas on the server.
  4. After any await, re-read the current record and apply only the intended fields.
- Dependencies: DB-001, DB-002
- Verification plan: two-client tests for the same record, stock and replay; re-run live4.mjs and expect a 409 or a preserved note.
- Confidence: Confirmed

### MIZAN-DB-004 Document numbers computed client-side as count+1: duplicate invoice and payment numbers
- Severity: P1
- Category / Component: Data integrity, numbering / src/models/common.js, accounting.js
- Evidence:
  - common.js:73-74 `nextName = ... prefix + pad(records.filter(... r.name?.startsWith(prefix)).length + 1)`.
  - Used for posting and for payments: accounting.js:31, :86, pay.js:22, ledger.js:94, quoteplus.js:110 and 5 more call sites.
  - The records table has only `PRIMARY KEY (model, id)` (storage.js:8). No uniqueness is enforced anywhere.
  - con1.mjs and con2.mjs output:
    ```
    [3] concurrent posting: draft ids 10 11 => names INV/2026/00003 INV/2026/00003 states posted posted
    [3b] deleted posted INV/2026/00001 (paid 7866 ) accepted
    [3b] new invoice name INV/2026/00002 | INV names now: 4:INV/2026/00002 10:INV/2026/00002
    ```
- Reproduction: con1.mjs [3]; con2.mjs [3b] (single user, default settings, no concurrency needed).
- Expected / Actual:
  - Expected: unique, monotonically increasing legal numbers allocated on the server.
  - Actual: two posted invoices share a number, both concurrently and after a deletion.
- Impact: duplicate legal invoice and payment numbers. Many tax regimes require unique, gapless sequences, so reports, payment matching by name and e-invoicing (ZATCA QR is supported) can all break. Numbering is also shared across companies (no company filter in the prefix).
- Root cause (verified): the count of existing names is used as the sequence, it is computed in the browser, and nothing checks uniqueness.
- Recommended correction:
  1. Keep a per-journal (and per-company) sequence on the server, allocated inside applyDiff when state goes to posted.
  2. Add a uniqueness check, for example a SQLite unique index on `(model, json_extract(data,'$.name'))` for posted moves, or an in-memory index.
  3. Never derive numbers from counts.
- Dependencies: DB-002, DB-005; possible acct overlap (deleting posted entries when no lock date or audit trail is set)
- Verification plan: con1 [3] and con2 [3b] should yield distinct names; add a property test for uniqueness.
- Confidence: Confirmed

### MIZAN-DB-005 No referential integrity: deletes leave dangling references; references to missing ids are accepted
- Severity: P1
- Category / Component: Schema / src/validate.js, src/sync.js
- Evidence:
  - validate.js:23-25 many2one only checks `Number.isInteger(value) && value >= 1`; existence is never checked.
  - Deletes are checked only by `protectDelete`, which 7 of 180 models define (seedstats.mjs).
  - Server-side deletes never run `onUnlink` cascades (sync.js:66-74 vs orm.js:122).
  - con3.mjs (user restricted to the CRM app):
    ```
    [d] CRM-only user deletes res.partner 3 ( Sara Hassan ) -> gone: true | dangling refs: 14 account.move#4.partner_id, account.move#4.line_ids[].partner_id, ... account.move#5.partner_id, ..., crm.lead#2.partner_id
        sale.order#1 partner_id set to 999999 accepted: true
    ```
  - con2.mjs [3b]: after a posted invoice is deleted, `payment 1 -> invoice_id 2` points at nothing.
- Reproduction: con3.mjs [d]; con2.mjs [3b].
- Expected / Actual:
  - Expected: deleting a referenced partner is refused or archived, and unknown ids are rejected.
  - Actual: both are accepted.
- Impact: posted journal lines and invoices lose their partner (aged receivables, follow-ups and the portal break). Payments point at deleted invoices. Any user with access to res.partner can do this, and CRM users have that access.
- Root cause (verified): JSON blobs per record with no foreign-key metadata enforcement and no reverse-reference check.
- Recommended correction:
  1. In applyDiff, maintain a reverse index of many2one targets.
  2. Reject deletes of referenced records, or archive them (`active=false`) as Odoo does for partners and products.
  3. Validate that many2one targets exist (in the db or in the same diff).
  4. Run onUnlink on the server.
- Dependencies: DB-007
- Verification plan: re-run con3 [d] and expect rejection; scan the stored db for dangling many2one references.
- Confidence: Confirmed

### MIZAN-DB-006 Sequence counters are client-asserted: any user can poison a model so every later create overwrites the previous one
- Severity: P0
- Category / Component: Integrity, id allocation / src/sync.js:75-78
- Evidence:
  - sync.js:76-77 takes `d.seq` for any model, with no `allowed` check: `if (models[model] && Number.isInteger(n)) seq[model] = Math.max(seq[model] ?? 0, n, ...)`.
  - `Number.isInteger(1e300)` is true, and `1e300 + 1 === 1e300`.
  - con3.mjs output:
    ```
    [b] CRM-only user sets seq: account.move 1e+300 res.partner 9007199254740992 (allowed has account.move: false )
       partner ids 9007199254740992 9007199254740992 equal? true | partners named *after poisoning*: [ 'Second after poisoning' ]
       account.move ids 1e+300 1e+300 | moves with ref one/two: [ 'two' ]
    ```
  - con15.mjs (persists through SQLite): `rows with the poisoned id: [{ id: 1e+300, t: 'real', ref: 'second' }]`, `seq after reload: 1e+300`.
- Reproduction: POST /api/diff `{"upserts":{},"deletes":{},"messages":[],"removedMessages":[],"seq":{"account.move":1e300}}` as any logged-in user (simulated in con3/con15).
- Expected / Actual:
  - Expected: seq is server-owned and bounded.
  - Actual: one request permanently makes every new journal entry overwrite the previous one. seq only ever grows (Math.max), so it cannot be repaired through the app.
- Impact: silent, persistent destruction of new records in any model, including posted accounting entries, by a low-privilege user.
- Root cause (verified): the client controls the sequence, with no range or authorization check.
- Recommended correction: ignore `d.seq` entirely and compute seq on the server as max(existing seq, max id) when allocating server-side ids (DB-002); reject ids above `Number.MAX_SAFE_INTEGER`.
- Dependencies: DB-002; possible sec overlap
- Verification plan: re-run con3 [b] and con15 and expect the request to be rejected or seq unchanged.
- Confidence: Confirmed

### MIZAN-DB-007 Audit trail is asserted by the client, omittable, forgeable and deletable; no server-side change log or retention policy
- Severity: P1
- Category / Component: Audit trail / src/orm.js, src/sync.js
- Evidence:
  - Tracking messages are produced only by the client ORM (orm.js:84-94, :108).
  - The server never creates them. It accepts client messages with client-supplied `date` and `kind` (validate.js:68-71) and only overwrites `author` (sync.js:85).
  - `audit_trail` blocks deleting audited messages only (sync.js:80-81).
  - The removedMessages filter has no `allowed` check (sync.js:81).
  - con3.mjs and con5.mjs output:
    ```
    [c] audit_trail true | posted INV/2026/00002 total 1710 -> server total 11.4 | messages added by the server: 0
       forged tracking message accepted: true date=2020-01-01T00:00:00.000Z author=Mallory kind=tracking
    messages on models outside the CRM app: 13 ...; after CRM-only user posts removedMessages for them, remaining: 0
    ```
- Reproduction: con3.mjs [c]; con5.mjs.
- Expected / Actual:
  - Expected: with the audit trail on, every change to a posted entry is logged by the server (who, when, old and new values) and cannot be deleted.
  - Actual: a non-admin rewrote a posted, partly paid invoice and left no trace. Back-dated "tracking" entries are accepted. Users can delete chatter on models outside their apps.
- Impact: no reliable history for financial or compliance review. Messages also grow without bound: the 50k-record test held 45k messages, all loaded in memory and sent to every client (PERF-002). There is no retention or archiving.
- Root cause (verified): the audit log is a side effect of client-side ORM calls, not of server-side writes.
- Recommended correction:
  1. Generate tracking and audit rows in applyDiff from before/after, with server time. Keep them append-only in a separate table.
  2. Reject client-supplied `kind: 'tracking'` and dates.
  3. Check `allowed` on removedMessages.
  4. Define a retention or archiving policy.
- Dependencies: acct (immutability of posted entries, the underlying edit), sec (message authorization)
- Verification plan: re-run con3 [c] and expect a server-written audit row, or rejection of the edit; con5 should leave messages intact.
- Confidence: Confirmed

### MIZAN-DB-008 Multi-company isolation is absent at the data layer: company selection is global, and flows stamp company 1
- Severity: P1
- Category / Component: Multi-company / src/sync.js, src/store.js, src/orm.js, src/models/company.js
- Evidence:
  - `current_company_id` and `allowed_company_ids` live in the shared `db.settings`. Any user may set them (sync.js:88-92; comment at :86 "selections ... are not" admin-only).
  - Form defaults read them (company.js:58-59).
  - Users have no company column (index.js:56-59). visibleDb filters by app only, never by company (index.js:147-155).
  - The client always calls `setActiveCompany(null)` (store.js:39), so `orm.create` stamps `company_id: activeCompany ?? 1` (orm.js:67).
  - con4.mjs and con7.mjs output:
    ```
    user A selects company 1 -> settings 1 [ 1 ] | CRM-only user B selects company 2 -> shared settings now 2 [ 2 ]
    settings.current_company_id 2 | invoice INV/2026/00003 company_id 2
    records created by payMove: account.move#11 company_id=1 | account.payment#3 company_id=1
    ```
- Reproduction: con4.mjs, con7.mjs.
- Expected / Actual:
  - Expected: a per-user company context, and records created by a flow inherit the company of their source document.
  - Actual: one user's company switch changes the active company for everyone, and new documents default to it. Paying a company-2 invoice books the bank entry and the payment in company 1.
- Impact: documents and ledger entries land in the wrong company, so company-2's AR stays open in its books while company 1 receives the cash entry. Every user can read every company's data.
- Root cause (verified): the company context is shared mutable state in `settings`, the ORM's company stamping is disabled, and there is no user-to-company assignment.
- Recommended correction:
  1. Store allowed and current companies per user or session on the server.
  2. Filter visibleDb and the REST API by allowed companies.
  3. Stamp company_id on the server from the source document (or from the session company).
  4. Use per-company sequences (DB-004).
- Dependencies: DB-004; possible acct overlap
- Verification plan: re-run con4 (B's switch must not affect A) and con7 (payment and bank move must carry company 2).
- Confidence: Confirmed (data layer); the effect on form defaults is Strongly supported (code read company.js:58)

### MIZAN-DB-009 Single in-memory authority: a second process on the same SQLite file silently overwrites data
- Severity: P1
- Category / Component: Architecture, deployment / server/index.js:70-73
- Evidence:
  - The process loads the whole db once (`let db = migrateAppointments(storage.load())`, :71) and never re-reads it.
  - Saves diff its own memory (:73).
  - There is no file lock or "already running" guard. WAL allows concurrent writers from separate processes.
  - live5.mjs output:
    ```
    A saved partner 9 -> 200 | replica B sees it? false B seq 8
    B saved partner 9 -> 200
    after restart, partners with id 9 : [ 'Created on replica B' ]
    ```
- Reproduction: live5.mjs (two servers, one MIZAN_DB).
- Expected / Actual: Expected: the second instance refuses to start, or the instances share state. Actual: each instance silently overwrites the other's records and seq.
- Impact:
  - Horizontal scaling and HA are impossible. Rolling deploys that overlap old and new containers on the same volume (Docker VOLUME /data) lose data.
  - The single Node process also serializes all CPU work (PERF-001).
- Root cause (verified): the authoritative state lives in process memory, and SQLite is used as a write-behind log.
- Recommended correction:
  1. Take an exclusive lock at startup, for example `PRAGMA locking_mode=EXCLUSIVE` or a lock file, and document single-instance deployment.
  2. In the longer term, make SQLite (or Postgres) the source of truth with per-record queries and transactions.
- Dependencies: PERF-001
- Verification plan: re-run live5 and expect the second process to fail to start.
- Confidence: Confirmed

### MIZAN-DB-010 Backup and restore: no server tooling, and the UI restore cannot restore more than 5 MB
- Severity: P1
- Category / Component: Crash recovery, operations / src/views/Settings.jsx, server/index.js
- Evidence:
  - "Download backup" serializes the browser's copy (`JSON.stringify(getDb())`, Settings.jsx:112-118). For app-restricted users that copy is partial (visibleDb), and it never contains the users, sessions, api_keys or kv secret tables.
  - "Restore backup" calls `commit(data)`, which sends one diff to /api/diff (Settings.jsx:119-123). That diff is limited by `MAX_BODY = 5 MB` (index.js:49).
  - No server backup command, no `VACUUM INTO`, and no documentation exist (grep of server/, Dockerfile and README found none).
  - "Reset demo" (index.js:441-445) wipes all records and messages in production after a browser `confirm` (Settings.jsx:225).
  - live6.mjs output (20k records):
    ```
    backup JSON 12.2 MB, 20345 records
    reset -> 200; restore diff 12.2 MB
    restore POST /api/diff -> socket error read ECONNRESET
    records on the server after restore attempt: 344
    ```
- Reproduction: live6.mjs.
- Expected / Actual:
  - Expected: a consistent server-side backup and a working restore.
  - Actual: a modest dataset cannot be restored. The 344 seed records remain.
- Impact: an operator who relies on the built-in backup permanently loses data after a reset, corruption or bad migration. Copying only `mizan.sqlite` while it runs in WAL mode can miss recent commits (hypothesis: standard SQLite WAL behaviour, not tested here).
- Root cause (verified): backup and restore reuse the client sync path; there is no storage-level backup.
- Recommended correction:
  1. Add an admin-only server endpoint or CLI using `VACUUM INTO` / the sqlite backup API, plus scheduled snapshots.
  2. Implement restore as a server-side full write (`storage.save(null, db)`) after validation.
  3. Gate "Reset demo" behind an environment flag.
- Dependencies: DB-009
- Verification plan: re-run live6 with a server-side restore; restore a backup taken during writes and check that the row counts match.
- Confidence: Confirmed

### MIZAN-DB-011 No schema-evolution strategy: in-memory migrations are never persisted, and schema changes lock or strip data
- Severity: P2
- Category / Component: Migrations / src/models/appointments.js, server/storage.js, src/validate.js, src/models/studio.js
- Evidence:
  - migrateAppointments runs at every boot and only in memory (index.js:71). Changed rows are never written, because storage.save writes only records whose reference changed. con14.mjs:
    ```
    in memory after migrate: {"id":1,"name":"Legacy consult","duration":90,"staff_ids":[{"employee_id":2}]}
    row in SQLite after a commit: {"id":1,"name":"Legacy consult","duration":1.5,"user_id":2}
    ```
  - The legacy blob migration drops the old blob outside the transaction (storage.js:50-54). On crash this is benign (the blob is left behind).
  - cleanRecord drops undeclared keys (validate.js:61-64). con9.mjs: `after an unrelated edit: x_region undefined legacy_code undefined`.
  - Changing selection options makes existing records un-editable (con8.mjs): `ordinary edit of lead#1 (priority) rejected: Invalid value for crm.lead.x_region`.
  - installCustomFields only ever adds fields (studio.js:31-44): `admin deletes the custom field -> still declared in this process: true`.
  - There is no schema version anywhere. The browser's local mode bumps a storage key instead (store.js:10, `mizan-db-v32`).
- Reproduction: con8.mjs, con9.mjs, con14.mjs.
- Expected / Actual:
  - Expected: versioned, persisted migrations, and schema changes that transform or validate existing data.
  - Actual: migrations must stay in the code forever. A removed or renamed field silently loses its data on the next edit. A tightened field blocks all edits of old records.
- Impact: silent data loss and stuck records after upgrades or Studio changes. Process state can drift from the stored settings until restart.
- Root cause (verified): there is no migration framework; validation is applied to whole records at write time.
- Recommended correction:
  1. Store `schema_version` in meta.
  2. Run ordered migrations inside a transaction and persist them with `storage.save(null, migrated)`.
  3. Preserve unknown keys, or migrate them explicitly.
  4. Validate only changed fields, or migrate values when field definitions change.
  5. Support uninstalling custom fields.
- Dependencies: DB-012
- Verification plan: re-run con8, con9 and con14 after the fix.
- Confidence: Confirmed

### MIZAN-DB-012 Business logic writes fields the server strips; the client and server diverge and flows break after sync
- Severity: P1
- Category / Component: Data integrity / model definitions vs src/validate.js cleanRecord
- Evidence:
  - con10.mjs ran every applicable form button on the seed (179 runs) and compared the client's records with the stored ones:
    `keys written by business logic but stripped by the server: purchase.order.order_line[].purchase_method(3), stock.valuation.layer.counterpart(4), product.qty_rented(2), stock.picking.repair_id(1), stock.picking.move_ids[].lot_id(1)`.
  - extra.js:41 writes `qty_rented`. valuation.js:26 relies on it: `owned = qty_available + qty_rented`.
  - con11.mjs output:
    ```
    after Pickup: client qty_rented 2 | server qty_rented undefined | qty_available 133
      receive() on client state: ok
      receive() on server state: Stock changed outside valuation; reconcile quantities first
    ```
- Reproduction: con10.mjs, con11.mjs.
- Expected / Actual:
  - Expected: every persisted key is declared and survives a round-trip.
  - Actual: these values exist only until the next poll or save response. After a rental pickup, valued receipts of that product fail. Lot, repair-link and purchase-method data are lost.
- Impact: features break and data goes missing after sync. The optimistic UI hides the problem until a reload.
- Root cause (verified): the fields are missing from `models[...].fields`, so cleanRecord drops them.
- Recommended correction: declare the fields (hidden or readonly), and add a CI test like con10 that fails when a button writes an undeclared key.
- Dependencies: DB-011
- Verification plan: con10 reports none; con11 gives ok in both states.
- Confidence: Confirmed (data loss for all 5 keys; downstream breakage shown for qty_rented)

### MIZAN-DB-013 No idempotency or outbox: interrupted sends are recorded as delivered, and API retries duplicate records
- Severity: P3
- Category / Component: Crash recovery, replay / server/mailtrack.js, src/models/mailing.js, server/integrations.js, server/api.js
- Evidence:
  - queueMailing creates traces with `state: 'sent'` and sets `delivered: picked.length` before any email goes out (mailing.js:73-77, read via grep).
  - deliver commits that state first and then loops over sendMail (mailtrack.js:40-55). SMS works the same way (integrations.js:219-232).
  - A crash mid-loop leaves the remaining recipients marked sent, with no retry.
  - REST `POST /api/v1/<model>` creates a new record on every call, with no idempotency key (api.js:305-309).
  - Positive: replaying an identical /api/diff create is idempotent (con3 [a]: 1 lead, 1 message), and WhatsApp inbound messages are deduplicated by wa_message_id (src/models/whatsapp.js:99).
- Reproduction: code read; the crash case was not executed.
- Expected / Actual:
  - Expected: a queued state, then a sent state per recipient, and an idempotency key on API creates.
  - Actual: at-most-once delivery reported as delivered, and duplicate records on client retries.
- Impact: wrong mailing statistics and silently missed recipients after a crash; duplicates from integrators that retry.
- Root cause: state is recorded optimistically before side effects; there is no idempotency key.
- Recommended correction: add a `queued` trace state promoted after each send, a resume job at boot, and support for an `Idempotency-Key` header on POST /api/v1.
- Dependencies: none
- Verification plan: kill the server mid-mailing (with a fake SMTP that hangs) and check the trace states; send the same Idempotency-Key twice.
- Confidence: Strongly supported (code read)

---

### MIZAN-PERF-001 Every write costs O(whole database) on the single event loop, and anonymous requests can trigger it
- Severity: P1
- Category / Component: Performance, scalability / src/sync.js, server/storage.js, server/index.js
- Evidence:
  - Each applyDiff runs `JSON.stringify(next)` of the whole db for the size cap (sync.js:116). It also builds full maps and sorts each touched model (sync.js:9, :55, :64) and copies the model per upserted record (sync.js:59). It scans all messages (sync.js:79-80).
  - storage.save runs diffDb over every model and record (storage.js:67).
  - /api/diff answers with the whole db (index.js:439, send at :174).
  - Unrate-limited anonymous commits: GET /api/public/blog/:id writes a visit counter through applyDiff (index.js:263-268, blog.js:14, :43).
  - perf.mjs timings:

    | records (JSON) | applyDiff 1 edit | diffDb in save | SQLite incremental save | JSON.stringify(db) | 1000-record diff |
    |---|---|---|---|---|---|
    | 344 seed (0.08 MB) | 1.0 ms | 0.2 ms | 0.9 ms | 0.6 ms | 0.7 ms |
    | 50,344 (30.7 MB) | 264 ms | 35.5 ms | 57.9 ms | 595 ms | 527 ms |
    | 150,344 (92.0 MB) | 1270 ms | 139 ms | 179 ms | 1151 ms | 1030 ms |

  - live2.mjs and live3.mjs (50k, real server):
    - `POST /api/diff (1 field on 1 lead): 200, response 30.4 MB, 901 ms | a GET /api/session sent 5 ms later waited 739 ms` (a second run gave 1329 ms / 1093 ms)
    - `20 sequential anonymous GET /api/public/blog/1 ...: 388 ms each`
- Reproduction: `node perf.mjs <copy> 0,50000`, `SKIP_JOBS=1 node --max-old-space-size=6144 perf.mjs <copy> 150000`, `node live2.mjs <copy> 50000`, `node live3.mjs <copy> 50000`.
- Expected / Actual:
  - Expected: write cost proportional to the change.
  - Actual: it is proportional to the database size. At 50k records one save blocks every other request for about 0.7-1.1 s.
- Impact:
  - Throughput collapses as data grows. Each save also downloads 30 MB to the saving user.
  - Arithmetic, not measured: at 388 ms per anonymous blog view, about 2.6 views per second saturate the server at 50k records. The tracking pixel (300 per 15 min per IP) and livechat give similar amplification.
- Root cause (verified): whole-db immutable snapshots, a full-JSON size check, full-db responses and a single Node process.
- Recommended correction:
  1. Track size incrementally (sum the per-record JSON lengths at save time).
  2. Return only the applied diff plus a version.
  3. Make storage.save take the applied diff instead of re-diffing.
  4. Rate-limit or batch visit counters.
  5. In the longer term, move to per-record SQL storage with indexes.
- Dependencies: PERF-002, DB-009
- Verification plan: re-run perf.mjs and live2.mjs; target applyDiff of 1 edit under 5 ms at 50k.
- Confidence: Confirmed (measured; the saturation figure is extrapolated)

### MIZAN-PERF-002 The whole database is replicated to every browser every 15 s and after every save
- Severity: P1
- Category / Component: Performance, network / src/store.js, server/index.js
- Evidence:
  - `GET /api/db` returns visibleDb, which for admins and unrestricted users is the entire db: all records, all messages and inline binary data URLs up to 3 MB each (index.js:147-155, :431; validate.js:6, :35-37).
  - The client polls every 15 s per visible tab (store.js:11, :83) and receives the whole db after each save (store.js:113).
  - There is no compression (no zlib in server/), no pagination and no delta sync.
  - live2.mjs (50k):
    - `GET /api/db: 200 30.4 MB in 582 ms`
    - `5 concurrent GET /api/db (5 users' 15 s poll): all done in 3882 ms, 152 MB sent`
    - `server RSS 616 MB`
  - perf.mjs: JSON.parse of the payload takes 250 ms at 50k and 889 ms at 150k (Node; the browser cost is not measured).
- Reproduction: live2.mjs.
- Expected / Actual:
  - Expected: paginated or delta queries.
  - Actual: about 2 MB/s of JSON per open tab at 50k records (30.4 MB / 15 s), and every user holds every record in browser memory.
- Impact:
  - Extrapolated, not measured: about 0.78 s of server CPU per poll means roughly 19 visible tabs saturate the single core budget at 50k records.
  - Bandwidth and browser memory grow linearly with the data, which makes mobile or remote users impractical.
  - All data, including other companies' data, is shipped to every user (DB-008).
- Root cause (verified): the client-side ORM needs the full db, because all business logic runs in the browser.
- Recommended correction: in the short term, send changes since a version number (server change log) instead of the full db, gzip JSON responses, and move binary data to separate endpoints. In the longer term, use server-side queries with pagination.
- Dependencies: PERF-001, DB-008
- Verification plan: measure bytes per poll at 50k after the change (should be about the diff size).
- Confidence: Confirmed (measured; the saturation figure is extrapolated)

### MIZAN-PERF-003 Scheduled jobs block the event loop at boot and hourly, with super-linear cost
- Severity: P2
- Category / Component: Performance / src/models/scheduler.js, server/index.js:543-553
- Evidence:
  - `runJobs()` runs synchronously at module load (index.js:552) and then every hour (:553).
  - The jobs loop `write()` inside `reduce`. write copies the whole model array and the messages array (orm.js:107-108), which makes the loops O(n²). Examples: finance.js:147-157 runFollowUps, crmteams.js:35-39 refreshProbabilities.
  - perf.mjs: `runScheduledJobs(db) (hourly, blocks the event loop): 8888.8ms` at 50k records (6.7 ms on the seed).
  - perfjobs.mjs: runFollowUps 5291 ms → 23769 ms, and refreshProbabilities 1913 ms → 15100 ms, going from 50k to 100k records.
  - live2.mjs: `spawn->'listening' log 8313 ms` at 50k against 2126 ms at 20k (live6.mjs). The listen callback cannot run until the jobs finish.
- Reproduction: perf.mjs, perfjobs.mjs.
- Expected / Actual:
  - Expected: background jobs that are incremental and yield.
  - Actual: a multi-second to tens-of-seconds freeze once an hour and on every restart.
- Impact: hourly outages that grow quadratically with data, and slow restarts.
- Root cause (verified): immutable full-array copies per write inside loops, run on the request thread.
- Recommended correction:
  1. Batch writes per job: build a Map, then one array rebuild.
  2. Process jobs in chunks with `setImmediate`, or move them to a worker thread.
  3. Run the boot job after `listen`.
- Dependencies: PERF-001
- Verification plan: perfjobs.mjs at 50k and 100k should scale linearly.
- Confidence: Confirmed

### MIZAN-PERF-004 No indexes: id lookups and text search are linear scans
- Severity: P2
- Category / Component: Performance / src/orm.js
- Evidence:
  - `read()` uses `Array.find` (orm.js:32).
  - `search()` maps computed fields over every row (orm.js:23-28).
  - `matches()` calls `read()` for every many2one field of every row (orm.js:184).
  - perf.mjs (50k): `1000 x read(account.move, id) (linear find): 510.0ms` (1687 ms at 150k); `search(account.move) -> 30009 rows with computed fields: 183.8ms`.
  - perf2.mjs: `30009 invoices, 5008 partners, 9 many2one fields: search-bar text filter took 678 ms` against `same partner lookups through a Map: 4.0 ms`.
  - SQLite load at startup: 392 ms (50k) and 1538 ms (150k).
- Reproduction: perf.mjs, perf2.mjs.
- Expected / Actual: Expected: O(1) id lookup. Actual: O(n) lookups, so list views, text search and the REST list (api.js:302) cost O(n·m).
- Impact: UI and REST latency grow with the data. The same code runs in the browser and on the server.
- Root cause (verified): records are stored as arrays only.
- Recommended correction: keep a per-model `Map` index (built lazily, invalidated per snapshot), and memoize computed fields per record object.
- Dependencies: PERF-001
- Verification plan: perf2 text filter under 50 ms at 50k.
- Confidence: Confirmed

### MIZAN-PERF-005 Hard capacity ceiling: past 200 M JSON characters every write fails; attachments count inline
- Severity: P2
- Category / Component: Scalability / src/sync.js:41, :116; src/validate.js:6
- Evidence:
  - `MAX_DB_CHARS = 200 * 1024 * 1024` and `if (JSON.stringify(next).length > MAX_DB_CHARS) throw new Error('Database size limit reached')`.
  - Binary fields are data URLs up to 3 MB stored inside records (validate.js:6, :36).
  - Measured: 92.0 MB at 150,344 records, with heapUsed 656 MB in the perf harness.
  - `MAX_BODY = 5 MB` per request (index.js:49) caps a single diff, which is what breaks the restore in DB-010.
- Reproduction: perf.mjs 150000.
- Expected / Actual: Expected: graceful growth. Actual: a hard stop. Arithmetic: about 325k records of this shape, or about 70 max-size attachments, reach the cap.
- Impact: once reached, every save for every user fails until data is deleted. Memory grows with the data (RSS 616 MB at 50k, measured live).
- Root cause (verified): the whole db is one in-memory JSON document.
- Recommended correction: store binary data outside records (a file table or blob storage); replace the cap with real storage limits; move to per-record storage (DB-009).
- Dependencies: PERF-001, DB-010
- Verification plan: inflate to the cap in a test copy and confirm that writes still work after the attachment move.
- Confidence: Confirmed (constants and measurements; the ceiling is extrapolated)

### MIZAN-PERF-006 Client bundle served uncompressed and without cache headers
- Severity: P3
- Category / Component: Performance, frontend delivery / server/index.js:200-223
- Evidence:
  - dist/assets/index-DuMxlqpS.js is 1,102,124 bytes (320,635 gzipped). It is a single chunk with no code splitting.
  - serveStatic sets only Content-Type and security headers. There is no compression, Cache-Control, ETag or Last-Modified (index.js:211; grep for zlib/ETag in server/ returned nothing).
  - Livechat polls every 3 s, but only while the widget is open, and the endpoint is read-only (PublicSite.jsx:39, :64; livechat.js:75-81). Low cost.
- Reproduction: `ls -la dist/assets; gzip -c <js> | wc -c`.
- Expected / Actual: Expected: gzip or brotli plus `immutable` caching for hashed assets. Actual: 1.1 MB per load, re-validated every time.
- Impact: slow first loads on poor links, which matters less than PERF-002.
- Root cause (verified): a minimal static server.
- Recommended correction: add `Cache-Control: public, max-age=31536000, immutable` for /assets/*, pre-compressed .gz/.br files, and route-level code splitting.
- Dependencies: none
- Verification plan: `curl -I` shows the headers; check transfer size.
- Confidence: Confirmed
