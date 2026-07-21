export const RECORDING_UPLOAD_PART_BYTES = 8 * 1024 * 1024;
export const MAX_RECORDING_UPLOAD_BYTES = 512 * 1024 * 1024;

export type RecordingUploadStatus =
  | "creating"
  | "open"
  | "completing"
  | "stored"
  | "duplicate"
  | "finalized"
  | "aborted"
  | "failed";

export type DuplicateRecording = {
  id: string | null;
  songId: string | null;
  trashed: boolean | null;
  revision: number | null;
  isHistorical: boolean;
};

export type RecordingUploadIntent =
  | { kind: "create"; targetRecordingId: null; targetRecordingRevision: null }
  | { kind: "replace"; targetRecordingId: string; targetRecordingRevision: number };

export type RecordingUploadSession = {
  id: string;
  songId: string;
  filename: string;
  byteSize: number;
  partSize: number;
  partCount: number;
  completedParts: number[];
  status: RecordingUploadStatus;
  revision: number;
  expiresAt: string;
  recordingId: string | null;
  fileIdentityBound: boolean;
  intent: RecordingUploadIntent | null;
  duplicateRecording?: DuplicateRecording;
};

export type FinalizedRecording = {
  id: string;
  revision: number;
  processingState: "processing" | "ready" | "failed";
};

export type RecordingUploadResult =
  | {
    kind: "finalized";
    upload: RecordingUploadSession;
    recording: FinalizedRecording;
  }
  | {
    kind: "duplicate";
    upload: RecordingUploadSession;
    duplicateRecording: DuplicateRecording;
  };

export type RecordingUploadProgress = {
  phase: "fingerprinting" | "creating" | "uploading" | "completing" | "finalizing";
  completedParts: number;
  totalParts: number;
  completedBytes: number;
  totalBytes: number;
  upload: RecordingUploadSession | null;
};

export type RecordingUploadInput = {
  songId: string;
  file: File;
  clientMutationId: string;
  description: string | null;
  recordedOn: string | null;
  creditPersonIds: string[];
};

export type RecordingUploadOptions = {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  resumeUpload?: RecordingUploadSession;
  descriptionOverride?: string;
  onProgress?: (progress: RecordingUploadProgress) => void;
  replaceTarget?: { recordingId: string; revision: number };
};

type ErrorPayload = {
  error?: unknown;
  fields?: unknown;
  existingRecording?: unknown;
};

export class RecordingUploadError extends Error {
  upload?: RecordingUploadSession;

  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly fields?: Record<string, string[]>,
    readonly existingRecording?: { id: string; songId: string },
  ) {
    super(message);
    this.name = "RecordingUploadError";
  }
}

const STATUS_VALUES = new Set<RecordingUploadStatus>([
  "creating",
  "open",
  "completing",
  "stored",
  "duplicate",
  "finalized",
  "aborted",
  "failed",
]);

