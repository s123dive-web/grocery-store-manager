// Daily-Need-Bills — day-to-day vendor bills for daily-need purchases.
//
// This slice (shop/dailyBills) is the SINGLE SOURCE OF TRUTH for daily-need data; it carries
// a few fields the Vendor Bills slice doesn't (paymentMethod, billNumber, notes). Every entry
// is MIRRORED into the existing `vendorBills` slice so both views stay in sync without a second
// hand-entry. The mirror reuses the SAME id (deterministic 1:1 link) and is stamped
// source: "daily-need" so it's traceable and never duplicated.
//
// All functions here are PURE (no Firebase, no Date.now) so they unit-test cleanly; the React
// layer supplies ids/timestamps and pushes both slices through the normal sync.js pipeline.

// Round money to 2dp, mirroring the app's `money()` helper (kept local so this module is pure).
export const dailyMoney = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round((v + Number.EPSILON) * 100) / 100 : 0;
};

export const PAYMENT_METHODS = ["Cash", "UPI", "Bank Transfer", "Credit", "Cheque"];
export const PAYMENT_STATUS = ["Paid", "Pending", "Partial"];
export const DAILY_CATEGORIES = ["Dairy", "Vegetables", "Groceries", "Packaging", "Other"];

// A daily-need purchase is always a stock purchase from the Vendor-Bills taxonomy's point of
// view; Packaging is the one category both taxonomies share, so it maps straight across.
export const DAILY_TO_BILL_CATEGORY = {
  Packaging: "Packaging",
  Dairy: "Stock purchase",
  Vegetables: "Stock purchase",
  Groceries: "Stock purchase",
  Other: "Stock purchase",
};

// paymentStatus (Paid|Pending|Partial) → vendorBills status (paid|partial|unpaid).
export const DAILY_TO_BILL_STATUS = { Paid: "paid", Pending: "unpaid", Partial: "partial" };
// …and back, for propagating a Vendor-Bills-side status edit onto the daily record.
export const BILL_TO_DAILY_STATUS = { paid: "Paid", unpaid: "Pending", partial: "Partial" };

// Blank form defaults. `date`/`today` are injected so this stays pure & testable.
export const blankDailyBill = (today = "") => ({
  vendorName: "",
  billAmount: "",
  paymentMethod: PAYMENT_METHODS[0],
  paymentStatus: PAYMENT_STATUS[0],
  paidAmount: "",
  date: today,
  category: "Groceries",
  billNumber: "",
  notes: "",
});

// Validate a form. Returns an error string, or "" when valid.
export function validateDailyBill(form) {
  if (!String(form.vendorName || "").trim()) return "Vendor name is required.";
  if (!(Number(form.billAmount) > 0)) return "Enter a bill amount greater than 0.";
  if (!PAYMENT_METHODS.includes(form.paymentMethod)) return "Pick a valid payment method.";
  if (!PAYMENT_STATUS.includes(form.paymentStatus)) return "Pick a valid payment status.";
  if (form.paymentStatus === "Partial") {
    const paid = Number(form.paidAmount);
    if (!(paid > 0)) return "Enter how much has been paid so far.";
    if (paid >= Number(form.billAmount)) return "Paid-so-far must be less than the bill amount for a partial bill.";
  }
  return "";
}

// How much is still owed on a daily bill (paid → 0, partial → amount − paid, pending → full).
export function dailyOutstanding(b) {
  const amt = Number(b.billAmount) || 0;
  if (b.paymentStatus === "Paid") return 0;
  if (b.paymentStatus === "Partial") return Math.max(0, amt - (Number(b.paidAmount) || 0));
  return amt;
}

// Build a clean daily-bill record from a form. `id`/`now` are injected by the caller.
// `existing` (on edit) preserves createdAt.
export function makeDailyBill(form, { id, now, existing } = {}) {
  const amount = dailyMoney(form.billAmount);
  const status = form.paymentStatus;
  return {
    id,
    vendorName: String(form.vendorName || "").trim(),
    billAmount: amount,
    paymentMethod: form.paymentMethod,
    paymentStatus: status,
    // paidAmount is only meaningful for a partial bill; paid → full, pending → 0.
    paidAmount: status === "Partial" ? dailyMoney(form.paidAmount || 0) : status === "Paid" ? amount : 0,
    date: form.date,
    category: form.category || "Other",
    billNumber: String(form.billNumber || "").trim(),
    notes: String(form.notes || "").trim(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    source: "daily-need",
  };
}

// Map a daily-need record → its mirrored vendorBills record (SAME id, marked & back-linked).
// The extra daily-only fields ride along so a backup/export never loses them.
export function dailyToVendorBill(d) {
  return {
    id: d.id,
    vendor: d.vendorName,
    date: d.date,
    amount: dailyMoney(d.billAmount),
    category: DAILY_TO_BILL_CATEGORY[d.category] || "Stock purchase",
    status: DAILY_TO_BILL_STATUS[d.paymentStatus] || "unpaid",
    paidAmount: Number(d.paidAmount) || 0,
    dueDate: "",
    // Traceability + the daily-only extras (Vendor Bills won't show them, but they survive).
    source: "daily-need",
    sourceId: d.id,
    paymentMethod: d.paymentMethod,
    billNumber: d.billNumber || "",
    notes: d.notes || "",
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

// Upsert a mirror into a vendorBills array (replace the row with the same id, else append).
export function upsertMirror(bills, mirror) {
  const i = bills.findIndex((b) => b.id === mirror.id);
  if (i === -1) return [...bills, mirror];
  const next = bills.slice();
  next[i] = { ...bills[i], ...mirror };
  return next;
}

// Propagate a Vendor-Bills-side edit of a synced row back onto its daily record, so editing
// from either side stays consistent. Only the cleanly-reversible fields are carried back;
// category is left alone (the daily taxonomy is finer-grained than the bill taxonomy).
export function applyVendorEditToDaily(daily, vb, now) {
  return {
    ...daily,
    vendorName: vb.vendor ?? daily.vendorName,
    date: vb.date ?? daily.date,
    billAmount: dailyMoney(vb.amount),
    paymentStatus: BILL_TO_DAILY_STATUS[vb.status] || daily.paymentStatus,
    paidAmount: Number(vb.paidAmount) || 0,
    updatedAt: now,
  };
}
