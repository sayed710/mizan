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

## Phase 2 observations

Evidence: `ev_68388708…` (CRM search panel, graph, pivot, calendar), `ev_c36d3c71…` (Accounting dashboard, invoice list, invoice form).

### Search panel
- O: Dropdown with three columns: Filters (grouped, separated by rules), Group By (fields + date granularity), Favorites ("Save search").
- O: Active filters show a ✓; facets in the search box show filter / group-by chips.
- D: Filters in one group are OR-ed, groups AND-ed. Group-by is multi-level (list nests, kanban uses first level). Favorites stored in db settings.

### Graph / Pivot / Calendar
- O: Graph: measure dropdown (Count default), bar/line/pie, stacked toggle, ascending/descending sort.
- O: Pivot: "Measures" dropdown, row headers (e.g. month), column headers (stage), totals row+column, download.
- O: Calendar: month grid with week numbers, prev/next/today, mini-month + attendee filters on the side.
- D: Graph is own SVG (one value axis, hover tooltip, data-table toggle, fixed categorical palette). Pivot uses row/column selects + CSV export instead of expandable headers. Calendar has no side panel yet; "+" on a day creates a record with that date.

### Accounting
- O: Dashboard: KPI strip (Invoices, Expenses, Cash, Receivable, Payable) + journal cards.
- O: Invoice list: Number, Customer, Invoice Date, Due Date (relative, red when late), Tax Excluded, Total, Amount Due, Status badge; totals footer.
- O: Invoice form: buttons Send / Print / Credit Note / Reset to Draft, status bar Draft → Posted, "PAID" diagonal ribbon,
  smart buttons (Payments, Journal Items), lines (Product, Account, Quantity, Price, Taxes, Amount), totals block
  (Untaxed, Total, Paid on…, Amount Due), chatter with tracked changes.
- D: Single `account.move` model for customer invoices and vendor bills; posting assigns `INV/YYYY/NNNNN` or `BILL/…`; payments are a paid amount (partial supported) rather than journal entries; no chart of accounts yet.

### Cross-app flows (D)
- Quotation → Confirm (stock out) → Create Invoice → Confirm → Register Payment.
- RFQ → Confirm Order → Receive Products (stock in) → Create Bill.
- Smart buttons jump to filtered lists (`?rel=field:id`).

## Persistence
- D: Browser `localStorage` (`mizan-db-v1`). Swap `src/store.js` for an HTTP API when a backend is needed.