const ERROR_MESSAGES: Record<string, string> = {
  invalid_recording_upload: "Check the Recording details and selected file.",
  invalid_recording_reference: "A selected vocalist is no longer available. Reload and try again.",
  recording_upload_mutation_reused: "This upload retry no longer matches its original details. Start again.",
  recording_upload_storage_unavailable: "Private audio storage is temporarily unavailable. Retry when the connection is stable.",
  recording_upload_part_storage_failed: "This audio part could not be stored. Retry when the connection is stable.",
  recording_upload_part_hash_mismatch: "The uploaded part did not match the selected file. Reselect the original file and retry.",
  recording_upload_file_mismatch: "This is not the same file that started the resumable upload. Reselect the exact original file.",
  recording_upload_file_identity_unavailable: "This older incomplete upload cannot be resumed safely. Cancel it and start a new upload.",
  recording_upload_checkpoint_failed: "The uploaded part could not be safely checkpointed. Retry it.",
  recording_upload_storage_completion_failed: "The private upload could not be completed. Retry it.",
  recording_upload_fingerprint_failed: "The stored audio could not be verified. Retry completion.",
  recording_upload_conflict: "The upload changed while this request was running. Its current status has been reloaded.",
  recording_upload_expired: "This upload expired. Start a new upload with the original file.",
  recording_upload_not_found: "This upload is no longer available.",
  recording_upload_stored_object_mismatch: "The stored audio did not match the selected file size and needs administrator review.",
  recording_upload_intent_mismatch: "This older upload cannot be finalized automatically. Dismiss it or ask an administrator to review it.",
  recording_upload_history_unavailable: "The retained historical audio is no longer available for safe reuse.",
  recording_upload_cannot_discard: "This upload is not in a completed state that can be dismissed.",
  recording_upload_discard_failed: "The upload could not be dismissed safely.",
  recording_processing_active: "Wait for the current audio processing to finish before replacing this Recording.",
  duplicate_recording_description: "This Song already has a Recording with that description. Enter a different description to finish.",
  recording_upload_network_error: "The connection was interrupted. The server-held upload state is safe to retry.",
  recording_upload_invalid_response: "The server returned an invalid upload response. Stop and retry after review.",
  recording_upload_terminal: "This upload can no longer continue.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArrayFields(value: unknown): Record<string, string[]> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string[]> = {};
  for (const [field, messages] of Object.entries(value)) {
    if (!Array.isArray(messages) || !messages.every((message) => typeof message === "string")) {
      return undefined;
    }
    result[field] = messages;
  }
  return result;
}

function existingRecording(value: unknown): { id: string; songId: string } | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.songId !== "string") {
    return undefined;
  }
  return { id: value.id, songId: value.songId };
}

function errorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? "The Recording upload could not continue.";
}

async function requestJson(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      cache: "no-store",
      headers: { Accept: "application/json", ...init.headers },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new RecordingUploadError(
      ERROR_MESSAGES.recording_upload_network_error,
      0,
      "recording_upload_network_error",
    );
  }

  const payload = await response.json().catch(() => null) as ErrorPayload | null;
  if (!response.ok) {
    const code = typeof payload?.error === "string" ? payload.error : "request_failed";
    throw new RecordingUploadError(
      errorMessage(code),
      response.status,
      code,
      stringArrayFields(payload?.fields),
      existingRecording(payload?.existingRecording),
    );
  }
  return payload;
}

function parseDuplicateRecording(value: unknown): DuplicateRecording | undefined {
  if (!isRecord(value)) return undefined;
  const id = value.id;
  const songId = value.songId;
  const trashed = value.trashed;
  const revision = value.revision ?? null;
  const isHistorical = value.isHistorical;
  if (
    !(typeof id === "string" || id === null)
    || !(typeof songId === "string" || songId === null)
    || !(typeof trashed === "boolean" || trashed === null)
    || !(revision === null || (Number.isSafeInteger(revision) && Number(revision) > 0))
    || typeof isHistorical !== "boolean"
  ) return undefined;
  return { id, songId, trashed, revision: revision as number | null, isHistorical };
}

function parseRecordingUploadIntent(value: unknown): RecordingUploadIntent | null | undefined {
  if (value === null || value === undefined) return value ?? null;
  if (!isRecord(value)) return undefined;
  if (
    value.kind === "create"
    && value.targetRecordingId === null
    && value.targetRecordingRevision === null
  ) {
    return { kind: "create", targetRecordingId: null, targetRecordingRevision: null };
  }
  if (
    value.kind === "replace"
    && typeof value.targetRecordingId === "string"
    && Number.isSafeInteger(value.targetRecordingRevision)
  ) {
    return {
      kind: "replace",
      targetRecordingId: value.targetRecordingId,
      targetRecordingRevision: value.targetRecordingRevision as number,
    };
  }
  return undefined;
}

