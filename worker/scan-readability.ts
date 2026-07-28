import { sha256Hex } from "./media-upload";

export const SCAN_READABILITY_POLICY_ID = "scan-jpeg-v1-2400-q85";
export const SCAN_READABILITY_SELECTION_POLICY_ID = "scan-readability-selection-v2";
export const SCAN_READABILITY_MAX_DIMENSION = 2400;
export const SCAN_IMAGE_MAX_PIXELS = 100_000_000;
export const MAX_SCAN_IMAGE_BINDING_BYTES = 20_000_000;
export const MAX_SCAN_READABILITY_BYTES = 20 * 1024 * 1024;
export const SCAN_OPTIONAL_CANDIDATE_MIN_SOURCE_BYTES = 1024 * 1024;
export const SCAN_OPTIONAL_MIN_SAVINGS_BYTES = 256 * 1024;
export const SCAN_OPTIONAL_MIN_SAVINGS_PERCENT = 20;
const SCAN_IMAGE_OPERATION_TIMEOUT_MS = 15_000;

export type ScanReadabilityDerivative = {
  bytes: Uint8Array;
  mimeType: "image/jpeg";
  sha256: string;
  width: number;
  height: number;
  policyId: typeof SCAN_READABILITY_POLICY_ID;
};

export type ScanReadabilitySelection = {
  representationKind: "source" | "derivative";
  selectionBasis:
    | "direct_safe_source"
    | "required_normalization"
    | "optional_material_savings";
  policyId: typeof SCAN_READABILITY_SELECTION_POLICY_ID;
  sourceWidth: number;
  sourceHeight: number;
  candidateByteSize: number | null;
  derivative: ScanReadabilityDerivative | null;
};

export class ScanReadabilityError extends Error {
  constructor(readonly code:
    | "scan_image_too_large"
    | "scan_image_decode_failed"
    | "scan_image_dimensions_invalid"
    | "scan_readability_generation_failed"
    | "scan_readability_output_invalid") {
    super(code);
  }
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([bytes.slice().buffer]).stream();
}

function dimensions(info: ImageInfoResponse): { width: number; height: number } | null {
  if (!("width" in info) || !("height" in info)) return null;
  if (!Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height)) return null;
  if (info.width < 1 || info.height < 1) return null;
  return { width: info.width, height: info.height };
}

export function scanJpegIsDirectlyUsable(
  bytes: Uint8Array,
  decoded: { width: number; height: number },
): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  let frameFound = false;
  let frameComponents: 1 | 3 | null = null;
  let jfifFound = false;
  let inEntropyData = false;

  while (offset < bytes.length) {
    let marker: number;
    if (inEntropyData) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) return false;
      const entropyMarker = bytes[offset]!;
      offset += 1;
      if (entropyMarker === 0x00 || (entropyMarker >= 0xd0 && entropyMarker <= 0xd7)) {
        continue;
      }
      if (entropyMarker === 0xd9) return frameFound && offset === bytes.length;
      inEntropyData = false;
      marker = entropyMarker;
    } else {
      if (bytes[offset] !== 0xff) return false;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) return false;
      marker = bytes[offset]!;
      offset += 1;
    }

    if (marker === 0xd9 || marker === 0xd8 || marker === 0x01
      || (marker >= 0xd0 && marker <= 0xd7)) {
      return false;
    }
    if (offset + 2 > bytes.length) return false;
    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return false;

    if (marker === 0xe0) {
      // A minimal JFIF header carries no thumbnail or free-form metadata.
      if (jfifFound
        || segmentLength !== 16
        || bytes[offset + 2] !== 0x4a
        || bytes[offset + 3] !== 0x46
        || bytes[offset + 4] !== 0x49
        || bytes[offset + 5] !== 0x46
        || bytes[offset + 6] !== 0x00
        || bytes[offset + 14] !== 0
        || bytes[offset + 15] !== 0) {
        return false;
      }
      jfifFound = true;
    } else if (marker >= 0xe1 && marker <= 0xef) {
      // EXIF/XMP/IPTC/ICC/Adobe and unknown application segments require
      // normalization. They may carry orientation, thumbnails, or private data.
      return false;
    } else if (marker === 0xfe) {
      return false;
    } else if (marker === 0xc0 || marker === 0xc2) {
      if (frameFound || segmentLength < 11) return false;
      const precision = bytes[offset + 2]!;
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const components = bytes[offset + 7]!;
      if (precision !== 8
        || (components !== 1 && components !== 3)
        || segmentLength !== 8 + (3 * components)
        || width !== decoded.width
        || height !== decoded.height) {
        return false;
      }
      frameFound = true;
      frameComponents = components;
    } else if (marker === 0xda) {
      const components = bytes[offset + 2]!;
      if (!frameFound
        || frameComponents === null
        || components < 1
        || components > frameComponents
        || segmentLength !== 6 + (2 * components)) {
        return false;
      }
      inEntropyData = true;
    } else if ((marker >= 0xc1 && marker <= 0xcf)
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return false;
    } else if (marker !== 0xc4 && marker !== 0xdb && marker !== 0xdd) {
      // Keep the direct lane deliberately narrow and browser-portable.
      return false;
    }
    offset += segmentLength;
  }
  return false;
}

