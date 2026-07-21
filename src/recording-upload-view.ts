import type { RecordingUploadProgress, RecordingUploadStatus } from "./recording-upload";

export const RECORDING_FILE_ACCEPT = [
  "audio/*",
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".flac",
  ".ogg",
  ".opus",
  ".wma",
  ".aif",
  ".aiff",
  ".amr",
  ".3gp",
  ".webm",
].join(",");

export function formatRecordingBytes(byteSize: number): string {
  if (byteSize < 1024 * 1024) return `${Math.max(1, Math.ceil(byteSize / 1024))} KB`;
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

export function recordingUploadPercent(progress: RecordingUploadProgress): number {
  if (progress.totalBytes <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(
    (progress.completedBytes / progress.totalBytes) * 100,
  )));
}

export function recordingUploadProgressLabel(progress: RecordingUploadProgress): string {
  switch (progress.phase) {
    case "fingerprinting": return `Verifying the selected file… ${recordingUploadPercent(progress)}%`;
    case "creating": return "Starting private upload…";
    case "uploading": return `Uploading audio… ${recordingUploadPercent(progress)}%`;
    case "completing": return "Verifying the stored original…";
    case "finalizing": return "Creating the Recording and processing job…";
  }
}

export function canAbortRecordingUpload(status: RecordingUploadStatus): boolean {
  return status === "creating" || status === "open";
}
