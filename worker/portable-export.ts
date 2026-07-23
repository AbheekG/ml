import type { Context } from "hono";

export const PORTABLE_EXPORT_PROFILE_VERSION = "1.0.0";
export const PORTABLE_EXPORT_SCHEMA_VERSION = "0021";
export const PORTABLE_EXPORT_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const PORTABLE_EXPORT_CLEANUP_GRACE_MS = 6 * 60 * 60 * 1000;
export const PORTABLE_EXPORT_PAGE_MAX = 200;

export type PortableExportState = "preparing" | "ready" | "revoked" | "expired" | "failed";

export type PortableExportSession = {
  id: string;
  profileVersion: string;
  state: PortableExportState;
  sourceSchemaVersion: string;
  sourceCommit: string;
  sourceEnvironment: string;
  snapshotAt: string;
  createdAt: string;
  expiresAt: string;
  recordCount: number;
  itemCount: number;
  plannedBytes: number;
  activeSongs: number | null;
  trashedSongs: number | null;
  activeLyrics: number | null;
  trashedLyrics: number | null;
  activeScans: number | null;
  trashedScans: number | null;
  activeRecordings: number | null;
  trashedRecordings: number | null;
  historyRelationships: number | null;
  unassignedMedia: number | null;
  planDigest: string | null;
  readyAt: string | null;
  revokedAt: string | null;
  expiredAt: string | null;
  failedAt: string | null;
  failureCode: string | null;
  detailPurgedAt: string | null;
};

export type PortableExportRecord = {
  kind: string;
  key: string;
  orderKey: string;
  data: Record<string, unknown>;
};

export type PortableExportItem = {
  id: string;
  sourceKind: "media_object" | "scan_readability";
  sourceId: string;
  representation: "scan_original" | "scan_optimized" | "recording_original" | "recording_playback";
  mimeType: string;
  byteSize: number;
  sha256: string;
};

type PortableExportItemPrivate = PortableExportItem & {
  objectKey: string;
};

type PortableExportContext = Context<{
  Bindings: {
    DB: D1Database;
    MEDIA: R2Bucket;
    SOURCE_COMMIT?: string;
  };
  Variables: {
    appUser: { identity: string };
  };
}>;

type SnapshotSpec = {
  table: string;
  key: string;
  order: string;
  json: string;
};