function parseUpload(value: unknown): RecordingUploadSession {
  if (!isRecord(value)) throw invalidResponse();
  const status = value.status;
  const completedParts = value.completedParts;
  const recordingId = value.recordingId;
  const intent = parseRecordingUploadIntent(value.intent);
  if (
    typeof value.id !== "string"
    || typeof value.songId !== "string"
    || typeof value.filename !== "string"
    || !Number.isSafeInteger(value.byteSize)
    || !Number.isSafeInteger(value.partSize)
    || !Number.isSafeInteger(value.partCount)
    || !Array.isArray(completedParts)
    || !completedParts.every((part) => Number.isSafeInteger(part))
    || typeof status !== "string"
    || !STATUS_VALUES.has(status as RecordingUploadStatus)
    || !Number.isSafeInteger(value.revision)
    || typeof value.expiresAt !== "string"
    || !(typeof recordingId === "string" || recordingId === null)
    || typeof value.fileIdentityBound !== "boolean"
    || intent === undefined
  ) throw invalidResponse();

  const duplicate = value.duplicateRecording === undefined
    ? undefined
    : parseDuplicateRecording(value.duplicateRecording);
  if (status === "duplicate" && !duplicate) throw invalidResponse();
  return {
    id: value.id,
    songId: value.songId,
    filename: value.filename,
    byteSize: value.byteSize as number,
    partSize: value.partSize as number,
    partCount: value.partCount as number,
    completedParts: [...completedParts] as number[],
    status: status as RecordingUploadStatus,
    revision: value.revision as number,
    expiresAt: value.expiresAt,
    recordingId,
    fileIdentityBound: value.fileIdentityBound,
    intent,
    ...(duplicate ? { duplicateRecording: duplicate } : {}),
  };
}

function parseUploadPayload(payload: unknown): RecordingUploadSession {
  if (!isRecord(payload)) throw invalidResponse();
  return parseUpload(payload.upload);
}

function parseFinalizedPayload(payload: unknown): RecordingUploadResult {
  if (!isRecord(payload)) throw invalidResponse();
  const upload = parseUpload(payload.upload);
  if (upload.status === "duplicate" && upload.duplicateRecording) {
    return { kind: "duplicate", upload, duplicateRecording: upload.duplicateRecording };
  }
  const recording = payload.recording;
  if (
    upload.status !== "finalized"
    || !isRecord(recording)
    || typeof recording.id !== "string"
    || !Number.isSafeInteger(recording.revision)
    || !["processing", "ready", "failed"].includes(String(recording.processingState))
  ) throw invalidResponse();
  return {
    kind: "finalized",
    upload,
    recording: {
      id: recording.id,
      revision: recording.revision as number,
      processingState: recording.processingState as FinalizedRecording["processingState"],
    },
  };
}

function invalidResponse(): RecordingUploadError {
  return new RecordingUploadError(
    ERROR_MESSAGES.recording_upload_invalid_response,
    0,
    "recording_upload_invalid_response",
  );
}

function validateInput(input: RecordingUploadInput): void {
  const fields: Record<string, string[]> = {};
  if (!(input.file instanceof File)) fields.file = ["Choose an audio file"];
  else if (input.file.size === 0) fields.file = ["The selected audio file is empty"];
  else if (input.file.size > MAX_RECORDING_UPLOAD_BYTES) {
    fields.file = ["The selected audio file is larger than 512 MB"];
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.clientMutationId)) {
    fields.form = ["Start a new Recording upload"];
  }
  if (Object.keys(fields).length > 0) {
    throw new RecordingUploadError(
      "Check the selected audio file.",
      0,
      "invalid_recording_upload",
      fields,
    );
  }
}

function validateSessionForFile(
  session: RecordingUploadSession,
  input: RecordingUploadInput,
): void {
  const expectedParts = Math.ceil(input.file.size / RECORDING_UPLOAD_PART_BYTES);
  const completed = new Set(session.completedParts);
  if (
    session.songId !== input.songId
    || session.byteSize !== input.file.size
    || session.partSize !== RECORDING_UPLOAD_PART_BYTES
    || session.partCount !== expectedParts
    || session.partCount < 1
    || session.partCount > MAX_RECORDING_UPLOAD_BYTES / RECORDING_UPLOAD_PART_BYTES
    || completed.size !== session.completedParts.length
    || session.completedParts.some((part) => part < 1 || part > session.partCount)
  ) throw invalidResponse();
}

