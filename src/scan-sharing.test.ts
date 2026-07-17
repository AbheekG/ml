import { describe, expect, it, vi } from "vitest";
import {
  loadOptimizedScanShareFile,
  MAX_OPTIMIZED_SCAN_SHARE_BYTES,
  shareOptimizedScanFile,
  supportsOptimizedScanSharing,
} from "./scan-sharing";

function optimizedResponse(
  bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  headers: Record<string, string> = {},
): Response {
  return new Response(bytes, {
    headers: {
      "Content-Length": String(bytes.byteLength),
      "Content-Type": "image/jpeg",
      "X-Scan-Representation": "readability",
      ...headers,
    },
  });
}

describe("optimized Scan sharing", () => {
  it("offers the action only when file capability checks and sharing exist", () => {
    expect(supportsOptimizedScanSharing({})).toBe(false);
    expect(supportsOptimizedScanSharing({
      canShare: () => false,
      share: async () => undefined,
    })).toBe(false);
    expect(supportsOptimizedScanSharing({
      canShare: () => true,
      share: async () => undefined,
    })).toBe(true);
  });

  it("loads exact authenticated readability bytes into a generic JPEG file", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const fetcher = vi.fn(async () => optimizedResponse(bytes));
    const controller = new AbortController();

    const file = await loadOptimizedScanShareFile(
      "scan/id",
      controller.signal,
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith("/api/scans/scan%2Fid/image", {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    expect(file.name).toBe("scan.jpg");
    expect(file.type).toBe("image/jpeg");
    expect(file.lastModified).toBe(0);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  it("never substitutes an original or a non-JPEG response", async () => {
    await expect(loadOptimizedScanShareFile("scan-1", undefined, async () => (
      optimizedResponse(undefined, { "X-Scan-Representation": "original" })
    ))).rejects.toMatchObject({ code: "optimized_unavailable" });

    await expect(loadOptimizedScanShareFile("scan-1", undefined, async () => (
      optimizedResponse(undefined, { "Content-Type": "image/png" })
    ))).rejects.toMatchObject({ code: "invalid_file" });
  });

  it("bounds declared and received bytes before constructing a shared file", async () => {
    await expect(loadOptimizedScanShareFile("scan-1", undefined, async () => (
      optimizedResponse(undefined, {
        "Content-Length": String(MAX_OPTIMIZED_SCAN_SHARE_BYTES + 1),
      })
    ))).rejects.toMatchObject({ code: "file_too_large" });

    await expect(loadOptimizedScanShareFile("scan-1", undefined, async () => (
      optimizedResponse(undefined, { "Content-Length": "3" })
    ))).rejects.toMatchObject({ code: "invalid_file" });
  });

  it("shares only the prepared file without a title, text, or URL", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "scan.jpg", {
      type: "image/jpeg",
    });
    const canShare = vi.fn(() => true);
    const share = vi.fn(async () => undefined);

    await expect(shareOptimizedScanFile(file, { canShare, share }))
      .resolves.toBe("shared");
    expect(canShare).toHaveBeenCalledWith({ files: [file] });
    expect(share).toHaveBeenCalledWith({ files: [file] });
  });

  it("keeps cancellation quiet and permits a second gesture after activation expires", async () => {
    const file = new File([new Uint8Array([1])], "scan.jpg", { type: "image/jpeg" });
    const canShare = () => true;

    await expect(shareOptimizedScanFile(file, {
      canShare,
      share: async () => { throw new DOMException("cancelled", "AbortError"); },
    })).resolves.toBe("cancelled");
    await expect(shareOptimizedScanFile(file, {
      canShare,
      share: async () => { throw new DOMException("activation expired", "NotAllowedError"); },
    })).resolves.toBe("retry_required");
  });

  it("returns bounded capability and platform failures", async () => {
    const file = new File([new Uint8Array([1])], "scan.jpg", { type: "image/jpeg" });

    await expect(shareOptimizedScanFile(file, {
      canShare: () => false,
      share: async () => undefined,
    })).rejects.toMatchObject({ code: "share_unavailable" });
    await expect(shareOptimizedScanFile(file, {
      canShare: () => true,
      share: async () => { throw new Error("private platform detail"); },
    })).rejects.toMatchObject({ code: "share_failed" });
  });
});
