import { sha256Hex } from "./media-upload";

export const SCAN_READABILITY_POLICY_ID = "scan-jpeg-v1-2400-q85";
export const SCAN_READABILITY_MAX_DIMENSION = 2400;
export const SCAN_IMAGE_MAX_PIXELS = 100_000_000;
export const MAX_SCAN_IMAGE_BINDING_BYTES = 20_000_000;
export const MAX_SCAN_READABILITY_BYTES = 20 * 1024 * 1024;
const SCAN_IMAGE_OPERATION_TIMEOUT_MS = 15_000;

export type ScanReadabilityDerivative = {
  bytes: Uint8Array;
  mimeType: "image/jpeg";
  sha256: string;
  width: number;
  height: number;
  policyId: typeof SCAN_READABILITY_POLICY_ID;
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

export async function createScanReadabilityDerivative(
  images: Pick<ImagesBinding, "info" | "input">,
  sourceBytes: Uint8Array,
): Promise<ScanReadabilityDerivative> {
  if (sourceBytes.byteLength > MAX_SCAN_IMAGE_BINDING_BYTES) {
    throw new ScanReadabilityError("scan_image_too_large");
  }

  let sourceDimensions: { width: number; height: number } | null;
  try {
    sourceDimensions = dimensions(await boundedImageOperation(
      images.info(byteStream(sourceBytes)),
      new ScanReadabilityError("scan_image_decode_failed"),
    ));
  } catch (error) {
    if (error instanceof ScanReadabilityError) throw error;
    throw new ScanReadabilityError("scan_image_decode_failed");
  }
  if (sourceDimensions === null
    || sourceDimensions.width * sourceDimensions.height > SCAN_IMAGE_MAX_PIXELS) {
    throw new ScanReadabilityError("scan_image_dimensions_invalid");
  }

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
    outputBytes = new Uint8Array(outputBuffer);
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
    || outputDimensions.height > SCAN_READABILITY_MAX_DIMENSION) {
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

export function scanReadabilityObjectKey(sourceMediaId: string): string {
  return `scans/readability/${sourceMediaId}.jpg`;
}