type RecordingFileIdentity = {
  manifestSha256: string;
  partSha256: string[];
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Bytes(bytes: ArrayBuffer): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export async function fingerprintRecordingFile(
  file: File,
  signal?: AbortSignal,
  onPart?: (completedParts: number, totalParts: number) => void,
): Promise<RecordingFileIdentity> {
  const partCount = Math.ceil(file.size / RECORDING_UPLOAD_PART_BYTES);
  const partSha256: string[] = [];
  const manifestLines = [
    "music-library-recording-upload-manifest-v1",
    String(file.size),
    String(RECORDING_UPLOAD_PART_BYTES),
  ];
  for (let index = 0; index < partCount; index += 1) {
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    const start = index * RECORDING_UPLOAD_PART_BYTES;
    const part = file.slice(start, Math.min(start + RECORDING_UPLOAD_PART_BYTES, file.size));
    const sha256 = await sha256Bytes(await part.arrayBuffer());
    partSha256.push(sha256);
    manifestLines.push(`${index + 1}:${part.size}:${sha256}`);
    onPart?.(index + 1, partCount);
  }
  return {
    manifestSha256: await sha256Bytes(new TextEncoder().encode(manifestLines.join("\n")).buffer),
    partSha256,
  };
}

function completedBytes(session: RecordingUploadSession): number {
  return session.completedParts.reduce((total, partNumber) => {
    const start = (partNumber - 1) * session.partSize;
    return total + Math.min(session.partSize, session.byteSize - start);
  }, 0);
}

function reportProgress(
  options: RecordingUploadOptions,
  phase: RecordingUploadProgress["phase"],
  upload: RecordingUploadSession | null,
  totalBytes: number,
): void {
  options.onProgress?.({
    phase,
    completedParts: upload?.completedParts.length ?? 0,
    totalParts: upload?.partCount ?? Math.ceil(totalBytes / RECORDING_UPLOAD_PART_BYTES),
    completedBytes: upload ? completedBytes(upload) : 0,
    totalBytes,
    upload,
  });
}

async function loadUpload(
  fetcher: typeof fetch,
  sessionId: string,
  signal?: AbortSignal,
): Promise<RecordingUploadSession> {
  return parseUploadPayload(await requestJson(
    fetcher,
    `/api/recording-uploads/${encodeURIComponent(sessionId)}`,
    { method: "GET", signal },
  ));
}

async function createUpload(
  input: RecordingUploadInput,
  identity: RecordingFileIdentity,
  fetcher: typeof fetch,
  replaceTarget?: { recordingId: string; revision: number },
  signal?: AbortSignal,
): Promise<RecordingUploadSession> {
  const payload = {
    clientMutationId: input.clientMutationId,
    fileManifestSha256: identity.manifestSha256,
    filename: input.file.name,
    mimeType: input.file.type || null,
    byteSize: input.file.size,
    description: input.description,
    recordedOn: input.recordedOn,
    creditPersonIds: input.creditPersonIds,
    ...(replaceTarget
      ? {
          targetRecordingId: replaceTarget.recordingId,
          targetRecordingRevision: replaceTarget.revision,
        }
      : {}),
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return parseUploadPayload(await requestJson(
        fetcher,
        `/api/songs/${encodeURIComponent(input.songId)}/recording-uploads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        },
      ));
    } catch (error) {
      lastError = error;
      if (!(error instanceof RecordingUploadError) || error.code !== "recording_upload_network_error") {
        throw error;
      }
    }
  }
  throw lastError;
}

async function reconcilePart(
  input: RecordingUploadInput,
  identity: RecordingFileIdentity,
  session: RecordingUploadSession,
  partNumber: number,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<RecordingUploadSession> {
  const start = (partNumber - 1) * session.partSize;
  const body = input.file.slice(start, Math.min(start + session.partSize, input.file.size));
  try {
    const payload = await requestJson(
      fetcher,
      `/api/recording-uploads/${encodeURIComponent(session.id)}/parts/${partNumber}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Upload-Part-Sha256": identity.partSha256[partNumber - 1] ?? "",
          "X-Upload-File-Manifest": identity.manifestSha256,
        },
        body,
        signal,
      },
    );
    if (!isRecord(payload) || !isRecord(payload.upload) || !Number.isSafeInteger(payload.upload.revision)) {
      throw invalidResponse();
    }
    return {
      ...session,
      revision: payload.upload.revision as number,
      completedParts: [...new Set([...session.completedParts, partNumber])].sort((left, right) => left - right),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    const current = await loadUpload(fetcher, session.id, signal);
    validateSessionForFile(current, input);
    if (current.completedParts.includes(partNumber)) return current;
    if (error instanceof RecordingUploadError) error.upload = current;
    throw error;
  }
}

async function verifyUploadFile(
  fetcher: typeof fetch,
  session: RecordingUploadSession,
  identity: RecordingFileIdentity,
  signal?: AbortSignal,
): Promise<void> {
  if (!session.fileIdentityBound) {
    throw new RecordingUploadError(
      ERROR_MESSAGES.recording_upload_file_identity_unavailable,
      409,
      "recording_upload_file_identity_unavailable",
    );
  }
  await requestJson(
    fetcher,
    `/api/recording-uploads/${encodeURIComponent(session.id)}/verify-file`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileManifestSha256: identity.manifestSha256 }),
      signal,
    },
  );
}

