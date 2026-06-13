// JSON and XLSX backup / restore for all store data.
// XLSX is multi-sheet and human-readable in Excel; sales are flattened to one
// row per line item (keyed by Bill ID) and reconstructed on import.
import * as XLSX from "xlsx";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ---- JSON ----
export function exportJson(data, filename) {
  const blob = new Blob([JSON.stringify({ ...data, exportedAt: new Date().toISOString() }, null, 2)], {
    type: "application/json",
  });
  triggerDownload(blob, filename);
}

// ---- XLSX ----
export function exportXlsx({ items, sales, expenses, logs }, filename) {
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      items.map((i) => ({
        id: i.id, name: i.name, code: i.code || "", category: i.category, unit: i.unit,
        buyPrice: i.buyPrice, sellPrice: i.sellPrice, stock: i.stock, lowAt: i.lowAt,
        createdAt: i.createdAt || "", updatedAt: i.updatedAt || "",
      }))
    ),
    "Items"
  );

  const saleRows = [];
  sales.forEach((s) =>
    (s.lines || []).forEach((l) =>
      saleRows.push({
        billId: s.id, date: s.date, time: s.time, item: l.name, qty: l.qty,
        unit: l.unit, price: l.price, amount: l.amount, billTotal: s.total, billProfit: s.profit,
      })
    )
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(saleRows.length ? saleRows : [{ billId: "", date: "", time: "", item: "", qty: "", unit: "", price: "", amount: "", billTotal: "", billProfit: "" }]), "Sales");

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(expenses.length ? expenses : [{ id: "", date: "", desc: "", amount: "" }]), "Expenses");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(logs.length ? logs : [{ id: "", at: "", date: "", time: "", type: "", message: "" }]), "Logs");

  XLSX.writeFile(wb, filename);
}

export async function importXlsx(file) {
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = (name) => (wb.Sheets[name] ? XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" }) : []);

  const items = sheet("Items")
    .filter((r) => String(r.name || "").trim())
    .map((r) => ({
      id: r.id || rid(), name: String(r.name).trim(), code: String(r.code || ""), category: r.category || "Other",
      unit: r.unit || "pc", buyPrice: num(r.buyPrice), sellPrice: num(r.sellPrice), stock: num(r.stock),
      lowAt: num(r.lowAt), createdAt: r.createdAt || "", updatedAt: r.updatedAt || "",
    }));

  // Rebuild bills by grouping flattened Sales rows on billId.
  const billMap = new Map();
  sheet("Sales").forEach((r) => {
    if (!r.billId) return;
    if (!billMap.has(r.billId)) billMap.set(r.billId, { id: r.billId, date: r.date, time: r.time, lines: [], total: num(r.billTotal), profit: num(r.billProfit) });
    billMap.get(r.billId).lines.push({ name: r.item, qty: num(r.qty), unit: r.unit || "pc", price: num(r.price), amount: num(r.amount) });
  });
  const sales = [...billMap.values()];

  const expenses = sheet("Expenses")
    .filter((r) => String(r.desc || "").trim())
    .map((r) => ({ id: r.id || rid(), date: r.date, desc: String(r.desc), amount: num(r.amount) }));

  const logs = sheet("Logs")
    .filter((r) => r.type)
    .map((r) => ({ id: r.id || rid(), at: num(r.at), date: r.date, time: r.time, type: r.type, message: r.message }));

  return { items, sales, expenses, logs };
}

function rid() {
  return Math.random().toString(36).slice(2, 10);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
