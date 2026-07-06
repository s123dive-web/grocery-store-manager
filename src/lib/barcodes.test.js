import { describe, it, expect } from "vitest";
import {
  itemBarcodes, findItemByBarcode, findBarcodeClash, cleanBarcodeList, looksLikeBarcode,
} from "./barcodes.js";

describe("itemBarcodes", () => {
  it("returns [] for a product with no barcodes", () => {
    expect(itemBarcodes({ id: "1", name: "Salt" })).toEqual([]);
    expect(itemBarcodes({ id: "1", code: "", barcodes: [] })).toEqual([]);
    expect(itemBarcodes(null)).toEqual([]);
  });

  it("puts the primary `code` first, then additional barcodes", () => {
    expect(itemBarcodes({ code: "890111", barcodes: ["890222", "890333"] }))
      .toEqual(["890111", "890222", "890333"]);
  });

  it("works when only additional barcodes exist (no primary)", () => {
    expect(itemBarcodes({ code: "", barcodes: ["A1", "A2"] })).toEqual(["A1", "A2"]);
  });

  it("trims and drops blank entries", () => {
    expect(itemBarcodes({ code: "  890  ", barcodes: ["", "  ", " 111 "] }))
      .toEqual(["890", "111"]);
  });

  it("de-dupes case-insensitively, keeping the first occurrence's casing", () => {
    expect(itemBarcodes({ code: "psm100", barcodes: ["PSM100", "psm200"] }))
      .toEqual(["psm100", "psm200"]);
  });

  it("tolerates a non-array barcodes field", () => {
    expect(itemBarcodes({ code: "890", barcodes: undefined })).toEqual(["890"]);
    expect(itemBarcodes({ code: "890", barcodes: null })).toEqual(["890"]);
  });
});

describe("findItemByBarcode", () => {
  const items = [
    { id: "a", name: "Amul Butter", code: "8901111", barcodes: ["8901112"] },
    { id: "b", name: "Parle-G", code: "8902222", barcodes: [] },
    { id: "c", name: "No barcode", code: "" },
  ];

  it("matches on the primary barcode", () => {
    expect(findItemByBarcode(items, "8901111")?.id).toBe("a");
  });

  it("matches on an additional barcode", () => {
    expect(findItemByBarcode(items, "8901112")?.id).toBe("a");
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    const alnum = [{ id: "x", name: "Pen", code: "PSM123ABC" }];
    expect(findItemByBarcode(alnum, "  psm123abc ")?.id).toBe("x");
  });

  it("returns null for an unknown barcode and for a blank query", () => {
    expect(findItemByBarcode(items, "0000000")).toBeNull();
    expect(findItemByBarcode(items, "")).toBeNull();
    expect(findItemByBarcode(items, "   ")).toBeNull();
  });
});

describe("findBarcodeClash", () => {
  const items = [
    { id: "a", name: "Amul Butter", code: "8901111", barcodes: ["8901112"] },
    { id: "b", name: "Parle-G", code: "8902222" },
  ];

  it("flags a barcode already owned by another product (naming it)", () => {
    const clash = findBarcodeClash(["8902222"], items, "a");
    expect(clash).toMatchObject({ code: "8902222" });
    expect(clash.item.name).toBe("Parle-G");
  });

  it("flags a clash against another product's ADDITIONAL barcode too", () => {
    const clash = findBarcodeClash(["8901112"], items, "b");
    expect(clash.item.name).toBe("Amul Butter");
  });

  it("does not flag the item's own barcodes (exceptId)", () => {
    expect(findBarcodeClash(["8901111", "8901112"], items, "a")).toBeNull();
  });

  it("returns null when every candidate is unique", () => {
    expect(findBarcodeClash(["9999999"], items, "a")).toBeNull();
  });

  it("ignores blank candidates", () => {
    expect(findBarcodeClash(["", "  "], items, undefined)).toBeNull();
  });

  it("is case-insensitive", () => {
    const alnum = [{ id: "x", name: "Pen", code: "PSM123" }];
    expect(findBarcodeClash(["psm123"], alnum, "y")?.item.name).toBe("Pen");
  });
});

describe("cleanBarcodeList", () => {
  it("trims, drops blanks, and de-dupes case-insensitively preserving order + first casing", () => {
    expect(cleanBarcodeList([" 890 ", "", "PSM1", "psm1", "  ", "890"]))
      .toEqual(["890", "PSM1"]);
  });

  it("handles empty / nullish input", () => {
    expect(cleanBarcodeList([])).toEqual([]);
    expect(cleanBarcodeList(null)).toEqual([]);
  });
});

describe("looksLikeBarcode", () => {
  it("accepts barcode-shaped strings (>=6 chars, has a digit, no spaces)", () => {
    expect(looksLikeBarcode("8901234567890")).toBe(true); // EAN-13
    expect(looksLikeBarcode("PSM123456")).toBe(true);      // app CODE128
    expect(looksLikeBarcode("12345678")).toBe(true);
  });

  it("rejects typed product-name searches", () => {
    expect(looksLikeBarcode("colgate")).toBe(false);   // no digit
    expect(looksLikeBarcode("amul butter")).toBe(false); // space
    expect(looksLikeBarcode("maggi")).toBe(false);      // too short + no digit
    expect(looksLikeBarcode("20")).toBe(false);         // price search, too short
    expect(looksLikeBarcode("")).toBe(false);
  });
});
