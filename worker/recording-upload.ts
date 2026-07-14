export const RECORDING_UPLOAD_PART_BYTES = 8 * 1024 * 1024;
export const MAX_RECORDING_UPLOAD_BYTES = 512 * 1024 * 1024;
export const MAX_RECORDING_UPLOAD_PARTS = MAX_RECORDING_UPLOAD_BYTES / RECORDING_UPLOAD_PART_BYTES;

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
  parts: Array<{ partNumber: number; etag: string }>,
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
    ) return false;
    seen.add(part.partNumber);
  }
  return seen.size === shape.partCount;
}