const SNAPSHOT_SPECS: SnapshotSpec[] = [
  {
    table: "app_users",
    key: "identity",
    order: "identity COLLATE NOCASE",
    json: `json_object(
      'identity', identity, 'display_name', display_name, 'role', role,
      'is_active', is_active, 'created_at', created_at, 'updated_at', updated_at
    )`,
  },
  {
    table: "audio_derivatives",
    key: "playback_media_id",
    order: "playback_media_id",
    json: `json_object(
      'playback_media_id', playback_media_id, 'source_media_id', source_media_id,
      'policy_id', policy_id, 'source_sha256', source_sha256,
      'source_byte_size', source_byte_size, 'derivative_sha256', derivative_sha256,
      'derivative_byte_size', derivative_byte_size
    )`,
  },
  {
    table: "languages",
    key: "id",
    order: "printf('%010d:%s', sort_order, id)",
    json: `json_object(
      'id', id, 'display_name', display_name, 'bcp47_tag', bcp47_tag,
      'sort_order', sort_order, 'normalized_name', normalized_name
    )`,
  },
  {
    table: "lyric_texts",
    key: "id",
    order: "song_id || ':' || printf('%010d', sort_order) || ':' || id",
    json: `json_object(
      'id', id, 'song_id', song_id, 'content', content, 'origin', origin,
      'sort_order', sort_order, 'revision', revision, 'created_at', created_at,
      'created_by', created_by, 'updated_at', updated_at, 'updated_by', updated_by,
      'trashed_at', trashed_at, 'trashed_by', trashed_by
    )`,
  },
  {
    table: "media_objects",
    key: "id",
    order: "kind || ':' || id",
    json: `json_object(
      'id', id, 'original_filename', original_filename, 'mime_type', mime_type,
      'byte_size', byte_size, 'sha256', sha256, 'kind', kind, 'state', state,
      'created_at', created_at, 'created_by', created_by,
      'trashed_at', trashed_at, 'trashed_by', trashed_by
    )`,
  },
  {
    table: "media_parent_moves",
    key: "id",
    order: "moved_at || ':' || id",
    json: `json_object(
      'id', id, 'scan_id', scan_id, 'recording_id', recording_id,
      'from_song_id', from_song_id, 'to_song_id', to_song_id,
      'moved_at', moved_at, 'moved_by', moved_by
    )`,
  },
  {
    table: "notebooks",
    key: "id",
    order: "printf('%010d:%s', sort_order, id)",
    json: `json_object(
      'id', id, 'display_name', display_name, 'sort_order', sort_order,
      'normalized_name', normalized_name
    )`,
  },
  {
    table: "people",
    key: "id",
    order: "normalized_name || ':' || id",
    json: `json_object(
      'id', id, 'full_name', full_name, 'normalized_name', normalized_name,
      'created_at', created_at, 'updated_at', updated_at
    )`,
  },
  {
    table: "recording_credits",
    key: "id",
    order: "recording_id || ':' || printf('%010d', sort_order) || ':' || id",
    json: `json_object(
      'id', id, 'recording_id', recording_id, 'person_id', person_id,
      'role', role, 'sort_order', sort_order
    )`,
  },
  {
    table: "recording_media_history",
    key: "id",
    order: "recording_id || ':' || replaced_at || ':' || id",
    json: `json_object(
      'id', id, 'recording_id', recording_id, 'original_media_id', original_media_id,
      'playback_media_id', playback_media_id, 'replaced_at', replaced_at,
      'replaced_by', replaced_by, 'revision_at_replacement', revision_at_replacement
    )`,
  },
  {
    table: "recordings",
    key: "id",
    order: "song_id || ':' || created_at || ':' || id",
    json: `json_object(
      'id', id, 'song_id', song_id, 'original_media_id', original_media_id,
      'playback_media_id', playback_media_id, 'legacy_version', legacy_version,
      'recorded_on', recorded_on, 'legacy_notes', legacy_notes, 'revision', revision,
      'created_at', created_at, 'created_by', created_by, 'updated_at', updated_at,
      'updated_by', updated_by, 'trashed_at', trashed_at, 'trashed_by', trashed_by,
      'description', description, 'normalized_description', normalized_description,
      'processing_state', processing_state, 'processing_error', processing_error
    )`,
  },
  {
    table: "scan_fingerprint_members",
    key: "media_id",
    order: "sha256 || ':' || media_id",
    json: `json_object(
      'media_id', media_id, 'sha256', sha256,
      'is_historical_duplicate', is_historical_duplicate, 'registered_at', registered_at
    )`,
  },
  {
    table: "scan_fingerprints",
    key: "sha256",
    order: "sha256",
    json: `json_object(
      'sha256', sha256, 'canonical_media_id', canonical_media_id,
      'first_seen_at', first_seen_at
    )`,
  },
  {
    table: "scan_media_history",
    key: "id",
    order: "scan_id || ':' || replaced_at || ':' || id",
    json: `json_object(
      'id', id, 'scan_id', scan_id, 'media_id', media_id,
      'replaced_at', replaced_at, 'replaced_by', replaced_by,
      'revision_at_replacement', revision_at_replacement
    )`,
  },
  {
    table: "scan_readability_derivatives",
    key: "source_media_id",
    order: "source_media_id",
    json: `json_object(
      'source_media_id', source_media_id, 'source_sha256', source_sha256,
      'source_byte_size', source_byte_size, 'mime_type', mime_type,
      'byte_size', byte_size, 'sha256', sha256, 'width', width, 'height', height,
      'policy_id', policy_id, 'created_at', created_at, 'created_by', created_by
    )`,
  },
  {
    table: "scans",
    key: "id",
    order: "song_id || ':' || created_at || ':' || id",
    json: `json_object(
      'id', id, 'song_id', song_id, 'media_id', media_id,
      'notebook_id', notebook_id, 'page_label', page_label,
      'legacy_version', legacy_version, 'legacy_captured_on', legacy_captured_on,
      'legacy_source', legacy_source, 'legacy_scan_text', legacy_scan_text,
      'legacy_notes', legacy_notes, 'revision', revision, 'created_at', created_at,
      'created_by', created_by, 'updated_at', updated_at, 'updated_by', updated_by,
      'trashed_at', trashed_at, 'trashed_by', trashed_by,
      'rotation_quarter_turns', rotation_quarter_turns
    )`,
  },
  {
    table: "song_aliases",
    key: "id",
    order: "song_id || ':' || printf('%010d', sort_order) || ':' || id",
    json: `json_object(
      'id', id, 'song_id', song_id, 'alias', alias,
      'normalized_alias', normalized_alias, 'sort_order', sort_order
    )`,
  },
  {
    table: "song_credits",
    key: "id",
    order: "song_id || ':' || printf('%010d', sort_order) || ':' || id",
    json: `json_object(
      'id', id, 'song_id', song_id, 'person_id', person_id,
      'role', role, 'sort_order', sort_order
    )`,
  },
  {
    table: "song_languages",
    key: "json_array(song_id, language_id)",
    order: "song_id || ':' || printf('%010d', sort_order) || ':' || language_id",
    json: `json_object(
      'song_id', song_id, 'language_id', language_id, 'sort_order', sort_order
    )`,
  },
  {
    table: "song_tags",
    key: "json_array(song_id, tag_id)",
    order: "song_id || ':' || printf('%010d', sort_order) || ':' || tag_id",
    json: `json_object(
      'song_id', song_id, 'tag_id', tag_id, 'sort_order', sort_order
    )`,
  },
  {
    table: "songs",
    key: "id",
    order: "CASE WHEN trashed_at IS NULL THEN '0:' ELSE '1:' END || normalized_title_latin || ':' || id",
    json: `json_object(
      'id', id, 'title_latin', title_latin, 'title_native', title_native,
      'status', status, 'notes', notes, 'revision', revision,
      'created_at', created_at, 'created_by', created_by,
      'updated_at', updated_at, 'updated_by', updated_by,
      'trashed_at', trashed_at, 'trashed_by', trashed_by,
      'normalized_title_latin', normalized_title_latin,
      'last_mutation_id', last_mutation_id
    )`,
  },
  {
    table: "tags",
    key: "id",
    order: "printf('%010d:%s', sort_order, id)",
    json: `json_object(
      'id', id, 'display_name', display_name, 'sort_order', sort_order,
      'normalized_name', normalized_name
    )`,
  },
];

