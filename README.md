# Prakash Super Mart — POS & Inventory

A single-screen point-of-sale, inventory, and accounts app for **Prakash Super Mart**,
Shop No. 16, Nancy Hill View, Baner, Pune 411021. Built in React, runs fully in the
browser (Vite).

> The store name and address/locality are real (Nancy Hill View is a residential
> complex in Baner, Pune 411021). A storefront photo and phone number were **not**
> verifiably sourced, so they are intentionally omitted rather than invented.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
```

Other scripts: `npm run build`, `npm run preview`, `npm run lint`, `npm run format`.

## Login & security (read this)

The app opens to a **login screen**. On first run in a browser (no credential yet) it asks
you to **create your own password** (username defaults to `prakash`) — nothing is shipped
in the source. Change it later via **🔑 Password** in the sidebar. The password is stored
only as a salted **SHA-256 hash** (Web Crypto); the session lives in `sessionStorage`
(closing the browser signs you out), with a 5-attempt lockout. No recovery — if forgotten,
clear the site's browser data to set a new one (back up your store data first).

> **Honest limitation:** this is a **client-side device gate**, not server-grade security.
> Because everything runs in the browser with no backend, a determined person with access
> to the device and dev-tools can read the local data. For real protection, host the app
> behind a **server-side login over HTTPS** (and keep the data server-side). The gate here
> stops casual/unauthorised access on a shared shop device, which is its intended purpose.

## How data is stored

Data lives in your browser via `localStorage` (shimmed in [`src/main.jsx`](src/main.jsx)).
There is no server and no cross-device sync.

> **Back up regularly** from the sidebar — **⬇ JSON** or **⬇ XLSX**, and **⬆ Restore**
> accepts either format. A toast warns you if a save ever fails (e.g. storage full).

## Features

- **Dashboard** — pick any day to view its sales/profit; 14-day sales trend chart;
  low-stock and recent-bills panels.
- **Billing (POS)** — search or scan a barcode (Enter adds top match); best-sellers show
  first; item icons; choose payment **UPI (default) / Cash / Udhari** (credit, with
  customer name); back-date a bill; complete sale and print the receipt.
- **Data Import** — import a **txt / csv / tsv / xls / xlsx / pdf / json** file *or paste
  raw text*; columns are auto-detected; review/add/edit/delete rows; then submit as a
  **sale** or **add to inventory**. (PDF text extraction is best-effort.)
- **Inventory** — add/edit/restock items with **expiry dates**; each item is an
  expandable row showing its **batches** (quantity, expiry, date added); icons,
  optional barcode/code, MRP, low-stock alerts. Stock depletes FIFO by earliest expiry.
- **Alerts** — explicit view of low-stock items (lowest quantity first) plus batches
  expiring within 30 days or already expired; filter by status and category.
- **Barcode Creator** — generate a scannable barcode (Code 128 or EAN-13) with product
  name, MRP, packaged & expiry dates; live preview; print a tiled sheet of small
  shelf labels at true mm size; optionally save the code back to the inventory item so
  it scans at billing.
- **Sales History** — date-range filter; change a bill's date; delete a bill (restores
  stock); reprint receipts.
- **Finance** — choose a period (this/last month, last 7/30 days, this year, or a custom
  range) and see revenue/profit/expenses with charts: revenue & profit trend, expense
  breakdown (pie), revenue vs expenses, and top items by revenue.
- **Add Expense** — its own page to record and review expenses by month.
- **Activity Log** — every sale, inventory change, expense, import, and backup is logged;
  filter by day/type.

## Libraries

- **recharts** — charts.
- **xlsx (SheetJS)** — parsing csv/xls/xlsx imports and building/reading XLSX backups.
- **pdfjs-dist** — extracting text from PDF imports (lazy-loaded into its own chunk).
- **jsbarcode** — rendering Code 128 / EAN-13 barcodes for shelf labels.

## Data reset

The storage key was bumped to `psm-data-v1` for the relaunch, so on first load the app
seeds a fresh catalogue (all items at **0 stock**, including new Stationery and
Sports & Toys items like cricket bats, balls, safety guard, supporters) and **no prior
sales / expenses / logs**. Restock items to begin selling. Old data under the previous
key is ignored (and can be cleared from the browser if desired).

## Catalogue & data safety

The catalogue now includes loose staples (atta/rice/dals in 500g–1kg), dry fruits & nuts,
cosmetics (shaving, shampoo, perfume, creams), brooms (zadu), detergents, Havmor ice
creams, Haldiram/Bikaji/Lay's/Balaji/Chitale snacks, Cadbury chocolates, oils (1L pouches
and Gemini 5L/15L cans), bakery (khari/toast/rusk), and a 30L water bottle. New catalogue
items are **merged in on load without overwriting** existing stock, prices, or batches, and
the latest changes are **flushed to storage on tab close / hide** so nothing is lost.

## Notes

- Built on top of an earlier artifact; includes fixes for local-timezone dates,
  paise-rounded money, an error boundary, accessibility, and a mobile layout.
- The main bundle is large (charts + spreadsheet libs). For production you'd code-split
  these; acceptable for a local single-shop tool.
