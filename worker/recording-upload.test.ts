import { describe, expect, it } from "vitest";
import {
  MAX_RECORDING_UPLOAD_BYTES,
  RECORDING_UPLOAD_PART_BYTES,
  expectedRecordingPartBytes,
  recordingUploadShape,
  validateCompletedRecordingParts,
} from "./recording-upload";

describe("Recording multipart upload contract", () => {
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
      { partNumber: 2, etag: "etag-two" },
      { partNumber: 1, etag: "etag-one" },
    ])).toBe(true);
  });

  it("rejects missing, duplicate, out-of-range, or unsafe part metadata", () => {
    const byteSize = RECORDING_UPLOAD_PART_BYTES + 1;
    expect(validateCompletedRecordingParts(byteSize, [{ partNumber: 1, etag: "etag" }])).toBe(false);
    expect(validateCompletedRecordingParts(byteSize, [
      { partNumber: 1, etag: "one" },
      { partNumber: 1, etag: "again" },
    ])).toBe(false);
    expect(validateCompletedRecordingParts(byteSize, [
      { partNumber: 1, etag: "one" },
      { partNumber: 3, etag: "three" },
    ])).toBe(false);
    expect(validateCompletedRecordingParts(byteSize, [
      { partNumber: 1, etag: "one\nprivate" },
      { partNumber: 2, etag: "two" },
    ])).toBe(false);
  });
});
