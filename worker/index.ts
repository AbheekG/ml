import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { decode, verifyWithJwks } from "hono/jwt";
import { loadAccessJwks } from "./access-jwks";
import { loadOfflineLibrary } from "./offline-library";
import {
  AUDIO_PROCESSING_LEASE_MS,
  AUDIO_PROCESSING_CAPABILITY_HEADER,
  MAX_EXPIRED_AUDIO_PROCESSING_ATTEMPTS,
  MAX_AUDIO_DERIVATIVE_BYTES,
  MAX_AUDIO_PROCESSING_RESULT_BYTES,
  audioProcessingDerivativeObjectKey,
  buildAudioProcessingCapabilityUrl,
  createAudioProcessingCapabilityToken,
  createAudioProcessingLeaseToken,
  hashAudioProcessingToken,
  normalizeProcessorTransferOrigin,
  parseAudioProcessingFailure,
  parseBearerToken,
  processorTokenMatches,
  verifyAudioProcessingCapabilityToken,
  type AudioProcessingCapabilityOperation,
} from "./audio-processing-control";
import {
  AUDIO_PROCESSING_POLICY_ID,
  hostedResultMatchesAudioProcessingJob,
  parseVerifiedHostedResult,
  type AudioProcessingJobStatus,
  type VerifiedHostedResult,
} from "./audio-processing-jobs";
import {
  parseLookupCreate,
  parseLookupKind,
  parseLookupUpdate,
  type LookupKind,
} from "./lookup-writes";
import {
  parseLyricCreate,
  parseLyricRevision,
  parseLyricUpdate,
  type LyricUpdateInput,
} from "./lyric-writes";
import {
  MAX_SCAN_UPLOAD_BYTES,
  inspectScanImage,
  safeUploadFilename,
  scanUploadRequestIsTooLarge,
  sha256Hex,
} from "./media-upload";
import { encodeRfc5987Filename } from "./filename-safety";
import {
  createScanReadabilityDerivative,
  scanReadabilityObjectKey,
  ScanReadabilityError,
  type ScanReadabilityDerivative,
} from "./scan-readability";
import {
  parseScanCreate,
  parseScanOrientation,
  parseScanRevision,
  parseScanUpdate,
  type ScanUpdateInput,
} from "./scan-writes";
import {
  parseRecordingRevision,
  parseRecordingUpdate,
  type RecordingUpdateInput,
} from "./recording-writes";
import { parseMediaParentMove } from "./media-parent-moves";
import {
  RECORDING_UPLOAD_EXPIRY_MS,
  RECORDING_UPLOAD_PART_BYTES,
  expectedRecordingPartBytes,
  parseRecordingUploadCreate,
  parseRecordingUploadFileIdentity,
  parseRecordingUploadFinalization,
  parseRecordingUploadReplacement,
  parseRecordingUploadRevision,
  recordingUploadRequestFingerprint,
  recordingUploadFileManifestSha256,
  sha256RecordingStream,
  validateCompletedRecordingParts,
  type RecordingUploadCreateInput,
} from "./recording-upload";
import {
  parseSongCreate,
  parseSongRevision,
  parseSongUpdate,
  normalizedTextKey,
  type SongWriteInput,
  type SongUpdateInput,
} from "./song-writes";
import {
  GoogleJobTriggerError,
  triggerGoogleCloudRunJob,
  validGoogleJobTriggerConfig,
  type GoogleJobTriggerConfig,
} from "./google-job-trigger";

export type AppRole = "viewer" | "editor" | "admin";
export type AppUser = {
  identity: string;
  displayName: string | null;
  role: AppRole;
};

type Bindings = {
  DB: D1Database;
  MEDIA: R2Bucket;
  IMAGES: ImagesBinding;
  AUTH_MODE: "access" | "local";
  ACCESS_AUD: string;
  ACCESS_ISSUER: string;
  ACCESS_JWKS_URL: string;
  LOCAL_ROLE?: AppRole;
  AUDIO_PROCESSOR_TOKEN?: string;
  AUDIO_PROCESSOR_TRANSFER_ORIGIN?: string;
  GCP_PROJECT_ID?: string;
  GCP_REGION?: string;
  GCP_JOB_NAME?: string;
  GCP_WORKLOAD_IDENTITY_PROVIDER?: string;
};

type Variables = {
  accessIdentity: {
    email: string;
    subject: string;
  };
  appUser: AppUser;
};

const ROLE_RANK: Record<AppRole, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
};

export function roleAllows(actual: AppRole, required: AppRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export async function resolveActiveAppUser(database: D1Database, email: string): Promise<AppUser | null> {
  return database.prepare(`
    SELECT
      identity,
      display_name AS displayName,
      role
    FROM app_users
    WHERE identity = ? COLLATE NOCASE AND is_active = 1
  `).bind(email).first<AppUser>();
}

async function opaqueCacheNamespace(issuer: string, subject: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${issuer}\0${subject}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

export const requireRole = (required: AppRole) => createMiddleware<{
  Bindings: Bindings;
  Variables: Variables;
}>(async (context, next) => {
  if (!roleAllows(context.get("appUser").role, required)) {
    return context.json({ error: "insufficient_role", requiredRole: required }, 403);
  }
  await next();
});

type CatalogSongRow = {
  id: string;
  titleLatin: string;
  titleNative: string | null;
  updatedAt: string;
  languageIds: string;
  lyricCount: number;
  scanCount: number;
  recordingCount: number;
};

type SongRow = {
  id: string;
  titleLatin: string;
  titleNative: string | null;
  status: string | null;
  notes: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type RecordingCreditRow = {
  recordingId: string;
  personId: string;
  fullName: string;
  role: string;
};

type MediaRow = {
  id: string;
  objectKey: string;
  filename: string;
  mimeType: string | null;
};

type LyricStateRow = {
  revision: number;
  trashedAt: string | null;
  songTrashedAt: string | null;
};

type LyricCreateReplayRow = {
  songId: string;
  content: string;
  origin: "user" | "legacy_import";
  revision: number;
  createdBy: string;
  trashedAt: string | null;
};

type ScanStateRow = {
  revision: number;
  rotationQuarterTurns: 0 | 1 | 2 | 3;
  trashedAt: string | null;
  songTrashedAt: string | null;
  mediaState: "active" | "trashed";
};

type RecordingStateRow = {
  revision: number;
  trashedAt: string | null;
  songTrashedAt: string | null;
  originalMediaState: "active" | "trashed";
  playbackMediaState: "active" | "trashed" | null;
};

type RecordingUploadStatus =
  | "creating" | "open" | "completing" | "stored"
  | "duplicate" | "finalized" | "aborted" | "failed";

type RecordingUploadSessionRow = {
  id: string;
  songId: string;
  requestFingerprint: string;
  fileManifestSha256: string | null;
  description: string | null;
  recordedOn: string | null;
  filename: string;
  byteSize: number;
  partCount: number;
  objectKey: string;
  uploadId: string | null;
  status: RecordingUploadStatus;
  revision: number;
  expiresAt: string;
  sha256: string | null;
  duplicateMediaId: string | null;
  recordingId: string | null;
  intentKind: "create" | "replace" | null;
  targetRecordingId: string | null;
  targetRecordingRevision: number | null;
};

type RecordingUploadPartRow = {
  partNumber: number;
  etag: string;
  byteSize: number;
  sha256: string | null;
};

type RecordingUploadDuplicateRow = {
  mediaId: string;
  recordingId: string | null;
  songId: string | null;
  recordingTrashedAt: string | null;
  recordingRevision: number | null;
  historyId: string | null;
  historyOriginalMediaId: string | null;
  historyPlaybackMediaId: string | null;
  isHistorical: number;
};

type FinalizedRecordingRow = {
  id: string;
  revision: number;
  processingState: "processing" | "ready" | "failed";
};

type AudioProcessingJobRow = {
  id: string;
  recordingId: string;
  songId: string;
  sourceMediaId: string;
  sourceObjectKey: string;
  sourceMediaState: "active" | "trashed";
  sourceSha256: string;
  sourceByteSize: number;
  policyId: typeof AUDIO_PROCESSING_POLICY_ID;
  status: AudioProcessingJobStatus;
  attemptCount: number;
  leaseTokenHash: string | null;
  leaseExpiresAt: string | null;
  playbackKind: "original" | "derivative" | null;
  derivativeMediaId: string | null;
  derivativeObjectKey: string | null;
  derivativeSha256: string | null;
  derivativeByteSize: number | null;
  errorCode: string | null;
  recordingRevision: number;
  recordingProcessingState: "processing" | "ready" | "failed";
  recordingTrashedAt: string | null;
};

type SongStateRow = {
  revision: number;
  trashedAt: string | null;
};

type SongDependencies = {
  lyricTexts: number;
  scans: number;
  recordings: number;
};

type LookupTable = "languages" | "tags" | "notebooks" | "people";

const LOOKUP_CONFIG: Record<LookupKind, {
  table: LookupTable;
  nameColumn: "display_name" | "full_name";
  ordered: boolean;
}> = {
  languages: { table: "languages", nameColumn: "display_name", ordered: true },
  tags: { table: "tags", nameColumn: "display_name", ordered: true },
  notebooks: { table: "notebooks", nameColumn: "display_name", ordered: true },
  people: { table: "people", nameColumn: "full_name", ordered: false },
};

async function lookupIdsExist(database: D1Database, table: LookupTable, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  const placeholders = ids.map(() => "?").join(", ");
  const result = await database.prepare(
    `SELECT id FROM ${table} WHERE id IN (${placeholders})`,
  ).bind(...ids).all<{ id: string }>();
  return result.results.length === ids.length;
}

function songWriteError(error: unknown): { error: string; status: 400 | 409 | 500 } {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("songs.normalized_title_latin") || message.includes("songs_active_normalized_title_idx")) {
    return { error: "duplicate_song_title", status: 409 };
  }
  if (message.includes("song_aliases") && message.includes("UNIQUE")) {
    return { error: "duplicate_song_alias", status: 409 };
  }
  if (message.includes("FOREIGN KEY")) {
    return { error: "invalid_reference", status: 400 };
  }
  return { error: "song_write_failed", status: 500 };
}

function lyricWriteError(error: unknown): { error: string; status: 400 | 409 | 500 } {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("lyric_texts") && message.includes("UNIQUE")) {
    return { error: "duplicate_lyric_text", status: 409 };
  }
  if (message.includes("FOREIGN KEY")) {
    return { error: "song_not_found", status: 400 };
  }
  return { error: "lyric_write_failed", status: 500 };
}

function scanWriteError(error: unknown): { error: string; status: 400 | 409 | 500 } {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("duplicate_or_invalid_scan_fingerprint")
    || message.includes("scan_fingerprints.sha256")) {
    return { error: "duplicate_scan_file", status: 409 };
  }
  if (message.includes("FOREIGN KEY") || message.includes("CHECK constraint")) {
    return { error: "invalid_scan_reference", status: 400 };
  }
  return { error: "scan_write_failed", status: 500 };
}

function scanReadabilityError(error: unknown): { error: string; status: 400 | 413 | 503 } {
  if (error instanceof ScanReadabilityError) {
    if (error.code === "scan_image_too_large") {
      return { error: error.code, status: 413 };
    }
    if (error.code === "scan_image_decode_failed"
      || error.code === "scan_image_dimensions_invalid") {
      return { error: error.code, status: 400 };
    }
  }
  return { error: "scan_readability_unavailable", status: 503 };
}

type DuplicateScanRow = {
  mediaId: string;
  historyId: string | null;
  isHistorical: number;
  representationPriority: number;
  scanId: string | null;
  songId: string | null;
  songTitle: string | null;
  filename: string;
  notebookName: string | null;
  pageLabel: string | null;
  scanRevision: number | null;
  scanIsTrashed: number | null;
  songIsTrashed: number | null;
};

async function loadDuplicateScan(
  database: D1Database,
  fingerprint: string,
  byteSize: number,
): Promise<DuplicateScanRow | null> {
  return database.prepare(`
    WITH duplicate_media(media_id, representation_priority) AS (
      SELECT
        scan_fingerprint_members.media_id,
        0
      FROM scan_fingerprint_members
      JOIN media_objects ON media_objects.id = scan_fingerprint_members.media_id
      WHERE scan_fingerprint_members.sha256 = ?
        AND media_objects.byte_size = ?
      UNION ALL
      SELECT
        scan_readability_derivatives.source_media_id,
        1
      FROM scan_readability_derivatives
      WHERE scan_readability_derivatives.sha256 = ?
        AND scan_readability_derivatives.byte_size = ?
    ), candidate_owners AS (
      SELECT
        duplicate_media.media_id,
        duplicate_media.representation_priority,
        scans.id AS scan_id,
        NULL AS history_id,
        0 AS is_historical
      FROM duplicate_media
      JOIN scans ON scans.media_id = duplicate_media.media_id
      UNION ALL
      SELECT
        duplicate_media.media_id,
        duplicate_media.representation_priority,
        scan_media_history.scan_id,
        scan_media_history.id,
        1
      FROM duplicate_media
      JOIN scan_media_history ON scan_media_history.media_id = duplicate_media.media_id
    )
    SELECT
      duplicate_media.media_id AS mediaId,
      candidate_owners.history_id AS historyId,
      COALESCE(candidate_owners.is_historical, 0) AS isHistorical,
      duplicate_media.representation_priority AS representationPriority,
      scans.id AS scanId,
      scans.song_id AS songId,
      songs.title_latin AS songTitle,
      media_objects.original_filename AS filename,
      notebooks.display_name AS notebookName,
      scans.page_label AS pageLabel,
      scans.revision AS scanRevision,
      CASE WHEN scans.trashed_at IS NULL THEN 0 ELSE 1 END AS scanIsTrashed,
      CASE WHEN songs.trashed_at IS NULL THEN 0 ELSE 1 END AS songIsTrashed
    FROM duplicate_media
    JOIN media_objects ON media_objects.id = duplicate_media.media_id
    LEFT JOIN candidate_owners
      ON candidate_owners.media_id = duplicate_media.media_id
      AND candidate_owners.representation_priority = duplicate_media.representation_priority
    LEFT JOIN scans ON scans.id = candidate_owners.scan_id
    LEFT JOIN songs ON songs.id = scans.song_id
    LEFT JOIN notebooks ON notebooks.id = scans.notebook_id
    ORDER BY
      scans.id IS NULL,
      scans.trashed_at IS NOT NULL,
      candidate_owners.is_historical,
      duplicate_media.representation_priority,
      scans.id,
      media_objects.id
    LIMIT 1
  `).bind(
    fingerprint,
    byteSize,
    fingerprint,
    byteSize,
  ).first<DuplicateScanRow>();
}

async function reuseHistoricalScanMedia(
  database: D1Database,
  songId: string,
  scanId: string,
  revision: number,
  historicalMediaId: string,
  actor: string,
): Promise<boolean> {
  const timestamp = new Date().toISOString();
  const historyId = crypto.randomUUID();
  try {
    const results = await database.batch([
      database.prepare(`
        INSERT INTO scan_media_history (
          id, scan_id, media_id, replaced_at, replaced_by, revision_at_replacement
        )
        SELECT ?, scans.id, scans.media_id, ?, ?, scans.revision
        FROM scans
        JOIN songs ON songs.id = scans.song_id
        WHERE scans.id = ? AND scans.song_id = ? AND scans.revision = ?
          AND scans.trashed_at IS NULL AND songs.trashed_at IS NULL
          AND scans.media_id <> ?
          AND EXISTS (
            SELECT 1 FROM scan_media_history
            JOIN media_objects
              ON media_objects.id = scan_media_history.media_id
            WHERE scan_media_history.scan_id = scans.id
              AND scan_media_history.media_id = ?
              AND media_objects.kind = 'scan'
              AND media_objects.state = 'active'
          )
      `).bind(
        historyId, timestamp, actor, scanId, songId, revision,
        historicalMediaId, historicalMediaId,
      ),
      database.prepare(`
        UPDATE scans
        SET media_id = ?, rotation_quarter_turns = 0,
            revision = revision + 1, updated_at = ?, updated_by = ?
        WHERE id = ? AND song_id = ? AND revision = ? AND trashed_at IS NULL
          AND EXISTS (SELECT 1 FROM scan_media_history WHERE id = ? AND scan_id = scans.id)
      `).bind(
        historicalMediaId, timestamp, actor, scanId, songId, revision, historyId,
      ),
      database.prepare(`
        UPDATE songs SET updated_at = ?, updated_by = ?
        WHERE id = ? AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM scans
            WHERE id = ? AND song_id = songs.id AND media_id = ?
              AND revision = ? AND trashed_at IS NULL
          )
      `).bind(timestamp, actor, songId, scanId, historicalMediaId, revision + 1),
    ]);
    return results[1].meta.changes > 0;
  } catch {
    const reconciled = await database.prepare(`
      SELECT 1 AS complete
      FROM scans
      WHERE id = ? AND song_id = ? AND media_id = ?
        AND revision = ? AND trashed_at IS NULL
    `).bind(scanId, songId, historicalMediaId, revision + 1).first<{ complete: number }>()
      .catch(() => null);
    return Boolean(reconciled);
  }
}

async function removeUncommittedScanObjects(
  media: R2Bucket,
  originalObjectKey: string,
  readabilityObjectKey: string,
): Promise<void> {
  try {
    await media.delete([originalObjectKey, readabilityObjectKey]);
  } catch {
    console.error("Failed to remove uncommitted Scan objects");
  }
}

async function removeUncommittedScanRows(database: D1Database, mediaId: string): Promise<boolean> {
  try {
    await database.batch([
      database.prepare(`
        DELETE FROM scan_readability_derivatives WHERE source_media_id = ?
      `).bind(mediaId),
      database.prepare(`DELETE FROM media_objects WHERE id = ?`).bind(mediaId),
    ]);
  } catch {
    console.error("Retaining Scan objects because D1 cleanup was not acknowledged");
    return false;
  }
  try {
    const retained = await database.prepare(`
      SELECT
        EXISTS (SELECT 1 FROM media_objects WHERE id = ?) AS mediaExists,
        EXISTS (
          SELECT 1 FROM scan_readability_derivatives
          WHERE source_media_id = ?
        ) AS derivativeExists
    `).bind(mediaId, mediaId).first<{ mediaExists: number; derivativeExists: number }>();
    return retained?.mediaExists === 0 && retained.derivativeExists === 0;
  } catch {
    console.error("Retaining Scan objects because D1 cleanup could not be verified");
    return false;
  }
}

async function removeUncommittedScanResources(
  database: D1Database,
  media: R2Bucket,
  mediaId: string,
  originalObjectKey: string,
  readabilityObjectKey: string,
): Promise<void> {
  if (!await removeUncommittedScanRows(database, mediaId)) return;
  await removeUncommittedScanObjects(media, originalObjectKey, readabilityObjectKey);
}

