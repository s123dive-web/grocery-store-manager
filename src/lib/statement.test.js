import { describe, it, expect } from "vitest";
import {
  buildStatement, udhariCustomers, billPayments, billDue, custKey,
  statementBillRef, periodLabel,
} from "./statement.js";

// A small credit book: Ramesh owes across three months (one bill is fully settled,
// so it must never appear), Sita has a legacy bill with no payments ledger, and one
// walk-in was billed without a name.
const sale = (o) => ({ payment: "Udhari", lines: [], ...o });
const SALES = [
  sale({ id: "aaa111", date: "2026-06-10", time: "10:30 am", customer: "Ramesh", mobile: "9876500001", total: 500, paid: 500,
         payments: [{ id: "p1", date: "2026-06-20", time: "05:00 pm", amount: 500, mode: "Cash" }] }),      // settled -> excluded
  sale({ id: "bbb222", date: "2026-07-04", time: "06:15 pm", customer: "Ramesh", total: 1200, paid: 200,
         payments: [{ id: "p2", date: "2026-07-30", time: "11:00 am", amount: 200, mode: "UPI" }],
         lines: [{ name: "Rice", qty: 5, unit: "kg", price: 60, amount: 300 }, { name: "Oil", qty: 2, unit: "L", price: 450, amount: 900 }] }),
  sale({ id: "ccc333", date: "2026-08-12", time: "09:05 am", customer: " Ramesh ", mobile: "9876500001", total: 800, paid: 0,
         subtotal: 850, discount: 50, discountPct: 6 }),
  sale({ id: "ddd444", date: "2026-08-20", time: "07:45 pm", customer: "Sita", total: 300, paid: 100, paidMode: "Cash" }), // legacy: no ledger
  sale({ id: "eee555", date: "2026-08-21", time: "", customer: "", total: 150, paid: 0 }),                  // walk-in, no name
  { id: "fff666", date: "2026-08-22", time: "01:00 pm", customer: "Ramesh", payment: "Cash", total: 400, lines: [] }, // not credit
];

describe("custKey / billDue / statementBillRef", () => {
  it("trims the name and buckets unnamed customers", () => {
    expect(custKey({ customer: " Ramesh " })).toBe("Ramesh");
    expect(custKey({ customer: "   " })).toBe("(no name)");
    expect(custKey({})).toBe("(no name)");
  });
  it("never reports a negative due", () => {
    expect(billDue({ total: 100, paid: 250 })).toBe(0);
    expect(billDue({ total: 100, paid: 25.005 })).toBe(75);
  });
  it("derives a 6-char upper-case reference", () => {
    expect(statementBillRef({ id: "x1y2z3abc123" })).toBe("ABC123");
  });
});

describe("billPayments", () => {
  it("returns the dated ledger entries", () => {
    const p = billPayments(SALES[1]);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ date: "2026-07-30", time: "11:00 am", amount: 200, mode: "UPI", atStart: false });
  });
  it("attributes a legacy paid amount to the bill's own date", () => {
    const p = billPayments(SALES[3]);
    expect(p).toEqual([{ id: "ddd444-p0", date: "2026-08-20", time: "07:45 pm", amount: 100, mode: "Cash", atStart: true }]);
  });
  it("reconciles a partial ledger against a larger paid total", () => {
    const p = billPayments({ id: "z", date: "2026-05-01", time: "", total: 900, paid: 500, paidMode: "Cash",
      payments: [{ id: "q", date: "2026-05-09", amount: 200, mode: "UPI" }] });
    expect(p.map((x) => x.amount)).toEqual([300, 200]); // the un-ledgered 300 leads, dated to the bill
    expect(p[0].atStart).toBe(true);
  });
  it("ignores zero-amount ledger rows", () => {
    expect(billPayments({ id: "z", date: "2026-05-01", total: 100, paid: 0, payments: [{ amount: 0 }] })).toEqual([]);
  });
});

describe("udhariCustomers", () => {
  it("lists everyone with credit history, most-owed first, keeping settled ones", () => {
    const cs = udhariCustomers(SALES);
    expect(cs.map((c) => c.name)).toEqual(["Ramesh", "Sita", "(no name)"]);
    expect(cs[0]).toMatchObject({ outstanding: 1800, bills: 3, mobile: "9876500001", first: "2026-06-10", last: "2026-08-12" });
    expect(cs[1].outstanding).toBe(200);
  });
  it("keeps a fully-settled customer in the list with zero outstanding", () => {
    const cs = udhariCustomers([SALES[0]]);
    expect(cs).toEqual([{ name: "Ramesh", mobile: "9876500001", bills: 1, outstanding: 0, first: "2026-06-10", last: "2026-06-10" }]);
  });
  it("ignores non-credit sales", () => {
    expect(udhariCustomers([SALES[5]])).toEqual([]);
  });
});

