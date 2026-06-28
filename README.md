# Prakash Super Mart — POS & Inventory

A single-screen point-of-sale, inventory, and accounts app for **Prakash Super Mart**,
Shop No. 16, Nancy Hill View, Baner, Pune 411021. A **React + Vite** front end backed by
**Firebase** (Authentication, Realtime Database, and Storage) — so data syncs live across
every device that signs in.

> The store name and address/locality are real (Nancy Hill View is a residential
> complex in Baner, Pune 411021). A storefront photo and phone number were **not**
> verifiably sourced, so they are intentionally omitted rather than invented.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
```

Other scripts: `npm run build`, `npm run preview`, `npm run lint`, `npm run format`,
`npm test` (Vitest), `npm run test:watch`.

## Login & security (read this)

The app opens to a **login screen** backed by **Firebase Authentication** (email/password).
Sign in with the shop account — no password is shipped in the source. "Forgot password?"
emails a reset link, and you can also send yourself one from the sidebar (**🔑 Reset**).
The session is managed by Firebase and persists until you sign out (**⎋ Logout**).

Access to the data is enforced **server-side** by Firebase security rules locked to the shop
owner's email. The Firebase config in [`src/lib/firebase.js`](src/lib/firebase.js) is
**public by design** (every client-side Firebase app ships its config); the **rules** are
what keep the data private. They are version-controlled here and must be deployed with the
owner's email filled in:

```bash
# one-time: install the CLI and sign in
npm i -g firebase-tools && firebase login

# edit OWNER_EMAIL in database.rules.json and storage.rules, then deploy:
firebase deploy --only database,storage
```

- [`database.rules.json`](database.rules.json) — Realtime Database access (owner-only).
- [`storage.rules`](storage.rules) — Storage access for vendor-bill proofs (owner-only, 10 MB cap).
- [`firebase.json`](firebase.json) — points the CLI at both rule files.

> Until these rules are deployed with a real `OWNER_EMAIL`, the database is only as safe as
> whatever rules are currently live in the Firebase console. Treat deploying them as part of
> setup, not an optional extra.

## How data is stored

Data lives in the **Firebase Realtime Database** and syncs **live across every signed-in
device**. Each record (item, sale, expense, log, vendor bill) is stored under its own keyed
node — `shop/<slice>/<id>` — so concurrent edits to different records from different devices
merge instead of clobbering each other; writes are field-level deltas, and incoming cloud
snapshots are 3-way merged with any un-pushed local edits. See
[`src/lib/sync.js`](src/lib/sync.js) (covered by [`src/lib/sync.test.js`](src/lib/sync.test.js)).

A `localStorage` cache (key `psm-cache-v1`) gives instant first paint and offline reads, and
is flushed on tab close/hide so nothing is lost between sessions. Vendor-bill **proof files**
are kept in **Firebase Storage** ([`src/lib/bills.js`](src/lib/bills.js)); only their
metadata and a download URL are stored in the database.

> **Back up regularly** from the sidebar — **⬇ JSON** or **⬇ XLSX**, and **⬆ Restore**
> accepts either format. ⚠ **Restore replaces all data and that change syncs to the cloud**,
> so it overwrites every signed-in device, not just this one. Export a fresh backup first.

## First run & catalogue

On the very first run (when the cloud has no items yet) the app seeds a fresh catalogue —
all items at **0 stock**, across categories including Stationery and Sports & Toys — and
writes it to the database. Restock items to begin selling. New catalogue items are **merged
in on load without overwriting** existing stock, prices, or batches, and legacy
array-shaped data from older versions is migrated to the keyed-by-id shape automatically.

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
- **Udhari (Credit)** — track on-credit sales, record repayments, and review a history of
  all credit transactions.
- **Vendor Bills** — record supplier purchase bills with an uploaded proof file.
- **Add Expense** — its own page to record and review expenses by month.
- **Activity Log** — every sale, inventory change, expense, import, and backup is logged;
  filter by day/type.

## Tests

```bash
npm test
```

[Vitest](https://vitest.dev) covers the two correctness-critical pure modules: the
array/map sync and 3-way merge logic ([`src/lib/sync.test.js`](src/lib/sync.test.js)) and
the tolerant import parser ([`src/lib/parse.test.js`](src/lib/parse.test.js)). The Firebase
SDK is mocked in the sync tests, so the suite never touches the network.

## Libraries

- **firebase** — Authentication, Realtime Database (live sync), and Storage.
- **recharts** — charts.
- **xlsx (SheetJS)** — parsing csv/xls/xlsx imports and building/reading XLSX backups.
  Installed from the **SheetJS CDN** (`cdn.sheetjs.com`), which carries the maintained,
  security-patched build rather than the stale npm release.
- **pdfjs-dist** — extracting text from PDF imports (lazy-loaded into its own chunk).
- **jsbarcode** — rendering Code 128 / EAN-13 barcodes for shelf labels.

## Notes

- Built on top of an earlier artifact; includes fixes for local-timezone dates,
  paise-rounded money, an error boundary, accessibility, and a mobile layout.
- The main bundle is large (charts + spreadsheet libs). Heavy vendors are split into
  separate cached chunks (see [`vite.config.js`](vite.config.js)); pdf.js is lazy-loaded
  only when a PDF is imported.
- Deployed to GitHub Pages via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
  on every push to `main`.
