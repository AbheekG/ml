import { describe, expect, it } from "vitest";
import {
  normalizedTextKey,
  parseSongCreate,
  parseSongUpdate,
  titleCaseText,
} from "./song-writes";

const validSong = {
  titleLatin: "  a   NEW-song  ",
  titleNative: "  native title  ",
  status: "draft",
  languageIds: ["en"],
  tagIds: ["tag-1"],
  aliases: [" first alias "],
  notes: "  a note  ",
};

describe("Song write validation", () => {
  it("normalizes titles and aliases while preserving free-text content", () => {
    expect(titleCaseText("  a   NEW-song  ")).toBe("A New-Song");
    expect(normalizedTextKey(" A   New-Song ")).toBe("a new-song");

    const result = parseSongCreate(validSong);
    expect(result).toEqual({
      success: true,
      data: {
        titleLatin: "A New-Song",
        normalizedTitleLatin: "a new-song",
        titleNative: "native title",
        status: "draft",
        languageIds: ["en"],
        tagIds: ["tag-1"],
        aliases: [{ value: "First Alias", normalizedValue: "first alias" }],
        notes: "a note",
      },
    });
  });

  it("requires a Language and rejects normalized duplicate aliases", () => {
    const noLanguage = parseSongCreate({ ...validSong, languageIds: [] });
    expect(noLanguage.success).toBe(false);
    if (!noLanguage.success) expect(noLanguage.fields.languageIds).toBeDefined();

    const duplicateAliases = parseSongCreate({
      ...validSong,
      aliases: ["Same alias", " same   ALIAS "],
    });
    expect(duplicateAliases.success).toBe(false);
    if (!duplicateAliases.success) expect(duplicateAliases.fields.aliases).toContain("Duplicate Aliases are not allowed");
  });

  it("requires a positive revision for updates", () => {
    expect(parseSongUpdate({ ...validSong, revision: 3 })).toMatchObject({
      success: true,
      data: { revision: 3 },
    });
    expect(parseSongUpdate({ ...validSong, revision: 0 }).success).toBe(false);
  });
});
