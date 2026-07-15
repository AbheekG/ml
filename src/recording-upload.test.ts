import { describe, expect, it, vi } from "vitest";
import {
  MAX_RECORDING_UPLOAD_BYTES,
  RECORDING_UPLOAD_PART_BYTES,
  RecordingUploadError,
  abortRecordingUpload,
  uploadRecordingOriginal,
  type RecordingUploadSession,
} from "./recording-upload";

function audioFile(size: number, name = "private take.wav"): File {
  return new File([new Uint8Array(size)], name, { type: "audio/wav" });
}

function session(overrides: Partial<RecordingUploadSession> = {}): RecordingUploadSession {
  return {
    id: "upload-1",
    songId: "song-1",
    filename: "private take.wav",
    byteSize: 12,
    partSize: RECORDING_UPLOAD_PART_BYTES,
    partCount: 1,
    completedParts: [],
    status: "open",
    revision: 2,
    expiresAt: "2099-01-01T00:00:00.000Z",
    recordingId: null,
    ...overrides,
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

const mutationId = "123e4567-e89b-42d3-a456-426614174000";

describe("Recording browser upload orchestration", () => {
  it("rejects empty and oversized files before any request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const base = {
      songId: "song-1",
      clientMutationId: mutationId,
      description: null,
      recordedOn: null,
      creditPersonIds: [],
    };

    await expect(uploadRecordingOriginal({ ...base, file: audioFile(0) }, { fetcher }))
      .rejects.toMatchObject({ code: "invalid_recording_upload", fields: { file: expect.any(Array) } });
    const oversized = { name: "large.wav", type: "audio/wav", size: MAX_RECORDING_UPLOAD_BYTES + 1 } as File;
    await expect(uploadRecordingOriginal({ ...base, file: oversized }, { fetcher }))
      .rejects.toMatchObject({ code: "invalid_recording_upload", fields: { file: expect.any(Array) } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("resumes from server-held parts, uploads sequential slices, completes, and finalizes", async () => {
    const file = audioFile(RECORDING_UPLOAD_PART_BYTES + 3);
    let current = session({
      byteSize: file.size,
      partCount: 2,
      completedParts: [],
    });
    const requests: Array<{ url: string; method: string; size: number | null; body: unknown }> = [];
    const fetcher = vi.fn<typeof fetch>(async (request, init) => {
      const url = String(request);
      requests.push({
        url,
        method: init?.method ?? "GET",
        size: init?.body instanceof Blob ? init.body.size : null,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      if (url.endsWith("/recording-uploads") && init?.method === "POST") {
        return json({ upload: current }, 201);
      }
      if (url === "/api/recording-uploads/upload-1" && init?.method === "GET") {
        current = { ...current, completedParts: [1] };
        return json({ upload: current });
      }
      if (url.endsWith("/parts/2")) {
        current = { ...current, completedParts: [1, 2], revision: 3 };
        return json({ part: { partNumber: 2 }, upload: { revision: 3 } });
      }
      if (url.endsWith("/complete")) {
        current = { ...current, status: "stored", revision: 5, completedParts: [] };
        return json({ upload: current });
      }
      if (url.endsWith("/finalize")) {
        current = { ...current, status: "finalized", revision: 6, recordingId: "recording-1" };
        return json({
          upload: current,
          recording: { id: "recording-1", revision: 1, processingState: "processing" },
        }, 201);
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const progress: string[] = [];

    const result = await uploadRecordingOriginal({
      songId: "song-1",
      file,
      clientMutationId: mutationId,
      description: "Old take",
      recordedOn: null,
      creditPersonIds: ["person-1"],
    }, {
      fetcher,
      onProgress: (update) => progress.push(`${update.phase}:${update.completedParts}/${update.totalParts}`),
    });

    expect(result).toMatchObject({ kind: "finalized", recording: { id: "recording-1" } });
    expect(requests.filter((request) => request.url.includes("/parts/"))).toEqual([
      expect.objectContaining({ url: "/api/recording-uploads/upload-1/parts/2", method: "PUT", size: 3 }),
    ]);
    expect(requests[0].body).toMatchObject({
      clientMutationId: mutationId,
      filename: "private take.wav",
      byteSize: RECORDING_UPLOAD_PART_BYTES + 3,
      description: "Old take",
      creditPersonIds: ["person-1"],
    });
    expect(progress).toContain("uploading:2/2");
    expect(progress.at(-1)).toBe("finalizing:0/2");
  });

  it("reconciles a lost part response from status without re-uploading it", async () => {
    const file = audioFile(12);
    let current = session();
    let statusReads = 0;
    let partWrites = 0;
    const fetcher = vi.fn<typeof fetch>(async (request, init) => {
      const url = String(request);
      if (url.endsWith("/recording-uploads") && init?.method === "POST") return json({ upload: current }, 201);
      if (url === "/api/recording-uploads/upload-1" && init?.method === "GET") {
        statusReads += 1;
        return json({ upload: current });
      }
      if (url.endsWith("/parts/1")) {
        partWrites += 1;
        current = { ...current, completedParts: [1], revision: 3 };
        throw new TypeError("connection lost after checkpoint");
      }
      if (url.endsWith("/complete")) {
        current = { ...current, completedParts: [], status: "stored", revision: 5 };
        return json({ upload: current });
      }
      if (url.endsWith("/finalize")) {
        current = { ...current, status: "finalized", revision: 6, recordingId: "recording-1" };
        return json({ upload: current, recording: { id: "recording-1", revision: 1, processingState: "processing" } });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    await expect(uploadRecordingOriginal({
      songId: "song-1",
      file,
      clientMutationId: mutationId,
      description: null,
      recordedOn: null,
      creditPersonIds: [],
    }, { fetcher })).resolves.toMatchObject({ kind: "finalized" });
    expect(partWrites).toBe(1);
    expect(statusReads).toBe(2);
  });

  it("stops on exact-content duplicate and never finalizes", async () => {
    const file = audioFile(12);
    let current = session({ completedParts: [1], revision: 3 });
    const fetcher = vi.fn<typeof fetch>(async (request, init) => {
      const url = String(request);
      if (url.endsWith("/recording-uploads") && init?.method === "POST") return json({ upload: current }, 201);
      if (url === "/api/recording-uploads/upload-1" && init?.method === "GET") return json({ upload: current });
      if (url.endsWith("/complete")) {
        current = {
          ...current,
          completedParts: [],
          status: "duplicate",
          revision: 5,
          duplicateRecording: { id: "recording-existing", songId: "song-existing", trashed: false },
        };
        return json({ upload: current });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    await expect(uploadRecordingOriginal({
      songId: "song-1",
      file,
      clientMutationId: mutationId,
      description: null,
      recordedOn: null,
      creditPersonIds: [],
    }, { fetcher })).resolves.toMatchObject({
      kind: "duplicate",
      duplicateRecording: { id: "recording-existing", songId: "song-existing", trashed: false },
    });
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/finalize"))).toBe(false);
  });

  it("retains a stored session for an explicit description override retry", async () => {
    const file = audioFile(12);
    let current = session({ completedParts: [], status: "stored", revision: 5 });
    const finalizeBodies: unknown[] = [];
    const fetcher = vi.fn<typeof fetch>(async (request, init) => {
      const url = String(request);
      if (url.endsWith("/recording-uploads") && init?.method === "POST") return json({ upload: current }, 201);
      if (url === "/api/recording-uploads/upload-1" && init?.method === "GET") return json({ upload: current });
      if (url.endsWith("/finalize")) {
        finalizeBodies.push(JSON.parse(String(init?.body)));
        if (finalizeBodies.length === 1) {
          return json({
            error: "duplicate_recording_description",
            existingRecording: { id: "existing", songId: "song-1" },
          }, 409);
        }
        current = { ...current, status: "finalized", revision: 6, recordingId: "recording-new" };
        return json({ upload: current, recording: { id: "recording-new", revision: 1, processingState: "processing" } });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const input = {
      songId: "song-1",
      file,
      clientMutationId: mutationId,
      description: "Same description",
      recordedOn: null,
      creditPersonIds: [],
    };

    let retained: RecordingUploadSession | undefined;
    try {
      await uploadRecordingOriginal(input, { fetcher });
    } catch (error) {
      expect(error).toBeInstanceOf(RecordingUploadError);
      expect(error).toMatchObject({
        code: "duplicate_recording_description",
        existingRecording: { id: "existing", songId: "song-1" },
        upload: { status: "stored", revision: 5 },
      });
      retained = (error as RecordingUploadError).upload;
    }
    expect(retained).toBeDefined();

    await expect(uploadRecordingOriginal(input, {
      fetcher,
      resumeUpload: retained,
      descriptionOverride: "Different description",
    })).resolves.toMatchObject({ kind: "finalized", recording: { id: "recording-new" } });
    expect(finalizeBodies).toEqual([
      { revision: 5 },
      { revision: 5, description: "Different description" },
    ]);
  });

  it("aborts only by explicit revision-bound request", async () => {
    const open = session();
    const fetcher = vi.fn<typeof fetch>(async (_request, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ revision: 2 });
      return json({ upload: { ...open, status: "aborted", revision: 3 } });
    });

    await expect(abortRecordingUpload(open, fetcher)).resolves.toMatchObject({
      status: "aborted",
      revision: 3,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/recording-uploads/upload-1/abort",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("fails closed on a malformed server session", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({
      upload: { id: "upload-1", status: "open", objectKey: "must-not-be-accepted" },
    }));
    await expect(uploadRecordingOriginal({
      songId: "song-1",
      file: audioFile(12),
      clientMutationId: mutationId,
      description: null,
      recordedOn: null,
      creditPersonIds: [],
    }, { fetcher })).rejects.toMatchObject({ code: "recording_upload_invalid_response" });
  });
});
