import type { SongScan } from "./catalog";

const MAX_EXPORT_FILENAME_BYTES = 240;
const INVALID_FILENAME_CHARACTERS = /[\u0000-\u001f\u007f<>:"/\\|?*]+/gu;
const TRAILING_FILENAME_PUNCTUATION = /(?:[.\s]+|[—-]\s*)+$/gu;

function cleanFilenamePart(value: string, fallback: string): string {
  const cleaned = value
    .normalize("NFC")
    .replace(INVALID_FILENAME_CHARACTERS, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(TRAILING_FILENAME_PUNCTUATION, "");
  return cleaned || fallback;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximumBytes) return value;

  let result = "";
  let byteLength = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (byteLength + characterBytes > maximumBytes) break;
    result += character;
    byteLength += characterBytes;
  }
  return result.trim().replace(TRAILING_FILENAME_PUNCTUATION, "");
}

function exportFilename(parts: string[], extension: ".jpg" | ".mp3"): string {
  const maximumStemBytes = MAX_EXPORT_FILENAME_BYTES - extension.length;
  const stem = truncateUtf8(parts.join(" — "), maximumStemBytes) || "Music Library Export";
  return `${stem}${extension}`;
}

export function recordingExportFilename(songTitle: string, description: string): string {
  return exportFilename([
    cleanFilenamePart(songTitle, "Untitled Song"),
    cleanFilenamePart(description, "Recording"),
  ], ".mp3");
}

function pageFilenamePart(pageLabel: string): string {
  const cleaned = cleanFilenamePart(pageLabel, "Page");
  return /^page\b/iu.test(cleaned) ? cleaned : `Page ${cleaned}`;
}

export function scanExportFilename(
  songTitle: string,
  scan: Pick<SongScan, "notebookName" | "pageLabel">,
  index: number,
  total: number,
): string {
  const details: string[] = [];
  if (scan.notebookName) details.push(cleanFilenamePart(scan.notebookName, "Notebook"));
  if (scan.pageLabel) details.push(pageFilenamePart(scan.pageLabel));
  if (total > 1 && index >= 0 && index < total) {
    details.push(`${index + 1} of ${total}`);
  }

  return exportFilename([
    cleanFilenamePart(songTitle, "Untitled Song"),
    "Scanned Lyrics",
    ...details,
  ], ".jpg");
}
