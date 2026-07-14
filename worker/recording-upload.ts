import { z } from "zod";
import { parseRecordingCreateMetadata } from "./recording-writes";

export const RECORDING_UPLOAD_PART_BYTES = 8 * 1024 * 1024;
export const MAX_RECORDING_UPLOAD_BYTES = 512 * 1024 * 1024;
export const MAX_RECORDING_UPLOAD_PARTS = MAX_RECORDING_UPLOAD_BYTES / RECORDING_UPLOAD_PART_BYTES;
export const RECORDING_UPLOAD_EXPIRY_MS = 24 * 60 * 60 * 1000;

const createUploadEnvelopeSchema = z.object({
  clientMutationId: z.uuid(),
  filename: z.string().max(1_000),
  mimeType: z.string().max(100).nullable().optional(),
  byteSize: z.number().int().positive().max(MAX_RECORDING_UPLOAD_BYTES),
  description: z.string().max(10_000).nullable().optional(),
  recordedOn: z.string().nullable().optional(),
  creditPersonIds: z.array(z.string()).optional(),
}).strict();

const recordingUploadRevisionSchema = z.object({
  revision: z.number().int().positive(),
}).strict();

export type RecordingUploadCreateInput = {
  clientMutationId: string;
  filename: string;
  mimeTypeHint: string | null;
  byteSize: number;
  partCount: number;
  description: string | null;
  recordedOn: string | null;
  creditPersonIds: string[];
};

export type RecordingUploadParseResult =
  | { success: true; data: RecordingUploadCreateInput }
  | { success: false; fields: Record<string, string[]> };

export type RecordingUploadRevisionParseResult =
  | { success: true; data: { revision: number } }
  | { success: false };

function safeOriginalFilename(value: string): string {
  const basename = value.replaceAll("\0", "").split(/[\\/]/u).at(-1)?.trim() ?? "";
  return (basename || "recording").slice(0, 255);
}

function mimeTypeHint(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(normalized)
    ? normalized
    : null;
}

export function parseRecordingUploadCreate(value: unknown): RecordingUploadParseResult {
  const envelope = createUploadEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of envelope.error.issues) {
      const field = String(issue.path[0] ?? "form");
      (fields[field] ??= []).push(issue.message);
    }
    return { success: false, fields };
  }
  const metadata = parseRecordingCreateMetadata({
    description: envelope.data.description,
    recordedOn: envelope.data.recordedOn,
    creditPersonIds: envelope.data.creditPersonIds,
  });
  if (!metadata.success) return metadata;
  const shape = recordingUploadShape(envelope.data.byteSize);
  if (!shape) return { success: false, fields: { byteSize: ["Invalid Recording size"] } };
  return {
    success: true,
    data: {
      clientMutationId: envelope.data.clientMutationId,
      filename: safeOriginalFilename(envelope.data.filename),
      mimeTypeHint: mimeTypeHint(envelope.data.mimeType),
      byteSize: shape.byteSize,
      partCount: shape.partCount,
      ...metadata.data,
    },
  };
}

export function parseRecordingUploadRevision(value: unknown): RecordingUploadRevisionParseResult {
  const result = recordingUploadRevisionSchema.safeParse(value);
  return result.success ? { success: true, data: result.data } : { success: false };
}

export async function recordingUploadRequestFingerprint(
  songId: string,
  input: RecordingUploadCreateInput,
): Promise<string> {
  const canonical = JSON.stringify({ songId, ...input });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type RecordingUploadShape = {
  byteSize: number;
  partCount: number;
};

export function recordingUploadShape(byteSize: number): RecordingUploadShape | null {
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0 || byteSize > MAX_RECORDING_UPLOAD_BYTES) {
    return null;
  }
  return {
    byteSize,
    partCount: Math.ceil(byteSize / RECORDING_UPLOAD_PART_BYTES),
  };
}

export function expectedRecordingPartBytes(
  byteSize: number,
  partNumber: number,
): number | null {
  const shape = recordingUploadShape(byteSize);
  if (!shape || !Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > shape.partCount) {
    return null;
  }
  if (partNumber < shape.partCount) return RECORDING_UPLOAD_PART_BYTES;
  return byteSize - ((shape.partCount - 1) * RECORDING_UPLOAD_PART_BYTES);
}

export function validateCompletedRecordingParts(
  byteSize: number,
  parts: Array<{ partNumber: number; etag: string; byteSize: number }>,
): boolean {
  const shape = recordingUploadShape(byteSize);
  if (!shape || parts.length !== shape.partCount) return false;
  const seen = new Set<number>();
  for (const part of parts) {
    if (
      !Number.isSafeInteger(part.partNumber)
      || part.partNumber < 1
      || part.partNumber > shape.partCount
      || seen.has(part.partNumber)
      || typeof part.etag !== "string"
      || part.etag.length === 0
      || part.etag.length > 200
      || /[\r\n]/u.test(part.etag)
      || part.byteSize !== expectedRecordingPartBytes(byteSize, part.partNumber)
    ) return false;
    seen.add(part.partNumber);
  }
  return seen.size === shape.partCount;
}

export async function sha256RecordingStream(
  body: ReadableStream,
  createDigestStream: () => DigestStream = () => new crypto.DigestStream("SHA-256"),
): Promise<{ sha256: string; byteSize: number }> {
  const digestStream = createDigestStream();
  await body.pipeTo(digestStream);
  const byteSize = Number(digestStream.bytesWritten);
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
    throw new Error("invalid_recording_digest_size");
  }
  const digest = await digestStream.digest;
  const sha256 = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error("invalid_recording_digest");
  }
  return { sha256, byteSize };
}
