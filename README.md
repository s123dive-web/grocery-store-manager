# Dukaan Manager — Grocery POS & Inventory

A single-screen point-of-sale and inventory app for a small Indian grocery (kirana)
store, built in React. Originally a Claude artifact (`grocery-store-manager.jsx`); this
repo wraps it in a runnable Vite project.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
```

Other scripts:

```bash
npm run build    # production build to dist/
npm run preview  # serve the production build
npm run lint     # ESLint
npm run format   # Prettier (writes)
```

## How data is stored

The original artifact expected a sandbox `window.storage` API. In this project,
[`src/main.jsx`](src/main.jsx) shims that with **`localStorage`**, so all data lives
**in your browser on this device only**. There is no server and no cross-device sync.

> **Back up regularly.** Clearing browser data wipes everything. Use the
> **⬇ Backup** button in the sidebar to download a JSON file, and **⬆ Restore** to
> load it back (on this or another device). A toast warns you if a save ever fails
> (e.g. storage full).

## Features

- **Dashboard** — today's sales/profit, month revenue, stock value, low-stock + recent bills.
- **Billing (POS)** — search or **scan a barcode** (type/scan then press **Enter** to add
  the top match), live cart, complete sale, and **🖨 print the last bill**.
- **Inventory** — add/edit/restock items, optional **barcode/code** per item, low-stock alerts.
- **Sales History** — bills grouped by day; expand any bill and **reprint** its receipt.
- **Finance** — monthly revenue/profit/expenses, last-7-days chart, expense log.
- **Scan Photo** — ⚠️ **does not work in this setup** (see below).

## ⚠️ The "Scan Photo" tab needs a backend

That feature calls `https://api.anthropic.com/v1/messages` directly from the browser.
That cannot work client-side: there is no API key and the browser blocks the call (CORS),
and **an API key must never be shipped in browser code**. To enable it, add a small
server proxy that holds the key and forwards requests, then point the `fetch` in
[`src/grocery-store-manager.jsx`](src/grocery-store-manager.jsx) at that proxy. The tab
shows a banner explaining this; everything else works fully offline.

## Notes on robustness

This project includes fixes layered on top of the original artifact:

- Local-timezone dates (sales no longer mis-file under the previous day in early hours).
- Currency math rounded to paise to avoid floating-point drift.
- Backup / restore + a visible warning when a save fails.
- Duplicate rows in photo-scan results are aggregated, not clobbered.
- An error boundary so a render crash shows a recoverable screen, not a blank page.
- Barcode/keyboard billing, printable receipts, `min=0` inputs, and a mobile layout.
- Accessibility: aria-labels on icon buttons and Esc-to-close dialogs.
