import { describe, expect, it } from "vitest";
import { recordingExportFilename, scanExportFilename } from "./export-filename";

describe("shared media filenames", () => {
  it("uses the Song title and Recording description", () => {
    expect(recordingExportFilename("Evening Song", "Home rehearsal"))
      .toBe("Evening Song — Home rehearsal.mp3");
  });

  it("keeps readable Unicode while removing unsafe filesystem characters", () => {
    expect(recordingExportFilename("  গান: এক / দুই  ", "Take * 1?  "))
      .toBe("গান এক দুই — Take 1.mp3");
  });

  it("uses Scan notebook and page metadata when available", () => {
    expect(scanExportFilename("Evening Song", {
      notebookName: "Blue Notebook",
      pageLabel: "12",
    }, 1, 3)).toBe(
      "Evening Song — Scanned Lyrics — Blue Notebook — Page 12 — 2 of 3.jpg",
    );
  });

  it("uses list position to distinguish otherwise unlabeled Scans", () => {
    expect(scanExportFilename("Evening Song", {
      notebookName: null,
      pageLabel: null,
    }, 1, 4)).toBe("Evening Song — Scanned Lyrics — 2 of 4.jpg");
    expect(scanExportFilename("Evening Song", {
      notebookName: null,
      pageLabel: null,
    }, 0, 1)).toBe("Evening Song — Scanned Lyrics.jpg");
  });

  it("bounds long UTF-8 filenames without losing their extension", () => {
    const filename = recordingExportFilename("🎵".repeat(100), "Recording");
    expect(new TextEncoder().encode(filename).byteLength).toBeLessThanOrEqual(240);
    expect(filename.endsWith(".mp3")).toBe(true);
  });
});
