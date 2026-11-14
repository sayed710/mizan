# Mizan security audit — Agent B (sec)

## Summary
The server trusts the client for all business-logic authorization. `POST /api/diff`, `/api/v1` and the
email/integration actions run every write through `applyDiff`, which enforces only (a) per-field type shape,
(b) the `allowed` model set, and (c) 56/180 model `guard`s. There is no server-side workflow, no field-level
write protection, and almost no record-level/company isolation. As a result any logged-in non-admin who can see
a model can forge posted & unbalanced invoices, mark invoices paid, create "paid" payslips, force stock transfers
"done", and delete posted entries — the browser form buttons are advisory only (MIZAN-SEC-001). `allowed_company_ids`
is a single GLOBAL, non-admin-settable setting and the server never filters records by company, so every user's
`/api/db` and `/api/v1` return every company's data, including salaries, bank accounts, passports and PINs
(MIZAN-SEC-002, and the modelsForApps over-grant owned by MIZAN-MOD-001). `removedMessages`/`seq` bypass the
`allowed` set (MIZAN-SEC-003). Lower-severity: brute-force limiter is in-process memory only and per-IP
(MIZAN-SEC-004), generated admin password printed to stdout (MIZAN-SEC-005), a user-set carrier URL is handed the
`MIZAN_SHIPPING_TOKEN` and the SSRF guard misses CGNAT/benchmark/multicast ranges and has a TOCTOU gap
(MIZAN-SEC-006), no password-change/session-revocation path (MIZAN-SEC-007), `/api/reset` silently wipes all
records (MIZAN-SEC-008), vite/esbuild dev-only advisories (MIZAN-SEC-009).

Verified safe (negative findings): blog/forum markdown is escaped (no stored XSS via renderMarkdown); public
order/cart prices are recomputed server-side (no price tampering); the `return=` redirect and `serveStatic`
path traversal are properly constrained; the WhatsApp webhook requires a valid HMAC and dedupes by message id;
API keys and session tokens are stored only as SHA-256 hashes; CSRF custom-header + JSON content-type check is
present on all cookie-authenticated state changes.

## What I verified / what I could not verify
- VERIFIED by running scripts against my copy's modules and against a live server instance (random port, temp
  MIZAN_DB): SEC-001 (both via `applyDiff` directly and end-to-end over HTTP with real non-admin sessions and an
  API key), SEC-002 (global settings rewrite + no server company filter), SEC-003, SEC-004 (memory Map), SEC-005
  (stdout), SEC-006 (stubbed fetch; token sent to attacker URL; SSRF range gaps), SEC-008 (HTTP 200 reset),
  SEC-009 (`npm audit`). Negative findings fuzzed/exercised (markdown, cart, redirect, traversal).
- NOT independently re-verified: the AI bill-digitization and SMTP paths require live network/credentials, which
  the brief forbids; I reviewed them statically only. The exact scrypt cost parameters are Node defaults (not tuned)
  — reviewed, not benchmarked.

---

