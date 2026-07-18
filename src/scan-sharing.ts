import {
  isShareAbort,
  NativeFileSharingError,
  sharePreparedFile,
  supportsFileSharing,
  type FileShareNavigator,
} from "./native-file-sharing";

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
