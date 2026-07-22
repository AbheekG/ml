import { describe, expect, it, vi } from "vitest";
import {
  isRecordingShareTooLarge,
  loadRecordingShareFile,
  MAX_RECORDING_SHARE_BYTES,
  shareRecordingFile,
  supportsRecordingSharing,
} from "./recording-sharing";

function playbackResponse(
  bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04]),
  headers: Record<string, string> = {},
  status = 200,
): Response {
  return new Response(bytes, {
    status,
    headers: {
      "Content-Length": String(bytes.byteLength),
      "Content-Type": "audio/mpeg",
      "X-Recording-Representation": "playback",
      ...headers,
    },
  });
}

describe("Recording sharing", () => {
  it("identifies only known playback sizes above the 50 MiB bound", () => {
    expect(isRecordingShareTooLarge(undefined)).toBe(false);
    expect(isRecordingShareTooLarge(null)).toBe(false);
    expect(isRecordingShareTooLarge(MAX_RECORDING_SHARE_BYTES)).toBe(false);
    expect(isRecordingShareTooLarge(MAX_RECORDING_SHARE_BYTES + 1)).toBe(true);
  });

  it("offers the action only when MP3 file sharing is supported", () => {
    expect(supportsRecordingSharing({})).toBe(false);
    expect(supportsRecordingSharing({
      canShare: () => false,
      share: async () => undefined,
    })).toBe(false);
    expect(supportsRecordingSharing({
      canShare: (data) => data?.files?.[0]?.type === "audio/mpeg",
      share: async () => undefined,
    })).toBe(true);
  });

  it("loads exact authenticated playback bytes into the requested semantic MP3 file", async () => {
    const bytes = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);
    const fetcher = vi.fn(async () => playbackResponse(bytes));
    const controller = new AbortController();

    const file = await loadRecordingShareFile(
      "recording/id",
      controller.signal,
      fetcher,
      "Evening Song — Home rehearsal.mp3",
    );

    expect(fetcher).toHaveBeenCalledWith("/api/recordings/recording%2Fid/playback", {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    expect(file.name).toBe("Evening Song — Home rehearsal.mp3");
    expect(file.type).toBe("audio/mpeg");
    expect(file.lastModified).toBe(0);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  it("rejects a non-playback representation or non-MP3 response", async () => {
    await expect(loadRecordingShareFile("recording-1", undefined, async () => (
      playbackResponse(undefined, { "X-Recording-Representation": "original" })
    ))).rejects.toMatchObject({ code: "invalid_file" });

    await expect(loadRecordingShareFile("recording-1", undefined, async () => (
      playbackResponse(undefined, { "Content-Type": "audio/wav" })
    ))).rejects.toMatchObject({ code: "invalid_file" });
  });

  it("bounds declared, server-rejected, and received bytes", async () => {
    await expect(loadRecordingShareFile("recording-1", undefined, async () => (
      playbackResponse(undefined, {}, 413)
    ))).rejects.toMatchObject({ code: "file_too_large" });

    await expect(loadRecordingShareFile("recording-1", undefined, async () => (
      playbackResponse(undefined, {
        "Content-Length": String(MAX_RECORDING_SHARE_BYTES + 1),
      })
    ))).rejects.toMatchObject({ code: "file_too_large" });

    await expect(loadRecordingShareFile("recording-1", undefined, async () => (
      playbackResponse(undefined, { "Content-Length": "3" })
    ))).rejects.toMatchObject({ code: "invalid_file" });
  });

  it("shares only the prepared MP3 without separate title, text, or URL", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "recording.mp3", {
      type: "audio/mpeg",
    });
    const canShare = vi.fn(() => true);
    const share = vi.fn(async () => undefined);

    await expect(shareRecordingFile(file, { canShare, share })).resolves.toBe("shared");
    expect(canShare).toHaveBeenCalledWith({ files: [file] });
    expect(share).toHaveBeenCalledWith({ files: [file] });
  });

  it("keeps cancellation quiet and permits a second gesture", async () => {
    const file = new File([new Uint8Array([1])], "recording.mp3", { type: "audio/mpeg" });
    const canShare = () => true;

    await expect(shareRecordingFile(file, {
      canShare,
      share: async () => { throw new DOMException("cancelled", "AbortError"); },
    })).resolves.toBe("cancelled");
    await expect(shareRecordingFile(file, {
      canShare,
      share: async () => { throw new DOMException("activation expired", "NotAllowedError"); },
    })).resolves.toBe("retry_required");
  });

  it("returns bounded capability and platform failures", async () => {
    const file = new File([new Uint8Array([1])], "recording.mp3", { type: "audio/mpeg" });

    await expect(shareRecordingFile(file, {
      canShare: () => false,
      share: async () => undefined,
    })).rejects.toMatchObject({ code: "share_unavailable" });
    await expect(shareRecordingFile(file, {
      canShare: () => true,
      share: async () => { throw new Error("private platform detail"); },
    })).rejects.toMatchObject({ code: "share_failed" });
  });
});