describe("buildStatement", () => {
  it("lists only still-due bills, oldest first, over an open range", () => {
    const st = buildStatement(SALES, { customer: "Ramesh" });
    expect(st.bills.map((b) => b.ref)).toEqual(["BBB222", "CCC333"]); // AAA111 is settled
    expect(st.totals).toEqual({ billed: 2000, paid: 200, due: 1800, closingDue: 1800, billCount: 2 });
    expect(st.openingDue).toBe(0);
    expect(st.laterDue).toBe(0);
    expect(st.mobile).toBe("9876500001");
  });

  it("carries pre-window debt in as an opening balance instead of dropping it", () => {
    const st = buildStatement(SALES, { customer: "Ramesh", from: "2026-08-01" });
    expect(st.bills.map((b) => b.ref)).toEqual(["CCC333"]);
    expect(st.openingDue).toBe(1000);                 // the July bill's unpaid remainder
    expect(st.totals.due).toBe(800);
    expect(st.totals.closingDue).toBe(1800);          // still the true balance
  });

  it("reports due bills after the window separately", () => {
    const st = buildStatement(SALES, { customer: "Ramesh", to: "2026-07-31" });
    expect(st.bills.map((b) => b.ref)).toEqual(["BBB222"]);
    expect(st.laterDue).toBe(800);
    expect(st.totals.closingDue).toBe(1000);
  });

  it("keeps the printed arithmetic exact: opening + billed - paid = closing", () => {
    for (const range of [{}, { from: "2026-07-01" }, { from: "2026-06-01", to: "2026-08-31" }, { to: "2026-08-01" }]) {
      const st = buildStatement(SALES, { customer: "Ramesh", ...range });
      expect(st.totals.closingDue).toBe(st.openingDue + st.totals.billed - st.totals.paid);
    }
  });

  it("matches the customer regardless of stored whitespace", () => {
    const st = buildStatement(SALES, { customer: "Ramesh", from: "2026-08-01", to: "2026-08-31" });
    expect(st.bills[0].ref).toBe("CCC333");           // stored as " Ramesh "
  });

  it("carries each bill's lines, discount and dated payments", () => {
    const [july, aug] = buildStatement(SALES, { customer: "Ramesh" }).bills;
    expect(july.lines.map((l) => l.name)).toEqual(["Rice", "Oil"]);
    expect(july).toMatchObject({ date: "2026-07-04", time: "06:15 pm", total: 1200, paid: 200, due: 1000, subtotal: 1200, discount: 0 });
    expect(july.payments[0]).toMatchObject({ date: "2026-07-30", amount: 200, mode: "UPI" });
    expect(aug).toMatchObject({ subtotal: 850, discount: 50, discountPct: 6, total: 800, due: 800 });
  });

  it("handles the unnamed walk-in bucket and a single-day window", () => {
    const st = buildStatement(SALES, { customer: "(no name)", from: "2026-08-21", to: "2026-08-21" });
    expect(st.totals).toMatchObject({ due: 150, closingDue: 150, billCount: 1 });
  });

  it("returns an empty statement for an unknown customer or a quiet window", () => {
    expect(buildStatement(SALES, { customer: "Nobody" }).totals).toEqual({ billed: 0, paid: 0, due: 0, closingDue: 0, billCount: 0 });
    const quiet = buildStatement(SALES, { customer: "Ramesh", from: "2026-09-01", to: "2026-09-30" });
    expect(quiet.bills).toEqual([]);
    expect(quiet.openingDue).toBe(1800);              // everything is now brought forward
    expect(quiet.totals.closingDue).toBe(1800);
  });

  it("rounds to paise so summed floats don't drift", () => {
    const st = buildStatement([
      sale({ id: "r1", date: "2026-08-01", customer: "Float", total: 10.1, paid: 0 }),
      sale({ id: "r2", date: "2026-08-02", customer: "Float", total: 20.2, paid: 0.3 }),
    ], { customer: "Float" });
    expect(st.totals.due).toBe(30);
    expect(st.totals.closingDue).toBe(30);
  });

  it("survives a missing sales list or customer", () => {
    expect(buildStatement(undefined, { customer: "Ramesh" }).bills).toEqual([]);
    expect(buildStatement(SALES, {}).bills).toEqual([]);
  });
});

describe("periodLabel", () => {
  const fmt = (d) => d.slice(8) + "/" + d.slice(5, 7);
  it("describes every shape of window", () => {
    expect(periodLabel("", "")).toBe("All unpaid bills");
    expect(periodLabel("2026-08-01", "2026-08-30", fmt)).toBe("01/08 — 30/08");
    expect(periodLabel("2026-08-01", "2026-08-01", fmt)).toBe("On 01/08");
    expect(periodLabel("2026-08-01", "", fmt)).toBe("From 01/08");
    expect(periodLabel("", "2026-08-30", fmt)).toBe("Up to 30/08");
  });
});