function minimalJfifSegment(
  bytes: Uint8Array,
  lengthOffset: number,
  segmentLength: number,
): boolean {
  return segmentLength === 16
    && bytes[lengthOffset + 2] === 0x4a
    && bytes[lengthOffset + 3] === 0x46
    && bytes[lengthOffset + 4] === 0x49
    && bytes[lengthOffset + 5] === 0x46
    && bytes[lengthOffset + 6] === 0x00
    && bytes[lengthOffset + 14] === 0
    && bytes[lengthOffset + 15] === 0;
}

export function stripScanJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new ScanReadabilityError("scan_readability_output_invalid");
  }
  const chunks: Uint8Array[] = [bytes.slice(0, 2)];
  let totalBytes = 2;
  let offset = 2;
  let scanFound = false;
  while (offset < bytes.length) {
    const markerStart = offset;
    if (bytes[offset] !== 0xff) {
      throw new ScanReadabilityError("scan_readability_output_invalid");
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) {
      throw new ScanReadabilityError("scan_readability_output_invalid");
    }
    const marker = bytes[offset]!;
    offset += 1;
    if (
      marker === 0xd9
      || marker === 0xd8
      || marker === 0x01
      || (marker >= 0xd0 && marker <= 0xd7)
      || offset + 2 > bytes.length
    ) {
      throw new ScanReadabilityError("scan_readability_output_invalid");
    }
    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    const segmentEnd = offset + segmentLength;
    if (segmentLength < 2 || segmentEnd > bytes.length) {
      throw new ScanReadabilityError("scan_readability_output_invalid");
    }
    const discard = marker === 0xfe
      || (marker >= 0xe1 && marker <= 0xef)
      || (marker === 0xe0 && !minimalJfifSegment(bytes, offset, segmentLength));
    if (!discard) {
      const chunk = bytes.slice(markerStart, segmentEnd);
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
    }
    offset = segmentEnd;
    if (marker === 0xda) {
      const entropy = bytes.slice(offset);
      chunks.push(entropy);
      totalBytes += entropy.byteLength;
      scanFound = true;
      break;
    }
  }
  if (!scanFound) throw new ScanReadabilityError("scan_readability_output_invalid");
  const output = new Uint8Array(totalBytes);
  let outputOffset = 0;
  for (const chunk of chunks) {
    output.set(chunk, outputOffset);
    outputOffset += chunk.byteLength;
  }
  return output;
}

