export type FileShareNavigator = {
  canShare?: (data?: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
};

export class NativeFileSharingError extends Error {
  constructor(readonly code: "share_unavailable" | "share_failed") {
    super(code);
  }
}

export function isShareAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function supportsFileSharing(
  filename: string,
  mimeType: string,
  shareNavigator: FileShareNavigator = navigator,
): boolean {
  if (
    typeof shareNavigator.canShare !== "function"
    || typeof shareNavigator.share !== "function"
    || typeof File !== "function"
  ) return false;
  try {
    return shareNavigator.canShare({
      files: [new File([new Uint8Array([0])], filename, { type: mimeType })],
    });
  } catch {
    return false;
  }
}

export async function sharePreparedFile(
  file: File,
  shareNavigator: FileShareNavigator = navigator,
): Promise<"shared" | "cancelled" | "retry_required"> {
  if (
    typeof shareNavigator.canShare !== "function"
    || typeof shareNavigator.share !== "function"
  ) throw new NativeFileSharingError("share_unavailable");

  const data: ShareData = { files: [file] };
  try {
    if (shareNavigator.canShare(data) !== true) throw new NativeFileSharingError("share_unavailable");
  } catch (error) {
    if (error instanceof NativeFileSharingError) throw error;
    throw new NativeFileSharingError("share_unavailable");
  }

  try {
    await shareNavigator.share(data);
    return "shared";
  } catch (error) {
    if (isShareAbort(error)) return "cancelled";
    if (error instanceof Error && error.name === "NotAllowedError") return "retry_required";
    throw new NativeFileSharingError("share_failed");
  }
}