export const PORTABLE_SNAPSHOT_STATEMENT_COUNT = SNAPSHOT_SPECS.length + 4;

const SESSION_SELECT = `
  SELECT
    id,
    profile_version AS profileVersion,
    state,
    source_schema_version AS sourceSchemaVersion,
    source_commit AS sourceCommit,
    source_environment AS sourceEnvironment,
    snapshot_at AS snapshotAt,
    created_at AS createdAt,
    expires_at AS expiresAt,
    record_count AS recordCount,
    item_count AS itemCount,
    planned_bytes AS plannedBytes,
    json_extract(summary_json, '$.activeSongs') AS activeSongs,
    json_extract(summary_json, '$.trashedSongs') AS trashedSongs,
    json_extract(summary_json, '$.activeLyrics') AS activeLyrics,
    json_extract(summary_json, '$.trashedLyrics') AS trashedLyrics,
    json_extract(summary_json, '$.activeScans') AS activeScans,
    json_extract(summary_json, '$.trashedScans') AS trashedScans,
    json_extract(summary_json, '$.activeRecordings') AS activeRecordings,
    json_extract(summary_json, '$.trashedRecordings') AS trashedRecordings,
    json_extract(summary_json, '$.historyRelationships') AS historyRelationships,
    json_extract(summary_json, '$.unassignedMedia') AS unassignedMedia,
    plan_digest AS planDigest,
    ready_at AS readyAt,
    revoked_at AS revokedAt,
    expired_at AS expiredAt,
    failed_at AS failedAt,
    failure_code AS failureCode,
    detail_purged_at AS detailPurgedAt
  FROM portable_export_sessions
`;

function sha256Input(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function sha256Hex(value: string): Promise<string> {
  const input = sha256Input(value);
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function opaqueId(): string {
  return crypto.randomUUID().replaceAll("-", "").toLowerCase();
}

export function parsePortableExportCreate(
  value: unknown,
): { success: true; clientMutationId: string } | { success: false } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { success: false };
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).length !== 1
    || typeof body.clientMutationId !== "string"
    || body.clientMutationId.length < 1
    || body.clientMutationId.length > 100
    || /[\r\n]/u.test(body.clientMutationId)
  ) {
    return { success: false };
  }
  return { success: true, clientMutationId: body.clientMutationId };
}

export function validPortableSourceCommit(value: string | undefined): value is string {
  return value === "local-development" || /^[0-9a-f]{7,40}$/u.test(value ?? "");
}

