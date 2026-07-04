import { describe, it, expect } from "vitest";
import {
  validateDailyBill, dailyOutstanding, makeDailyBill, dailyToVendorBill,
  upsertMirror, applyVendorEditToDaily, blankDailyBill, itemsForCategory,
  DAILY_CATEGORIES, DAILY_ITEMS, DAILY_TO_BILL_CATEGORY, DAILY_TO_BILL_STATUS,
} from "./dailyBills.js";

const goodForm = {
  vendorName: "  Amul Dairy  ",
  billAmount: "1250.5",
  paymentMethod: "UPI",
  paymentStatus: "Paid",
  paidAmount: "",
  date: "2026-07-04",
  category: "Dairy",
  billNumber: "INV-9",
  notes: "morning delivery",
};

describe("validateDailyBill", () => {
  it("passes a well-formed bill", () => {
    expect(validateDailyBill(goodForm)).toBe("");
  });
  it("requires a vendor name", () => {
    expect(validateDailyBill({ ...goodForm, vendorName: "   " })).toMatch(/vendor/i);
  });
  it("requires a positive amount", () => {
    expect(validateDailyBill({ ...goodForm, billAmount: "0" })).toMatch(/greater than 0/i);
    expect(validateDailyBill({ ...goodForm, billAmount: "-5" })).toMatch(/greater than 0/i);
  });
  it("rejects an unknown payment method / status", () => {
    expect(validateDailyBill({ ...goodForm, paymentMethod: "Bitcoin" })).toMatch(/method/i);
    expect(validateDailyBill({ ...goodForm, paymentStatus: "Later" })).toMatch(/status/i);
  });
  it("requires a sane paid-so-far for partial bills", () => {
    expect(validateDailyBill({ ...goodForm, paymentStatus: "Partial", paidAmount: "" })).toMatch(/paid/i);
    expect(validateDailyBill({ ...goodForm, paymentStatus: "Partial", paidAmount: "2000" })).toMatch(/less than/i);
    expect(validateDailyBill({ ...goodForm, paymentStatus: "Partial", paidAmount: "500" })).toBe("");
  });
});

describe("dailyOutstanding", () => {
  it("is 0 when paid", () => {
    expect(dailyOutstanding({ billAmount: 1000, paymentStatus: "Paid" })).toBe(0);
  });
  it("is the full amount when pending", () => {
    expect(dailyOutstanding({ billAmount: 1000, paymentStatus: "Pending" })).toBe(1000);
  });
  it("is amount − paid when partial (never negative)", () => {
    expect(dailyOutstanding({ billAmount: 1000, paymentStatus: "Partial", paidAmount: 400 })).toBe(600);
    expect(dailyOutstanding({ billAmount: 1000, paymentStatus: "Partial", paidAmount: 5000 })).toBe(0);
  });
});

describe("makeDailyBill", () => {
  it("trims, rounds, stamps and marks the record", () => {
    const rec = makeDailyBill(goodForm, { id: "abc", now: 111 });
    expect(rec).toMatchObject({
      id: "abc", vendorName: "Amul Dairy", billAmount: 1250.5, paymentMethod: "UPI",
      paymentStatus: "Paid", paidAmount: 1250.5, billNumber: "INV-9", notes: "morning delivery",
      createdAt: 111, updatedAt: 111, source: "daily-need",
    });
  });
  it("keeps paidAmount only for partial, 0 for pending", () => {
    expect(makeDailyBill({ ...goodForm, paymentStatus: "Pending" }, { id: "a", now: 1 }).paidAmount).toBe(0);
    expect(makeDailyBill({ ...goodForm, paymentStatus: "Partial", paidAmount: "300" }, { id: "a", now: 1 }).paidAmount).toBe(300);
  });
  it("preserves createdAt on edit", () => {
    const rec = makeDailyBill(goodForm, { id: "a", now: 222, existing: { createdAt: 99 } });
    expect(rec.createdAt).toBe(99);
    expect(rec.updatedAt).toBe(222);
  });
});

describe("dailyToVendorBill (mirror mapping)", () => {
  const d = makeDailyBill(goodForm, { id: "abc", now: 111 });
  const vb = dailyToVendorBill(d);
  it("shares the id and back-links + marks the source", () => {
    expect(vb.id).toBe("abc");
    expect(vb.sourceId).toBe("abc");
    expect(vb.source).toBe("daily-need");
  });
  it("maps daily fields onto the vendorBills schema", () => {
    expect(vb.vendor).toBe("Amul Dairy");
    expect(vb.amount).toBe(1250.5);
    expect(vb.category).toBe(DAILY_TO_BILL_CATEGORY.Dairy);
    expect(vb.status).toBe(DAILY_TO_BILL_STATUS.Paid);
  });
  it("carries the daily-only extras so a backup never loses them", () => {
    expect(vb.paymentMethod).toBe("UPI");
    expect(vb.billNumber).toBe("INV-9");
    expect(vb.notes).toBe("morning delivery");
  });
  it("maps Packaging straight across but everything else to Stock purchase", () => {
    expect(dailyToVendorBill({ ...d, category: "Packaging" }).category).toBe("Packaging");
    expect(dailyToVendorBill({ ...d, category: "Vegetables" }).category).toBe("Stock purchase");
    expect(dailyToVendorBill({ ...d, category: "Groceries" }).category).toBe("Stock purchase");
  });
});