function scanReadabilityInsert(
  database: D1Database,
  mediaId: string,
  sourceSha256: string,
  sourceByteSize: number,
  objectKey: string,
  derivative: ScanReadabilityDerivative,
  timestamp: string,
  actor: string,
): D1PreparedStatement {
  return database.prepare(`
    INSERT INTO scan_readability_derivatives (
      source_media_id, source_sha256, source_byte_size, object_key,
      mime_type, byte_size, sha256, width, height, policy_id,
      created_at, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    mediaId,
    sourceSha256,
    sourceByteSize,
    objectKey,
    derivative.mimeType,
    derivative.bytes.byteLength,
    derivative.sha256,
    derivative.width,
    derivative.height,
    derivative.policyId,
    timestamp,
    actor,
  );
}

function recordingWriteError(error: unknown): { error: string; status: 400 | 409 | 500 } {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("recordings_active_description_idx")
    || (message.includes("recordings.song_id") && message.includes("recordings.normalized_description"))) {
    return { error: "duplicate_recording_description", status: 409 };
  }
  if (message.includes("FOREIGN KEY")) {
    return { error: "invalid_recording_reference", status: 400 };
  }
  if (message.includes("invalid_recording_values") || message.includes("CHECK constraint")) {
    return { error: "invalid_recording", status: 400 };
  }
  if (message.includes("recording_has_active_audio_processing")) {
    return { error: "recording_processing_active", status: 409 };
  }
  return { error: "recording_write_failed", status: 500 };
}

async function loadRecordingUploadSession(
  database: D1Database,
  sessionId: string,
  actor: string,
  allowAnyActor = false,
): Promise<RecordingUploadSessionRow | null> {
  return database.prepare(`
    SELECT
      id,
      song_id AS songId,
      request_fingerprint AS requestFingerprint,
      file_manifest_sha256 AS fileManifestSha256,
      description,
      recorded_on AS recordedOn,
      original_filename AS filename,
      byte_size AS byteSize,
      part_count AS partCount,
      object_key AS objectKey,
      r2_upload_id AS uploadId,
      status,
      revision,
      expires_at AS expiresAt,
      sha256,
      duplicate_media_id AS duplicateMediaId,
      recording_id AS recordingId,
      recording_upload_intents.intent_kind AS intentKind,
      recording_upload_intents.target_recording_id AS targetRecordingId,
      recording_upload_intents.target_recording_revision AS targetRecordingRevision
    FROM recording_upload_sessions
    LEFT JOIN recording_upload_intents
      ON recording_upload_intents.session_id = recording_upload_sessions.id
    WHERE recording_upload_sessions.id = ?
      AND (recording_upload_sessions.created_by = ? OR ? = 1)
  `).bind(sessionId, actor, allowAnyActor ? 1 : 0).first<RecordingUploadSessionRow>();
}

async function loadRecordingUploadByMutation(
  database: D1Database,
  actor: string,
  clientMutationId: string,
): Promise<RecordingUploadSessionRow | null> {
  return database.prepare(`
    SELECT
      id,
      song_id AS songId,
      request_fingerprint AS requestFingerprint,
      file_manifest_sha256 AS fileManifestSha256,
      description,
      recorded_on AS recordedOn,
      original_filename AS filename,
      byte_size AS byteSize,
      part_count AS partCount,
      object_key AS objectKey,
      r2_upload_id AS uploadId,
      status,
      revision,
      expires_at AS expiresAt,
      sha256,
      duplicate_media_id AS duplicateMediaId,
      recording_id AS recordingId,
      recording_upload_intents.intent_kind AS intentKind,
      recording_upload_intents.target_recording_id AS targetRecordingId,
      recording_upload_intents.target_recording_revision AS targetRecordingRevision
    FROM recording_upload_sessions
    LEFT JOIN recording_upload_intents
      ON recording_upload_intents.session_id = recording_upload_sessions.id
    WHERE recording_upload_sessions.created_by = ?
      AND recording_upload_sessions.client_mutation_id = ?
  `).bind(actor, clientMutationId).first<RecordingUploadSessionRow>();
}

async function loadRecoverableRecordingUploads(
  database: D1Database,
  songId: string,
  actor: string,
): Promise<RecordingUploadSessionRow[]> {
  const uploads = await database.prepare(`
    SELECT
      recording_upload_sessions.id,
      recording_upload_sessions.song_id AS songId,
      recording_upload_sessions.request_fingerprint AS requestFingerprint,
      recording_upload_sessions.file_manifest_sha256 AS fileManifestSha256,
      recording_upload_sessions.description,
      recording_upload_sessions.recorded_on AS recordedOn,
      recording_upload_sessions.original_filename AS filename,
      recording_upload_sessions.byte_size AS byteSize,
      recording_upload_sessions.part_count AS partCount,
      recording_upload_sessions.object_key AS objectKey,
      recording_upload_sessions.r2_upload_id AS uploadId,
      recording_upload_sessions.status,
      recording_upload_sessions.revision,
      recording_upload_sessions.expires_at AS expiresAt,
      recording_upload_sessions.sha256,
      recording_upload_sessions.duplicate_media_id AS duplicateMediaId,
      recording_upload_sessions.recording_id AS recordingId,
      recording_upload_intents.intent_kind AS intentKind,
      recording_upload_intents.target_recording_id AS targetRecordingId,
      recording_upload_intents.target_recording_revision AS targetRecordingRevision
    FROM recording_upload_sessions
    LEFT JOIN recording_upload_intents
      ON recording_upload_intents.session_id = recording_upload_sessions.id
    WHERE recording_upload_sessions.song_id = ?
      AND recording_upload_sessions.created_by = ?
      AND recording_upload_sessions.status IN (
        'creating', 'open', 'completing', 'stored', 'duplicate'
      )
    ORDER BY recording_upload_sessions.updated_at DESC, recording_upload_sessions.id
    LIMIT 50
  `).bind(songId, actor).all<RecordingUploadSessionRow>();
  return uploads.results;
}

function publicRecordingUploadSession(
  session: RecordingUploadSessionRow,
  completedParts: number[] = [],
  duplicate: RecordingUploadDuplicateRow | null = null,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id: session.id,
    songId: session.songId,
    filename: session.filename,
    byteSize: session.byteSize,
    partSize: RECORDING_UPLOAD_PART_BYTES,
    partCount: session.partCount,
    completedParts,
    status: session.status,
    revision: session.revision,
    expiresAt: session.expiresAt,
    recordingId: session.recordingId,
    fileIdentityBound: session.fileManifestSha256 !== null,
    intent: session.intentKind == null
      ? null
      : {
          kind: session.intentKind,
          targetRecordingId: session.targetRecordingId,
          targetRecordingRevision: session.targetRecordingRevision,
        },
  };
  if (session.status === "duplicate") {
    result.duplicateRecording = {
      id: duplicate?.recordingId ?? null,
      songId: duplicate?.songId ?? null,
      trashed: duplicate ? duplicate.recordingTrashedAt !== null : null,
      revision: duplicate?.recordingRevision ?? null,
      isHistorical: duplicate?.isHistorical === 1,
    };
  }
  return result;
}

async function discardRecordingUploadSession(
  context: any,
  allowAnyActor: boolean,
): Promise<Response> {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseRecordingUploadRevision(body);
  if (!parsed.success) return context.json({ error: "invalid_recording_upload" }, 400);
  const actor = context.get("appUser").identity;
  const session = await loadRecordingUploadSession(
    context.env.DB,
    context.req.param("sessionId"),
    actor,
    allowAnyActor,
  );
  if (!session) return context.json({ error: "recording_upload_not_found" }, 404);
  if (session.status !== "stored" && session.status !== "duplicate") {
    return context.json({ error: "recording_upload_cannot_discard" }, 409);
  }
  const timestamp = new Date().toISOString();
  let result: D1Result;
  try {
    result = await context.env.DB.prepare(`
      UPDATE recording_upload_sessions
      SET status = 'failed', duplicate_media_id = NULL,
          error_code = 'user_discarded', revision = revision + 1,
          updated_at = ?, updated_by = ?
      WHERE id = ? AND revision = ? AND status IN ('stored', 'duplicate')
        AND (created_by = ? OR ? = 1)
    `).bind(
      timestamp, actor, session.id, parsed.data.revision,
      actor, allowAnyActor ? 1 : 0,
    ).run();
  } catch {
    return context.json({ error: "recording_upload_discard_failed" }, 500);
  }
  if (result.meta.changes !== 1) {
    return context.json({ error: "recording_upload_conflict" }, 409);
  }
  const discarded = await loadRecordingUploadSession(
    context.env.DB, session.id, actor, allowAnyActor,
  );
  if (!discarded) return context.json({ error: "recording_upload_not_found" }, 404);
  return context.json({
    upload: publicRecordingUploadSession(discarded),
    objectRetainedForReview: true,
  });
}

async function loadRecordingUploadParts(
  database: D1Database,
  sessionId: string,
): Promise<RecordingUploadPartRow[]> {
  const parts = await database.prepare(`
    SELECT part_number AS partNumber, etag, byte_size AS byteSize, sha256
    FROM recording_upload_parts
    WHERE session_id = ?
    ORDER BY part_number
  `).bind(sessionId).all<RecordingUploadPartRow>();
  return parts.results;
}

async function findDuplicateRecordingMedia(
  database: D1Database,
  sha256: string,
  byteSize: number,
): Promise<RecordingUploadDuplicateRow | null> {
  return database.prepare(`
    WITH candidate_owners AS (
      SELECT
        media_objects.id AS media_id,
        recordings.id AS recording_id,
        NULL AS history_id,
        NULL AS history_original_media_id,
        NULL AS history_playback_media_id,
        0 AS is_historical
      FROM media_objects
      JOIN recordings ON
        recordings.original_media_id = media_objects.id
        OR recordings.playback_media_id = media_objects.id
      UNION ALL
      SELECT
        media_objects.id,
        recording_media_history.recording_id,
        recording_media_history.id,
        recording_media_history.original_media_id,
        recording_media_history.playback_media_id,
        1
      FROM media_objects
      JOIN recording_media_history ON
        recording_media_history.original_media_id = media_objects.id
        OR recording_media_history.playback_media_id = media_objects.id
    )
    SELECT
      media_objects.id AS mediaId,
      recordings.id AS recordingId,
      recordings.song_id AS songId,
      recordings.trashed_at AS recordingTrashedAt,
      recordings.revision AS recordingRevision,
      candidate_owners.history_id AS historyId,
      candidate_owners.history_original_media_id AS historyOriginalMediaId,
      candidate_owners.history_playback_media_id AS historyPlaybackMediaId,
      COALESCE(candidate_owners.is_historical, 0) AS isHistorical
    FROM media_objects
    LEFT JOIN candidate_owners ON candidate_owners.media_id = media_objects.id
    LEFT JOIN recordings ON recordings.id = candidate_owners.recording_id
    WHERE media_objects.kind IN ('original_audio', 'playback_audio')
      AND media_objects.sha256 = ?
      AND media_objects.byte_size = ?
    ORDER BY
      recordings.id IS NULL,
      recordings.trashed_at IS NOT NULL,
      candidate_owners.is_historical,
      media_objects.kind <> 'original_audio',
      recordings.id,
      media_objects.id
    LIMIT 1
  `).bind(sha256, byteSize).first<RecordingUploadDuplicateRow>();
}

async function loadRecordingUploadDuplicate(
  database: D1Database,
  session: RecordingUploadSessionRow,
): Promise<RecordingUploadDuplicateRow | null> {
  if (!session.duplicateMediaId) return null;
  return database.prepare(`
    WITH candidate_owners AS (
      SELECT
        recordings.id AS recording_id,
        NULL AS history_id,
        NULL AS history_original_media_id,
        NULL AS history_playback_media_id,
        0 AS is_historical
      FROM recordings
      WHERE recordings.original_media_id = ? OR recordings.playback_media_id = ?
      UNION ALL
      SELECT
        recording_media_history.recording_id,
        recording_media_history.id,
        recording_media_history.original_media_id,
        recording_media_history.playback_media_id,
        1
      FROM recording_media_history
      WHERE recording_media_history.original_media_id = ?
        OR recording_media_history.playback_media_id = ?
    )
    SELECT
      media_objects.id AS mediaId,
      recordings.id AS recordingId,
      recordings.song_id AS songId,
      recordings.trashed_at AS recordingTrashedAt,
      recordings.revision AS recordingRevision,
      candidate_owners.history_id AS historyId,
      candidate_owners.history_original_media_id AS historyOriginalMediaId,
      candidate_owners.history_playback_media_id AS historyPlaybackMediaId,
      COALESCE(candidate_owners.is_historical, 0) AS isHistorical
    FROM media_objects
    LEFT JOIN candidate_owners ON 1 = 1
    LEFT JOIN recordings ON recordings.id = candidate_owners.recording_id
    WHERE media_objects.id = ?
      AND media_objects.kind IN ('original_audio', 'playback_audio')
    ORDER BY recordings.id IS NULL, recordings.trashed_at IS NOT NULL,
             candidate_owners.is_historical, recordings.id
    LIMIT 1
  `).bind(
    session.duplicateMediaId,
    session.duplicateMediaId,
    session.duplicateMediaId,
    session.duplicateMediaId,
    session.duplicateMediaId,
  ).first<RecordingUploadDuplicateRow>();
}

async function loadFinalizedRecording(
  database: D1Database,
  session: RecordingUploadSessionRow,
): Promise<FinalizedRecordingRow | null> {
  if (!session.recordingId) return null;
  return database.prepare(`
    SELECT id, revision, processing_state AS processingState
    FROM recordings
    WHERE id = ?
  `).bind(session.recordingId).first<FinalizedRecordingRow>();
}

async function loadAudioProcessingJob(
  database: D1Database,
  jobId: string,
): Promise<AudioProcessingJobRow | null> {
  return database.prepare(`
    SELECT
      audio_processing_jobs.id,
      audio_processing_jobs.recording_id AS recordingId,
      recordings.song_id AS songId,
      audio_processing_jobs.source_media_id AS sourceMediaId,
      source_media.object_key AS sourceObjectKey,
      source_media.state AS sourceMediaState,
      audio_processing_jobs.source_sha256 AS sourceSha256,
      audio_processing_jobs.source_byte_size AS sourceByteSize,
      audio_processing_jobs.policy_id AS policyId,
      audio_processing_jobs.status,
      audio_processing_jobs.attempt_count AS attemptCount,
      audio_processing_jobs.lease_token_hash AS leaseTokenHash,
      audio_processing_jobs.lease_expires_at AS leaseExpiresAt,
      audio_processing_jobs.playback_kind AS playbackKind,
      audio_processing_jobs.derivative_media_id AS derivativeMediaId,
      derivative_media.object_key AS derivativeObjectKey,
      derivative_media.sha256 AS derivativeSha256,
      derivative_media.byte_size AS derivativeByteSize,
      audio_processing_jobs.error_code AS errorCode,
      recordings.revision AS recordingRevision,
      recordings.processing_state AS recordingProcessingState,
      recordings.trashed_at AS recordingTrashedAt
    FROM audio_processing_jobs
    JOIN recordings ON recordings.id = audio_processing_jobs.recording_id
    JOIN media_objects AS source_media
      ON source_media.id = audio_processing_jobs.source_media_id
    LEFT JOIN media_objects AS derivative_media
      ON derivative_media.id = audio_processing_jobs.derivative_media_id
    WHERE audio_processing_jobs.id = ?
  `).bind(jobId).first<AudioProcessingJobRow>();
}

async function loadAudioProcessingJobByRecording(
  database: D1Database,
  recordingId: string,
): Promise<AudioProcessingJobRow | null> {
  const job = await database.prepare(`
    SELECT audio_processing_jobs.id
    FROM audio_processing_jobs
    JOIN recordings ON recordings.id = audio_processing_jobs.recording_id
      AND recordings.original_media_id = audio_processing_jobs.source_media_id
    WHERE audio_processing_jobs.recording_id = ?
  `).bind(recordingId).first<{ id: string }>();
  return job ? loadAudioProcessingJob(database, job.id) : null;
}

type AudioDispatchSource =
  | "upload_finalize"
  | "upload_replay"
  | "replacement_finalize"
  | "replacement_replay"
  | "editor_retry"
  | "processor_chain"
  | "admin_smoke";

function googleJobTriggerConfig(env: Bindings): GoogleJobTriggerConfig {
  return {
    workloadIdentityProvider: env.GCP_WORKLOAD_IDENTITY_PROVIDER ?? "",
    projectId: env.GCP_PROJECT_ID ?? "",
    region: env.GCP_REGION ?? "",
    jobName: env.GCP_JOB_NAME ?? "",
  };
}

function boundedDispatchErrorCode(error: unknown): string {
  if (error instanceof GoogleJobTriggerError) return error.code;
  return "google_trigger_unavailable";
}

function executionContextFrom(context: any): { waitUntil(promise: Promise<unknown>): void } | null {
  try {
    const executionContext = context.executionCtx;
    return executionContext && typeof executionContext.waitUntil === "function"
      ? executionContext
      : null;
  } catch {
    return null;
  }
}

async function scheduleAudioProcessorRun(
  context: any,
  jobId: string,
  triggerSource: AudioDispatchSource,
  requestedBy: string,
): Promise<void> {
  if (context.env.AUTH_MODE === "local") return;

  const dispatchId = crypto.randomUUID();
  const requestedAt = new Date().toISOString();
  try {
    const inserted = await context.env.DB.prepare(`
      INSERT INTO audio_processing_dispatch_attempts (
        id, job_id, trigger_source, status, requested_at, requested_by
      )
      SELECT ?, id, ?, 'started', ?, ?
      FROM audio_processing_jobs
      WHERE id = ? AND status = 'pending'
    `).bind(
      dispatchId, triggerSource, requestedAt, requestedBy, jobId,
    ).run();
    if (inserted.meta.changes !== 1) return;
  } catch {
    console.error("Audio processor dispatch checkpoint failed", { dispatchId });
    return;
  }

  const config = googleJobTriggerConfig(context.env);
  const accessJwt = context.req.header("Cf-Access-Jwt-Assertion") ?? "";
  const dispatch = (async () => {
    let status: "accepted" | "failed" = "accepted";
    let errorCode: string | null = null;
    try {
      if (!accessJwt) throw new GoogleJobTriggerError("google_trigger_not_configured");
      if (!validGoogleJobTriggerConfig(config)) {
        throw new GoogleJobTriggerError("google_trigger_not_configured");
      }
      await triggerGoogleCloudRunJob(config, accessJwt);
    } catch (error) {
      status = "failed";
      errorCode = boundedDispatchErrorCode(error);
      console.error("Audio processor dispatch failed", { dispatchId, errorCode });
    }

    const completedAt = new Date().toISOString();
    try {
      await context.env.DB.prepare(`
        UPDATE audio_processing_dispatch_attempts
        SET status = ?, completed_at = ?, error_code = ?
        WHERE id = ? AND status = 'started'
      `).bind(status, completedAt, errorCode, dispatchId).run();
    } catch {
      console.error("Audio processor dispatch result checkpoint failed", { dispatchId });
    }
  })();

  const executionContext = executionContextFrom(context);
  if (executionContext) executionContext.waitUntil(dispatch);
  else await dispatch;
}

async function triggerNextPendingJob(context: any): Promise<void> {
  try {
    const pending = await context.env.DB.prepare(`
      SELECT id FROM audio_processing_jobs
      WHERE status = 'pending'
      ORDER BY created_at, id
      LIMIT 1
    `).first() as { id: string } | null;
    if (pending) {
      await scheduleAudioProcessorRun(context, pending.id, "processor_chain", "audio-processor");
    }
  } catch {
    console.error("Pending audio processor dispatch check failed");
  }
}

async function audioProcessorAuthorization(
  authorization: string | undefined,
  configuredToken: string | undefined,
): Promise<"authorized" | "unauthorized" | "unconfigured"> {
  if (!configuredToken || configuredToken.length < 32) return "unconfigured";
  return await processorTokenMatches(parseBearerToken(authorization), configuredToken)
    ? "authorized"
    : "unauthorized";
}

async function audioProcessingLeaseMatches(
  job: AudioProcessingJobRow,
  capabilityToken: string | null,
  operation: AudioProcessingCapabilityOperation,
  processorToken: string | undefined,
  now: string,
): Promise<boolean> {
  const leaseToken = await verifyAudioProcessingCapabilityToken(
    capabilityToken, job.id, job.attemptCount, operation, processorToken,
  );
  if (
    !leaseToken
    || job.status !== "running"
    || job.policyId !== AUDIO_PROCESSING_POLICY_ID
    || job.recordingProcessingState !== "processing"
    || job.recordingTrashedAt !== null
    || job.sourceMediaState !== "active"
    || !job.leaseTokenHash
    || !job.leaseExpiresAt
    || job.leaseExpiresAt <= now
  ) return false;
  return await hashAudioProcessingToken(leaseToken) === job.leaseTokenHash;
}

type StoredAudioVerification =
  | { status: "verified" }
  | { status: "missing" }
  | { status: "mismatch" }
  | { status: "unavailable" };

async function verifyStoredAudioObject(
  bucket: R2Bucket,
  objectKey: string,
  expectedSha256: string,
  expectedByteSize: number,
): Promise<StoredAudioVerification> {
  let object: R2ObjectBody | null;
  try {
    object = await bucket.get(objectKey);
  } catch {
    return { status: "unavailable" };
  }
  if (!object) return { status: "missing" };
  if (object.size !== expectedByteSize) return { status: "mismatch" };
  try {
    const fingerprint = await sha256RecordingStream(object.body);
    return fingerprint.byteSize === expectedByteSize && fingerprint.sha256 === expectedSha256
      ? { status: "verified" }
      : { status: "mismatch" };
  } catch {
    return { status: "unavailable" };
  }
}

function succeededAudioProcessingJobMatches(
  job: AudioProcessingJobRow,
  result: VerifiedHostedResult,
): boolean {
  if (
    job.status !== "succeeded"
    || !hostedResultMatchesAudioProcessingJob(result, job)
    || job.playbackKind !== result.playbackKind
  ) return false;
  if (result.playbackKind === "original") {
    return job.derivativeMediaId === null
      && result.derivativeSha256 === null
      && result.derivativeByteSize === null;
  }
  return job.derivativeMediaId !== null
    && job.derivativeSha256 === result.derivativeSha256
    && job.derivativeByteSize === result.derivativeByteSize;
}

async function failAudioProcessingJob(
  database: D1Database,
  job: AudioProcessingJobRow,
  leaseTokenHash: string,
  errorCode: string,
): Promise<boolean> {
  const timestamp = new Date().toISOString();
  const results = await database.batch([
    database.prepare(`
      UPDATE recordings
      SET processing_state = 'failed', processing_error = ?,
          revision = revision + 1, updated_at = ?, updated_by = 'audio-processor'
      WHERE id = ? AND processing_state = 'processing'
        AND processing_error IS NULL AND trashed_at IS NULL
        AND EXISTS (
          SELECT 1 FROM audio_processing_jobs
          WHERE id = ? AND recording_id = recordings.id
            AND status = 'running' AND attempt_count = ?
            AND lease_token_hash = ?
        )
    `).bind(
      errorCode, timestamp, job.recordingId,
      job.id, job.attemptCount, leaseTokenHash,
    ),
    database.prepare(`
      UPDATE songs
      SET updated_at = ?, updated_by = 'audio-processor'
      WHERE id = ? AND trashed_at IS NULL
        AND EXISTS (
          SELECT 1 FROM recordings
          WHERE id = ? AND song_id = songs.id
            AND processing_state = 'failed' AND processing_error = ?
            AND trashed_at IS NULL
        )
    `).bind(timestamp, job.songId, job.recordingId, errorCode),
    database.prepare(`
      UPDATE audio_processing_jobs
      SET status = 'failed', lease_token_hash = NULL, lease_expires_at = NULL,
          error_code = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND attempt_count = ?
        AND lease_token_hash = ?
    `).bind(errorCode, timestamp, job.id, job.attemptCount, leaseTokenHash),
  ]);
  return results[2].meta.changes === 1;
}

async function provisionRecordingMultipartUpload(
  database: D1Database,
  media: R2Bucket,
  session: RecordingUploadSessionRow,
  actor: string,
): Promise<RecordingUploadSessionRow> {
  const multipart = await media.createMultipartUpload(session.objectKey);
  let result: D1Result;
  try {
    const timestamp = new Date().toISOString();
    result = await database.prepare(`
      UPDATE recording_upload_sessions
      SET r2_upload_id = ?, status = 'open', revision = revision + 1,
          updated_at = ?, updated_by = ?
      WHERE id = ? AND created_by = ? AND request_fingerprint = ?
        AND status = 'creating' AND revision = ?
    `).bind(
      multipart.uploadId, timestamp, actor,
      session.id, actor, session.requestFingerprint, session.revision,
    ).run();
  } catch (error) {
    await multipart.abort().catch(() => undefined);
    throw error;
  }
  if (result.meta.changes === 0) {
    await multipart.abort().catch(() => undefined);
    const current = await loadRecordingUploadSession(database, session.id, actor);
    if (!current) throw new Error("recording_upload_session_lost");
    return current;
  }
  const current = await loadRecordingUploadSession(database, session.id, actor);
  if (!current) throw new Error("recording_upload_session_lost");
  return current;
}

function lookupWriteError(error: unknown): { error: string; status: 400 | 409 | 500 } {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE constraint failed") || message.includes("normalized_name_idx")) {
    return { error: "duplicate_lookup_name", status: 409 };
  }
  if (message.includes("invalid_language_name")
    || message.includes("invalid_tag_name")
    || message.includes("invalid_notebook_name")
    || message.includes("CHECK constraint")) {
    return { error: "invalid_lookup", status: 400 };
  }
  return { error: "lookup_write_failed", status: 500 };
}

async function loadLyricState(
  database: D1Database,
  songId: string,
  lyricId: string,
): Promise<LyricStateRow | null> {
  return database.prepare(`
    SELECT
      lyric_texts.revision,
      lyric_texts.trashed_at AS trashedAt,
      songs.trashed_at AS songTrashedAt
    FROM lyric_texts
    JOIN songs ON songs.id = lyric_texts.song_id
    WHERE lyric_texts.id = ? AND lyric_texts.song_id = ?
  `).bind(lyricId, songId).first<LyricStateRow>();
}

async function loadLyricCreateReplay(
  database: D1Database,
  lyricId: string,
): Promise<LyricCreateReplayRow | null> {
  return database.prepare(`
    SELECT
      song_id AS songId,
      content,
      origin,
      revision,
      created_by AS createdBy,
      trashed_at AS trashedAt
    FROM lyric_texts
    WHERE id = ?
  `).bind(lyricId).first<LyricCreateReplayRow>();
}

function lyricCreateReplayMatches(
  row: LyricCreateReplayRow | null,
  songId: string,
  content: string,
  actor: string,
): boolean {
  return row?.songId === songId
    && row.content === content
    && row.origin === "user"
    && row.revision === 1
    && row.createdBy === actor
    && row.trashedAt === null;
}

async function loadSongState(database: D1Database, songId: string): Promise<SongStateRow | null> {
  return database.prepare(`
    SELECT revision, trashed_at AS trashedAt
    FROM songs
    WHERE id = ?
  `).bind(songId).first<SongStateRow>();
}

async function loadSongDependencies(database: D1Database, songId: string): Promise<SongDependencies> {
  const result = await database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM lyric_texts WHERE song_id = ? AND trashed_at IS NULL) AS lyricTexts,
      (SELECT COUNT(*) FROM scans WHERE song_id = ? AND trashed_at IS NULL) AS scans,
      (SELECT COUNT(*) FROM recordings WHERE song_id = ? AND trashed_at IS NULL) AS recordings
  `).bind(songId, songId, songId).first<SongDependencies>();
  return result ?? { lyricTexts: 0, scans: 0, recordings: 0 };
}

function hasSongDependencies(dependencies: SongDependencies): boolean {
  return dependencies.lyricTexts > 0 || dependencies.scans > 0 || dependencies.recordings > 0;
}

async function loadScanState(
  database: D1Database,
  songId: string,
  scanId: string,
): Promise<ScanStateRow | null> {
  return database.prepare(`
    SELECT
      scans.revision,
      scans.rotation_quarter_turns AS rotationQuarterTurns,
      scans.trashed_at AS trashedAt,
      songs.trashed_at AS songTrashedAt,
      media_objects.state AS mediaState
    FROM scans
    JOIN songs ON songs.id = scans.song_id
    JOIN media_objects ON media_objects.id = scans.media_id
    WHERE scans.id = ? AND scans.song_id = ?
  `).bind(scanId, songId).first<ScanStateRow>();
}

async function loadRecordingState(
  database: D1Database,
  songId: string,
  recordingId: string,
): Promise<RecordingStateRow | null> {
  return database.prepare(`
    SELECT
      recordings.revision,
      recordings.trashed_at AS trashedAt,
      songs.trashed_at AS songTrashedAt,
      original_media.state AS originalMediaState,
      playback_media.state AS playbackMediaState
    FROM recordings
    JOIN songs ON songs.id = recordings.song_id
    JOIN media_objects AS original_media ON original_media.id = recordings.original_media_id
    LEFT JOIN media_objects AS playback_media ON playback_media.id = recordings.playback_media_id
    WHERE recordings.id = ? AND recordings.song_id = ?
  `).bind(recordingId, songId).first<RecordingStateRow>();
}

function languageStatementsForUpdate(
  database: D1Database,
  songId: string,
  mutationId: string,
  languageIds: string[],
): D1PreparedStatement[] {
  const statements = languageIds.map((languageId, sortOrder) => database.prepare(`
    INSERT OR IGNORE INTO song_languages (song_id, language_id, sort_order)
    SELECT ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM songs WHERE id = ? AND last_mutation_id = ?
    )
  `).bind(songId, languageId, sortOrder, songId, mutationId));
  const placeholders = languageIds.map(() => "?").join(", ");
  statements.push(database.prepare(`
    DELETE FROM song_languages
    WHERE song_id = ?
      AND language_id NOT IN (${placeholders})
      AND EXISTS (
        SELECT 1 FROM songs WHERE id = ? AND last_mutation_id = ?
      )
  `).bind(songId, ...languageIds, songId, mutationId));
  return statements;
}

function replaceJoinStatements(
  database: D1Database,
  table: "song_tags" | "song_aliases",
  songId: string,
  mutationId: string,
  song: SongWriteInput,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [database.prepare(`
    DELETE FROM ${table}
    WHERE song_id = ?
      AND EXISTS (
        SELECT 1 FROM songs WHERE id = ? AND last_mutation_id = ?
      )
  `).bind(songId, songId, mutationId)];

  if (table === "song_tags") {
    for (const [sortOrder, tagId] of song.tagIds.entries()) {
      statements.push(database.prepare(`
        INSERT INTO song_tags (song_id, tag_id, sort_order)
        SELECT ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM songs WHERE id = ? AND last_mutation_id = ?
        )
      `).bind(songId, tagId, sortOrder, songId, mutationId));
    }
  } else {
    for (const [sortOrder, alias] of song.aliases.entries()) {
      statements.push(database.prepare(`
        INSERT INTO song_aliases (id, song_id, alias, normalized_alias, sort_order)
        SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM songs WHERE id = ? AND last_mutation_id = ?
        )
      `).bind(
        crypto.randomUUID(), songId, alias.value, alias.normalizedValue, sortOrder,
        songId, mutationId,
      ));
    }
  }
  return statements;
}

function creditStatementsForUpdate(
  database: D1Database,
  songId: string,
  mutationId: string,
  song: SongWriteInput,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [database.prepare(`
    DELETE FROM song_credits
    WHERE song_id = ?
      AND EXISTS (
        SELECT 1 FROM songs WHERE id = ? AND last_mutation_id = ?
      )
  `).bind(songId, songId, mutationId)];
  for (const [sortOrder, credit] of song.credits.entries()) {
    statements.push(database.prepare(`
      INSERT INTO song_credits (id, song_id, person_id, role, sort_order)
      SELECT ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM songs WHERE id = ? AND last_mutation_id = ?
      )
    `).bind(
      crypto.randomUUID(), songId, credit.personId, credit.role, sortOrder,
      songId, mutationId,
    ));
  }
  return statements;
}

export function parseByteRange(value: string, size: number): { offset: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size < 1) return null;

  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }

  const offset = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(requestedEnd)
    || offset < 0
    || offset >= size
    || requestedEnd < offset
  ) return null;

  const end = Math.min(requestedEnd, size - 1);
  return { offset, length: end - offset + 1 };
}

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function browserMutationRequestError(
  request: Request,
  authMode: Bindings["AUTH_MODE"],
): "cross_site_request_rejected" | "unsupported_media_type" | null {
  if (!MUTATION_METHODS.has(request.method.toUpperCase())) return null;
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/processing/")) return null;

  if (authMode === "access") {
    if (request.headers.get("Origin") !== url.origin) return "cross_site_request_rejected";
    const fetchSite = request.headers.get("Sec-Fetch-Site");
    if (fetchSite && fetchSite !== "same-origin") return "cross_site_request_rejected";
  }

  if (request.method === "POST" && url.pathname === "/api/logout") return null;
  const mediaType = (request.headers.get("Content-Type") ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  if (
    request.method === "PUT"
    && /^\/api\/recording-uploads\/[^/]+\/parts\/[^/]+$/u.test(url.pathname)
  ) {
    return mediaType === "application/octet-stream" ? null : "unsupported_media_type";
  }
  if (
    request.method === "POST"
    && (
      /^\/api\/songs\/[^/]+\/scans$/u.test(url.pathname)
      || /^\/api\/songs\/[^/]+\/scans\/[^/]+\/media$/u.test(url.pathname)
    )
  ) {
    return mediaType === "multipart/form-data" ? null : "unsupported_media_type";
  }
  return mediaType === "application/json" ? null : "unsupported_media_type";
}

export const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use("/api/*", async (context, next) => {
  await next();
  context.header("X-Content-Type-Options", "nosniff");
  context.header("Referrer-Policy", "no-referrer");
  context.header("X-Frame-Options", "DENY");
  context.header("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  context.header("Cross-Origin-Resource-Policy", "same-origin");
  const contentType = context.res.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    context.header("Cache-Control", "private, no-store");
  }
});

app.use("/api/*", async (context, next) => {
  if (context.req.path.startsWith("/api/processing/")) {
    await next();
    return;
  }
  if (context.env.AUTH_MODE === "local") {
    context.set("accessIdentity", { email: "local@example.invalid", subject: "local-development" });
    context.set("appUser", {
      identity: "local@example.invalid",
      displayName: "Local developer",
      role: context.env.LOCAL_ROLE ?? "admin",
    });
    await next();
    return;
  }

  if (
    context.env.AUTH_MODE !== "access"
    || !context.env.ACCESS_AUD
    || !context.env.ACCESS_ISSUER
    || !context.env.ACCESS_JWKS_URL
  ) {
    return context.json({ error: "authentication_not_configured" }, 503);
  }

  const token = context.req.header("Cf-Access-Jwt-Assertion");
  if (!token) {
    return context.json({ error: "authentication_required" }, 401);
  }

  let verifiedIdentity: { email: string; subject: string };
  try {
    const decoded = decode(token);
    if (typeof decoded.header.kid !== "string" || decoded.header.kid.length === 0) {
      return context.json({ error: "invalid_access_token" }, 401);
    }
    const keys = await loadAccessJwks(context.env.ACCESS_JWKS_URL, decoded.header.kid);
    const payload = await verifyWithJwks(token, {
      keys,
      allowedAlgorithms: ["RS256"],
      verification: {
        aud: context.env.ACCESS_AUD,
        iss: context.env.ACCESS_ISSUER,
      },
    });

    if (typeof payload.email !== "string" || typeof payload.sub !== "string") {
      return context.json({ error: "invalid_identity" }, 401);
    }

    verifiedIdentity = { email: payload.email, subject: payload.sub };
  } catch {
    return context.json({ error: "invalid_access_token" }, 401);
  }

  context.set("accessIdentity", verifiedIdentity);
  try {
    const user = await resolveActiveAppUser(context.env.DB, verifiedIdentity.email);

    if (!user) {
      return context.json({ error: "access_not_authorized" }, 403);
    }
    context.set("appUser", user);
  } catch {
    return context.json({ error: "authorization_unavailable" }, 503);
  }

  await next();
});

app.use("/api/*", async (context, next) => {
  const error = browserMutationRequestError(context.req.raw, context.env.AUTH_MODE);
  if (error) return context.json({ error }, error === "unsupported_media_type" ? 415 : 403);
  await next();
});

app.post("/api/processing/jobs/claim", async (context) => {
  const authorization = await audioProcessorAuthorization(
    context.req.header("Authorization"), context.env.AUDIO_PROCESSOR_TOKEN,
  );
  if (authorization === "unconfigured") {
    return context.json({ error: "audio_processor_not_configured" }, 503);
  }
  if (authorization !== "authorized") {
    return context.json({ error: "audio_processor_authentication_required" }, 401);
  }
  const transferOrigin = normalizeProcessorTransferOrigin(
    context.env.AUDIO_PROCESSOR_TRANSFER_ORIGIN,
  );
  if (!transferOrigin) {
    return context.json({ error: "audio_processor_transfer_origin_not_configured" }, 503);
  }

  const timestamp = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + AUDIO_PROCESSING_LEASE_MS).toISOString();
  const leaseToken = createAudioProcessingLeaseToken();
  const leaseTokenHash = await hashAudioProcessingToken(leaseToken);
  let claimed = false;
  try {
    const results = await context.env.DB.batch([
      context.env.DB.prepare(`
        UPDATE recordings
        SET processing_state = 'failed', processing_error = 'processing_lease_expired',
            revision = revision + 1, updated_at = ?, updated_by = 'audio-processor'
        WHERE processing_state = 'processing' AND processing_error IS NULL
          AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM audio_processing_jobs
            JOIN media_objects
              ON media_objects.id = audio_processing_jobs.source_media_id
            WHERE audio_processing_jobs.recording_id = recordings.id
              AND audio_processing_jobs.status = 'running'
              AND audio_processing_jobs.attempt_count >= ?
              AND audio_processing_jobs.lease_expires_at <= ?
              AND recordings.original_media_id = audio_processing_jobs.source_media_id
              AND media_objects.kind = 'original_audio'
              AND media_objects.state = 'active'
              AND media_objects.sha256 = audio_processing_jobs.source_sha256
              AND media_objects.byte_size = audio_processing_jobs.source_byte_size
          )
      `).bind(timestamp, MAX_EXPIRED_AUDIO_PROCESSING_ATTEMPTS, timestamp),
      context.env.DB.prepare(`
        UPDATE songs
        SET updated_at = ?, updated_by = 'audio-processor'
        WHERE trashed_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM recordings
            JOIN audio_processing_jobs
              ON audio_processing_jobs.recording_id = recordings.id
            WHERE recordings.song_id = songs.id
              AND recordings.processing_state = 'failed'
              AND recordings.processing_error = 'processing_lease_expired'
              AND recordings.updated_at = ?
              AND audio_processing_jobs.status = 'running'
              AND audio_processing_jobs.attempt_count >= ?
              AND audio_processing_jobs.lease_expires_at <= ?
          )
      `).bind(
        timestamp, timestamp, MAX_EXPIRED_AUDIO_PROCESSING_ATTEMPTS, timestamp,
      ),
      context.env.DB.prepare(`
        UPDATE audio_processing_jobs
        SET status = 'failed', lease_token_hash = NULL, lease_expires_at = NULL,
            error_code = 'processing_lease_expired', updated_at = ?
        WHERE status = 'running' AND attempt_count >= ? AND lease_expires_at <= ?
          AND EXISTS (
            SELECT 1 FROM recordings
            WHERE recordings.id = audio_processing_jobs.recording_id
              AND recordings.processing_state = 'failed'
              AND recordings.processing_error = 'processing_lease_expired'
              AND recordings.trashed_at IS NULL
          )
      `).bind(timestamp, MAX_EXPIRED_AUDIO_PROCESSING_ATTEMPTS, timestamp),
      context.env.DB.prepare(`
        UPDATE audio_processing_jobs
        SET status = 'pending', lease_token_hash = NULL, lease_expires_at = NULL,
            updated_at = ?
        WHERE status = 'running' AND lease_expires_at <= ?
          AND attempt_count < ?
          AND EXISTS (
            SELECT 1
            FROM recordings
            JOIN media_objects ON media_objects.id = recordings.original_media_id
            WHERE recordings.id = audio_processing_jobs.recording_id
              AND recordings.trashed_at IS NULL
              AND recordings.processing_state = 'processing'
              AND recordings.processing_error IS NULL
              AND media_objects.id = audio_processing_jobs.source_media_id
              AND media_objects.kind = 'original_audio'
              AND media_objects.state = 'active'
              AND media_objects.sha256 = audio_processing_jobs.source_sha256
              AND media_objects.byte_size = audio_processing_jobs.source_byte_size
          )
      `).bind(timestamp, timestamp, MAX_EXPIRED_AUDIO_PROCESSING_ATTEMPTS),
      context.env.DB.prepare(`
        UPDATE audio_processing_jobs
        SET status = 'running', attempt_count = attempt_count + 1,
            lease_token_hash = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = (
          SELECT audio_processing_jobs.id
          FROM audio_processing_jobs
          JOIN recordings ON recordings.id = audio_processing_jobs.recording_id
          JOIN media_objects ON media_objects.id = audio_processing_jobs.source_media_id
          WHERE audio_processing_jobs.status = 'pending'
            AND audio_processing_jobs.policy_id = ?
            AND audio_processing_jobs.source_byte_size <= ?
            AND recordings.trashed_at IS NULL
            AND recordings.processing_state = 'processing'
            AND recordings.processing_error IS NULL
            AND recordings.original_media_id = audio_processing_jobs.source_media_id
            AND media_objects.kind = 'original_audio'
            AND media_objects.state = 'active'
            AND media_objects.sha256 = audio_processing_jobs.source_sha256
            AND media_objects.byte_size = audio_processing_jobs.source_byte_size
            AND NOT EXISTS (
              SELECT 1
              FROM audio_processing_jobs AS running_job
              WHERE running_job.status = 'running'
                AND running_job.lease_expires_at > ?
            )
          ORDER BY audio_processing_jobs.created_at, audio_processing_jobs.id
          LIMIT 1
        ) AND status = 'pending'
      `).bind(
        leaseTokenHash, leaseExpiresAt, timestamp,
        AUDIO_PROCESSING_POLICY_ID, MAX_AUDIO_DERIVATIVE_BYTES, timestamp,
      ),
    ]);
    claimed = results[4].meta.changes === 1;
  } catch {
    return context.json({ error: "audio_processing_claim_failed" }, 503);
  }
  if (!claimed) return new Response(null, { status: 204 });

  const claimedId = await context.env.DB.prepare(`
    SELECT id FROM audio_processing_jobs
    WHERE status = 'running' AND lease_token_hash = ? AND lease_expires_at = ?
  `).bind(leaseTokenHash, leaseExpiresAt).first<{ id: string }>();
  if (!claimedId) return context.json({ error: "audio_processing_claim_incomplete" }, 503);
  const job = await loadAudioProcessingJob(context.env.DB, claimedId.id);
  if (!job || job.policyId !== AUDIO_PROCESSING_POLICY_ID) {
    return context.json({ error: "audio_processing_claim_incomplete" }, 503);
  }
  const derivativeObjectKey = audioProcessingDerivativeObjectKey(job.id, job.attemptCount);
  if (!derivativeObjectKey) {
    return context.json({ error: "audio_processing_claim_invalid" }, 500);
  }
  const [sourceCapability, derivativeCapability, resultCapability, failureCapability] =
    await Promise.all([
      createAudioProcessingCapabilityToken(
        leaseToken, job.id, job.attemptCount, "source", context.env.AUDIO_PROCESSOR_TOKEN!,
      ),
      createAudioProcessingCapabilityToken(
        leaseToken, job.id, job.attemptCount, "derivative", context.env.AUDIO_PROCESSOR_TOKEN!,
      ),
      createAudioProcessingCapabilityToken(
        leaseToken, job.id, job.attemptCount, "result", context.env.AUDIO_PROCESSOR_TOKEN!,
      ),
      createAudioProcessingCapabilityToken(
        leaseToken, job.id, job.attemptCount, "failure", context.env.AUDIO_PROCESSOR_TOKEN!,
      ),
    ]);

  context.header("Cache-Control", "private, no-store");
  context.header("Referrer-Policy", "no-referrer");
  return context.json({
    schemaVersion: 2,
    leaseExpiresAt,
    processingRequest: {
      schemaVersion: 2,
      jobId: job.id,
      policyId: job.policyId,
      sourceSha256: job.sourceSha256,
      sourceByteSize: job.sourceByteSize,
      sourceDownloadUrl: buildAudioProcessingCapabilityUrl(
        transferOrigin, job.id, "source",
      ),
      sourceCapability,
      derivativeUploadUrl: buildAudioProcessingCapabilityUrl(
        transferOrigin, job.id, "derivative",
      ),
      derivativeCapability,
    },
    resultUrl: buildAudioProcessingCapabilityUrl(
      transferOrigin, job.id, "result",
    ),
    resultCapability,
    failureUrl: buildAudioProcessingCapabilityUrl(
      transferOrigin, job.id, "failure",
    ),
    failureCapability,
  });
});

