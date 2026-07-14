import { z } from "zod";
import { MAX_RECORDING_UPLOAD_BYTES } from "./recording-upload";

export const AUDIO_PROCESSING_LEASE_MS = 60 * 60 * 1000;
export const MAX_EXPIRED_AUDIO_PROCESSING_ATTEMPTS = 3;
export const MAX_AUDIO_DERIVATIVE_BYTES = MAX_RECORDING_UPLOAD_BYTES;
export const MAX_AUDIO_PROCESSING_RESULT_BYTES = 64 * 1024;

const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{0,99}$/u;
const SAFE_JOB_ID = /^[A-Za-z0-9_-]{1,100}$/u;
const CAPABILITY_TOKEN = /^([A-Za-z0-9_-]{43})\.([a-f0-9]{64})$/u;

export type AudioProcessingCapabilityOperation =
  | "source" | "derivative" | "result" | "failure";

const failureSchema = z.object({
  errorCode: z.string().regex(SAFE_ERROR_CODE),
}).strict();

export type AudioProcessingFailureInput = { errorCode: string };

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashAudioProcessingToken(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function processorTokenMatches(
  candidate: string | null,
  configured: string,
): Promise<boolean> {
  const supplied = candidate ?? "";
  const [suppliedHash, configuredHash] = await Promise.all([
    hashAudioProcessingToken(supplied),
    hashAudioProcessingToken(configured),
  ]);
  let difference = supplied.length === configured.length ? 0 : 1;
  for (let index = 0; index < suppliedHash.length; index += 1) {
    difference |= suppliedHash.charCodeAt(index) ^ configuredHash.charCodeAt(index);
  }
  return difference === 0;
}

export function createAudioProcessingLeaseToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function capabilitySignature(
  leaseToken: string,
  jobId: string,
  attemptCount: number,
  operation: AudioProcessingCapabilityOperation,
  processorToken: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(processorToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = `audio-processing-capability-v1\n${jobId}\n${attemptCount}\n${operation}\n${leaseToken}`;
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToHex(new Uint8Array(signature));
}

export async function createAudioProcessingCapabilityToken(
  leaseToken: string,
  jobId: string,
  attemptCount: number,
  operation: AudioProcessingCapabilityOperation,
  processorToken: string,
): Promise<string> {
  if (!SAFE_JOB_ID.test(jobId) || !Number.isSafeInteger(attemptCount) || attemptCount < 1) {
    throw new Error("invalid_audio_processing_capability_scope");
  }
  const signature = await capabilitySignature(
    leaseToken, jobId, attemptCount, operation, processorToken,
  );
  return `${leaseToken}.${signature}`;
}

export async function verifyAudioProcessingCapabilityToken(
  capabilityToken: string | null,
  jobId: string,
  attemptCount: number,
  operation: AudioProcessingCapabilityOperation,
  processorToken: string | undefined,
): Promise<string | null> {
  if (!capabilityToken || !processorToken || processorToken.length < 32) return null;
  const match = CAPABILITY_TOKEN.exec(capabilityToken);
  if (!match || !SAFE_JOB_ID.test(jobId) || !Number.isSafeInteger(attemptCount)) return null;
  const expected = await capabilitySignature(
    match[1], jobId, attemptCount, operation, processorToken,
  );
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ match[2].charCodeAt(index);
  }
  return difference === 0 ? match[1] : null;
}

export function parseBearerToken(value: string | undefined): string | null {
  const match = /^Bearer ([^\s]+)$/u.exec(value ?? "");
  return match?.[1] ?? null;
}

export function parseAudioProcessingFailure(value: unknown): AudioProcessingFailureInput | null {
  const result = failureSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function audioProcessingDerivativeObjectKey(jobId: string, attemptCount: number): string | null {
  if (!SAFE_JOB_ID.test(jobId) || !Number.isSafeInteger(attemptCount) || attemptCount < 1) return null;
  return `recordings/playback/pending/${jobId}/attempt-${attemptCount}.mp3`;
}

export function normalizeProcessorTransferOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
      || parsed.origin !== value
    ) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function buildAudioProcessingCapabilityUrl(
  origin: string,
  jobId: string,
  operation: AudioProcessingCapabilityOperation,
  capabilityToken: string,
): string {
  const url = new URL(`/api/processing/jobs/${encodeURIComponent(jobId)}/${operation}`, origin);
  url.searchParams.set("token", capabilityToken);
  return url.toString();
}
