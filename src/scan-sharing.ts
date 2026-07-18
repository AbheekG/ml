import {
  isShareAbort,
  NativeFileSharingError,
  sharePreparedFile,
  supportsFileSharing,
  type FileShareNavigator,
} from "./native-file-sharing";
import type { ScanRotationQuarterTurns } from "./catalog";

export { isShareAbort };

export const MAX_OPTIMIZED_SCAN_SHARE_BYTES = 20_971_520;

export type ScanSharingErrorCode =
  | "load_failed"
  | "optimized_unavailable"
  | "invalid_file"
  | "file_too_large"
  | "share_unavailable"
  | "share_failed";

export class ScanSharingError extends Error {
  constructor(readonly code: ScanSharingErrorCode) {
    super(code);
  }
}

type ScanShareFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

type ScanShareImage = CanvasImageSource & {
  naturalHeight: number;
  naturalWidth: number;
};

type ScanShareCanvasFactory = () => HTMLCanvasElement;

type ScanShareImageLoader = (file: File) => Promise<{
  image: ScanShareImage;
  release: () => void;
}>;

export function supportsOptimizedScanSharing(
  shareNavigator: FileShareNavigator = navigator,
): boolean {
  return supportsFileSharing("scan.jpg", "image/jpeg", shareNavigator);
}

function discardResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

export async function loadOptimizedScanShareFile(
  scanId: string,
  signal?: AbortSignal,
  fetcher: ScanShareFetcher = fetch,
): Promise<File> {
  let response: Response;
  try {
    response = await fetcher(`/api/scans/${encodeURIComponent(scanId)}/image`, {
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
  } catch (error) {
    if (isShareAbort(error)) throw error;
    throw new ScanSharingError("load_failed");
  }

  if (!response.ok) {
    discardResponseBody(response);
    throw new ScanSharingError("load_failed");
  }
  if (response.headers.get("X-Scan-Representation") !== "readability") {
    discardResponseBody(response);
    throw new ScanSharingError("optimized_unavailable");
  }

  const contentType = response.headers.get("Content-Type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "image/jpeg") {
    discardResponseBody(response);
    throw new ScanSharingError("invalid_file");
  }

  const contentLengthHeader = response.headers.get("Content-Length") ?? "";
  if (!/^\d+$/u.test(contentLengthHeader)) {
    discardResponseBody(response);
    throw new ScanSharingError("invalid_file");
  }
  const contentLength = Number(contentLengthHeader);
  if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
    discardResponseBody(response);
    throw new ScanSharingError("invalid_file");
  }
  if (contentLength > MAX_OPTIMIZED_SCAN_SHARE_BYTES) {
    discardResponseBody(response);
    throw new ScanSharingError("file_too_large");
  }

  let blob: Blob;
  try {
    blob = await response.blob();
  } catch (error) {
    if (isShareAbort(error)) throw error;
    throw new ScanSharingError("load_failed");
  }
  if (blob.size !== contentLength || blob.size > MAX_OPTIMIZED_SCAN_SHARE_BYTES) {
    throw new ScanSharingError("invalid_file");
  }

  return new File([blob], "scan.jpg", {
    type: "image/jpeg",
    lastModified: 0,
  });
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new ScanSharingError("share_failed"));
    }, "image/jpeg", 0.92);
  });
}

export async function prepareVisibleScanShareFile(
  sourceFile: File | null,
  image: ScanShareImage,
  rotationQuarterTurns: ScanRotationQuarterTurns,
  canvasFactory: ScanShareCanvasFactory = () => document.createElement("canvas"),
): Promise<File> {
  if (rotationQuarterTurns === 0 && sourceFile) return sourceFile;
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  if (!Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight)
    || sourceWidth < 1 || sourceHeight < 1) {
    throw new ScanSharingError("invalid_file");
  }

  const canvas = canvasFactory();
  canvas.width = rotationQuarterTurns % 2 === 0 ? sourceWidth : sourceHeight;
  canvas.height = rotationQuarterTurns % 2 === 0 ? sourceHeight : sourceWidth;
  const context = canvas.getContext("2d");
  if (!context) throw new ScanSharingError("share_failed");

  switch (rotationQuarterTurns) {
    case 1:
      context.translate(canvas.width, 0);
      context.rotate(Math.PI / 2);
      break;
    case 2:
      context.translate(canvas.width, canvas.height);
      context.rotate(Math.PI);
      break;
    case 3:
      context.translate(0, canvas.height);
      context.rotate(-Math.PI / 2);
      break;
  }
  context.drawImage(image, 0, 0);

  const blob = await canvasBlob(canvas);
  if (blob.size < 1 || blob.size > MAX_OPTIMIZED_SCAN_SHARE_BYTES) {
    throw new ScanSharingError(blob.size > MAX_OPTIMIZED_SCAN_SHARE_BYTES
      ? "file_too_large"
      : "invalid_file");
  }
  return new File([blob], "scan.jpg", {
    type: "image/jpeg",
    lastModified: 0,
  });
}

async function loadShareImage(file: File): ReturnType<ScanShareImageLoader> {
  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new ScanSharingError("invalid_file"));
      image.src = objectUrl;
    });
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
  return {
    image,
    release: () => URL.revokeObjectURL(objectUrl),
  };
}

export async function rotateOptimizedScanShareFile(
  file: File,
  rotationQuarterTurns: ScanRotationQuarterTurns,
  imageLoader: ScanShareImageLoader = loadShareImage,
  canvasFactory?: ScanShareCanvasFactory,
): Promise<File> {
  if (rotationQuarterTurns === 0) return file;
  const loaded = await imageLoader(file);
  try {
    return await prepareVisibleScanShareFile(
      file,
      loaded.image,
      rotationQuarterTurns,
      canvasFactory,
    );
  } finally {
    loaded.release();
  }
}

export async function shareOptimizedScanFile(
  file: File,
  shareNavigator: FileShareNavigator = navigator,
): Promise<"shared" | "cancelled" | "retry_required"> {
  try {
    return await sharePreparedFile(file, shareNavigator);
  } catch (error) {
    throw new ScanSharingError(
      error instanceof NativeFileSharingError ? error.code : "share_failed",
    );
  }
}