function recordStatement(database: D1Database, exportId: string, spec: SnapshotSpec): D1PreparedStatement {
  return database.prepare(`
    INSERT INTO portable_export_records (
      export_id, record_kind, record_key, order_key, frozen_json
    )
    SELECT ?, '${spec.table}', ${spec.key}, ${spec.order}, ${spec.json}
    FROM ${spec.table}
  `).bind(exportId);
}

async function sessionByMutation(
  database: D1Database,
  actor: string,
  clientMutationId: string,
): Promise<(PortableExportSession & { requestFingerprint: string }) | null> {
  return database.prepare(`
    ${SESSION_SELECT.replace("FROM portable_export_sessions", ", request_fingerprint AS requestFingerprint FROM portable_export_sessions")}
    WHERE created_by = ? AND client_mutation_id = ?
  `).bind(actor, clientMutationId).first<PortableExportSession & { requestFingerprint: string }>();
}

export async function createPortableExport(
  database: D1Database,
  actor: string,
  sourceCommit: string,
  sourceEnvironment: string,
  clientMutationId: string,
  now = new Date(),
): Promise<PortableExportSession> {
  if (!validPortableSourceCommit(sourceCommit)) throw new Error("portable_source_commit_invalid");
  const requestFingerprint = await sha256Hex([
    PORTABLE_EXPORT_PROFILE_VERSION,
    PORTABLE_EXPORT_SCHEMA_VERSION,
    sourceCommit,
    sourceEnvironment,
  ].join("\0"));
  const replay = await sessionByMutation(database, actor, clientMutationId);
  if (replay) {
    if (replay.requestFingerprint !== requestFingerprint) {
      throw new Error("portable_export_replay_conflict");
    }
    return replay;
  }

  const exportId = opaqueId();
  const snapshotAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + PORTABLE_EXPORT_LIFETIME_MS).toISOString();
  const planDigest = await sha256Hex([
    PORTABLE_EXPORT_PROFILE_VERSION,
    exportId,
    snapshotAt,
    expiresAt,
    sourceCommit,
    requestFingerprint,
  ].join("\0"));

  const statements: D1PreparedStatement[] = [
    database.prepare(`
      INSERT INTO portable_export_sessions (
        id, profile_version, client_mutation_id, request_fingerprint, state,
        source_schema_version, source_commit, source_environment,
        snapshot_at, created_at, created_by, expires_at
      ) VALUES (?, ?, ?, ?, 'preparing', ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      exportId,
      PORTABLE_EXPORT_PROFILE_VERSION,
      clientMutationId,
      requestFingerprint,
      PORTABLE_EXPORT_SCHEMA_VERSION,
      sourceCommit,
      sourceEnvironment,
      snapshotAt,
      snapshotAt,
      actor,
      expiresAt,
    ),
    ...SNAPSHOT_SPECS.map((spec) => recordStatement(database, exportId, spec)),
    database.prepare(`
      INSERT INTO portable_export_items (
        id, export_id, source_kind, source_id, representation,
        object_key, mime_type, byte_size, sha256
      )
      SELECT
        lower(hex(randomblob(16))), ?, 'media_object', id,
        CASE kind
          WHEN 'scan' THEN 'scan_original'
          WHEN 'original_audio' THEN 'recording_original'
          ELSE 'recording_playback'
        END,
        object_key, COALESCE(mime_type, 'application/octet-stream'), byte_size, sha256
      FROM media_objects
    `).bind(exportId),
    database.prepare(`
      INSERT INTO portable_export_items (
        id, export_id, source_kind, source_id, representation,
        object_key, mime_type, byte_size, sha256
      )
      SELECT
        lower(hex(randomblob(16))), ?, 'scan_readability', source_media_id,
        'scan_optimized', object_key, mime_type, byte_size, sha256
      FROM scan_readability_derivatives
    `).bind(exportId),
    database.prepare(`
      UPDATE portable_export_sessions
      SET state = 'ready',
          record_count = (
            SELECT COUNT(*) FROM portable_export_records WHERE export_id = ?
          ),
          item_count = (
            SELECT COUNT(*) FROM portable_export_items WHERE export_id = ?
          ),
          planned_bytes = COALESCE((
            SELECT SUM(byte_size) FROM portable_export_items WHERE export_id = ?
          ), 0),
          summary_json = json_object(
            'activeSongs', (SELECT COUNT(*) FROM songs WHERE trashed_at IS NULL),
            'trashedSongs', (SELECT COUNT(*) FROM songs WHERE trashed_at IS NOT NULL),
            'activeLyrics', (SELECT COUNT(*) FROM lyric_texts WHERE trashed_at IS NULL),
            'trashedLyrics', (SELECT COUNT(*) FROM lyric_texts WHERE trashed_at IS NOT NULL),
            'activeScans', (SELECT COUNT(*) FROM scans WHERE trashed_at IS NULL),
            'trashedScans', (SELECT COUNT(*) FROM scans WHERE trashed_at IS NOT NULL),
            'activeRecordings', (SELECT COUNT(*) FROM recordings WHERE trashed_at IS NULL),
            'trashedRecordings', (SELECT COUNT(*) FROM recordings WHERE trashed_at IS NOT NULL),
            'historyRelationships', (
              (SELECT COUNT(*) FROM scan_media_history)
              + (SELECT COUNT(*) FROM recording_media_history)
              + (SELECT COUNT(*) FROM media_parent_moves)
            ),
            'unassignedMedia', (
              SELECT COUNT(*)
              FROM media_objects
              WHERE id NOT IN (
                SELECT media_id FROM scans
                UNION SELECT original_media_id FROM recordings
                UNION SELECT playback_media_id FROM recordings WHERE playback_media_id IS NOT NULL
                UNION SELECT media_id FROM scan_media_history
                UNION SELECT original_media_id FROM recording_media_history
                UNION SELECT playback_media_id FROM recording_media_history
                  WHERE playback_media_id IS NOT NULL
              )
            )
          ),
          plan_digest = ?,
          ready_at = ?
      WHERE id = ? AND state = 'preparing'
    `).bind(exportId, exportId, exportId, planDigest, snapshotAt, exportId),
  ];
  if (statements.length !== PORTABLE_SNAPSHOT_STATEMENT_COUNT || statements.length >= 50) {
    throw new Error("portable_snapshot_query_boundary_invalid");
  }

  try {
    const results = await database.batch(statements);
    if (results.at(-1)?.meta.changes !== 1) throw new Error("portable_snapshot_not_ready");
  } catch {
    const ambiguous = await sessionByMutation(database, actor, clientMutationId).catch(() => null);
    if (ambiguous?.state === "ready") return ambiguous;
    if (ambiguous) return ambiguous;
    await database.prepare(`
      INSERT INTO portable_export_sessions (
        id, profile_version, client_mutation_id, request_fingerprint, state,
        source_schema_version, source_commit, source_environment,
        snapshot_at, created_at, created_by, expires_at,
        failed_at, failure_code
      ) VALUES (?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?, ?, ?, ?, 'snapshot_precondition_failed')
      ON CONFLICT(created_by, client_mutation_id) DO NOTHING
    `).bind(
      exportId,
      PORTABLE_EXPORT_PROFILE_VERSION,
      clientMutationId,
      requestFingerprint,
      PORTABLE_EXPORT_SCHEMA_VERSION,
      sourceCommit,
      sourceEnvironment,
      snapshotAt,
      snapshotAt,
      actor,
      expiresAt,
      snapshotAt,
    ).run().catch(() => undefined);
    const failed = await sessionByMutation(database, actor, clientMutationId).catch(() => null);
    if (failed) return failed;
    throw new Error("portable_snapshot_failed");
  }

  const created = await database.prepare(`${SESSION_SELECT} WHERE id = ? AND created_by = ?`)
    .bind(exportId, actor)
    .first<PortableExportSession>();
  if (!created) throw new Error("portable_snapshot_unavailable");
  return created;
}

export async function expirePortableExport(
  database: D1Database,
  exportId: string,
  actor: string,
  now = new Date(),
): Promise<void> {
  const timestamp = now.toISOString();
  await database.prepare(`
    UPDATE portable_export_sessions
    SET state = 'expired', expired_at = ?
    WHERE id = ? AND created_by = ? AND state = 'ready' AND expires_at <= ?
  `).bind(timestamp, exportId, actor, timestamp).run();
}

export async function loadPortableExport(
  database: D1Database,
  exportId: string,
  actor: string,
  now = new Date(),
): Promise<PortableExportSession | null> {
  await expirePortableExport(database, exportId, actor, now);
  return database.prepare(`${SESSION_SELECT} WHERE id = ? AND created_by = ?`)
    .bind(exportId, actor)
    .first<PortableExportSession>();
}

export async function revokePortableExport(
  database: D1Database,
  exportId: string,
  actor: string,
  now = new Date(),
): Promise<PortableExportSession | null> {
  await expirePortableExport(database, exportId, actor, now);
  const timestamp = now.toISOString();
  await database.prepare(`
    UPDATE portable_export_sessions
    SET state = 'revoked', revoked_at = ?
    WHERE id = ? AND created_by = ? AND state = 'ready'
  `).bind(timestamp, exportId, actor).run();
  return database.prepare(`${SESSION_SELECT} WHERE id = ? AND created_by = ?`)
    .bind(exportId, actor)
    .first<PortableExportSession>();
}

export function parsePortablePage(url: URL): { limit: number; offset: number } | null {
  const limitValue = url.searchParams.get("limit");
  const offsetValue = url.searchParams.get("offset");
  const limit = limitValue === null ? 100 : Number(limitValue);
  const offset = offsetValue === null ? 0 : Number(offsetValue);
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || limit > PORTABLE_EXPORT_PAGE_MAX
    || !Number.isSafeInteger(offset)
    || offset < 0
    || offset > 1_000_000
  ) {
    return null;
  }
  return { limit, offset };
}

export async function pagePortableExportRecords(
  database: D1Database,
  exportId: string,
  actor: string,
  page: { limit: number; offset: number },
  now = new Date(),
): Promise<{ records: PortableExportRecord[]; nextOffset: number | null } | null> {
  const session = await loadPortableExport(database, exportId, actor, now);
  if (!session || session.state !== "ready" || session.detailPurgedAt) return null;
  const result = await database.prepare(`
    SELECT
      record_kind AS kind,
      record_key AS key,
      order_key AS orderKey,
      frozen_json AS frozenJson
    FROM portable_export_records
    WHERE export_id = ?
    ORDER BY record_kind, order_key, record_key
    LIMIT ? OFFSET ?
  `).bind(exportId, page.limit + 1, page.offset).all<{
    kind: string;
    key: string;
    orderKey: string;
    frozenJson: string;
  }>();
  const hasMore = result.results.length > page.limit;
  return {
    records: result.results.slice(0, page.limit).map((row) => ({
      kind: row.kind,
      key: row.key,
      orderKey: row.orderKey,
      data: JSON.parse(row.frozenJson) as Record<string, unknown>,
    })),
    nextOffset: hasMore ? page.offset + page.limit : null,
  };
}

export async function pagePortableExportItems(
  database: D1Database,
  exportId: string,
  actor: string,
  page: { limit: number; offset: number },
  now = new Date(),
): Promise<{ items: PortableExportItem[]; nextOffset: number | null } | null> {
  const session = await loadPortableExport(database, exportId, actor, now);
  if (!session || session.state !== "ready" || session.detailPurgedAt) return null;
  const result = await database.prepare(`
    SELECT
      id,
      source_kind AS sourceKind,
      source_id AS sourceId,
      representation,
      mime_type AS mimeType,
      byte_size AS byteSize,
      sha256
    FROM portable_export_items
    WHERE export_id = ?
    ORDER BY source_kind, source_id, id
    LIMIT ? OFFSET ?
  `).bind(exportId, page.limit + 1, page.offset).all<PortableExportItem>();
  const hasMore = result.results.length > page.limit;
  return {
    items: result.results.slice(0, page.limit),
    nextOffset: hasMore ? page.offset + page.limit : null,
  };
}

export function parsePortableRange(
  value: string | undefined,
  size: number,
): { offset: number; length: number } | null | undefined {
  if (value === undefined) return undefined;
  if (value.includes(",")) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
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
  ) {
    return null;
  }
  const end = Math.min(requestedEnd, size - 1);
  return { offset, length: end - offset + 1 };
}

async function privatePortableItem(
  database: D1Database,
  exportId: string,
  itemId: string,
  actor: string,
  now = new Date(),
): Promise<PortableExportItemPrivate | null> {
  await expirePortableExport(database, exportId, actor, now);
  return database.prepare(`
    SELECT
      portable_export_items.id,
      portable_export_items.source_kind AS sourceKind,
      portable_export_items.source_id AS sourceId,
      portable_export_items.representation,
      portable_export_items.object_key AS objectKey,
      portable_export_items.mime_type AS mimeType,
      portable_export_items.byte_size AS byteSize,
      portable_export_items.sha256
    FROM portable_export_items
    JOIN portable_export_sessions
      ON portable_export_sessions.id = portable_export_items.export_id
    WHERE portable_export_items.export_id = ?
      AND portable_export_items.id = ?
      AND portable_export_sessions.created_by = ?
      AND portable_export_sessions.state = 'ready'
      AND portable_export_sessions.expires_at > ?
      AND portable_export_sessions.detail_purged_at IS NULL
  `).bind(exportId, itemId, actor, now.toISOString()).first<PortableExportItemPrivate>();
}

export async function portableExportContentResponse(
  context: PortableExportContext,
): Promise<Response> {
  const exportId = context.req.param("exportId") ?? "";
  const itemId = context.req.param("itemId") ?? "";
  if (!/^[0-9a-f]{32}$/u.test(exportId) || !/^[0-9a-f]{32}$/u.test(itemId)) {
    return context.json({ error: "portable_export_item_not_found" }, 404);
  }
  const item = await privatePortableItem(
    context.env.DB,
    exportId,
    itemId,
    context.get("appUser").identity,
  );
  if (!item) return context.json({ error: "portable_export_item_not_found" }, 404);

  const range = parsePortableRange(context.req.header("Range"), item.byteSize);
  if (range === null) {
    return new Response(null, {
      status: 416,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${item.byteSize}`,
        "Cache-Control": "private, no-store",
      },
    });
  }

  let object: R2ObjectBody | null;
  try {
    object = await context.env.MEDIA.get(
      item.objectKey,
      range ? { range } : undefined,
    );
  } catch {
    return context.json({ error: "portable_export_storage_unavailable" }, 503);
  }
  if (!object) return context.json({ error: "portable_export_item_unavailable" }, 404);
  if (object.size !== item.byteSize) {
    return context.json({ error: "portable_export_item_invalid" }, 409);
  }

  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": "attachment; filename=payload.bin",
    "Content-Type": item.mimeType,
    "X-Portable-Representation": item.representation,
  });
  if (range) {
    headers.set("Content-Length", String(range.length));
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${item.byteSize}`,
    );
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(item.byteSize));
  return new Response(object.body, { headers });
}

export async function cleanupPortableExports(
  database: D1Database,
  now = new Date(),
  limit = 2,
): Promise<{ expired: number; purgedSessions: number }> {
  const timestamp = now.toISOString();
  const expired = await database.prepare(`
    UPDATE portable_export_sessions
    SET state = 'expired', expired_at = ?
    WHERE state = 'ready' AND expires_at <= ?
  `).bind(timestamp, timestamp).run();
  const cutoff = new Date(now.getTime() - PORTABLE_EXPORT_CLEANUP_GRACE_MS).toISOString();
  const candidates = await database.prepare(`
    SELECT id
    FROM portable_export_sessions
    WHERE detail_purged_at IS NULL
      AND (
        (state = 'revoked' AND revoked_at <= ?)
        OR (state = 'expired' AND expired_at <= ?)
        OR (state = 'failed' AND failed_at <= ?)
      )
    ORDER BY COALESCE(revoked_at, expired_at, failed_at), id
    LIMIT ?
  `).bind(cutoff, cutoff, cutoff, limit).all<{ id: string }>();
  for (const candidate of candidates.results) {
    await database.batch([
      database.prepare(`
        DELETE FROM portable_export_records
        WHERE export_id = ?
          AND EXISTS (
            SELECT 1 FROM portable_export_sessions
            WHERE id = ? AND state IN ('revoked', 'expired', 'failed')
          )
      `).bind(candidate.id, candidate.id),
      database.prepare(`
        DELETE FROM portable_export_items
        WHERE export_id = ?
          AND EXISTS (
            SELECT 1 FROM portable_export_sessions
            WHERE id = ? AND state IN ('revoked', 'expired', 'failed')
          )
      `).bind(candidate.id, candidate.id),
      database.prepare(`
        UPDATE portable_export_sessions
        SET detail_purged_at = ?
        WHERE id = ? AND detail_purged_at IS NULL
          AND state IN ('revoked', 'expired', 'failed')
      `).bind(timestamp, candidate.id),
    ]);
  }
  return {
    expired: expired.meta.changes ?? 0,
    purgedSessions: candidates.results.length,
  };
}
