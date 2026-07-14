import { describe, expect, it } from "vitest";
import {
  AUDIO_PROCESSING_POLICY_ID,
  canTransitionAudioProcessingJob,
  hostedResultMatchesAudioProcessingJob,
  isSafeProcessingErrorCode,
  parseVerifiedHostedResult,
} from "./audio-processing-jobs";

const original = {
  sha256: "a".repeat(64), byte_size: 100, codec: "aac", containers: ["m4a"],
  duration_seconds: 10, bit_rate: 80, sample_rate: 44_100, channels: 2,
  had_decode_warnings: false,
};
const derivative = {
  sha256: "b".repeat(64), byte_size: 60, codec: "mp3", containers: ["mp3"],
  duration_seconds: 10, bit_rate: 48, sample_rate: 44_100, channels: 2,
  had_decode_warnings: false,
};

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    jobId: "opaque_job-1",
    policyId: AUDIO_PROCESSING_POLICY_ID,
    status: "created_derivative",
    playbackKind: "derivative",
    original,
    derivative,
    decision: { kind: "require_derivative", reason: "non_mp3_source" },
    validation: { accepted: true, reason: "accepted", saving_fraction: null },
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
      decision: { kind: "use_original", reason: "canonical_mp3" },
      validation: null,
    }))).toMatchObject({ playbackKind: "original", derivativeSha256: null });
  });

  it("rejects stale policies, mismatched status, and unverified derivatives", () => {
    expect(parseVerifiedHostedResult(result({ policyId: "mp3-v0" }))).toBeNull();
    expect(parseVerifiedHostedResult(result({ playbackKind: "original" }))).toBeNull();
    expect(parseVerifiedHostedResult(result({ validation: { accepted: false } }))).toBeNull();
    expect(parseVerifiedHostedResult(result({ sourceDownloadUrl: "private" }))).toBeNull();
  });

  it("accepts an uneconomical oversized candidate as verified direct-original playback", () => {
    expect(parseVerifiedHostedResult(result({
      status: "candidate_discarded_original_is_playback",
      playbackKind: "original",
      original: { ...original, codec: "mp3", containers: ["mp3"] },
      derivative: null,
      decision: {
        kind: "try_oversized_mp3_derivative",
        reason: "oversized_high_bitrate_mp3",
      },
      validation: {
        accepted: false,
        reason: "oversized_mp3_saving_not_material",
        saving_fraction: 0.1,
      },
    }))).toMatchObject({ playbackKind: "original", derivativeSha256: null });
  });

  it("binds a hosted result to the exact durable job and original", () => {
    const parsed = parseVerifiedHostedResult(result());
    expect(parsed).not.toBeNull();
    expect(hostedResultMatchesAudioProcessingJob(parsed!, {
      id: "opaque_job-1",
      policyId: AUDIO_PROCESSING_POLICY_ID,
      sourceSha256: "a".repeat(64),
      sourceByteSize: 100,
    })).toBe(true);
    expect(hostedResultMatchesAudioProcessingJob(parsed!, {
      id: "opaque_job-1",
      policyId: AUDIO_PROCESSING_POLICY_ID,
      sourceSha256: "c".repeat(64),
      sourceByteSize: 100,
    })).toBe(false);
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
