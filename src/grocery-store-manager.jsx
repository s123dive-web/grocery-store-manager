import { useState, useEffect, useMemo, useRef, useCallback, Fragment } from "react";
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell, Legend,
} from "recharts";
import JsBarcode from "jsbarcode";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail } from "firebase/auth";
import { auth } from "./lib/firebase.js";
import {
  toMap, mapToArray, isLegacyShape, buildSliceUpdate, mergeRemote,
  writeSlice, overwriteSlice, subscribeSlice, subscribeConnection,
} from "./lib/sync.js";
import { parseFile, parseRawText } from "./lib/parse.js";
import { exportJson, exportXlsx, importXlsx } from "./lib/backup.js";

// ---------- helpers ----------
const INR = (n) =>
  "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
// Round money to 2 decimals so bill totals don't drift (e.g. 0.1 + 0.2 = 0.30000004).
const money = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
// Local calendar date as YYYY-MM-DD. MUST be local, not toISOString() (which is UTC)
// — otherwise early-morning sales in IST get filed under the previous day.
const dateStr = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayStr = () => dateStr(new Date());
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Brand + payment assets (served from /public). BASE_URL is "/" in dev and the repo
// sub-path on GitHub Pages, so these resolve correctly in both. assetUrl() makes them
// absolute for the print window (about:blank, which can't resolve relative paths).
const BASE = import.meta.env.BASE_URL;
const LOGO_SRC = BASE + "logo.jpg";
const PAYMENT_QR_SRC = BASE + "payment-qr.jpg";
const assetUrl = (p) => (typeof location !== "undefined" ? location.origin : "") + p;

