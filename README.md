# Mizan ERP

An open, clean-room business suite inspired by the *behaviour* of full-featured ERPs
(apps launcher, kanban pipelines, list/form views, chatter). Written from scratch —
no third-party ERP code, assets or branding.

How the reference behaviour was observed and what was a design choice is documented in
[SPEC.md](SPEC.md).

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # ORM unit tests
npm run build
```

## Architecture

- `src/models.js` — model registry (fields, kanban/list/form definitions) and apps/menus.
  The UI is generated from it: a new app is mostly a new model entry.
- `src/orm.js` — pure, immutable ORM (create/write/unlink/search, computed fields,
  tracking messages). Unit tested in `src/orm.test.js`.
- `src/store.js` — persistence (browser `localStorage` for now) + React subscription.
- `src/ActionView.jsx`, `src/FormView.jsx` — generic views.
