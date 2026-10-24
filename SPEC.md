# Mizan ERP — clean-room spec

Behaviour observed on the public Odoo Enterprise demo (demo.odoo.com) via REA
`capture_browser_scenario`. No Odoo source, assets, icons or branding are used;
everything in `src/` is written from these observations.

Evidence: `ev_67ecdb63…` (home), `ev_5a9caa98…` (CRM kanban), `ev_f1748908…` (CRM form + list).

## Observed (O) vs design choice (D)

### Shell
- O: Home = grid of app tiles (icon + name), 6 per row, on a light dotted background.
- O: "Search for a menu..." combobox filters apps while typing.
- O: Top bar inside an app: app name, then app menus (CRM: Sales / Reporting / Configuration); right side: messages, activities, company, avatar.
- D: Only working apps are shown (CRM, Sales, Contacts, Inventory). Own icons and colours.

### Control panel
- O: `New` primary button, current action title, gear (⋮) menu.
- O: Centre search box with removable facet chips (e.g. "My Opportunities ×").
- O: Right: pager (`1-10 / 10`) and view switcher (kanban, list, calendar, pivot, graph, map, activity).
- D: Kanban + list implemented; typing + Enter adds a "Search" facet matching any text field.

### Kanban (CRM pipeline)
- O: One column per stage, header = stage name, `+` quick create, progress bar, column revenue total.
- O: Card = title, revenue, contact, coloured tags, priority stars, salesperson badge.
- O: Cards are draggable between stages (`o_draggable`).
- D: Progress bar segments by priority (no activities model yet).

### List
- O: Selection checkboxes, columns, monetary column summed in footer, row click opens form.
- D: Click header to sort; delete selected rows.

### Form
- O: Breadcrumb (`Pipeline / Record`), record pager `1 / 10` with prev/next.
- O: Header buttons (CRM: Won, Lost…) and clickable status bar of stages.
- O: Big title, two-column field groups, notebook tabs (Notes, Extra Info).
- O: Chatter on the right (Send message / Log note / Activity).
- O: Always-editable form; changes saved when leaving the record (URL `/odoo/crm/31`).
- D: Explicit save/discard shown when dirty; stage changes log a tracking message in chatter.

## Persistence
- D: Browser `localStorage` (`mizan-db-v1`). Swap `src/store.js` for an HTTP API when a backend is needed.
