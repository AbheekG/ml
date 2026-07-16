// Cloudflare's private Images binding accepts at most 20 MB of source bytes.
export const MAX_SCAN_UPLOAD_BYTES = 20_000_000;

export type ScanImageType = {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  extension: "jpg" | "png" | "webp";
};

export function inspectScanImage(bytes: Uint8Array): ScanImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" };
  }
  return null;
}

export function safeUploadFilename(value: string, extension: ScanImageType["extension"]): string {
  const basename = value.replaceAll("\0", "").split(/[\\/]/u).at(-1)?.trim() ?? "";
  const fallback = `scan.${extension}`;
  if (!basename) return fallback;
  if (basename.length <= 255) return basename;
  return `${basename.slice(0, 250 - extension.length)}.${extension}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
