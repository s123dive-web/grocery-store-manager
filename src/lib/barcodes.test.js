import { describe, it, expect } from "vitest";
import {
  itemBarcodes, findItemByBarcode, findBarcodeClash, cleanBarcodeList, looksLikeBarcode,
  barcodeMatchKey, parseBarcodeText, withBarcodeSep,
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

describe("barcodeMatchKey (ignore last 5 digits when length > 10)", () => {
  it("strips the last 5 characters when longer than 10", () => {
    expect(barcodeMatchKey("2001234500999")).toBe("20012345"); // 13 → 8
    expect(barcodeMatchKey("12345678901")).toBe("123456");     // 11 → 6
  });
  it("leaves codes of length 10 or less unchanged", () => {
    expect(barcodeMatchKey("1234567890")).toBe("1234567890"); // exactly 10
    expect(barcodeMatchKey("890123")).toBe("890123");
  });
  it("trims and lowercases", () => {
    expect(barcodeMatchKey("  PSM12345ABCDE ")).toBe("psm12345"); // 13 → 8, lowercased
  });
});

describe("findItemByBarcode — long variable-weight/price codes", () => {
  const items = [
    { id: "veg", name: "Loose Tomatoes", code: "2001234" },          // 7-digit product prefix
    { id: "cheese", name: "Cheese Block", code: "2009999500100" },   // 13-digit sample weight barcode
    { id: "milk", name: "Milk 1L", code: "8901234567890" },          // normal fixed EAN-13
  ];

  it("matches a long scan to a product stored by its prefix (last 5 ignored)", () => {
    // scanned 12-digit weight barcode → prefix "2001234" matches the stored 7-digit prefix
    expect(findItemByBarcode(items, "200123400575")?.id).toBe("veg");
  });

  it("matches two long codes that share the prefix but differ in the last 5 (price/weight)", () => {
    expect(findItemByBarcode(items, "2009999512345")?.id).toBe("cheese");
  });

  it("still resolves a normal fixed barcode by EXACT match", () => {
    expect(findItemByBarcode(items, "8901234567890")?.id).toBe("milk");
  });

  it("does not prefix-match a short (<=10) scan", () => {
    expect(findItemByBarcode(items, "2001234500")).toBeNull(); // 10 chars → no stripping, no exact
  });

  it("returns null when no prefix matches", () => {
    expect(findItemByBarcode(items, "7777777777777")).toBeNull();
  });

  it("prefers an EXACT match over a prefix collision", () => {
    const two = [
      { id: "a", name: "A", code: "8901234567890" },
      { id: "b", name: "B", code: "8901234511111" }, // same first 8 "89012345"
    ];
    expect(findItemByBarcode(two, "8901234511111")?.id).toBe("b"); // exact wins, not the first prefix hit
    expect(findItemByBarcode(two, "8901234567890")?.id).toBe("a");
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

describe("parseBarcodeText (semicolon multi-barcode field)", () => {
  it("splits on semicolons and trims", () => {
    expect(parseBarcodeText("8901111; 8902222; 8903333")).toEqual(["8901111", "8902222", "8903333"]);
  });
  it("tolerates commas, newlines and stray whitespace from scanners", () => {
    expect(parseBarcodeText("8901111 , 8902222\n8903333")).toEqual(["8901111", "8902222", "8903333"]);
  });
  it("drops empties and a trailing separator, and de-dupes case-insensitively", () => {
    expect(parseBarcodeText("8901111; 8901111; ; PSM1; psm1; ")).toEqual(["8901111", "PSM1"]);
  });
  it("handles blank / nullish input", () => {
    expect(parseBarcodeText("")).toEqual([]);
    expect(parseBarcodeText(null)).toEqual([]);
    expect(parseBarcodeText("   ")).toEqual([]);
  });
});

describe("withBarcodeSep (auto-append ';' after a scan)", () => {
  it("appends '; ' to a scanned value", () => {
    expect(withBarcodeSep("8901234567890")).toBe("8901234567890; ");
  });
  it("does not double-append when already ending in a separator or space", () => {
    expect(withBarcodeSep("8901111; ")).toBe("8901111; ");
    expect(withBarcodeSep("8901111;")).toBe("8901111;");
    expect(withBarcodeSep("8901111 ")).toBe("8901111 ");
  });
  it("leaves an empty / whitespace-only field untouched (no stray ';')", () => {
    expect(withBarcodeSep("")).toBe("");
    expect(withBarcodeSep("   ")).toBe("   ");
  });
  it("appends after a full multi-barcode list too", () => {
    expect(withBarcodeSep("8901111; 8902222")).toBe("8901111; 8902222; ");
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