describe("upsertMirror", () => {
  it("appends a brand-new mirror", () => {
    const out = upsertMirror([{ id: "x" }], { id: "y", vendor: "V" });
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ id: "y", vendor: "V" });
  });
  it("replaces the row with the same id in place (no duplication)", () => {
    const out = upsertMirror([{ id: "x", vendor: "old" }, { id: "y" }], { id: "x", vendor: "new" });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: "x", vendor: "new" });
  });
});

describe("applyVendorEditToDaily (edit from the Vendor Bills side)", () => {
  const daily = makeDailyBill(goodForm, { id: "abc", now: 111 });
  it("carries reversible fields back and re-stamps updatedAt, leaving category alone", () => {
    const edited = applyVendorEditToDaily(daily, { vendor: "Reliance", date: "2026-07-05", amount: 900, status: "partial", paidAmount: 200 }, 333);
    expect(edited).toMatchObject({
      vendorName: "Reliance", date: "2026-07-05", billAmount: 900,
      paymentStatus: "Partial", paidAmount: 200, updatedAt: 333, category: "Dairy",
    });
    // untouched daily-only fields survive
    expect(edited.paymentMethod).toBe("UPI");
    expect(edited.billNumber).toBe("INV-9");
  });
});

describe("DAILY_CATEGORIES", () => {
  it("keeps the three new categories at the top of the list", () => {
    expect(DAILY_CATEGORIES.slice(0, 3)).toEqual(["Water-Bottles", "Dairy-Milk-Dahi", "Bakery-BreadnAll"]);
  });
  it("mirrors the new categories to a valid Vendor-Bills category", () => {
    for (const c of ["Water-Bottles", "Dairy-Milk-Dahi", "Bakery-BreadnAll"]) {
      const vb = dailyToVendorBill(makeDailyBill({ ...goodForm, category: c }, { id: "a", now: 1 }));
      expect(vb.category).toBe("Stock purchase");
    }
  });
});

describe("blankDailyBill", () => {
  it("seeds today's date, first category, and empty item/qty", () => {
    expect(blankDailyBill("2026-07-04")).toMatchObject({
      vendorName: "", billAmount: "", paymentMethod: "Cash", paymentStatus: "Paid",
      date: "2026-07-04", category: DAILY_CATEGORIES[0], itemName: "", qty: "",
    });
  });
});

describe("itemsForCategory", () => {
  it("returns the seeded items for a category", () => {
    expect(itemsForCategory("Water-Bottles")).toEqual(["Water Bootle - 20ltr"]);
    expect(itemsForCategory("Dairy-Milk-Dahi")).toContain("Amul Milk - 0.5ltr");
    expect(itemsForCategory("Dairy-Milk-Dahi")).toContain("Chitale Dahi - 400gm");
    expect(itemsForCategory("Dairy-Milk-Dahi").length).toBe(5);
  });
  it("returns an empty array for a category with no seeded items", () => {
    expect(itemsForCategory("Groceries")).toEqual([]);
    expect(itemsForCategory("nope")).toEqual([]);
  });
  it("every seeded item belongs to a real category", () => {
    for (const cat of Object.keys(DAILY_ITEMS)) expect(DAILY_CATEGORIES).toContain(cat);
  });
});

describe("makeDailyBill item & qty", () => {
  it("captures a trimmed item name and a positive numeric qty", () => {
    const rec = makeDailyBill({ ...goodForm, itemName: "  Amul Milk - 0.5ltr  ", qty: "3" }, { id: "a", now: 1 });
    expect(rec.itemName).toBe("Amul Milk - 0.5ltr");
    expect(rec.qty).toBe(3);
  });
  it("normalises a blank/invalid/zero qty to 0", () => {
    expect(makeDailyBill({ ...goodForm, qty: "" }, { id: "a", now: 1 }).qty).toBe(0);
    expect(makeDailyBill({ ...goodForm, qty: "0" }, { id: "a", now: 1 }).qty).toBe(0);
    expect(makeDailyBill({ ...goodForm, qty: "abc" }, { id: "a", now: 1 }).qty).toBe(0);
  });
  it("carries item & qty onto the vendorBills mirror (for backup preservation)", () => {
    const rec = makeDailyBill({ ...goodForm, itemName: "Taak - 500ml", qty: "2" }, { id: "a", now: 1 });
    const vb = dailyToVendorBill(rec);
    expect(vb.itemName).toBe("Taak - 500ml");
    expect(vb.qty).toBe(2);
  });
});
