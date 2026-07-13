import { describe, expect, it } from "vitest";
import { findSimilarLookupItems, normalizeLookupCandidate } from "./lookup-similarity";

const items = [
  { id: "1", name: "Bengali" },
  { id: "2", name: "A. R. Rahman" },
  { id: "3", name: "Notebook 12" },
];

describe("lookup similarity", () => {
  it("normalizes Unicode, capitalization, and repeated spaces", () => {
    expect(normalizeLookupCandidate("  A.  R. Rahman ")).toBe("a. r. rahman");
  });

  it("separates exact normalized duplicates from likely similar names", () => {
    expect(findSimilarLookupItems("  BENGALI ", items)).toEqual({ exact: items[0], similar: [] });
    expect(findSimilarLookupItems("Bengli", items)).toEqual({ exact: null, similar: [items[0]] });
  });

  it("can exclude the item being renamed", () => {
    expect(findSimilarLookupItems("Bengali", items, "1")).toEqual({ exact: null, similar: [] });
  });
});
