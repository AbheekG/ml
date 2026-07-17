import {
  isShareAbort,
  NativeFileSharingError,
  sharePreparedFile,
  supportsFileSharing,
  type FileShareNavigator,
} from "./native-file-sharing";

export const MAX_RECORDING_SHARE_BYTES = 52_428_800;

export function isRecordingShareTooLarge(byteSize: number | null | undefined): boolean {
  return typeof byteSize === "number" && byteSize > MAX_RECORDING_SHARE_BYTES;
}

export type RecordingSharingErrorCode =
  | "load_failed"
  | "invalid_file"
  | "file_too_large"
  | "share_unavailable"
  | "share_failed";

export class RecordingSharingError extends Error {
  constructor(readonly code: RecordingSharingErrorCode) {
    super(code);
  }
}

type RecordingShareFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export function supportsRecordingSharing(
  shareNavigator: FileShareNavigator = navigator,
): boolean {
  return supportsFileSharing("recording.mp3", "audio/mpeg", shareNavigator);
}

function discardResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

export async function loadRecordingShareFile(
  recordingId: string,
  signal?: AbortSignal,
  fetcher: RecordingShareFetcher = fetch,
): Promise<File> {
  let response: Response;
  try {
    response = await fetcher(`/api/recordings/${encodeURIComponent(recordingId)}/playback`, {
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
  } catch (error) {
    if (isShareAbort(error)) throw error;
    throw new RecordingSharingError("load_failed");
  }

  if (!response.ok) {
    discardResponseBody(response);
    throw new RecordingSharingError(response.status === 413 ? "file_too_large" : "load_failed");
  }
  if (response.headers.get("X-Recording-Representation") !== "playback") {
    discardResponseBody(response);
    throw new RecordingSharingError("invalid_file");
  }
  const contentType = response.headers.get("Content-Type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "audio/mpeg") {
    discardResponseBody(response);
    throw new RecordingSharingError("invalid_file");
  }

  const contentLengthHeader = response.headers.get("Content-Length") ?? "";
  if (!/^\d+$/u.test(contentLengthHeader)) {
    discardResponseBody(response);
    throw new RecordingSharingError("invalid_file");
  }
  const contentLength = Number(contentLengthHeader);
  if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
    discardResponseBody(response);
    throw new RecordingSharingError("invalid_file");
  }
  if (contentLength > MAX_RECORDING_SHARE_BYTES) {
    discardResponseBody(response);
    throw new RecordingSharingError("file_too_large");
  }

  let blob: Blob;
  try {
    blob = await response.blob();
  } catch (error) {
    if (isShareAbort(error)) throw error;
    throw new RecordingSharingError("load_failed");
  }
  if (blob.size !== contentLength || blob.size > MAX_RECORDING_SHARE_BYTES) {
    throw new RecordingSharingError("invalid_file");
  }

  return new File([blob], "recording.mp3", {
    type: "audio/mpeg",
    lastModified: 0,
  });
}

export async function shareRecordingFile(
  file: File,
  shareNavigator: FileShareNavigator = navigator,
): Promise<"shared" | "cancelled" | "retry_required"> {
  try {
    return await sharePreparedFile(file, shareNavigator);
  } catch (error) {
    throw new RecordingSharingError(
      error instanceof NativeFileSharingError ? error.code : "share_failed",
    );
  }
}
