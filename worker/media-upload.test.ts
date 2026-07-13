import { describe, expect, it } from "vitest";
import { inspectScanImage, safeUploadFilename, sha256Hex } from "./media-upload";

describe("Scan media validation", () => {
  it("recognizes JPEG, PNG, and WebP from bytes rather than names", () => {
    expect(inspectScanImage(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toEqual({ mimeType: "image/jpeg", extension: "jpg" });
    expect(inspectScanImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({ mimeType: "image/png", extension: "png" });
    expect(inspectScanImage(new TextEncoder().encode("RIFF0000WEBP"))).toEqual({ mimeType: "image/webp", extension: "webp" });
    expect(inspectScanImage(new TextEncoder().encode("not really an image"))).toBeNull();
  });

  it("keeps only a safe basename and provides a fallback", () => {
    expect(safeUploadFilename("../private/page.JPG", "jpg")).toBe("page.JPG");
    expect(safeUploadFilename("", "png")).toBe("scan.png");
  });

  it("calculates a stable SHA-256 fingerprint", async () => {
    await expect(sha256Hex(new TextEncoder().encode("scan"))).resolves.toBe(
      "59ad1b2fc74287ded1bba7af67765d23ad4a49f1ae51902cc2ed3f8ebee96cfa",
    );
  });
});