app.get("/api/processing/jobs/:jobId/source", async (context) => {
  const job = await loadAudioProcessingJob(context.env.DB, context.req.param("jobId"));
  const now = new Date().toISOString();
  if (!job || !await audioProcessingLeaseMatches(
    job, context.req.header(AUDIO_PROCESSING_CAPABILITY_HEADER) ?? null, "source",
    context.env.AUDIO_PROCESSOR_TOKEN, now,
  )) {
    return context.json({ error: "audio_processing_capability_invalid" }, 401);
  }
  let object: R2ObjectBody | null;
  try {
    object = await context.env.MEDIA.get(job.sourceObjectKey);
  } catch {
    return context.json({ error: "audio_processing_storage_unavailable" }, 503);
  }
  if (!object || object.size !== job.sourceByteSize) {
    return context.json({ error: "audio_processing_source_unavailable" }, 503);
  }
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Length": String(object.size),
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  return new Response(object.body, { headers });
});

app.put("/api/processing/jobs/:jobId/derivative", async (context) => {
  const job = await loadAudioProcessingJob(context.env.DB, context.req.param("jobId"));
  const now = new Date().toISOString();
  if (!job || !await audioProcessingLeaseMatches(
    job, context.req.header(AUDIO_PROCESSING_CAPABILITY_HEADER) ?? null, "derivative",
    context.env.AUDIO_PROCESSOR_TOKEN, now,
  )) {
    return context.json({ error: "audio_processing_capability_invalid" }, 401);
  }
  const contentLengthValue = context.req.header("Content-Length") ?? "";
  if (!/^\d+$/u.test(contentLengthValue)) {
    return context.json({ error: "audio_processing_derivative_length_required" }, 411);
  }
  const contentLength = Number(contentLengthValue);
  if (
    !Number.isSafeInteger(contentLength)
    || contentLength < 1
    || contentLength > MAX_AUDIO_DERIVATIVE_BYTES
  ) {
    return context.json({ error: "audio_processing_derivative_too_large" }, 413);
  }
  if (!context.req.raw.body) {
    return context.json({ error: "audio_processing_derivative_required" }, 400);
  }
  const objectKey = audioProcessingDerivativeObjectKey(job.id, job.attemptCount);
  if (!objectKey) return context.json({ error: "audio_processing_job_invalid" }, 500);

  let stored: R2Object | null;
  try {
    stored = await context.env.MEDIA.put(objectKey, context.req.raw.body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "audio/mpeg" },
    });
  } catch {
    return context.json({ error: "audio_processing_storage_unavailable" }, 503);
  }
  if (!stored) {
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
    });
  }
  if (stored.size !== contentLength) {
    return context.json({ error: "audio_processing_derivative_store_mismatch" }, 500);
  }
  return new Response(null, {
    status: 201,
    headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
  });
});