### MIZAN-SEC-001 No server-side workflow or field-level authorization: any user who can see a model forges posted financial/HR/stock state
- Severity: P0
- Category / Component: Authorization / `src/sync.js` `applyDiff`, `src/orm.js`, `server/index.js` `/api/diff`, `server/api.js` `handleApi`
- Evidence:
  - `src/sync.js:56-62`: a write is accepted when `validate(model, rec) ?? models[model].guard?.(seen, before, rec, {isAdmin})` returns falsy. `validate` (orm.js:37-42) only checks required fields. `cleanRecord`/`cleanValue` (validate.js:50-66, 11-47) strip only `compute` fields — **readonly non-computed fields such as `account.move.amount_paid` are NOT stripped** (`amount_paid` is `{type:'monetary', readonly:true}`, accounting.js:254; `amount_residual` IS compute so it recomputes from the forged `amount_paid`).
  - `moveGuard` (finance.js:40-49) only blocks edits inside a locked period / audit-trail renames. It never checks debit=credit balance, never checks `state` transitions, and ignores `isAdmin`. There is no "only the Confirm button may set state=posted" check anywhere server-side.
  - Live-server PoC output (real non-admin sessions over HTTP, server started with MIZAN_DB in a temp file):
    ```
    stock-user forged posted invoice 200 INV/2026/77777 posted debit=1000000 credit=0
    /api/v1 POST posted move by non-admin 201 INV/2026/88888 posted amount_paid 123 payment_state paid
    /api/v1 PATCH posted INV/2026/00001 200 total 1 residual 1      (was 7866)
    ```
  - Module PoC (`applyDiff` with `isAdmin:false`, `allowed=modelsForApps([...])`):
    ```
    ACCEPTED 1 create posted unbalanced invoice   stored: INV/2026/99999 posted total 1000000 residual 1000000 debit 1000000 credit sum 0
    ACCEPTED 3 set amount_paid on INV/2026/00002   residual before 1210 after 0 payment_state paid
    ACCEPTED 4 delete posted BILL/2026/00001   bill still present? false
    ACCEPTED 5 force picking done with qty 10000
    ACCEPTED 6 create payslip state=paid   net_wage 250000
    ```
- Reproduction: `node /tmp/.../scratchpad/sec-scripts/poc_diff.mjs <work-sec>` and `node .../sec-scripts/http1.mjs <port>` (server started with `PORT=<rand> MIZAN_DB=<temp> MIZAN_ADMIN_PASSWORD=... node server/index.js`).
- Expected / Actual: Expected — posting, payment, payroll "paid" and stock "done" happen only through the model button logic (which balances entries, allocates sequences, posts analytics) and only for authorized roles. Actual — the client can PUT any record in any state with any readonly-field value, and delete posted documents (BILL had `amount_paid:0` so `moveDeleteGuard` did not stop it; audit_trail defaults off).
- Impact: Forged/fraudulent accounting (fake posted invoices, invoices marked paid with no payment, deleted posted entries), fabricated payslips/net pay, phantom inventory. Corrupts the books and every report derived from them. This is independent of the modelsForApps over-grant: it hits any user who legitimately has the model (e.g. an accountant can set `amount_paid` directly, an inventory user owns `account.move` via a relation).
- Root cause: verified. The business rules live in `src/models/*.js` button `run()` functions that execute in the browser; the server re-validates only shape + a sparse guard set, so it never re-derives or re-authorizes the transition. 124/180 models have no guard at all; even guarded models (account.move, hr.payslip has none) don't gate state.
- Recommended correction: Treat `state` and all `readonly`/computed-adjacent fields as server-authoritative: reject client-supplied `state` transitions and readonly fields in `cleanRecord`, require posting/payment/stock moves to go through server-run button logic, and add balance/`state`-transition guards to the financial/stock/payroll models. Gate state changes on role, not just model access.
- Dependencies: MIZAN-SEC-002, MIZAN-MOD-001 widen *who* can reach each model; this is *what* they can do once reached.
- Verification plan: After a fix, re-run both PoCs; forged posted/paid/done writes and readonly-field writes must be rejected with 400/403.
- Confidence: Confirmed

