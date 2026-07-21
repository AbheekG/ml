import { describe, expect, it } from "vitest";
import {
  MAX_RECORDING_UPLOAD_BYTES,
  RECORDING_UPLOAD_PART_BYTES,
  expectedRecordingPartBytes,
  parseRecordingUploadFinalization,
  parseRecordingUploadCreate,
  parseRecordingUploadFileIdentity,
  parseRecordingUploadReplacement,
  recordingUploadFileManifestSha256,
  recordingUploadRequestFingerprint,
  recordingUploadShape,
  sha256RecordingStream,
  validateCompletedRecordingParts,
} from "./recording-upload";

class TestDigestStream extends WritableStream<ArrayBuffer | ArrayBufferView> {
  readonly digest: Promise<ArrayBuffer>;
  bytesWritten = 0;

  constructor() {
    const chunks: Uint8Array[] = [];
    let resolveDigest!: (digest: ArrayBuffer) => void;
    let rejectDigest!: (error: unknown) => void;
    const digest = new Promise<ArrayBuffer>((resolve, reject) => {
      resolveDigest = resolve;
      rejectDigest = reject;
    });
    super({
      write: (chunk) => {
        const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        chunks.push(bytes.slice());
        this.bytesWritten += bytes.byteLength;
      },
      close: async () => {
        try {
          const bytes = new Uint8Array(this.bytesWritten);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          resolveDigest(await crypto.subtle.digest("SHA-256", bytes));
        } catch (error) {
          rejectDigest(error);
        }
      },
      abort: rejectDigest,
    });
    this.digest = digest;
  }
}