app.post("/api/processing/jobs/:jobId/result", async (context) => {
  const authorization = await audioProcessorAuthorization(
    context.req.header("Authorization"), context.env.AUDIO_PROCESSOR_TOKEN,
  );
  if (authorization === "unconfigured") {
    return context.json({ error: "audio_processor_not_configured" }, 503);
  }
  if (authorization !== "authorized") {
    return context.json({ error: "audio_processor_authentication_required" }, 401);
  }
  context.header("Cache-Control", "private, no-store");
  context.header("Referrer-Policy", "no-referrer");
  const contentLengthValue = context.req.header("Content-Length") ?? "";
  if (!/^\d+$/u.test(contentLengthValue)) {
    return context.json({ error: "audio_processing_result_length_required" }, 411);
  }
  const contentLength = Number(contentLengthValue);
  if (
    !Number.isSafeInteger(contentLength)
    || contentLength < 1
    || contentLength > MAX_AUDIO_PROCESSING_RESULT_BYTES
  ) {
    return context.json({ error: "audio_processing_result_too_large" }, 413);
  }
  let body: unknown;
  try {
    const text = await context.req.text();
    if (new TextEncoder().encode(text).byteLength > MAX_AUDIO_PROCESSING_RESULT_BYTES) {
      return context.json({ error: "audio_processing_result_too_large" }, 413);
    }
    body = JSON.parse(text);
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const result = parseVerifiedHostedResult(body);
  const jobId = context.req.param("jobId");
  if (!result || result.jobId !== jobId) {
    return context.json({ error: "invalid_audio_processing_result" }, 400);
  }
  let job = await loadAudioProcessingJob(context.env.DB, jobId);
  if (!job) return context.json({ error: "audio_processing_job_not_found" }, 404);
  if (!hostedResultMatchesAudioProcessingJob(result, job)) {
    return context.json({ error: "audio_processing_result_mismatch" }, 422);
  }
  if (job.status === "succeeded") {
    if (succeededAudioProcessingJobMatches(job, result)) {
      await triggerNextPendingJob(context);
      return context.json({
        job: { id: job.id, status: job.status, playbackKind: job.playbackKind },
      });
    }
    return succeededAudioProcessingJobMatches(job, result)
      ? context.json({ job: { id: job.id, status: job.status, playbackKind: job.playbackKind } })
      : context.json({ error: "audio_processing_result_conflict" }, 409);
  }
  const leaseToken = context.req.header(AUDIO_PROCESSING_CAPABILITY_HEADER) ?? null;
  const now = new Date().toISOString();
  if (!await audioProcessingLeaseMatches(
      job, leaseToken, "result", context.env.AUDIO_PROCESSOR_TOKEN, now,
  ) || !job.leaseTokenHash) {
    return context.json({ error: "audio_processing_lease_stale" }, 409);
  }
  const leaseTokenHash = job.leaseTokenHash;

  const sourceVerification = await verifyStoredAudioObject(
    context.env.MEDIA, job.sourceObjectKey, job.sourceSha256, job.sourceByteSize,
  );
  if (sourceVerification.status === "missing" || sourceVerification.status === "unavailable") {
    return context.json({ error: "audio_processing_source_unavailable" }, 503);
  }
  if (sourceVerification.status === "mismatch") {
    try {
      const failed = await failAudioProcessingJob(
        context.env.DB, job, leaseTokenHash, "source_verification_failed",
      );
      if (!failed) {
        return context.json({ error: "audio_processing_result_conflict" }, 409);
      }
    } catch {
      return context.json({ error: "audio_processing_failure_checkpoint_failed" }, 503);
    }
    return context.json({ error: "audio_processing_source_verification_failed" }, 422);
  }

  const timestamp = new Date().toISOString();
  let statements: D1PreparedStatement[];
  let finalStatementIndex: number;
  if (result.playbackKind === "original") {
    statements = [
      context.env.DB.prepare(`
        UPDATE media_objects
        SET mime_type = 'audio/mpeg'
        WHERE id = ? AND object_key = ? AND kind = 'original_audio'
          AND state = 'active' AND sha256 = ? AND byte_size = ?
      `).bind(
        job.sourceMediaId, job.sourceObjectKey, job.sourceSha256, job.sourceByteSize,
      ),
      context.env.DB.prepare(`
        UPDATE recordings
        SET playback_media_id = ?, processing_state = 'ready', processing_error = NULL,
            revision = revision + 1, updated_at = ?, updated_by = 'audio-processor'
        WHERE id = ? AND original_media_id = ? AND processing_state = 'processing'
          AND processing_error IS NULL AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM media_objects
            WHERE id = ? AND kind = 'original_audio' AND state = 'active'
              AND sha256 = ? AND byte_size = ? AND mime_type = 'audio/mpeg'
          )
      `).bind(
        job.sourceMediaId, timestamp, job.recordingId, job.sourceMediaId,
        job.sourceMediaId, job.sourceSha256, job.sourceByteSize,
      ),
      context.env.DB.prepare(`
        UPDATE songs SET updated_at = ?, updated_by = 'audio-processor'
        WHERE id = ? AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM recordings
            WHERE id = ? AND song_id = songs.id AND processing_state = 'ready'
              AND playback_media_id = ? AND trashed_at IS NULL
          )
      `).bind(timestamp, job.songId, job.recordingId, job.sourceMediaId),
      context.env.DB.prepare(`
        UPDATE audio_processing_jobs
        SET status = CASE
              WHEN status = 'running' AND attempt_count = ? AND lease_token_hash = ?
              THEN 'succeeded' ELSE 'stale_result'
            END,
            lease_token_hash = NULL, lease_expires_at = NULL,
            playback_kind = 'original', derivative_media_id = NULL,
            error_code = NULL, updated_at = ?
        WHERE id = ?
      `).bind(job.attemptCount, leaseTokenHash, timestamp, job.id),
    ];
    finalStatementIndex = 3;
  } else {
    if (
      !result.derivativeSha256
      || !result.derivativeByteSize
      || result.derivativeByteSize > MAX_AUDIO_DERIVATIVE_BYTES
    ) {
      return context.json({ error: "invalid_audio_processing_result" }, 400);
    }
    const derivativeObjectKey = audioProcessingDerivativeObjectKey(job.id, job.attemptCount);
    if (!derivativeObjectKey) return context.json({ error: "audio_processing_job_invalid" }, 500);
    const derivativeVerification = await verifyStoredAudioObject(
      context.env.MEDIA,
      derivativeObjectKey,
      result.derivativeSha256,
      result.derivativeByteSize,
    );
    if (derivativeVerification.status === "missing") {
      return context.json({ error: "audio_processing_derivative_not_available" }, 409);
    }
    if (derivativeVerification.status === "unavailable") {
      return context.json({ error: "audio_processing_storage_unavailable" }, 503);
    }
    if (derivativeVerification.status === "mismatch") {
      try {
        const failed = await failAudioProcessingJob(
          context.env.DB, job, leaseTokenHash, "derivative_verification_failed",
        );
        if (!failed) {
          return context.json({ error: "audio_processing_result_conflict" }, 409);
        }
      } catch {
        return context.json({ error: "audio_processing_failure_checkpoint_failed" }, 503);
      }
      return context.json({ error: "audio_processing_derivative_verification_failed" }, 422);
    }
    const derivativeMediaId = crypto.randomUUID();
    statements = [
      context.env.DB.prepare(`
        INSERT INTO media_objects (
          id, object_key, original_filename, mime_type, byte_size, sha256,
          kind, state, created_at, created_by
        ) VALUES (?, ?, 'playback.mp3', 'audio/mpeg', ?, ?,
                  'playback_audio', 'active', ?, 'audio-processor')
      `).bind(
        derivativeMediaId, derivativeObjectKey,
        result.derivativeByteSize, result.derivativeSha256, timestamp,
      ),
      context.env.DB.prepare(`
        INSERT INTO audio_derivatives (
          playback_media_id, source_media_id, policy_id,
          source_sha256, source_byte_size,
          derivative_sha256, derivative_byte_size
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        derivativeMediaId, job.sourceMediaId, job.policyId,
        job.sourceSha256, job.sourceByteSize,
        result.derivativeSha256, result.derivativeByteSize,
      ),
      context.env.DB.prepare(`
        UPDATE recordings
        SET playback_media_id = ?, processing_state = 'ready', processing_error = NULL,
            revision = revision + 1, updated_at = ?, updated_by = 'audio-processor'
        WHERE id = ? AND original_media_id = ? AND processing_state = 'processing'
          AND processing_error IS NULL AND trashed_at IS NULL
      `).bind(derivativeMediaId, timestamp, job.recordingId, job.sourceMediaId),
      context.env.DB.prepare(`
        UPDATE songs SET updated_at = ?, updated_by = 'audio-processor'
        WHERE id = ? AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM recordings
            WHERE id = ? AND song_id = songs.id AND processing_state = 'ready'
              AND playback_media_id = ? AND trashed_at IS NULL
          )
      `).bind(timestamp, job.songId, job.recordingId, derivativeMediaId),
      context.env.DB.prepare(`
        UPDATE audio_processing_jobs
        SET status = CASE
              WHEN status = 'running' AND attempt_count = ? AND lease_token_hash = ?
              THEN 'succeeded' ELSE 'stale_result'
            END,
            lease_token_hash = NULL, lease_expires_at = NULL,
            playback_kind = 'derivative', derivative_media_id = ?,
            error_code = NULL, updated_at = ?
        WHERE id = ?
      `).bind(
        job.attemptCount, leaseTokenHash, derivativeMediaId, timestamp, job.id,
      ),
    ];
    finalStatementIndex = 4;
  }

  try {
    const results = await context.env.DB.batch(statements);
    if (results[finalStatementIndex].meta.changes !== 1) {
      return context.json({ error: "audio_processing_result_conflict" }, 409);
    }
  } catch {
    job = await loadAudioProcessingJob(context.env.DB, job.id);
    if (job && succeededAudioProcessingJobMatches(job, result)) {
      await triggerNextPendingJob(context);
      return context.json({
        job: { id: job.id, status: job.status, playbackKind: job.playbackKind },
      });
    }
    return context.json({ error: "audio_processing_finalization_failed" }, 500);
  }
  job = await loadAudioProcessingJob(context.env.DB, job.id);
  if (!job || !succeededAudioProcessingJobMatches(job, result)) {
    return context.json({ error: "audio_processing_finalization_incomplete" }, 500);
  }
  await triggerNextPendingJob(context);

  return context.json({
    job: { id: job.id, status: job.status, playbackKind: job.playbackKind },
  });
});

app.post("/api/processing/jobs/:jobId/failure", async (context) => {
  const authorization = await audioProcessorAuthorization(
    context.req.header("Authorization"), context.env.AUDIO_PROCESSOR_TOKEN,
  );
  if (authorization === "unconfigured") {
    return context.json({ error: "audio_processor_not_configured" }, 503);
  }
  if (authorization !== "authorized") {
    return context.json({ error: "audio_processor_authentication_required" }, 401);
  }
  context.header("Cache-Control", "private, no-store");
  context.header("Referrer-Policy", "no-referrer");
  const contentLengthValue = context.req.header("Content-Length") ?? "";
  if (!/^\d+$/u.test(contentLengthValue)) {
    return context.json({ error: "audio_processing_failure_length_required" }, 411);
  }
  const contentLength = Number(contentLengthValue);
  if (
    !Number.isSafeInteger(contentLength)
    || contentLength < 1
    || contentLength > MAX_AUDIO_PROCESSING_RESULT_BYTES
  ) {
    return context.json({ error: "audio_processing_failure_too_large" }, 413);
  }
  let body: unknown;
  try {
    const text = await context.req.text();
    if (new TextEncoder().encode(text).byteLength > MAX_AUDIO_PROCESSING_RESULT_BYTES) {
      return context.json({ error: "audio_processing_failure_too_large" }, 413);
    }
    body = JSON.parse(text);
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const failure = parseAudioProcessingFailure(body);
  if (!failure) return context.json({ error: "invalid_audio_processing_failure" }, 400);
  const job = await loadAudioProcessingJob(context.env.DB, context.req.param("jobId"));
  if (!job) return context.json({ error: "audio_processing_job_not_found" }, 404);
  if (job.status === "failed") {
    if (job.errorCode !== failure.errorCode) {
      return context.json({ error: "audio_processing_failure_conflict" }, 409);
    }
    await triggerNextPendingJob(context);
    return context.json({ job: { id: job.id, status: job.status, errorCode: job.errorCode } });
  }
  const now = new Date().toISOString();
  if (
    !await audioProcessingLeaseMatches(
      job, context.req.header(AUDIO_PROCESSING_CAPABILITY_HEADER) ?? null, "failure",
      context.env.AUDIO_PROCESSOR_TOKEN, now,
    )
    || !job.leaseTokenHash
  ) {
    return context.json({ error: "audio_processing_lease_stale" }, 409);
  }
  try {
    if (!await failAudioProcessingJob(
      context.env.DB, job, job.leaseTokenHash, failure.errorCode,
    )) {
      return context.json({ error: "audio_processing_failure_conflict" }, 409);
    }
  } catch {
    return context.json({ error: "audio_processing_failure_checkpoint_failed" }, 503);
  }
  await triggerNextPendingJob(context);

  return context.json({
    job: { id: job.id, status: "failed", errorCode: failure.errorCode },
  });
});

app.get("/api/health", (context) => {
  return context.json({
    service: "music-library",
    status: "ok",
  });
});

app.get("/api/session", async (context) => {
  const user = context.get("appUser");
  const identity = context.get("accessIdentity");
  return context.json({
    user: {
      email: identity.email,
      role: user.role,
      cacheNamespace: await opaqueCacheNamespace(
        context.env.AUTH_MODE === "access" ? context.env.ACCESS_ISSUER : "local",
        identity.subject,
      ),
    },
  });
});

app.post("/api/logout", (context) => {
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "private, no-store",
      "Clear-Site-Data": '"cache"',
    },
  });
});

app.get("/api/song-editor/options", requireRole("editor"), async (context) => {
  const [languages, tags, people] = await Promise.all([
    context.env.DB.prepare(`
      SELECT id, display_name AS displayName
      FROM languages
      ORDER BY sort_order, display_name COLLATE NOCASE
    `).all<{ id: string; displayName: string }>(),
    context.env.DB.prepare(`
      SELECT id, display_name AS displayName
      FROM tags
      ORDER BY sort_order, display_name COLLATE NOCASE
    `).all<{ id: string; displayName: string }>(),
    context.env.DB.prepare(`
      SELECT id, full_name AS fullName
      FROM people
      ORDER BY full_name COLLATE NOCASE, id
    `).all<{ id: string; fullName: string }>(),
  ]);
  return context.json({
    languages: languages.results,
    tags: tags.results,
    people: people.results,
    statuses: ["draft", "checked"],
  });
});

app.get("/api/scan-editor/options", requireRole("editor"), async (context) => {
  const notebooks = await context.env.DB.prepare(`
    SELECT id, display_name AS displayName
    FROM notebooks
    ORDER BY sort_order, display_name COLLATE NOCASE
  `).all<{ id: string; displayName: string }>();
  return context.json({ notebooks: notebooks.results });
});

app.get("/api/recording-editor/options", requireRole("editor"), async (context) => {
  const people = await context.env.DB.prepare(`
    SELECT id, full_name AS fullName
    FROM people
    ORDER BY full_name COLLATE NOCASE, id
  `).all<{ id: string; fullName: string }>();
  return context.json({ people: people.results });
});

app.post("/api/recordings/:recordingId/retry-processing", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const retry = parseRecordingRevision(body);
  if (!retry.success) return context.json({ error: "invalid_audio_processing_retry" }, 400);
  let job = await loadAudioProcessingJobByRecording(
    context.env.DB, context.req.param("recordingId"),
  );
  if (!job) return context.json({ error: "audio_processing_job_not_found" }, 404);
  if (job.status === "succeeded") {
    return context.json({ error: "audio_processing_already_succeeded" }, 409);
  }
  if (job.status !== "failed") {
    return context.json({ error: "audio_processing_already_active" }, 409);
  }
  if (job.recordingRevision !== retry.data.revision) {
    return context.json({ error: "audio_processing_retry_conflict" }, 409);
  }
  const timestamp = new Date().toISOString();
  const actor = context.get("appUser").identity;
  try {
    const results = await context.env.DB.batch([
      context.env.DB.prepare(`
        UPDATE recordings
        SET processing_state = 'processing', processing_error = NULL,
            revision = revision + 1, updated_at = ?, updated_by = ?
        WHERE id = ? AND processing_state = 'failed' AND processing_error = ?
          AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM audio_processing_jobs
            WHERE id = ? AND recording_id = recordings.id
              AND status = 'failed' AND attempt_count = ?
              AND error_code = recordings.processing_error
          )
      `).bind(
        timestamp, actor, job.recordingId, job.errorCode,
        job.id, job.attemptCount,
      ),
      context.env.DB.prepare(`
        UPDATE songs
        SET updated_at = ?, updated_by = ?
        WHERE id = ? AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM recordings
            WHERE id = ? AND song_id = songs.id
              AND processing_state = 'processing' AND processing_error IS NULL
              AND trashed_at IS NULL
          )
      `).bind(timestamp, actor, job.songId, job.recordingId),
      context.env.DB.prepare(`
        UPDATE audio_processing_jobs
        SET status = 'pending', error_code = NULL, updated_at = ?
        WHERE id = ? AND status = 'failed' AND attempt_count = ?
      `).bind(timestamp, job.id, job.attemptCount),
    ]);
    if (results[2].meta.changes !== 1) {
      return context.json({ error: "audio_processing_retry_conflict" }, 409);
    }
  } catch {
    return context.json({ error: "audio_processing_retry_failed" }, 500);
  }
  job = await loadAudioProcessingJob(context.env.DB, job.id);
  if (!job || job.status !== "pending" || job.recordingProcessingState !== "processing") {
    return context.json({ error: "audio_processing_retry_incomplete" }, 500);
  }
  await scheduleAudioProcessorRun(context, job.id, "editor_retry", actor);
  return context.json({
    job: { status: job.status, attemptCount: job.attemptCount },
    recording: {
      id: job.recordingId,
      revision: job.recordingRevision,
      processingState: job.recordingProcessingState,
    },
  });
});

app.get("/api/songs/:songId/recording-uploads", requireRole("editor"), async (context) => {
  const actor = context.get("appUser").identity;
  const songId = context.req.param("songId");
  const song = await context.env.DB.prepare(`
    SELECT id FROM songs WHERE id = ?
  `).bind(songId).first<{ id: string }>();
  if (!song) return context.json({ error: "song_not_found" }, 404);
  const sessions = await loadRecoverableRecordingUploads(context.env.DB, songId, actor);
  const uploads = await Promise.all(sessions.map(async (session) => {
    const [parts, duplicate] = await Promise.all([
      loadRecordingUploadParts(context.env.DB, session.id),
      loadRecordingUploadDuplicate(context.env.DB, session),
    ]);
    return publicRecordingUploadSession(
      session,
      parts.map((part) => part.partNumber),
      duplicate,
    );
  }));
  return context.json({ uploads });
});

app.post("/api/songs/:songId/recording-uploads", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseRecordingUploadCreate(body);
  if (!parsed.success) {
    return context.json({ error: "invalid_recording_upload", fields: parsed.fields }, 400);
  }
  const upload: RecordingUploadCreateInput = parsed.data;
  const songId = context.req.param("songId");
  const actor = context.get("appUser").identity;
  const [song, peopleExist, replacementTarget] = await Promise.all([
    context.env.DB.prepare(`
      SELECT id FROM songs WHERE id = ? AND trashed_at IS NULL
    `).bind(songId).first<{ id: string }>(),
    lookupIdsExist(context.env.DB, "people", upload.creditPersonIds),
    upload.replaceTarget
      ? context.env.DB.prepare(`
          SELECT
            recordings.id,
            recordings.revision,
            recordings.processing_state AS processingState,
            EXISTS (
              SELECT 1 FROM audio_processing_jobs
              WHERE recording_id = recordings.id AND status IN ('pending', 'running')
            ) AS hasActiveJob
          FROM recordings
          WHERE recordings.id = ? AND recordings.song_id = ?
            AND recordings.trashed_at IS NULL
        `).bind(upload.replaceTarget.recordingId, songId).first<{
          id: string;
          revision: number;
          processingState: "processing" | "ready" | "failed";
          hasActiveJob: number;
        }>()
      : Promise.resolve(null),
  ]);
  if (!song) return context.json({ error: "song_not_found" }, 404);
  if (!peopleExist) return context.json({ error: "invalid_recording_reference" }, 400);
  if (upload.replaceTarget) {
    if (!replacementTarget) return context.json({ error: "recording_not_found" }, 404);
    if (
      replacementTarget.revision !== upload.replaceTarget.revision
      || replacementTarget.processingState === "processing"
      || replacementTarget.hasActiveJob === 1
    ) {
      return context.json({ error: "recording_processing_active" }, 409);
    }
  }

  const fingerprint = await recordingUploadRequestFingerprint(songId, upload);
  let session = await loadRecordingUploadByMutation(
    context.env.DB, actor, upload.clientMutationId,
  );
  let created = false;
  if (session && session.requestFingerprint !== fingerprint) {
    return context.json({ error: "recording_upload_mutation_reused" }, 409);
  }

  if (!session) {
    const sessionId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const expiresAt = new Date(Date.now() + RECORDING_UPLOAD_EXPIRY_MS).toISOString();
    const objectKey = `recordings/original/${sessionId}`;
    const statements: D1PreparedStatement[] = [context.env.DB.prepare(`
      INSERT INTO recording_upload_sessions (
        id, song_id, client_mutation_id, request_fingerprint,
        file_manifest_sha256,
        description, recorded_on, original_filename, mime_type_hint,
        byte_size, part_size, part_count, object_key, status, revision,
        expires_at, created_at, created_by, updated_at, updated_by
      )
      SELECT ?, songs.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', 1, ?, ?, ?, ?, ?
      FROM songs
      WHERE songs.id = ? AND songs.trashed_at IS NULL
    `).bind(
      sessionId, upload.clientMutationId, fingerprint, upload.fileManifestSha256,
      upload.description, upload.recordedOn, upload.filename, upload.mimeTypeHint,
      upload.byteSize, RECORDING_UPLOAD_PART_BYTES, upload.partCount, objectKey,
      expiresAt, timestamp, actor, timestamp, actor, songId,
    ), context.env.DB.prepare(`
      INSERT INTO recording_upload_intents (
        session_id, intent_kind, target_recording_id,
        target_recording_revision, created_at, created_by
      )
      SELECT id, ?, ?, ?, ?, ?
      FROM recording_upload_sessions
      WHERE id = ? AND created_by = ? AND status = 'creating'
    `).bind(
      upload.replaceTarget ? "replace" : "create",
      upload.replaceTarget?.recordingId ?? null,
      upload.replaceTarget?.revision ?? null,
      timestamp, actor, sessionId, actor,
    )];
    for (const [sortOrder, personId] of upload.creditPersonIds.entries()) {
      statements.push(context.env.DB.prepare(`
        INSERT INTO recording_upload_credits (session_id, person_id, role, sort_order)
        SELECT id, ?, 'vocals', ?
        FROM recording_upload_sessions
        WHERE id = ? AND request_fingerprint = ? AND status = 'creating'
      `).bind(personId, sortOrder, sessionId, fingerprint));
    }
    try {
      const results = await context.env.DB.batch(statements);
      if (results[0].meta.changes === 0) return context.json({ error: "song_not_found" }, 404);
      created = true;
    } catch {
      session = await loadRecordingUploadByMutation(
        context.env.DB, actor, upload.clientMutationId,
      );
      if (!session || session.requestFingerprint !== fingerprint) {
        return context.json({ error: "recording_upload_create_failed" }, 500);
      }
    }
    session ??= await loadRecordingUploadSession(context.env.DB, sessionId, actor);
    if (!session) return context.json({ error: "recording_upload_create_failed" }, 500);
  }

  if (session.status === "creating") {
    if (session.expiresAt <= new Date().toISOString()) {
      const timestamp = new Date().toISOString();
      try {
        await context.env.DB.prepare(`
          UPDATE recording_upload_sessions
          SET status = 'aborted', revision = revision + 1,
              updated_at = ?, updated_by = ?
          WHERE id = ? AND created_by = ? AND status = 'creating' AND revision = ?
        `).bind(timestamp, actor, session.id, actor, session.revision).run();
      } catch {
        return context.json({ error: "recording_upload_expiry_checkpoint_failed" }, 503);
      }
      const current = await loadRecordingUploadSession(context.env.DB, session.id, actor);
      if (!current) return context.json({ error: "recording_upload_not_found" }, 404);
      if (current.status === "aborted") {
        return context.json({
          error: "recording_upload_expired",
          upload: publicRecordingUploadSession(current),
        }, 410);
      }
      if (current.status === "creating") {
        return context.json({ error: "recording_upload_expiry_checkpoint_failed" }, 503);
      }
      session = current;
    }
    if (session.status === "creating") {
      try {
        session = await provisionRecordingMultipartUpload(
          context.env.DB, context.env.MEDIA, session, actor,
        );
      } catch {
        return context.json({ error: "recording_upload_storage_unavailable" }, 503);
      }
    }
  }
  return context.json(
    { upload: publicRecordingUploadSession(session) },
    created ? 201 : 200,
  );
});

app.get("/api/recording-uploads/:sessionId", requireRole("editor"), async (context) => {
  const actor = context.get("appUser").identity;
  const session = await loadRecordingUploadSession(
    context.env.DB, context.req.param("sessionId"), actor,
  );
  if (!session) return context.json({ error: "recording_upload_not_found" }, 404);
  const [parts, duplicate] = await Promise.all([
    loadRecordingUploadParts(context.env.DB, session.id),
    loadRecordingUploadDuplicate(context.env.DB, session),
  ]);
  return context.json({
    upload: publicRecordingUploadSession(
      session,
      parts.map((part) => part.partNumber),
      duplicate,
    ),
  });
});

app.post("/api/recording-uploads/:sessionId/verify-file", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseRecordingUploadFileIdentity(body);
  if (!parsed.success) return context.json({ error: "invalid_recording_upload" }, 400);
  const actor = context.get("appUser").identity;
  const session = await loadRecordingUploadSession(
    context.env.DB, context.req.param("sessionId"), actor,
  );
  if (!session) return context.json({ error: "recording_upload_not_found" }, 404);
  if (session.status !== "open") {
    return context.json({ error: "recording_upload_not_open" }, 409);
  }
  if (!session.fileManifestSha256) {
    return context.json({ error: "recording_upload_file_identity_unavailable" }, 409);
  }
  if (session.fileManifestSha256 !== parsed.data.fileManifestSha256) {
    return context.json({ error: "recording_upload_file_mismatch" }, 409);
  }
  return context.json({ verified: true });
});

app.put("/api/recording-uploads/:sessionId/parts/:partNumber", requireRole("editor"), async (context) => {
  const actor = context.get("appUser").identity;
  const session = await loadRecordingUploadSession(
    context.env.DB, context.req.param("sessionId"), actor,
  );
  if (!session) return context.json({ error: "recording_upload_not_found" }, 404);
  if (session.status !== "open" || !session.uploadId) {
    return context.json({ error: "recording_upload_not_open" }, 409);
  }
  if (session.expiresAt <= new Date().toISOString()) {
    return context.json({ error: "recording_upload_expired" }, 410);
  }
  const partNumber = Number(context.req.param("partNumber"));
  const expectedBytes = expectedRecordingPartBytes(session.byteSize, partNumber);
  if (expectedBytes === null) return context.json({ error: "invalid_recording_upload_part" }, 400);
  const contentLength = Number(context.req.header("Content-Length"));
  if (!Number.isSafeInteger(contentLength) || contentLength !== expectedBytes) {
    return context.json({ error: "recording_upload_part_size_mismatch" }, 400);
  }
  const contentEncoding = context.req.header("Content-Encoding");
  if (contentEncoding && contentEncoding !== "identity") {
    return context.json({ error: "recording_upload_content_encoding_unsupported" }, 415);
  }
  const requestBody = context.req.raw.body;
  if (!requestBody) return context.json({ error: "recording_upload_part_required" }, 400);
  const claimedPartSha256 = context.req.header("X-Upload-Part-Sha256") ?? "";
  const claimedFileManifest = context.req.header("X-Upload-File-Manifest") ?? "";
  if (!/^[a-f0-9]{64}$/u.test(claimedPartSha256)
    || !/^[a-f0-9]{64}$/u.test(claimedFileManifest)) {
    return context.json({ error: "recording_upload_file_identity_required" }, 400);
  }
  if (!session.fileManifestSha256) {
    return context.json({ error: "recording_upload_file_identity_unavailable" }, 409);
  }
  if (session.fileManifestSha256 !== claimedFileManifest) {
    return context.json({ error: "recording_upload_file_mismatch" }, 409);
  }

  let uploaded: R2UploadedPart;
  let measuredPart: { sha256: string; byteSize: number };
  try {
    const [storageBody, digestBody] = requestBody.tee();
    [uploaded, measuredPart] = await Promise.all([
      context.env.MEDIA
        .resumeMultipartUpload(session.objectKey, session.uploadId)
        .uploadPart(partNumber, storageBody),
      sha256RecordingStream(digestBody),
    ]);
  } catch {
    return context.json({ error: "recording_upload_part_storage_failed" }, 503);
  }
  if (
    measuredPart.byteSize !== expectedBytes
    || measuredPart.sha256 !== claimedPartSha256
  ) {
    return context.json({ error: "recording_upload_part_hash_mismatch" }, 422);
  }
  if (
    uploaded.partNumber !== partNumber
    || !uploaded.etag
    || uploaded.etag.length > 200
    || /[\r\n]/u.test(uploaded.etag)
  ) {
    return context.json({ error: "recording_upload_part_invalid_etag" }, 503);
  }

  const timestamp = new Date().toISOString();
  const newRevision = session.revision + 1;
  try {
    const results = await context.env.DB.batch([
      context.env.DB.prepare(`
        UPDATE recording_upload_sessions
        SET revision = revision + 1, updated_at = ?, updated_by = ?
        WHERE id = ? AND created_by = ? AND status = 'open' AND revision = ?
      `).bind(timestamp, actor, session.id, actor, session.revision),
      context.env.DB.prepare(`
        INSERT INTO recording_upload_parts (
          session_id, part_number, etag, byte_size, sha256, uploaded_at, uploaded_by
        )
        SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM recording_upload_sessions
          WHERE id = ? AND created_by = ? AND status = 'open'
            AND revision = ? AND updated_at = ? AND updated_by = ?
        )
        ON CONFLICT(session_id, part_number) DO UPDATE SET
          etag = excluded.etag,
          byte_size = excluded.byte_size,
          sha256 = excluded.sha256,
          uploaded_at = excluded.uploaded_at,
          uploaded_by = excluded.uploaded_by
      `).bind(
        session.id, partNumber, uploaded.etag, expectedBytes, measuredPart.sha256, timestamp, actor,
        session.id, actor, newRevision, timestamp, actor,
      ),
    ]);
    if (results[0].meta.changes === 0 || results[1].meta.changes === 0) {
      return context.json({ error: "recording_upload_conflict" }, 409);
    }
  } catch {
    return context.json({ error: "recording_upload_checkpoint_failed" }, 503);
  }
  return context.json({ part: { partNumber }, upload: { revision: newRevision } });
});

app.post("/api/recording-uploads/:sessionId/complete", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseRecordingUploadRevision(body);
  if (!parsed.success) return context.json({ error: "invalid_recording_upload" }, 400);
  const actor = context.get("appUser").identity;
  let session = await loadRecordingUploadSession(
    context.env.DB, context.req.param("sessionId"), actor,
  );
  if (!session) return context.json({ error: "recording_upload_not_found" }, 404);

  if (session.status === "duplicate" || session.status === "finalized") {
    const duplicate = await loadRecordingUploadDuplicate(context.env.DB, session);
    return context.json({ upload: publicRecordingUploadSession(session, [], duplicate) });
  }
  if (session.status !== "open" && session.status !== "completing" && session.status !== "stored") {
    return context.json({ error: "recording_upload_cannot_complete" }, 409);
  }

  const parts = await loadRecordingUploadParts(context.env.DB, session.id);
  if (!validateCompletedRecordingParts(session.byteSize, parts)) {
    return context.json({ error: "recording_upload_parts_incomplete" }, 409);
  }
  const measuredManifest = await recordingUploadFileManifestSha256(
    session.byteSize,
    parts.map((part) => ({
      partNumber: part.partNumber,
      byteSize: part.byteSize,
      sha256: part.sha256 ?? "",
    })),
  );
  if (!session.fileManifestSha256 || measuredManifest !== session.fileManifestSha256) {
    return context.json({ error: "recording_upload_file_mismatch" }, 409);
  }

  if (session.status === "open") {
    if (!session.uploadId) return context.json({ error: "recording_upload_not_open" }, 409);
    if (session.revision !== parsed.data.revision) {
      return context.json({ error: "recording_upload_conflict" }, 409);
    }
    const timestamp = new Date().toISOString();
    let result: D1Result;
    try {
      result = await context.env.DB.prepare(`
        UPDATE recording_upload_sessions
        SET status = 'completing', revision = revision + 1,
            updated_at = ?, updated_by = ?
        WHERE id = ? AND created_by = ? AND status = 'open' AND revision = ?
      `).bind(timestamp, actor, session.id, actor, session.revision).run();
    } catch {
      return context.json({ error: "recording_upload_completion_checkpoint_failed" }, 503);
    }
    if (result.meta.changes === 0) {
      return context.json({ error: "recording_upload_conflict" }, 409);
    }
    const completing = await loadRecordingUploadSession(context.env.DB, session.id, actor);
    if (!completing) return context.json({ error: "recording_upload_not_found" }, 404);
    session = completing;
  } else if (session.status === "completing" && session.revision !== parsed.data.revision) {
    return context.json({ error: "recording_upload_conflict" }, 409);
  }

  if (session.status === "completing") {
    const completingSession = session;
    if (!completingSession.uploadId) return context.json({ error: "recording_upload_not_open" }, 409);
    let storedObject: R2Object | null;
    try {
      storedObject = await context.env.MEDIA.head(completingSession.objectKey);
    } catch {
      return context.json({ error: "recording_upload_storage_unavailable" }, 503);
    }
    if (!storedObject) {
      try {
        storedObject = await context.env.MEDIA
          .resumeMultipartUpload(completingSession.objectKey, completingSession.uploadId)
          .complete(parts.map((part) => ({
            partNumber: part.partNumber,
            etag: part.etag,
          })));
      } catch {
        try {
          storedObject = await context.env.MEDIA.head(completingSession.objectKey);
        } catch {
          return context.json({ error: "recording_upload_storage_unavailable" }, 503);
        }
        if (!storedObject) {
          const timestamp = new Date().toISOString();
          try {
            await context.env.DB.prepare(`
              UPDATE recording_upload_sessions
              SET status = 'open', revision = revision + 1,
                  updated_at = ?, updated_by = ?
              WHERE id = ? AND created_by = ? AND status = 'completing' AND revision = ?
            `).bind(
              timestamp, actor, completingSession.id, actor, completingSession.revision,
            ).run();
          } catch {
            return context.json({ error: "recording_upload_completion_checkpoint_failed" }, 503);
          }
          return context.json({ error: "recording_upload_storage_completion_failed" }, 503);
        }
      }
    }

    const failStoredObject = async (): Promise<Response> => {
      const timestamp = new Date().toISOString();
      let result: D1Result;
      try {
        result = await context.env.DB.prepare(`
          UPDATE recording_upload_sessions
          SET status = 'failed', error_code = 'stored_object_mismatch',
              revision = revision + 1, updated_at = ?, updated_by = ?
          WHERE id = ? AND created_by = ? AND status = 'completing' AND revision = ?
        `).bind(
          timestamp, actor, completingSession.id, actor, completingSession.revision,
        ).run();
      } catch {
        return context.json({ error: "recording_upload_completion_checkpoint_failed" }, 503);
      }
      if (result.meta.changes === 0) {
        return context.json({ error: "recording_upload_conflict" }, 409);
      }
      return context.json({ error: "recording_upload_stored_object_mismatch" }, 500);
    };

    if (
      storedObject.key !== completingSession.objectKey
      || storedObject.size !== completingSession.byteSize
    ) {
      return failStoredObject();
    }
    let privateObject: R2ObjectBody | null;
    try {
      privateObject = await context.env.MEDIA.get(completingSession.objectKey);
    } catch {
      return context.json({ error: "recording_upload_storage_unavailable" }, 503);
    }
    if (!privateObject) {
      return context.json({ error: "recording_upload_storage_unavailable" }, 503);
    }
    if (
      privateObject.key !== completingSession.objectKey
      || privateObject.size !== completingSession.byteSize
    ) {
      return failStoredObject();
    }
    let fingerprint: { sha256: string; byteSize: number };
    try {
      fingerprint = await sha256RecordingStream(privateObject.body);
    } catch {
      return context.json({ error: "recording_upload_fingerprint_failed" }, 503);
    }
    if (fingerprint.byteSize !== completingSession.byteSize) {
      return failStoredObject();
    }

    const timestamp = new Date().toISOString();
    let result: D1Result;
    try {
      result = await context.env.DB.prepare(`
        UPDATE recording_upload_sessions
        SET status = 'stored', sha256 = ?, revision = revision + 1,
            updated_at = ?, updated_by = ?
        WHERE id = ? AND created_by = ? AND status = 'completing' AND revision = ?
      `).bind(
        fingerprint.sha256, timestamp, actor,
        completingSession.id, actor, completingSession.revision,
      ).run();
    } catch {
      return context.json({ error: "recording_upload_completion_checkpoint_failed" }, 503);
    }
    const current = await loadRecordingUploadSession(context.env.DB, completingSession.id, actor);
    if (!current) return context.json({ error: "recording_upload_not_found" }, 404);
    if (result.meta.changes === 0 && current.status !== "stored" && current.status !== "duplicate") {
      return context.json({ error: "recording_upload_conflict" }, 409);
    }
    session = current;
  }

  if (session.status === "stored") {
    if (!session.sha256) {
      return context.json({ error: "recording_upload_completion_checkpoint_failed" }, 500);
    }
    let duplicate: RecordingUploadDuplicateRow | null;
    try {
      duplicate = await findDuplicateRecordingMedia(
        context.env.DB, session.sha256, session.byteSize,
      );
    } catch {
      return context.json({ error: "recording_upload_duplicate_check_failed" }, 503);
    }
    if (duplicate) {
      const timestamp = new Date().toISOString();
      let result: D1Result;
      try {
        result = await context.env.DB.prepare(`
          UPDATE recording_upload_sessions
          SET status = 'duplicate', duplicate_media_id = ?, revision = revision + 1,
              updated_at = ?, updated_by = ?
          WHERE id = ? AND created_by = ? AND status = 'stored' AND revision = ?
        `).bind(
          duplicate.mediaId, timestamp, actor,
          session.id, actor, session.revision,
        ).run();
      } catch {
        return context.json({ error: "recording_upload_duplicate_checkpoint_failed" }, 503);
      }
      const current = await loadRecordingUploadSession(context.env.DB, session.id, actor);
      if (!current) return context.json({ error: "recording_upload_not_found" }, 404);
      if (result.meta.changes === 0 && current.status !== "duplicate") {
        return context.json({ error: "recording_upload_conflict" }, 409);
      }
      session = current;
      duplicate = await loadRecordingUploadDuplicate(context.env.DB, session);
      return context.json({ upload: publicRecordingUploadSession(session, [], duplicate) });
    }
  }

  return context.json({ upload: publicRecordingUploadSession(session) });
});

app.post("/api/recording-uploads/:sessionId/finalize", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseRecordingUploadFinalization(body);
  if (!parsed.success) {
    return context.json({ error: "invalid_recording_upload", fields: parsed.fields }, 400);
  }
  const actor = context.get("appUser").identity;
  let session = await loadRecordingUploadSession(
    context.env.DB, context.req.param("sessionId"), actor,
  );
  if (!session) return context.json({ error: "recording_upload_not_found" }, 404);

  if (session.status === "duplicate") {
    const duplicate = await loadRecordingUploadDuplicate(context.env.DB, session);
    return context.json({ upload: publicRecordingUploadSession(session, [], duplicate) });
  }
  if (session.status === "finalized") {
    const recording = await loadFinalizedRecording(context.env.DB, session);
    if (!recording) return context.json({ error: "recording_upload_finalization_incomplete" }, 500);
    const job = await loadAudioProcessingJobByRecording(context.env.DB, recording.id);
    if (job?.status === "pending") {
      await scheduleAudioProcessorRun(context, job.id, "upload_replay", actor);
    }
    return context.json({ upload: publicRecordingUploadSession(session), recording });
  }
  if (session.status !== "stored" || !session.sha256) {
    return context.json({ error: "recording_upload_not_stored" }, 409);
  }
  if (session.intentKind !== "create") {
    return context.json({ error: "recording_upload_intent_mismatch" }, 409);
  }
  if (session.revision !== parsed.data.revision) {
    return context.json({ error: "recording_upload_conflict" }, 409);
  }

  const finalDescription = parsed.data.description ?? session.description;
  const normalizedDescription = finalDescription === null
    ? null
    : normalizedTextKey(finalDescription);
  if (finalDescription !== null && !normalizedDescription) {
    return context.json({ error: "invalid_recording_upload" }, 400);
  }
  if (normalizedDescription) {
    const conflict = await context.env.DB.prepare(`
      SELECT id
      FROM recordings
      WHERE song_id = ? AND normalized_description = ? AND trashed_at IS NULL
      LIMIT 1
    `).bind(session.songId, normalizedDescription).first<{ id: string }>();
    if (conflict) {
      return context.json({
        error: "duplicate_recording_description",
        existingRecording: { id: conflict.id, songId: session.songId },
      }, 409);
    }
  }

  const mediaId = crypto.randomUUID();
  const recordingId = crypto.randomUUID();
  const processingJobId = crypto.randomUUID();
  const creditIdPrefix = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const duplicateStatement = context.env.DB.prepare(`
    WITH duplicate(media_id) AS (
      SELECT media_objects.id
      FROM media_objects
      LEFT JOIN recordings ON
        recordings.original_media_id = media_objects.id
        OR recordings.playback_media_id = media_objects.id
      WHERE media_objects.kind IN ('original_audio', 'playback_audio')
        AND media_objects.sha256 = ?
        AND media_objects.byte_size = ?
      ORDER BY
        recordings.id IS NULL,
        recordings.trashed_at IS NOT NULL,
        media_objects.kind <> 'original_audio',
        recordings.id,
        media_objects.id
      LIMIT 1
    )
    UPDATE recording_upload_sessions
    SET status = 'duplicate',
        duplicate_media_id = (SELECT media_id FROM duplicate),
        revision = revision + 1,
        updated_at = ?,
        updated_by = ?
    WHERE id = ? AND created_by = ? AND status = 'stored' AND revision = ?
      AND EXISTS (SELECT 1 FROM duplicate)
  `).bind(
    session.sha256, session.byteSize, timestamp, actor,
    session.id, actor, session.revision,
  );
  const mediaStatement = context.env.DB.prepare(`
    INSERT INTO media_objects (
      id, object_key, original_filename, mime_type, byte_size, sha256,
      kind, state, created_at, created_by
    )
    SELECT ?, object_key, original_filename, NULL, byte_size, sha256,
           'original_audio', 'active', ?, ?
    FROM recording_upload_sessions
    WHERE id = ? AND created_by = ? AND status = 'stored' AND revision = ?
      AND sha256 = ?
      AND NOT EXISTS (
        SELECT 1 FROM media_objects
        WHERE kind = 'original_audio'
          AND sha256 = recording_upload_sessions.sha256
          AND byte_size = recording_upload_sessions.byte_size
      )
  `).bind(
    mediaId, timestamp, actor,
    session.id, actor, session.revision, session.sha256,
  );
  const recordingStatement = finalDescription === null
    ? context.env.DB.prepare(`
      WITH RECURSIVE active_descriptions(normalized_description) AS (
        SELECT normalized_description
        FROM recordings
        WHERE song_id = ? AND trashed_at IS NULL
      ),
      recording_numbers(value, maximum) AS (
        SELECT 1, (SELECT COUNT(*) + 1 FROM active_descriptions)
        UNION ALL
        SELECT value + 1, maximum
        FROM recording_numbers
        WHERE value < maximum
      ),
      available_description(value) AS (
        SELECT value
        FROM recording_numbers
        WHERE NOT EXISTS (
          SELECT 1 FROM active_descriptions
          WHERE normalized_description = 'recording ' || recording_numbers.value
        )
        ORDER BY value
        LIMIT 1
      )
      INSERT INTO recordings (
        id, song_id, original_media_id, playback_media_id,
        description, normalized_description, recorded_on,
        processing_state, processing_error, revision,
        created_at, created_by, updated_at, updated_by
      )
      SELECT ?, recording_upload_sessions.song_id, ?, NULL,
             'Recording ' || available_description.value,
             'recording ' || available_description.value,
             recording_upload_sessions.recorded_on,
             'processing', NULL, 1, ?, ?, ?, ?
      FROM recording_upload_sessions
      JOIN media_objects ON media_objects.id = ?
        AND media_objects.object_key = recording_upload_sessions.object_key
        AND media_objects.sha256 = recording_upload_sessions.sha256
        AND media_objects.byte_size = recording_upload_sessions.byte_size
        AND media_objects.kind = 'original_audio'
        AND media_objects.state = 'active'
      CROSS JOIN available_description
      WHERE recording_upload_sessions.id = ?
        AND recording_upload_sessions.created_by = ?
        AND recording_upload_sessions.status = 'stored'
        AND recording_upload_sessions.revision = ?
    `).bind(
      session.songId,
      recordingId, mediaId, timestamp, actor, timestamp, actor,
      mediaId, session.id, actor, session.revision,
    )
    : context.env.DB.prepare(`
      INSERT INTO recordings (
        id, song_id, original_media_id, playback_media_id,
        description, normalized_description, recorded_on,
        processing_state, processing_error, revision,
        created_at, created_by, updated_at, updated_by
      )
      SELECT ?, recording_upload_sessions.song_id, ?, NULL,
             ?, ?, recording_upload_sessions.recorded_on,
             'processing', NULL, 1, ?, ?, ?, ?
      FROM recording_upload_sessions
      JOIN media_objects ON media_objects.id = ?
        AND media_objects.object_key = recording_upload_sessions.object_key
        AND media_objects.sha256 = recording_upload_sessions.sha256
        AND media_objects.byte_size = recording_upload_sessions.byte_size
        AND media_objects.kind = 'original_audio'
        AND media_objects.state = 'active'
      WHERE recording_upload_sessions.id = ?
        AND recording_upload_sessions.created_by = ?
        AND recording_upload_sessions.status = 'stored'
        AND recording_upload_sessions.revision = ?
    `).bind(
      recordingId, mediaId, finalDescription, normalizedDescription,
      timestamp, actor, timestamp, actor,
      mediaId, session.id, actor, session.revision,
    );
  const creditStatement = context.env.DB.prepare(`
    INSERT INTO recording_credits (
      id, recording_id, person_id, role, sort_order
    )
    SELECT ? || '-' || printf('%03d', recording_upload_credits.sort_order),
           ?, recording_upload_credits.person_id,
           recording_upload_credits.role, recording_upload_credits.sort_order
    FROM recording_upload_credits
    JOIN recording_upload_sessions
      ON recording_upload_sessions.id = recording_upload_credits.session_id
    WHERE recording_upload_credits.session_id = ?
      AND recording_upload_sessions.created_by = ?
      AND recording_upload_sessions.status = 'stored'
      AND recording_upload_sessions.revision = ?
    ORDER BY recording_upload_credits.sort_order, recording_upload_credits.person_id
  `).bind(
    creditIdPrefix, recordingId, session.id, actor, session.revision,
  );
  const jobStatement = context.env.DB.prepare(`
    INSERT INTO audio_processing_jobs (
      id, recording_id, source_media_id, source_sha256, source_byte_size,
      policy_id, status, attempt_count, created_at, updated_at
    )
    SELECT ?, ?, ?, recording_upload_sessions.sha256,
           recording_upload_sessions.byte_size, ?, 'pending', 0, ?, ?
    FROM recording_upload_sessions
    JOIN recordings ON recordings.id = ?
      AND recordings.song_id = recording_upload_sessions.song_id
      AND recordings.original_media_id = ?
      AND recordings.processing_state = 'processing'
      AND recordings.processing_error IS NULL
      AND recordings.trashed_at IS NULL
    WHERE recording_upload_sessions.id = ?
      AND recording_upload_sessions.created_by = ?
      AND recording_upload_sessions.status = 'stored'
      AND recording_upload_sessions.revision = ?
  `).bind(
    processingJobId, recordingId, mediaId, AUDIO_PROCESSING_POLICY_ID,
    timestamp, timestamp, recordingId, mediaId,
    session.id, actor, session.revision,
  );
  const songStatement = context.env.DB.prepare(`
    UPDATE songs
    SET updated_at = ?, updated_by = ?
    WHERE id = ? AND trashed_at IS NULL
      AND EXISTS (
        SELECT 1 FROM recordings
        WHERE recordings.id = ?
          AND recordings.song_id = songs.id
          AND recordings.original_media_id = ?
          AND recordings.processing_state = 'processing'
          AND recordings.trashed_at IS NULL
      )
  `).bind(timestamp, actor, session.songId, recordingId, mediaId);
  const finalizeStatement = context.env.DB.prepare(`
    UPDATE recording_upload_sessions
    SET status = 'finalized', recording_id = ?, revision = revision + 1,
        updated_at = ?, updated_by = ?
    WHERE id = ? AND created_by = ? AND status = 'stored' AND revision = ?
  `).bind(
    recordingId, timestamp, actor,
    session.id, actor, session.revision,
  );

  let results: D1Result[];
  try {
    results = await context.env.DB.batch([
      duplicateStatement,
      mediaStatement,
      recordingStatement,
      creditStatement,
      jobStatement,
      songStatement,
      finalizeStatement,
    ]);
  } catch (error) {
    if (normalizedDescription) {
      const conflict = await context.env.DB.prepare(`
        SELECT id
        FROM recordings
        WHERE song_id = ? AND normalized_description = ? AND trashed_at IS NULL
        LIMIT 1
      `).bind(session.songId, normalizedDescription).first<{ id: string }>();
      if (conflict) {
        return context.json({
          error: "duplicate_recording_description",
          existingRecording: { id: conflict.id, songId: session.songId },
        }, 409);
      }
    }
    const mapped = recordingWriteError(error);
    return context.json({
      error: mapped.status === 409 ? mapped.error : "recording_upload_finalization_failed",
    }, mapped.status === 409 ? 409 : 500);
  }

  const current = await loadRecordingUploadSession(context.env.DB, session.id, actor);
  if (!current) return context.json({ error: "recording_upload_not_found" }, 404);
  session = current;
  if (session.status === "duplicate") {
    const duplicate = await loadRecordingUploadDuplicate(context.env.DB, session);
    return context.json({ upload: publicRecordingUploadSession(session, [], duplicate) });
  }
  if (session.status !== "finalized") {
    return context.json({ error: "recording_upload_conflict" }, 409);
  }
  const recording = await loadFinalizedRecording(context.env.DB, session);
  if (!recording) return context.json({ error: "recording_upload_finalization_incomplete" }, 500);
  await scheduleAudioProcessorRun(context, processingJobId, "upload_finalize", actor);
  return context.json(
    { upload: publicRecordingUploadSession(session), recording },
    results[6].meta.changes === 1 ? 201 : 200,
  );
});

app.post("/api/songs/:songId/recording-uploads/:sessionId/replace", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseRecordingUploadReplacement(body);
  if (!parsed.success) {
    return context.json({ error: "invalid_recording_upload", fields: parsed.fields }, 400);
  }

  const actor = context.get("appUser").identity;
  const sessionId = context.req.param("sessionId");
  const targetRecordingId = parsed.data.targetRecordingId;

  let session = await loadRecordingUploadSession(context.env.DB, sessionId, actor);
  if (!session) return context.json({ error: "recording_upload_not_found" }, 404);

  if (session.status !== "stored") {
    if (session.status === "duplicate") {
      const duplicate = await loadRecordingUploadDuplicate(context.env.DB, session);
      return context.json({ upload: publicRecordingUploadSession(session, [], duplicate) });
    }
    if (session.status === "finalized") {
      const recording = await loadFinalizedRecording(context.env.DB, session);
      if (!recording) return context.json({ error: "recording_upload_finalization_incomplete" }, 500);
      const job = await loadAudioProcessingJobByRecording(context.env.DB, recording.id);
      if (job?.status === "pending") {
        await scheduleAudioProcessorRun(context, job.id, "replacement_replay", actor);
      }
      return context.json({ upload: publicRecordingUploadSession(session), recording });
    }
    return context.json({ error: "recording_upload_conflict" }, 409);
  }
  if (
    session.intentKind !== "replace"
    || session.targetRecordingId !== targetRecordingId
  ) {
    return context.json({ error: "recording_upload_intent_mismatch" }, 409);
  }
  if (session.targetRecordingRevision !== parsed.data.targetRecordingRevision) {
    return context.json({ error: "recording_conflict" }, 409);
  }

  const timestamp = new Date().toISOString();
  const finalDescription = parsed.data.description ?? session.description;
  const normalizedDescription = finalDescription === null
    ? null
    : normalizedTextKey(finalDescription);
  if (finalDescription !== null && !normalizedDescription) {
    return context.json({ error: "invalid_recording_upload" }, 400);
  }

  const currentRecording = await context.env.DB.prepare(`
    SELECT
      recordings.id,
      recordings.original_media_id,
      recordings.playback_media_id,
      recordings.processing_state,
      recordings.revision,
      EXISTS (
        SELECT 1 FROM audio_processing_jobs
        WHERE recording_id = recordings.id AND status IN ('pending', 'running')
      ) AS has_active_job
    FROM recordings
    WHERE recordings.id = ? AND recordings.song_id = ? AND recordings.trashed_at IS NULL
  `).bind(targetRecordingId, session.songId).first<{
    id: string;
    original_media_id: string;
    playback_media_id: string | null;
    processing_state: "processing" | "ready" | "failed";
    has_active_job: number;
    revision: number;
  }>();

  if (!currentRecording) return context.json({ error: "recording_not_found" }, 404);
  if (currentRecording.revision !== parsed.data.targetRecordingRevision) {
    return context.json({ error: "recording_conflict" }, 409);
  }
  if (currentRecording.processing_state === "processing" || currentRecording.has_active_job === 1) {
    return context.json({ error: "recording_processing_active" }, 409);
  }

  const mediaId = crypto.randomUUID();
  const historyId = crypto.randomUUID();
  const processingJobId = crypto.randomUUID();

  let results: D1Result[];
  try {
    results = await context.env.DB.batch([
      context.env.DB.prepare(`
        WITH duplicate AS (
          SELECT media_objects.id
          FROM media_objects
          WHERE media_objects.kind IN ('original_audio', 'playback_audio')
            AND media_objects.sha256 = ?
            AND media_objects.byte_size = ?
          ORDER BY
            NOT EXISTS (
              SELECT 1 FROM recordings
              WHERE recordings.original_media_id = media_objects.id
                 OR recordings.playback_media_id = media_objects.id
            ),
            NOT EXISTS (
              SELECT 1 FROM recordings
              WHERE (recordings.original_media_id = media_objects.id
                  OR recordings.playback_media_id = media_objects.id)
                AND recordings.trashed_at IS NULL
            ),
            NOT EXISTS (
              SELECT 1 FROM recording_media_history
              WHERE recording_media_history.original_media_id = media_objects.id
                 OR recording_media_history.playback_media_id = media_objects.id
            ),
            media_objects.kind <> 'original_audio',
            media_objects.id
          LIMIT 1
        )
        UPDATE recording_upload_sessions
        SET status = 'duplicate',
            duplicate_media_id = (SELECT id FROM duplicate),
            revision = revision + 1,
            updated_at = ?,
            updated_by = ?
        WHERE id = ? AND created_by = ? AND status = 'stored' AND revision = ?
          AND EXISTS (SELECT 1 FROM duplicate)
      `).bind(
        session.sha256, session.byteSize, timestamp, actor,
        session.id, actor, parsed.data.sessionRevision,
      ),
      context.env.DB.prepare(`
        INSERT INTO media_objects (
          id, object_key, original_filename, mime_type, byte_size, sha256,
          kind, state, created_at, created_by
        )
        SELECT ?, object_key, original_filename, NULL, byte_size, sha256,
               'original_audio', 'active', ?, ?
        FROM recording_upload_sessions
        WHERE id = ? AND created_by = ? AND status = 'stored' AND revision = ?
          AND sha256 = ?
          AND NOT EXISTS (
            SELECT 1 FROM media_objects
            WHERE kind = 'original_audio'
              AND sha256 = recording_upload_sessions.sha256
              AND byte_size = recording_upload_sessions.byte_size
          )
      `).bind(
        mediaId, timestamp, actor,
        session.id, actor, parsed.data.sessionRevision, session.sha256,
      ),
      context.env.DB.prepare(`
        INSERT INTO recording_media_history (
          id, recording_id, original_media_id, playback_media_id,
          replaced_at, replaced_by, revision_at_replacement
        )
        SELECT ?, id, original_media_id, playback_media_id, ?, ?, revision
        FROM recordings
        WHERE id = ? AND song_id = ? AND revision = ? AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM recording_upload_sessions
            WHERE id = ? AND created_by = ? AND status = 'stored' AND revision = ?
          )
      `).bind(
        historyId, timestamp, actor,
        targetRecordingId, session.songId, parsed.data.targetRecordingRevision,
        session.id, actor, parsed.data.sessionRevision,
      ),
      context.env.DB.prepare(`
        UPDATE recordings
        SET original_media_id = ?,
            playback_media_id = NULL,
            description = ?,
            normalized_description = ?,
            recorded_on = (SELECT recorded_on FROM recording_upload_sessions WHERE id = ?),
            processing_state = 'processing',
            processing_error = NULL,
            revision = revision + 1,
            updated_at = ?,
            updated_by = ?
        WHERE id = ? AND song_id = ? AND revision = ? AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM recording_upload_sessions
            WHERE id = ? AND created_by = ? AND status = 'stored' AND revision = ?
          )
      `).bind(
        mediaId, finalDescription, normalizedDescription, session.id,
        timestamp, actor,
        targetRecordingId, session.songId, parsed.data.targetRecordingRevision,
        session.id, actor, parsed.data.sessionRevision,
      ),
      context.env.DB.prepare(`
        DELETE FROM recording_credits
        WHERE recording_id = ?
          AND EXISTS (
            SELECT 1 FROM recording_upload_sessions
            WHERE id = ? AND created_by = ? AND status = 'stored' AND revision = ?
          )
      `).bind(targetRecordingId, session.id, actor, parsed.data.sessionRevision),
      context.env.DB.prepare(`
        INSERT INTO recording_credits (
          id, recording_id, person_id, role, sort_order
        )
        SELECT ? || '-' || printf('%03d', recording_upload_credits.sort_order),
               ?, recording_upload_credits.person_id,
               recording_upload_credits.role, recording_upload_credits.sort_order
        FROM recording_upload_credits
        JOIN recording_upload_sessions
          ON recording_upload_sessions.id = recording_upload_credits.session_id
        WHERE recording_upload_credits.session_id = ?
          AND recording_upload_sessions.created_by = ?
          AND recording_upload_sessions.status = 'stored'
          AND recording_upload_sessions.revision = ?
        ORDER BY recording_upload_credits.sort_order, recording_upload_credits.person_id
      `).bind(
        targetRecordingId, targetRecordingId, session.id, actor, parsed.data.sessionRevision,
      ),
      context.env.DB.prepare(`
        INSERT INTO audio_processing_jobs (
          id, recording_id, source_media_id, source_sha256, source_byte_size,
          policy_id, status, attempt_count, created_at, updated_at
        )
        SELECT ?, ?, ?, recording_upload_sessions.sha256,
               recording_upload_sessions.byte_size, ?, 'pending', 0, ?, ?
        FROM recording_upload_sessions
        JOIN recordings ON recordings.id = ?
          AND recordings.song_id = recording_upload_sessions.song_id
          AND recordings.original_media_id = ?
          AND recordings.processing_state = 'processing'
          AND recordings.processing_error IS NULL
          AND recordings.trashed_at IS NULL
        WHERE recording_upload_sessions.id = ?
          AND recording_upload_sessions.created_by = ?
          AND recording_upload_sessions.status = 'stored'
          AND recording_upload_sessions.revision = ?
      `).bind(
        processingJobId, targetRecordingId, mediaId,
        AUDIO_PROCESSING_POLICY_ID, timestamp, timestamp,
        targetRecordingId, mediaId, session.id, actor, parsed.data.sessionRevision,
      ),
      context.env.DB.prepare(`
        UPDATE recording_upload_sessions
        SET status = 'finalized',
            recording_id = ?,
            revision = revision + 1,
            updated_at = ?,
            updated_by = ?
        WHERE id = ? AND created_by = ? AND status = 'stored' AND revision = ?
          AND EXISTS (
            SELECT 1 FROM recordings
            WHERE id = ? AND original_media_id = ? AND processing_state = 'processing'
          )
      `).bind(
        targetRecordingId, timestamp, actor,
        session.id, actor, parsed.data.sessionRevision,
        targetRecordingId, mediaId,
      ),
      context.env.DB.prepare(`
        UPDATE songs
        SET updated_at = ?, updated_by = ?
        WHERE id = ? AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM recording_upload_sessions
            WHERE id = ? AND created_by = ? AND status = 'finalized'
          )
      `).bind(timestamp, actor, session.songId, session.id, actor),
    ]);
  } catch (error: any) {
    if (error.message?.includes("recording_conflict")) {
      return context.json({ error: "recording_conflict" }, 409);
    }
    if (error.message?.includes("recording_upload_is_terminal")) {
      const duplicate = await loadRecordingUploadDuplicate(context.env.DB, session);
      return context.json({ upload: publicRecordingUploadSession(session, [], duplicate) });
    }
    const mapped = recordingWriteError(error);
    return context.json({
      error: mapped.status === 409 ? mapped.error : "recording_upload_finalization_failed",
    }, mapped.status === 409 ? 409 : 500);
  }

  const current = await loadRecordingUploadSession(context.env.DB, session.id, actor);
  if (!current) return context.json({ error: "recording_upload_not_found" }, 404);
  session = current;
  if (session.status === "duplicate") {
    const duplicate = await loadRecordingUploadDuplicate(context.env.DB, session);
    return context.json({ upload: publicRecordingUploadSession(session, [], duplicate) });
  }
  if (session.status !== "finalized") {
    return context.json({ error: "recording_upload_conflict" }, 409);
  }
  const recording = await loadFinalizedRecording(context.env.DB, session);
  if (!recording) return context.json({ error: "recording_upload_finalization_incomplete" }, 500);
  await scheduleAudioProcessorRun(context, processingJobId, "replacement_finalize", actor);
  return context.json(
    { upload: publicRecordingUploadSession(session), recording },
    results[7].meta.changes === 1 ? 201 : 200,
  );
});

app.post("/api/songs/:songId/recording-uploads/:sessionId/reuse-history", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseRecordingUploadReplacement(body);
  if (!parsed.success) {
    return context.json({ error: "invalid_recording_upload", fields: parsed.fields }, 400);
  }
  const actor = context.get("appUser").identity;
  const songId = context.req.param("songId");
  const session = await loadRecordingUploadSession(
    context.env.DB, context.req.param("sessionId"), actor,
  );
  if (!session) return context.json({ error: "recording_upload_not_found" }, 404);
  if (
    session.status !== "duplicate"
    || session.revision !== parsed.data.sessionRevision
    || session.songId !== songId
    || session.intentKind !== "replace"
    || session.targetRecordingId !== parsed.data.targetRecordingId
    || session.targetRecordingRevision !== parsed.data.targetRecordingRevision
  ) {
    return context.json({ error: "recording_upload_intent_mismatch" }, 409);
  }
  const duplicate = await loadRecordingUploadDuplicate(context.env.DB, session);
  if (
    !duplicate
    || duplicate.isHistorical !== 1
    || duplicate.recordingId !== parsed.data.targetRecordingId
    || !duplicate.historyId
    || !duplicate.historyOriginalMediaId
  ) {
    return context.json({ error: "recording_upload_history_unavailable" }, 409);
  }

  const current = await context.env.DB.prepare(`
    SELECT
      recordings.original_media_id AS originalMediaId,
      recordings.playback_media_id AS playbackMediaId,
      recordings.description,
      recordings.normalized_description AS normalizedDescription,
      recordings.revision,
      recordings.processing_state AS processingState,
      EXISTS (
        SELECT 1 FROM audio_processing_jobs
        WHERE recording_id = recordings.id AND status IN ('pending', 'running')
      ) AS hasActiveJob
    FROM recordings
    JOIN songs ON songs.id = recordings.song_id
    WHERE recordings.id = ? AND recordings.song_id = ?
      AND recordings.trashed_at IS NULL AND songs.trashed_at IS NULL
  `).bind(parsed.data.targetRecordingId, songId).first<{
    originalMediaId: string;
    playbackMediaId: string | null;
    description: string;
    normalizedDescription: string;
    revision: number;
    processingState: "processing" | "ready" | "failed";
    hasActiveJob: number;
  }>();
  if (!current) return context.json({ error: "recording_not_found" }, 404);
  if (current.revision !== parsed.data.targetRecordingRevision) {
    return context.json({ error: "recording_conflict" }, 409);
  }
  if (current.processingState === "processing" || current.hasActiveJob === 1) {
    return context.json({ error: "recording_processing_active" }, 409);
  }
  const finalDescription = parsed.data.description ?? session.description ?? current.description;
  const normalizedDescription = normalizedTextKey(finalDescription);
  if (!normalizedDescription) return context.json({ error: "invalid_recording_upload" }, 400);

  const timestamp = new Date().toISOString();
  const currentHistoryId = crypto.randomUUID();
  try {
    const results = await context.env.DB.batch([
      context.env.DB.prepare(`
        INSERT INTO recording_media_history (
          id, recording_id, original_media_id, playback_media_id,
          replaced_at, replaced_by, revision_at_replacement
        )
        SELECT ?, recordings.id, recordings.original_media_id,
               recordings.playback_media_id, ?, ?, recordings.revision
        FROM recordings
        WHERE recordings.id = ? AND recordings.song_id = ?
          AND recordings.revision = ? AND recordings.trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM recording_media_history
            JOIN media_objects AS historical_original
              ON historical_original.id = recording_media_history.original_media_id
            LEFT JOIN media_objects AS historical_playback
              ON historical_playback.id = recording_media_history.playback_media_id
            WHERE recording_media_history.id = ?
              AND recording_media_history.recording_id = recordings.id
              AND recording_media_history.original_media_id = ?
              AND recording_media_history.playback_media_id IS ?
              AND historical_original.kind = 'original_audio'
              AND historical_original.state = 'active'
              AND (
                recording_media_history.playback_media_id IS NULL
                OR historical_playback.state = 'active'
              )
          )
      `).bind(
        currentHistoryId, timestamp, actor,
        parsed.data.targetRecordingId, songId, current.revision,
        duplicate.historyId, duplicate.historyOriginalMediaId,
        duplicate.historyPlaybackMediaId,
      ),
      context.env.DB.prepare(`
        UPDATE recordings
        SET original_media_id = ?, playback_media_id = ?,
            description = ?, normalized_description = ?,
            recorded_on = (SELECT recorded_on FROM recording_upload_sessions WHERE id = ?),
            processing_state = 'ready', processing_error = NULL,
            revision = revision + 1, updated_at = ?, updated_by = ?
        WHERE id = ? AND song_id = ? AND revision = ? AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM recording_media_history
            WHERE id = ? AND recording_id = recordings.id
          )
      `).bind(
        duplicate.historyOriginalMediaId, duplicate.historyPlaybackMediaId,
        finalDescription, normalizedDescription, session.id,
        timestamp, actor, parsed.data.targetRecordingId, songId, current.revision,
        currentHistoryId,
      ),
      context.env.DB.prepare(`
        DELETE FROM recording_credits
        WHERE recording_id = ?
          AND EXISTS (
            SELECT 1 FROM recording_upload_sessions
            WHERE id = ? AND created_by = ? AND status = 'duplicate' AND revision = ?
          )
      `).bind(parsed.data.targetRecordingId, session.id, actor, session.revision),
      context.env.DB.prepare(`
        INSERT INTO recording_credits (id, recording_id, person_id, role, sort_order)
        SELECT ? || '-' || printf('%03d', recording_upload_credits.sort_order),
               ?, recording_upload_credits.person_id,
               recording_upload_credits.role, recording_upload_credits.sort_order
        FROM recording_upload_credits
        JOIN recording_upload_sessions
          ON recording_upload_sessions.id = recording_upload_credits.session_id
        WHERE recording_upload_credits.session_id = ?
          AND recording_upload_sessions.created_by = ?
          AND recording_upload_sessions.status = 'duplicate'
          AND recording_upload_sessions.revision = ?
      `).bind(
        currentHistoryId, parsed.data.targetRecordingId, session.id, actor, session.revision,
      ),
      context.env.DB.prepare(`
        UPDATE recording_upload_sessions
        SET status = 'failed', duplicate_media_id = NULL,
            error_code = 'user_discarded', revision = revision + 1,
            updated_at = ?, updated_by = ?
        WHERE id = ? AND created_by = ? AND status = 'duplicate' AND revision = ?
          AND EXISTS (
            SELECT 1 FROM recordings
            WHERE id = ? AND original_media_id = ?
              AND playback_media_id IS ? AND revision = ?
          )
      `).bind(
        timestamp, actor, session.id, actor, session.revision,
        parsed.data.targetRecordingId, duplicate.historyOriginalMediaId,
        duplicate.historyPlaybackMediaId, current.revision + 1,
      ),
      context.env.DB.prepare(`
        UPDATE songs SET updated_at = ?, updated_by = ?
        WHERE id = ? AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM recording_upload_sessions
            WHERE id = ? AND status = 'failed' AND error_code = 'user_discarded'
          )
      `).bind(timestamp, actor, songId, session.id),
    ]);
    if (results[1].meta.changes === 0 || results[4].meta.changes === 0) {
      return context.json({ error: "recording_conflict" }, 409);
    }
  } catch (error) {
    const reconciled = await context.env.DB.prepare(`
      SELECT recordings.revision
      FROM recordings
      JOIN recording_upload_sessions ON recording_upload_sessions.id = ?
      WHERE recordings.id = ? AND recordings.song_id = ?
        AND recordings.original_media_id = ?
        AND recordings.playback_media_id IS ?
        AND recordings.revision = ?
        AND recording_upload_sessions.status = 'failed'
        AND recording_upload_sessions.error_code = 'user_discarded'
    `).bind(
      session.id, parsed.data.targetRecordingId, songId,
      duplicate.historyOriginalMediaId, duplicate.historyPlaybackMediaId,
      current.revision + 1,
    ).first<{ revision: number }>().catch(() => null);
    if (!reconciled) {
      const mapped = recordingWriteError(error);
      return context.json({ error: mapped.error }, mapped.status);
    }
  }
  return context.json({
    recording: {
      id: parsed.data.targetRecordingId,
      revision: current.revision + 1,
      processingState: "ready",
    },
    reusedHistoricalMedia: true,
  });
});

app.post("/api/recording-uploads/:sessionId/abort", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseRecordingUploadRevision(body);
  if (!parsed.success) return context.json({ error: "invalid_recording_upload" }, 400);
  const actor = context.get("appUser").identity;
  const session = await loadRecordingUploadSession(
    context.env.DB, context.req.param("sessionId"), actor,
  );
  if (!session) return context.json({ error: "recording_upload_not_found" }, 404);
  if (session.status === "aborted") {
    return context.json({ upload: publicRecordingUploadSession(session), cleanupDeferred: false });
  }
  if (session.status !== "creating" && session.status !== "open") {
    return context.json({ error: "recording_upload_cannot_abort" }, 409);
  }
  const timestamp = new Date().toISOString();
  let result: D1Result;
  try {
    result = await context.env.DB.prepare(`
      UPDATE recording_upload_sessions
      SET status = 'aborted', revision = revision + 1, updated_at = ?, updated_by = ?
      WHERE id = ? AND created_by = ? AND revision = ? AND status IN ('creating', 'open')
    `).bind(timestamp, actor, session.id, actor, parsed.data.revision).run();
  } catch {
    return context.json({ error: "recording_upload_abort_failed" }, 500);
  }
  if (result.meta.changes === 0) {
    return context.json({ error: "recording_upload_conflict" }, 409);
  }
  let cleanupDeferred = false;
  if (session.uploadId) {
    try {
      await context.env.MEDIA.resumeMultipartUpload(session.objectKey, session.uploadId).abort();
    } catch {
      cleanupDeferred = true;
    }
  }
  const aborted = await loadRecordingUploadSession(context.env.DB, session.id, actor);
  if (!aborted) return context.json({ error: "recording_upload_not_found" }, 404);
  return context.json({ upload: publicRecordingUploadSession(aborted), cleanupDeferred });
});

app.post("/api/recording-uploads/:sessionId/discard", requireRole("editor"), async (context) => (
  discardRecordingUploadSession(context, false)
));

app.post("/api/admin/recording-uploads/:sessionId/discard", requireRole("admin"), async (context) => (
  discardRecordingUploadSession(context, true)
));

app.get("/api/lookups", requireRole("editor"), async (context) => {
  const [languages, tags, notebooks, people] = await Promise.all([
    context.env.DB.prepare(`
      SELECT id, display_name AS name
      FROM languages
      ORDER BY sort_order, display_name COLLATE NOCASE, id
    `).all<{ id: string; name: string }>(),
    context.env.DB.prepare(`
      SELECT id, display_name AS name
      FROM tags
      ORDER BY sort_order, display_name COLLATE NOCASE, id
    `).all<{ id: string; name: string }>(),
    context.env.DB.prepare(`
      SELECT id, display_name AS name
      FROM notebooks
      ORDER BY sort_order, display_name COLLATE NOCASE, id
    `).all<{ id: string; name: string }>(),
    context.env.DB.prepare(`
      SELECT id, full_name AS name
      FROM people
      ORDER BY full_name COLLATE NOCASE, id
    `).all<{ id: string; name: string }>(),
  ]);
  return context.json({
    languages: languages.results,
    tags: tags.results,
    notebooks: notebooks.results,
    people: people.results,
  });
});

app.post("/api/lookups/:kind", requireRole("editor"), async (context) => {
  const kind = parseLookupKind(context.req.param("kind"));
  if (!kind) return context.json({ error: "lookup_not_found" }, 404);

  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseLookupCreate(body);
  if (!parsed.success) {
    return context.json({ error: "invalid_lookup", fields: parsed.fields }, 400);
  }

  const config = LOOKUP_CONFIG[kind];
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  try {
    if (config.ordered) {
      await context.env.DB.prepare(`
        INSERT INTO ${config.table} (id, ${config.nameColumn}, normalized_name, sort_order)
        VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM ${config.table}))
      `).bind(id, parsed.data.name, parsed.data.normalizedName).run();
    } else {
      await context.env.DB.prepare(`
        INSERT INTO people (id, full_name, normalized_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(id, parsed.data.name, parsed.data.normalizedName, timestamp, timestamp).run();
    }
  } catch (error) {
    const mapped = lookupWriteError(error);
    return context.json({ error: mapped.error }, mapped.status);
  }

  return context.json({ item: { id, name: parsed.data.name } }, 201);
});

