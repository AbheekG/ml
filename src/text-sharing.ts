export class TextSharingError extends Error {
  constructor(readonly code: "copy_unavailable" | "copy_failed" | "share_unavailable" | "share_failed") {
    super(code);
  }
}

type ClipboardWriter = {
  writeText(text: string): Promise<void>;
};

type TextShareNavigator = {
  share?: (data: ShareData) => Promise<void>;
};

export async function copyTextBlock(
  text: string,
  clipboard: ClipboardWriter | null | undefined = navigator.clipboard,
): Promise<void> {
  if (!clipboard || typeof clipboard.writeText !== "function") {
    throw new TextSharingError("copy_unavailable");
  }
  try {
    await clipboard.writeText(text);
  } catch {
    throw new TextSharingError("copy_failed");
  }
}

export function supportsSystemTextShare(
  shareNavigator: TextShareNavigator = navigator,
): boolean {
  return typeof shareNavigator.share === "function";
}

export async function shareTextBlock(
  text: string,
  shareNavigator: TextShareNavigator = navigator,
): Promise<"shared" | "cancelled"> {
  if (typeof shareNavigator.share !== "function") {
    throw new TextSharingError("share_unavailable");
  }
  try {
    await shareNavigator.share({ text });
    return "shared";
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    throw new TextSharingError("share_failed");
  }
}
