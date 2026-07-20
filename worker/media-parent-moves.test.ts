import { describe, expect, it } from "vitest";
import { parseMediaParentMove } from "./media-parent-moves";

describe("parseMediaParentMove", () => {
  it("accepts Trash moves with an optional duplicate upload checkpoint", () => {
    expect(parseMediaParentMove({ revision: 3, targetSongId: "song-2" })).toEqual({
      success: true,
      data: { revision: 3, targetSongId: "song-2" },
    });
    expect(parseMediaParentMove({
      revision: 4,
      targetSongId: "song-2",
      duplicateUpload: { sessionId: "upload-1", revision: 6 },
    })).toMatchObject({ success: true });
  });

  it("rejects stale, blank, and unexpected values", () => {
    expect(parseMediaParentMove({ revision: 0, targetSongId: "song-2" })).toEqual({ success: false });
    expect(parseMediaParentMove({ revision: 1, targetSongId: "" })).toEqual({ success: false });
    expect(parseMediaParentMove({ revision: 1, targetSongId: "song-2", extra: true })).toEqual({ success: false });
  });
});