app.put("/api/lookups/:kind/:id", requireRole("editor"), async (context) => {
  const kind = parseLookupKind(context.req.param("kind"));
  if (!kind) return context.json({ error: "lookup_not_found" }, 404);

  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseLookupUpdate(body);
  if (!parsed.success) {
    return context.json({ error: "invalid_lookup", fields: parsed.fields }, 400);
  }

  const config = LOOKUP_CONFIG[kind];
  try {
    const timestampUpdate = kind === "people" ? ", updated_at = ?" : "";
    const values = kind === "people"
      ? [parsed.data.name, parsed.data.normalizedName, new Date().toISOString(), context.req.param("id"), parsed.data.currentName]
      : [parsed.data.name, parsed.data.normalizedName, context.req.param("id"), parsed.data.currentName];
    const result = await context.env.DB.prepare(`
      UPDATE ${config.table}
      SET ${config.nameColumn} = ?, normalized_name = ?${timestampUpdate}
      WHERE id = ? AND ${config.nameColumn} = ?
    `).bind(...values).run();

    if (result.meta.changes === 0) {
      const current = await context.env.DB.prepare(`
        SELECT ${config.nameColumn} AS name
        FROM ${config.table}
        WHERE id = ?
      `).bind(context.req.param("id")).first<{ name: string }>();
      if (!current) return context.json({ error: "lookup_not_found" }, 404);
      return context.json({ error: "lookup_edit_conflict", currentName: current.name }, 409);
    }
  } catch (error) {
    const mapped = lookupWriteError(error);
    return context.json({ error: mapped.error }, mapped.status);
  }

  return context.json({ item: { id: context.req.param("id"), name: parsed.data.name } });
});

app.post("/api/songs", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseSongCreate(body);
  if (!parsed.success) {
    return context.json({ error: "invalid_song", fields: parsed.fields }, 400);
  }
  const song = parsed.data;
  const [languagesExist, tagsExist, peopleExist] = await Promise.all([
    lookupIdsExist(context.env.DB, "languages", song.languageIds),
    lookupIdsExist(context.env.DB, "tags", song.tagIds),
    lookupIdsExist(context.env.DB, "people", [...new Set(song.credits.map((credit) => credit.personId))]),
  ]);
  if (!languagesExist || !tagsExist || !peopleExist) {
    return context.json({ error: "invalid_reference" }, 400);
  }

  const songId = crypto.randomUUID();
  const mutationId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const actor = context.get("appUser").identity;
  const statements: D1PreparedStatement[] = [context.env.DB.prepare(`
    INSERT INTO songs (
      id, title_latin, normalized_title_latin, title_native, status, notes,
      revision, created_at, created_by, updated_at, updated_by, last_mutation_id
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
  `).bind(
    songId, song.titleLatin, song.normalizedTitleLatin, song.titleNative, song.status, song.notes,
    timestamp, actor, timestamp, actor, mutationId,
  )];
  for (const [sortOrder, languageId] of song.languageIds.entries()) {
    statements.push(context.env.DB.prepare(`
      INSERT INTO song_languages (song_id, language_id, sort_order) VALUES (?, ?, ?)
    `).bind(songId, languageId, sortOrder));
  }
  for (const [sortOrder, tagId] of song.tagIds.entries()) {
    statements.push(context.env.DB.prepare(`
      INSERT INTO song_tags (song_id, tag_id, sort_order) VALUES (?, ?, ?)
    `).bind(songId, tagId, sortOrder));
  }
  for (const [sortOrder, alias] of song.aliases.entries()) {
    statements.push(context.env.DB.prepare(`
      INSERT INTO song_aliases (id, song_id, alias, normalized_alias, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), songId, alias.value, alias.normalizedValue, sortOrder));
  }
  for (const [sortOrder, credit] of song.credits.entries()) {
    statements.push(context.env.DB.prepare(`
      INSERT INTO song_credits (id, song_id, person_id, role, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), songId, credit.personId, credit.role, sortOrder));
  }

  try {
    await context.env.DB.batch(statements);
    return context.json({ song: { id: songId, revision: 1, titleLatin: song.titleLatin } }, 201);
  } catch (error) {
    const response = songWriteError(error);
    return context.json({ error: response.error }, response.status);
  }
});