### MIZAN-SEC-002 No server-side multi-company isolation; `allowed_company_ids` is a global, client-settable setting
- Severity: P1 (cross-company data exposure — P0 category in the brief; severity held at P1 because it needs a logged-in account)
- Category / Component: Authorization / multi-company / `server/index.js` `visibleDb`, `src/orm.js` `setActiveCompany`/`inCompany`, `src/sync.js:86-93`, `src/models/company.js`
- Evidence:
  - `server/index.js` never calls `setActiveCompany` (grep in `server/` = 0 hits), so `inCompany` (orm.js:14) treats `activeCompany=null` ⇒ no filtering. `search`/`read` on the server return records of every company.
  - `visibleDb` (index.js:147-154) filters only by *model* (`allowedFor`), never by company; for an unrestricted non-admin it returns `db` unchanged (index.js:148).
  - `current_company_id` and `allowed_company_ids` are written from the client diff for **non-admins** (`sync.js:86-92`, deliberately outside the `isAdmin` block) and they are a single global `db.settings`, not per-user.
  - PoC (`sec-scripts/company.mjs`): admin seeds a company-2 lead; `applyDiff` with `isAdmin:false, allowed:null` sets global `allowed_company_ids:[2]`; the company-2 lead is present in the db returned to any user; a non-admin also moved a company-1 lead into company 2 by setting `company_id`.
    ```
    after non-admin diff, global settings: 2 [2]
    company-2 lead present in the db sent to any user: true
    non-admin moved lead 2 to company 2
    ```
- Reproduction: `node .../sec-scripts/company.mjs <work-sec>`.
- Expected / Actual: Expected — a user sees and edits only records of companies they are assigned to, enforced server-side. Actual — `GET /api/db` and `/api/v1` return all companies' records to every authenticated user; the "allowed companies" switch is a shared global any non-admin can overwrite (also a cross-tenant integrity issue: one user's switch changes every user's company scoping and server persistence).
- Impact: Any employee of one company reads/writes another company's leads, invoices, partners, HR data. For a multi-company deployment this is full cross-company data exposure and tampering.
- Root cause: verified. Company scoping is implemented only client-side (`src/companyView.js`, `inCompany`); the server never binds the active company to the session user and shares one settings object.
- Recommended correction: Derive the company scope from the session user server-side (per-user allowed companies in the `users` table, not in shared settings); make `visibleDb` and `applyDiff` filter/deny by the session's companies; reject client writes to `current_company_id`/`allowed_company_ids` as a privilege/tenant boundary.
- Dependencies: amplifies MIZAN-SEC-001 and MIZAN-MOD-001.
- Verification plan: Create two companies and a user scoped to company 1; confirm `/api/db` omits company-2 records and diffs touching company-2 records are rejected.
- Confidence: Confirmed

### MIZAN-SEC-003 `removedMessages` and `seq` bypass the per-model `allowed` set
- Severity: P1
- Category / Component: Authorization / `src/sync.js:76-85`
- Evidence:
  - `sync.js:76-78`: `for (const [model, n] of Object.entries(d.seq ?? {})) if (models[model] && Number.isInteger(n)) seq[model] = Math.max(...)` — no `check(model)`/`allowed` test.
  - `sync.js:79-85`: message removal filters incoming *new* messages by `allowed` (line 84) but `removedMessages` is filtered only by the `kept`/audited set (line 81), never by `allowed`.
  - PoC (contacts-only non-admin): `ACCEPTED 9 contacts user removes 13 messages of non-allowed models` (removed chatter of uom.category, res.currency, stock.warehouse, stock.location…); `ACCEPTED 10 contacts user bumps seq of sale.order` to `Number.MAX_SAFE_INTEGER`.
- Reproduction: `sec-scripts/poc_diff.mjs`, cases 9 and 10.
- Expected / Actual: Expected — a user restricted to some models cannot touch chatter or id sequences of other models. Actual — a non-admin deletes audit/chatter messages for models they have no access to, and can exhaust/scramble any model's id sequence (bumping `seq` near MAX_SAFE_INTEGER breaks future id allocation and uniqueness: `nextId` would return non-integer / colliding ids).
- Impact: Destruction of audit-trail/chatter for arbitrary models (except models whose `audited(db)` keeps messages); denial of service / id collisions on any model's sequence.
- Root cause: verified. `check(model)` is applied to upserts/deletes but not to `seq` or `removedMessages`.
- Recommended correction: Run `check(model)` for every `seq` key and resolve each removed message's model and require `allowed.has(model)` before removal.
- Dependencies: none.
- Verification plan: Re-run cases 9/10; both must throw `No access to ...`.
- Confidence: Confirmed

