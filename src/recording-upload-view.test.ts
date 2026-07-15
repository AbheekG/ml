import { describe, expect, it } from "vitest";
import {
  RECORDING_FILE_ACCEPT,
  canAbortRecordingUpload,
  formatRecordingBytes,
  recordingUploadPercent,
  recordingUploadProgressLabel,
} from "./recording-upload-view";

describe("Recording upload presentation", () => {
  it("formats private file sizes without exposing paths", () => {
    expect(formatRecordingBytes(1)).toBe("1 KB");
    expect(formatRecordingBytes(1536)).toBe("2 KB");
    expect(formatRecordingBytes(12 * 1024 * 1024)).toBe("12.0 MB");
  });

  it("bounds progress and labels every durable phase", () => {
    const base = {
      completedParts: 1,
      totalParts: 2,
      totalBytes: 100,
      upload: null,
    };
    expect(recordingUploadPercent({ ...base, phase: "uploading", completedBytes: 49 })).toBe(49);
    expect(recordingUploadPercent({ ...base, phase: "uploading", completedBytes: 101 })).toBe(100);
    expect(recordingUploadProgressLabel({ ...base, phase: "creating", completedBytes: 0 })).toContain("Starting");
    expect(recordingUploadProgressLabel({ ...base, phase: "uploading", completedBytes: 49 })).toContain("49%");
    expect(recordingUploadProgressLabel({ ...base, phase: "completing", completedBytes: 100 })).toContain("Verifying");
    expect(recordingUploadProgressLabel({ ...base, phase: "finalizing", completedBytes: 100 })).toContain("processing job");
  });

  it("offers broad audio selection as a hint while retaining the upload bound", () => {
    expect(RECORDING_FILE_ACCEPT).toContain("audio/*");
    expect(RECORDING_FILE_ACCEPT).toContain(".mp3");
    expect(RECORDING_FILE_ACCEPT).toContain(".flac");
  });

  it("allows explicit abort only before storage completion", () => {
    expect(canAbortRecordingUpload("creating")).toBe(true);
    expect(canAbortRecordingUpload("open")).toBe(true);
    expect(canAbortRecordingUpload("completing")).toBe(false);
    expect(canAbortRecordingUpload("stored")).toBe(false);
    expect(canAbortRecordingUpload("duplicate")).toBe(false);
    expect(canAbortRecordingUpload("finalized")).toBe(false);
    expect(canAbortRecordingUpload("aborted")).toBe(false);
    expect(canAbortRecordingUpload("failed")).toBe(false);
  });
});
