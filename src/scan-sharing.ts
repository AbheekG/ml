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

type FileShareNavigator = {
  canShare?: (data?: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
};

export function isShareAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function supportsOptimizedScanSharing(
  shareNavigator: FileShareNavigator = navigator,
): boolean {
  if (
    typeof shareNavigator.canShare !== "function"
    || typeof shareNavigator.share !== "function"
    || typeof File !== "function"
  ) return false;
  try {
    return shareNavigator.canShare({
      files: [new File([new Uint8Array([0])], "scan.jpg", { type: "image/jpeg" })],
    });
  } catch {
    return false;
  }
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

export async function shareOptimizedScanFile(
  file: File,
  shareNavigator: FileShareNavigator = navigator,
): Promise<"shared" | "cancelled" | "retry_required"> {
  if (
    typeof shareNavigator.canShare !== "function"
    || typeof shareNavigator.share !== "function"
  ) {
    throw new ScanSharingError("share_unavailable");
  }

  const data: ShareData = { files: [file] };
  try {
    if (shareNavigator.canShare?.(data) !== true) {
      throw new ScanSharingError("share_unavailable");
    }
  } catch (error) {
    if (error instanceof ScanSharingError) throw error;
    throw new ScanSharingError("share_unavailable");
  }

  try {
    await shareNavigator.share?.(data);
    return "shared";
  } catch (error) {
    if (isShareAbort(error)) return "cancelled";
    if (error instanceof Error && error.name === "NotAllowedError") {
      return "retry_required";
    }
    throw new ScanSharingError("share_failed");
  }
}
