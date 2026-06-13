// Flexible data parser for the "Raw Data Record" tab.
// Turns an uploaded file (csv / tsv / txt / xls / xlsx / json / pdf) or pasted
// text into a normalised list of rows the app can map to inventory or sales:
//   { name, qty, unit, buyPrice, sellPrice, amount }
// Everything runs in the browser. PDF text extraction is best-effort.
import * as XLSX from "xlsx";

const UNITS = ["pc", "kg", "g", "L", "ml", "packet", "dozen", "box"];

// Header keyword → field. Order matters (more specific first).
const HEADER_RULES = [
  ["amount", /\b(amount|total|value|net|line\s*total)\b/i],
  ["buyPrice", /\b(buy|cost|purchase|wholesale|cp)\b/i],
  ["sellPrice", /\b(sell|sale|mrp|price|selling|rate|sp|unit\s*price)\b/i],
  ["qty", /\b(qty|quantity|nos|units?|pcs|count)\b/i],
  ["unit", /\b(unit|uom|measure|packing)\b/i],
  ["name", /\b(name|item|product|description|particular|goods|details?)\b/i],
];

const toNum = (v) => {
  if (v == null) return 0;
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

function mapHeaderIndices(cells) {
  const idx = { name: -1, qty: -1, unit: -1, buyPrice: -1, sellPrice: -1, amount: -1 };
  cells.forEach((cell, i) => {
    const c = String(cell ?? "");
    for (const [field, re] of HEADER_RULES) {
      if (idx[field] === -1 && re.test(c)) {
        idx[field] = i;
        break;
      }
    }
  });
  return idx;
}

function looksLikeHeader(cells) {
  const text = cells.map((c) => String(c ?? "").trim());
  const anyName = HEADER_RULES.some(([, re]) => text.some((c) => re.test(c)));
  const numeric = text.filter((c) => c !== "" && Number.isFinite(Number(c.replace(/[^0-9.-]/g, "")))).length;
  return anyName && numeric < text.length;
}

// Core: given a header row + data rows, produce normalised rows.
function coreMap(headerCells, dataRows, hasHeader) {
  const idx = hasHeader ? mapHeaderIndices(headerCells) : { name: 0, qty: 1, unit: -1, buyPrice: -1, sellPrice: 2, amount: 2 };
  const out = [];
  for (const row of dataRows) {
    if (!row || row.every((c) => String(c ?? "").trim() === "")) continue;
    const name = String((idx.name >= 0 ? row[idx.name] : row[0]) ?? "").trim();
    if (!name) continue;
    const rawUnit = idx.unit >= 0 ? String(row[idx.unit] ?? "").trim() : "";
    out.push({
      name,
      qty: idx.qty >= 0 ? toNum(row[idx.qty]) || 1 : 1,
      unit: UNITS.includes(rawUnit) ? rawUnit : "pc",
      buyPrice: idx.buyPrice >= 0 ? toNum(row[idx.buyPrice]) : "",
      sellPrice: idx.sellPrice >= 0 ? toNum(row[idx.sellPrice]) : "",
      amount: idx.amount >= 0 ? toNum(row[idx.amount]) : "",
    });
  }
  return out;
}

function matrixToRows(matrix) {
  const rows = (matrix || []).filter((r) => Array.isArray(r) && r.some((c) => String(c ?? "").trim() !== ""));
  if (!rows.length) return [];
  const hasHeader = looksLikeHeader(rows[0]);
  return coreMap(hasHeader ? rows[0] : null, hasHeader ? rows.slice(1) : rows, hasHeader);
}

// Array of plain objects (from JSON) → rows.
function objectsToRows(arr) {
  const objs = arr.filter((o) => o && typeof o === "object" && !Array.isArray(o));
  if (!objs.length) return [];
  const header = Array.from(new Set(objs.flatMap((o) => Object.keys(o))));
  const data = objs.map((o) => header.map((k) => o[k]));
  return coreMap(header, data, true);
}

function detectDelimiter(line) {
  const counts = { "\t": (line.match(/\t/g) || []).length, ";": (line.match(/;/g) || []).length, ",": (line.match(/,/g) || []).length, "|": (line.match(/\|/g) || []).length };
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : null;
}

function splitCsvLine(line, delim) {
  // Minimal quoted-field handling for comma/semicolon CSV.
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

export function parseTextToMatrix(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim() !== "");
  if (!lines.length) return [];
  const delim = detectDelimiter(lines[0]);
  if (delim) return lines.map((l) => splitCsvLine(l, delim));
  // No delimiter: split on runs of 2+ spaces (common in PDF/printed text).
  return lines.map((l) => l.trim().split(/\s{2,}/));
}

// Parse pasted text (JSON or delimited/columnar).
export function parseRawText(text) {
  const t = (text || "").trim();
  if (!t) return [];
  if (t[0] === "[" || t[0] === "{") {
    try {
      const j = JSON.parse(t);
      return objectsToRows(Array.isArray(j) ? j : [j]);
    } catch {
      /* fall through to delimited parsing */
    }
  }
  return matrixToRows(parseTextToMatrix(t));
}

async function pdfToText(file) {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  let text = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // Reconstruct lines from text items by their y-position.
    const byLine = new Map();
    content.items.forEach((it) => {
      const y = Math.round(it.transform[5]);
      if (!byLine.has(y)) byLine.set(y, []);
      byLine.get(y).push(it.str);
    });
    [...byLine.entries()].sort((a, b) => b[0] - a[0]).forEach(([, parts]) => {
      text += parts.join("  ").trim() + "\n";
    });
  }
  return text;
}

// Main entry: parse any uploaded file into normalised rows.
export async function parseFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext === "json") {
    const j = JSON.parse(await file.text());
    return objectsToRows(Array.isArray(j) ? j : [j]);
  }
  if (ext === "xlsx" || ext === "xls") {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: true });
    return matrixToRows(matrix);
  }
  if (ext === "csv" || ext === "tsv") {
    const wb = XLSX.read(await file.text(), { type: "string" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return matrixToRows(XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: true }));
  }
  if (ext === "pdf") {
    return matrixToRows(parseTextToMatrix(await pdfToText(file)));
  }
  // txt / unknown → treat as delimited/columnar text
  return parseRawText(await file.text());
}