describe("Recording multipart upload contract", () => {
  it("normalizes a strict idempotent upload request without trusting MIME or paths", async () => {
    const parsed = parseRecordingUploadCreate({
      clientMutationId: "3f2a1dc0-49aa-4e52-a27a-74d1372aa219",
      fileManifestSha256: "e".repeat(64),
      filename: "../private/take.M4A",
      mimeType: "not a mime type",
      byteSize: 123,
      description: "  Early take  ",
      recordedOn: "2020-02-29",
      creditPersonIds: ["person-1"],
    });
    expect(parsed).toEqual({
      success: true,
      data: {
        clientMutationId: "3f2a1dc0-49aa-4e52-a27a-74d1372aa219",
        fileManifestSha256: "e".repeat(64),
        filename: "take.M4A",
        mimeTypeHint: null,
        byteSize: 123,
        partCount: 1,
        replaceTarget: null,
        description: "Early take",
        recordedOn: "2020-02-29",
        creditPersonIds: ["person-1"],
      },
    });
    if (!parsed.success) throw new Error("fixture failed");
    await expect(recordingUploadRequestFingerprint("song-1", parsed.data))
      .resolves.toMatch(/^[a-f0-9]{64}$/u);
  });

  it("requires a complete replacement target and rejects extra replacement fields", () => {
    expect(parseRecordingUploadCreate({
      clientMutationId: "123e4567-e89b-42d3-a456-426614174000",
      filename: "take.wav",
      byteSize: 3,
      targetRecordingId: "recording-1",
    }).success).toBe(false);
    expect(parseRecordingUploadReplacement({
      targetRecordingId: "recording-1",
      targetRecordingRevision: 1,
      sessionRevision: 4,
      revision: 4,
    }).success).toBe(false);
  });

  it("requires and validates the exact-file manifest", () => {
    expect(parseRecordingUploadFileIdentity({
      fileManifestSha256: "e".repeat(64),
    })).toEqual({
      success: true,
      data: { fileManifestSha256: "e".repeat(64) },
    });
    expect(parseRecordingUploadFileIdentity({ fileManifestSha256: "E".repeat(64) }).success)
      .toBe(false);
    expect(parseRecordingUploadCreate({
      clientMutationId: "123e4567-e89b-42d3-a456-426614174000",
      filename: "take.mp3",
      byteSize: 3,
    }).success).toBe(false);
  });

  it("rejects invalid dates, duplicate credits, empty files, and mutation reuse without a UUID", () => {
    expect(parseRecordingUploadCreate({
      clientMutationId: "not-a-uuid",
      filename: "take.mp3",
      byteSize: 0,
      recordedOn: "2999-01-01",
      creditPersonIds: ["person-1", "person-1"],
    }).success).toBe(false);
  });

  it("accepts an optional trimmed finalization override and rejects blank metadata", () => {
    expect(parseRecordingUploadFinalization({
      revision: 5,
      description: "  Alternate take  ",
    })).toEqual({
      success: true,
      data: { revision: 5, description: "Alternate take" },
    });
    expect(parseRecordingUploadFinalization({ revision: 5 })).toEqual({
      success: true,
      data: { revision: 5 },
    });
    expect(parseRecordingUploadFinalization({ revision: 5, description: "   " }).success)
      .toBe(false);
  });
  it("bounds originals and calculates the exact part count", () => {
    expect(recordingUploadShape(1)).toEqual({ byteSize: 1, partCount: 1 });
    expect(recordingUploadShape(RECORDING_UPLOAD_PART_BYTES)).toEqual({
      byteSize: RECORDING_UPLOAD_PART_BYTES,
      partCount: 1,
    });
    expect(recordingUploadShape(RECORDING_UPLOAD_PART_BYTES + 1)).toEqual({
      byteSize: RECORDING_UPLOAD_PART_BYTES + 1,
      partCount: 2,
    });
    expect(recordingUploadShape(0)).toBeNull();
    expect(recordingUploadShape(MAX_RECORDING_UPLOAD_BYTES + 1)).toBeNull();
    expect(recordingUploadShape(1.5)).toBeNull();
  });

  it("requires uniform full parts and an exact final remainder", () => {
    const byteSize = (RECORDING_UPLOAD_PART_BYTES * 2) + 123;
    expect(expectedRecordingPartBytes(byteSize, 1)).toBe(RECORDING_UPLOAD_PART_BYTES);
    expect(expectedRecordingPartBytes(byteSize, 2)).toBe(RECORDING_UPLOAD_PART_BYTES);
    expect(expectedRecordingPartBytes(byteSize, 3)).toBe(123);
    expect(expectedRecordingPartBytes(byteSize, 0)).toBeNull();
    expect(expectedRecordingPartBytes(byteSize, 4)).toBeNull();
  });

  it("accepts a complete unordered R2 part set for finalization", () => {
    const byteSize = RECORDING_UPLOAD_PART_BYTES + 1;
    expect(validateCompletedRecordingParts(byteSize, [
      { partNumber: 2, etag: "etag-two", byteSize: 1, sha256: "b".repeat(64) },
      { partNumber: 1, etag: "etag-one", byteSize: RECORDING_UPLOAD_PART_BYTES, sha256: "a".repeat(64) },
    ])).toBe(true);
  });

  it("rejects missing, duplicate, out-of-range, or unsafe part metadata", () => {
    const byteSize = RECORDING_UPLOAD_PART_BYTES + 1;
    expect(validateCompletedRecordingParts(byteSize, [
      { partNumber: 1, etag: "etag", byteSize: RECORDING_UPLOAD_PART_BYTES, sha256: "a".repeat(64) },
    ])).toBe(false);
    expect(validateCompletedRecordingParts(byteSize, [
      { partNumber: 1, etag: "one", byteSize: RECORDING_UPLOAD_PART_BYTES, sha256: "a".repeat(64) },
      { partNumber: 1, etag: "again", byteSize: 1, sha256: "b".repeat(64) },
    ])).toBe(false);
    expect(validateCompletedRecordingParts(byteSize, [
      { partNumber: 1, etag: "one", byteSize: RECORDING_UPLOAD_PART_BYTES, sha256: "a".repeat(64) },
      { partNumber: 3, etag: "three", byteSize: 1, sha256: "b".repeat(64) },
    ])).toBe(false);
    expect(validateCompletedRecordingParts(byteSize, [
      { partNumber: 1, etag: "one\nprivate", byteSize: RECORDING_UPLOAD_PART_BYTES, sha256: "a".repeat(64) },
      { partNumber: 2, etag: "two", byteSize: 1, sha256: "b".repeat(64) },
    ])).toBe(false);
    expect(validateCompletedRecordingParts(byteSize, [
      { partNumber: 1, etag: "one", byteSize: RECORDING_UPLOAD_PART_BYTES - 1, sha256: "a".repeat(64) },
      { partNumber: 2, etag: "two", byteSize: 1, sha256: "b".repeat(64) },
    ])).toBe(false);
    expect(validateCompletedRecordingParts(byteSize, [
      { partNumber: 1, etag: "one", byteSize: RECORDING_UPLOAD_PART_BYTES, sha256: null },
      { partNumber: 2, etag: "two", byteSize: 1, sha256: "b".repeat(64) },
    ])).toBe(false);
  });

  it("derives one deterministic manifest from the ordered part identities", async () => {
    const byteSize = RECORDING_UPLOAD_PART_BYTES + 1;
    const parts = [
      { partNumber: 2, byteSize: 1, sha256: "b".repeat(64) },
      { partNumber: 1, byteSize: RECORDING_UPLOAD_PART_BYTES, sha256: "a".repeat(64) },
    ];
    const manifest = await recordingUploadFileManifestSha256(byteSize, parts);
    expect(manifest).toMatch(/^[a-f0-9]{64}$/u);
    await expect(recordingUploadFileManifestSha256(byteSize, [...parts].reverse()))
      .resolves.toBe(manifest);
    await expect(recordingUploadFileManifestSha256(byteSize, [parts[0]!]))
      .resolves.toBeNull();
  });

  it("hashes a private object stream without buffering it in application code", async () => {
    const body = new Response("abc").body;
    if (!body) throw new Error("missing test body");
    await expect(sha256RecordingStream(
      body,
      () => new TestDigestStream() as unknown as DigestStream,
    )).resolves.toEqual({
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      byteSize: 3,
    });
  });
});
