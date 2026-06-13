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

## How data is stored

Data lives in your browser via `localStorage` (shimmed in [`src/main.jsx`](src/main.jsx)).
There is no server and no cross-device sync.

> **Back up regularly** from the sidebar — **⬇ JSON** or **⬇ XLSX**, and **⬆ Restore**
> accepts either format. A toast warns you if a save ever fails (e.g. storage full).

## Features

- **Dashboard** — pick any day to view its sales/profit; 14-day sales trend chart;
  low-stock and recent-bills panels.
- **Billing (POS)** — search or scan a barcode (Enter adds top match), live cart,
  back-date a bill, complete sale, and print the receipt.
- **Data Import** — import a **txt / csv / tsv / xls / xlsx / pdf / json** file *or paste
  raw text*; columns are auto-detected; review/add/edit/delete rows; then submit as a
  **sale** or **add to inventory**. (PDF text extraction is best-effort.)
- **Inventory** — add/edit/restock items, optional barcode/code, "Added on" dates,
  low-stock alerts.
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

## Notes

- Built on top of an earlier artifact; includes fixes for local-timezone dates,
  paise-rounded money, an error boundary, accessibility, and a mobile layout.
- The main bundle is large (charts + spreadsheet libs). For production you'd code-split
  these; acceptable for a local single-shop tool.