async function completeUpload(
  input: RecordingUploadInput,
  initial: RecordingUploadSession,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<RecordingUploadSession> {
  let session = initial;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const completed = parseUploadPayload(await requestJson(
        fetcher,
        `/api/recording-uploads/${encodeURIComponent(session.id)}/complete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision: session.revision }),
          signal,
        },
      ));
      return completed.completedParts.length === 0 && session.completedParts.length > 0
        ? { ...completed, completedParts: session.completedParts }
        : completed;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      session = await loadUpload(fetcher, session.id, signal);
      validateSessionForFile(session, input);
      if (["stored", "duplicate", "finalized"].includes(session.status)) return session;
      if (!["open", "completing"].includes(session.status)) break;
    }
  }
  if (lastError instanceof RecordingUploadError) lastError.upload = session;
  throw lastError;
}

async function finalizeUpload(
  input: RecordingUploadInput,
  initial: RecordingUploadSession,
  fetcher: typeof fetch,
  options: RecordingUploadOptions,
): Promise<RecordingUploadResult> {
  let session = initial;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return parseFinalizedPayload(await requestJson(
        fetcher,
        options.replaceTarget
          ? `/api/songs/${encodeURIComponent(session.songId)}/recording-uploads/${encodeURIComponent(session.id)}/replace`
          : `/api/recording-uploads/${encodeURIComponent(session.id)}/finalize`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(options.replaceTarget
            ? {
                targetRecordingId: options.replaceTarget.recordingId,
                targetRecordingRevision: options.replaceTarget.revision,
                sessionRevision: session.revision,
                ...(options.descriptionOverride === undefined
                  ? {}
                  : { description: options.descriptionOverride }),
              }
            : {
                revision: session.revision,
                ...(options.descriptionOverride === undefined
                  ? {}
                  : { description: options.descriptionOverride }),
              }),
          signal: options.signal,
        },
      ));
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastError = error;
      if (
        error instanceof RecordingUploadError
        && error.code === "duplicate_recording_description"
      ) break;
      session = await loadUpload(fetcher, session.id, options.signal);
      validateSessionForFile(session, input);
      if (session.status === "duplicate" && session.duplicateRecording) {
        return { kind: "duplicate", upload: session, duplicateRecording: session.duplicateRecording };
      }
      if (session.status === "finalized") {
        const payload = await requestJson(
          fetcher,
          options.replaceTarget
            ? `/api/songs/${encodeURIComponent(session.songId)}/recording-uploads/${encodeURIComponent(session.id)}/replace`
            : `/api/recording-uploads/${encodeURIComponent(session.id)}/finalize`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(options.replaceTarget
              ? {
                  targetRecordingId: options.replaceTarget.recordingId,
                  targetRecordingRevision: options.replaceTarget.revision,
                  sessionRevision: session.revision,
                }
              : { revision: session.revision }),
            signal: options.signal,
          },
        );
        return parseFinalizedPayload(payload);
      }
      if (session.status !== "stored") break;
    }
  }
  if (lastError instanceof RecordingUploadError) lastError.upload = session;
  throw lastError;
}

export async function uploadRecordingOriginal(
  input: RecordingUploadInput,
  options: RecordingUploadOptions = {},
): Promise<RecordingUploadResult> {
  validateInput(input);
  const fetcher = options.fetcher ?? fetch;
  let session: RecordingUploadSession | null = options.resumeUpload ?? null;
  let fileIdentityVerified = false;
  try {
    options.onProgress?.({
      phase: "fingerprinting",
      completedParts: 0,
      totalParts: Math.ceil(input.file.size / RECORDING_UPLOAD_PART_BYTES),
      completedBytes: 0,
      totalBytes: input.file.size,
      upload: session,
    });
    const identity = await fingerprintRecordingFile(
      input.file,
      options.signal,
      (completedParts, totalParts) => options.onProgress?.({
        phase: "fingerprinting",
        completedParts,
        totalParts,
        completedBytes: Math.min(completedParts * RECORDING_UPLOAD_PART_BYTES, input.file.size),
        totalBytes: input.file.size,
        upload: session,
      }),
    );
    if (session) {
      session = await loadUpload(fetcher, session.id, options.signal);
      if (session.status === "open") {
        await verifyUploadFile(fetcher, session, identity, options.signal);
        fileIdentityVerified = true;
      }
    } else {
      reportProgress(options, "creating", null, input.file.size);
      session = await createUpload(input, identity, fetcher, options.replaceTarget, options.signal);
      fileIdentityVerified = true;
    }
    validateSessionForFile(session, input);

    if (session.status === "duplicate" && session.duplicateRecording) {
      return { kind: "duplicate", upload: session, duplicateRecording: session.duplicateRecording };
    }
    if (session.status === "finalized") {
      reportProgress(options, "finalizing", session, input.file.size);
      return finalizeUpload(input, session, fetcher, options);
    }
    if (["aborted", "failed"].includes(session.status)) {
      throw new RecordingUploadError(
        ERROR_MESSAGES.recording_upload_terminal,
        409,
        "recording_upload_terminal",
      );
    }

    if (session.status === "open") {
      session = await loadUpload(fetcher, session.id, options.signal);
      validateSessionForFile(session, input);
      if (!fileIdentityVerified) {
        await verifyUploadFile(fetcher, session, identity, options.signal);
        fileIdentityVerified = true;
      }
      const completed = new Set(session.completedParts);
      for (let partNumber = 1; partNumber <= session.partCount; partNumber += 1) {
        if (completed.has(partNumber)) continue;
        reportProgress(options, "uploading", session, input.file.size);
        session = await reconcilePart(input, identity, session, partNumber, fetcher, options.signal);
        completed.add(partNumber);
        reportProgress(options, "uploading", session, input.file.size);
      }
    }

    if (["open", "completing"].includes(session.status)) {
      reportProgress(options, "completing", session, input.file.size);
      session = await completeUpload(input, session, fetcher, options.signal);
      validateSessionForFile(session, input);
    }
    if (session.status === "duplicate" && session.duplicateRecording) {
      return { kind: "duplicate", upload: session, duplicateRecording: session.duplicateRecording };
    }
    if (!["stored", "finalized"].includes(session.status)) {
      throw new RecordingUploadError(
        ERROR_MESSAGES.recording_upload_terminal,
        409,
        "recording_upload_terminal",
      );
    }

    reportProgress(options, "finalizing", session, input.file.size);
    return await finalizeUpload(input, session, fetcher, options);
  } catch (error) {
    if (error instanceof RecordingUploadError && session) error.upload ??= session;
    throw error;
  }
}

export async function abortRecordingUpload(
  upload: RecordingUploadSession,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<RecordingUploadSession> {
  return parseUploadPayload(await requestJson(
    fetcher,
    `/api/recording-uploads/${encodeURIComponent(upload.id)}/abort`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: upload.revision }),
      signal,
    },
  ));
}

export async function reuseHistoricalRecordingUpload(
  upload: RecordingUploadSession,
  replaceTarget: { recordingId: string; revision: number },
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<FinalizedRecording> {
  const payload = await requestJson(
    fetcher,
    `/api/songs/${encodeURIComponent(upload.songId)}/recording-uploads/${encodeURIComponent(upload.id)}/reuse-history`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetRecordingId: replaceTarget.recordingId,
        targetRecordingRevision: replaceTarget.revision,
        sessionRevision: upload.revision,
      }),
      signal,
    },
  );
  if (!isRecord(payload) || !isRecord(payload.recording)) throw invalidResponse();
  const recording = payload.recording;
  if (
    typeof recording.id !== "string"
    || !Number.isSafeInteger(recording.revision)
    || recording.processingState !== "ready"
  ) throw invalidResponse();
  return {
    id: recording.id,
    revision: recording.revision as number,
    processingState: "ready",
  };
}

export async function listRecoverableRecordingUploads(
  songId: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<RecordingUploadSession[]> {
  const payload = await requestJson(
    fetcher,
    `/api/songs/${encodeURIComponent(songId)}/recording-uploads`,
    { method: "GET", signal },
  );
  if (!isRecord(payload) || !Array.isArray(payload.uploads)) throw invalidResponse();
  return payload.uploads.map(parseUpload);
}

export async function discardRecordingUpload(
  upload: RecordingUploadSession,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<RecordingUploadSession> {
  return parseUploadPayload(await requestJson(
    fetcher,
    `/api/recording-uploads/${encodeURIComponent(upload.id)}/discard`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: upload.revision }),
      signal,
    },
  ));
}

export async function finishStoredRecordingUpload(
  upload: RecordingUploadSession,
  options: Pick<RecordingUploadOptions, "fetcher" | "signal" | "replaceTarget"> = {},
): Promise<RecordingUploadResult> {
  if (upload.status !== "stored" && upload.status !== "finalized") {
    throw new RecordingUploadError(
      ERROR_MESSAGES.recording_upload_terminal,
      409,
      "recording_upload_terminal",
    );
  }
  if (
    upload.intent?.kind === "replace"
    && (
      !options.replaceTarget
      || options.replaceTarget.recordingId !== upload.intent.targetRecordingId
      || options.replaceTarget.revision !== upload.intent.targetRecordingRevision
    )
  ) {
    throw invalidResponse();
  }
  const fetcher = options.fetcher ?? fetch;
  const replaceTarget = options.replaceTarget;
  const payload = await requestJson(
    fetcher,
    replaceTarget
      ? `/api/songs/${encodeURIComponent(upload.songId)}/recording-uploads/${encodeURIComponent(upload.id)}/replace`
      : `/api/recording-uploads/${encodeURIComponent(upload.id)}/finalize`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(replaceTarget
        ? {
            targetRecordingId: replaceTarget.recordingId,
            targetRecordingRevision: replaceTarget.revision,
            sessionRevision: upload.revision,
          }
        : { revision: upload.revision }),
      signal: options.signal,
    },
  );
  return parseFinalizedPayload(payload);
}

export async function completeServerHeldRecordingUpload(
  upload: RecordingUploadSession,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<RecordingUploadSession> {
  if (
    !["open", "completing", "stored"].includes(upload.status)
    || (upload.status === "open" && upload.completedParts.length !== upload.partCount)
  ) {
    throw new RecordingUploadError(
      ERROR_MESSAGES.recording_upload_terminal,
      409,
      "recording_upload_terminal",
    );
  }
  if (upload.status === "stored") return upload;
  return parseUploadPayload(await requestJson(
    fetcher,
    `/api/recording-uploads/${encodeURIComponent(upload.id)}/complete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: upload.revision }),
      signal,
    },
  ));
}
