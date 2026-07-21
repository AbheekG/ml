import { describe, expect, it } from "vitest";
import {
  MAX_CATALOG_SEARCH_QUERY_LENGTH,
  buildCatalogSearchFields,
  scoreCatalogSearch,
} from "./catalog-search";

function titleScore(title: string, query: string): number | null {
  return scoreCatalogSearch(buildCatalogSearchFields({ titles: [title] }), query);
}

describe("Indic-roman catalog search", () => {
  it.each([
    ["Gaan Example", "gan"],
    ["Deep Example", "dip"],
    ["Ghar Example", "gar"],
    ["Vani Example", "wani"],
    ["Rama Example", "ram"],
  ])("matches systematic romanization variation: %s / %s", (title, query) => {
    expect(titleScore(title, query)).not.toBeNull();
  });

  it("matches an exact phrase beginning after the first title word", () => {
    expect(titleScore("Opening Middle Ending", "middle ending")).toBe(1100);
  });

  it("matches several phonetic query words from later in a title", () => {
    expect(titleScore("Opening Gaan Deep", "gan dip")).not.toBeNull();
  });

  it.each([
    ["Mindblowing Example", "mind blowing"],
    ["Mind Blowing Example", "mindblowing"],
    ["Opening Mindblowing Example", "mind blowing"],
    ["Opening Mind Blowing Example", "mindblowing"],
    ["Gaandeep Example", "gan dip"],
  ])("matches conservative joined/split title variants: %s / %s", (title, query) => {
    expect(titleScore(title, query)).not.toBeNull();
  });

  it.each([
    ["Opening Middle Echo Echo Ending", "opening middle echoecho"],
    ["Opening Middle Echoecho Ending", "opening middle echo echo"],
    ["Prelude Echo Echo Ending", "echoecho ending"],
    ["Aal Baari Echo Echo Ending", "al bari echoecho"],
    ["Prelude Aal Baari Echo Echo Ending", "al bari echoecho"],
    ["One Two Middle Three Four Ending", "onetwo middle threefour"],
  ])("combines local joined/split matches with surrounding query words: %s / %s", (title, query) => {
    expect(titleScore(title, query)).not.toBeNull();
  });

  it("allows strong short-token normalization without short-token typos", () => {
    expect(titleScore("Aal Melody", "al")).not.toBeNull();
    expect(titleScore("Al Melody", "aal melody")).not.toBeNull();
    expect(titleScore("At Melody", "it")).toBeNull();
  });

  it("does not add typo fuzziness or unlimited joining to split-word matches", () => {
    expect(titleScore("Mind Blowing Example", "mindblowinx")).toBeNull();
    expect(titleScore("One Two Three Four", "onetwothreefour")).toBeNull();
    expect(titleScore("OneTwoThreeFour", "one two three four")).toBeNull();
  });

  it("preserves title order while allowing intervening title words", () => {
    expect(titleScore("First Middle Third", "first third")).not.toBeNull();
    expect(titleScore("First Second Third", "second first")).toBeNull();
  });

  it("requires query words to match distinct title words", () => {
    expect(titleScore("Gaan Example", "gan gan")).toBeNull();
  });

  it("allows ranked outer-tier mistakes only for sufficiently long words", () => {
    const oneEdit = titleScore("Harmony Example", "hxrmony");
    const twoEdits = titleScore("Harmony Example", "hxrmonx");
    expect(oneEdit).not.toBeNull();
    expect(twoEdits).not.toBeNull();
    expect(oneEdit!).toBeGreaterThan(twoEdits!);
    expect(titleScore("Melody Example", "mxlodx")).toBeNull();
    expect(titleScore("Harmony Example", "hxxmonx")).toBeNull();
    expect(titleScore("Harmony Example", "xxrmony")).toBeNull();
    expect(titleScore("Celebrations Example", "cxlebxatixns")).not.toBeNull();
    expect(titleScore("Celebrations Example", "xxlebxations")).toBeNull();
    expect(titleScore("Cat Example", "bat")).toBeNull();
  });

  it("keeps fuzzy matching out of lyrics and metadata", () => {
    const fields = buildCatalogSearchFields({
      metadata: ["Notebook Example"],
      lyrics: ["Sangeet Example"],
    });
    expect(scoreCatalogSearch(fields, "notebook")).not.toBeNull();
    expect(scoreCatalogSearch(fields, "snageet")).toBeNull();
    expect(scoreCatalogSearch(buildCatalogSearchFields({ lyrics: ["Mind Blowing"] }), "mindblowing")).toBeNull();
  });

  it("ranks phonetic title matches above literal lyric-only matches", () => {
    const title = scoreCatalogSearch(buildCatalogSearchFields({ titles: ["Gaan Example"] }), "gan");
    const lyrics = scoreCatalogSearch(buildCatalogSearchFields({ lyrics: ["gan"] }), "gan");
    expect(title).not.toBeNull();
    expect(lyrics).not.toBeNull();
    expect(title!).toBeGreaterThan(lyrics!);
  });

  it("gives exact aliases strong priority", () => {
    const alias = scoreCatalogSearch(buildCatalogSearchFields({ aliases: ["Known Alternate"] }), "known alternate");
    const metadata = scoreCatalogSearch(buildCatalogSearchFields({ metadata: ["Known Alternate"] }), "known alternate");
    expect(alias!).toBeGreaterThan(metadata!);
  });

  it("normalizes punctuation, case, and whitespace", () => {
    const fields = buildCatalogSearchFields({ titles: ["One — Two"] });
    expect(scoreCatalogSearch(fields, "  ONE,\nTWO ")).not.toBeNull();
  });

  it("returns no result when no literal or bounded title/alias match exists", () => {
    const fields = buildCatalogSearchFields({ titles: ["Unrelated Title"] });
    expect(scoreCatalogSearch(fields, "no plausible match")).toBeNull();
  });

  it("bounds pasted queries before normalization and fuzzy comparison", () => {
    const bounded = "a".repeat(MAX_CATALOG_SEARCH_QUERY_LENGTH);
    const oversized = `${bounded}${"x".repeat(100_000)}`;
    expect(titleScore(bounded, oversized)).toBe(1200);
  });

  it("keeps long bounded typo comparisons accurate without a two-dimensional matrix", () => {
    const title = `${"a".repeat(96)}bc${"d".repeat(96)}`;
    const transposed = `${"a".repeat(96)}cb${"d".repeat(96)}`;
    expect(titleScore(title, transposed)).not.toBeNull();
    expect(titleScore(title, `${"x".repeat(4)}${transposed.slice(4)}`)).toBeNull();
  });
});
