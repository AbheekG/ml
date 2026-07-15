import { describe, expect, it, vi } from "vitest";
import {
  copyTextBlock,
  shareTextBlock,
  supportsSystemTextShare,
} from "./text-sharing";

describe("typed-lyrics text actions", () => {
  it("copies the exact Unicode block without normalization", async () => {
    const writeText = vi.fn(async () => undefined);
    const content = "line one\n\nবাংলা line";
    await copyTextBlock(content, { writeText });
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(content);
  });

  it("fails with bounded public copy errors", async () => {
    await expect(copyTextBlock("lyrics", null)).rejects.toMatchObject({
      code: "copy_unavailable",
    });
    await expect(copyTextBlock("lyrics", {
      writeText: async () => { throw new Error("private platform detail"); },
    })).rejects.toMatchObject({ code: "copy_failed" });
  });

  it("offers system sharing only when the capability exists", () => {
    expect(supportsSystemTextShare({})).toBe(false);
    expect(supportsSystemTextShare({ share: async () => undefined })).toBe(true);
  });

  it("shares only the exact lyric content", async () => {
    const share = vi.fn(async () => undefined);
    const content = "first line\nsecond line";
    await expect(shareTextBlock(content, { share })).resolves.toBe("shared");
    expect(share).toHaveBeenCalledWith({ text: content });
  });

  it("treats user cancellation differently from a sharing failure", async () => {
    await expect(shareTextBlock("lyrics", {
      share: async () => { throw new DOMException("cancelled", "AbortError"); },
    })).resolves.toBe("cancelled");
    await expect(shareTextBlock("lyrics", {
      share: async () => { throw new Error("private platform detail"); },
    })).rejects.toMatchObject({ code: "share_failed" });
  });
});