app.put("/api/songs/:songId", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseSongUpdate(body);
  if (!parsed.success) {
    return context.json({ error: "invalid_song", fields: parsed.fields }, 400);
  }
  const song: SongUpdateInput = parsed.data;
  const [languagesExist, tagsExist, peopleExist] = await Promise.all([
    lookupIdsExist(context.env.DB, "languages", song.languageIds),
    lookupIdsExist(context.env.DB, "tags", song.tagIds),
    lookupIdsExist(context.env.DB, "people", [...new Set(song.credits.map((credit) => credit.personId))]),
  ]);
  if (!languagesExist || !tagsExist || !peopleExist) {
    return context.json({ error: "invalid_reference" }, 400);
  }

  const songId = context.req.param("songId");
  const mutationId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const actor = context.get("appUser").identity;
  const statements: D1PreparedStatement[] = [context.env.DB.prepare(`
    UPDATE songs
    SET title_latin = ?,
        normalized_title_latin = ?,
        title_native = ?,
        status = ?,
        notes = ?,
        revision = revision + 1,
        updated_at = ?,
        updated_by = ?,
        last_mutation_id = ?
    WHERE id = ? AND revision = ? AND trashed_at IS NULL
  `).bind(
    song.titleLatin, song.normalizedTitleLatin, song.titleNative, song.status, song.notes,
    timestamp, actor, mutationId, songId, song.revision,
  )];
  statements.push(...languageStatementsForUpdate(context.env.DB, songId, mutationId, song.languageIds));
  statements.push(...replaceJoinStatements(context.env.DB, "song_tags", songId, mutationId, song));
  statements.push(...replaceJoinStatements(context.env.DB, "song_aliases", songId, mutationId, song));
  statements.push(...creditStatementsForUpdate(context.env.DB, songId, mutationId, song));

  try {
    const results = await context.env.DB.batch(statements);
    if (results[0].meta.changes === 0) {
      const current = await context.env.DB.prepare(`
        SELECT revision FROM songs WHERE id = ? AND trashed_at IS NULL
      `).bind(songId).first<{ revision: number }>();
      if (!current) return context.json({ error: "song_not_found" }, 404);
      return context.json({ error: "edit_conflict", currentRevision: current.revision }, 409);
    }
    return context.json({
      song: { id: songId, revision: song.revision + 1, titleLatin: song.titleLatin },
    });
  } catch (error) {
    const response = songWriteError(error);
    return context.json({ error: response.error }, response.status);
  }
});

app.post("/api/songs/:songId/trash", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseSongRevision(body);
  if (!parsed.success) {
    return context.json({ error: "invalid_song", fields: parsed.fields }, 400);
  }
  const songId = context.req.param("songId");
  const current = await loadSongState(context.env.DB, songId);
  if (!current) return context.json({ error: "song_not_found" }, 404);
  if (current.trashedAt !== null) {
    return context.json({ error: "song_already_trashed", currentRevision: current.revision }, 409);
  }
  if (current.revision !== parsed.data.revision) {
    return context.json({ error: "song_trash_conflict", currentRevision: current.revision }, 409);
  }
  const dependencies = await loadSongDependencies(context.env.DB, songId);
  if (hasSongDependencies(dependencies)) {
    return context.json({ error: "song_has_active_content", dependencies }, 409);
  }

  const timestamp = new Date().toISOString();
  const actor = context.get("appUser").identity;
  try {
    const result = await context.env.DB.prepare(`
      UPDATE songs
      SET trashed_at = ?,
          trashed_by = ?,
          revision = revision + 1,
          updated_at = ?,
          updated_by = ?
      WHERE id = ? AND revision = ? AND trashed_at IS NULL
    `).bind(timestamp, actor, timestamp, actor, songId, parsed.data.revision).run();
    if (result.meta.changes === 0) {
      const state = await loadSongState(context.env.DB, songId);
      if (!state) return context.json({ error: "song_not_found" }, 404);
      if (state.trashedAt !== null) {
        return context.json({ error: "song_already_trashed", currentRevision: state.revision }, 409);
      }
      return context.json({ error: "song_trash_conflict", currentRevision: state.revision }, 409);
    }
    return context.json({ song: { id: songId, revision: parsed.data.revision + 1 } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("song_has_active_recording_upload")) {
      return context.json({ error: "song_has_active_recording_upload" }, 409);
    }
    if (message.includes("song_has_active_content")) {
      return context.json({
        error: "song_has_active_content",
        dependencies: await loadSongDependencies(context.env.DB, songId),
      }, 409);
    }
    return context.json({ error: "song_write_failed" }, 500);
  }
});

app.post("/api/trash/songs/:songId/restore", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseSongRevision(body);
  if (!parsed.success) {
    return context.json({ error: "invalid_song", fields: parsed.fields }, 400);
  }
  const songId = context.req.param("songId");
  const timestamp = new Date().toISOString();
  const actor = context.get("appUser").identity;
  try {
    const result = await context.env.DB.prepare(`
      UPDATE songs
      SET trashed_at = NULL,
          trashed_by = NULL,
          revision = revision + 1,
          updated_at = ?,
          updated_by = ?
      WHERE id = ? AND revision = ? AND trashed_at IS NOT NULL
    `).bind(timestamp, actor, songId, parsed.data.revision).run();
    if (result.meta.changes === 0) {
      const state = await loadSongState(context.env.DB, songId);
      if (!state) return context.json({ error: "song_not_found" }, 404);
      if (state.trashedAt === null) {
        return context.json({ error: "song_not_trashed", currentRevision: state.revision }, 409);
      }
      return context.json({ error: "song_trash_conflict", currentRevision: state.revision }, 409);
    }
    return context.json({ song: { id: songId, revision: parsed.data.revision + 1 } });
  } catch (error) {
    const response = songWriteError(error);
    return context.json({ error: response.error }, response.status);
  }
});

app.post("/api/songs/:songId/lyrics", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseLyricCreate(body);
  if (!parsed.success) {
    return context.json({ error: "invalid_lyric", fields: parsed.fields }, 400);
  }

  const songId = context.req.param("songId");
  const lyricId = parsed.data.clientMutationId ?? crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const actor = context.get("appUser").identity;
  try {
    const results = await context.env.DB.batch([
      context.env.DB.prepare(`
        INSERT INTO lyric_texts (
          id, song_id, content, origin, sort_order, revision,
          created_at, created_by, updated_at, updated_by
        )
        SELECT
          ?, songs.id, ?, 'user',
          COALESCE((
            SELECT MAX(existing.sort_order) + 1
            FROM lyric_texts AS existing
            WHERE existing.song_id = songs.id
          ), 0),
          1, ?, ?, ?, ?
        FROM songs
        WHERE songs.id = ? AND songs.trashed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM lyric_texts WHERE id = ?)
      `).bind(
        lyricId, parsed.data.content,
        timestamp, actor, timestamp, actor,
        songId, lyricId,
      ),
      context.env.DB.prepare(`
        UPDATE songs
        SET updated_at = ?, updated_by = ?
        WHERE id = ? AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM lyric_texts
            WHERE id = ? AND song_id = songs.id
              AND created_at = ? AND created_by = ? AND revision = 1
          )
      `).bind(timestamp, actor, songId, lyricId, timestamp, actor),
    ]);
    if (results[0].meta.changes === 0) {
      if (parsed.data.clientMutationId) {
        const replay = await loadLyricCreateReplay(context.env.DB, lyricId);
        if (lyricCreateReplayMatches(replay, songId, parsed.data.content, actor)) {
          return context.json({ lyric: { id: lyricId, revision: 1 } });
        }
        if (replay) return context.json({ error: "lyric_mutation_conflict" }, 409);
      }
      return context.json({ error: "song_not_found" }, 404);
    }
    return context.json({ lyric: { id: lyricId, revision: 1 } }, 201);
  } catch (error) {
    if (parsed.data.clientMutationId) {
      const replay = await loadLyricCreateReplay(context.env.DB, lyricId).catch(() => null);
      if (lyricCreateReplayMatches(replay, songId, parsed.data.content, actor)) {
        return context.json({ lyric: { id: lyricId, revision: 1 } });
      }
      if (replay) return context.json({ error: "lyric_mutation_conflict" }, 409);
    }
    const response = lyricWriteError(error);
    return context.json({ error: response.error }, response.status);
  }
});

app.post("/api/songs/:songId/scans", requireRole("editor"), async (context) => {
  if (scanUploadRequestIsTooLarge(context.req.header("Content-Length"))) {
    return context.json({ error: "scan_file_too_large", fields: { file: ["The maximum Scan size is 20 MB"] } }, 413);
  }
  let form: FormData;
  try {
    form = await context.req.formData();
  } catch {
    return context.json({ error: "invalid_scan_upload" }, 400);
  }

  const fileValue = form.get("file");
  if (!(fileValue instanceof File)) {
    return context.json({ error: "scan_file_required", fields: { file: ["Choose an image file"] } }, 400);
  }
  if (fileValue.size === 0) {
    return context.json({ error: "empty_scan_file", fields: { file: ["The selected file is empty"] } }, 400);
  }
  if (fileValue.size > MAX_SCAN_UPLOAD_BYTES) {
    return context.json({ error: "scan_file_too_large", fields: { file: ["The maximum Scan size is 20 MB"] } }, 413);
  }

  const parsed = parseScanCreate({
    notebookId: typeof form.get("notebookId") === "string" ? form.get("notebookId") : null,
    pageLabel: typeof form.get("pageLabel") === "string" ? form.get("pageLabel") : null,
  });
  if (!parsed.success) {
    return context.json({ error: "invalid_scan", fields: parsed.fields }, 400);
  }
  if (parsed.data.notebookId
    && !await lookupIdsExist(context.env.DB, "notebooks", [parsed.data.notebookId])) {
    return context.json({ error: "invalid_scan_reference" }, 400);
  }

  const songId = context.req.param("songId");
  const activeSong = await context.env.DB.prepare(`
    SELECT id FROM songs WHERE id = ? AND trashed_at IS NULL
  `).bind(songId).first<{ id: string }>();
  if (!activeSong) return context.json({ error: "song_not_found" }, 404);

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await fileValue.arrayBuffer());
  } catch {
    return context.json({ error: "scan_file_unreadable" }, 400);
  }
  const imageType = inspectScanImage(bytes);
  if (!imageType) {
    return context.json({
      error: "unsupported_scan_file",
      fields: { file: ["Use a JPEG, PNG, or WebP image with a recognized file signature"] },
    }, 415);
  }

  const fingerprint = await sha256Hex(bytes);
  const duplicate = await loadDuplicateScan(context.env.DB, fingerprint, bytes.byteLength);
  if (duplicate) {
    if (duplicate.scanId === null
      || duplicate.songId === null
      || duplicate.songTitle === null
      || duplicate.scanRevision === null) {
      return context.json({
        error: "duplicate_scan_file",
        fields: { file: ["This file is already retained in the library"] },
      }, 409);
    }
    return context.json({
      error: "duplicate_scan_file",
      existing: {
        scanId: duplicate.scanId,
        songId: duplicate.songId,
        songTitle: duplicate.songTitle,
        filename: duplicate.filename,
        notebookName: duplicate.notebookName,
            pageLabel: duplicate.pageLabel,
            revision: duplicate.scanRevision,
            isTrashed: Boolean(duplicate.scanIsTrashed || duplicate.songIsTrashed),
            isHistorical: duplicate.isHistorical === 1,
          },
    }, 409);
  }

  let readability: ScanReadabilityDerivative;
  try {
    readability = await createScanReadabilityDerivative(context.env.IMAGES, bytes);
  } catch (error) {
    const mapped = scanReadabilityError(error);
    return context.json({ error: mapped.error }, mapped.status);
  }

  const scanId = crypto.randomUUID();
  const mediaId = crypto.randomUUID();
  const objectKey = `scans/${mediaId}.${imageType.extension}`;
  const readabilityObjectKey = scanReadabilityObjectKey(mediaId);
  const filename = safeUploadFilename(fileValue.name, imageType.extension);
  const timestamp = new Date().toISOString();
  const actor = context.get("appUser").identity;

  try {
    await Promise.all([
      context.env.MEDIA.put(objectKey, bytes, {
        httpMetadata: {
          contentType: imageType.mimeType,
          contentDisposition: "inline",
        },
      }),
      context.env.MEDIA.put(readabilityObjectKey, readability.bytes, {
        httpMetadata: {
          contentType: readability.mimeType,
          contentDisposition: "inline",
        },
      }),
    ]);
  } catch {
    await removeUncommittedScanObjects(context.env.MEDIA, objectKey, readabilityObjectKey);
    return context.json({ error: "scan_storage_failed" }, 503);
  }

  try {
    const results = await context.env.DB.batch([
      context.env.DB.prepare(`
        INSERT INTO media_objects (
          id, object_key, original_filename, mime_type, byte_size, sha256,
          kind, state, created_at, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, 'scan', 'active', ?, ?)
      `).bind(
        mediaId, objectKey, filename, imageType.mimeType, bytes.byteLength, fingerprint,
        timestamp, actor,
      ),
      scanReadabilityInsert(
        context.env.DB,
        mediaId,
        fingerprint,
        bytes.byteLength,
        readabilityObjectKey,
        readability,
        timestamp,
        actor,
      ),
      context.env.DB.prepare(`
        INSERT INTO scans (
          id, song_id, media_id, notebook_id, page_label, revision,
          created_at, created_by, updated_at, updated_by
        )
        SELECT ?, songs.id, ?, ?, ?, 1, ?, ?, ?, ?
        FROM songs
        WHERE songs.id = ? AND songs.trashed_at IS NULL
      `).bind(
        scanId, mediaId, parsed.data.notebookId, parsed.data.pageLabel,
        timestamp, actor, timestamp, actor, songId,
      ),
      context.env.DB.prepare(`
        UPDATE songs
        SET updated_at = ?, updated_by = ?
        WHERE id = ? AND trashed_at IS NULL
          AND EXISTS (SELECT 1 FROM scans WHERE id = ? AND song_id = songs.id)
      `).bind(timestamp, actor, songId, scanId),
    ]);
    if (results[2].meta.changes === 0) {
      await removeUncommittedScanResources(
        context.env.DB, context.env.MEDIA, mediaId, objectKey, readabilityObjectKey,
      );
      return context.json({ error: "song_not_found" }, 404);
    }
  } catch (error) {
    await removeUncommittedScanResources(
      context.env.DB, context.env.MEDIA, mediaId, objectKey, readabilityObjectKey,
    );
    const response = scanWriteError(error);
    return context.json({ error: response.error }, response.status);
  }

  return context.json({
    scan: { id: scanId, mediaId, revision: 1, filename },
  }, 201);
});

app.put("/api/songs/:songId/lyrics/:lyricId", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseLyricUpdate(body);
  if (!parsed.success) {
    return context.json({ error: "invalid_lyric", fields: parsed.fields }, 400);
  }
  const lyric: LyricUpdateInput = parsed.data;
  const songId = context.req.param("songId");
  const lyricId = context.req.param("lyricId");
  const timestamp = new Date().toISOString();
  const actor = context.get("appUser").identity;

  try {
    const results = await context.env.DB.batch([
      context.env.DB.prepare(`
        UPDATE lyric_texts
        SET content = ?,
            revision = revision + 1,
            updated_at = ?,
            updated_by = ?
        WHERE id = ?
          AND song_id = ?
          AND revision = ?
          AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM songs
            WHERE songs.id = lyric_texts.song_id AND songs.trashed_at IS NULL
          )
      `).bind(lyric.content, timestamp, actor, lyricId, songId, lyric.revision),
      context.env.DB.prepare(`
        UPDATE songs
        SET updated_at = ?, updated_by = ?
        WHERE id = ? AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM lyric_texts
            WHERE id = ?
              AND song_id = songs.id
              AND revision = ?
              AND updated_at = ?
              AND updated_by = ?
          )
      `).bind(timestamp, actor, songId, lyricId, lyric.revision + 1, timestamp, actor),
    ]);
    if (results[0].meta.changes === 0) {
      const current = await context.env.DB.prepare(`
        SELECT lyric_texts.revision
        FROM lyric_texts
        JOIN songs ON songs.id = lyric_texts.song_id
        WHERE lyric_texts.id = ?
          AND lyric_texts.song_id = ?
          AND lyric_texts.trashed_at IS NULL
          AND songs.trashed_at IS NULL
      `).bind(lyricId, songId).first<{ revision: number }>();
      if (!current) return context.json({ error: "lyric_not_found" }, 404);
      return context.json({ error: "lyric_edit_conflict", currentRevision: current.revision }, 409);
    }
    return context.json({ lyric: { id: lyricId, revision: lyric.revision + 1 } });
  } catch (error) {
    const response = lyricWriteError(error);
    return context.json({ error: response.error }, response.status);
  }
});

app.put("/api/songs/:songId/scans/:scanId", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseScanUpdate(body);
  if (!parsed.success) {
    return context.json({ error: "invalid_scan", fields: parsed.fields }, 400);
  }
  const scan: ScanUpdateInput = parsed.data;
  if (scan.notebookId && !await lookupIdsExist(context.env.DB, "notebooks", [scan.notebookId])) {
    return context.json({ error: "invalid_scan_reference" }, 400);
  }

  const songId = context.req.param("songId");
  const scanId = context.req.param("scanId");
  const timestamp = new Date().toISOString();
  const actor = context.get("appUser").identity;
  try {
    const results = await context.env.DB.batch([
      context.env.DB.prepare(`
        UPDATE scans
        SET notebook_id = ?,
            page_label = ?,
            revision = revision + 1,
            updated_at = ?,
            updated_by = ?
        WHERE id = ?
          AND song_id = ?
          AND revision = ?
          AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM songs
            WHERE songs.id = scans.song_id AND songs.trashed_at IS NULL
          )
      `).bind(
        scan.notebookId, scan.pageLabel, timestamp, actor,
        scanId, songId, scan.revision,
      ),
      context.env.DB.prepare(`
        UPDATE songs
        SET updated_at = ?, updated_by = ?
        WHERE id = ? AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM scans
            WHERE id = ?
              AND song_id = songs.id
              AND revision = ?
              AND updated_at = ?
              AND updated_by = ?
          )
      `).bind(timestamp, actor, songId, scanId, scan.revision + 1, timestamp, actor),
    ]);
    if (results[0].meta.changes === 0) {
      const current = await loadScanState(context.env.DB, songId, scanId);
      if (!current || current.trashedAt !== null || current.songTrashedAt !== null) {
        return context.json({ error: "scan_not_found" }, 404);
      }
      return context.json({ error: "scan_edit_conflict", currentRevision: current.revision }, 409);
    }
    return context.json({ scan: { id: scanId, revision: scan.revision + 1 } });
  } catch (error) {
    const response = scanWriteError(error);
    return context.json({ error: response.error }, response.status);
  }
});

app.put("/api/songs/:songId/scans/:scanId/orientation", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseScanOrientation(body);
  if (!parsed.success) {
    return context.json({ error: "invalid_scan_orientation", fields: parsed.fields }, 400);
  }

  const songId = context.req.param("songId");
  const scanId = context.req.param("scanId");
  const timestamp = new Date().toISOString();
  const actor = context.get("appUser").identity;
  const { revision, rotationQuarterTurns } = parsed.data;

  try {
    const results = await context.env.DB.batch([
      context.env.DB.prepare(`
        UPDATE scans
        SET rotation_quarter_turns = ?,
            revision = revision + 1,
            updated_at = ?,
            updated_by = ?
        WHERE id = ?
          AND song_id = ?
          AND revision = ?
          AND rotation_quarter_turns <> ?
          AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM songs
            WHERE songs.id = scans.song_id AND songs.trashed_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM media_objects
            WHERE media_objects.id = scans.media_id
              AND media_objects.kind = 'scan'
              AND media_objects.state = 'active'
          )
      `).bind(
        rotationQuarterTurns, timestamp, actor,
        scanId, songId, revision, rotationQuarterTurns,
      ),
      context.env.DB.prepare(`
        UPDATE songs
        SET updated_at = ?, updated_by = ?
        WHERE id = ? AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM scans
            WHERE id = ?
              AND song_id = songs.id
              AND revision = ?
              AND rotation_quarter_turns = ?
              AND updated_at = ?
              AND updated_by = ?
          )
      `).bind(
        timestamp, actor, songId, scanId, revision + 1,
        rotationQuarterTurns, timestamp, actor,
      ),
    ]);

    if (results[0].meta.changes === 0) {
      const current = await loadScanState(context.env.DB, songId, scanId);
      if (!current || current.trashedAt !== null || current.songTrashedAt !== null) {
        return context.json({ error: "scan_not_found" }, 404);
      }
      if (current.mediaState !== "active") {
        return context.json({ error: "scan_media_unavailable" }, 409);
      }
      if (current.revision === revision
        && current.rotationQuarterTurns === rotationQuarterTurns) {
        return context.json({
          scan: { id: scanId, revision, rotationQuarterTurns },
        });
      }
      return context.json({ error: "scan_edit_conflict", currentRevision: current.revision }, 409);
    }

    return context.json({
      scan: { id: scanId, revision: revision + 1, rotationQuarterTurns },
    });
  } catch (error) {
    const response = scanWriteError(error);
    return context.json({ error: response.error }, response.status);
  }
});

app.put("/api/songs/:songId/recordings/:recordingId", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseRecordingUpdate(body);
  if (!parsed.success) {
    return context.json({ error: "invalid_recording", fields: parsed.fields }, 400);
  }
  const recording: RecordingUpdateInput = parsed.data;
  if (!await lookupIdsExist(context.env.DB, "people", recording.creditPersonIds)) {
    return context.json({ error: "invalid_recording_reference" }, 400);
  }

  const songId = context.req.param("songId");
  const recordingId = context.req.param("recordingId");
  const timestamp = new Date().toISOString();
  const actor = context.get("appUser").identity;
  const newRevision = recording.revision + 1;
  const statements: D1PreparedStatement[] = [context.env.DB.prepare(`
    UPDATE recordings
    SET description = ?,
        normalized_description = ?,
        recorded_on = ?,
        revision = revision + 1,
        updated_at = ?,
        updated_by = ?
    WHERE id = ?
      AND song_id = ?
      AND revision = ?
      AND trashed_at IS NULL
      AND EXISTS (
        SELECT 1 FROM songs
        WHERE songs.id = recordings.song_id AND songs.trashed_at IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM media_objects
        WHERE media_objects.id = recordings.original_media_id
          AND media_objects.kind = 'original_audio'
          AND media_objects.state = 'active'
      )
      AND (
        recordings.playback_media_id IS NULL
        OR EXISTS (
          SELECT 1 FROM media_objects
          WHERE media_objects.id = recordings.playback_media_id
            AND media_objects.state = 'active'
        )
      )
  `).bind(
    recording.description, recording.normalizedDescription, recording.recordedOn,
    timestamp, actor, recordingId, songId, recording.revision,
  ), context.env.DB.prepare(`
    DELETE FROM recording_credits
    WHERE recording_id = ? AND role = 'vocals'
      AND EXISTS (
        SELECT 1 FROM recordings
        WHERE recordings.id = recording_credits.recording_id
          AND recordings.song_id = ?
          AND recordings.revision = ?
          AND recordings.updated_at = ?
          AND recordings.updated_by = ?
          AND recordings.trashed_at IS NULL
      )
  `).bind(recordingId, songId, newRevision, timestamp, actor)];
  for (const [sortOrder, personId] of recording.creditPersonIds.entries()) {
    statements.push(context.env.DB.prepare(`
      INSERT INTO recording_credits (id, recording_id, person_id, role, sort_order)
      SELECT ?, recordings.id, ?, 'vocals', ?
      FROM recordings
      WHERE recordings.id = ?
        AND recordings.song_id = ?
        AND recordings.revision = ?
        AND recordings.updated_at = ?
        AND recordings.updated_by = ?
        AND recordings.trashed_at IS NULL
    `).bind(
      crypto.randomUUID(), personId, sortOrder,
      recordingId, songId, newRevision, timestamp, actor,
    ));
  }
  statements.push(context.env.DB.prepare(`
    UPDATE songs
    SET updated_at = ?, updated_by = ?
    WHERE id = ? AND trashed_at IS NULL
      AND EXISTS (
        SELECT 1 FROM recordings
        WHERE id = ?
          AND song_id = songs.id
          AND revision = ?
          AND updated_at = ?
          AND updated_by = ?
          AND trashed_at IS NULL
      )
  `).bind(timestamp, actor, songId, recordingId, newRevision, timestamp, actor));

  try {
    const results = await context.env.DB.batch(statements);
    if (results[0].meta.changes === 0) {
      const current = await loadRecordingState(context.env.DB, songId, recordingId);
      if (!current || current.trashedAt !== null || current.songTrashedAt !== null) {
        return context.json({ error: "recording_not_found" }, 404);
      }
      if (current.originalMediaState !== "active" || current.playbackMediaState === "trashed") {
        return context.json({ error: "recording_media_unavailable" }, 409);
      }
      return context.json({ error: "recording_edit_conflict", currentRevision: current.revision }, 409);
    }
    return context.json({ recording: { id: recordingId, revision: newRevision } });
  } catch (error) {
    const response = recordingWriteError(error);
    return context.json({ error: response.error }, response.status);
  }
});

