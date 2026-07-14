import { z } from "zod";

export const AUDIO_PROCESSING_POLICY_ID = "mp3-v1-libmp3lame-q2";

export type AudioProcessingJobStatus = "pending" | "running" | "succeeded" | "failed";
export type AudioProcessingPlaybackKind = "original" | "derivative";

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,99}$/u;

const hostedFileSummarySchema = z.object({
  sha256: z.string().regex(SHA256),
  byte_size: z.number().int().positive(),
  codec: z.string().min(1).max(100),
  containers: z.array(z.string().min(1).max(100)).min(1).max(20),
  duration_seconds: z.number().positive().finite(),
  bit_rate: z.number().int().nonnegative(),
  sample_rate: z.number().int().positive(),
  channels: z.number().int().positive(),
  had_decode_warnings: z.boolean(),
}).strict();

const hostedValidationSchema = z.object({
  accepted: z.boolean(),
  reason: z.string().regex(SAFE_CODE),
  saving_fraction: z.number().min(0).max(1).nullable(),
}).strict();

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
  original: hostedFileSummarySchema,
  derivative: hostedFileSummarySchema.nullable(),
  decision: z.object({
    kind: z.enum(["use_original", "require_derivative", "try_oversized_mp3_derivative"]),
    reason: z.string().regex(SAFE_CODE),
  }).strict(),
  validation: hostedValidationSchema.nullable(),
}).strict().superRefine((value, context) => {
  const derivativeStatus = value.status === "created_derivative"
    || value.status === "verified_existing_derivative";
  const discardedCandidate = value.status === "candidate_discarded_original_is_playback";
  if (derivativeStatus !== (value.playbackKind === "derivative")) {
    context.addIssue({ code: "custom", message: "Processing status and playback kind disagree" });
  }
  if (derivativeStatus && (value.derivative === null || value.validation?.accepted !== true)) {
    context.addIssue({ code: "custom", message: "Derivative result is not verified" });
  }
  if (!derivativeStatus && value.derivative !== null) {
    context.addIssue({ code: "custom", message: "Original playback result includes a derivative" });
  }
  if (discardedCandidate && (
    value.validation?.accepted !== false
    || value.validation.reason !== "oversized_mp3_saving_not_material"
  )) {
    context.addIssue({ code: "custom", message: "Discarded candidate result is invalid" });
  }
  if (!derivativeStatus && !discardedCandidate && value.validation !== null) {
    context.addIssue({ code: "custom", message: "Direct original result includes validation" });
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

export type ExpectedAudioProcessingJob = {
  id: string;
  policyId: typeof AUDIO_PROCESSING_POLICY_ID;
  sourceSha256: string;
  sourceByteSize: number;
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

export function hostedResultMatchesAudioProcessingJob(
  result: VerifiedHostedResult,
  job: ExpectedAudioProcessingJob,
): boolean {
  return result.jobId === job.id
    && result.policyId === job.policyId
    && result.originalSha256 === job.sourceSha256
    && result.originalByteSize === job.sourceByteSize;
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
