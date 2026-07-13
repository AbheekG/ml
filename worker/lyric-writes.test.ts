import { describe, expect, it } from "vitest";
import { parseLyricCreate, parseLyricRevision, parseLyricUpdate } from "./lyric-writes";

describe("typed lyric validation", () => {
  it("preserves Unicode, spaces, and line endings exactly", () => {
    const content = "  প্রথম লাইন\r\n\r\n  Second line  ";

    expect(parseLyricCreate({ content })).toEqual({
      success: true,
      data: { content },
    });
  });

  it("rejects blank content", () => {
    expect(parseLyricCreate({ content: " \n\t " })).toEqual({
      success: false,
      fields: { content: ["Typed lyrics must not be blank"] },
    });
  });

  it("requires a positive revision for edits", () => {
    expect(parseLyricUpdate({ content: "Text", revision: 0 })).toMatchObject({
      success: false,
      fields: { revision: expect.any(Array) },
    });
  });

  it("accepts only a positive revision for Trash-state changes", () => {
    expect(parseLyricRevision({ revision: 3 })).toEqual({
      success: true,
      data: { revision: 3 },
    });
    expect(parseLyricRevision({ revision: 3, content: "unexpected" })).toMatchObject({
      success: false,
    });
  });
});