app.post("/api/songs/:songId/lyrics/:lyricId/trash", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseLyricRevision(body);
  if (!parsed.success) {
    return context.json({ error: "invalid_lyric", fields: parsed.fields }, 400);
  }
  const songId = context.req.param("songId");
  const lyricId = context.req.param("lyricId");
  const timestamp = new Date().toISOString();
  const actor = context.get("appUser").identity;

  try {
    const results = await context.env.DB.batch([
      context.env.DB.prepare(`
        UPDATE lyric_texts
        SET trashed_at = ?,
            trashed_by = ?,
            revision = revision + 1,
            updated_at = ?,
            updated_by = ?
        WHERE id = ?
          AND song_id = ?
          AND revision = ?
          AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM songs
            WHERE songs.id = lyric_texts.song_id AND songs.trashed_at IS NULL
          )
      `).bind(timestamp, actor, timestamp, actor, lyricId, songId, parsed.data.revision),
      context.env.DB.prepare(`
        UPDATE songs
        SET updated_at = ?, updated_by = ?
        WHERE id = ? AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM lyric_texts
            WHERE id = ?
              AND song_id = songs.id
              AND revision = ?
              AND trashed_at = ?
              AND trashed_by = ?
          )
      `).bind(timestamp, actor, songId, lyricId, parsed.data.revision + 1, timestamp, actor),
    ]);
    if (results[0].meta.changes === 0) {
      const current = await loadLyricState(context.env.DB, songId, lyricId);
      if (!current || current.songTrashedAt !== null) {
        return context.json({ error: "lyric_not_found" }, 404);
      }
      if (current.trashedAt !== null) {
        return context.json({ error: "lyric_already_trashed", currentRevision: current.revision }, 409);
      }
      return context.json({ error: "lyric_edit_conflict", currentRevision: current.revision }, 409);
    }
    return context.json({ lyric: { id: lyricId, revision: parsed.data.revision + 1 } });
  } catch (error) {
    const response = lyricWriteError(error);
    return context.json({ error: response.error }, response.status);
  }
});
app.post("/api/songs/:songId/scans/:scanId/media", requireRole("editor"), async (context) => {
  if (scanUploadRequestIsTooLarge(context.req.header("Content-Length"))) {
    return context.json({ error: "scan_file_too_large", fields: { file: ["The maximum Scan size is 20 MB"] } }, 413);
  }
  let form: FormData;
  try {
    form = await context.req.formData();
  } catch {
    return context.json({ error: "invalid_scan_upload" }, 400);
  }

  const fileValue = form.get("file");
  if (!(fileValue instanceof File)) {
    return context.json({ error: "scan_file_required", fields: { file: ["Choose an image file"] } }, 400);
  }
  if (fileValue.size === 0) {
    return context.json({ error: "empty_scan_file", fields: { file: ["The selected file is empty"] } }, 400);
  }
  if (fileValue.size > MAX_SCAN_UPLOAD_BYTES) {
    return context.json({ error: "scan_file_too_large", fields: { file: ["The maximum Scan size is 20 MB"] } }, 413);
  }

  const parsed = parseScanRevision({
    revision: typeof form.get("revision") === "string" ? parseInt(form.get("revision") as string, 10) : undefined,
  });
  if (!parsed.success) {
    return context.json({ error: "invalid_scan", fields: parsed.fields }, 400);
  }

  const songId = context.req.param("songId");
  const scanId = context.req.param("scanId");
  const actor = context.get("appUser").identity;

  const currentScan = await context.env.DB.prepare(`
    SELECT scans.revision, scans.media_id, media_objects.sha256
    FROM scans
    JOIN songs ON songs.id = scans.song_id
    JOIN media_objects ON media_objects.id = scans.media_id
    WHERE scans.id = ? AND scans.song_id = ? AND scans.trashed_at IS NULL AND songs.trashed_at IS NULL
  `).bind(scanId, songId).first<{ revision: number; media_id: string; sha256: string | null }>();

  if (!currentScan) return context.json({ error: "scan_not_found" }, 404);
  if (currentScan.revision !== parsed.data.revision) return context.json({ error: "scan_conflict" }, 409);

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await fileValue.arrayBuffer());
  } catch {
    return context.json({ error: "scan_file_unreadable" }, 400);
  }
  const imageType = inspectScanImage(bytes);
  if (!imageType) {
    return context.json({
      error: "unsupported_scan_file",
      fields: { file: ["Use a JPEG, PNG, or WebP image with a recognized file signature"] },
    }, 415);
  }

  const fingerprint = await sha256Hex(bytes);
  if (fingerprint === currentScan.sha256) {
    return context.json({ error: "duplicate_scan_file", fields: { file: ["This file is identical to the current scan media"] } }, 409);
  }
  const duplicateScan = await loadDuplicateScan(context.env.DB, fingerprint, bytes.byteLength);
  if (
    duplicateScan?.scanId === scanId
    && duplicateScan.historyId !== null
    && duplicateScan.isHistorical === 1
    && duplicateScan.representationPriority === 0
  ) {
    if (await reuseHistoricalScanMedia(
      context.env.DB,
      songId,
      scanId,
      parsed.data.revision,
      duplicateScan.mediaId,
      actor,
    )) {
      return context.json({
        scan: { id: scanId, revision: parsed.data.revision + 1 },
        reusedHistoricalMedia: true,
      });
    }
    return context.json({ error: "scan_conflict" }, 409);
  }
  if (duplicateScan) {
    return context.json({
      error: "duplicate_scan_file",
      fields: { file: ["This file is already retained elsewhere in the library"] },
      ...(duplicateScan.scanId !== null
        && duplicateScan.songId !== null
        && duplicateScan.songTitle !== null
        && duplicateScan.scanRevision !== null
        ? {
            existing: {
              scanId: duplicateScan.scanId,
              songId: duplicateScan.songId,
              songTitle: duplicateScan.songTitle,
              filename: duplicateScan.filename,
              notebookName: duplicateScan.notebookName,
              pageLabel: duplicateScan.pageLabel,
              revision: duplicateScan.scanRevision,
              isTrashed: Boolean(duplicateScan.scanIsTrashed || duplicateScan.songIsTrashed),
              isHistorical: duplicateScan.isHistorical === 1,
            },
          }
        : {}),
    }, 409);
  }

  let readability: ScanReadabilityDerivative;
  try {
    readability = await createScanReadabilityDerivative(context.env.IMAGES, bytes);
  } catch (error) {
    const mapped = scanReadabilityError(error);
    return context.json({ error: mapped.error }, mapped.status);
  }

  const mediaId = crypto.randomUUID();
  const historyId = crypto.randomUUID();
  const objectKey = `scans/${mediaId}.${imageType.extension}`;
  const readabilityObjectKey = scanReadabilityObjectKey(mediaId);
  const filename = safeUploadFilename(fileValue.name, imageType.extension);
  const timestamp = new Date().toISOString();

  try {
    await Promise.all([
      context.env.MEDIA.put(objectKey, bytes, {
        httpMetadata: {
          contentType: imageType.mimeType,
          contentDisposition: "inline",
        },
      }),
      context.env.MEDIA.put(readabilityObjectKey, readability.bytes, {
        httpMetadata: {
          contentType: readability.mimeType,
          contentDisposition: "inline",
        },
      }),
    ]);
  } catch {
    await removeUncommittedScanObjects(context.env.MEDIA, objectKey, readabilityObjectKey);
    return context.json({ error: "scan_storage_failed" }, 503);
  }

  try {
    const results = await context.env.DB.batch([
      context.env.DB.prepare(`
        INSERT INTO media_objects (
          id, object_key, original_filename, mime_type, byte_size, sha256,
          kind, state, created_at, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, 'scan', 'active', ?, ?)
      `).bind(
        mediaId, objectKey, filename, imageType.mimeType, bytes.byteLength, fingerprint,
        timestamp, actor,
      ),
      scanReadabilityInsert(
        context.env.DB,
        mediaId,
        fingerprint,
        bytes.byteLength,
        readabilityObjectKey,
        readability,
        timestamp,
        actor,
      ),
      context.env.DB.prepare(`
        INSERT INTO scan_media_history (
          id, scan_id, media_id, replaced_at, replaced_by, revision_at_replacement
        )
        SELECT ?, id, media_id, ?, ?, revision
        FROM scans
        WHERE id = ? AND song_id = ? AND revision = ? AND trashed_at IS NULL
      `).bind(historyId, timestamp, actor, scanId, songId, parsed.data.revision),
      context.env.DB.prepare(`
        UPDATE scans
        SET media_id = ?, rotation_quarter_turns = 0,
            revision = revision + 1, updated_at = ?, updated_by = ?
        WHERE id = ? AND song_id = ? AND revision = ? AND trashed_at IS NULL
          AND EXISTS (SELECT 1 FROM songs WHERE id = ? AND trashed_at IS NULL)
      `).bind(mediaId, timestamp, actor, scanId, songId, parsed.data.revision, songId),
      context.env.DB.prepare(`
        UPDATE songs
        SET updated_at = ?, updated_by = ?
        WHERE id = ? AND trashed_at IS NULL
          AND EXISTS (SELECT 1 FROM scans WHERE id = ? AND song_id = songs.id)
      `).bind(timestamp, actor, songId, scanId),
    ]);
    if (results[3].meta.changes === 0) {
      await removeUncommittedScanResources(
        context.env.DB, context.env.MEDIA, mediaId, objectKey, readabilityObjectKey,
      );
      return context.json({ error: "scan_conflict" }, 409);
    }
  } catch (error) {
    await removeUncommittedScanResources(
      context.env.DB, context.env.MEDIA, mediaId, objectKey, readabilityObjectKey,
    );
    const mapped = scanWriteError(error);
    return context.json({ error: mapped.error }, mapped.status);
  }

  const updated = await loadScanState(context.env.DB, songId, scanId);
  if (!updated) return context.json({ error: "scan_not_found" }, 404);
  return context.json({ scan: { id: scanId, revision: updated.revision } });
});

app.post("/api/songs/:songId/scans/:scanId/trash", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseScanRevision(body);
  if (!parsed.success) {
    return context.json({ error: "invalid_scan", fields: parsed.fields }, 400);
  }
  const songId = context.req.param("songId");
  const scanId = context.req.param("scanId");
  const timestamp = new Date().toISOString();
  const actor = context.get("appUser").identity;

  try {
    const results = await context.env.DB.batch([
      context.env.DB.prepare(`
        UPDATE scans
        SET trashed_at = ?,
            trashed_by = ?,
            revision = revision + 1,
            updated_at = ?,
            updated_by = ?
        WHERE id = ?
          AND song_id = ?
          AND revision = ?
          AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM songs
            WHERE songs.id = scans.song_id AND songs.trashed_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM media_objects
            WHERE media_objects.id = scans.media_id
              AND media_objects.kind = 'scan'
              AND media_objects.state = 'active'
          )
      `).bind(timestamp, actor, timestamp, actor, scanId, songId, parsed.data.revision),
      context.env.DB.prepare(`
        UPDATE media_objects
        SET state = 'trashed', trashed_at = ?, trashed_by = ?
        WHERE kind = 'scan' AND state = 'active'
          AND id = (
            SELECT media_id FROM scans
            WHERE id = ?
              AND song_id = ?
              AND revision = ?
              AND trashed_at = ?
              AND trashed_by = ?
          )
      `).bind(timestamp, actor, scanId, songId, parsed.data.revision + 1, timestamp, actor),
      context.env.DB.prepare(`
        UPDATE songs
        SET updated_at = ?, updated_by = ?
        WHERE id = ? AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM scans
            WHERE id = ?
              AND song_id = songs.id
              AND revision = ?
              AND trashed_at = ?
              AND trashed_by = ?
          )
      `).bind(timestamp, actor, songId, scanId, parsed.data.revision + 1, timestamp, actor),
    ]);
    if (results[0].meta.changes === 0) {
      const current = await loadScanState(context.env.DB, songId, scanId);
      if (!current || current.songTrashedAt !== null) {
        return context.json({ error: "scan_not_found" }, 404);
      }
      if (current.trashedAt !== null) {
        return context.json({ error: "scan_already_trashed", currentRevision: current.revision }, 409);
      }
      if (current.mediaState !== "active") {
        return context.json({ error: "scan_media_unavailable" }, 409);
      }
      return context.json({ error: "scan_edit_conflict", currentRevision: current.revision }, 409);
    }
    return context.json({ scan: { id: scanId, revision: parsed.data.revision + 1 } });
  } catch (error) {
    const response = scanWriteError(error);
    return context.json({ error: response.error }, response.status);
  }
});

app.post("/api/songs/:songId/recordings/:recordingId/trash", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseRecordingRevision(body);
  if (!parsed.success) {
    return context.json({ error: "invalid_recording", fields: parsed.fields }, 400);
  }
  const songId = context.req.param("songId");
  const recordingId = context.req.param("recordingId");
  const timestamp = new Date().toISOString();
  const actor = context.get("appUser").identity;
  const newRevision = parsed.data.revision + 1;

  try {
    const results = await context.env.DB.batch([
      context.env.DB.prepare(`
        UPDATE recordings
        SET trashed_at = ?,
            trashed_by = ?,
            revision = revision + 1,
            updated_at = ?,
            updated_by = ?
        WHERE id = ?
          AND song_id = ?
          AND revision = ?
          AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM songs
            WHERE songs.id = recordings.song_id AND songs.trashed_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM media_objects
            WHERE media_objects.id = recordings.original_media_id
              AND media_objects.state = 'active'
          )
          AND (
            recordings.playback_media_id IS NULL
            OR EXISTS (
              SELECT 1 FROM media_objects
              WHERE media_objects.id = recordings.playback_media_id
                AND media_objects.state = 'active'
            )
          )
      `).bind(timestamp, actor, timestamp, actor, recordingId, songId, parsed.data.revision),
      context.env.DB.prepare(`
        UPDATE media_objects
        SET state = 'trashed', trashed_at = ?, trashed_by = ?
        WHERE state = 'active'
          AND id IN (
            SELECT original_media_id FROM recordings
            WHERE id = ? AND song_id = ? AND revision = ?
              AND trashed_at = ? AND trashed_by = ?
            UNION
            SELECT playback_media_id FROM recordings
            WHERE id = ? AND song_id = ? AND revision = ?
              AND trashed_at = ? AND trashed_by = ?
              AND playback_media_id IS NOT NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM recordings AS active_recordings
            WHERE active_recordings.trashed_at IS NULL
              AND (
                active_recordings.original_media_id = media_objects.id
                OR active_recordings.playback_media_id = media_objects.id
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM scans
            WHERE scans.trashed_at IS NULL AND scans.media_id = media_objects.id
          )
      `).bind(
        timestamp, actor,
        recordingId, songId, newRevision, timestamp, actor,
        recordingId, songId, newRevision, timestamp, actor,
      ),
      context.env.DB.prepare(`
        UPDATE songs
        SET updated_at = ?, updated_by = ?
        WHERE id = ? AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM recordings
            WHERE id = ? AND song_id = songs.id AND revision = ?
              AND trashed_at = ? AND trashed_by = ?
          )
      `).bind(timestamp, actor, songId, recordingId, newRevision, timestamp, actor),
    ]);
    if (results[0].meta.changes === 0) {
      const current = await loadRecordingState(context.env.DB, songId, recordingId);
      if (!current || current.songTrashedAt !== null) {
        return context.json({ error: "recording_not_found" }, 404);
      }
      if (current.trashedAt !== null) {
        return context.json({ error: "recording_already_trashed", currentRevision: current.revision }, 409);
      }
      if (current.originalMediaState !== "active" || current.playbackMediaState === "trashed") {
        return context.json({ error: "recording_media_unavailable" }, 409);
      }
      return context.json({ error: "recording_edit_conflict", currentRevision: current.revision }, 409);
    }
    return context.json({ recording: { id: recordingId, revision: newRevision } });
  } catch (error) {
    const response = recordingWriteError(error);
    return context.json({ error: response.error }, response.status);
  }
});

app.get("/api/trash", requireRole("editor"), async (context) => {
  const [songs, lyrics, scans, recordings, activeSongs] = await Promise.all([
    context.env.DB.prepare(`
      SELECT
        songs.id,
        songs.title_latin AS titleLatin,
        songs.title_native AS titleNative,
        songs.revision,
        songs.trashed_at AS trashedAt,
        (SELECT COUNT(*) FROM lyric_texts WHERE song_id = songs.id) AS lyricCount,
        (SELECT COUNT(*) FROM scans WHERE song_id = songs.id) AS scanCount,
        (SELECT COUNT(*) FROM recordings WHERE song_id = songs.id) AS recordingCount
      FROM songs
      WHERE songs.trashed_at IS NOT NULL
      ORDER BY songs.trashed_at DESC, songs.id
    `).all<{
      id: string;
      titleLatin: string;
      titleNative: string | null;
      revision: number;
      trashedAt: string;
      lyricCount: number;
      scanCount: number;
      recordingCount: number;
    }>(),
    context.env.DB.prepare(`
      SELECT
        lyric_texts.id,
        lyric_texts.song_id AS songId,
        songs.title_latin AS songTitle,
        lyric_texts.content,
        lyric_texts.origin,
        lyric_texts.revision,
        lyric_texts.trashed_at AS trashedAt,
        CASE WHEN songs.trashed_at IS NULL THEN 0 ELSE 1 END AS songIsTrashed
      FROM lyric_texts
      JOIN songs ON songs.id = lyric_texts.song_id
      WHERE lyric_texts.trashed_at IS NOT NULL
      ORDER BY lyric_texts.trashed_at DESC, lyric_texts.id
    `).all<{
      id: string;
      songId: string;
      songTitle: string;
      content: string;
      origin: "user" | "legacy_import";
      revision: number;
      trashedAt: string;
      songIsTrashed: number;
    }>(),
    context.env.DB.prepare(`
      SELECT
        scans.id,
        scans.song_id AS songId,
        songs.title_latin AS songTitle,
        notebooks.display_name AS notebookName,
        scans.page_label AS pageLabel,
        scans.revision,
        scans.trashed_at AS trashedAt,
        CASE WHEN songs.trashed_at IS NULL THEN 0 ELSE 1 END AS songIsTrashed
      FROM scans
      JOIN songs ON songs.id = scans.song_id
      LEFT JOIN notebooks ON notebooks.id = scans.notebook_id
      WHERE scans.trashed_at IS NOT NULL
      ORDER BY scans.trashed_at DESC, scans.id
    `).all<{
      id: string;
      songId: string;
      songTitle: string;
      notebookName: string | null;
      pageLabel: string | null;
      revision: number;
      trashedAt: string;
      songIsTrashed: number;
    }>(),
    context.env.DB.prepare(`
      SELECT
        recordings.id,
        recordings.song_id AS songId,
        songs.title_latin AS songTitle,
        recordings.description,
        recordings.recorded_on AS recordedOn,
        recordings.revision,
        recordings.trashed_at AS trashedAt,
        CASE WHEN songs.trashed_at IS NULL THEN 0 ELSE 1 END AS songIsTrashed
      FROM recordings
      JOIN songs ON songs.id = recordings.song_id
      WHERE recordings.trashed_at IS NOT NULL
      ORDER BY recordings.trashed_at DESC, recordings.id
    `).all<{
      id: string;
      songId: string;
      songTitle: string;
      description: string;
      recordedOn: string | null;
      revision: number;
      trashedAt: string;
      songIsTrashed: number;
    }>(),
    context.env.DB.prepare(`
      SELECT id, title_latin AS titleLatin, title_native AS titleNative
      FROM songs
      WHERE trashed_at IS NULL
      ORDER BY title_latin COLLATE NOCASE, id
    `).all<{ id: string; titleLatin: string; titleNative: string | null }>(),
  ]);
  return context.json({
    songs: songs.results,
    lyrics: lyrics.results.map((lyric) => ({
      ...lyric,
      songIsTrashed: lyric.songIsTrashed === 1,
    })),
    scans: scans.results.map((scan) => ({
      ...scan,
      songIsTrashed: scan.songIsTrashed === 1,
    })),
    recordings: recordings.results.map((recording) => ({
      ...recording,
      songIsTrashed: recording.songIsTrashed === 1,
    })),
    activeSongs: activeSongs.results,
  });
});

app.post("/api/trash/lyrics/:lyricId/restore", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseLyricRevision(body);
  if (!parsed.success) {
    return context.json({ error: "invalid_lyric", fields: parsed.fields }, 400);
  }
  const lyricId = context.req.param("lyricId");
  const current = await context.env.DB.prepare(`
    SELECT lyric_texts.song_id AS songId
    FROM lyric_texts
    JOIN songs ON songs.id = lyric_texts.song_id
    WHERE lyric_texts.id = ?
  `).bind(lyricId).first<{ songId: string }>();
  if (!current) return context.json({ error: "lyric_not_found" }, 404);

  const timestamp = new Date().toISOString();
  const actor = context.get("appUser").identity;
  try {
    const results = await context.env.DB.batch([
      context.env.DB.prepare(`
        UPDATE lyric_texts
        SET trashed_at = NULL,
            trashed_by = NULL,
            revision = revision + 1,
            updated_at = ?,
            updated_by = ?
        WHERE id = ?
          AND revision = ?
          AND trashed_at IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM songs
            WHERE songs.id = lyric_texts.song_id AND songs.trashed_at IS NULL
          )
      `).bind(timestamp, actor, lyricId, parsed.data.revision),
      context.env.DB.prepare(`
        UPDATE songs
        SET updated_at = ?, updated_by = ?
        WHERE id = ? AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM lyric_texts
            WHERE id = ?
              AND song_id = songs.id
              AND revision = ?
              AND trashed_at IS NULL
              AND updated_at = ?
              AND updated_by = ?
          )
      `).bind(
        timestamp, actor, current.songId, lyricId,
        parsed.data.revision + 1, timestamp, actor,
      ),
    ]);
    if (results[0].meta.changes === 0) {
      const state = await loadLyricState(context.env.DB, current.songId, lyricId);
      if (!state || state.songTrashedAt !== null) {
        return context.json({ error: "lyric_parent_trashed" }, 409);
      }
      if (state.trashedAt === null) {
        return context.json({ error: "lyric_not_trashed", currentRevision: state.revision }, 409);
      }
      return context.json({ error: "lyric_edit_conflict", currentRevision: state.revision }, 409);
    }
    return context.json({
      lyric: { id: lyricId, songId: current.songId, revision: parsed.data.revision + 1 },
    });
  } catch (error) {
    const response = lyricWriteError(error);
    return context.json({ error: response.error }, response.status);
  }
});

app.post("/api/trash/scans/:scanId/restore", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseScanRevision(body);
  if (!parsed.success) {
    return context.json({ error: "invalid_scan", fields: parsed.fields }, 400);
  }
  const scanId = context.req.param("scanId");
  const current = await context.env.DB.prepare(`
    SELECT scans.song_id AS songId
    FROM scans
    JOIN songs ON songs.id = scans.song_id
    WHERE scans.id = ?
  `).bind(scanId).first<{ songId: string }>();
  if (!current) return context.json({ error: "scan_not_found" }, 404);

  const timestamp = new Date().toISOString();
  const actor = context.get("appUser").identity;
  try {
    const results = await context.env.DB.batch([
      context.env.DB.prepare(`
        UPDATE scans
        SET trashed_at = NULL,
            trashed_by = NULL,
            revision = revision + 1,
            updated_at = ?,
            updated_by = ?
        WHERE id = ?
          AND revision = ?
          AND trashed_at IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM songs
            WHERE songs.id = scans.song_id AND songs.trashed_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM media_objects
            WHERE media_objects.id = scans.media_id
              AND media_objects.kind = 'scan'
              AND media_objects.state = 'trashed'
          )
      `).bind(timestamp, actor, scanId, parsed.data.revision),
      context.env.DB.prepare(`
        UPDATE media_objects
        SET state = 'active', trashed_at = NULL, trashed_by = NULL
        WHERE kind = 'scan' AND state = 'trashed'
          AND id = (
            SELECT media_id FROM scans
            WHERE id = ?
              AND revision = ?
              AND trashed_at IS NULL
              AND updated_at = ?
              AND updated_by = ?
          )
      `).bind(scanId, parsed.data.revision + 1, timestamp, actor),
      context.env.DB.prepare(`
        UPDATE songs
        SET updated_at = ?, updated_by = ?
        WHERE id = ? AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM scans
            WHERE id = ?
              AND song_id = songs.id
              AND revision = ?
              AND trashed_at IS NULL
              AND updated_at = ?
              AND updated_by = ?
          )
      `).bind(
        timestamp, actor, current.songId, scanId,
        parsed.data.revision + 1, timestamp, actor,
      ),
    ]);
    if (results[0].meta.changes === 0) {
      const state = await loadScanState(context.env.DB, current.songId, scanId);
      if (!state) return context.json({ error: "scan_not_found" }, 404);
      if (state.songTrashedAt !== null) {
        return context.json({ error: "scan_parent_trashed" }, 409);
      }
      if (state.trashedAt === null) {
        return context.json({ error: "scan_not_trashed", currentRevision: state.revision }, 409);
      }
      if (state.mediaState !== "trashed") {
        return context.json({ error: "scan_media_unavailable" }, 409);
      }
      return context.json({ error: "scan_edit_conflict", currentRevision: state.revision }, 409);
    }
    return context.json({
      scan: { id: scanId, songId: current.songId, revision: parsed.data.revision + 1 },
    });
  } catch (error) {
    const response = scanWriteError(error);
    return context.json({ error: response.error }, response.status);
  }
});

app.post("/api/trash/scans/:scanId/move", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseMediaParentMove(body);
  if (!parsed.success || parsed.data.duplicateUpload) {
    return context.json({ error: "invalid_media_parent_move" }, 400);
  }

  const scanId = context.req.param("scanId");
  const current = await context.env.DB.prepare(`
    SELECT
      scans.song_id AS songId,
      scans.revision,
      scans.trashed_at AS trashedAt,
      media_objects.state AS mediaState
    FROM scans
    JOIN media_objects ON media_objects.id = scans.media_id
    WHERE scans.id = ?
  `).bind(scanId).first<{
    songId: string;
    revision: number;
    trashedAt: string | null;
    mediaState: "active" | "trashed";
  }>();
  if (!current) return context.json({ error: "scan_not_found" }, 404);
  const target = await context.env.DB.prepare(`
    SELECT id FROM songs WHERE id = ? AND trashed_at IS NULL
  `).bind(parsed.data.targetSongId).first<{ id: string }>();
  if (!target) return context.json({ error: "media_move_target_not_found" }, 404);
  if (current.trashedAt === null) {
    return context.json({ error: "scan_not_trashed", currentRevision: current.revision }, 409);
  }
  if (current.mediaState !== "trashed") {
    return context.json({ error: "scan_media_unavailable" }, 409);
  }

  const timestamp = new Date().toISOString();
  const actor = context.get("appUser").identity;
  const newRevision = parsed.data.revision + 1;
  const statements: D1PreparedStatement[] = [
    context.env.DB.prepare(`
      UPDATE scans
      SET song_id = ?, trashed_at = NULL, trashed_by = NULL,
          revision = revision + 1, updated_at = ?, updated_by = ?
      WHERE id = ? AND revision = ? AND trashed_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM songs WHERE id = ? AND trashed_at IS NULL)
        AND EXISTS (
          SELECT 1 FROM media_objects
          WHERE id = scans.media_id AND kind = 'scan' AND state = 'trashed'
        )
    `).bind(
      parsed.data.targetSongId, timestamp, actor, scanId, parsed.data.revision,
      parsed.data.targetSongId,
    ),
    context.env.DB.prepare(`
      UPDATE media_objects
      SET state = 'active', trashed_at = NULL, trashed_by = NULL
      WHERE kind = 'scan' AND state = 'trashed'
        AND id = (
          SELECT media_id FROM scans
          WHERE id = ? AND song_id = ? AND revision = ?
            AND trashed_at IS NULL AND updated_at = ? AND updated_by = ?
        )
    `).bind(scanId, parsed.data.targetSongId, newRevision, timestamp, actor),
    context.env.DB.prepare(`
      UPDATE songs SET updated_at = ?, updated_by = ?
      WHERE id = ?
        AND EXISTS (
          SELECT 1 FROM scans
          WHERE id = ? AND song_id = ? AND revision = ?
            AND trashed_at IS NULL AND updated_at = ? AND updated_by = ?
        )
    `).bind(
      timestamp, actor, current.songId, scanId, parsed.data.targetSongId,
      newRevision, timestamp, actor,
    ),
  ];
  if (current.songId !== parsed.data.targetSongId) {
    statements.push(context.env.DB.prepare(`
      UPDATE songs SET updated_at = ?, updated_by = ?
      WHERE id = ? AND trashed_at IS NULL
        AND EXISTS (
          SELECT 1 FROM scans
          WHERE id = ? AND song_id = songs.id AND revision = ?
            AND trashed_at IS NULL AND updated_at = ? AND updated_by = ?
        )
    `).bind(
      timestamp, actor, parsed.data.targetSongId, scanId,
      newRevision, timestamp, actor,
    ));
  }

  try {
    const results = await context.env.DB.batch(statements);
    if (results[0].meta.changes === 0) {
      return context.json({ error: "scan_edit_conflict", currentRevision: current.revision }, 409);
    }
    return context.json({
      scan: { id: scanId, songId: parsed.data.targetSongId, revision: newRevision },
    });
  } catch (error) {
    const response = scanWriteError(error);
    return context.json({ error: response.error }, response.status);
  }
});

app.post("/api/trash/recordings/:recordingId/restore", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseRecordingRevision(body);
  if (!parsed.success) {
    return context.json({ error: "invalid_recording", fields: parsed.fields }, 400);
  }
  const recordingId = context.req.param("recordingId");
  const current = await context.env.DB.prepare(`
    SELECT recordings.song_id AS songId
    FROM recordings
    JOIN songs ON songs.id = recordings.song_id
    WHERE recordings.id = ?
  `).bind(recordingId).first<{ songId: string }>();
  if (!current) return context.json({ error: "recording_not_found" }, 404);

  const timestamp = new Date().toISOString();
  const actor = context.get("appUser").identity;
  const newRevision = parsed.data.revision + 1;
  try {
    const results = await context.env.DB.batch([
      context.env.DB.prepare(`
        UPDATE recordings
        SET trashed_at = NULL,
            trashed_by = NULL,
            revision = revision + 1,
            updated_at = ?,
            updated_by = ?
        WHERE id = ?
          AND revision = ?
          AND trashed_at IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM songs
            WHERE songs.id = recordings.song_id AND songs.trashed_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM media_objects
            WHERE media_objects.id = recordings.original_media_id
              AND media_objects.state = 'trashed'
          )
          AND (
            recordings.playback_media_id IS NULL
            OR EXISTS (
              SELECT 1 FROM media_objects
              WHERE media_objects.id = recordings.playback_media_id
                AND media_objects.state IN ('active', 'trashed')
            )
          )
      `).bind(timestamp, actor, recordingId, parsed.data.revision),
      context.env.DB.prepare(`
        UPDATE media_objects
        SET state = 'active', trashed_at = NULL, trashed_by = NULL
        WHERE state = 'trashed'
          AND id IN (
            SELECT original_media_id FROM recordings
            WHERE id = ? AND revision = ? AND trashed_at IS NULL
              AND updated_at = ? AND updated_by = ?
            UNION
            SELECT playback_media_id FROM recordings
            WHERE id = ? AND revision = ? AND trashed_at IS NULL
              AND updated_at = ? AND updated_by = ?
              AND playback_media_id IS NOT NULL
          )
      `).bind(
        recordingId, newRevision, timestamp, actor,
        recordingId, newRevision, timestamp, actor,
      ),
      context.env.DB.prepare(`
        UPDATE songs
        SET updated_at = ?, updated_by = ?
        WHERE id = ? AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM recordings
            WHERE id = ? AND song_id = songs.id AND revision = ?
              AND trashed_at IS NULL AND updated_at = ? AND updated_by = ?
          )
      `).bind(timestamp, actor, current.songId, recordingId, newRevision, timestamp, actor),
    ]);
    if (results[0].meta.changes === 0) {
      const state = await loadRecordingState(context.env.DB, current.songId, recordingId);
      if (!state) return context.json({ error: "recording_not_found" }, 404);
      if (state.songTrashedAt !== null) {
        return context.json({ error: "recording_parent_trashed" }, 409);
      }
      if (state.trashedAt === null) {
        return context.json({ error: "recording_not_trashed", currentRevision: state.revision }, 409);
      }
      if (state.originalMediaState !== "trashed") {
        return context.json({ error: "recording_media_unavailable" }, 409);
      }
      return context.json({ error: "recording_edit_conflict", currentRevision: state.revision }, 409);
    }
    return context.json({
      recording: { id: recordingId, songId: current.songId, revision: newRevision },
    });
  } catch (error) {
    const response = recordingWriteError(error);
    return context.json({ error: response.error }, response.status);
  }
});

