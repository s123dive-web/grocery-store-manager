// ---------------------------------------------------------------------------
// Consolidated udhari (credit) statement for one customer.
//
// A statement answers one question for a shop owner standing at the counter:
// "what does this person still owe me, and which bills is it from?" So it lists
// only bills that are STILL DUE — a bill already settled in full has left the
// customer's account and would only pad the paper.
//
// Everything here is pure and free of `new Date()` (dates arrive as YYYY-MM-DD
// strings), so it is deterministic and unit-testable — see statement.test.js.
// The React layer owns rendering and printing.
//
// Consumes the app's sale shape:
//   sale = { id, date:"YYYY-MM-DD", time:"02:15 pm", payment:"Udhari",
//            customer, mobile, total, paid?, paidMode?, subtotal?, discount?,
//            payments?:[{id, date, time, amount, mode}],
//            lines:[{name, qty, unit, price, amount, misc?}] }
// ---------------------------------------------------------------------------

import { round2 as money } from "./stats.js";

// How a customer is keyed everywhere in the udhari view: trimmed name, with
// unnamed walk-ins collected under one bucket rather than vanishing.
export const custKey = (sale) => (sale && sale.customer ? String(sale.customer).trim() : "") || "(no name)";

// Short human bill reference — mirrors billRef() in the app (last 6 of the id).
export const statementBillRef = (sale) => String((sale && sale.id) || "").slice(-6).toUpperCase();

// What's still owed on one bill.
export const billDue = (s) => Math.max(0, money((s.total || 0) - (s.paid || 0)));

// Every repayment against a bill, dated. Bills recorded before the payments
// ledger existed carry only `paid`/`paidMode` — that remainder is attributed to
// the bill's own date, exactly as the Udhari History panel does, so the two
// views can never disagree about when money came in.
export function billPayments(s) {
  const out = [];
  let ledgerSum = 0;
  (Array.isArray(s.payments) ? s.payments : []).forEach((p, i) => {
    const amount = money(p.amount || 0);
    if (amount <= 0) return;
    ledgerSum = money(ledgerSum + amount);
    out.push({ id: `${s.id}-p${p.id || i}`, date: p.date || s.date, time: p.time || "", amount, mode: p.mode || "", atStart: false });
  });
  const rest = money((s.paid || 0) - ledgerSum);
  if (rest > 0.005) out.unshift({ id: s.id + "-p0", date: s.date, time: s.time || "", amount: rest, mode: s.paidMode || "", atStart: true });
  return out;
}

// Minutes since midnight from "02:15 pm" / "10:05 am (back-dated)"; -1 if unknown.
const timeToMin = (t) => {
  const m = String(t || "").match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!m) return -1;
  let h = +m[1];
  const ap = (m[3] || "").toLowerCase();
  if (ap) { h = h % 12; if (ap === "pm") h += 12; }
  return h * 60 + (+m[2]);
};

// Oldest first: date ascending, then time ascending. A statement reads
// chronologically (unlike the screen tables, which lead with the newest).
const byDateTimeAsc = (a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : timeToMin(a.time) - timeToMin(b.time));

// Every customer with any udhari history, most-owed first — the picker list.
// Fully-settled customers stay in it (their statement is a paid-up account),
// so a receipt can still be produced after the debt is cleared.
export function udhariCustomers(sales) {
  const by = new Map();
  (sales || []).filter((s) => s.payment === "Udhari").forEach((s) => {
    const name = custKey(s);
    const c = by.get(name) || { name, mobile: "", bills: 0, outstanding: 0, first: s.date, last: s.date };
    c.bills += 1;
    c.outstanding = money(c.outstanding + billDue(s));
    if (s.mobile) c.mobile = s.mobile;
    if (s.date < c.first) c.first = s.date;
    if (s.date > c.last) c.last = s.date;
    by.set(name, c);
  });
  return [...by.values()].sort((a, b) => b.outstanding - a.outstanding || a.name.localeCompare(b.name));
}

// Build the statement for one customer over an optional [from, to] window
// (either end may be "" for open-ended). Only still-due bills are listed.
//
// The window filters on BILL date. Debt from before `from` isn't dropped — it
// is carried in as `openingDue`, so the printed balance is never less than what
// the customer actually owes. Due bills dated after `to` are reported
// separately as `laterDue` and called out in a footnote, for the same reason.
export function buildStatement(sales, { customer, from = "", to = "" } = {}) {
  const name = String(customer || "").trim();
  const mine = (sales || [])
    .filter((s) => s.payment === "Udhari" && custKey(s) === name && billDue(s) > 0)
    .sort(byDateTimeAsc);

  let mobile = "";
  mine.forEach((s) => { if (s.mobile) mobile = s.mobile; });

  const before = mine.filter((s) => from && s.date < from);
  const after = mine.filter((s) => to && s.date > to);
  const inRange = mine.filter((s) => (!from || s.date >= from) && (!to || s.date <= to));

  const bills = inRange.map((s) => {
    const payments = billPayments(s);
    const total = money(s.total || 0);
    const discount = money(s.discount || 0);
    return {
      id: s.id,
      ref: statementBillRef(s),
      date: s.date,
      time: s.time || "",
      lines: Array.isArray(s.lines) ? s.lines : [],
      subtotal: money(s.subtotal != null ? s.subtotal : total + discount),
      discount,
      discountPct: s.discountPct || 0,
      total,
      paid: money(s.paid || 0),
      due: billDue(s),
      payments,
    };
  });

  const openingDue = money(before.reduce((a, s) => a + billDue(s), 0));
  const laterDue = money(after.reduce((a, s) => a + billDue(s), 0));
  const billed = money(bills.reduce((a, b) => a + b.total, 0));
  const paid = money(bills.reduce((a, b) => a + b.paid, 0));
  const due = money(bills.reduce((a, b) => a + b.due, 0));

  return {
    customer: name,
    mobile,
    from,
    to,
    bills,
    openingDue,
    laterDue,
    // openingDue + billed − paid === closingDue, by construction: the running
    // arithmetic printed on the statement is the balance, not an estimate.
    totals: { billed, paid, due, closingDue: money(openingDue + due), billCount: bills.length },
  };
}

// One-line period caption for the statement head. Dates are formatted by the
// caller's locale helper; this only decides the shape of the phrase.
export function periodLabel(from, to, fmt = (d) => d) {
  if (!from && !to) return "All unpaid bills";
  if (from && to) return from === to ? `On ${fmt(from)}` : `${fmt(from)} — ${fmt(to)}`;
  return from ? `From ${fmt(from)}` : `Up to ${fmt(to)}`;
}