// Open a thermal-style receipt in a new window and trigger the print dialog.
function printReceipt(sale) {
  const rows = sale.lines
    .map(
      (l) =>
        `<tr><td>${escapeHtml(l.name)}</td><td class="c">${l.qty}</td><td class="r">${INR(l.amount)}</td></tr>`
    )
    .join("");
  const w = window.open("", "_blank", "width=340,height=620");
  if (!w) return; // popup blocked
  w.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>Receipt</title>
    <style>body{font-family:'Courier New',monospace;padding:10px;width:280px;color:#000}
    h2{text-align:center;margin:4px 0}.meta{text-align:center;font-size:11px}
    .logo{display:block;margin:0 auto 2px;height:46px;object-fit:contain}
    table{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}
    td{padding:2px 0}.c{text-align:center}.r{text-align:right}
    .tot td{border-top:1px dashed #000;font-weight:bold;padding-top:4px}
    .ft{text-align:center;font-size:11px;margin-top:8px;border-top:1px dashed #000;padding-top:6px}
    .pay{text-align:center;margin-top:10px;border-top:1px dashed #000;padding-top:8px}
    .pay img{width:150px;height:150px;object-fit:contain}
    .pay .lbl{font-size:11px;font-weight:bold;margin-top:2px}</style>
    </head><body>
    <img class="logo" src="${assetUrl(LOGO_SRC)}" alt="" onerror="this.style.display='none'" />
    <h2>${escapeHtml(STORE.name)}</h2>
    <div class="meta">${escapeHtml(STORE.address)}</div>
    <div class="meta">${escapeHtml(sale.date)} &nbsp; ${escapeHtml(sale.time)}</div>
    <table>${rows}
    <tr class="tot"><td>TOTAL</td><td></td><td class="r">${INR(sale.total)}</td></tr>
    </table>
    ${sale.payment ? `<div class="meta">Paid via ${escapeHtml(sale.payment)}${sale.customer ? " — " + escapeHtml(sale.customer) : ""}</div>` : ""}
    <div class="ft">Thank you! Please visit again.</div>
    <div class="pay">
      <img src="${assetUrl(PAYMENT_QR_SRC)}" alt="Scan to pay" onerror="this.style.display='none'" />
      <div class="lbl">Scan to Pay · PhonePe / UPI</div>
    </div>
    <script>window.onload=function(){setTimeout(function(){window.print()},250)}</scr` + `ipt>
    </body></html>`
  );
  w.document.close();
}
const UNITS = ["pc", "kg", "g", "L", "ml", "packet", "dozen", "box"];
const CATEGORIES = [
  "Cold Drinks & Water", "Ice Cream", "Chocolates & Candy", "Snacks & Biscuits",
  "Dairy & Eggs", "Bakery & Bread", "Staples & Grains", "Dry Fruits & Nuts",
  "Fruits & Vegetables", "Oil & Ghee", "Beverages", "Spices & Masala", "Frozen & Instant",
  "Personal Care", "Household & Cleaning", "Stationery", "Sports & Toys", "Other",
];
// A small emoji icon per category (used in place of product photos).
const CATEGORY_ICONS = {
  "Cold Drinks & Water": "🥤", "Ice Cream": "🍦", "Chocolates & Candy": "🍫",
  "Snacks & Biscuits": "🍪", "Dairy & Eggs": "🥛", "Bakery & Bread": "🍞",
  "Staples & Grains": "🌾", "Dry Fruits & Nuts": "🥜", "Fruits & Vegetables": "🥦",
  "Oil & Ghee": "🛢️", "Beverages": "☕", "Spices & Masala": "🌶️", "Frozen & Instant": "🍜",
  "Personal Care": "🧴", "Household & Cleaning": "🧹", "Stationery": "✏️",
  "Sports & Toys": "🏏", "Other": "📦",
};
const iconFor = (category) => CATEGORY_ICONS[category] || "📦";

// Catalog tuned for a Pashan–Baner (Pune) society convenience store:
// top-up shoppers, kids' favourites, always-moving chilled stock.
const SEED_ITEMS = [
  // Cold Drinks & Water — the never-stops shelf
  ["Bisleri Water 1L", "Cold Drinks & Water", "pc", 16, 20, 48, 12],
  ["Bisleri Water 500ml", "Cold Drinks & Water", "pc", 8, 10, 48, 12],
  ["Kinley Water 1L", "Cold Drinks & Water", "pc", 15, 20, 24, 8],
  ["Coca-Cola 750ml", "Cold Drinks & Water", "pc", 32, 40, 24, 6],
  ["Thums Up 750ml", "Cold Drinks & Water", "pc", 32, 40, 24, 6],
  ["Sprite 750ml", "Cold Drinks & Water", "pc", 32, 40, 18, 6],
  ["Maaza 600ml", "Cold Drinks & Water", "pc", 30, 38, 18, 6],
  ["Frooti 250ml Tetra", "Cold Drinks & Water", "pc", 16, 20, 30, 10],
  ["Sting Energy 250ml", "Cold Drinks & Water", "pc", 16, 20, 24, 8],
  ["Red Bull 250ml", "Cold Drinks & Water", "pc", 99, 125, 12, 4],
  ["Paper Boat Aam Panna", "Cold Drinks & Water", "pc", 28, 35, 12, 4],
  ["Amul Masti Buttermilk 200ml", "Cold Drinks & Water", "pc", 12, 15, 24, 8],
  // Ice Cream — kids' magnet
  ["Amul Vanilla Cup 100ml", "Ice Cream", "pc", 16, 20, 24, 8],
  ["Amul Kulfi Stick", "Ice Cream", "pc", 20, 25, 20, 6],
  ["Amul Tricone Chocolate", "Ice Cream", "pc", 28, 35, 16, 5],
  ["Cornetto Double Chocolate", "Ice Cream", "pc", 32, 40, 16, 5],
  ["Magnum Almond", "Ice Cream", "pc", 72, 90, 10, 3],
  ["Vadilal Cassata Slice", "Ice Cream", "pc", 48, 60, 8, 3],
  ["Amul Vanilla Family Pack 700ml", "Ice Cream", "pc", 140, 180, 6, 2],
  // Chocolates & Candy — pocket-money zone
  ["Dairy Milk (small)", "Chocolates & Candy", "pc", 8, 10, 60, 15],
  ["Dairy Milk Silk 60g", "Chocolates & Candy", "pc", 76, 95, 15, 5],
  ["KitKat 4-Finger", "Chocolates & Candy", "pc", 16, 20, 40, 10],
  ["5 Star", "Chocolates & Candy", "pc", 8, 10, 50, 12],
  ["Munch", "Chocolates & Candy", "pc", 8, 10, 50, 12],
  ["Cadbury Gems", "Chocolates & Candy", "pc", 8, 10, 40, 10],
  ["Kinder Joy", "Chocolates & Candy", "pc", 40, 50, 20, 6],
  ["Pulse Candy", "Chocolates & Candy", "pc", 0.8, 1, 200, 50],
  ["Alpenliebe Lollipop", "Chocolates & Candy", "pc", 1.6, 2, 100, 25],
  ["Choco Pie Box (12)", "Chocolates & Candy", "box", 110, 140, 8, 3],
  // Snacks & Biscuits
  ["Lay's Magic Masala", "Snacks & Biscuits", "packet", 16, 20, 40, 10],
  ["Kurkure Masala Munch", "Snacks & Biscuits", "packet", 16, 20, 40, 10],
  ["Bingo Mad Angles", "Snacks & Biscuits", "packet", 16, 20, 24, 8],
  ["Pringles Original", "Snacks & Biscuits", "pc", 88, 110, 8, 3],
  ["Haldiram Aloo Bhujia 200g", "Snacks & Biscuits", "packet", 44, 55, 15, 5],
  ["Parle-G", "Snacks & Biscuits", "packet", 8, 10, 60, 15],
  ["Oreo Chocolate", "Snacks & Biscuits", "packet", 24, 30, 30, 8],
  ["Hide & Seek", "Snacks & Biscuits", "packet", 24, 30, 24, 8],
  ["Britannia Good Day", "Snacks & Biscuits", "packet", 24, 30, 24, 8],
  ["Little Hearts", "Snacks & Biscuits", "packet", 8, 10, 30, 10],
  ["Monaco", "Snacks & Biscuits", "packet", 24, 30, 20, 6],
  // Dairy & Eggs — daily top-ups
  ["Amul Taaza Milk 500ml", "Dairy & Eggs", "packet", 26, 29, 30, 10],
  ["Amul Gold Milk 500ml", "Dairy & Eggs", "packet", 31, 34, 24, 8],
  ["Chitale Full Cream Milk 500ml", "Dairy & Eggs", "packet", 30, 33, 24, 8],
  ["Amul Dahi 400g", "Dairy & Eggs", "pc", 30, 35, 15, 5],
  ["Amul Butter 100g", "Dairy & Eggs", "pc", 56, 62, 15, 5],
  ["Amul Cheese Slices (10)", "Dairy & Eggs", "packet", 130, 145, 10, 3],
  ["Amul Paneer 200g", "Dairy & Eggs", "packet", 88, 99, 12, 4],
  ["Eggs", "Dairy & Eggs", "dozen", 75, 90, 15, 5],
  // Bakery & Bread
  ["Brown Bread", "Bakery & Bread", "packet", 45, 55, 12, 4],
  ["White Sandwich Bread", "Bakery & Bread", "packet", 30, 40, 12, 4],
  ["Ladi Pav (6 pc)", "Bakery & Bread", "packet", 18, 25, 15, 5],
  ["Pune Khari 200g", "Bakery & Bread", "packet", 35, 50, 10, 3],
  // Staples — top-up sizes, not bulk
  ["Aashirvaad Atta 1kg", "Staples & Grains", "packet", 52, 60, 15, 5],
  ["India Gate Basmati 1kg", "Staples & Grains", "packet", 130, 155, 10, 3],
  ["Tata Salt 1kg", "Staples & Grains", "packet", 23, 28, 25, 8],
  ["Sugar 1kg", "Staples & Grains", "kg", 42, 48, 20, 6],
  ["Toor Dal 1kg", "Staples & Grains", "packet", 140, 165, 10, 3],
  ["Moong Dal 500g", "Staples & Grains", "packet", 70, 85, 10, 3],
  ["Poha 500g", "Staples & Grains", "packet", 30, 40, 15, 5],
  ["Rava 500g", "Staples & Grains", "packet", 28, 35, 12, 4],
  ["Besan 500g", "Staples & Grains", "packet", 45, 55, 10, 3],
  // Fruits & Vegetables — emergency veggies
  ["Onion", "Fruits & Vegetables", "kg", 28, 38, 20, 5],
  ["Potato", "Fruits & Vegetables", "kg", 22, 30, 20, 5],
  ["Tomato", "Fruits & Vegetables", "kg", 25, 35, 15, 4],
  ["Banana", "Fruits & Vegetables", "dozen", 45, 60, 10, 3],
  ["Lemon", "Fruits & Vegetables", "pc", 4, 6, 40, 10],
  ["Coriander Bunch", "Fruits & Vegetables", "pc", 8, 15, 15, 5],
  ["Green Chilli 100g", "Fruits & Vegetables", "packet", 8, 12, 15, 5],
  ["Ginger 100g", "Fruits & Vegetables", "packet", 8, 12, 12, 4],
  ["Garlic 100g", "Fruits & Vegetables", "packet", 12, 18, 12, 4],
  // Oil & Ghee
  ["Fortune Sunflower Oil 1L", "Oil & Ghee", "packet", 130, 145, 12, 4],
  ["Saffola Gold 1L", "Oil & Ghee", "packet", 175, 199, 8, 3],
  ["Amul Ghee 500ml", "Oil & Ghee", "pc", 290, 320, 8, 3],
  // Beverages (hot)
  ["Tata Tea Premium 250g", "Beverages", "packet", 72, 85, 12, 4],
  ["Nescafe Classic 50g", "Beverages", "pc", 150, 170, 10, 3],
  ["Bru Instant 50g", "Beverages", "pc", 85, 95, 10, 3],
  ["Bournvita 500g", "Beverages", "pc", 220, 250, 8, 3],
  ["Horlicks 500g", "Beverages", "pc", 230, 260, 8, 3],
  // Spices & Masala
  ["Everest Garam Masala 50g", "Spices & Masala", "packet", 38, 45, 12, 4],
  ["MDH Chana Masala 100g", "Spices & Masala", "packet", 38, 45, 10, 3],
  ["Haldi Powder 100g", "Spices & Masala", "packet", 30, 38, 12, 4],
  ["Red Chilli Powder 100g", "Spices & Masala", "packet", 38, 45, 12, 4],
  ["Jeera 100g", "Spices & Masala", "packet", 35, 45, 10, 3],
  // Frozen & Instant — IT-crowd dinner savers
  ["Maggi 2-Min Noodles", "Frozen & Instant", "packet", 11, 14, 60, 15],
  ["Yippee Noodles", "Frozen & Instant", "packet", 11, 14, 30, 10],
  ["Cup Noodles", "Frozen & Instant", "pc", 40, 50, 15, 5],
  ["ID Dosa Batter 1kg", "Frozen & Instant", "packet", 75, 95, 12, 4],
  ["McCain French Fries 420g", "Frozen & Instant", "packet", 90, 110, 8, 3],
  ["Safal Green Peas 500g", "Frozen & Instant", "packet", 60, 75, 8, 3],
  ["Frozen Veg Momos (12)", "Frozen & Instant", "packet", 110, 140, 6, 2],
  // Personal Care
  ["Colgate Strong Teeth 100g", "Personal Care", "pc", 52, 60, 15, 5],
  ["Dove Soap 100g", "Personal Care", "pc", 48, 58, 15, 5],
  ["Lifebuoy Soap 125g", "Personal Care", "pc", 28, 34, 15, 5],
  ["Dove Shampoo 180ml", "Personal Care", "pc", 110, 130, 8, 3],
  ["Dettol Handwash Refill 175ml", "Personal Care", "pc", 75, 90, 10, 3],
  ["Gillette Guard Razor", "Personal Care", "pc", 75, 90, 10, 3],
  ["Stayfree Secure XL (6)", "Personal Care", "packet", 45, 55, 12, 4],
  // Household & Cleaning
  ["Vim Bar", "Household & Cleaning", "pc", 8, 10, 25, 8],
  ["Surf Excel 500g", "Household & Cleaning", "packet", 60, 70, 12, 4],
  ["Lizol 500ml", "Household & Cleaning", "pc", 95, 110, 8, 3],
  ["Harpic 500ml", "Household & Cleaning", "pc", 80, 92, 8, 3],
  ["Garbage Bags Medium (30)", "Household & Cleaning", "packet", 50, 65, 12, 4],
  ["Scotch-Brite Scrub Pad", "Household & Cleaning", "pc", 18, 25, 15, 5],
  ["Good Knight Refill", "Household & Cleaning", "pc", 65, 75, 12, 4],
  ["Aluminium Foil 9m", "Household & Cleaning", "pc", 50, 65, 8, 3],
  // Stationery
  ["Classmate Notebook 180pg", "Stationery", "pc", 45, 60, 0, 5],
  ["Reynolds Ball Pen (Blue)", "Stationery", "pc", 6, 10, 0, 10],
  ["Apsara Pencil", "Stationery", "pc", 4, 7, 0, 10],
  ["Non-Dust Eraser", "Stationery", "pc", 3, 5, 0, 10],
  ["Scale 30cm", "Stationery", "pc", 8, 15, 0, 5],
  ["A4 Paper Ream (500)", "Stationery", "packet", 260, 320, 0, 3],
  ["Glue Stick", "Stationery", "pc", 18, 28, 0, 5],
  ["Marker Pen", "Stationery", "pc", 22, 35, 0, 5],
  // Sports & Toys — MRP given as 8th value where it differs from selling price
  ["Hard Hitter Cricket Bat", "Sports & Toys", "pc", 2200, 3500, 0, 2, 2200],
  ["Sixit Cricket Balls", "Sports & Toys", "pc", 310, 490, 0, 3, 510],
  ["Abdominal Safety Guard", "Sports & Toys", "pc", 120, 180, 0, 3],
  ["Batting Supporter", "Sports & Toys", "pc", 90, 140, 0, 3],
  // Loose staples — 500g / 1kg packs
  ["Gehu Atta 1kg", "Staples & Grains", "packet", 38, 48, 0, 6],
  ["Gehu Atta 500g", "Staples & Grains", "packet", 20, 26, 0, 6],
  ["Samrat Atta 1kg", "Staples & Grains", "packet", 45, 55, 0, 6],
  ["Sona Masoori Rice 1kg", "Staples & Grains", "kg", 55, 70, 0, 6],
  ["Kolam Rice 1kg", "Staples & Grains", "kg", 60, 78, 0, 5],
  ["Toor Dal 500g", "Staples & Grains", "packet", 72, 90, 0, 5],
  ["Chana Dal 500g", "Staples & Grains", "packet", 40, 52, 0, 5],
  ["Urad Dal 500g", "Staples & Grains", "packet", 60, 78, 0, 5],
  ["Masoor Dal 500g", "Staples & Grains", "packet", 45, 58, 0, 5],
  ["Moong Dal 1kg", "Staples & Grains", "kg", 130, 160, 0, 4],
  ["Rajma 500g", "Staples & Grains", "packet", 70, 90, 0, 4],
  ["Kabuli Chana 500g", "Staples & Grains", "packet", 55, 72, 0, 4],
  ["Sugar 500g", "Staples & Grains", "packet", 22, 26, 0, 6],
  // Staples & Grains — full dal / rice / flour range in 500g & 1kg packs
  ["Chana Dal 1kg", "Staples & Grains", "packet", 78, 98, 0, 4],
  ["Urad Dal 1kg", "Staples & Grains", "packet", 118, 150, 0, 4],
  ["Masoor Dal 1kg", "Staples & Grains", "packet", 88, 112, 0, 4],
  ["Rajma 1kg", "Staples & Grains", "packet", 135, 170, 0, 3],
  ["Kabuli Chana 1kg", "Staples & Grains", "packet", 105, 135, 0, 3],
  ["Kala Chana 500g", "Staples & Grains", "packet", 40, 52, 0, 5],
  ["Kala Chana 1kg", "Staples & Grains", "packet", 78, 98, 0, 4],
  ["Green Moong Whole 500g", "Staples & Grains", "packet", 55, 70, 0, 4],
  ["Green Moong Whole 1kg", "Staples & Grains", "packet", 105, 130, 0, 3],
  ["Lobia (Chawli) 500g", "Staples & Grains", "packet", 50, 65, 0, 4],
  ["Matki (Moth Bean) 500g", "Staples & Grains", "packet", 55, 70, 0, 4],
  ["Dried Green Peas 500g", "Staples & Grains", "packet", 45, 58, 0, 4],
  ["Basmati Rice 500g", "Staples & Grains", "packet", 70, 90, 0, 4],
  ["Sona Masoori Rice 500g", "Staples & Grains", "packet", 30, 40, 0, 5],
  ["Kolam Rice 500g", "Staples & Grains", "packet", 32, 42, 0, 5],
  ["Idli Rice 1kg", "Staples & Grains", "kg", 55, 72, 0, 4],
  ["Brown Rice 1kg", "Staples & Grains", "kg", 75, 95, 0, 3],
  ["Besan 1kg", "Staples & Grains", "packet", 85, 105, 0, 4],
  ["Maida 500g", "Staples & Grains", "packet", 22, 30, 0, 5],
  ["Maida 1kg", "Staples & Grains", "packet", 42, 55, 0, 4],
  ["Rava / Sooji 1kg", "Staples & Grains", "packet", 50, 65, 0, 4],
  ["Jowar Atta 1kg", "Staples & Grains", "packet", 55, 70, 0, 4],
  ["Bajra Atta 1kg", "Staples & Grains", "packet", 55, 70, 0, 4],
  ["Ragi Atta 1kg", "Staples & Grains", "packet", 65, 82, 0, 3],
  ["Multigrain Atta 1kg", "Staples & Grains", "packet", 60, 78, 0, 4],
  ["Rice Flour 500g", "Staples & Grains", "packet", 28, 38, 0, 4],
  ["Poha 1kg", "Staples & Grains", "packet", 58, 75, 0, 4],
  ["Sabudana 500g", "Staples & Grains", "packet", 45, 58, 0, 4],
  ["Daliya (Broken Wheat) 500g", "Staples & Grains", "packet", 30, 40, 0, 4],
  ["Daliya (Broken Wheat) 1kg", "Staples & Grains", "packet", 55, 72, 0, 4],
  ["Vermicelli (Shevaya) 500g", "Staples & Grains", "packet", 35, 48, 0, 4],
  ["Rock Salt (Sendha) 500g", "Staples & Grains", "packet", 25, 35, 0, 4],
  // Dry Fruits & Nuts — 100/200/250/500g
  ["Almonds 100g", "Dry Fruits & Nuts", "packet", 75, 95, 0, 4],
  ["Almonds 250g", "Dry Fruits & Nuts", "packet", 180, 230, 0, 3],
  ["Cashew 100g", "Dry Fruits & Nuts", "packet", 90, 120, 0, 4],
  ["Cashew 250g", "Dry Fruits & Nuts", "packet", 220, 280, 0, 3],
  ["Raisins (Kishmish) 200g", "Dry Fruits & Nuts", "packet", 60, 80, 0, 4],
  ["Walnuts 200g", "Dry Fruits & Nuts", "packet", 150, 190, 0, 3],
  ["Pistachios 100g", "Dry Fruits & Nuts", "packet", 110, 140, 0, 3],
  ["Dates (Khajur) 500g", "Dry Fruits & Nuts", "packet", 90, 120, 0, 4],
  // Personal care — shaving / shampoo / perfume / cosmetics
  ["Gillette Shaving Foam 200ml", "Personal Care", "pc", 180, 210, 0, 4],
  ["Old Spice Shaving Cream 70g", "Personal Care", "pc", 95, 115, 0, 4],
  ["Gillette Razor Blades (5)", "Personal Care", "packet", 45, 60, 0, 6],
  ["Clinic Plus Shampoo 175ml", "Personal Care", "pc", 75, 90, 0, 5],
  ["Head & Shoulders Shampoo 180ml", "Personal Care", "pc", 110, 130, 0, 4],
  ["Shampoo Sachets (16)", "Personal Care", "packet", 30, 45, 0, 6],
  ["Fogg Perfume 100ml", "Personal Care", "pc", 230, 290, 0, 3],
  ["Wild Stone Deo 150ml", "Personal Care", "pc", 180, 220, 0, 3],
  ["Nivea Cream 100ml", "Personal Care", "pc", 120, 145, 0, 4],
  ["Vaseline 100ml", "Personal Care", "pc", 95, 115, 0, 4],
  ["Glow & Lovely Cream 50g", "Personal Care", "pc", 80, 95, 0, 4],
  // Household — brooms & detergents
  ["Zadu (Floor Broom)", "Household & Cleaning", "pc", 60, 90, 0, 4],
  ["Phool Jhadu (Soft Broom)", "Household & Cleaning", "pc", 90, 130, 0, 4],
  ["Surf Excel 1kg", "Household & Cleaning", "packet", 110, 130, 0, 4],
  ["Surf Excel Matic 1kg", "Household & Cleaning", "packet", 200, 230, 0, 3],
  ["Tide 1kg", "Household & Cleaning", "packet", 100, 120, 0, 4],
  ["Ariel 1kg", "Household & Cleaning", "packet", 180, 210, 0, 3],
  ["Ghadi Detergent 1kg", "Household & Cleaning", "packet", 60, 75, 0, 4],
  ["Rin Bar", "Household & Cleaning", "pc", 10, 14, 0, 8],
  ["Comfort Fabric Conditioner 200ml", "Household & Cleaning", "pc", 45, 60, 0, 4],
  // Water
  ["Water Bottle 30L", "Cold Drinks & Water", "pc", 40, 70, 0, 6],
  // Ice cream — Havmor
  ["Havmor Vanilla Cup 100ml", "Ice Cream", "pc", 18, 25, 0, 8],
  ["Havmor Chocolate Cone", "Ice Cream", "pc", 30, 40, 0, 6],
  ["Havmor Kulfi Stick", "Ice Cream", "pc", 22, 30, 0, 6],
  ["Havmor Rajbhog 700ml", "Ice Cream", "pc", 160, 210, 0, 3],
  // Snacks — Haldiram / Bikaji / Lays / Balaji / Chitale
  ["Haldiram Bhujia Sev 200g", "Snacks & Biscuits", "packet", 48, 60, 0, 5],
  ["Haldiram Moong Dal 200g", "Snacks & Biscuits", "packet", 45, 58, 0, 5],
  ["Haldiram Navratan Mix 200g", "Snacks & Biscuits", "packet", 48, 62, 0, 5],
  ["Bikaji Bhujia 200g", "Snacks & Biscuits", "packet", 45, 58, 0, 5],
  ["Bikaji Aloo Bhujia 200g", "Snacks & Biscuits", "packet", 45, 58, 0, 5],
  ["Balaji Wafers Masala 150g", "Snacks & Biscuits", "packet", 30, 40, 0, 6],
  ["Balaji Chaat Chaska 150g", "Snacks & Biscuits", "packet", 30, 40, 0, 6],
  ["Lay's Cream & Onion 52g", "Snacks & Biscuits", "packet", 16, 20, 0, 10],
  ["Lay's India's Magic Masala 52g", "Snacks & Biscuits", "packet", 16, 20, 0, 10],
  ["Chitale Bakarwadi 200g", "Snacks & Biscuits", "packet", 70, 90, 0, 5],
  ["Chitale Bhajani Chakli 200g", "Snacks & Biscuits", "packet", 65, 85, 0, 4],
  // Chocolates — Cadbury & others
  ["Cadbury Dairy Milk 40g", "Chocolates & Candy", "pc", 35, 45, 0, 8],
  ["Cadbury Perk", "Chocolates & Candy", "pc", 8, 10, 0, 12],
  ["Cadbury Fuse", "Chocolates & Candy", "pc", 16, 20, 0, 8],
  ["Cadbury Celebrations Box", "Chocolates & Candy", "box", 150, 185, 0, 3],
  ["Ferrero Rocher (4)", "Chocolates & Candy", "packet", 130, 160, 0, 3],
  // Oils — pouches & Gemini cans
  ["Sunflower Oil Pouch 1L", "Oil & Ghee", "packet", 120, 140, 0, 5],
  ["Soyabean Oil Pouch 1L", "Oil & Ghee", "packet", 115, 135, 0, 5],
  ["Mustard Oil Pouch 1L", "Oil & Ghee", "packet", 140, 165, 0, 4],
  ["Gemini Refined Oil 5L Can", "Oil & Ghee", "pc", 620, 720, 0, 3],
  ["Gemini Refined Oil 15L Can", "Oil & Ghee", "pc", 1850, 2100, 0, 2],
  // Bakery — khari, toast, rusk
  ["Butter Khari 200g", "Bakery & Bread", "packet", 35, 50, 0, 5],
  ["Butter Toast 200g", "Bakery & Bread", "packet", 35, 48, 0, 5],
  ["Milk Rusk 300g", "Bakery & Bread", "packet", 40, 55, 0, 5],
  ["Fruit Bun (4)", "Bakery & Bread", "packet", 25, 35, 0, 4],
  ["Cream Roll (6)", "Bakery & Bread", "packet", 40, 55, 0, 4],
].map(([name, category, unit, buyPrice, sellPrice, , lowAt, mrp]) => ({
  // Fresh start: every catalogue item begins at 0 stock with no batches.
  id: uid(), name, category, unit, buyPrice, sellPrice, mrp: mrp ?? sellPrice,
  stock: 0, lowAt, batches: [], icon: iconFor(category), createdAt: todayStr(),
}));

// Categories of activity recorded in the global Activity Log.
const LOG_TYPES = ["sale", "inventory", "expense", "import", "backup"];

// Store identity. Address/locality verified (Nancy Hill View is a real complex in
// Baner, Pune 411021); phone left blank rather than invented.
const STORE = {
  name: "Prakash Super Mart",
  tagline: "Groceries & Daily Needs",
  address: "Shop No. 16, Nancy Hill View, Baner, Pune 411021",
  phone: "",
};

// ---------- stock / expiry batch helpers ----------
// Each item tracks stock as dated batches { id, qty, expiry, addedOn }; `stock` is the
// cached sum. Adding stock appends a batch; selling depletes batches FIFO by expiry.
const batchSort = (a, b) => (String(a.expiry || "9999-99-99") < String(b.expiry || "9999-99-99") ? -1 : 1);

function addBatch(item, qty, expiry, date) {
  const q = +qty || 0;
  if (q <= 0) return item;
  const batches = [...(item.batches || []), { id: uid(), qty: q, expiry: expiry || "", addedOn: date || todayStr() }];
  return { ...item, batches, stock: (item.stock || 0) + q, updatedAt: date || todayStr() };
}

function removeStock(item, qty, date) {
  let need = +qty || 0;
  const out = [];
  [...(item.batches || [])].sort(batchSort).forEach((b) => {
    if (need <= 0) return out.push(b);
    if (b.qty <= need) { need -= b.qty; } // consume whole batch
    else { out.push({ ...b, qty: b.qty - need }); need = 0; }
  });
  return { ...item, batches: out, stock: Math.max(0, (item.stock || 0) - (+qty || 0)), updatedAt: date || todayStr() };
}

// Days until the earliest batch expiry (null if no dated batches; negative = expired).
function daysToExpiry(item) {
  const dates = (item.batches || []).filter((b) => b.expiry).map((b) => b.expiry).sort();
  if (!dates.length) return null;
  return Math.round((new Date(dates[0] + "T00:00") - new Date(todayStr() + "T00:00")) / 86400000);
}

// ---------- authentication (Firebase email/password) ----------
// Real server-side auth via Firebase. Data is gated by the database security rules
// (locked to the shop owner's email), so it is genuinely private — not just a UI gate.
const AUTH_ERRORS = {
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/wrong-password": "Incorrect email or password.",
  "auth/user-not-found": "No account with that email.",
  "auth/invalid-email": "That email address looks invalid.",
  "auth/missing-password": "Please enter your password.",
  "auth/too-many-requests": "Too many attempts — please wait a minute and retry.",
  "auth/network-request-failed": "Network error — check your internet connection.",
  "auth/unauthorized-domain": "This web address isn't authorised in Firebase Auth settings.",
};
const authMessage = (code) => AUTH_ERRORS[code] || "Could not sign in. Please try again.";

function Login() {
  const [email, setEmail] = useState("");
  const [pwd, setPwd] = useState("");
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true); setErr(""); setInfo("");
    try {
      await signInWithEmailAndPassword(auth, email.trim(), pwd);
      // App's auth listener swaps to the dashboard on success.
    } catch (ex) {
      setErr(authMessage(ex.code));
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!email.trim()) return setErr("Enter your email above first, then tap reset.");
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setErr(""); setInfo("Password reset link sent to " + email.trim());
    } catch (ex) { setErr(authMessage(ex.code)); }
  };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#10331F", padding: 16 }}>
      <style>{CSS}</style>
      <form onSubmit={submit} style={{ background: "#fff", borderRadius: 16, padding: "26px 24px", width: "min(380px, 94vw)", boxShadow: "0 12px 40px rgba(0,0,0,.3)" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <img src={LOGO_SRC} alt="Prakash Super Mart" style={{ width: 52, height: 52, borderRadius: 12, objectFit: "contain", flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 800, fontSize: 18, letterSpacing: "-0.02em" }}>{STORE.name}</div>
            <div style={{ fontSize: 11.5, color: "#8A9C90" }}>{STORE.address}</div>
          </div>
        </div>
        <h2 style={{ fontSize: 16, margin: "18px 0 12px" }}>Sign in</h2>
        <Field label="Email"><input className="input" type="email" value={email} autoComplete="username" autoFocus onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password"><input className="input" type="password" value={pwd} autoComplete="current-password" onChange={(e) => setPwd(e.target.value)} /></Field>
        {err && <div style={{ color: "#C44536", fontSize: 13, marginBottom: 8 }}>{err}</div>}
        {info && <div style={{ color: "#1B5E43", fontSize: 13, marginBottom: 8 }}>{info}</div>}
        <button className="btn primary big" type="submit" style={{ width: "100%" }} disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <button type="button" onClick={reset} style={{ display: "block", background: "none", border: "none", color: "#1B5E43", fontSize: 12, marginTop: 10, cursor: "pointer", padding: 0 }}>Forgot password? Email me a reset link</button>
        <div style={{ fontSize: 11, color: "#8A9C90", marginTop: 12, lineHeight: 1.5 }}>
          Sign in with your shop account. Your data syncs live across every device that signs in.
        </div>
      </form>
    </div>
  );
}

// ---------- root: Firebase auth gate ----------
export default function App() {
  const [user, setUser] = useState(undefined); // undefined = checking, null = signed out
  useEffect(() => onAuthStateChanged(auth, setUser), []);
  if (user === undefined) {
    return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#10331F", color: "#BCD2C4", fontFamily: "system-ui, sans-serif" }}>Loading…</div>;
  }
  if (!user) return <Login />;
  return <StoreManager user={user} onLogout={() => signOut(auth)} />;
}

// ---------- main app ----------
function StoreManager({ user, onLogout }) {
  const [tab, setTab] = useState("dashboard");
  const [items, setItems] = useState([]);
  const [sales, setSales] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [logs, setLogs] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [toast, setToast] = useState(null);

  // ---- Realtime Database sync (live across every signed-in device) ----
  // Every record (item/sale/expense/log) lives at its own keyed node — shop/<slice>/<id> —
  // so concurrent edits from different devices to different records merge instead of
  // clobbering. Writes are field-level deltas; incoming snapshots are 3-way merged with any
  // un-pushed local edits. A localStorage cache gives instant first paint and offline reads.
  // See src/lib/sync.js for the array↔map bridge.
  const CACHE_KEY = "psm-cache-v1";
  const lastRemote = useRef({ items: {}, sales: {}, expenses: {}, logs: {} }); // last cloud map per slice
  const synced = useRef({ items: false, sales: false, expenses: false, logs: false });
  const seeded = useRef(false);
  const [online, setOnline] = useState(true);

  // Always-current local state, readable from inside async listeners (for the merge).
  const dataRef = useRef({ items, sales, expenses, logs });
  dataRef.current = { items, sales, expenses, logs };
  const notifyRef = useRef(null);

  // 1) Instant paint from the local cache.
  useEffect(() => {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (c) { setItems(c.items || []); setSales(c.sales || []); setExpenses(c.expenses || []); setLogs(c.logs || []); }
    } catch (e) { console.error("cache read failed", e); }
    setLoaded(true);
  }, []);

  // 2) Subscribe to the cloud; changes from any device flow in live.
  useEffect(() => {
    const slices = [["items", setItems], ["sales", setSales], ["expenses", setExpenses], ["logs", setLogs]];
    const unsubs = slices.map(([slice, setter]) =>
      subscribeSlice(
        slice,
        (val) => {
          // First run anywhere: seed the catalogue once, then write it to the cloud.
          if (slice === "items" && val === null) {
            if (seeded.current) { synced.current.items = true; return; }
            seeded.current = true;
            const map = toMap(SEED_ITEMS);
            lastRemote.current.items = map;
            synced.current.items = true;
            setItems(mapToArray("items", map));
            overwriteSlice("items", map).catch((e) => console.error("seed write failed", e));
            return;
          }
          const theirs = toMap(val);
          // One-time migration of legacy array / numeric-keyed data → keyed-by-id map.
          if (isLegacyShape(val, theirs)) {
            overwriteSlice(slice, theirs).catch((e) => console.error("migrate failed", slice, e));
          }
          // Reconcile the cloud snapshot with any local edits not yet pushed.
          const ours = toMap(dataRef.current[slice]);
          const merged = synced.current[slice]
            ? mergeRemote(lastRemote.current[slice], theirs, ours)
            : theirs;
          lastRemote.current[slice] = theirs;
          synced.current[slice] = true;
          setter(mapToArray(slice, merged));
        },
        (err) => {
          console.error("sync read failed", slice, err);
          notifyRef.current?.("⚠ Cloud sync error — check your connection or account access.");
        }
      )
    );
    const unsubConn = subscribeConnection(setOnline);
    return () => { unsubs.forEach((u) => u()); unsubConn(); };
  }, []);

  // 3) Push field-level deltas to the cloud when a slice changes locally (after the first
  //    cloud snapshot). buildSliceUpdate skips no-op echoes, so this is loop-safe.
  const pushSlice = useCallback((slice, value) => {
    if (!synced.current[slice]) return; // don't write before we've read the cloud once
    const { updates, nextMap, changed } = buildSliceUpdate(lastRemote.current[slice], value);
    if (!changed) return;
    lastRemote.current[slice] = nextMap; // optimistic; the echo snapshot confirms it
    writeSlice(slice, updates).catch((e) => {
      console.error("sync write failed", slice, e);
      notify("⚠ Couldn't sync to cloud — saved on this device, will retry when back online.");
    });
  }, []);
  useEffect(() => { if (!loaded) return; const t = setTimeout(() => pushSlice("items", items), 300); return () => clearTimeout(t); }, [items, loaded, pushSlice]);
  useEffect(() => { if (!loaded) return; const t = setTimeout(() => pushSlice("sales", sales), 300); return () => clearTimeout(t); }, [sales, loaded, pushSlice]);
  useEffect(() => { if (!loaded) return; const t = setTimeout(() => pushSlice("expenses", expenses), 300); return () => clearTimeout(t); }, [expenses, loaded, pushSlice]);
  useEffect(() => { if (!loaded) return; const t = setTimeout(() => pushSlice("logs", logs), 300); return () => clearTimeout(t); }, [logs, loaded, pushSlice]);

  // 4) Mirror to a local cache (instant next paint + offline reads + no data loss on close).
  useEffect(() => {
    if (!loaded) return;
    const writeCache = () => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(dataRef.current)); } catch (e) { console.error("cache write failed", e); } };
    const t = setTimeout(writeCache, 400);
    const onHide = () => { if (document.visibilityState === "hidden") writeCache(); };
    window.addEventListener("beforeunload", writeCache);
    window.addEventListener("pagehide", writeCache);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      clearTimeout(t);
      window.removeEventListener("beforeunload", writeCache);
      window.removeEventListener("pagehide", writeCache);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [items, sales, expenses, logs, loaded]);

  const notify = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  };
  notifyRef.current = notify; // let the cloud listener surface errors via the same toast

  const resetMyPassword = async () => {
    if (!user?.email) return;
    if (!confirm(`Send a password reset link to ${user.email}?`)) return;
    try { await sendPasswordResetEmail(auth, user.email); notify("Reset link sent to " + user.email); }
    catch (e) { console.error("reset failed", e); notify("⚠ Could not send reset email."); }
  };

  // Append an entry to the global activity log (newest first; capped to protect storage).
  const addLog = (type, message) => {
    const now = new Date();
    setLogs((l) =>
      [
        {
          id: uid(),
          at: now.getTime(),
          date: todayStr(),
          time: now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
          type,
          message,
        },
        ...l,
      ].slice(0, 2000)
    );
  };

  const exportData = (fmt) => {
    const data = { items, sales, expenses, logs };
    const fname = `prakash-supermart-${todayStr()}.${fmt === "xlsx" ? "xlsx" : "json"}`;
    try {
      if (fmt === "xlsx") exportXlsx(data, fname);
      else exportJson(data, fname);
      addLog("backup", `Backup downloaded (${fmt.toUpperCase()})`);
      notify(`Backup downloaded (${fmt.toUpperCase()})`);
    } catch (err) {
      console.error("backup failed", err);
      notify("⚠ Could not create the backup file.");
    }
  };

  const importData = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-importing the same file later
    if (!f) return;
    try {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      const d = ext === "xlsx" || ext === "xls" ? await importXlsx(f) : JSON.parse(await f.text());
      if (!d || !Array.isArray(d.items)) throw new Error("bad file");
      if (!confirm("Restore this backup? It will REPLACE all current data on this device.")) return;
      setItems(d.items);
      setSales(Array.isArray(d.sales) ? d.sales : []);
      setExpenses(Array.isArray(d.expenses) ? d.expenses : []);
      setLogs(Array.isArray(d.logs) ? d.logs : []);
      addLog("backup", `Backup restored (${ext.toUpperCase()})`);
      notify("Backup restored");
    } catch (err) {
      console.error("restore failed", err);
      notify("⚠ That file is not a valid backup.");
    }
  };

  const lowStock = items.filter((i) => i.stock <= i.lowAt);
  const alertCount = lowStock.length + items.filter((i) => { const d = daysToExpiry(i); return d != null && d <= 30; }).length;

  return (
    <div className="app" style={S.app}>
      <style>{CSS}</style>
      {/* sidebar */}
      <nav className="nav" style={S.nav}>
        <div style={S.logo}>
          <img src={LOGO_SRC} alt="Prakash Super Mart" style={{ width: 42, height: 42, borderRadius: 10, objectFit: "contain", background: "#fff", padding: 2, flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 800, fontSize: 14.5, letterSpacing: "-0.02em" }}>{STORE.name}</div>
            <div style={{ fontSize: 10.5, color: "#9DB5A8", lineHeight: 1.3 }}>{STORE.address}</div>
          </div>
        </div>
        {[
          ["dashboard", "⌂", "Dashboard"],
          ["billing", "₹", "Billing (POS)"],
          ["inventory", "▦", "Inventory"],
          ["alerts", "⚠", "Alerts"],
          ["sales", "⊟", "Sales History"],
          ["finance", "∑", "Finance"],
          ["expense", "⊝", "Add Expense"],
          ["raw", "⇪", "Data Import"],
          ["barcode", "▥", "Barcode Creator"],
          ["logs", "❑", "Activity Log"],
        ].map(([k, ic, label]) => (
          <button key={k} className={"navbtn" + (tab === k ? " active" : "")} onClick={() => setTab(k)}>
            <span style={{ width: 22, display: "inline-block", textAlign: "center" }}>{ic}</span> {label}
            {k === "inventory" && lowStock.length > 0 && (
              <span style={S.badge}>{lowStock.length}</span>
            )}
            {k === "alerts" && alertCount > 0 && (
              <span style={S.badge}>{alertCount}</span>
            )}
          </button>
        ))}
        <div style={{ marginTop: "auto", padding: "8px 8px 4px" }}>
          <div style={{ fontSize: 10.5, color: "#6E8A7C", textTransform: "uppercase", letterSpacing: ".06em", padding: "0 6px 4px" }}>Backup</div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="navbtn" style={{ border: "1px solid #2A5A3E", justifyContent: "center" }} onClick={() => exportData("json")}>⬇ JSON</button>
            <button className="navbtn" style={{ border: "1px solid #2A5A3E", justifyContent: "center" }} onClick={() => exportData("xlsx")}>⬇ XLSX</button>
          </div>
          <label className="navbtn" style={{ border: "1px solid #2A5A3E", justifyContent: "center", cursor: "pointer", marginTop: 6 }}>
            ⬆ Restore (JSON / XLSX)
            <input type="file" accept=".json,.xlsx,.xls,application/json" onChange={importData} style={{ display: "none" }} />
          </label>
        </div>
        <div style={{ display: "flex", gap: 6, padding: "8px 8px 4px" }}>
          <button className="navbtn" style={{ border: "1px solid #2A5A3E", justifyContent: "center" }} onClick={resetMyPassword}>🔑 Reset</button>
          <button className="navbtn" style={{ border: "1px solid #2A5A3E", justifyContent: "center" }} onClick={onLogout}>⎋ Logout</button>
        </div>
        <div style={{ fontSize: 11, color: "#6E8A7C", padding: "6px 14px 8px" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: online ? "#3FB873" : "#C9803A", display: "inline-block" }} />
            {online ? "Online · syncing live" : "Offline · saved on this device"}
          </span>
          <br />
          {user?.email ? <>Signed in as {user.email}.<br /></> : null}Back up regularly.
        </div>
      </nav>

      {/* main */}
      <main className="main" style={S.main}>
        {!loaded ? (
          <div style={{ padding: 40, color: "#667" }}>Loading store data…</div>
        ) : tab === "dashboard" ? (
          <Dashboard items={items} sales={sales} lowStock={lowStock} goBilling={() => setTab("billing")} />
        ) : tab === "billing" ? (
          <Billing items={items} sales={sales} setItems={setItems} setSales={setSales} notify={notify} log={addLog} />
        ) : tab === "raw" ? (
          <RawData items={items} setItems={setItems} setSales={setSales} notify={notify} log={addLog} />
        ) : tab === "inventory" ? (
          <Inventory items={items} setItems={setItems} notify={notify} log={addLog} />
        ) : tab === "alerts" ? (
          <Alerts items={items} goInventory={() => setTab("inventory")} />
        ) : tab === "barcode" ? (
          <BarcodeCreator items={items} setItems={setItems} notify={notify} log={addLog} />
        ) : tab === "sales" ? (
          <SalesHistory sales={sales} items={items} setSales={setSales} setItems={setItems} notify={notify} log={addLog} />
        ) : tab === "finance" ? (
          <Finance sales={sales} expenses={expenses} />
        ) : tab === "expense" ? (
          <Expenses expenses={expenses} setExpenses={setExpenses} notify={notify} log={addLog} />
        ) : tab === "logs" ? (
          <Logs logs={logs} setLogs={setLogs} notify={notify} />
        ) : (
          <Dashboard items={items} sales={sales} lowStock={lowStock} goBilling={() => setTab("billing")} />
        )}
      </main>

      {toast && <div style={S.toast}>{toast}</div>}
    </div>
  );
}

// ---------- Dashboard ----------
function Dashboard({ items, sales, lowStock, goBilling }) {
  const [date, setDate] = useState(todayStr());
  const isToday = date === todayStr();
  const daySales = sales.filter((s) => s.date === date);
  const rev = money(daySales.reduce((a, s) => a + s.total, 0));
  const profit = money(daySales.reduce((a, s) => a + s.profit, 0));
  const stockValue = money(items.reduce((a, i) => a + i.buyPrice * i.stock, 0));
  const month = date.slice(0, 7);
  const monthRev = money(sales.filter((s) => s.date.startsWith(month)).reduce((a, s) => a + s.total, 0));
  const monthName = new Date(date + "T00:00").toLocaleDateString("en-IN", { month: "long" });
  const niceDate = new Date(date + "T00:00").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const trend = useMemo(() => {
    const d = new Date(); d.setDate(d.getDate() - 13);
    return buildSeries(sales, [], dateStr(d), todayStr());
  }, [sales]);

  return (
    <div>
      <Header title="Dashboard" sub={niceDate}>
        <label style={{ fontSize: 12, color: "#6B7E74" }}>
          View day{" "}
          <input type="date" className="input" style={{ width: "auto", marginLeft: 4 }} value={date} max={todayStr()} onChange={(e) => setDate(e.target.value)} />
        </label>
      </Header>
      <div style={S.cards}>
        <Card label={isToday ? "Today's sales" : "Sales (this day)"} value={INR(rev)} sub={daySales.length + " bills"} />
        <Card label={isToday ? "Today's profit" : "Profit (this day)"} value={INR(profit)} sub="after item cost" accent />
        <Card label={monthName + " revenue"} value={INR(monthRev)} sub="month to date" />
        <Card label="Stock value" value={INR(stockValue)} sub={items.length + " items (at cost)"} />
      </div>

      <div style={{ marginTop: 16 }}>
        <ChartCard title="Sales — last 14 days" height={200}>
          <AreaChart data={trend} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
            <defs>
              <linearGradient id="gDash" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#1B5E43" stopOpacity={0.35} /><stop offset="100%" stopColor="#1B5E43" stopOpacity={0.03} /></linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} interval="preserveStartEnd" minTickGap={16} />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Area type="monotone" dataKey="revenue" name="Revenue" stroke="#1B5E43" strokeWidth={2} fill="url(#gDash)" />
          </AreaChart>
        </ChartCard>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
        <section style={S.panel}>
          <div style={S.panelHead}>
            Low stock — reorder soon
            {lowStock.length > 0 && <span style={{ ...S.badge, position: "static", marginLeft: 8 }}>{lowStock.length}</span>}
          </div>
          {lowStock.length === 0 ? (
            <Empty text="All items are well stocked." />
          ) : (
            lowStock.slice(0, 8).map((i) => (
              <div key={i.id} style={S.row}>
                <span>{i.name}</span>
                <span style={{ color: "#C44536", fontWeight: 700 }}>{i.stock} {i.unit} left</span>
              </div>
            ))
          )}
        </section>
        <section style={S.panel}>
          <div style={S.panelHead}>{isToday ? "Recent bills" : "Bills on this day"}</div>
          {daySales.length === 0 ? (
            <Empty text={isToday ? "No bills yet today." : "No bills on this day."}>
              {isToday && <button className="btn primary" onClick={goBilling}>Start billing</button>}
            </Empty>
          ) : (
            [...daySales].reverse().slice(0, 8).map((s) => (
              <div key={s.id} style={S.row}>
                <span>{s.time} · {s.lines.length} items</span>
                <b>{INR(s.total)}</b>
              </div>
            ))
          )}
        </section>
      </div>
    </div>
  );
}

// ---------- Billing / POS ----------
function Billing({ items, sales, setItems, setSales, notify, log }) {
  const [q, setQ] = useState("");
  const [cart, setCart] = useState([]); // {id, name, icon, unit, sellPrice, buyPrice, qty}
  const [lastSale, setLastSale] = useState(null);
  const [saleDate, setSaleDate] = useState(todayStr()); // back-date a bill if needed
  const [pay, setPay] = useState("UPI"); // UPI | Cash | Udhari
  const [customer, setCustomer] = useState("");
  const searchRef = useRef(null);
  useEffect(() => searchRef.current?.focus(), []);

  // Units sold per item name — used to surface best-sellers first.
  const soldQty = useMemo(() => {
    const m = {};
    (sales || []).forEach((s) => (s.lines || []).forEach((l) => { m[l.name] = (m[l.name] || 0) + l.qty; }));
    return m;
  }, [sales]);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s) {
      return items
        .filter((i) => i.name.toLowerCase().includes(s) || (i.code || "").toLowerCase().includes(s))
        .slice(0, 12);
    }
    // No search: best-sellers (by units sold) first, then the rest.
    return [...items].sort((a, b) => (soldQty[b.name] || 0) - (soldQty[a.name] || 0)).slice(0, 12);
  }, [q, items, soldQty]);

  const add = (item) => {
    if (item.stock <= 0) return notify("Out of stock: " + item.name);
    const ex = cart.find((c) => c.id === item.id);
    if (ex && ex.qty + 1 > item.stock) return notify("Only " + item.stock + " " + item.unit + " in stock");
    // Functional update so rapid clicks / scanner input never read a stale cart.
    setCart((cart) => {
      const ex = cart.find((c) => c.id === item.id);
      return ex
        ? cart.map((c) => (c.id === item.id ? { ...c, qty: c.qty + 1 } : c))
        : [...cart, { id: item.id, name: item.name, icon: item.icon, unit: item.unit, sellPrice: item.sellPrice, buyPrice: item.buyPrice, qty: 1 }];
    });
  };
  const setQty = (id, qty) => {
    const stock = items.find((i) => i.id === id)?.stock ?? 0;
    if (qty > stock) { notify("Only " + stock + " in stock"); qty = stock; }
    const q = qty;
    setCart((cart) => (q <= 0 ? cart.filter((c) => c.id !== id) : cart.map((c) => (c.id === id ? { ...c, qty: q } : c))));
  };

  // Enter (or a barcode scanner, which types then sends Enter) adds the best match.
  const onSearchKey = (e) => {
    if (e.key !== "Enter" || results.length === 0) return;
    const code = q.trim().toLowerCase();
    const exact = results.find((i) => (i.code || "").toLowerCase() === code && code);
    add(exact || results[0]);
    setQ("");
  };

  const total = money(cart.reduce((a, c) => a + c.sellPrice * c.qty, 0));
  const profit = money(cart.reduce((a, c) => a + (c.sellPrice - c.buyPrice) * c.qty, 0));

  const completeSale = () => {
    if (cart.length === 0) return;
    const now = new Date();
    const backDated = saleDate !== todayStr();
    const sale = {
      id: uid(),
      date: saleDate,
      time: now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) + (backDated ? " (back-dated)" : ""),
      lines: cart.map((c) => ({ name: c.name, qty: c.qty, unit: c.unit, price: c.sellPrice, amount: money(c.sellPrice * c.qty) })),
      total, profit,
      payment: pay,
      ...(pay === "Udhari" && customer.trim() ? { customer: customer.trim() } : {}),
    };
    setSales((s) => [...s, sale]);
    setItems((its) => its.map((i) => {
      const c = cart.find((x) => x.id === i.id);
      return c ? removeStock(i, c.qty, saleDate) : i; // FIFO deplete batches by expiry
    }));
    setLastSale(sale);
    log("sale", `Bill ${INR(total)} · ${cart.length} item(s) · ${pay}` + (pay === "Udhari" && customer.trim() ? ` (${customer.trim()})` : "") + (backDated ? ` · back-dated to ${saleDate}` : ""));
    setCart([]);
    setQ("");
    setCustomer("");
    searchRef.current?.focus();
    notify(`Bill saved (${pay}) — ` + INR(total));
  };

  return (
    <div>
      <Header title="Billing" sub="Tap an item to add it to the bill">
        <label style={{ fontSize: 12, color: saleDate === todayStr() ? "#6B7E74" : "#C44536", fontWeight: 600 }}>
          Bill date{" "}
          <input type="date" className="input" style={{ width: "auto", marginLeft: 4 }} value={saleDate} max={todayStr()} onChange={(e) => setSaleDate(e.target.value || todayStr())} />
        </label>
      </Header>
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
        {/* item picker */}
        <section style={S.panel}>
          <input
            ref={searchRef}
            className="input"
            placeholder="Search or scan barcode… (Enter adds top match)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onSearchKey}
            aria-label="Search items or scan barcode"
            style={{ marginBottom: 12 }}
          />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {results.map((i) => (
              <button key={i.id} className="pick" onClick={() => add(i)} disabled={i.stock <= 0}>
                <div style={{ fontWeight: 700, fontSize: 13.5 }}><span style={{ marginRight: 5 }}>{i.icon || "📦"}</span>{i.name}{soldQty[i.name] ? <span style={{ color: "#E8A33D", fontSize: 11, marginLeft: 4 }} title="best-seller">★</span> : null}</div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 12.5 }}>
                  <span style={{ color: "#1B5E43", fontWeight: 800 }}>{INR(i.sellPrice)}<span style={{ color: "#8AA", fontWeight: 500 }}>/{i.unit}</span></span>
                  <span style={{ color: i.stock <= i.lowAt ? "#C44536" : "#789" }}>{i.stock <= 0 ? "Out of stock" : i.stock + " left"}</span>
                </div>
              </button>
            ))}
            {results.length === 0 && <Empty text="No items match. Add it from Inventory first." />}
          </div>
        </section>

        {/* receipt cart */}
        <section style={S.receipt}>
          <div style={S.receiptHead}>CURRENT BILL</div>
          {cart.length === 0 ? (
            <Empty text="Bill is empty. Tap items on the left to add.">
              {lastSale && (
                <button className="btn" onClick={() => printReceipt(lastSale)}>🖨 Print last bill · {INR(lastSale.total)}</button>
              )}
            </Empty>
          ) : (
            <>
              {cart.map((c) => (
                <div key={c.id} style={S.rcptLine}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}><span style={{ marginRight: 4 }}>{c.icon || "📦"}</span>{c.name}</div>
                    <div style={{ fontSize: 11.5, color: "#777" }}>{INR(c.sellPrice)} × {c.qty} {c.unit}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <button className="qty" aria-label={"Decrease " + c.name} onClick={() => setQty(c.id, c.qty - 1)}>−</button>
                    <span style={{ minWidth: 22, textAlign: "center", fontWeight: 700 }}>{c.qty}</span>
                    <button className="qty" aria-label={"Increase " + c.name} onClick={() => setQty(c.id, c.qty + 1)}>+</button>
                  </div>
                  <b style={{ width: 76, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{INR(c.sellPrice * c.qty)}</b>
                </div>
              ))}
              <div style={S.rcptTotal}>
                <span>TOTAL</span>
                <span>{INR(total)}</span>
              </div>
              <div style={{ fontSize: 12, color: "#1B5E43", textAlign: "right", marginTop: 2 }}>
                Profit on this bill: {INR(profit)}
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#6B7E74", textTransform: "uppercase", letterSpacing: ".05em", margin: "12px 0 4px" }}>Payment</div>
              <div style={{ display: "flex", gap: 6 }}>
                {["UPI", "Cash", "Udhari"].map((p) => (
                  <button key={p} className={"btn small " + (pay === p ? "primary" : "")} style={{ flex: 1 }} onClick={() => setPay(p)}>
                    {p === "UPI" ? "UPI" : p === "Cash" ? "Cash" : "Udhari"}
                  </button>
                ))}
              </div>
              {pay === "Udhari" && (
                <input className="input" style={{ marginTop: 8 }} placeholder="Customer name (paying later)" value={customer} onChange={(e) => setCustomer(e.target.value)} />
              )}
              {pay === "UPI" && (
                <div style={{ textAlign: "center", marginTop: 10, padding: 8, background: "#fff", border: "1px solid #E2EAE3", borderRadius: 10 }}>
                  <img src={PAYMENT_QR_SRC} alt="Scan to pay" style={{ width: 150, height: 150, objectFit: "contain" }} />
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: "#3A5547" }}>Scan to Pay · PhonePe / UPI</div>
                </div>
              )}
              <button className="btn primary big" onClick={completeSale} style={{ marginTop: 12, width: "100%" }}>
                Complete sale · {INR(total)} · {pay}
              </button>
              <button className="btn ghost" onClick={() => setCart([])} style={{ marginTop: 8, width: "100%" }}>
                Clear bill
              </button>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

// ---------- Inventory ----------
const blankItem = { name: "", code: "", category: CATEGORIES[0], unit: "pc", icon: "", buyPrice: "", sellPrice: "", mrp: "", stock: "", lowAt: 5, expiry: "" };

function Inventory({ items, setItems, notify, log }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("All");
  const [form, setForm] = useState(null); // null | {…item, id?}
  const [restock, setRestock] = useState(null); // {id, name, qty, expiry}
  const [open, setOpen] = useState(null); // expanded item id (batch detail)

  const filtered = items.filter((i) => {
    const term = q.trim().toLowerCase();
    return (
      (cat === "All" || i.category === cat) &&
      (i.name.toLowerCase().includes(term) || (i.code || "").toLowerCase().includes(term))
    );
  });

  const save = () => {
    const f = form;
    if (!f.name.trim()) return notify("Item name is required");
    const buy = +f.buyPrice, sell = +f.sellPrice, lowAt = +f.lowAt || 0;
    if (!(sell > 0)) return notify("Selling price must be more than 0");
    if (buy < 0 || sell < 0) return notify("Prices cannot be negative");
    const base = {
      name: f.name.trim(), code: (f.code || "").trim(), category: f.category, unit: f.unit,
      icon: (f.icon || "").trim() || iconFor(f.category), buyPrice: buy || 0, sellPrice: sell,
      mrp: +f.mrp || sell, lowAt,
    };
    if (f.id) {
      const prevStock = (items.find((i) => i.id === f.id)?.stock) || 0;
      const newStock = Math.max(0, +f.stock || 0);
      const diff = newStock - prevStock;
      // Functional updater so a live cloud snapshot landing mid-edit can't drop other items.
      setItems((list) => list.map((i) => {
        if (i.id !== f.id) return i;
        let updated = { ...i, ...base, updatedAt: todayStr() };
        // Reconcile batches with the edited stock: grow → new batch, shrink → FIFO deplete.
        if (diff > 0) updated = addBatch(updated, diff, f.expiry, todayStr());
        else if (diff < 0) updated = removeStock(updated, -diff, todayStr());
        return updated;
      }));
      log("inventory", `Edited item “${base.name}”` + (diff ? ` · stock ${prevStock}→${newStock}` : ""));
      notify("Item updated");
    } else {
      const stock = +f.stock || 0;
      const batches = stock > 0 ? [{ id: uid(), qty: stock, expiry: f.expiry || "", addedOn: todayStr() }] : [];
      const newItem = { ...base, id: uid(), stock, batches, createdAt: todayStr() };
      setItems((list) => [...list, newItem]);
      log("inventory", `Added item “${base.name}” · ${stock} ${base.unit} @ ${INR(sell)}` + (f.expiry ? ` (exp ${f.expiry})` : ""));
      notify("Item added to inventory");
    }
    setForm(null);
  };

  const doRestock = () => {
    const qty = +restock.qty;
    if (!(qty > 0)) return notify("Enter quantity to add");
    setItems((list) => list.map((i) => (i.id === restock.id ? addBatch(i, qty, restock.expiry, todayStr()) : i)));
    log("inventory", `Restocked “${restock.name}” +${qty}` + (restock.expiry ? ` (exp ${restock.expiry})` : ""));
    setRestock(null);
    notify("Stock added");
  };

  const del = (i) => {
    if (!confirm("Delete " + i.name + "?")) return;
    setItems((list) => list.filter((x) => x.id !== i.id));
    log("inventory", `Deleted item “${i.name}”`);
  };

  const stop = (e) => e.stopPropagation();

  return (
    <div>
      <Header title="Inventory" sub={items.length + " items · click a row to see batches & expiry"}>
        <button className="btn primary" onClick={() => setForm({ ...blankItem })}>+ Add item</button>
      </Header>

      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        <input className="input" placeholder="Find an item…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        <select className="input" value={cat} onChange={(e) => setCat(e.target.value)} style={{ width: 220 }}>
          <option>All</option>
          {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>

      <section style={S.panel}>
        <table className="tbl">
          <thead>
            <tr><th>Item</th><th>Category</th><th>Added</th><th style={{ textAlign: "right" }}>Buy</th><th style={{ textAlign: "right" }}>Sell</th><th style={{ textAlign: "right" }}>Margin</th><th style={{ textAlign: "right" }}>Stock</th><th></th></tr>
          </thead>
          <tbody>
            {filtered.map((i) => {
              const dte = daysToExpiry(i);
              const isOpen = open === i.id;
              return (
                <Fragment key={i.id}>
                  <tr style={{ cursor: "pointer" }} onClick={() => setOpen(isOpen ? null : i.id)}>
                    <td style={{ fontWeight: 600 }}>
                      <span style={{ marginRight: 6 }}>{i.icon || "📦"}</span>{i.name}
                      {i.code ? <span style={{ color: "#9AA", fontWeight: 400, fontSize: 11 }}> · {i.code}</span> : null}
                      <span style={{ color: "#AAB", marginLeft: 6 }}>{isOpen ? "▾" : "▸"}</span>
                    </td>
                    <td style={{ color: "#677" }}>{i.category}</td>
                    <td style={{ color: "#789", whiteSpace: "nowrap", fontSize: 12.5 }}>{i.createdAt || "—"}{i.updatedAt && i.updatedAt !== i.createdAt ? <span title={"edited " + i.updatedAt}> ✎</span> : null}</td>
                    <td style={{ textAlign: "right" }}>{INR(i.buyPrice)}</td>
                    <td style={{ textAlign: "right", fontWeight: 700 }}>{INR(i.sellPrice)}</td>
                    <td style={{ textAlign: "right", color: "#1B5E43" }}>{i.buyPrice ? Math.round(((i.sellPrice - i.buyPrice) / i.buyPrice) * 100) + "%" : "—"}</td>
                    <td style={{ textAlign: "right", fontWeight: 700, color: i.stock <= i.lowAt ? "#C44536" : "#223" }}>
                      {i.stock} {i.unit}{i.stock <= i.lowAt && " ⚠"}
                      {dte != null && dte <= 30 && <div style={{ fontSize: 10.5, fontWeight: 600, color: dte < 0 ? "#C44536" : "#B0762A" }}>{dte < 0 ? "expired" : "exp in " + dte + "d"}</div>}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn small" onClick={(e) => { stop(e); setRestock({ id: i.id, name: i.name, qty: "", expiry: "" }); }}>Restock</button>{" "}
                      <button className="btn small ghost" onClick={(e) => { stop(e); setForm({ ...i, mrp: i.mrp ?? "", icon: i.icon || "", expiry: "" }); }}>Edit</button>{" "}
                      <button className="btn small danger" aria-label={"Delete " + i.name} onClick={(e) => { stop(e); del(i); }}>✕</button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={8} style={{ background: "#F7FAF7" }}>
                        {i.batches && i.batches.length ? (
                          <table className="tbl" style={{ margin: 0 }}>
                            <thead><tr><th style={{ width: 120 }}>Batch qty</th><th style={{ width: 160 }}>Expiry</th><th>Date added</th></tr></thead>
                            <tbody>
                              {[...i.batches].sort(batchSort).map((b) => {
                                const bd = b.expiry ? Math.round((new Date(b.expiry + "T00:00") - new Date(todayStr() + "T00:00")) / 86400000) : null;
                                const col = bd == null ? "#677" : bd < 0 ? "#C44536" : bd <= 30 ? "#B0762A" : "#677";
                                return (
                                  <tr key={b.id}>
                                    <td style={{ fontWeight: 700 }}>{b.qty} {i.unit}</td>
                                    <td style={{ color: col, fontWeight: bd != null && bd <= 30 ? 700 : 400 }}>{b.expiry || "— no expiry —"}{bd != null && bd <= 30 ? (bd < 0 ? " (expired)" : ` (${bd}d left)`) : ""}</td>
                                    <td style={{ color: "#677" }}>{b.addedOn}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        ) : (
                          <div style={{ padding: "8px 4px", color: "#8A9", fontSize: 13 }}>No batch / expiry detail yet — add stock via <b>Restock</b> to record expiry dates.</div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {filtered.length === 0 && <tr><td colSpan={8}><Empty text="No items found." /></td></tr>}
          </tbody>
        </table>
      </section>

      {form && (
        <Modal title={form.id ? "Edit item" : "Add new item"} onClose={() => setForm(null)}>
          <Field label="Item name"><input className="input" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Amul Butter 100g" /></Field>
          <Field label="Barcode / code (optional)"><input className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="Scan or type a barcode" /></Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Category">
              <select className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Unit">
              <select className="input" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}>
                {UNITS.map((u) => <option key={u}>{u}</option>)}
              </select>
            </Field>
            <Field label="Icon (emoji)"><input className="input" value={form.icon} onChange={(e) => setForm({ ...form, icon: e.target.value })} placeholder={iconFor(form.category)} /></Field>
            <Field label="MRP (₹)"><input className="input" type="number" min="0" step="0.01" value={form.mrp} onChange={(e) => setForm({ ...form, mrp: e.target.value })} /></Field>
            <Field label="Buying price (₹)"><input className="input" type="number" min="0" step="0.01" value={form.buyPrice} onChange={(e) => setForm({ ...form, buyPrice: e.target.value })} /></Field>
            <Field label="Selling price (₹)"><input className="input" type="number" min="0" step="0.01" value={form.sellPrice} onChange={(e) => setForm({ ...form, sellPrice: e.target.value })} /></Field>
            <Field label={form.id ? "Stock quantity" : "Opening stock"}><input className="input" type="number" min="0" value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} /></Field>
            <Field label={form.id ? "Expiry (for added stock)" : "Expiry (optional)"}><input className="input" type="date" value={form.expiry} onChange={(e) => setForm({ ...form, expiry: e.target.value })} /></Field>
            <Field label="Alert when stock below"><input className="input" type="number" min="0" value={form.lowAt} onChange={(e) => setForm({ ...form, lowAt: e.target.value })} /></Field>
          </div>
          {form.id && <div style={{ fontSize: 12, color: "#6B7E74", marginTop: 8 }}>Changing stock here adjusts batches automatically (increase adds a batch using the expiry above; decrease removes earliest-expiry stock first). For a specific dated batch, use <b>Restock</b>.</div>}
          <button className="btn primary big" style={{ width: "100%", marginTop: 14 }} onClick={save}>
            {form.id ? "Save changes" : "Add item"}
          </button>
        </Modal>
      )}

      {restock && (
        <Modal title={"Restock — " + restock.name} onClose={() => setRestock(null)}>
          <Field label="Quantity to add">
            <input className="input" type="number" min="0" autoFocus value={restock.qty} onChange={(e) => setRestock({ ...restock, qty: e.target.value })} />
          </Field>
          <Field label="Expiry date (optional)">
            <input className="input" type="date" value={restock.expiry} onChange={(e) => setRestock({ ...restock, expiry: e.target.value })} />
          </Field>
          <button className="btn primary big" style={{ width: "100%", marginTop: 12 }} onClick={doRestock}>Add stock</button>
        </Modal>
      )}
    </div>
  );
}

// ---------- Barcode Creator ----------
// Format a YYYY-MM-DD date as MM/YY for compact shelf labels.
const mmYY = (ds) => {
  if (!ds) return "";
  const [y, m] = ds.split("-");
  return m && y ? `${m}/${y.slice(2)}` : "";
};
const LABEL_SIZES = {
  "38x25": { w: 38, h: 25, label: "38 × 25 mm (small)" },
  "50x30": { w: 50, h: 30, label: "50 × 30 mm (medium)" },
  "65x38": { w: 65, h: 38, label: "65 × 38 mm (large)" },
};

// Generate a code valid for the chosen symbology.
function genCode(format) {
  if (format === "EAN13") {
    let base = "890"; // GS1 India prefix
    for (let i = 0; i < 9; i++) base += Math.floor(Math.random() * 10);
    const d = base.split("").map(Number);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += d[i] * (i % 2 === 0 ? 1 : 3);
    return base + ((10 - (sum % 10)) % 10);
  }
  let s = "";
  for (let i = 0; i < 9; i++) s += Math.floor(Math.random() * 10);
  return "PSM" + s;
}

function barcodeDataUrl(value, format) {
  const canvas = document.createElement("canvas");
  JsBarcode(canvas, value, { format, width: 2, height: 60, fontSize: 16, margin: 6, displayValue: true });
  return canvas.toDataURL("image/png");
}

function BarcodeCreator({ items, setItems, notify, log }) {
  const [itemId, setItemId] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState(genCode("CODE128"));
  const [format, setFormat] = useState("CODE128");
  const [mrp, setMrp] = useState("");
  const [sell, setSell] = useState("");
  const [pkd, setPkd] = useState(todayStr());
  const [exp, setExp] = useState("");
  const [qty, setQty] = useState(12);
  const [size, setSize] = useState("38x25");
  const [cw, setCw] = useState(40);
  const [ch, setCh] = useState(28);
  const [err, setErr] = useState(null);
  const svgRef = useRef(null);

  // Resolve the chosen label size (preset or custom width/height in mm).
  const sz = size === "custom"
    ? (() => { const w = Math.max(15, +cw || 40), h = Math.max(10, +ch || 28); return { w, h, label: `${w} × ${h} mm` }; })()
    : LABEL_SIZES[size];

  // Live barcode preview (re-rendered whenever the code or symbology changes).
  useEffect(() => {
    if (!svgRef.current) return;
    if (!code.trim()) { svgRef.current.innerHTML = ""; setErr(null); return; }
    try {
      JsBarcode(svgRef.current, code.trim(), { format, width: 2, height: 50, fontSize: 14, margin: 4, displayValue: true });
      setErr(null);
    } catch {
      setErr("This value isn't valid for " + format + (format === "EAN13" ? " — EAN-13 needs 12–13 digits." : "."));
    }
  }, [code, format]);

  const pickItem = (id) => {
    setItemId(id);
    const it = items.find((i) => i.id === id);
    if (!it) return;
    setName(it.name);
    if (it.sellPrice) setMrp(it.sellPrice);
    setSell(it.sellPrice || "");
    setCode(it.code ? it.code : genCode(format));
  };

  const saveToItem = () => {
    if (!itemId) return notify("Pick an inventory item first to save its barcode");
    if (!code.trim()) return notify("Nothing to save");
    setItems((list) => list.map((i) => (i.id === itemId ? { ...i, code: code.trim(), updatedAt: todayStr() } : i)));
    log("inventory", `Set barcode for “${name}” → ${code.trim()}`);
    notify("Barcode saved to item — it can now be scanned at billing");
  };

  const printLabels = () => {
    if (!code.trim()) return notify("Enter or generate a barcode first");
    let url;
    try { url = barcodeDataUrl(code.trim(), format); }
    catch { return notify("Invalid barcode value for " + format); }
    const n = Math.max(1, Math.min(300, +qty || 1));
    const priceLine = [mrp ? "MRP ₹" + escapeHtml(String(mrp)) : "", sell ? "Sell ₹" + escapeHtml(String(sell)) : ""].filter(Boolean).join("&nbsp;&nbsp;");
    const dateLine = [pkd ? "PKD " + mmYY(pkd) : "", exp ? "EXP " + mmYY(exp) : ""].filter(Boolean).join("&nbsp;&nbsp;");
    const one = `<div class="lbl">
      <div class="store">${escapeHtml(STORE.name)}</div>
      <div class="pname">${escapeHtml(name || "")}</div>
      <img src="${url}" />
      ${priceLine ? `<div class="price">${priceLine}</div>` : ""}
      <div class="dates">${dateLine}</div>
    </div>`;
    const w = window.open("", "_blank");
    if (!w) return notify("Allow pop-ups to print labels");
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Barcode labels</title>
      <style>
        @page { margin: 6mm; }
        body { margin:0; font-family: Arial, Helvetica, sans-serif; }
        .sheet { display:flex; flex-wrap:wrap; gap:2mm; }
        .lbl { width:${sz.w}mm; height:${sz.h}mm; box-sizing:border-box; border:1px dashed #c8c8c8;
               padding:1mm 1.5mm; display:flex; flex-direction:column; align-items:center;
               justify-content:space-between; overflow:hidden; text-align:center; }
        .store { font-size:6pt; font-weight:bold; color:#10331F; line-height:1; }
        .pname { font-size:7.5pt; font-weight:bold; line-height:1.05; max-height:2.3em; overflow:hidden; }
        .lbl img { max-width:100%; height:auto; flex:0 0 auto; }
        .price { font-size:8pt; font-weight:bold; line-height:1; }
        .dates { font-size:5.5pt; color:#333; line-height:1; }
        @media print { .lbl { border-color:#e5e5e5; } }
      </style></head><body>
      <div class="sheet">${one.repeat(n)}</div>
      <script>window.onload=function(){window.print()}</scr` + `ipt>
      </body></html>`);
    w.document.close();
    log("inventory", `Printed ${n} barcode label(s) for “${name || code.trim()}”`);
    notify(`Opened ${n} label(s) for printing`);
  };

  const addExpiry = (days) => {
    const d = new Date((pkd || todayStr()) + "T00:00");
    d.setDate(d.getDate() + days);
    setExp(dateStr(d));
  };

  return (
    <div>
      <Header title="Barcode Creator" sub="Generate scannable barcode labels to paste on shelf items" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <section style={S.panel}>
          <div style={S.panelHead}>Label details</div>

          <Field label="From inventory (optional)">
            <select className="input" value={itemId} onChange={(e) => pickItem(e.target.value)}>
              <option value="">— manual entry —</option>
              {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </Field>

          <Field label="Product name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Amul Butter 100g" /></Field>

          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "end" }}>
            <Field label="Barcode value"><input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Scan, type, or generate" /></Field>
            <button className="btn" style={{ marginBottom: 10 }} onClick={() => setCode(genCode(format))}>Generate</button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Symbology">
              <select className="input" value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="CODE128">Code 128 (any text)</option>
                <option value="EAN13">EAN-13 (13 digits)</option>
              </select>
            </Field>
            <Field label="MRP (₹)"><input className="input" type="number" min="0" step="0.01" value={mrp} onChange={(e) => setMrp(e.target.value)} /></Field>
            <Field label="Selling price (₹)"><input className="input" type="number" min="0" step="0.01" value={sell} onChange={(e) => setSell(e.target.value)} /></Field>
            <Field label="Packaged date"><input className="input" type="date" max={todayStr()} value={pkd} onChange={(e) => setPkd(e.target.value)} /></Field>
            <Field label="Expiry date"><input className="input" type="date" value={exp} onChange={(e) => setExp(e.target.value)} /></Field>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: -2, marginBottom: 12 }}>
            <span style={{ fontSize: 11.5, color: "#6B7E74", alignSelf: "center" }}>Expiry quick-set:</span>
            {[["1w", 7], ["1m", 30], ["3m", 90], ["6m", 180], ["1y", 365]].map(([lbl, d]) => (
              <button key={lbl} className="btn small ghost" onClick={() => addExpiry(d)}>+{lbl}</button>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Label size">
              <select className="input" value={size} onChange={(e) => setSize(e.target.value)}>
                {Object.entries(LABEL_SIZES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                <option value="custom">Custom…</option>
              </select>
            </Field>
            <Field label="How many labels"><input className="input" type="number" min="1" max="300" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
          </div>
          {size === "custom" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="Width (mm)"><input className="input" type="number" min="15" max="200" value={cw} onChange={(e) => setCw(e.target.value)} /></Field>
              <Field label="Height (mm)"><input className="input" type="number" min="10" max="200" value={ch} onChange={(e) => setCh(e.target.value)} /></Field>
            </div>
          )}

          {err && <div style={{ color: "#C44536", fontSize: 13, marginTop: 4 }}>{err}</div>}
          {itemId && <button className="btn ghost" style={{ width: "100%", marginTop: 8 }} onClick={saveToItem}>Save this barcode to the inventory item</button>}
        </section>

        <section style={S.panel}>
          <div style={S.panelHead}>Label preview</div>
          <div style={{ display: "grid", placeItems: "center", padding: "10px 0 16px" }}>
            <div style={{
              width: 230, minHeight: 130, border: "1px dashed #cfcfcf", borderRadius: 6, padding: "8px 10px",
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "space-between", textAlign: "center", background: "#fff",
            }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "#10331F" }}>{STORE.name}</div>
              <div style={{ fontSize: 12.5, fontWeight: 700, lineHeight: 1.1 }}>{name || <span style={{ color: "#AAB" }}>Product name</span>}</div>
              <svg ref={svgRef} style={{ maxWidth: "100%" }} />
              {(mrp || sell) ? (
                <div style={{ fontSize: 12, fontWeight: 800 }}>
                  {mrp ? "MRP ₹" + mrp : ""}{mrp && sell ? " · " : ""}{sell ? "Sell ₹" + sell : ""}
                </div>
              ) : null}
              <div style={{ fontSize: 9, color: "#445" }}>{pkd ? "PKD " + mmYY(pkd) : ""}{exp ? "  EXP " + mmYY(exp) : ""}</div>
            </div>
          </div>
          <button className="btn primary big" style={{ width: "100%" }} disabled={!code.trim() || !!err} onClick={printLabels}>
            🖨 Print {Math.max(1, Math.min(300, +qty || 1))} label(s) · {sz.label.split(" (")[0]}
          </button>
          <div style={{ fontSize: 11.5, color: "#8A9C90", marginTop: 10, lineHeight: 1.5 }}>
            Labels print as a tiled sheet at true millimetre size with dashed cut guides — set your printer to 100% / “Actual size” (not “Fit”). Saving the barcode to an item lets the cashier scan it on the Billing screen.
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------- Raw Data Record (file import / paste) ----------
const RAW_ACCEPT = ".txt,.csv,.tsv,.xls,.xlsx,.pdf,.json";
function RawData({ items, setItems, setSales, notify, log }) {
  const [mode, setMode] = useState("inventory"); // "inventory" | "sales"
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [raw, setRaw] = useState("");
  const [source, setSource] = useState("");
  const [saleDate, setSaleDate] = useState(todayStr());

  const loadRows = (parsed, srcLabel) => {
    if (!parsed || parsed.length === 0) {
      setErr("No rows found. Make sure the data has item names and numbers — or add rows manually below.");
      return;
    }
    setErr(null);
    setRows(parsed);
    setSource(srcLabel);
    notify(`${parsed.length} row(s) loaded — review, edit, then submit`);
  };

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setBusy(true); setErr(null);
    try {
      loadRows(await parseFile(f), f.name);
    } catch (ex) {
      console.error(ex);
      setErr("Could not read that file. Supported types: txt, csv, tsv, xls, xlsx, pdf, json.");
    }
    setBusy(false);
  };

  const processPaste = () => {
    if (!raw.trim()) return setErr("Paste some data into the box first.");
    try {
      loadRows(parseRawText(raw), "pasted text");
    } catch (ex) {
      console.error(ex);
      setErr("Could not parse that text.");
    }
  };

  const addRow = () => setRows([...(rows || []), { name: "", qty: 1, unit: "pc", buyPrice: "", sellPrice: "", amount: "" }]);
  const edit = (i, k, v) => setRows(rows.map((r, x) => (x === i ? { ...r, [k]: v } : r)));
  const drop = (i) => setRows(rows.filter((_, x) => x !== i));
  const reset = () => { setRows(null); setRaw(""); setSource(""); setErr(null); };

  // Collapse duplicate rows (same name) into one entry so quantities sum instead
  // of one row clobbering another. Returns a Map keyed by lowercased name.
  const aggregateRows = () => {
    const agg = new Map();
    rows.forEach((r) => {
      const key = r.name.trim().toLowerCase();
      if (!key) return;
      const buy = +r.buyPrice || 0, sell = +r.sellPrice || 0, qty = +r.qty || 0, amount = +r.amount || 0;
      const prev = agg.get(key);
      if (prev) {
        prev.qty += qty; prev.amount += amount;
        if (buy) prev.buy = buy;
        if (sell) prev.sell = sell;
      } else {
        agg.set(key, { name: r.name.trim(), unit: r.unit, qty, amount, buy, sell });
      }
    });
    return agg;
  };

  const commitInventory = () => {
    const counts = aggregateRows();
    const names = new Set(items.map((i) => i.name.toLowerCase()));
    let added = 0, updated = 0;
    counts.forEach((_, key) => (names.has(key) ? updated++ : added++));
    // Functional updater (rebuilds the aggregate per call so it stays correct even if a live
    // cloud snapshot changed `items` since the import was previewed). Always NEW objects.
    setItems((list) => {
      const agg = aggregateRows();
      const next = list.map((i) => {
        const a = agg.get(i.name.toLowerCase());
        if (!a) return i;
        agg.delete(i.name.toLowerCase());
        return { ...addBatch(i, a.qty, "", todayStr()), buyPrice: a.buy || i.buyPrice, sellPrice: a.sell || i.sellPrice };
      });
      agg.forEach((a) => {
        const sell = a.sell || (a.buy ? Math.round(a.buy * 1.15) : 0);
        next.push({
          id: uid(), name: a.name, code: "", category: "Other", unit: a.unit, icon: iconFor("Other"),
          buyPrice: a.buy, sellPrice: sell, mrp: sell, stock: a.qty, lowAt: 5,
          batches: a.qty > 0 ? [{ id: uid(), qty: a.qty, expiry: "", addedOn: todayStr() }] : [], createdAt: todayStr(),
        });
      });
      return next;
    });
    log("import", `Imported to inventory (${source || "manual"}): ${added} new, ${updated} restocked`);
    reset();
    notify(`Inventory updated — ${added} new, ${updated} restocked`);
  };

  const commitSales = () => {
    const agg = aggregateRows();
    let profit = 0, total = 0;
    const lines = [...agg.values()].map((a) => {
      total += a.amount;
      const ex = items.find((i) => i.name.toLowerCase() === a.name.toLowerCase());
      if (ex) profit += a.amount - ex.buyPrice * a.qty;
      return { name: a.name, qty: a.qty, unit: ex?.unit || "pc", price: a.qty ? money(a.amount / a.qty) : a.amount, amount: money(a.amount) };
    });
    total = money(total); profit = money(profit);
    const now = new Date();
    setSales((s) => [...s, {
      id: uid(), date: saleDate || todayStr(),
      time: now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) + " (imported)",
      lines, total, profit,
    }]);
    setItems((its) => its.map((i) => {
      const a = agg.get(i.name.toLowerCase());
      return a ? removeStock(i, a.qty, todayStr()) : i;
    }));
    log("import", `Imported sale ${INR(total)} · ${lines.length} line(s) (${source || "manual"})`);
    reset();
    notify("Sale recorded — " + INR(total));
  };

  return (
    <div>
      <Header title="Data Import" sub="Import a file or paste data — then review, edit, and submit">
        {rows && <button className="btn ghost small" onClick={reset}>Start over</button>}
      </Header>

      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <button className={"btn " + (mode === "inventory" ? "primary" : "")} onClick={() => setMode("inventory")}>
          ➕ Add to inventory
        </button>
        <button className={"btn " + (mode === "sales" ? "primary" : "")} onClick={() => setMode("sales")}>
          🧾 Record a sale
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 16 }}>
        <section style={S.panel}>
          <div style={S.panelHead}>1 · Provide data</div>
          <label className="btn primary" style={{ display: "block", textAlign: "center", padding: "14px", cursor: "pointer", opacity: busy ? 0.6 : 1 }}>
            {busy ? "Reading file…" : "📂 Choose a file"}
            <input type="file" accept={RAW_ACCEPT} onChange={onFile} disabled={busy} style={{ display: "none" }} />
          </label>
          <div style={{ fontSize: 11.5, color: "#8A9C90", margin: "8px 0 14px", textAlign: "center" }}>
            txt · csv · tsv · xls · xlsx · pdf · json
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#465", marginBottom: 6 }}>…or paste data</div>
          <textarea
            className="input"
            rows={6}
            placeholder={mode === "inventory"
              ? "name, qty, buy, sell\nParle-G, 24, 8, 10\nLay's, 40, 16, 20"
              : "name, qty, amount\nParle-G, 5, 50\nLay's, 3, 60"}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            style={{ resize: "vertical", fontFamily: "monospace", fontSize: 12.5 }}
          />
          <button className="btn" style={{ width: "100%", marginTop: 8 }} onClick={processPaste}>Process pasted data</button>
          {err && <div style={{ color: "#C44536", fontSize: 13, marginTop: 10 }}>{err}</div>}
          <div style={{ fontSize: 11.5, color: "#8A9C90", marginTop: 12, lineHeight: 1.5 }}>
            Columns are auto-detected from headers (name / qty / buy / sell / amount). No headers? Columns are read left-to-right as name, qty, price.
          </div>
        </section>

        <section style={S.panel}>
          <div style={S.panelHead}>
            2 · Review &amp; edit{source ? <span style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0, color: "#8A9C90", marginLeft: 8 }}>from {source}</span> : null}
            <button className="btn small ghost" style={{ marginLeft: "auto" }} onClick={addRow}>+ Add row</button>
          </div>
          {!rows ? (
            <Empty text={busy ? "Reading…" : "Imported rows appear here. You can also build a list by hand with “+ Add row”."} />
          ) : (
            <>
              {mode === "sales" && (
                <label style={{ fontSize: 12, color: "#6B7E74", display: "block", marginBottom: 10 }}>
                  Sale date <input type="date" className="input" style={{ width: "auto", marginLeft: 6 }} value={saleDate} max={todayStr()} onChange={(e) => setSaleDate(e.target.value || todayStr())} />
                </label>
              )}
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Item</th><th style={{ width: 58 }}>Qty</th>
                    {mode === "inventory"
                      ? (<><th style={{ width: 72 }}>Unit</th><th style={{ width: 78 }}>Buy ₹</th><th style={{ width: 78 }}>Sell ₹</th></>)
                      : (<th style={{ width: 96 }}>Amount ₹</th>)}
                    <th style={{ width: 30 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td><input className="input" style={{ padding: "6px 8px" }} value={r.name} onChange={(e) => edit(i, "name", e.target.value)} /></td>
                      <td><input className="input" style={{ padding: "6px 8px" }} type="number" min="0" value={r.qty} onChange={(e) => edit(i, "qty", +e.target.value)} /></td>
                      {mode === "inventory" ? (
                        <>
                          <td>
                            <select className="input" style={{ padding: "6px 4px" }} value={r.unit} onChange={(e) => edit(i, "unit", e.target.value)}>
                              {UNITS.map((u) => <option key={u}>{u}</option>)}
                            </select>
                          </td>
                          <td><input className="input" style={{ padding: "6px 8px" }} type="number" min="0" step="0.01" value={r.buyPrice} onChange={(e) => edit(i, "buyPrice", e.target.value)} /></td>
                          <td><input className="input" style={{ padding: "6px 8px" }} type="number" min="0" step="0.01" value={r.sellPrice} onChange={(e) => edit(i, "sellPrice", e.target.value)} /></td>
                        </>
                      ) : (
                        <td><input className="input" style={{ padding: "6px 8px" }} type="number" min="0" step="0.01" value={r.amount} onChange={(e) => edit(i, "amount", e.target.value)} /></td>
                      )}
                      <td><button className="btn small danger" aria-label="Remove row" onClick={() => drop(i)}>✕</button></td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={mode === "inventory" ? 6 : 4}><Empty text="No rows yet — click “+ Add row”." /></td></tr>}
                </tbody>
              </table>
              <div style={{ fontSize: 12, color: "#6B7E74", margin: "10px 0" }}>
                {mode === "inventory"
                  ? "Existing names get restocked; new names create items (blank sell = buy + 15%)."
                  : "Matched item names reduce stock automatically; unmatched lines still record as revenue."}
              </div>
              <button className="btn primary big" style={{ width: "100%" }} disabled={rows.length === 0} onClick={mode === "inventory" ? commitInventory : commitSales}>
                {mode === "inventory" ? `Add ${rows.length} item(s) to inventory` : `Record sale · ${rows.length} line(s)`}
              </button>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

// ---------- Sales history ----------
const PAY_COLORS = { UPI: "#2A6FB0", Cash: "#1B5E43", Udhari: "#C44536" };

function SalesHistory({ sales, items, setSales, setItems, notify, log }) {
  const [open, setOpen] = useState(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [editing, setEditing] = useState(null); // { id, date, payment, lines:[...], orig:[...] }

  const visible = sales.filter((s) => (!from || s.date >= from) && (!to || s.date <= to));
  const byDate = useMemo(() => {
    const m = {};
    [...visible].reverse().forEach((s) => { (m[s.date] = m[s.date] || []).push(s); });
    return Object.entries(m).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [visible]);
  const rangeTotal = money(visible.reduce((a, s) => a + s.total, 0));

  // Adjust stock by per-item-name deltas (positive = sell more → remove; negative = add back).
  const applyDeltas = (deltas) => {
    setItems((its) => its.map((i) => {
      const d = deltas[i.name.toLowerCase()];
      if (!d) return i;
      return d > 0 ? removeStock(i, d, todayStr()) : addBatch(i, -d, "", todayStr());
    }));
  };

  const deleteSale = (s) => {
    if (!confirm(`Delete this ${INR(s.total)} bill from ${s.date}? Stock will be added back.`)) return;
    const deltas = {};
    s.lines.forEach((l) => { deltas[l.name.toLowerCase()] = (deltas[l.name.toLowerCase()] || 0) - l.qty; });
    applyDeltas(deltas);
    setSales((all) => all.filter((x) => x.id !== s.id));
    log("sale", `Deleted bill ${INR(s.total)} (${s.date}) — stock restored`);
    notify("Bill deleted, stock restored");
  };

  const openEdit = (s) => setEditing({
    id: s.id, date: s.date, payment: s.payment || "UPI",
    lines: s.lines.map((l) => ({ ...l })), orig: s.lines.map((l) => ({ ...l })),
  });
  const editLine = (idx, qty) => setEditing((e) => ({ ...e, lines: e.lines.map((l, i) => (i === idx ? { ...l, qty: Math.max(0, qty || 0) } : l)) }));
  const removeLine = (idx) => setEditing((e) => ({ ...e, lines: e.lines.filter((_, i) => i !== idx) }));
  const editTotal = editing ? money(editing.lines.reduce((a, l) => a + l.price * l.qty, 0)) : 0;

  const saveEdit = () => {
    const newLines = editing.lines.filter((l) => l.qty > 0).map((l) => ({ ...l, amount: money(l.price * l.qty) }));
    if (newLines.length === 0) return notify("A bill needs at least one line — use Delete instead");
    const total = money(newLines.reduce((a, l) => a + l.amount, 0));
    const buyOf = (name) => items.find((i) => i.name.toLowerCase() === name.toLowerCase())?.buyPrice || 0;
    const profit = money(newLines.reduce((a, l) => a + (l.price - buyOf(l.name)) * l.qty, 0));
    const oldQ = {}, newQ = {};
    editing.orig.forEach((l) => { const k = l.name.toLowerCase(); oldQ[k] = (oldQ[k] || 0) + l.qty; });
    newLines.forEach((l) => { const k = l.name.toLowerCase(); newQ[k] = (newQ[k] || 0) + l.qty; });
    const deltas = {};
    [...new Set([...Object.keys(oldQ), ...Object.keys(newQ)])].forEach((k) => { const d = (newQ[k] || 0) - (oldQ[k] || 0); if (d) deltas[k] = d; });
    applyDeltas(deltas);
    setSales((all) => all.map((x) => (x.id === editing.id ? { ...x, date: editing.date || x.date, payment: editing.payment, lines: newLines, total, profit } : x)));
    log("sale", `Edited bill → ${INR(total)} · ${newLines.length} line(s) · ${editing.payment}`);
    setEditing(null);
    notify("Bill updated");
  };

  return (
    <div>
      <Header title="Sales History" sub={`${visible.length} of ${sales.length} bills · ${INR(rangeTotal)}`} />

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12, color: "#6B7E74" }}>From <input type="date" className="input" style={{ width: "auto", marginLeft: 4 }} value={from} max={to || todayStr()} onChange={(e) => setFrom(e.target.value)} /></label>
        <label style={{ fontSize: 12, color: "#6B7E74" }}>To <input type="date" className="input" style={{ width: "auto", marginLeft: 4 }} value={to} max={todayStr()} onChange={(e) => setTo(e.target.value)} /></label>
        {(from || to) && <button className="btn ghost small" onClick={() => { setFrom(""); setTo(""); }}>Clear range</button>}
      </div>

      {sales.length === 0 && <section style={S.panel}><Empty text="No sales yet. Bills will appear here after you complete a sale." /></section>}
      {sales.length > 0 && visible.length === 0 && <section style={S.panel}><Empty text="No bills in this date range." /></section>}
      {byDate.map(([date, list]) => (
        <section key={date} style={{ ...S.panel, marginBottom: 14 }}>
          <div style={S.panelHead}>
            {new Date(date + "T00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
            <span style={{ marginLeft: "auto", fontWeight: 800 }}>{INR(list.reduce((a, s) => a + s.total, 0))}</span>
          </div>
          {list.map((s) => (
            <div key={s.id}>
              <div style={{ ...S.row, cursor: "pointer" }} onClick={() => setOpen(open === s.id ? null : s.id)}>
                <span>
                  {s.time} · {s.lines.length} item{s.lines.length > 1 ? "s" : ""}
                  {s.payment && <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 800, color: PAY_COLORS[s.payment] || "#789", border: `1px solid ${PAY_COLORS[s.payment] || "#bbb"}`, borderRadius: 6, padding: "0 6px" }}>{s.payment}{s.customer ? " · " + s.customer : ""}</span>}
                </span>
                <span><b>{INR(s.total)}</b> <span style={{ color: "#1B5E43", fontSize: 12 }}>(+{INR(s.profit)})</span> {open === s.id ? "▾" : "▸"}</span>
              </div>
              {open === s.id && (
                <div style={{ background: "#F4F7F4", borderRadius: 8, padding: "8px 12px", margin: "0 0 8px" }}>
                  {s.lines.map((l, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "3px 0" }}>
                      <span>{l.name} × {l.qty}</span><span>{INR(l.amount)}</span>
                    </div>
                  ))}
                  <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                    <button className="btn small" onClick={() => printReceipt(s)}>🖨 Print</button>
                    <button className="btn small ghost" onClick={() => openEdit(s)}>✎ Edit bill</button>
                    <button className="btn small danger" onClick={() => deleteSale(s)}>🗑 Delete</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </section>
      ))}

      {editing && (
        <Modal title="Edit bill" onClose={() => setEditing(null)}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Date"><input type="date" className="input" max={todayStr()} value={editing.date} onChange={(e) => setEditing({ ...editing, date: e.target.value })} /></Field>
            <Field label="Payment">
              <select className="input" value={editing.payment} onChange={(e) => setEditing({ ...editing, payment: e.target.value })}>
                {["UPI", "Cash", "Udhari"].map((p) => <option key={p}>{p}</option>)}
              </select>
            </Field>
          </div>
          <table className="tbl">
            <thead><tr><th>Item</th><th style={{ width: 70 }}>Qty</th><th style={{ textAlign: "right" }}>Amount</th><th style={{ width: 30 }}></th></tr></thead>
            <tbody>
              {editing.lines.map((l, idx) => (
                <tr key={idx}>
                  <td>{l.name}<div style={{ fontSize: 11, color: "#9AA" }}>{INR(l.price)}/{l.unit}</div></td>
                  <td><input className="input" style={{ padding: "6px 8px" }} type="number" min="0" value={l.qty} onChange={(e) => editLine(idx, +e.target.value)} /></td>
                  <td style={{ textAlign: "right", fontWeight: 700 }}>{INR(money(l.price * l.qty))}</td>
                  <td><button className="btn small danger" aria-label="Remove line" onClick={() => removeLine(idx)}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 800, marginTop: 10 }}><span>New total</span><span>{INR(editTotal)}</span></div>
          <div style={{ fontSize: 11.5, color: "#6B7E74", marginTop: 4 }}>Stock adjusts automatically for any quantity change.</div>
          <button className="btn primary big" style={{ width: "100%", marginTop: 12 }} onClick={saveEdit}>Save changes</button>
        </Modal>
      )}
    </div>
  );
}

// ---------- Alerts ----------
function Alerts({ items, goInventory }) {
  const [view, setView] = useState("low"); // low | out | expiring | expired
  const [cat, setCat] = useState("All");
  const byCat = (i) => cat === "All" || i.category === cat;

  const low = items.filter((i) => byCat(i) && i.stock <= i.lowAt).sort((a, b) => a.stock - b.stock);
  const out = low.filter((i) => i.stock <= 0);

  const expRows = [];
  items.filter(byCat).forEach((i) => (i.batches || []).forEach((b) => {
    if (!b.expiry) return;
    const d = Math.round((new Date(b.expiry + "T00:00") - new Date(todayStr() + "T00:00")) / 86400000);
    expRows.push({ item: i, b, d });
  }));
  const expiring = expRows.filter((r) => r.d >= 0 && r.d <= 30).sort((a, b) => a.d - b.d);
  const expired = expRows.filter((r) => r.d < 0).sort((a, b) => a.d - b.d);

  const tabs = [["low", "Low stock", low.length], ["out", "Out of stock", out.length], ["expiring", "Expiring ≤30d", expiring.length], ["expired", "Expired", expired.length]];
  const isStockView = view === "low" || view === "out";
  const stockList = view === "out" ? out : low;
  const expList = view === "expired" ? expired : expiring;

  return (
    <div>
      <Header title="Alerts" sub="Items running low (lowest stock first) and batches nearing or past expiry">
        <button className="btn ghost small" onClick={goInventory}>Go to inventory</button>
      </Header>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        {tabs.map(([k, lbl, n]) => (
          <button key={k} className={"btn small " + (view === k ? "primary" : "")} onClick={() => setView(k)}>
            {lbl} <b>({n})</b>
          </button>
        ))}
        <select className="input" style={{ width: "auto", marginLeft: "auto" }} value={cat} onChange={(e) => setCat(e.target.value)}>
          <option>All</option>
          {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>

      <section style={S.panel}>
        {isStockView ? (
          stockList.length === 0 ? (
            <Empty text="Nothing here — stock looks healthy." />
          ) : (
            <table className="tbl">
              <thead><tr><th>Item</th><th>Category</th><th style={{ textAlign: "right" }}>Stock</th><th style={{ textAlign: "right" }}>Alert below</th></tr></thead>
              <tbody>
                {stockList.map((i) => (
                  <tr key={i.id}>
                    <td style={{ fontWeight: 600 }}><span style={{ marginRight: 6 }}>{i.icon || "📦"}</span>{i.name}</td>
                    <td style={{ color: "#677" }}>{i.category}</td>
                    <td style={{ textAlign: "right", fontWeight: 800, color: i.stock <= 0 ? "#C44536" : "#B0762A" }}>{i.stock} {i.unit}</td>
                    <td style={{ textAlign: "right", color: "#789" }}>{i.lowAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          expList.length === 0 ? (
            <Empty text="No batches in this window." />
          ) : (
            <table className="tbl">
              <thead><tr><th>Item</th><th>Category</th><th style={{ textAlign: "right" }}>Batch qty</th><th>Expiry</th><th style={{ textAlign: "right" }}>Status</th></tr></thead>
              <tbody>
                {expList.map((r, idx) => (
                  <tr key={idx}>
                    <td style={{ fontWeight: 600 }}><span style={{ marginRight: 6 }}>{r.item.icon || "📦"}</span>{r.item.name}</td>
                    <td style={{ color: "#677" }}>{r.item.category}</td>
                    <td style={{ textAlign: "right", fontWeight: 700 }}>{r.b.qty} {r.item.unit}</td>
                    <td>{r.b.expiry}</td>
                    <td style={{ textAlign: "right", fontWeight: 700, color: r.d < 0 ? "#C44536" : "#B0762A" }}>{r.d < 0 ? `${-r.d}d ago` : `in ${r.d}d`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </section>
    </div>
  );
}

// ---------- Activity Log ----------
const LOG_COLORS = { sale: "#1B5E43", inventory: "#2A6FB0", expense: "#C44536", import: "#7A5AB0", backup: "#7A6A1E" };

function Logs({ logs, setLogs, notify }) {
  const [date, setDate] = useState(""); // "" = all dates
  const [type, setType] = useState("all");

  const filtered = logs.filter((l) => (!date || l.date === date) && (type === "all" || l.type === type));

  const clear = () => {
    if (confirm("Clear the entire activity log? This cannot be undone (it does not affect sales or stock).")) {
      setLogs([]);
      notify("Activity log cleared");
    }
  };

  return (
    <div>
      <Header title="Activity Log" sub={logs.length + " events recorded — every change is logged here"}>
        {logs.length > 0 && <button className="btn ghost small" onClick={clear}>Clear log</button>}
      </Header>

      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12, color: "#6B7E74" }}>Day <input type="date" className="input" style={{ width: "auto", marginLeft: 4 }} value={date} max={todayStr()} onChange={(e) => setDate(e.target.value)} /></label>
        <select className="input" style={{ width: 180 }} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="all">All activity</option>
          {LOG_TYPES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
        </select>
        {(date || type !== "all") && <button className="btn ghost small" onClick={() => { setDate(""); setType("all"); }}>Show all</button>}
      </div>

      <section style={S.panel}>
        {filtered.length === 0 ? (
          <Empty text={logs.length === 0 ? "No activity yet. Actions you take in the app will appear here." : "No activity matches this filter."} />
        ) : (
          <table className="tbl">
            <thead><tr><th style={{ width: 168 }}>When</th><th style={{ width: 96 }}>Type</th><th>Activity</th></tr></thead>
            <tbody>
              {filtered.map((l) => (
                <tr key={l.id}>
                  <td style={{ whiteSpace: "nowrap", color: "#677" }}>{l.date} <span style={{ color: "#9AA" }}>{l.time}</span></td>
                  <td><span style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", color: LOG_COLORS[l.type] || "#555" }}>{l.type}</span></td>
                  <td>{l.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

// ---------- Finance analytics helpers ----------
const PIE_COLORS = ["#1B5E43", "#E8A33D", "#2A6FB0", "#C44536", "#7A5AB0", "#3DA17A", "#B0762A", "#8A9C90"];
const inrTick = (v) => "₹" + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + "k" : v);

// Resolve a period preset (+ optional custom range) to { from, to, label }.
function periodRange(preset, cfrom, cto) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const som = (yy, mm) => dateStr(new Date(yy, mm, 1));
  const eom = (yy, mm) => dateStr(new Date(yy, mm + 1, 0));
  switch (preset) {
    case "lastMonth": { const d = new Date(y, m - 1, 1); return { from: som(d.getFullYear(), d.getMonth()), to: eom(d.getFullYear(), d.getMonth()), label: d.toLocaleDateString("en-IN", { month: "long", year: "numeric" }) }; }
    case "thisYear": return { from: dateStr(new Date(y, 0, 1)), to: dateStr(now), label: "Year " + y };
    case "last7": { const d = new Date(); d.setDate(d.getDate() - 6); return { from: dateStr(d), to: dateStr(now), label: "Last 7 days" }; }
    case "last30": { const d = new Date(); d.setDate(d.getDate() - 29); return { from: dateStr(d), to: dateStr(now), label: "Last 30 days" }; }
    case "custom": return { from: cfrom || dateStr(now), to: cto || dateStr(now), label: `${cfrom || "…"} → ${cto || "…"}` };
    default: return { from: som(y, m), to: dateStr(now), label: now.toLocaleDateString("en-IN", { month: "long", year: "numeric" }) };
  }
}

// Build a daily (or monthly, for long ranges) revenue/profit/expense series.
function buildSeries(sales, expenses, from, to) {
  const start = new Date(from + "T00:00"), end = new Date(to + "T00:00");
  if (isNaN(start) || isNaN(end) || end < start) return [];
  const monthly = (end - start) / 86400000 > 62;
  const keyOf = (ds) => (monthly ? ds.slice(0, 7) : ds);
  const labelOf = (k) => (monthly
    ? new Date(k + "-01T00:00").toLocaleDateString("en-IN", { month: "short", year: "2-digit" })
    : new Date(k + "T00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }));
  const buckets = new Map();
  if (monthly) { let d = new Date(start.getFullYear(), start.getMonth(), 1); while (d <= end) { const k = dateStr(d).slice(0, 7); buckets.set(k, { key: k, label: labelOf(k), revenue: 0, profit: 0, expenses: 0 }); d = new Date(d.getFullYear(), d.getMonth() + 1, 1); } }
  else { const d = new Date(start); while (d <= end) { const k = dateStr(d); buckets.set(k, { key: k, label: labelOf(k), revenue: 0, profit: 0, expenses: 0 }); d.setDate(d.getDate() + 1); } }
  sales.forEach((s) => { const b = buckets.get(keyOf(s.date)); if (b) { b.revenue += s.total; b.profit += s.profit; } });
  expenses.forEach((e) => { const b = buckets.get(keyOf(e.date)); if (b) b.expenses += e.amount; });
  return [...buckets.values()].map((b) => ({ ...b, revenue: money(b.revenue), profit: money(b.profit), expenses: money(b.expenses) }));
}

const ChartCard = ({ title, children, height = 240 }) => (
  <section style={S.panel}>
    <div style={S.panelHead}>{title}</div>
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
    </div>
  </section>
);

// ---------- Finance (analytics) ----------
const PERIODS = [["thisMonth", "This month"], ["lastMonth", "Last month"], ["last7", "Last 7 days"], ["last30", "Last 30 days"], ["thisYear", "This year"], ["custom", "Custom"]];

function Finance({ sales, expenses }) {
  const [preset, setPreset] = useState("thisMonth");
  const [cfrom, setCfrom] = useState("");
  const [cto, setCto] = useState("");
  const { from, to, label } = periodRange(preset, cfrom, cto);

  const pSales = useMemo(() => sales.filter((s) => s.date >= from && s.date <= to), [sales, from, to]);
  const pExp = useMemo(() => expenses.filter((e) => e.date >= from && e.date <= to), [expenses, from, to]);
  const revenue = money(pSales.reduce((a, s) => a + s.total, 0));
  const grossProfit = money(pSales.reduce((a, s) => a + s.profit, 0));
  const expTotal = money(pExp.reduce((a, e) => a + e.amount, 0));

  const series = useMemo(() => buildSeries(pSales, pExp, from, to), [pSales, pExp, from, to]);
  const expBreakdown = useMemo(() => {
    const m = {};
    pExp.forEach((e) => { m[e.desc] = (m[e.desc] || 0) + e.amount; });
    return Object.entries(m).map(([name, value]) => ({ name, value: money(value) })).sort((a, b) => b.value - a.value).slice(0, 8);
  }, [pExp]);
  const topItems = useMemo(() => {
    const m = {};
    pSales.forEach((s) => (s.lines || []).forEach((l) => { m[l.name] = (m[l.name] || 0) + l.amount; }));
    return Object.entries(m).map(([name, value]) => ({ name, value: money(value) })).sort((a, b) => b.value - a.value).slice(0, 7);
  }, [pSales]);

  return (
    <div>
      <Header title="Finance" sub={label}>
        <select className="input" style={{ width: "auto" }} value={preset} onChange={(e) => setPreset(e.target.value)}>
          {PERIODS.map(([k, lbl]) => <option key={k} value={k}>{lbl}</option>)}
        </select>
      </Header>

      {preset === "custom" && (
        <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
          <label style={{ fontSize: 12, color: "#6B7E74" }}>From <input type="date" className="input" style={{ width: "auto", marginLeft: 4 }} value={cfrom} max={cto || todayStr()} onChange={(e) => setCfrom(e.target.value)} /></label>
          <label style={{ fontSize: 12, color: "#6B7E74" }}>To <input type="date" className="input" style={{ width: "auto", marginLeft: 4 }} value={cto} max={todayStr()} onChange={(e) => setCto(e.target.value)} /></label>
        </div>
      )}

      <div style={S.cards}>
        <Card label="Revenue" value={INR(revenue)} sub={pSales.length + " bills"} />
        <Card label="Gross profit" value={INR(grossProfit)} sub="sales − item cost" />
        <Card label="Expenses" value={INR(expTotal)} sub={pExp.length + " entries"} />
        <Card label="Net profit" value={INR(money(grossProfit - expTotal))} sub="gross − expenses" accent />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 16, marginTop: 16 }}>
        <ChartCard title="Revenue & profit over time">
          <AreaChart data={series} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
            <defs>
              <linearGradient id="gRev" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#1B5E43" stopOpacity={0.35} /><stop offset="100%" stopColor="#1B5E43" stopOpacity={0.03} /></linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} interval="preserveStartEnd" minTickGap={20} />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area type="monotone" dataKey="revenue" name="Revenue" stroke="#1B5E43" strokeWidth={2} fill="url(#gRev)" />
            <Area type="monotone" dataKey="profit" name="Profit" stroke="#E8A33D" strokeWidth={2} fill="none" />
          </AreaChart>
        </ChartCard>

        <ChartCard title="Expense breakdown">
          {expBreakdown.length === 0 ? (
            <div style={{ display: "grid", placeItems: "center", height: "100%" }}><Empty text="No expenses in this period." /></div>
          ) : (
            <PieChart>
              <Pie data={expBreakdown} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={84} label={(e) => { const n = String(e.name || ""); return n.length > 10 ? n.slice(0, 10) + "…" : n; }} labelLine={false} fontSize={10}>
                {expBreakdown.map((e, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={(v) => INR(v)} />
            </PieChart>
          )}
        </ChartCard>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
        <ChartCard title="Revenue vs expenses">
          <BarChart data={series} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} interval="preserveStartEnd" minTickGap={20} />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="revenue" name="Revenue" fill="#1B5E43" radius={[3, 3, 0, 0]} />
            <Bar dataKey="expenses" name="Expenses" fill="#C44536" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartCard>

        <ChartCard title="Top items by revenue">
          {topItems.length === 0 ? (
            <div style={{ display: "grid", placeItems: "center", height: "100%" }}><Empty text="No sales in this period." /></div>
          ) : (
            <BarChart data={topItems} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10.5, fill: "#465" }} width={110} />
              <Tooltip formatter={(v) => INR(v)} />
              <Bar dataKey="value" name="Revenue" fill="#2A6FB0" radius={[0, 3, 3, 0]} />
            </BarChart>
          )}
        </ChartCard>
      </div>
    </div>
  );
}

// ---------- Add Expense (own page) ----------
function Expenses({ expenses, setExpenses, notify, log }) {
  const [exp, setExp] = useState({ desc: "", amount: "", date: todayStr() });
  const [month, setMonth] = useState(todayStr().slice(0, 7));
  const mExp = expenses.filter((e) => e.date.startsWith(month));
  const total = money(mExp.reduce((a, e) => a + e.amount, 0));
  const monthLabel = new Date(month + "-01T00:00").toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  const addExp = () => {
    if (!exp.desc.trim() || !(+exp.amount > 0)) return notify("Enter a description and a positive amount");
    const date = exp.date || todayStr();
    const row = { id: uid(), date, desc: exp.desc.trim(), amount: +exp.amount };
    setExpenses((list) => [...list, row]);
    log("expense", `Expense ${INR(+exp.amount)} — ${exp.desc.trim()}` + (date !== todayStr() ? ` (dated ${date})` : ""));
    setExp({ desc: "", amount: "", date: todayStr() });
    notify("Expense recorded");
  };

  const del = (e) => {
    if (!confirm(`Delete expense “${e.desc}” (${INR(e.amount)})?`)) return;
    setExpenses((list) => list.filter((x) => x.id !== e.id));
    log("expense", `Deleted expense ${INR(e.amount)} — ${e.desc}`);
    notify("Expense deleted");
  };

  return (
    <div>
      <Header title="Add Expense" sub="Record shop expenses — rent, electricity, supplies, salaries…">
        <label style={{ fontSize: 12, color: "#6B7E74" }}>
          Month <input type="month" className="input" style={{ width: "auto", marginLeft: 4 }} value={month} max={todayStr().slice(0, 7)} onChange={(e) => setMonth(e.target.value || todayStr().slice(0, 7))} />
        </label>
      </Header>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 16 }}>
        <section style={S.panel}>
          <div style={S.panelHead}>New expense</div>
          <Field label="Description"><input className="input" autoFocus value={exp.desc} onChange={(e) => setExp({ ...exp, desc: e.target.value })} placeholder="e.g. Electricity bill" /></Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Amount (₹)"><input className="input" type="number" min="0" step="0.01" value={exp.amount} onChange={(e) => setExp({ ...exp, amount: e.target.value })} /></Field>
            <Field label="Date"><input className="input" type="date" max={todayStr()} value={exp.date} onChange={(e) => setExp({ ...exp, date: e.target.value })} /></Field>
          </div>
          <button className="btn primary big" style={{ width: "100%", marginTop: 8 }} onClick={addExp}>Record expense</button>
        </section>

        <section style={S.panel}>
          <div style={S.panelHead}>
            {monthLabel}
            <span style={{ marginLeft: "auto", fontWeight: 800 }}>{INR(total)}</span>
          </div>
          {mExp.length === 0 ? (
            <Empty text={"No expenses recorded in " + monthLabel + "."} />
          ) : (
            <table className="tbl">
              <thead><tr><th style={{ width: 110 }}>Date</th><th>Description</th><th style={{ textAlign: "right" }}>Amount</th><th style={{ width: 30 }}></th></tr></thead>
              <tbody>
                {[...mExp].sort((a, b) => (a.date < b.date ? 1 : -1)).map((e) => (
                  <tr key={e.id}>
                    <td style={{ color: "#677", whiteSpace: "nowrap" }}>{e.date}</td>
                    <td>{e.desc}</td>
                    <td style={{ textAlign: "right", fontWeight: 700 }}>{INR(e.amount)}</td>
                    <td><button className="btn small danger" aria-label={"Delete " + e.desc} onClick={() => del(e)}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}

// ---------- small components ----------
const Header = ({ title, sub, children }) => (
  <div style={{ display: "flex", alignItems: "flex-end", marginBottom: 18, gap: 12 }}>
    <div>
      <h1 style={{ margin: 0, fontSize: 24, letterSpacing: "-0.03em" }}>{title}</h1>
      {sub && <div style={{ color: "#6B7E74", fontSize: 13, marginTop: 2 }}>{sub}</div>}
    </div>
    <div style={{ marginLeft: "auto" }}>{children}</div>
  </div>
);

const Card = ({ label, value, sub, accent }) => (
  <div style={{ ...S.card, ...(accent ? { background: "#1B5E43", color: "#fff" } : {}) }}>
    <div style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.07em", color: accent ? "#A8CDBA" : "#7A8C81" }}>{label}</div>
    <div style={{ fontSize: 24, fontWeight: 800, margin: "6px 0 2px", fontVariantNumeric: "tabular-nums" }}>{value}</div>
    <div style={{ fontSize: 12, color: accent ? "#C8E2D4" : "#8A9C90" }}>{sub}</div>
  </div>
);

const Field = ({ label, children }) => (
  <label style={{ display: "block", marginBottom: 10 }}>
    <div style={{ fontSize: 12, fontWeight: 600, color: "#465", marginBottom: 4 }}>{label}</div>
    {children}
  </label>
);

const Empty = ({ text, children }) => (
  <div style={{ padding: "22px 10px", textAlign: "center", color: "#8A9", fontSize: 13 }}>
    {text}
    {children && <div style={{ marginTop: 10 }}>{children}</div>}
  </div>
);

function Modal({ title, children, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div style={S.overlay} onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>{title}</h2>
          <button className="btn ghost small" style={{ marginLeft: "auto" }} aria-label="Close dialog" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------- styles ----------
const S = {
  app: { display: "flex", minHeight: "100vh", background: "#EFF3EE", fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif", color: "#1E2421" },
  nav: { width: 210, background: "#10331F", color: "#E6F0E9", display: "flex", flexDirection: "column", gap: 4, padding: "16px 10px", position: "sticky", top: 0, height: "100vh", boxSizing: "border-box" },
  logo: { display: "flex", gap: 10, alignItems: "center", padding: "4px 8px 18px" },
  logoMark: { width: 38, height: 38, borderRadius: 10, background: "#E8A33D", color: "#10331F", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 17 },
  main: { flex: 1, padding: "26px 30px", maxWidth: 1280, margin: "0 auto", width: "100%", boxSizing: "border-box" },
  cards: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 },
  card: { background: "#fff", borderRadius: 14, padding: "16px 18px", border: "1px solid #E2EAE3" },
  panel: { background: "#fff", borderRadius: 14, padding: 16, border: "1px solid #E2EAE3" },
  panelHead: { fontWeight: 800, fontSize: 13.5, textTransform: "uppercase", letterSpacing: "0.05em", color: "#3A5547", display: "flex", alignItems: "center", marginBottom: 10 },
  row: { display: "flex", justifyContent: "space-between", padding: "8px 2px", borderBottom: "1px dashed #E5ECE6", fontSize: 13.5 },
  receipt: { background: "#FFFDF6", borderRadius: 4, padding: "18px 16px", border: "1px solid #E8E2CF", boxShadow: "0 2px 10px rgba(40,60,40,.07)", alignSelf: "start", backgroundImage: "repeating-linear-gradient(transparent, transparent 27px, rgba(180,170,140,.12) 28px)" },
  receiptHead: { textAlign: "center", fontWeight: 800, letterSpacing: "0.25em", fontSize: 12, color: "#6B6347", borderBottom: "2px dashed #D8D0B8", paddingBottom: 10, marginBottom: 8 },
  rcptLine: { display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px dotted #E0D9C4" },
  rcptTotal: { display: "flex", justifyContent: "space-between", fontWeight: 800, fontSize: 18, paddingTop: 12, marginTop: 6, borderTop: "2px dashed #C9BF9F" },
  badge: { background: "#C44536", color: "#fff", fontSize: 10.5, fontWeight: 800, borderRadius: 9, padding: "1px 7px", marginLeft: 8 },
  toast: { position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "#10331F", color: "#fff", padding: "10px 20px", borderRadius: 10, fontSize: 13.5, boxShadow: "0 6px 20px rgba(0,0,0,.25)", zIndex: 60 },
  overlay: { position: "fixed", inset: 0, background: "rgba(15,30,20,.45)", display: "grid", placeItems: "center", zIndex: 50 },
  modal: { background: "#fff", borderRadius: 16, padding: 20, width: "min(480px, 92vw)", maxHeight: "86vh", overflow: "auto" },
};

const CSS = `
  .navbtn { display:flex; align-items:center; gap:6px; width:100%; text-align:left; background:none; border:none; color:#BCD2C4; padding:10px 12px; border-radius:9px; font-size:13.5px; font-weight:600; cursor:pointer; position:relative; }
  .navbtn:hover { background:#1A4A2E; color:#fff; }
  .navbtn.active { background:#1B5E43; color:#fff; }
  .input { width:100%; box-sizing:border-box; padding:10px 12px; border:1.5px solid #D5E0D6; border-radius:9px; font-size:14px; background:#fff; outline:none; font-family:inherit; }
  .input:focus { border-color:#1B5E43; box-shadow:0 0 0 3px rgba(27,94,67,.12); }
  .btn { border:none; border-radius:9px; padding:9px 16px; font-size:13.5px; font-weight:700; cursor:pointer; background:#E4ECE5; color:#23402F; font-family:inherit; }
  .btn:hover { filter:brightness(.96); }
  .btn.primary { background:#1B5E43; color:#fff; }
  .btn.big { padding:13px 18px; font-size:15px; }
  .btn.ghost { background:transparent; border:1.5px solid #CFDCD1; }
  .btn.small { padding:5px 10px; font-size:12px; }
  .btn.danger { background:#FBEAE7; color:#C44536; }
  .pick { text-align:left; background:#F6FAF6; border:1.5px solid #DDE8DE; border-radius:11px; padding:10px 12px; cursor:pointer; font-family:inherit; }
  .pick:hover:not(:disabled) { border-color:#1B5E43; background:#fff; }
  .pick:disabled { opacity:.45; cursor:not-allowed; }
  .qty { width:26px; height:26px; border-radius:7px; border:1.5px solid #D0C7AB; background:#fff; font-size:15px; font-weight:700; cursor:pointer; line-height:1; }
  .tbl { width:100%; border-collapse:collapse; font-size:13.5px; }
  .tbl th { text-align:left; font-size:11.5px; text-transform:uppercase; letter-spacing:.05em; color:#7A8C81; padding:6px 8px; border-bottom:2px solid #E2EAE3; }
  .tbl td { padding:9px 8px; border-bottom:1px solid #EEF3EE; }
  .tbl tr:hover td { background:#F7FAF7; }
  @media (max-width: 820px) {
    .app { flex-direction:column !important; }
    .nav { width:auto !important; height:auto !important; position:static !important;
           flex-direction:row !important; flex-wrap:wrap !important; gap:4px !important; }
    .nav .navbtn { width:auto !important; }
    .main { padding:16px !important; max-width:none !important; }
    /* 16px inputs stop mobile browsers auto-zooming on focus */
    .input { font-size:16px; }
    /* inline grids are 2- or 4-column; collapse them all on small screens */
    [style*="grid-template-columns"] { grid-template-columns:1fr !important; }
    /* let wide tables scroll horizontally instead of overflowing the panel */
    .tbl { display:block; overflow-x:auto; white-space:nowrap; }
  }
`;
