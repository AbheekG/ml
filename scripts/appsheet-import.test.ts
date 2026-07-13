import { describe, expect, it } from "vitest";
import {
  createLegacyLyricText,
  normalizeLanguageId,
  normalizeNotebookId,
  normalizedName,
  splitReferences,
} from "./appsheet-import";

describe("AppSheet import helpers", () => {
  it("normalizes only known legacy lookup case errors", () => {
    expect(normalizeLanguageId("BN")).toBe("bn");
    expect(normalizeLanguageId("hn")).toBe("hn");
    expect(normalizeNotebookId("O1")).toBe("o1");
    expect(normalizeNotebookId("original")).toBe("original");
  });

  it("splits AppSheet reference lists without empty values", () => {
    expect(splitReferences("bn, en, ,sn")).toEqual(["bn", "en", "sn"]);
    expect(splitReferences(null)).toEqual([]);
  });

  it("normalizes names consistently for uniqueness", () => {
    expect(normalizedName("  A   Name  ")).toBe("a name");
  });

  it("preserves a combined lyric block exactly", () => {
    const content = "বাংলা line\nदेवनागरी line\nLatin line  ";
    const result = createLegacyLyricText({
      SongID: "song-1",
      LyricsTyped: content,
      CreatedAt: new Date("2026-01-01T00:00:00.000Z"),
      UpdatedAt: new Date("2026-01-02T00:00:00.000Z"),
      CreatedBy: "legacy-user",
    });

    expect(result).toMatchObject({
      id: "lyrics:song-1:legacy",
      origin: "legacy_import",
      content,
    });
  });
});