async function boundedImageOperation<T>(
  operation: Promise<T>,
  error: ScanReadabilityError,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(error), SCAN_IMAGE_OPERATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function inspectSource(
  images: Pick<ImagesBinding, "info" | "input">,
  sourceBytes: Uint8Array,
  sourceMimeType?: "image/jpeg" | "image/png" | "image/webp",
): Promise<{ width: number; height: number; format: string }> {
  if (sourceBytes.byteLength > MAX_SCAN_IMAGE_BINDING_BYTES) {
    throw new ScanReadabilityError("scan_image_too_large");
  }

  let sourceInfo: ImageInfoResponse;
  try {
    sourceInfo = await boundedImageOperation(
      images.info(byteStream(sourceBytes)),
      new ScanReadabilityError("scan_image_decode_failed"),
    );
  } catch (error) {
    if (error instanceof ScanReadabilityError) throw error;
    throw new ScanReadabilityError("scan_image_decode_failed");
  }
  const sourceDimensions = dimensions(sourceInfo);
  if (sourceDimensions === null
    || sourceDimensions.width * sourceDimensions.height > SCAN_IMAGE_MAX_PIXELS) {
    throw new ScanReadabilityError("scan_image_dimensions_invalid");
  }
  if (!("format" in sourceInfo)
    || (sourceMimeType !== undefined && sourceInfo.format !== sourceMimeType)
    || ("fileSize" in sourceInfo && sourceInfo.fileSize !== sourceBytes.byteLength)) {
    throw new ScanReadabilityError("scan_image_decode_failed");
  }
  return { ...sourceDimensions, format: sourceInfo.format };
}

async function createDerivativeCandidate(
  images: Pick<ImagesBinding, "info" | "input">,
  sourceBytes: Uint8Array,
): Promise<ScanReadabilityDerivative> {
  let outputBytes: Uint8Array;
  try {
    const output = await boundedImageOperation(
      images
        .input(byteStream(sourceBytes))
        .transform({
          width: SCAN_READABILITY_MAX_DIMENSION,
          height: SCAN_READABILITY_MAX_DIMENSION,
          fit: "scale-down",
        })
        .output({
          format: "image/jpeg",
          quality: 85,
          background: "#ffffff",
          anim: false,
        }),
      new ScanReadabilityError("scan_readability_generation_failed"),
    );
    const outputBuffer = await boundedImageOperation(
      new Response(output.image()).arrayBuffer(),
      new ScanReadabilityError("scan_readability_generation_failed"),
    );
    outputBytes = stripScanJpegMetadata(new Uint8Array(outputBuffer));
  } catch (error) {
    if (error instanceof ScanReadabilityError) throw error;
    throw new ScanReadabilityError("scan_readability_generation_failed");
  }

  if (outputBytes.byteLength === 0 || outputBytes.byteLength > MAX_SCAN_READABILITY_BYTES) {
    throw new ScanReadabilityError("scan_readability_output_invalid");
  }

  let outputDimensions: { width: number; height: number } | null;
  try {
    const info = await boundedImageOperation(
      images.info(byteStream(outputBytes)),
      new ScanReadabilityError("scan_readability_output_invalid"),
    );
    outputDimensions = dimensions(info);
    if (!("format" in info) || info.format !== "image/jpeg") {
      throw new ScanReadabilityError("scan_readability_output_invalid");
    }
  } catch (error) {
    if (error instanceof ScanReadabilityError) throw error;
    throw new ScanReadabilityError("scan_readability_output_invalid");
  }
  if (outputDimensions === null
    || outputDimensions.width > SCAN_READABILITY_MAX_DIMENSION
    || outputDimensions.height > SCAN_READABILITY_MAX_DIMENSION
    || !scanJpegIsDirectlyUsable(outputBytes, outputDimensions)) {
    throw new ScanReadabilityError("scan_readability_output_invalid");
  }

  return {
    bytes: outputBytes,
    mimeType: "image/jpeg",
    sha256: await sha256Hex(outputBytes),
    width: outputDimensions.width,
    height: outputDimensions.height,
    policyId: SCAN_READABILITY_POLICY_ID,
  };
}

export async function createScanReadabilityDerivative(
  images: Pick<ImagesBinding, "info" | "input">,
  sourceBytes: Uint8Array,
): Promise<ScanReadabilityDerivative> {
  await inspectSource(images, sourceBytes);
  return createDerivativeCandidate(images, sourceBytes);
}

export function scanCandidateHasMaterialSavings(
  sourceBytes: number,
  candidateBytes: number,
): boolean {
  const savings = sourceBytes - candidateBytes;
  return savings >= SCAN_OPTIONAL_MIN_SAVINGS_BYTES
    && savings * 100 >= sourceBytes * SCAN_OPTIONAL_MIN_SAVINGS_PERCENT;
}

export async function selectScanReadabilityRepresentation(
  images: Pick<ImagesBinding, "info" | "input">,
  sourceBytes: Uint8Array,
  sourceMimeType: "image/jpeg" | "image/png" | "image/webp",
): Promise<ScanReadabilitySelection> {
  const source = await inspectSource(images, sourceBytes, sourceMimeType);
  const bounded = source.width <= SCAN_READABILITY_MAX_DIMENSION
    && source.height <= SCAN_READABILITY_MAX_DIMENSION;
  const directlyUsable = sourceMimeType === "image/jpeg"
    && bounded
    && scanJpegIsDirectlyUsable(sourceBytes, source);
  const base = {
    policyId: SCAN_READABILITY_SELECTION_POLICY_ID,
    sourceWidth: source.width,
    sourceHeight: source.height,
  } as const;

  if (directlyUsable
    && sourceBytes.byteLength < SCAN_OPTIONAL_CANDIDATE_MIN_SOURCE_BYTES) {
    return {
      ...base,
      representationKind: "source",
      selectionBasis: "direct_safe_source",
      candidateByteSize: null,
      derivative: null,
    };
  }

  if (directlyUsable) {
    let candidate: ScanReadabilityDerivative;
    try {
      candidate = await createDerivativeCandidate(images, sourceBytes);
    } catch {
      // Optional optimization cannot make an already safe source unreadable.
      return {
        ...base,
        representationKind: "source",
        selectionBasis: "direct_safe_source",
        candidateByteSize: null,
        derivative: null,
      };
    }
    if (!scanCandidateHasMaterialSavings(sourceBytes.byteLength, candidate.bytes.byteLength)) {
      return {
        ...base,
        representationKind: "source",
        selectionBasis: "direct_safe_source",
        candidateByteSize: candidate.bytes.byteLength,
        derivative: null,
      };
    }
    return {
      ...base,
      representationKind: "derivative",
      selectionBasis: "optional_material_savings",
      candidateByteSize: candidate.bytes.byteLength,
      derivative: candidate,
    };
  }

  const derivative = await createDerivativeCandidate(images, sourceBytes);
  return {
    ...base,
    representationKind: "derivative",
    selectionBasis: "required_normalization",
    candidateByteSize: derivative.bytes.byteLength,
    derivative,
  };
}

export function scanReadabilityObjectKey(sourceMediaId: string): string {
  return `scans/readability-v2/${sourceMediaId}.jpg`;
}
