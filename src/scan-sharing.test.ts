import { describe, expect, it, vi } from "vitest";
import {
  loadOptimizedScanShareFile,
  MAX_OPTIMIZED_SCAN_SHARE_BYTES,
  prepareVisibleScanShareFile,
  rotateOptimizedScanShareFile,
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

  it("loads exact authenticated readability bytes into the requested semantic JPEG file", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const fetcher = vi.fn(async () => optimizedResponse(bytes));
    const controller = new AbortController();

    const file = await loadOptimizedScanShareFile(
      "scan/id",
      controller.signal,
      fetcher,
      "Evening Song — Scanned Lyrics — Page 2.jpg",
    );

    expect(fetcher).toHaveBeenCalledWith("/api/scans/scan%2Fid/image", {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    expect(file.name).toBe("Evening Song — Scanned Lyrics — Page 2.jpg");
    expect(file.type).toBe("image/jpeg");
    expect(file.lastModified).toBe(0);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  it("rotates the complete visible image into a semantic JPEG without another fetch", async () => {
    const operations: Array<[string, ...number[]]> = [];
    const context = {
      translate: (x: number, y: number) => operations.push(["translate", x, y]),
      rotate: (radians: number) => operations.push(["rotate", radians]),
      drawImage: () => operations.push(["drawImage"]),
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toBlob: (callback: BlobCallback) => callback(new Blob([new Uint8Array([1, 2, 3])], {
        type: "image/jpeg",
      })),
    } as unknown as HTMLCanvasElement;
    const image = {
      naturalWidth: 1200,
      naturalHeight: 900,
    } as unknown as HTMLImageElement;

    const file = await prepareVisibleScanShareFile(
      null,
      image,
      1,
      () => canvas,
      "Evening Song — Scanned Lyrics.jpg",
    );

    expect(canvas.width).toBe(900);
    expect(canvas.height).toBe(1200);
    expect(operations[0]).toEqual(["translate", 900, 0]);
    expect(operations[1][0]).toBe("rotate");
    expect(operations[1][1]).toBeCloseTo(Math.PI / 2);
    expect(operations[2]).toEqual(["drawImage"]);
    expect(file.name).toBe("Evening Song — Scanned Lyrics.jpg");
    expect(file.type).toBe("image/jpeg");
    expect(file.size).toBe(3);
  });

  it("shares zero-turn bytes unchanged and releases decoded rotation resources", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "scan.jpg", { type: "image/jpeg" });
    await expect(rotateOptimizedScanShareFile(file, 0)).resolves.toBe(file);

    let released = false;
    const image = { naturalWidth: 2, naturalHeight: 3 } as unknown as HTMLImageElement;
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        translate: () => undefined,
        rotate: () => undefined,
        drawImage: () => undefined,
      }),
      toBlob: (callback: BlobCallback) => callback(new Blob([new Uint8Array([4])], {
        type: "image/jpeg",
      })),
    } as unknown as HTMLCanvasElement;
    const rotated = await rotateOptimizedScanShareFile(
      file,
      3,
      async () => ({ image, release: () => { released = true; } }),
      () => canvas,
    );
    expect(rotated.size).toBe(1);
    expect(canvas.width).toBe(3);
    expect(canvas.height).toBe(2);
    expect(released).toBe(true);
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