app.post("/api/trash/recordings/:recordingId/move", requireRole("editor"), async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseMediaParentMove(body);
  if (!parsed.success) return context.json({ error: "invalid_media_parent_move" }, 400);

  const recordingId = context.req.param("recordingId");
  const current = await context.env.DB.prepare(`
    SELECT
      recordings.song_id AS songId,
      recordings.original_media_id AS originalMediaId,
      recordings.playback_media_id AS playbackMediaId,
      recordings.revision,
      recordings.trashed_at AS trashedAt,
      original_media.state AS originalMediaState,
      playback_media.state AS playbackMediaState
    FROM recordings
    JOIN media_objects AS original_media ON original_media.id = recordings.original_media_id
    LEFT JOIN media_objects AS playback_media ON playback_media.id = recordings.playback_media_id
    WHERE recordings.id = ?
  `).bind(recordingId).first<{
    songId: string;
    originalMediaId: string;
    playbackMediaId: string | null;
    revision: number;
    trashedAt: string | null;
    originalMediaState: "active" | "trashed";
    playbackMediaState: "active" | "trashed" | null;
  }>();
  if (!current) return context.json({ error: "recording_not_found" }, 404);
  const target = await context.env.DB.prepare(`
    SELECT id FROM songs WHERE id = ? AND trashed_at IS NULL
  `).bind(parsed.data.targetSongId).first<{ id: string }>();
  if (!target) return context.json({ error: "media_move_target_not_found" }, 404);
  if (current.trashedAt === null) {
    return context.json({ error: "recording_not_trashed", currentRevision: current.revision }, 409);
  }
  if (current.originalMediaState !== "trashed") {
    return context.json({ error: "recording_media_unavailable" }, 409);
  }

  const actor = context.get("appUser").identity;
  const duplicateUpload = parsed.data.duplicateUpload;
  if (duplicateUpload) {
    const session = await loadRecordingUploadSession(
      context.env.DB, duplicateUpload.sessionId, actor,
    );
    if (!session
      || session.status !== "duplicate"
      || session.revision !== duplicateUpload.revision
      || session.songId !== parsed.data.targetSongId
      || (
        session.duplicateMediaId !== current.originalMediaId
        && session.duplicateMediaId !== current.playbackMediaId
      )) {
      return context.json({ error: "recording_upload_conflict" }, 409);
    }
  }

  const timestamp = new Date().toISOString();
  const newRevision = parsed.data.revision + 1;
  const sessionId = duplicateUpload?.sessionId ?? null;
  const sessionRevision = duplicateUpload?.revision ?? null;
  const statements: D1PreparedStatement[] = [
    context.env.DB.prepare(`
      UPDATE recordings
      SET song_id = ?, trashed_at = NULL, trashed_by = NULL,
          revision = revision + 1, updated_at = ?, updated_by = ?
      WHERE id = ? AND revision = ? AND trashed_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM songs WHERE id = ? AND trashed_at IS NULL)
        AND EXISTS (
          SELECT 1 FROM media_objects
          WHERE id = recordings.original_media_id AND state = 'trashed'
        )
        AND NOT EXISTS (
          SELECT 1 FROM audio_processing_jobs
          WHERE recording_id = recordings.id AND status IN ('pending', 'running')
        )
        AND (
          ? IS NULL OR EXISTS (
            SELECT 1 FROM recording_upload_sessions
            WHERE id = ? AND created_by = ? AND revision = ?
              AND status = 'duplicate' AND song_id = ?
              AND duplicate_media_id IN (
                recordings.original_media_id,
                recordings.playback_media_id
              )
          )
        )
    `).bind(
      parsed.data.targetSongId, timestamp, actor, recordingId, parsed.data.revision,
      parsed.data.targetSongId,
      sessionId, sessionId, actor, sessionRevision, parsed.data.targetSongId,
    ),
    context.env.DB.prepare(`
      UPDATE media_objects
      SET state = 'active', trashed_at = NULL, trashed_by = NULL
      WHERE state = 'trashed'
        AND id IN (
          SELECT original_media_id FROM recordings
          WHERE id = ? AND song_id = ? AND revision = ?
            AND trashed_at IS NULL AND updated_at = ? AND updated_by = ?
          UNION
          SELECT playback_media_id FROM recordings
          WHERE id = ? AND song_id = ? AND revision = ?
            AND trashed_at IS NULL AND updated_at = ? AND updated_by = ?
            AND playback_media_id IS NOT NULL
        )
    `).bind(
      recordingId, parsed.data.targetSongId, newRevision, timestamp, actor,
      recordingId, parsed.data.targetSongId, newRevision, timestamp, actor,
    ),
  ];
  if (duplicateUpload) {
    statements.push(context.env.DB.prepare(`
      UPDATE recording_upload_sessions
      SET status = 'failed', duplicate_media_id = NULL,
          error_code = 'user_discarded', revision = revision + 1,
          updated_at = ?, updated_by = ?
      WHERE id = ? AND created_by = ? AND revision = ?
        AND status = 'duplicate' AND song_id = ?
        AND EXISTS (
          SELECT 1 FROM recordings
          WHERE id = ? AND song_id = ? AND revision = ? AND trashed_at IS NULL
            AND recording_upload_sessions.duplicate_media_id IN (
              recordings.original_media_id,
              recordings.playback_media_id
            )
        )
    `).bind(
      timestamp, actor, duplicateUpload.sessionId, actor, duplicateUpload.revision,
      parsed.data.targetSongId, recordingId, parsed.data.targetSongId, newRevision,
    ));
  }
  statements.push(context.env.DB.prepare(`
    UPDATE songs SET updated_at = ?, updated_by = ?
    WHERE id = ?
      AND EXISTS (
        SELECT 1 FROM recordings
        WHERE id = ? AND song_id = ? AND revision = ?
          AND trashed_at IS NULL AND updated_at = ? AND updated_by = ?
      )
  `).bind(
    timestamp, actor, current.songId, recordingId, parsed.data.targetSongId,
    newRevision, timestamp, actor,
  ));
  if (current.songId !== parsed.data.targetSongId) {
    statements.push(context.env.DB.prepare(`
      UPDATE songs SET updated_at = ?, updated_by = ?
      WHERE id = ? AND trashed_at IS NULL
        AND EXISTS (
          SELECT 1 FROM recordings
          WHERE id = ? AND song_id = songs.id AND revision = ?
            AND trashed_at IS NULL AND updated_at = ? AND updated_by = ?
        )
    `).bind(
      timestamp, actor, parsed.data.targetSongId, recordingId,
      newRevision, timestamp, actor,
    ));
  }

  try {
    const results = await context.env.DB.batch(statements);
    if (results[0].meta.changes === 0) {
      return context.json({ error: "recording_edit_conflict", currentRevision: current.revision }, 409);
    }
    return context.json({
      recording: { id: recordingId, songId: parsed.data.targetSongId, revision: newRevision },
    });
  } catch (error) {
    const response = recordingWriteError(error);
    return context.json({ error: response.error }, response.status);
  }
});

app.get("/api/catalog", async (context) => {
  const result = await context.env.DB.prepare(`
    SELECT
      songs.id AS id,
      songs.title_latin AS titleLatin,
      songs.title_native AS titleNative,
      songs.updated_at AS updatedAt,
      COALESCE((
        SELECT json_group_array(language_id)
        FROM song_languages
        WHERE song_id = songs.id
        ORDER BY sort_order
      ), '[]') AS languageIds,
      (SELECT COUNT(*) FROM lyric_texts WHERE song_id = songs.id AND trashed_at IS NULL) AS lyricCount,
      (SELECT COUNT(*) FROM scans WHERE song_id = songs.id AND trashed_at IS NULL) AS scanCount,
      (SELECT COUNT(*) FROM recordings WHERE song_id = songs.id AND trashed_at IS NULL) AS recordingCount
    FROM songs
    WHERE songs.trashed_at IS NULL
    ORDER BY songs.title_latin COLLATE NOCASE, songs.id
  `).all<CatalogSongRow>();

  return context.json({
    songs: result.results.map((row) => ({
      ...row,
      languageIds: JSON.parse(row.languageIds) as string[],
    })),
  });
});

app.get("/api/offline-library", async (context) => {
  return context.json({ songs: await loadOfflineLibrary(context.env.DB) });
});

app.get("/api/songs/:songId", async (context) => {
  const songId = context.req.param("songId");
  const song = await context.env.DB.prepare(`
    SELECT
      id,
      title_latin AS titleLatin,
      title_native AS titleNative,
      status,
      notes,
      revision,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM songs
    WHERE id = ? AND trashed_at IS NULL
  `).bind(songId).first<SongRow>();

  if (!song) {
    return context.json({ error: "song_not_found" }, 404);
  }

  const [aliases, languages, tags, credits, lyricTexts, scans, recordings, recordingCredits] = await Promise.all([
    context.env.DB.prepare(`
      SELECT alias FROM song_aliases WHERE song_id = ? ORDER BY sort_order, alias
    `).bind(songId).all<{ alias: string }>(),
    context.env.DB.prepare(`
      SELECT languages.id, languages.display_name AS displayName
      FROM song_languages
      JOIN languages ON languages.id = song_languages.language_id
      WHERE song_languages.song_id = ?
      ORDER BY song_languages.sort_order, languages.display_name
    `).bind(songId).all<{ id: string; displayName: string }>(),
    context.env.DB.prepare(`
      SELECT tags.id, tags.display_name AS displayName
      FROM song_tags
      JOIN tags ON tags.id = song_tags.tag_id
      WHERE song_tags.song_id = ?
      ORDER BY song_tags.sort_order, tags.display_name
    `).bind(songId).all<{ id: string; displayName: string }>(),
    context.env.DB.prepare(`
      SELECT
        people.id AS personId,
        people.full_name AS fullName,
        song_credits.role
      FROM song_credits
      JOIN people ON people.id = song_credits.person_id
      WHERE song_credits.song_id = ?
      ORDER BY song_credits.sort_order, people.full_name
    `).bind(songId).all<{ personId: string; fullName: string; role: string }>(),
    context.env.DB.prepare(`
      SELECT
        lyric_texts.id,
        lyric_texts.content,
        lyric_texts.origin,
        lyric_texts.revision
      FROM lyric_texts
      WHERE lyric_texts.song_id = ? AND lyric_texts.trashed_at IS NULL
      ORDER BY lyric_texts.sort_order, lyric_texts.id
    `).bind(songId).all<{
      id: string;
      content: string;
      origin: "user" | "legacy_import";
      revision: number;
    }>(),
    context.env.DB.prepare(`
      SELECT
        scans.id,
        media_objects.id AS mediaId,
        scans.notebook_id AS notebookId,
        notebooks.display_name AS notebookName,
        scans.page_label AS pageLabel,
        scans.revision,
        scans.rotation_quarter_turns AS rotationQuarterTurns,
        CASE WHEN scan_readability_derivatives.source_media_id IS NULL THEN 0 ELSE 1 END
          AS hasReadabilityDerivative,
        media_objects.original_filename AS filename
      FROM scans
      JOIN media_objects ON media_objects.id = scans.media_id
      LEFT JOIN scan_readability_derivatives
        ON scan_readability_derivatives.source_media_id = media_objects.id
      LEFT JOIN notebooks ON notebooks.id = scans.notebook_id
      WHERE scans.song_id = ? AND scans.trashed_at IS NULL
      ORDER BY
        CASE WHEN scans.notebook_id IS NULL THEN 1 ELSE 0 END,
        notebooks.sort_order,
        length(scans.page_label),
        scans.page_label COLLATE NOCASE,
        scans.created_at,
        scans.id
    `).bind(songId).all<{
      id: string;
      mediaId: string;
      notebookId: string | null;
      notebookName: string | null;
      pageLabel: string | null;
      revision: number;
      rotationQuarterTurns: 0 | 1 | 2 | 3;
      hasReadabilityDerivative: number;
      filename: string;
    }>(),
    context.env.DB.prepare(`
      SELECT
        recordings.id,
        recordings.original_media_id AS originalMediaId,
        recordings.playback_media_id AS playbackMediaId,
        CASE
          WHEN recordings.playback_media_id IS NULL THEN media_objects.byte_size
          ELSE playback_media.byte_size
        END AS playbackByteSize,
        recordings.description,
        recordings.recorded_on AS recordedOn,
        recordings.revision,
        recordings.processing_state AS processingState,
        media_objects.original_filename AS filename,
        CASE WHEN recordings.playback_media_id IS NULL THEN 0 ELSE 1 END AS hasPlaybackMedia
      FROM recordings
      JOIN media_objects ON media_objects.id = recordings.original_media_id
      LEFT JOIN media_objects AS playback_media
        ON playback_media.id = recordings.playback_media_id
      WHERE recordings.song_id = ? AND recordings.trashed_at IS NULL
      ORDER BY recordings.recorded_on, recordings.id
    `).bind(songId).all<{
      id: string;
      originalMediaId: string;
      playbackMediaId: string | null;
      playbackByteSize: number;
      description: string;
      recordedOn: string | null;
      revision: number;
      processingState: "processing" | "ready" | "failed";
      filename: string;
      hasPlaybackMedia: number;
    }>(),
    context.env.DB.prepare(`
      SELECT
        recording_credits.recording_id AS recordingId,
        people.id AS personId,
        people.full_name AS fullName,
        recording_credits.role
      FROM recording_credits
      JOIN recordings ON recordings.id = recording_credits.recording_id
      JOIN people ON people.id = recording_credits.person_id
      WHERE recordings.song_id = ? AND recordings.trashed_at IS NULL
      ORDER BY recording_credits.sort_order, people.full_name
    `).bind(songId).all<RecordingCreditRow>(),
  ]);

  const creditsByRecording = new Map<string, RecordingCreditRow[]>();
  for (const credit of recordingCredits.results) {
    const group = creditsByRecording.get(credit.recordingId) ?? [];
    group.push(credit);
    creditsByRecording.set(credit.recordingId, group);
  }

  return context.json({
    song: {
      ...song,
      aliases: aliases.results.map(({ alias }) => alias),
      languages: languages.results,
      tags: tags.results,
      credits: credits.results,
      lyricTexts: lyricTexts.results,
      scans: scans.results.map((scan) => ({
        ...scan,
        hasReadabilityDerivative: scan.hasReadabilityDerivative === 1,
      })),
      recordings: recordings.results.map((recording) => ({
        ...recording,
        hasPlaybackMedia: recording.hasPlaybackMedia === 1,
        credits: creditsByRecording.get(recording.id) ?? [],
      })),
    },
  });
});

app.get("/api/scans/:scanId/image", async (context) => {
  const scan = await context.env.DB.prepare(`
    SELECT
      COALESCE(scan_readability_derivatives.object_key, media_objects.object_key) AS objectKey,
      CASE
        WHEN scan_readability_derivatives.source_media_id IS NULL THEN media_objects.mime_type
        ELSE scan_readability_derivatives.mime_type
      END AS mimeType,
      media_objects.original_filename AS filename,
      CASE WHEN scan_readability_derivatives.source_media_id IS NULL THEN 0 ELSE 1 END AS isDerivative
    FROM scans
    JOIN songs ON songs.id = scans.song_id
    JOIN media_objects ON media_objects.id = scans.media_id
    LEFT JOIN scan_readability_derivatives
      ON scan_readability_derivatives.source_media_id = media_objects.id
    WHERE scans.id = ?
      AND scans.trashed_at IS NULL
      AND songs.trashed_at IS NULL
      AND media_objects.state = 'active'
  `).bind(context.req.param("scanId")).first<{
    objectKey: string;
    mimeType: string | null;
    filename: string;
    isDerivative: number;
  }>();
  if (!scan) return context.json({ error: "scan_not_found" }, 404);

  const object = await context.env.MEDIA.get(scan.objectKey);
  if (!object) return context.json({ error: "scan_file_unavailable" }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", scan.mimeType ?? "application/octet-stream");
  headers.set(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeRfc5987Filename(scan.filename)}`,
  );
  headers.set("Content-Length", String(object.size));
  headers.set("Cache-Control", "private, no-store");
  headers.set("ETag", object.httpEtag);
  headers.set("X-Scan-Representation", scan.isDerivative === 1 ? "readability" : "original");
  return new Response(object.body, { headers });
});

const MAX_RECORDING_SHARE_BYTES = 52_428_800;

app.get("/api/recordings/:recordingId/playback", async (context) => {
  const recording = await context.env.DB.prepare(`
    SELECT
      CASE
        WHEN recordings.playback_media_id IS NULL THEN original_media.object_key
        ELSE playback_media.object_key
      END AS objectKey,
      CASE
        WHEN recordings.playback_media_id IS NULL THEN original_media.mime_type
        ELSE playback_media.mime_type
      END AS mimeType,
      CASE
        WHEN recordings.playback_media_id IS NULL THEN original_media.byte_size
        ELSE playback_media.byte_size
      END AS byteSize
    FROM recordings
    JOIN songs ON songs.id = recordings.song_id
    JOIN media_objects AS original_media ON original_media.id = recordings.original_media_id
    LEFT JOIN media_objects AS playback_media ON playback_media.id = recordings.playback_media_id
    WHERE recordings.id = ?
      AND recordings.trashed_at IS NULL
      AND songs.trashed_at IS NULL
      AND recordings.processing_state = 'ready'
      AND (
        (recordings.playback_media_id IS NULL
          AND original_media.state = 'active'
          AND original_media.mime_type = 'audio/mpeg')
        OR
        (recordings.playback_media_id IS NOT NULL
          AND playback_media.state = 'active'
          AND playback_media.mime_type = 'audio/mpeg')
      )
  `).bind(context.req.param("recordingId")).first<{
    objectKey: string;
    mimeType: string;
    byteSize: number;
  }>();
  if (!recording) return context.json({ error: "recording_playback_not_found" }, 404);
  if (recording.byteSize > MAX_RECORDING_SHARE_BYTES) {
    return context.json({ error: "recording_playback_too_large_to_share" }, 413);
  }

  const object = await context.env.MEDIA.get(recording.objectKey);
  if (!object) return context.json({ error: "recording_playback_unavailable" }, 404);
  if (object.size !== recording.byteSize || object.size < 1) {
    return context.json({ error: "recording_playback_invalid" }, 409);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", recording.mimeType);
  headers.set("Content-Disposition", "attachment; filename=recording.mp3");
  headers.set("Content-Length", String(object.size));
  headers.set("Cache-Control", "private, no-store");
  headers.set("ETag", object.httpEtag);
  headers.set("X-Recording-Representation", "playback");
  return new Response(object.body, { headers });
});

app.get("/api/media/:mediaId", async (context) => {
  const mediaId = context.req.param("mediaId");
  const media = await context.env.DB.prepare(`
    SELECT
      media_objects.id,
      media_objects.object_key AS objectKey,
      media_objects.original_filename AS filename,
      media_objects.mime_type AS mimeType
    FROM media_objects
    WHERE media_objects.id = ?
      AND media_objects.state = 'active'
      AND (
        EXISTS (
          SELECT 1 FROM scans
          JOIN songs ON songs.id = scans.song_id
          WHERE scans.media_id = media_objects.id
            AND scans.trashed_at IS NULL
            AND songs.trashed_at IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM recordings
          JOIN songs ON songs.id = recordings.song_id
          WHERE recordings.trashed_at IS NULL
            AND songs.trashed_at IS NULL
            AND recordings.processing_state = 'ready'
            AND (
              recordings.playback_media_id = media_objects.id
              OR (
                recordings.playback_media_id IS NULL
                AND recordings.original_media_id = media_objects.id
              )
            )
        )
      )
  `).bind(mediaId).first<MediaRow>();

  if (!media) {
    return context.json({ error: "media_not_found" }, 404);
  }

  const rangeHeader = context.req.header("Range");
  const object = await context.env.MEDIA.get(
    media.objectKey,
    rangeHeader ? { range: context.req.raw.headers } : undefined,
  );
  if (!object) {
    return context.json({ error: "media_file_unavailable" }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", media.mimeType ?? "application/octet-stream");
  headers.set(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeRfc5987Filename(media.filename)}`,
  );
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, no-store");
  headers.set("ETag", object.httpEtag);

  if (rangeHeader) {
    const range = parseByteRange(rangeHeader, object.size);
    if (!range) {
      headers.set("Content-Range", `bytes */${object.size}`);
      return new Response(null, { status: 416, headers });
    }
    const { offset, length } = range;
    const end = offset + length - 1;
    headers.set("Content-Range", `bytes ${offset}-${end}/${object.size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
});

type PendingScanMaintenanceRow = {
  mediaId: string;
  objectKey: string;
  byteSize: number;
  sha256: string | null;
};

type ScanMaintenanceStage = "source_read" | "source_verify" | "derivative" | "commit";

const SCAN_MAINTENANCE_LEASE_MINUTES = 10;

async function recordScanMaintenanceFailure(
  database: D1Database,
  mediaId: string,
  stage: ScanMaintenanceStage,
  errorCode: string,
): Promise<void> {
  const timestamp = new Date().toISOString();
  await database.prepare(`
    INSERT INTO scan_maintenance_failures (
      media_id, stage, error_code, attempt_count,
      first_failed_at, last_failed_at, retry_after
    ) VALUES (?, ?, ?, 1, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+1 day'))
    ON CONFLICT(media_id) DO UPDATE SET
      stage = excluded.stage,
      error_code = excluded.error_code,
      attempt_count = scan_maintenance_failures.attempt_count + 1,
      last_failed_at = excluded.last_failed_at,
      retry_after = excluded.retry_after
  `).bind(mediaId, stage, errorCode, timestamp, timestamp, timestamp).run();
}

async function pendingScanMaintenance(database: D1Database): Promise<PendingScanMaintenanceRow | null> {
  return database.prepare(`
    SELECT
      media_objects.id AS mediaId,
      media_objects.object_key AS objectKey,
      media_objects.byte_size AS byteSize,
      media_objects.sha256
    FROM media_objects
    LEFT JOIN scan_readability_derivatives
      ON scan_readability_derivatives.source_media_id = media_objects.id
    LEFT JOIN scan_maintenance_failures
      ON scan_maintenance_failures.media_id = media_objects.id
    LEFT JOIN scan_maintenance_leases
      ON scan_maintenance_leases.media_id = media_objects.id
      AND scan_maintenance_leases.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE media_objects.kind = 'scan'
      AND (
        media_objects.sha256 IS NULL
        OR scan_readability_derivatives.source_media_id IS NULL
      )
      AND (
        scan_maintenance_failures.media_id IS NULL
        OR scan_maintenance_failures.retry_after <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      )
      AND scan_maintenance_leases.media_id IS NULL
    ORDER BY media_objects.id
    LIMIT 1
  `).first<PendingScanMaintenanceRow>();
}

async function claimScanMaintenance(
  database: D1Database,
  mediaId: string,
  leaseToken: string,
): Promise<boolean> {
  const leasedAt = new Date().toISOString();
  const result = await database.prepare(`
    INSERT INTO scan_maintenance_leases (
      media_id, lease_token, leased_at, lease_expires_at
    ) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+${SCAN_MAINTENANCE_LEASE_MINUTES} minutes'))
    ON CONFLICT(media_id) DO UPDATE SET
      lease_token = excluded.lease_token,
      leased_at = excluded.leased_at,
      lease_expires_at = excluded.lease_expires_at
    WHERE scan_maintenance_leases.lease_expires_at <= excluded.leased_at
  `).bind(mediaId, leaseToken, leasedAt, leasedAt).run();
  return result.meta.changes === 1;
}

async function releaseScanMaintenance(
  database: D1Database,
  mediaId: string,
  leaseToken: string,
): Promise<void> {
  try {
    await database.prepare(`
      DELETE FROM scan_maintenance_leases
      WHERE media_id = ? AND lease_token = ?
    `).bind(mediaId, leaseToken).run();
  } catch {
    console.error("Failed to release a Scan maintenance lease");
  }
}

async function commitScanFingerprint(
  database: D1Database,
  pending: PendingScanMaintenanceRow,
  sourceSha256: string,
): Promise<boolean> {
  if (pending.sha256 === sourceSha256) return true;
  try {
    await database.prepare(`
      UPDATE media_objects
      SET sha256 = ?
      WHERE id = ?
        AND kind = 'scan'
        AND object_key = ?
        AND byte_size = ?
        AND sha256 IS NULL
    `).bind(
      sourceSha256,
      pending.mediaId,
      pending.objectKey,
      pending.byteSize,
    ).run();
    const verified = await database.prepare(`
      SELECT 1 AS valid
      FROM media_objects
      JOIN scan_fingerprint_members
        ON scan_fingerprint_members.media_id = media_objects.id
      WHERE media_objects.id = ?
        AND media_objects.kind = 'scan'
        AND media_objects.object_key = ?
        AND media_objects.byte_size = ?
        AND media_objects.sha256 = ?
        AND scan_fingerprint_members.sha256 = ?
    `).bind(
      pending.mediaId,
      pending.objectKey,
      pending.byteSize,
      sourceSha256,
      sourceSha256,
    ).first<{ valid: number }>();
    return Boolean(verified);
  } catch {
    return false;
  }
}

async function processClaimedScan(
  env: Pick<Bindings, "DB" | "MEDIA" | "IMAGES">,
  pending: PendingScanMaintenanceRow,
): Promise<"processed" | "failed"> {
  let source: R2ObjectBody | null;
  try {
    source = await env.MEDIA.get(pending.objectKey);
  } catch {
    await recordScanMaintenanceFailure(env.DB, pending.mediaId, "source_read", "source_storage_unavailable");
    return "failed";
  }
  if (!source) {
    await recordScanMaintenanceFailure(env.DB, pending.mediaId, "source_read", "source_file_unavailable");
    return "failed";
  }

  let sourceBytes: Uint8Array;
  try {
    sourceBytes = new Uint8Array(await source.arrayBuffer());
  } catch {
    await recordScanMaintenanceFailure(env.DB, pending.mediaId, "source_read", "source_read_failed");
    return "failed";
  }
  if (sourceBytes.byteLength !== pending.byteSize || !inspectScanImage(sourceBytes)) {
    await recordScanMaintenanceFailure(env.DB, pending.mediaId, "source_verify", "source_precondition_failed");
    return "failed";
  }

  const sourceSha256 = await sha256Hex(sourceBytes);
  if (pending.sha256 !== null && pending.sha256 !== sourceSha256) {
    await recordScanMaintenanceFailure(env.DB, pending.mediaId, "source_verify", "source_hash_mismatch");
    return "failed";
  }
  if (!await commitScanFingerprint(env.DB, pending, sourceSha256)) {
    await recordScanMaintenanceFailure(env.DB, pending.mediaId, "commit", "scan_fingerprint_commit_failed");
    return "failed";
  }

  let readability: ScanReadabilityDerivative;
  try {
    readability = await createScanReadabilityDerivative(env.IMAGES, sourceBytes);
  } catch (error) {
    const code = error instanceof ScanReadabilityError
      ? error.code
      : "scan_readability_unavailable";
    await recordScanMaintenanceFailure(env.DB, pending.mediaId, "derivative", code);
    return "failed";
  }

  const readabilityObjectKey = scanReadabilityObjectKey(pending.mediaId);
  try {
    await env.MEDIA.put(readabilityObjectKey, readability.bytes, {
      httpMetadata: {
        contentType: readability.mimeType,
        contentDisposition: "inline",
      },
    });
  } catch {
    await recordScanMaintenanceFailure(env.DB, pending.mediaId, "derivative", "derivative_storage_failed");
    return "failed";
  }

  const timestamp = new Date().toISOString();
  try {
    await env.DB.batch([
      scanReadabilityInsert(
        env.DB,
        pending.mediaId,
        sourceSha256,
        pending.byteSize,
        readabilityObjectKey,
        readability,
        timestamp,
        "system:scan-maintenance",
      ),
      env.DB.prepare(`DELETE FROM scan_maintenance_failures WHERE media_id = ?`).bind(pending.mediaId),
    ]);
  } catch {
    // A D1 failure can be an ambiguous response after the batch committed. Keep
    // the deterministic private object: deleting it here could remove a
    // derivative that the committed row now references. If the batch truly did
    // not commit, the next maintenance attempt safely overwrites the same key.
    const committed = await env.DB.prepare(`
      SELECT 1 AS valid
      FROM scan_readability_derivatives
      WHERE source_media_id = ?
        AND source_sha256 = ?
        AND source_byte_size = ?
        AND object_key = ?
        AND mime_type = ?
        AND byte_size = ?
        AND sha256 = ?
        AND width = ?
        AND height = ?
        AND policy_id = ?
    `).bind(
      pending.mediaId,
      sourceSha256,
      pending.byteSize,
      readabilityObjectKey,
      readability.mimeType,
      readability.bytes.byteLength,
      readability.sha256,
      readability.width,
      readability.height,
      readability.policyId,
    ).first<{ valid: number }>().catch(() => null);
    if (committed) return "processed";
    await recordScanMaintenanceFailure(env.DB, pending.mediaId, "commit", "scan_maintenance_commit_failed");
    return "failed";
  }

  return "processed";
}

export async function processOnePendingScan(env: Pick<Bindings, "DB" | "MEDIA" | "IMAGES">): Promise<
  "complete" | "processed" | "failed"
> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pending = await pendingScanMaintenance(env.DB);
    if (!pending) return "complete";
    const leaseToken = crypto.randomUUID();
    if (!await claimScanMaintenance(env.DB, pending.mediaId, leaseToken)) continue;
    try {
      return await processClaimedScan(env, pending);
    } finally {
      await releaseScanMaintenance(env.DB, pending.mediaId, leaseToken);
    }
  }
  return "complete";
}

export async function processPendingScans(
  env: Pick<Bindings, "DB" | "MEDIA" | "IMAGES">,
  limit = 5,
): Promise<{ processed: number; failed: number; complete: boolean }> {
  let processed = 0;
  let failed = 0;
  for (let index = 0; index < limit; index += 1) {
    const result = await processOnePendingScan(env);
    if (result === "complete") return { processed, failed, complete: true };
    if (result === "processed") processed += 1;
    else failed += 1;
  }
  return { processed, failed, complete: false };
}

app.notFound((context) => {
  return context.json(
    {
      error: "not_found",
    },
    404,
  );
});

export default {
  fetch(request, env, executionContext) {
    return app.fetch(request, env, executionContext);
  },
  scheduled(_controller, env, executionContext) {
    executionContext.waitUntil(processPendingScans(env, 5).then((result) => {
      console.log(JSON.stringify({ event: "scan_maintenance", ...result }));
    }));
  },
} satisfies ExportedHandler<Bindings>;