### MIZAN-SEC-004 Brute-force / rate limiting is in-process memory only and keyed per client IP
- Severity: P2
- Category / Component: Auth hardening / `server/index.js:158-169`
- Evidence: `const failures = new Map()` (index.js:158); `tooMany`/`recordFailure` operate on it (165-166); login key is `login:${ip}:${login}` (index.js:375). `clientIp` trusts `x-forwarded-for` only when `MIZAN_TRUST_PROXY=1` (169), otherwise uses the socket address.
- Expected / Actual: Expected — limits survive restarts and apply across workers. Actual — any process restart (or a second instance / horizontal scale) resets all counters; the limiter never shares state. Also, because the key includes the IP, an attacker rotating source IPs (or behind a shared NAT victim) is barely constrained, and legitimately clustered users share a bucket.
- Impact: Weak protection against online password guessing, API-key guessing, order-token/livechat-token guessing (all use the same `failures` map), and trivial bypass by restart timing or IP rotation. Memory also grows under distributed attack until the 15-min sweep.
- Root cause: verified (design choice; comment at index.js:157 says "memory").
- Recommended correction: Persist attempt counters (e.g. the existing SQLite) with an account-wide lockout/backoff in addition to per-IP, and document the reverse-proxy requirement for correct client attribution.
- Dependencies: none.
- Verification plan: Restart server mid-lockout; confirm the lockout persists.
- Confidence: Confirmed

### MIZAN-SEC-005 Generated admin password printed to stdout/logs on first start
- Severity: P2
- Category / Component: Secrets / `server/index.js:102-104`
- Evidence: `const password = process.env.MIZAN_ADMIN_PASSWORD ?? randomBytes(9).toString('base64url'); ... console.info(\`Created user "admin". Password: ${process.env.MIZAN_ADMIN_PASSWORD ? '(from MIZAN_ADMIN_PASSWORD)' : password}\`)`. Live run log confirms the branch; when the env var is absent the plaintext password is logged.
- Expected / Actual: Expected — the initial credential is delivered out-of-band, never written to logs. Actual — on any deploy that does not set `MIZAN_ADMIN_PASSWORD`, the admin password lands in container/stdout logs (often shipped to a log aggregator readable by many).
- Impact: Admin credential disclosure to anyone with log access.
- Root cause: verified.
- Recommended correction: Print only "generated a random admin password; reset it on first login" and force a password change, or require `MIZAN_ADMIN_PASSWORD`. (Note: there is currently no password-change endpoint — see SEC-007.)
- Dependencies: SEC-007.
- Verification plan: Start without the env var; confirm no plaintext password in logs.
- Confidence: Confirmed

### MIZAN-SEC-006 Outbound integrations: `MIZAN_SHIPPING_TOKEN` sent to a non-admin-set URL; SSRF guard misses ranges and has a DNS-rebinding/TOCTOU gap
- Severity: P2
- Category / Component: SSRF / secret egress / `server/integrations.js:27-46, 239-273`
- Evidence:
  - `quoteShipping` (integrations.js:239-258) POSTs to `carrier.api_url` with header `Authorization: Bearer ${env.MIZAN_SHIPPING_TOKEN}`. `delivery.carrier` is writable by sales/inventory users (`modelsForApps(['sales']).has('delivery.carrier') === true`). PoC (stubbed fetch, no network):
    ```
    non-admin set carrier api_url -> https://203.0.113.10/rates
    outbound request captured: {"url":"https://203.0.113.10/rates","auth":"Bearer sk_live_SECRET123"}
    ```
    So a non-admin who controls a carrier's Rate URL receives the shipping provider's bearer token. (The `/api/integrations/shipping-rate` action is not marked `admin:true`.)
  - `assertPublicUrl` (27-39) blocks RFC1918/loopback/link-local but PoC shows it ALLOWS `198.18.0.1` (benchmark), `224.0.0.1` (multicast) and `255.255.255.255` (broadcast); it also resolves the hostname once with `dns.lookup` then `fetch`es the hostname again (`redirect:'error'` helps but the name is re-resolved), i.e. a DNS-rebinding/TOCTOU window.
  - `syncMarketplace` (266-271) and `digitizeBill` similarly fetch user-controlled URLs; marketplace is `admin:true`, shipping is not.
