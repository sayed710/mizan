# Mizan ERP

An open, clean-room business suite inspired by the *behaviour* of full-featured ERPs — app launcher,
kanban pipelines, list/form/graph/pivot/calendar views, search panel, chatter. Written from scratch:
no third-party ERP code, assets or branding. English and Arabic (RTL).

How the reference behaviour was observed (REA browser captures) and what was a design choice is documented
in [SPEC.md](SPEC.md).

## Apps

CRM · Sales · Invoicing · Purchase · Inventory · Contacts · Calendar · Project · Helpdesk · Employees · Settings

Cross-app flows: quotation → sales order (stock out) → invoice → payment; RFQ → purchase order → receipt (stock in) → vendor bill.

## Run

```bash
npm install
npm run build
npm start          # server + app on http://localhost:8069 (login required)
```

On first start the server creates user `admin` and prints a random password
(or set `MIZAN_ADMIN_PASSWORD`). Admins add users in **Settings**.

Environment: `PORT` (8069), `MIZAN_DB` (SQLite file, default `mizan.sqlite`),
`MIZAN_SECURE_COOKIE=1` when served over HTTPS.

Development: `npm start` in one terminal and `npm run dev` in another — Vite proxies `/api` to the server.
Without a server the frontend runs as a browser-only demo (data in `localStorage`).

```bash
npm test           # ORM, business-flow and sync tests
```

## Architecture

- `src/models/` — model registry (fields, filters, group-bys, view definitions, buttons) and app menus.
  The UI is generated from it: a new app is mostly a new model entry.
- `src/orm.js` — pure, immutable ORM (create/write/unlink/search, computed fields, tracking messages, grouping).
- `src/sync.js` — record-level diff/apply, so concurrent edits to different records merge on the server;
  the server validates and strips every incoming record.
- `server/index.js` — Node 24 built-ins only (`node:http`, `node:sqlite`, `node:crypto`): scrypt passwords,
  HttpOnly session cookies, CSRF header check, login rate limiting, static hosting.
- `src/views/` — generic Kanban, List, Graph, Pivot, Calendar, Form, plus Dashboard and Settings pages.
