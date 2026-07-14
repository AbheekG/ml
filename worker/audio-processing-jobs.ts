import { z } from "zod";

export const AUDIO_PROCESSING_POLICY_ID = "mp3-v1-libmp3lame-q2";

export type AudioProcessingJobStatus = "pending" | "running" | "succeeded" | "failed";
export type AudioProcessingPlaybackKind = "original" | "derivative";

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,99}$/u;

const hostedResultSchema = z.object({
  schemaVersion: z.literal(1),
  jobId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/u),
  policyId: z.literal(AUDIO_PROCESSING_POLICY_ID),
  status: z.enum([
    "original_is_playback",
    "created_derivative",
    "verified_existing_derivative",
    "candidate_discarded_original_is_playback",
  ]),
  playbackKind: z.enum(["original", "derivative"]),
  original: z.object({
    sha256: z.string().regex(SHA256),
    byte_size: z.number().int().positive(),
  }).passthrough(),
  derivative: z.object({
    sha256: z.string().regex(SHA256),
    byte_size: z.number().int().positive(),
  }).passthrough().nullable(),
  validation: z.object({ accepted: z.literal(true) }).passthrough().nullable(),
}).passthrough().superRefine((value, context) => {
  const derivativeStatus = value.status === "created_derivative"
    || value.status === "verified_existing_derivative";
  if (derivativeStatus !== (value.playbackKind === "derivative")) {
    context.addIssue({ code: "custom", message: "Processing status and playback kind disagree" });
  }
  if (derivativeStatus && (value.derivative === null || value.validation?.accepted !== true)) {
    context.addIssue({ code: "custom", message: "Derivative result is not verified" });
  }
  if (!derivativeStatus && value.derivative !== null) {
    context.addIssue({ code: "custom", message: "Original playback result includes a derivative" });
  }
});

export type VerifiedHostedResult = {
  jobId: string;
  policyId: typeof AUDIO_PROCESSING_POLICY_ID;
  playbackKind: AudioProcessingPlaybackKind;
  originalSha256: string;
  originalByteSize: number;
  derivativeSha256: string | null;
  derivativeByteSize: number | null;
};

export function parseVerifiedHostedResult(value: unknown): VerifiedHostedResult | null {
  const result = hostedResultSchema.safeParse(value);
  if (!result.success) return null;
  return {
    jobId: result.data.jobId,
    policyId: result.data.policyId,
    playbackKind: result.data.playbackKind,
    originalSha256: result.data.original.sha256,
    originalByteSize: result.data.original.byte_size,
    derivativeSha256: result.data.derivative?.sha256 ?? null,
    derivativeByteSize: result.data.derivative?.byte_size ?? null,
  };
}

export function canTransitionAudioProcessingJob(
  current: AudioProcessingJobStatus,
  next: AudioProcessingJobStatus,
): boolean {
  return (current === "pending" && next === "running")
    || (current === "running" && (next === "succeeded" || next === "failed" || next === "pending"))
    || (current === "failed" && next === "pending");
}

export function isSafeProcessingErrorCode(value: string): boolean {
  return SAFE_CODE.test(value);
}
