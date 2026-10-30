# Mizan audit: Architecture, Code Quality, Tests/CI, Dependencies/Licensing, GitHub Governance (workstream "arch")

Audited commit: 0e9f74820706083ba6e94dd414a63053348e1d3d. Dynamic work ran only in copies:
- `scratchpad/work-arch` and `scratchpad/work-arch2`: full copies.
- `scratchpad/arch-ro`: src copy with a node_modules symlink.

The scripts are in `evidence/arch-scripts/`.

## Summary
- **Where the logic runs.** Mizan is a browser-first ERP. 230 of 290 form buttons compute state transitions in the browser with `run(db, record)`. The server only re-validates the resulting records: 56 of 180 models have a guard and 7 have protectDelete (ARCH-001).
- **applyDiff is order-dependent.** It validates a multi-model diff against partially applied state. Because of this, the Expenses **Create Report** button always fails in server mode (HTTP 400 as admin, reproduced) (ARCH-002).
- **Model composition is fragile.** The model registry is composed from 79 object spreads in one 1,534-character line (index.js:85), and 42 model keys are defined by more than one module. I moved each of 28 overriding modules: 6 of the 28 moves silently drop fields and buttons and the 762-test suite stays green. One example is `pos.order`, which loses 12 fields and the **Pay** button (ARCH-003).
- **Import cycles.** `src/orm.js` plus 85 of 89 model files form one strongly connected import cycle with 12,989 elementary cycles. 82 of 93 core modules crash with a temporal-dead-zone (TDZ) ReferenceError when they are the first module imported (ARCH-004).
- **The tests mostly avoid the server path.**
  - 34 `applyDiff` calls appear in 10 of 113 test files, and only 4 of them use `isAdmin:false`.
  - No test exercises `/api/diff`, `/api/db` or `/api/v1` (`handleApi`) over HTTP.
  - `server/index.js` is never instrumented.
  - A browser-only test such as ledger.test.js:31 ("unbalanced entries cannot be posted") passes, while the server accepts the same forged entry (TEST-001).
- **Date time bombs.** The suite starts failing on **2026-12-02** (in 37 days) and has 5 failures from **2027-01-01**. The Dockerfile runs `npm test`, so Docker builds will break on those dates (TEST-002). Without `dist/`, 4 tests fail (TEST-003, confirmed).
- **Coverage.** Line coverage is 99.0% for src/models and 90.5% for server, which flatters the suite. Branch coverage is 84.5% and 73.2%. 22% of the source lines are never loaded by any test (TEST-005).
- **Governance.**
  - There is no CI, no branch protection, no rulesets, no PRs, no issues, no tags and no releases (GOV-001).
  - 149 commits landed in 32.9 h, all by one author directly to main. Commit messages name AI agents (Codex, Pi, agy), and 32 commits landed less than 60 s after the previous one (GOV-002).
  - The repository is public, its README calls it "open", and it has **no LICENSE** (LIC-001).
- **Licensing.** The dependencies are all permissive (MIT, ISC, Apache-2.0, BSD, Unlicense, CC-BY-4.0). There are no Odoo assets or logos. The SPEC states that behaviour was captured from the Odoo Enterprise demo, and the code reuses Odoo's technical model and field names. These are legal-review items, and I draw no legal conclusions (LIC-002).
- **Fit for a large ERP and the Odoo option.** ARCH-008 gives an evidence-based Odoo Community/OCA comparison as decision input only.

Counts: P0 0 (the P0 instances are owned by SEC, ACC, FLOW and DB and cited below), P1 5, P2 11, P3 4.