- Reproduction: `node .../sec-scripts/ship.mjs <work-sec>`.
- Expected / Actual: Expected — integration secrets go only to operator-vetted endpoints and the SSRF guard covers all non-public ranges and resolves-then-connects to the same pinned IP. Actual — a low-privilege user exfiltrates `MIZAN_SHIPPING_TOKEN`; the guard has range gaps and a rebinding window.
- Impact: Theft of the shipping API credential by a non-admin; limited SSRF to odd address ranges / via rebinding.
- Root cause: verified.
- Recommended correction: Make carrier/connector URL changes admin-only (or don't attach the shared secret to user-chosen URLs — use per-carrier stored credentials); connect to the resolved, validated IP (pin it) and extend the private-range list to carrier-grade NAT (100.64/10), 198.18/15, 224/4, 240/4 and 255.255.255.255.
- Dependencies: relates to SEC-001 (who can edit delivery.carrier).
- Verification plan: Re-run ship.mjs after fix: non-admin cannot set api_url / token not sent; the extra ranges BLOCK.
- Confidence: Confirmed (token egress & range gaps); rebinding window Strongly supported (static).

### MIZAN-SEC-007 No password-change and no session/API-key revocation path for a user's own or others' sessions
- Severity: P2
- Category / Component: Session management / `server/index.js` (routes), SQL `sessions`
- Evidence: Routes present are `/api/login`, `/api/logout` (deletes only the current token, index.js:427-429), `/api/keys` (GET/POST/DELETE own keys), `/api/users` (admin GET/POST only — no update/delete/password reset). There is no endpoint to change a password or to invalidate all sessions of a user; `createUser` is the only password-setting path. Sessions are fixed 14-day, not rotated on login (index.js:379-381).
- Expected / Actual: Expected — users can rotate credentials and admins can revoke a compromised account's sessions. Actual — a leaked session token is valid for up to 14 days with no server-side revocation (short of deleting the user row manually); users cannot change their own password at all.
- Impact: Compromised sessions/credentials cannot be contained operationally; forces manual DB surgery.
- Root cause: verified (feature absent).
- Recommended correction: Add authenticated password-change (re-hash, delete that user's sessions), an admin "reset password / log out everywhere" action, and consider session rotation on privilege-affecting changes.
- Dependencies: SEC-005.
- Verification plan: Confirm new endpoints exist and that changing a password drops existing sessions.
- Confidence: Confirmed

### MIZAN-SEC-008 `/api/reset` silently wipes all business records (no confirmation, no backup)
- Severity: P2
- Category / Component: Data loss / `server/index.js:441-444`
- Evidence: `if (path === '/api/reset' && req.method === 'POST') { if (!user.isAdmin) return 403; commitDb(seed(), { full: true }); return send(res, 200, db); }`. Live run: `reset by admin: 200`. `commitDb(seed(), {full:true})` → `storage.save(null, next)` → `writeAll` which `clearRecords`/`clearMessages` and reseeds. Users/sessions/api_keys live in separate SQL tables and are NOT wiped (that part is fine).
- Expected / Actual: Expected — a destructive, irreversible reset requires explicit confirmation and ideally a backup/export; ideally it is disabled in production. Actual — one admin POST (CSRF-header-guarded but otherwise unconfirmed) replaces the entire record/message store with demo seed data.
- Impact: One compromised admin session, one accidental call, or a malicious admin destroys all accounting/CRM/inventory data instantly; overwrites with fake demo records.
- Root cause: verified.
- Recommended correction: Gate behind an explicit confirmation token and `NODE_ENV!=='production'` (or a separate dangerous-ops flag); snapshot the DB first.
- Dependencies: none.
- Verification plan: Confirm reset refuses in production / without confirmation.
- Confidence: Confirmed

### MIZAN-SEC-009 Dependency advisories (dev-time only) and dependency surface
- Severity: P3
- Category / Component: Supply chain / `npm audit`
- Evidence: `npm audit` in my copy: `{"moderate":1,"high":1,"total":2}` — `vite` (high, `<=6.4.3`, dev-server request/`?raw` fs.deny bypass, GHSA-vg6x-rcgg-rjx6) and transitive `esbuild` (moderate, GHSA-67mh-4wv8-2f99). Both are `devDependencies` (vite, @vitejs/plugin-react) and the Dockerfile runs `npm ci --omit=dev` for the runtime image, so they are **not shipped to production**; they only affect `npm run dev` on developer machines. Runtime deps (`npm ls --omit=dev`): `@anthropic-ai/sdk@1.3.0`, `qrcode-generator@1.4.4`, `react`/`react-dom@18.3.1` — no advisories. Note `@anthropic-ai/sdk` has an UNMET OPTIONAL `zod` peer (harmless unless schema features used).
- Expected / Actual: Expected — no known-vuln deps. Actual — the only advisories are dev-only and fixed by `vite@5.4.21` (non-major).
- Impact: Dev-server exposure if a developer runs `vite dev` on an untrusted network. No production impact.
- Root cause: verified.
- Recommended correction: `npm audit fix` to pull `vite@5.4.21`; keep dev servers off untrusted networks.
- Dependencies: none.
- Verification plan: `npm audit` clean after bump.
- Confidence: Confirmed

---

## Negative findings (verified safe — do not re-report as issues)
- Stored XSS via blog/forum content: `renderMarkdown` (src/models/blog.js) escapes all input first, allows only a fixed tag set, and restricts link URLs to http(s)/mailto. Fuzzing (`sec-scripts/md.mjs`) could not inject a tag or `javascript:`/`"onclick` attribute. `Blog.jsx` `dangerouslySetInnerHTML` consumes only this server-escaped HTML. Website page `Content` (PublicSite.jsx:135) renders blocks as React text nodes (no raw HTML). Portal (`server/portal.js`) escapes every interpolation.
- Public order/cart price tampering: `cartLines` (api.js) reads only `product_id` and `qty`; all prices come from `cartTotals` server-side. Client `price_unit` is ignored.
- Open redirect (`return=` on `/`): `server/index.js:478` requires a single leading `/` (`/^\/(?!\/)/`) and rejects control chars/backslash; `//evil.com`, `/\evil.com`, `https://evil.com` all stayed on-origin in live tests (`%2f%2f` is not decoded by browsers in `Location`). Portal/password-form actions are escaped.
- Path traversal in `serveStatic`: `normalize(join(DIST,path))` + `startsWith(DIST+sep)` check; `/../package.json` falls back to index.html, `..%2f..%2f` → 403. No file escape observed.
- WhatsApp webhook: HMAC-SHA256 signature required (`checkSignature`), verify-token compared constant-time, messages deduped by `wa_message_id`, status updates monotonic — replay/forgery resistant (disabled safely when `MIZAN_WHATSAPP_APP_SECRET` unset).
- CSRF: cookie-authenticated state changes require `x-requested-with: mizan` AND `application/json` (index.js:370-372) plus per-route header checks; portal POSTs add same-origin + form-encoding checks. `/api/v1` is Bearer-only (no cookies).
- Credential storage: passwords scrypt(salt,64) with per-user salt; session tokens and API keys stored only as SHA-256 hashes; `timingSafeEqual` used for password, page, portal, livechat and order tokens.
