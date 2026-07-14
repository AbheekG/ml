import { describe, expect, it } from "vitest";
import {
  AUDIO_PROCESSING_POLICY_ID,
  canTransitionAudioProcessingJob,
  isSafeProcessingErrorCode,
  parseVerifiedHostedResult,
} from "./audio-processing-jobs";

const original = { sha256: "a".repeat(64), byte_size: 100, codec: "aac" };
const derivative = { sha256: "b".repeat(64), byte_size: 60, codec: "mp3" };

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    jobId: "opaque_job-1",
    policyId: AUDIO_PROCESSING_POLICY_ID,
    status: "created_derivative",
    playbackKind: "derivative",
    original,
    derivative,
    validation: { accepted: true, reason: "accepted" },
    ...overrides,
  };
}

describe("audio processing job boundary", () => {
  it("accepts a verified derivative result and extracts finalization facts", () => {
    expect(parseVerifiedHostedResult(result())).toEqual({
      jobId: "opaque_job-1",
      policyId: AUDIO_PROCESSING_POLICY_ID,
      playbackKind: "derivative",
      originalSha256: "a".repeat(64),
      originalByteSize: 100,
      derivativeSha256: "b".repeat(64),
      derivativeByteSize: 60,
    });
  });

  it("accepts a verified direct-original result", () => {
    expect(parseVerifiedHostedResult(result({
      status: "original_is_playback",
      playbackKind: "original",
      original: { ...original, codec: "mp3" },
      derivative: null,
      validation: null,
    }))).toMatchObject({ playbackKind: "original", derivativeSha256: null });
  });

  it("rejects stale policies, mismatched status, and unverified derivatives", () => {
    expect(parseVerifiedHostedResult(result({ policyId: "mp3-v0" }))).toBeNull();
    expect(parseVerifiedHostedResult(result({ playbackKind: "original" }))).toBeNull();
    expect(parseVerifiedHostedResult(result({ validation: { accepted: false } }))).toBeNull();
  });

  it("allows only explicit retry-safe job transitions", () => {
    expect(canTransitionAudioProcessingJob("pending", "running")).toBe(true);
    expect(canTransitionAudioProcessingJob("running", "pending")).toBe(true);
    expect(canTransitionAudioProcessingJob("running", "succeeded")).toBe(true);
    expect(canTransitionAudioProcessingJob("failed", "pending")).toBe(true);
    expect(canTransitionAudioProcessingJob("pending", "succeeded")).toBe(false);
    expect(canTransitionAudioProcessingJob("succeeded", "pending")).toBe(false);
  });

  it("keeps stored failure codes bounded and privacy-safe", () => {
    expect(isSafeProcessingErrorCode("source_decode_failed")).toBe(true);
    expect(isSafeProcessingErrorCode("Private filename.mp3 failed")).toBe(false);
    expect(isSafeProcessingErrorCode("x".repeat(101))).toBe(false);
  });
});