## What I verified / what I could not verify
**Verified (I ran it or read it):**
- The full suite gives 762/762 in my copy. With `dist` removed I get 4 failures; I read the test names and the error.
- The coverage run (`--experimental-test-coverage` plus an lcov reporter) works on Node 22.22.0.
- An import-graph script with Tarjan SCC and an exact count of elementary cycles.
- A standalone import of every core module.
- Collision, shadow and mutation scripts over the model spread (28 suite runs).
- Clock-shifted suite runs (+30 to +1200 days, binary search to the first failing day) and runs in 4 time zones.
- Tests at every 10th historical commit, with the failures re-checked under a clock set back one day.
- A button harness: 220 button runs on seed records, each passed through applyDiff.
- A real HTTP server on port 38517 with a temporary database, used to reproduce the Create Report 400. Only my own process was stopped.
- An applyDiff benchmark, `npm audit` (lockfile copy), a license scan of node_modules/*/package.json and the lockfile prod tree, and an Odoo grep over the working tree, dist and history.
- `git log` statistics and the secret-pattern scan of history.
- `gh api` GET calls: repo, branches/protection, rulesets, pulls, issues, actions/workflows, community/profile, releases, tags, deployments.

**Could not verify:**
- `gh api` collaborators, hooks, environments and vulnerability-alerts were refused by the proxy (HTTP 403).
- The latest @anthropic-ai/sdk version: I used no network beyond `npm audit`. **NOT VERIFIED**.
- Odoo and OCA feature and licence statements in ARCH-008 and LIC-002 come from auditor knowledge and were not checked against Odoo or OCA sources in this audit. **Hypothesis-level; verify before deciding**.
- Whether any AI agent that wrote the code had access to Odoo source. **NOT VERIFIED** (legal-review item).
- The REA evidence ids cited in SPEC.md (`ev_67ecdb63…` and others) are not in the repo, so the clean-room capture record could not be inspected.

---

### MIZAN-ARCH-001 Business logic and workflow authority live in the browser; the server is a record-shape validator
- Severity: P1 (architecture root cause; the exploitable P0 instances are MIZAN-SEC-001, MIZAN-ACC-001 and MIZAN-FLOW-001)
- Category / Component: Architecture / src/views/FormView.jsx, src/store.js, src/sync.js, src/models/*
- Evidence:
  - FormView.jsx:285-286: `const res = b.run(getDb(), read(getDb(), model, savedId)); commit(res.db);`. Then store.js:103 and :110-114 compute `diffDb(db, next)` and POST it to `/api/diff`. On failure the client shows `alert(...)` (store.js:114).
  - The server handler (index.js:432-439) is just `commitDb(applyDiff(db, diff, {...}))`. The server never learns which action was intended.
  - A registry scan (arch-ro) found 85 models with form buttons and 290 buttons. 230 of the buttons have a client `run()`, and only 8 are flagged `server`. Guards: 56 of 180 models; protectDelete: 7 (account.move, hr.expense, hr.expense.sheet, account.fiscal.year, uom.category, uom.uom, consolidation.period).
  - The browser and server use different validators. The browser ORM checks only `required` and the guard (orm.js:37-42, :71, :103). Type and shape cleaning (validate.js `cleanRecord`) runs only on the server, inside applyDiff (sync.js:58). So the browser can produce states the server rejects (ARCH-002, ARCH-006, MIZAN-FLOW-004/005, MIZAN-DB-012), and the server accepts states the browser would never produce (next bullet).
  - Repro of the "browser-only rule": `postMove` throws "Journal entry is not balanced". The same entry upserted as `state:'posted'` with debit 100 / credit 90 through `applyDiff(..., {isAdmin:false})` is **accepted**, with `state=posted lines [[100,0],[0,90]]`.
  - Model logic calls UI globals, which blocks moving it to the server unchanged: `window.open` (sales.js:120, crm.js:62), `window.location.href` (logistics.js:140), and `globalThis.prompt` (qualityplus.js:109, websiteplus.js:207).
  - Company filtering is a client concern: orm.js:13 says `let activeCompany = null; // null = no filtering (server, tests)` (see MIZAN-SEC-002 and MIZAN-DB-008).
- Reproduction: `node --input-type=module` in a copy. Create an unbalanced `account.move`, then call `applyDiff` with a forged `state:'posted'` and `{isAdmin:false}` (the script is inline in my transcript; MIZAN-ACC-001 has a fuller repro).
- Expected / Actual: Expected: state transitions are executed and authorized on the server. Actual: the server checks per-record shape plus 56 optional guards. Every other workflow rule is advisory.
- Impact: Every invariant that lives only in a button (posting, balancing, stock moves, approvals) can be bypassed by a crafted diff. Fixing it rule by rule means duplicating each one into a guard.
- Root cause: Verified design choice. README "Architecture" and SPEC describe the pure ORM as running in the client, with the server applying a record diff.
- Recommended correction:
  - Introduce server-side commands, for example `POST /api/action {model, id, button}`, that run the same pure `run()` on the server's db. Accept only declared editable fields in generic diffs.
  - Make state, numbering and amount fields readonly to `/api/diff`.
  - Move UI calls (prompt, window) out of models into button metadata (the `prompt` key already exists).
- Dependencies: MIZAN-SEC-001, MIZAN-ACC-001, MIZAN-FLOW-001, MIZAN-MOD-008, MIZAN-DB-012, ARCH-002, TEST-001.
- Verification plan: For each of the 230 run-buttons, a test posts the forged end state through HTTP as a non-admin and expects 403/400, while the server-side command path succeeds.
- Confidence: Confirmed

### MIZAN-ARCH-002 applyDiff validates a multi-model diff against partially applied state; Expenses "Create Report" always fails in server mode
- Severity: P1
- Category / Component: Architecture, correctness / src/sync.js:52-64, src/models/expenseplus.js:220-224 and :238
- Evidence:
  - sync.js:52-64 loops `for (const [model, recs] of Object.entries(d.upserts))`. Each record is checked with `guard(seen, ...)`, where `seen` holds only the models already processed (sync.js:59).
  - `diffDb` orders upserts by the db's model-key order (sync.js:18). After a reload from SQLite, that order is alphabetical (`ORDER BY model, id`, storage.js:17), so `hr.expense` always comes before `hr.expense.sheet`.
  - The hr.expense guard (expenseplus.js:221-223) requires the new `sheet_id` to point to an existing draft sheet that lists the expense. In the diff that the button itself produces, that sheet has not been applied yet.
  - Repro in a copy:
    ```
    diff upsert order: hr.expense -> hr.expense.sheet
    server /api/diff path rejects: Use Create Report to group draft expenses
    same diff with model order reversed: accepted
    ```
  - Real HTTP server in work-arch2 (port 38517, temporary DB, admin login), script `arch-scripts/http-expense.mjs`:
    ```
    login 200
    POST /api/diff (admin, Create Report on draft expense 3): 400 Use Create Report to group draft expenses
    ```
  - The button harness (`arch-scripts/buttons.mjs`) ran 220 button executions on seed records: 157 were accepted by the server and 7 rejected. Of the 7, 1 is this case and 6 are ARCH-006.
- Reproduction: Start the server on a high port with a temporary MIZAN_DB, log in, GET /api/db, run the hr.expense "Create Report" button with src/models, then POST `diffDb(db, res.db)`.
- Expected / Actual: Expected: an atomic diff is validated against its full post-state, or applied in dependency order. Actual: guard outcomes depend on model-key order, and this feature is unusable when a server is running.
- Impact: Expense reports cannot be created in production mode. Every cross-model guard (sheet ↔ expense, and any future ones) is order-sensitive in the same way. The test suite misses it because it never runs this flow through applyDiff (TEST-001).
- Root cause: Verified, as shown by the reversed-order acceptance above.
- Recommended correction: Apply all upserts first, then run every guard against the complete candidate state (`guard(next, before, after)`), and only then commit. Alternatively, add a two-phase validate step.
- Dependencies: ARCH-001, TEST-001. Same root-cause family as MIZAN-FLOW-004/005 and MIZAN-DB-012.
- Verification plan: A regression test that runs Create Report through `applyDiff(db, diffDb(db, run(...)), {isAdmin:false})` and over HTTP.
- Confidence: Confirmed

### MIZAN-TEST-001 The tests exercise browser functions; the server enforcement path is barely tested
- Severity: P1
- Category / Component: Tests / src/*.test.js, server/*.test.js
- Evidence:
  - **Size.** The inventory is 113 test files (101 in src, 12 in server). The suite runs 762 tests (759 top-level `test(` calls) with 3,927 assert calls.
  - **Server path.**
    - `applyDiff(` is called 34 times, in 10 of 113 files.
    - `isAdmin: false` appears 4 times (companyView.test.js:99, studio.test.js:25 and :32, whatsapp.test.js:101), and `allowed` appears in 6 files.
    - 13 of 56 guarded models are named in a test body that also calls applyDiff. This is an upper bound from a text heuristic.
    - Only account.move (finance.test.js:60) has a protectDelete case through applyDiff, 1 of 7.
    - Direct guard calls: 3 (company.test.js:65, uom-flows.test.js:67, uom.test.js:44), none of them with `isAdmin:false`.
  - **HTTP.**
    - No test calls `/api/diff`, `/api/db`, `/api/keys`, `/api/users` or `/api/reset`, or checks CSRF or session expiry over HTTP. server/website.test.js has 6 tests: 1 admin login and redirects; the rest cover website pages.
    - `handleApi` (REST /api/v1, server/api.js:285) has 0 references in tests. Coverage marks api.js lines 286-328 uncovered.
  - **Escapes the suite does not catch:**
    1. src/ledger.test.js:31-37 asserts that `postMove` rejects unbalanced entries, while the server accepts a forged posted unbalanced entry (ARCH-001; MIZAN-ACC-001 is primary).
    2. Create Report is broken in server mode (ARCH-002).
    3. Seeded documents cannot be saved by the server (ARCH-006).
    4. Stripped workflow fields and work-order Start fail (MIZAN-FLOW-004/005).
    5. Same-record lost update, reproduced: `after Alice then Bob (same record, both from same base): revenue = 42000 name = Bob renamed -> Alice edit lost silently, no error` (MIZAN-DB-003 is primary). No test covers same-record concurrency; grep for `concurren|conflict|stale|race|version` finds only domain-level "stale approval" cases.
  - **Authorization tests:** 4 tests in security.test.js plus 1 WhatsApp test. There are no record-rule or company-isolation tests on the server path.
- Reproduction: `grep -c "applyDiff(" src/*.test.js server/*.test.js`, `grep -n "isAdmin: \?false"`, `grep -l handleApi`, and the button harness `arch-scripts/buttons.mjs`.
- Expected / Actual: Expected: every guard, protectDelete, app restriction and API route has negative tests through the server boundary. Actual: the server boundary is tested by roughly 10 files, mostly as admin by default (applyDiff defaults to `isAdmin=true`, sync.js:44).
- Impact: A green suite says little about what the production server enforces. Security and accounting P0s, and broken server-mode flows, ship green.
- Root cause: Verified. Tests import model functions directly (pure ORM). The server entry point (index.js) has import-time side effects (it opens SQLite and listens; index.js:52 and :540), so it can only be tested by spawning it.
- Recommended correction:
  - Add a server-path harness: an in-process `createApp({sql, env})` factory exported from index.js. It should run each flow test twice, once via the browser ORM and once via `applyDiff(..., {isAdmin:false, allowed})` and HTTP.
  - Add forged-diff negative tests per guarded model.
  - Add REST /api/v1 tests with restricted keys.
  - Add a same-record concurrency test that expects a conflict once optimistic locking exists.
- Dependencies: ARCH-001, ARCH-002, MIZAN-SEC-001, MIZAN-ACC-001, MIZAN-DB-003, MIZAN-FLOW-004, MIZAN-MOD-007 (86 tested functions unreachable from the UI).
- Verification plan: A coverage report that includes server/index.js. Count of guarded models with a non-admin applyDiff test = 56/56.
- Confidence: Confirmed

### MIZAN-GOV-001 No CI, no branch protection, no PR review: the Docker build is the only automated gate
- Severity: P1
- Category / Component: Governance / GitHub repo sayed710/mizan
- Evidence (`gh api`, read-only GET):
  - `branches/main/protection` → `404 Branch not protected`. `branches` → `"protected":false`, `"required_status_checks":{"enforcement_level":"off"}`.
  - `rulesets` → `[]`. `actions/workflows` → `{"total_count":0}`. There is no `.github` directory in the clone.
  - `pulls?state=all` → `[]`. `issues?state=all` → `[]`. `releases` → `[]`. `tags` → `[]`. `deployments` → `[]`.
  - `community/profile` → `"health_percentage":14`, with license, contributing, code_of_conduct and templates all null.
  - Repo: `"private":false,"visibility":"public","license":null`.
  - `security_and_analysis`: `dependabot_security_updates: disabled`, `secret_scanning: enabled`, `push_protection: enabled` (the last two are positive).
  - The only test gate is Dockerfile:7, `RUN npm run build && npm test`. TEST-002 shows that this gate will start failing for date reasons alone.
- Expected / Actual: Expected for an ERP that holds financial data: protected main, required CI (tests, lint, audit), PR review, and tagged releases. Actual: none of these.
- Impact: Nothing prevents a regressing or malicious commit from reaching main. Combined with the concurrent agent workflow (GOV-002) and the weak server-path tests (TEST-001), integrity depends entirely on the author's local runs. There is no release identifier to tie a deployment to an audited commit.
- Root cause: Verified (repo settings).
- Recommended correction:
  - Add a GitHub Actions workflow: `npm ci && npm run build && npm test` on Node 22 and 24, plus `npm audit --omit=dev`, plus lint.
  - Protect main: require PRs, the status check and one review, and block force-push.
  - Enable Dependabot alerts and updates.
  - Tag releases.
  - Do not initiate any of this without owner approval.
- Dependencies: GOV-002, TEST-002, TEST-003.
- Verification plan: Re-query `branches/main/protection`, `rulesets` and `actions/workflows`.
- Confidence: Confirmed

### MIZAN-LIC-001 Public repository with no LICENSE while the README calls it "open"
- Severity: P1 (legal and governance blocker for any third-party use or contribution; no legal conclusion drawn)
- Category / Component: Licensing / repo root, package.json
- Evidence:
  - `ls LICENSE* COPYING*`: none. GitHub `license: null`; community profile `license: null`.
  - package.json has `"private": true` and no `license` field.
  - README.md:3 says "An open, clean-room business suite".
- Expected / Actual: Expected: an explicit licence (or an explicit proprietary notice) in a public repo, matching the "open" claim. Actual: no licence is stated.
- Impact: Users, deployers and contributors have no stated rights. The ambiguity also complicates the clean-room position (LIC-002), any future combination with LGPL/AGPL code (ARCH-008), and the Apache-2.0 NOTICE handling of dependencies (LIC-003).
- Root cause: Verified (file absent).
- Recommended correction: The owner, after legal advice, chooses a licence (or "all rights reserved"), adds LICENSE plus the package.json `license` field, and documents third-party notices.
- Dependencies: LIC-002, LIC-003, ARCH-008.
- Verification plan: The GitHub API `license` field is non-null.
- Confidence: Confirmed

### MIZAN-ARCH-003 Model composition by object-spread order is fragile: silent overrides, dead shadowed definitions, and regressions the tests do not catch
- Severity: P2
- Category / Component: Architecture, coupling / src/models/index.js:85, src/models/*plus.js
- Evidence:
  - **The spread.** index.js:85 is a single 1,534-character line, `export const models = withCompany({ ...crmModels, ...salesModels, ... ...consolidationModels });`, with 79 spread entries. A line follows that mutates the result: index.js:86 `models['hr.leave'].guard = leaveGuard;`.
  - **Collisions** (`arch-scripts/collisions.mjs`): 42 model keys are defined by more than one spread module. Examples: `product` by 4 modules (sales > valuation > billControl > ecommerce); `sale.order` by sales > ecommerce > quotePlus; `account.analytic.line` by more > analyticPlus > timesheetPlus.
  - **Two sources of truth.** Each `*plus.js` file extends a base it imports (for example expenseplus.js:5 and :8 import `moreModels['hr.expense']`, and ecommerce.js:7 imports billControl), and the spread order must agree with that import chain. The history shows real breakage: commit c4e79cd, "chore: load timesheet depth after analytic accounting (both define account.analytic.line)". 97 of 149 commits touch index.js, and 61 commits changed line 85 (`git log -L85,85`).
  - **Shadowed dead code** (`arch-scripts/shadow.mjs`): 35 base definitions are extended and 13 are wholly replaced. The replaced ones are 12 in apps2.js (maintenance.equipment and maintenance.request at apps2.js:79/103, quality.check and quality.alert :128/164, fleet.service :262, survey.survey and survey.answer :330/360, lunch.product and lunch.order :381/396, approval.request :418, fsm.task :492, slide.channel :545) and more.js:510 `event.registration`. That is about 330 lines of unreachable model definitions. Logic is duplicated by copy-paste: the seat-capacity guard in more.js:525-532 is re-implemented in eventsplus.js:219-228.
  - **Mutation test** (`arch-scripts/mutate.sh`). I moved each of the 28 overriding modules to the front of the spread and ran the full suite. 22 reorderings were caught (1 to 9 failures). **6 left the suite at 762 pass / 0 fail**, while `arch-scripts/lost.mjs` shows what the effective registry lost:
    ```
    posPlusModels      pos.order: lost 12 fields [config_id,table_id,customer_count,note,tip_amount,payment_ids,…], lost buttons [Pay|Apply Promotions]
    surveyModels       survey.survey: lost 7 fields […], lost buttons [Start Survey|See Results|Close]; survey.answer: lost 7 fields
    recruitPlusModels  hr.applicant: lost 8 fields, lost buttons [Schedule Interview|Send Offer|Accept Offer]
    analyticPlusModels account.budget: lost buttons [Confirm|Approve|Done|Cancel|Reset to Draft]; account.analytic.account: lost 6 fields
    documentsPlusModels documents.folder: lost 2 fields [company_id,tag_categories]; documents.document lost button [Share]
    warehouseModels    stock.picking: lost 3 fields [warehouse_id,warehouse_route,move_orig_picking_id]
    ```
    A separate run moving analyticPlus after timesheetPlus dropped the timesheet guard, 8 fields and 4 buttons. That one *was* caught (4 failures).
  - **Global mutable registry.** `installCustomFields` mutates shared definitions in place (studio.js:35-43) and is called in applyDiff before the size check that can still reject the diff (sync.js:114 vs :116). MIZAN-DB-011 covers the fact that custom fields are never removed.
- Reproduction: `bash arch-scripts/mutate.sh` (in a copy; it restores index.js and checks it with `cmp`).
- Expected / Actual: Expected: deterministic composition from a declared dependency graph, with conflicts detected. Actual: later spreads silently replace earlier ones, and correctness depends on manual ordering of a 1.5k-character line.
- Impact: Features and multi-company fields (for example `documents.folder.company_id`) can disappear from the effective schema with a green suite. The server sanitizer then strips that data on the next save (MIZAN-FLOW-004). The single line is also a merge-conflict hotspot for concurrent agents (GOV-002).
- Root cause: Verified. There is no extension or dependency mechanism. Odoo solves the same problem with `_inherit` plus manifest `depends` (ARCH-008).
- Recommended correction:
  - Replace the spread with an explicit `extend(base, patch)` registry that has declared dependencies and topological ordering.
  - Throw on an unintended redefinition.
  - Delete the 13 shadowed definitions.
  - Add a snapshot test of the effective registry (fields, buttons, guard presence per model).
- Dependencies: TEST-004, GOV-002, MIZAN-FLOW-004, MIZAN-DB-011.
- Verification plan: Re-run mutate.sh; every reordering should either be rejected at load or fail the registry snapshot test.
- Confidence: Confirmed

### MIZAN-ARCH-004 One giant import cycle: the ORM depends on every business module; most modules cannot be imported first
- Severity: P2
- Category / Component: Coupling / src/orm.js:3, src/models/*
- Evidence:
  - `arch-scripts/importgraph.py` (static ESM imports, non-test) finds 143 modules and 647 edges.
  - It finds **one non-trivial SCC of 86 modules** (`src/orm.js` plus 85 of 89 model files). The only model files outside the cycle are qr.js, reports.js, scheduler.js and studio.js.
  - The SCC contains **12,989 elementary cycles** (an exact count, not capped).
  - There are 5 mutual import pairs: apps4↔index, bank↔reconcile, index↔whatsapp, sales↔valuation, sales↔warehouse.
  - orm.js:3 does `import { models } from './models/index.js'`, so the generic ORM depends on all 79 model modules. Fan-in is orm.js 120 and common.js 82; fan-out is index.js 80.
  - Standalone first-import test (`node -e "await import('./<file>')"` for each of 93 core files): ok=11, **fail=82**. For example:
    ```
    src/models/common.js  ReferenceError: Cannot access 'productLines' before initialization (sales.js:325)
    src/models/ledger.js  ReferenceError: Cannot access 'ACCOUNT_TYPES' before initialization (accounting.js:182)
    src/models/accounting.js ReferenceError: Cannot access 'accountingModels' before initialization (index.js:85)
    ```
    Importing `src/models/index.js` or `src/sync.js` first works.
- Reproduction: `python3 -I arch-scripts/importgraph.py /home/claude/mizan`, plus the loop in my transcript.
- Expected / Actual: Expected: a layered graph, with the ORM below the models and models depending on a few shared utilities. Actual: everything depends on everything. Correctness depends on the entry point's import order.
- Impact: Adding an import can break unrelated modules at load time (TDZ). Modules cannot be tested or reused in isolation, tree-shaking is defeated (MIZAN-UI-018 reports a 1.10 MB single bundle), and any plan to run models on the server per module or lazily is blocked.
- Root cause: Verified. The ORM looks up `models[model]` from a global registry instead of receiving the registry as a parameter, and helper code sits in feature modules (for example `productLines` in sales.js used by common.js).
- Recommended correction: Pass the registry into ORM functions (or register models into an ORM instance), move shared helpers into a leaf module, and add an import-cycle check (for example madge or eslint-plugin-import `no-cycle`) to CI.
- Dependencies: ARCH-003, ARCH-007, GOV-001.
- Verification plan: The SCC count drops to 0 or 1 small cluster, and every module imports standalone.
- Confidence: Confirmed

### MIZAN-ARCH-005 Fail-open authorization defaults at three layers (latent), and authorization derived from UI menus
- Severity: P2
- Category / Component: Architecture, security by default / src/sync.js:44, src/models/whatsapp.js:112, src/models/company.js:60, src/models/index.js:563-576
- Evidence:
  - **Layer 1:** `export function applyDiff(db, d, { author, isAdmin = true, allowed = null } = {})` (sync.js:44). A caller that omits options gets admin rights and no model restriction.
  - **Layer 2:** templateGuard has `if (ctx?.isAdmin !== false) return null;` (whatsapp.js:112). Anything except an explicit `false` is treated as admin.
  - **Layer 3:** the withCompany wrapper is `guard: (db, before, r) => model.guard?.(db, before, r) ?? checkCompany(...)` (company.js:60). It drops the 4th `ctx` argument for the 11 scoped models (company.js:10). The ORM also calls guards without ctx (orm.js:71, :103).
  - **Verified, and no current escalation:** whatsapp.template is not company-scoped, so the registry guard is templateGuard itself (`true`). A non-admin approval with `{isAdmin:false}` is rejected ("Only administrators..."). Omitting `isAdmin` is **accepted**. A ctx-dependent guard wrapped by withCompany and called with `{isAdmin:false}` returns `null`, so it is allowed.
  - **Call sites.** All 16 applyDiff call sites in server/ pass `isAdmin` explicitly, except the scheduler (index.js:547 and `storeFor({author:'Scheduler'})`, index.js:570), which intends admin.
  - **Authorization coupled to navigation.** `modelsForApps` builds read and write rights from menu leaves, plus SHARED `res.partner`/`product`, plus one hop of relations (index.js:560-576). Repro: a Discuss-only user's applyDiff write to `account.tax` (amount 0), `account.account` (rename) and `hr.employee` was ACCEPTED. A non-admin with an empty app list gets `allowed = null`, which means every model (index.js:146). MIZAN-MOD-001, MIZAN-SEC-001 and MIZAN-ACC-009 are primary for this impact.
- Expected / Actual: Expected: deny by default (`isAdmin=false`, ctx always forwarded, guards checking `isAdmin === true`), with rights declared per model and operation rather than inferred from menus. Actual: allow by default at every layer.
- Impact: Today it is latent. The next guard that relies on `ctx.isAdmin` on a scoped model, or a new endpoint that forgets the option, silently becomes an escalation.
- Root cause: Verified.
- Recommended correction: Flip the defaults. Forward `...rest` in the withCompany wrapper and in ORM guard calls. Introduce an explicit ACL table (model × operation × group) independent of menus.
- Dependencies: MIZAN-MOD-001, MIZAN-SEC-001, MIZAN-SEC-003, MIZAN-ACC-009, TEST-001.
- Verification plan: A unit test that calls `applyDiff(db, d)` without options and expects non-admin behaviour. A wrapper test asserting that ctx reaches the inner guard.
- Confidence: Confirmed (the hazard). The current escalation through these defaults was verified as absent.

### MIZAN-ARCH-006 Shipped seed data violates the current schema; data from earlier versions cannot be re-saved
- Severity: P2
- Category / Component: Versioning and migrations / src/seed.js:251-252, src/models/signplus.js:304
- Evidence:
  - The seed writes `tag_ids: ['Tax']`, `['Policy']` and `['Contract']` as strings (seed.js:251-252). The effective field is a one2many of `{tag_id}` (signplus.js:304; registry dump: `{"type":"one2many",...,"fields":{"tag_id":{...}}}`), and there are no `documents.tag` records.
  - Repro:
    ```
    browser orm.write: ok -> Q3 VAT return (renamed).pdf
    server applyDiff rejects the same edit: Invalid value for documents.document.tag_ids
    ```
    Any button on these records is rejected too (button harness: "Create Task" and "Lock", 3 each).
  - **Older data.** `arch-scripts/resave.mjs` exports seed data from older commits and re-saves every record unchanged through the current applyDiff.
    - 682510d (10-25 11:05): 8 records rejected. Errors include "appointment.booking: Start (YYYY-MM-DDTHH:MM) is required", "maintenance.request: Maintenance duration cannot be negative" and "hr.referral: Points spent must be a non-negative integer".
    - 5b05625: 3 records rejected.
    - The current seed: 3 records rejected.
  - **Versioning practices.**
    - No schema version exists anywhere. The browser demo bumps its localStorage key instead (store.js:10 `mizan-db-v32`; the key was changed in 34 commits).
    - The only data migration is `migrateAppointments` (appointments.js:169).
    - Ad-hoc DDL: `try { sql.exec('ALTER TABLE users ADD COLUMN apps TEXT'); } catch { /* column already exists */ }` (index.js:64) swallows any error.
    - Fields are kept for compatibility instead of being migrated ("Legacy Cost", fleetplus.js:128; "Legacy Preventive Interval", maintplus.js:104; approvalsplus.js:152 "without a data migration").
- Expected / Actual: Expected: a versioned schema with forward migrations run at boot and tested against previous releases' data. Actual: data written by an earlier build can become un-editable after an upgrade, and even the shipped seed is invalid.
- Impact: Users get "Invalid value" errors on old records after an upgrade, and the browser (which accepts) and the server (which rejects) diverge (ARCH-001).
- Root cause: Verified (no migration framework). The overall strategy gap is MIZAN-DB-011, which is primary.
- Recommended correction: Add `kv.schema_version` plus ordered migration functions, and persist the migrated rows. Add a CI test that loads the previous release's db and re-saves every record through applyDiff. Fix the seed's tag_ids.
- Dependencies: MIZAN-DB-011, MIZAN-DB-012, MIZAN-FLOW-004, TEST-001.
- Verification plan: `resave.mjs` gives 0 rejections for the current seed and for the last tagged release's data.
- Confidence: Confirmed

### MIZAN-ARCH-007 Code quality: no types, lint or formatting; extreme line lengths; divergent copy-pasted helpers
- Severity: P2
- Category / Component: Code quality / all of src and server
- Evidence:
  - **Size.** 143 non-test source files with 26,604 lines (1.61 MB). 113 test files with 12,001 lines. The largest by bytes are i18n.js (110,934), seed.js (41,310), models/index.js (40,804), more.js (39,457) and server/index.js (34,614).
  - **Line length** (`arch-scripts/linestats.sh`): 3,143 lines (11.8%) exceed 120 characters, 437 exceed 200, 21 exceed 500 and 9 exceed 1,000. The longest are i18n.js:462 (2,044 characters) and index.js:85 (1,534). Many model button definitions sit on a single line, which also inflates line coverage (TEST-005).
  - **Types and tooling.** 0 `.ts` files and 0 `// @ts-check`. There are 33 JSDoc type tags (9 `@param`, 24 `@returns`) across 718 exported functions, and no PropTypes. There is no tsconfig/jsconfig, no eslint config and no prettier config.
  - **Duplication.** 91 distinct long lines are duplicated verbatim across model files.
  - **Rounding helpers.** `round` is redeclared in 33 model files in 4 variants: 27 `Math.round(n*100)/100`, 4 `… || 0`, 1 with a `d` parameter, and 1 with `Number(n) || 0`. NaN handling differs between them (NaN vs 0).
  - **Same name, different units.** `cents` returns integer cents in assets.js:6, deferred.js:6, loans.js:6, payments.js:7 and terms.js:3, but in shop.js:9 it returns rounded currency units.
  - **Binary floating point.** `round(1.005)=1`, `round(-0.125)=-0.12` vs `round(0.125)=0.13` (accounting impact: MIZAN-ACC-015).
- Expected / Actual: Expected for a financial system: a single money module (integer minor units or decimal), type checking (TS or `checkJs`), lint and format in CI. Actual: none of these.
- Impact: Refactors (ARCH-001, ARCH-004) are high-risk without types. Helper drift causes inconsistent amounts across modules, and the long lines make review and diffs hard to read.
- Root cause: Verified.
- Recommended correction: Add `jsconfig.json` with `checkJs`, or migrate gradually to TS starting with orm, sync, validate and ledger. Add eslint (no-cycle, max-len) and prettier. Extract `money.js` (minor units, banker's or half-up rounding per policy) and replace the 33 local helpers.
- Dependencies: ARCH-004, MIZAN-ACC-015, GOV-001.
- Verification plan: `tsc --noEmit` passes in CI. `grep -c "^const round ="` returns 0.
- Confidence: Confirmed

### MIZAN-ARCH-008 Is this architecture appropriate for a large ERP? Evidence-based comparison with Odoo Community (LGPL-3) plus OCA (decision input only; nothing initiated)
- Severity: P2 (strategic)
- Category / Component: Architecture strategy
- Evidence, from this repo:
  - **Scale.** The whole database is one in-memory JS object. Each write re-validates and `JSON.stringify`s it (sync.js:116). Benchmark of `applyDiff` with a 1-record change, single-threaded: 20 ms at 10k extra records (3.2 MB), 106 ms at 50k (15.7 MB), 436 ms at 200k (62.9 MB). There is a hard cap of 200M characters (sync.js:41). Every save returns the full visible db (index.js:439), and every client polls `/api/db` every 15 s (store.js:68 and :83). MIZAN-PERF-001/002/005 are primary.
  - **What Mizan rebuilt itself:**
    - the ORM (orm.js, 191 lines), sync/validate, and a model extension mechanism (ARCH-003);
    - access control (is_admin plus menu-derived app lists; ARCH-005);
    - multi-company (client-side filter; MIZAN-SEC-002 and MIZAN-DB-008);
    - migrations (none; ARCH-006);
    - an accounting engine of about 3,216 lines across 21 files (accounting, ledger, taxes, reconcile, bank, closing, consolidation, currency, deferred, assets, payments, terms, reports, statements, finance, analyticplus, billcontrol, valuation, pay, batch, loans);
    - 180 models and 56 apps, written in about 33 hours by AI agents (GOV-002).
  - **The defect classes found in this audit sit exactly in those platform layers:** server-side authorization (SEC-001), record rules and company isolation (SEC-002, DB-008), concurrency and locking (DB-003, ACC-003), sequences (DB-004, ACC-004), migrations (DB-011), posted-entry immutability (ACC-001) and the model extension order (ARCH-003).
- What Odoo Community plus OCA would materially reduce (auditor knowledge, **not verified against Odoo or OCA sources in this audit**):
  - **ORM.** Server-side business methods, stored computed fields, SQL constraints, `@api.constrains`, PostgreSQL transactions with serialization-failure retry, and sequences (`ir.sequence`). Addresses ARCH-001, DB-003 and DB-004.
  - **Access.** `ir.model.access` (model × CRUD × group), `ir.rule` record rules, field `groups=`, and multi-company `company_ids`/`check_company` rules. Addresses ARCH-005, SEC-001 and SEC-002.
  - **Module system.** `_inherit` model extension, resolved through manifest `depends`. This is the mechanism ARCH-003 reinvents without a dependency graph.
  - **Migrations.** Module versions, pre/post migration scripts, and OCA OpenUpgrade for major versions. Addresses ARCH-006 and DB-011.
  - **Accounting.** The Community `account` module: journals, double-entry moves with posted-state immutability and balance constraints, taxes, payments, reconciliation, lock dates and multi-currency. OCA account-financial-reporting / mis-builder cover reports that Odoo ships only in Enterprise.
- Trade-offs:
  - **Licences.** LGPL-3 obligations for distributed modifications of core. Most OCA modules are AGPL-3: modified versions offered over a network must make their source available to users (legal review needed).
  - **Stack.** A Python and PostgreSQL stack and operating skills, against the current Node-only, SQLite deployment.
  - **Upgrades.** A yearly major-version cadence and upgrade cost.
  - **UI.** The UI and RTL/Arabic experience would be Odoo's web client, not Mizan's React views (MIZAN-UI-*). Customization uses Odoo's framework conventions.
  - **Missing apps.** Several apps Mizan clones are Enterprise-only in Odoo, for example Studio, Sign, Documents, Planning, Knowledge, Consolidation and IoT. These would need OCA equivalents (helpdesk_mgmt, field-service, contract and others, where they exist) or custom modules.
  - **Clean-room questions** (LIC-002) would largely disappear, because origin and licence would be explicit.
- Assessment: The current design is reasonable for a single-tenant demo or small team. For a "large ERP", the browser-authoritative model, the whole-DB-in-memory store, the missing ACL and record rules, and the missing migrations are structural rather than incremental gaps. Fixing them means building the same platform layers that Odoo/OCA already provide. Before deciding, the owner should compare the cost of a server-authoritative rewrite of Mizan's platform layer (commands, ACL, Postgres, migrations) against adopting Odoo Community plus OCA with Mizan-specific modules, including a legal review of the LGPL/AGPL obligations.
- Dependencies: ARCH-001, ARCH-003, ARCH-005, ARCH-006, MIZAN-PERF-001/002/005, MIZAN-SEC-001/002, MIZAN-DB-003/004/011, MIZAN-ACC-001.
- Verification plan: A spike that implements one flow (quotation → invoice → payment) under both options and measures integrity tests passed, effort and licence obligations.
- Confidence: Strongly supported (the Mizan-side facts are confirmed; the Odoo/OCA side is auditor knowledge)

### MIZAN-TEST-002 Date time bombs: the suite fails from 2026-12-02, so Docker builds will break; historical commits can no longer be re-verified
- Severity: P2
- Category / Component: Tests (flakiness) / src/review-fixes8.test.js:40, src/orm.test.js:92-105, src/loyalty.test.js:75, src/reports.test.js:53 and :86, src/valuation.test.js:199, Dockerfile:7
- Evidence:
  - A clock-shift preload (`arch-scripts/shift-date.mjs`, which overrides `Date`/`Date.now`) was run with the full suite in work-arch2:
    ```
    shift +0 days:   pass 762 fail 0
    shift +70 days:  pass 757 fail 5
    shift +400 days: pass 759 fail 3
    shift +1200 days: pass 758 fail 4
    ```
  - Binary search on the affected files: +36 days (2026-12-01) gives 0 failures; **+37 days (2026-12-02) gives 1 failure**, "Update Quantity and rentals keep stock valuation usable", which receives with a hard-coded `date: '2026-12-01'` (review-fixes8.test.js:52 and :58). **2027-01-01 gives 5 failures**, for example orm.test.js:101 `assert.match(posted.name, /^INV\/\d{4}\/00003$/)` (the sequence resets with the new year) and the loyalty expiry `'2026-12-31'` (loyalty.test.js:91).
  - Scale of the dependency: 101 `today()` calls in 14 test files, and 576 hard-coded 2026/2027 dates in tests.
  - Historical commits: in a copy, tests at every 10th commit fail 1 test at 98a84b1 … f2fd453 ("vendorSummary lists products and quantities per vendor"). With the clock set back 1 day they pass, so they were green when written but cannot be reproduced now.
  - Time zones UTC, Pacific/Kiritimati, Pacific/Pago_Pago and Asia/Riyadh all gave 762/762 at the audit time. No time-zone flakiness was observed (only one time of day was tested).
- Reproduction: `MIZAN_SHIFT_DAYS=37 node --import arch-scripts/shift-date.mjs --test src/review-fixes8.test.js`.
- Expected / Actual: Expected: deterministic tests with an injected clock. Actual: results depend on the wall-clock date.
- Impact: From 2026-12-02 `npm test` is red and `docker build` fails at `RUN npm run build && npm test` (Dockerfile:7), blocking deployments. Bisecting history gives false failures.
- Root cause: Verified. `today()` reads `new Date()` directly (common.js:10), and tests mix `today()`-relative data with fixed dates.
- Recommended correction: Inject the clock (`setNow()` in common.js) and freeze it in tests, or use `node:test` mock timers (`mock.timers.enable({apis:['Date'], now})`). Replace absolute dates with offsets from the frozen clock.
- Dependencies: GOV-001, TEST-003.
- Verification plan: A CI job that runs the suite at +0, +37, +67 and +400 days with the preload.
- Confidence: Confirmed

### MIZAN-TEST-003 Hidden ordering dependency: server/website.test.js needs a prior `vite build`
- Severity: P2
- Category / Component: Tests / server/website.test.js:52-127, server/index.js:46
- Evidence:
  - In work-arch with `dist` moved away, `npm test` gives `# pass 758 # fail 4`. The failing tests are #52 (permanent redirects), #53 (password form), #54 (signed-in pages redirect) and #56 (unknown slugs return the SPA). The error is `The input did not match /id="root"/. Input: '{"error":"Run \"npm run build\" first"}'`.
  - website.test.js:116 reads `../dist/index.html`, and index.js:46 has `const DIST = join(ROOT, 'dist')`.
  - The README "Run" section documents `npm test` without the build.
- Expected / Actual: Expected: `npm test` is self-contained (it builds in `pretest`, or the test uses a fixture `dist`). Actual: the result depends on a prior build artefact. A stale `dist` would also test outdated HTML.
- Impact: Fresh clones and CI jobs see 4 false failures, or false passes against a stale build.
- Root cause: Verified.
- Recommended correction: Add `"pretest": "vite build"`, or let the server take `MIZAN_DIST` so the test can point at a temporary fixture.
- Dependencies: GOV-001, TEST-002.
- Verification plan: `rm -rf dist && npm test` gives 762/762.
- Confidence: Confirmed

### MIZAN-TEST-004 Assertion quality: mostly real behaviour, but invariants are checked only on seed data, definition checks target module-local objects, and some asserts are tautologies
- Severity: P2
- Category / Component: Tests
- Evidence: the assert mix is equal 2,147, deepEqual 676, throws 609, ok 346, match 82 and other 67. All 759 top-level tests contain an assert. A sample of 15:

  | Test | Verdict |
  |---|---|
  | security.test.js:10 (wrong-type values rejected) | Strong negative test through applyDiff (default admin) |
  | security.test.js:36 (app-limited users) | Real, but line 42 `assert.ok(applyDiff(...))` is a truthy-object check |
  | sync.test.js:12 (concurrent edits, different records) | Real; there is no same-record case (TEST-001) |
  | sync.test.js:33 (untrusted input, `__proto__`) | Strong |
  | ledger.test.js:10 (every posted move balanced) | Invariant on seed data only |
  | ledger.test.js:17 (balance sheet balances) | Invariant on seed data only |
  | ledger.test.js:22 (P&L revenue) | Independent oracle for revenue, but `p.net` is recomputed from p's own fields (self-consistency only) |
  | ledger.test.js:31 (unbalanced entries cannot be posted) | False assurance: browser-only, the server accepts it (ARCH-001) |
  | sales-invoicing.test.js:9 (SO → delivery → invoice) | Strong end-to-end, browser path |
  | payroll.test.js:16 | Mixed: `defaults().rules` deep-equals the constant it is built from (change detector); `computeLines(1000)` has hard-coded values (good) |
  | company.test.js:33 (main company init) | Strong: idempotence plus `structuredClone` immutability |
  | reconcile.test.js:15 (ruleMatches) | Strong table-driven test, including an invalid regex |
  | taxes.test.js:28 (taxes booked per account) | Strong: exact amounts plus a balance check |
  | posplus.test.js:20 (tables) | Good behaviour test, but asserts on `posPlusModels['pos.order'].fields.kitchen_state`, not the merged registry |
  | server/portal.test.js:47 (HMAC links) | Strong real-HTTP negative cases; the harness `commitDb` bypasses applyDiff and storage (portal.test.js:15) |
  | (extra) orm.test.js:92 | Date-dependent (TEST-002) |
  | (extra) extra.test.js:46 `assert.ok(write(db, ...))` | Tautology: write always returns a db |

  Systemic points:
  - Tests reference module-local registries (`xxxModels['…']`) 82 times in 34 files, and the merged `models['…']` only 46 times. This is why 6 of 28 composition mutations go undetected (ARCH-003).
  - There are 44 existence-only asserts on definitions (`assert.ok(...fields.x)` and similar).
  - There are no property-based or fuzz tests of accounting invariants (random postings, credit notes, reconciliations) and no concurrency tests.
- Expected / Actual: Expected: invariants asserted on generated scenarios and through the server path, and definition checks against the effective registry. Actual: as in the table.
- Impact: Medium. The suite catches many logic regressions, but not schema-composition or server-boundary regressions.
- Root cause: Verified.
- Recommended correction: Add an effective-registry snapshot test. Replace `assert.ok(write(...))` with checks on the resulting state. Add fast-check style generators for postings that assert `isBalanced`, trial balance = 0 and the AR subledger matching the GL after random sequences, run through applyDiff.
- Dependencies: ARCH-003, TEST-001, MIZAN-MOD-007.
- Verification plan: Re-run mutate.sh and expect 28/28 detected.
- Confidence: Confirmed

### MIZAN-GOV-002 Commit hygiene and concurrent-agent risk: 149 unreviewed commits in 33 hours, parallel agents editing one hotspot line on main
- Severity: P2
- Category / Component: Governance / git history
- Evidence (from `git log` in /home/claude/mizan, read-only):
  - **Volume.** 149 commits from 2026-10-24 23:59 to 2026-10-26 08:53 (32.9 h). All are by one author and committer identity, use a personal Gmail address rather than a noreply address, and are unsigned (`%G?` = N for 149). There are 0 merge commits and a single branch, main.
  - **Agents in commit messages.** "(Codex)" 17, "(Pi)" 17, "agy" 5, as in "fix(planning): agy review round 5 …". There are 23 "chore: stub(s) for …" commits that pre-register modules so parallel agents can fill them.
  - **Cadence.** 32 commits landed less than 60 s after the previous one. Up to 28 commits in one hour (10-25 06h).
  - **Hotspot.** 42 index.js commits landed within 3 min of the previous index.js commit, and 61 commits changed the single spread line index.js:85. Commit c4e79cd fixed a load-order collision.
  - **Churn.** 54,680 insertions and 13,119 deletions. The median commit adds 144 lines; the largest adds 6,829 (1729aa5 "per-record SQLite storage").
  - **Types.** feat 113, chore 25, fix 7, test 1, security 1, i18n 1, docs 1. 9 feat commits changed no test file. Tests are named after review rounds (review-fixes, -2, -3, -4, -8 .test.js) rather than behaviour.
- Expected / Actual: Expected: feature branches, PR review (human or agent) with CI before merge, attributable authorship (Co-authored-by trailers for agents) and signed commits. Actual: direct pushes, agent identity only in free-text subjects, no review record.
- Impact: Concurrent agents editing shared files (index.js, sales.js, seed.js) can silently override each other's model definitions (ARCH-003) without a merge or CI checkpoint. The history cannot tell which agent or human produced which code (relevant to LIC-002 provenance). There is no audit trail for code that handles financial data.
- Root cause: Verified (process).
- Recommended correction: Use one branch per agent task plus a PR with required CI and review, and use `Co-authored-by` trailers naming the agent. Replace the stub/spread pattern with a registry that has no single-line hotspot (ARCH-003). Use signed commits.
- Dependencies: GOV-001, ARCH-003, LIC-002.
- Verification plan: New commits arrive via PRs with passing checks.
- Confidence: Confirmed

### MIZAN-LIC-002 Clean-room claim: Odoo naming and behavioural derivation are legal-review items (no legal conclusion)
- Severity: P2
- Category / Component: Licensing, IP / SPEC.md, README.md, src/models/*
- Evidence:
  - **What the docs say.** SPEC.md:3-5: "Behaviour observed on the public Odoo Enterprise demo (demo.odoo.com) via REA `capture_browser_scenario`. No Odoo source, assets, icons or branding are used". SPEC.md:38 records the observed URL `/odoo/crm/31`. README.md:3-5 says "clean-room … no third-party ERP code, assets or branding".
  - **"odoo" in code** (case-insensitive, excluding node_modules and dist): comments only, at Dashboard.jsx:12, orm.js:10, scheduler.js:1 ("Odoo's cron jobs"), sales.js:174 ("Odoo's backorder wizard"), sales.js:369 ("Odoo's 'Promotions' button") and closing.test.js:52. There are 0 hits in the dist bundle. In history, the term appears only in SPEC (first commit 4b903c9).
  - **Assets.** The repo contains no image, icon or font files (find for png/svg/ico/jpg/woff/ttf returned nothing). index.html has only the title "Mizan ERP".
  - **Names.** The 180 technical model names largely coincide with Odoo's, for example account.move, res.partner, stock.picking, stock.valuation.layer, hr.payslip.run, mailing.trace, documents.workflow.rule, data.recycle, account.reconcile.model and sale.order.template; the coincidence is based on auditor knowledge, **not verified against Odoo source**. Field names match too: account.move uses `move_type` (13 occurrences), `payment_state` (5), `invoice_date_due` (11), `amount_residual` (3); sales and picking use `qty_delivered` and `location_dest_id`.
  - **Not documented:** the provenance of the Arabic translations (i18n.js, 788 lines) and the evidence ids `ev_…`, which are not in the repo.
- Legal-review items (for counsel; no conclusions drawn):
  1. Whether the automated capture of demo.odoo.com complied with that site's terms of use.
  2. The status of reproducing Odoo's technical model and field naming scheme and UI structure (trade dress), given that the SPEC explicitly mirrors Odoo Enterprise behaviour.
  3. Use of the "Odoo" name in public docs and comments (trademark).
  4. Clean-room separation when the authors are AI agents, which may have been trained on public Odoo source (hypothesis, NOT VERIFIED).
  5. Translation provenance.
  6. The missing LICENSE (LIC-001).
- Expected / Actual: Expected: a documented clean-room record (who observed, who implemented, evidence archive) and a naming policy. Actual: SPEC claims only, and the evidence is not in the repo.
- Impact: Legal uncertainty for any distribution or commercial use. It weighs on the build-vs-adopt decision (ARCH-008).
- Root cause: Verified facts; the legal significance is undetermined.
- Recommended correction: The owner obtains legal review. Archive the REA captures with the repo or a private record. Consider neutral comments, and decide on a naming policy.
- Dependencies: LIC-001, GOV-002, ARCH-008.
- Verification plan: Counsel sign-off is recorded.
- Confidence: Strongly supported (facts confirmed, significance requires legal investigation)

### MIZAN-ARCH-009 Error handling, logging, configuration and versioning are ad hoc; docs misstate the dependency footprint
- Severity: P3
- Category / Component: Operability / server/index.js, src/store.js, README.md, Dockerfile, package.json
- Evidence:
  - **Errors.** Business rules throw plain `Error(string)`. The server maps any exception to 400 with `e.message` (index.js:436-437) or 500 (index.js:538). The client shows `alert(...)` (11 `alert(` calls in src; store.js:114). There are no error codes and no i18n of errors (MIZAN-UI-008/012).
  - **Logging.** Only 6 `console.*` calls on the server. There is no request or access log, no structured or JSON logging, and no server-side change log (MIZAN-DB-007). Empty catches: 6, including index.js:64 (the DDL migration).
  - **Configuration.** 10 env vars are read ad hoc in 5 files (index.js, api.js, portal.js, integrations.js, smtp.js), and there is no central validated config. `MIZAN_TRUST_PROXY` (index.js:168-169), `MIZAN_DEMO_PAYMENTS` (api.js:25-26) and `MIZAN_PUBLIC_URL` are not documented in README or SPEC (grep count 0).
  - **Docs.** README.md:101 says "`server/index.js` — Node 24 built-ins only", and Dockerfile:1 says "no runtime dependencies". But server/integrations.js:7 imports `@anthropic-ai/sdk`, index.js:23 imports integrations, src/models/qr.js:2 imports `qrcode-generator`, and the runtime stage runs `npm ci --omit=dev` (14 production packages).
  - **Versioning.** package.json `"version": "0.1.0"` and no `engines` field, although the README targets Node 24. The suite also passes on Node 22.22.0. There are no tags, releases or CHANGELOG. The Docker base `node:24-alpine` is pinned by tag, not by digest.
- Expected / Actual: Expected: typed errors with codes, structured logs, one validated config module, accurate docs and versioned releases. Actual: as above.
- Impact: Hard to operate, debug and audit in production. Misleading documentation of the supply-chain footprint.
- Root cause: Verified.
- Recommended correction: Add an error class with code and HTTP status, a JSON logger with request ids, and `config.js` that validates env vars at boot. Fix README and Dockerfile, add `engines`, tag releases and pin the base image digest.
- Dependencies: MIZAN-SEC-005 (admin password printed to stdout, index.js:104), MIZAN-UI-008, MIZAN-DB-007, GOV-001.
- Verification plan: Doc review and a config unit test.
- Confidence: Confirmed

### MIZAN-TEST-005 Coverage numbers overstate assurance; 22% of the source is never loaded by any test
- Severity: P3
- Category / Component: Tests / coverage
- Evidence:
  - `node --test --experimental-test-coverage` works on Node 22.22.0 (exit 0). Its own "all files" line, `98.97 | 87.34 | 87.85`, includes the test files themselves.
  - With lcov aggregated by `arch-scripts/lcovsum.py`, excluding tests:
    ```
    src/models       89 files  lines 17455/17635 = 99.0%  branches 7534/8918 = 84.5%  funcs 2963/3745 = 79.1%
    server            9 files  lines 1245/1375  = 90.5%  branches 575/786  = 73.2%  funcs 225/247  = 91.1%
    src (top-level)   7 files  lines 1647/1667  = 98.8%  branches 363/407  = 89.2%  funcs 166/176  = 94.3%
    ```
  - Lowest files: server/api.js 81.4% lines (handleApi, 286-328, uncovered), smtp.js 84.3%, integrations.js 85.7%. By functions: crm.js 39.1%, more.js 48.5%, accounting.js 58.3%.
  - **Never loaded in-process:** server/index.js (spawned only by website.test.js, so uninstrumented), server/mail.js, src/store.js (client sync and error path), src/ui.jsx, App/Home/Login/Navbar/main.jsx and all 28 `src/views/*.jsx`. That is 5,857 of 26,604 source lines.
  - Line coverage is inflated by one-line button definitions (ARCH-007): a line counts as covered if any part of it ran.
- Expected / Actual: Expected: coverage reported on source only, with branch and function thresholds, including the server entry point and the client store. Actual: as above.
- Impact: The headline coverage looks near-complete while the auth and sync entry points and the whole UI are untested.
- Root cause: Verified.
- Recommended correction: Report coverage with `--test-coverage-exclude='**/*.test.js'` and enforce branch and function thresholds in CI. Refactor index.js into an importable app factory (TEST-001). Add React Testing Library or Playwright smoke tests for store.js and FormView.
- Dependencies: TEST-001, GOV-001.
- Verification plan: The coverage report lists server/index.js and src/store.js.
- Confidence: Confirmed

### MIZAN-LIC-003 Dependency licences and audit: permissive, but Apache-2.0 notices and an unbounded SDK range need handling
- Severity: P3
- Category / Component: Dependencies / package.json, package-lock.json
- Evidence:
  - **Licence scan** (`node_modules/*/package.json`): 71 installed packages, all permissive: MIT 60, ISC 5, Apache-2.0 3, BSD-3-Clause 1, Unlicense 1 (fast-sha256 1.3.0, prod, via standardwebhooks) and CC-BY-4.0 1 (caniuse-lite, dev and data only).
  - **Production tree** (lockfile, non-dev, non-optional): 14 packages, including `@anthropic-ai/sdk` 1.3.0 (Apache-2.0) and `@opentelemetry/api` 1.10.0 (Apache-2.0). The rest are react, react-dom, scheduler, qrcode-generator, json-schema-to-ts and others, all MIT.
  - **SDK range.** `"@anthropic-ai/sdk": "^1.3.0"`, so a fresh lockfile can pull any 1.x. The SDK is used in server/integrations.js:7 and :54 with the hard-coded model `'claude-opus-5-5'` (integrations.js:17). Whether 1.3.0 is current is NOT VERIFIED (no network).
  - **npm audit** (lockfile copy): 2 vulnerabilities. vite `<=6.4.3` is "high" because it aggregates 17 dev-server advisories, for example GHSA-vg6x-rcgg-rjx6 and GHSA-fx2h-pf6j-xcff (Windows). esbuild `<=0.24.2` is moderate (GHSA-67mh-4wv8-2f99). The fix is vite 5.4.21, which is blocked because vite is pinned exactly to `5.4.11`. `npm audit --omit=dev` gives `found 0 vulnerabilities`, so these affect only the dev server (`npm run dev`/`preview`) and not the built `dist` or the Node server.
- Expected / Actual: Expected: third-party notices shipped with the Docker image, dependency ranges controlled, and audit in CI. Actual: no NOTICE or third-party file, a caret range on the SDK, and no automated audit (Dependabot disabled, GOV-001).
- Impact: Low. Apache-2.0 attribution obligations apply on redistribution of the image (legal confirmation needed). Dev-server exposure applies only when a developer runs Vite on an untrusted network.
- Root cause: Verified.
- Recommended correction: Generate THIRD_PARTY_NOTICES (for example with license-checker), bump vite to 5.4.21 or later, add `npm audit --omit=dev --audit-level=high` to CI, and pin the SDK minor version.
- Dependencies: MIZAN-SEC-009 (primary for the audit advisories), LIC-001, GOV-001.
- Verification plan: The licence report is in the repo and `npm audit` is clean.
- Confidence: Confirmed

### MIZAN-GOV-003 Public exposure and secrets in history: no secrets found; notes on what the public repo reveals
- Severity: P3
- Category / Component: Governance / git history, public repo
- Evidence:
  - The requested scan `git log -p --all | grep -nE "(sk-ant|api[_-]?key|password\s*=|BEGIN (RSA|OPENSSH))"` gave 23 matches, all code identifiers: the `api_keys` table SQL, `const password = process.env.MIZAN_ADMIN_PASSWORD ?? randomBytes(9)…`, and `globalThis.prompt('Enter the page password')`. A broader scan (ghp_, github_pat_, AKIA, xox*, sk-*, AIza*, mzn_ literals, private-key headers) found 0.
  - The only sensitive-named file ever added is `.claude/launch.json`, which holds dev ports only. No `.env` or `*.sqlite` was ever committed, and .gitignore and .dockerignore exclude them.
  - GitHub secret scanning and push protection are enabled.
  - What the public repo does expose: the full source and security design, including the rate limits and the CSRF header name `X-Requested-With: mizan`, the SPEC's REA methodology, the author's personal email in every commit, and agent workflow details.
- Expected / Actual: Expected: no secrets in history. Actual: none found. Exposure of design details is inherent to a public repo; combined with the open P0s (SEC-001 and others), anyone can read the attack surface.
- Impact: Low on its own, but it raises the urgency of fixing the P0s before any internet-facing deployment.
- Root cause: Verified.
- Recommended correction: Keep push protection on. Consider a noreply commit email. Consider making the repo private until the P0s are fixed and a licence is chosen (owner decision).
- Dependencies: LIC-001, GOV-001, MIZAN-SEC-001.
- Verification plan: Re-run the scan in CI (for example gitleaks).
- Confidence: Confirmed
