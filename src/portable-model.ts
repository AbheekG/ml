export const PORTABLE_PROFILE_ID = "urn:music-library:portable-archive-profile:1";
export const PORTABLE_PROFILE_VERSION = "1.0.0";
export const PORTABLE_SCHEMA_VERSION = "0023";
export const PORTABLE_TOOL_VERSION = "1.0.0";
export const MAX_PORTABLE_COMPONENT_BYTES = 120;
export const MAX_PORTABLE_PATH_BYTES = 512;

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type SnapshotRecord = {
  kind: string;
  key: string;
  orderKey: string;
  data: Record<string, JsonValue>;
};

export type FrozenExportSession = {
  id: string;
  snapshotAt: string;
  expiresAt: string;
  planDigest: string;
  sourceCommit: string;
  sourceSchemaVersion: string;
  sourceEnvironment: string;
  recordCount: number;
  itemCount: number;
  plannedBytes: number;
};

export type FrozenExportItem = {
  id: string;
  sourceKind: "media_object" | "scan_readability";
  sourceId: string;
  representation:
    | "scan_original"
    | "scan_optimized"
    | "recording_original"
    | "recording_playback";
  mimeType: string;
  byteSize: number;
  sha256: string;
  contentPath: string;
};

export type PortablePlanItem = FrozenExportItem & {
  payloadPath: string;
};

export type PortableRepresentation = {
  id: string;
  type: "MediaRepresentation";
  mediaId: string;
  semanticRole: string;
  path: string;
  mimeType: string;
  originalFilename: string | null;
  byteSize: number;
  sha256: string;
  state: string;
  createdAt: string;
  createdBy: string;
  trashedAt: string | null;
  trashedBy: string | null;
  extensions: { musicLibrary: { source: Record<string, JsonValue> } };
};

export type PortableCatalog = {
  profile: {
    id: typeof PORTABLE_PROFILE_ID;
    version: typeof PORTABLE_PROFILE_VERSION;
    bagItVersion: "1.0";
    roCrateVersion: "1.3";
  };
  export: {
    id: string;
    snapshotAt: string;
    expiresAt: string;
    planDigest: string;
    exporterVersion: string;
    builderVersion: string;
  };
  source: {
    commit: string;
    schemaVersion: string;
    environment: string;
    includedTables: string[];
    excludedTables: string[];
  };
  collection: {
    counts: Record<string, number>;
    plannedObjects: number;
    plannedBytes: number;
  };
  actors: Array<Record<string, JsonValue>>;
  languages: Array<Record<string, JsonValue>>;
  tags: Array<Record<string, JsonValue>>;
  notebooks: Array<Record<string, JsonValue>>;
  people: Array<Record<string, JsonValue>>;
  songs: Array<Record<string, JsonValue>>;
  unassignedMedia: PortableRepresentation[];
  relationshipHistory: Array<Record<string, JsonValue>>;
  extensions: {
    musicLibrary: {
      sourceCoverageVersion: "1.0.0";
      sourceRecords: Record<string, Array<Record<string, JsonValue>>>;
    };
  };
};

export type PortableExportModel = {
  catalog: PortableCatalog;
  items: PortablePlanItem[];
};

const INCLUDED_SOURCE_TABLES = [
  "app_users",
  "audio_derivatives",
  "languages",
  "lyric_texts",
  "media_objects",
  "media_parent_moves",
  "notebooks",
  "people",
  "recording_credits",
  "recording_media_history",
  "recordings",
  "scan_fingerprint_members",
  "scan_fingerprints",
  "scan_media_history",
  "scan_readability_derivatives",
  "scan_readability_selections",
  "scans",
  "song_aliases",
  "song_credits",
  "song_languages",
  "song_tags",
  "songs",
  "tags",
] as const;

const EXCLUDED_SOURCE_TABLES = [
  "audio_processing_dispatch_attempts",
  "audio_processing_jobs",
  "recording_upload_credits",
  "recording_upload_intents",
  "recording_upload_parts",
  "recording_upload_sessions",
  "scan_maintenance_failures",
  "scan_maintenance_leases",
  "d1_migrations",
  "portable_export_sessions",
  "portable_export_records",
  "portable_export_items",
  "portable_export_item_chunks",
] as const;

const encoder = new TextEncoder();
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const EXPORT_ID = /^[0-9a-f]{32}$/u;

function stringValue(row: Record<string, JsonValue>, key: string, required = true): string | null {
  const value = row[key];
  if (value === null || value === undefined) {
    if (required) throw new Error(`portable_record_missing_${key}`);
    return null;
  }
  if (typeof value !== "string") throw new Error(`portable_record_invalid_${key}`);
  return value;
}

function numberValue(row: Record<string, JsonValue>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`portable_record_invalid_${key}`);
  }
  return value;
}

function nullableNumber(row: Record<string, JsonValue>, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`portable_record_invalid_${key}`);
  }
  return value;
}

function repairUnicode(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value[index] + value[index + 1];
        index += 1;
      } else {
        output += "\ufffd";
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      output += "\ufffd";
    } else {
      output += value[index];
    }
  }
  return output;
}

function stableSuffix(stableId: string): string {
  const direct = stableId.normalize("NFC").toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (direct.length >= 8) return direct.slice(-8);
  let hash = 2166136261;
  for (const character of stableId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `${direct}${(hash >>> 0).toString(16).padStart(8, "0")}`.slice(-8);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let output = "";
  for (const character of value) {
    if (encoder.encode(output + character).byteLength > maxBytes) break;
    output += character;
  }
  return output;
}

export function portableCollisionKey(value: string): string {
  return repairUnicode(value)
    .normalize("NFC")
    .toLocaleLowerCase("und")
    .replace(/[ .]+$/gu, "");
}

export function safePortableComponent(
  source: string,
  stableId: string,
  maxBytes = MAX_PORTABLE_COMPONENT_BYTES,
): string {
  let value = repairUnicode(source)
    .normalize("NFC")
    .replace(/[\\/]/gu, "／")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/^[ .]+|[ .]+$/gu, "");
  if (!value || value === "." || value === "..") value = "Untitled";
  if (WINDOWS_RESERVED.test(value)) value = `_${value}`;

  if (encoder.encode(value).byteLength <= maxBytes) return value;
  const suffix = ` [${stableSuffix(stableId)}]`;
  const available = maxBytes - encoder.encode(suffix).byteLength;
  value = truncateUtf8(value, Math.max(1, available)).replace(/[ .]+$/gu, "") || "Item";
  return `${value}${suffix}`;
}

class SiblingNameAllocator {
  private readonly used = new Set<string>();

  allocate(source: string, stableId: string): string {
    const ordinary = safePortableComponent(source, stableId);
    const ordinaryKey = portableCollisionKey(ordinary);
    if (!this.used.has(ordinaryKey)) {
      this.used.add(ordinaryKey);
      return ordinary;
    }
    const suffix = ` [${stableSuffix(stableId)}]`;
    const available = MAX_PORTABLE_COMPONENT_BYTES - encoder.encode(suffix).byteLength;
    const base = truncateUtf8(ordinary, Math.max(1, available)).replace(/[ .]+$/gu, "") || "Item";
    let candidate = `${base}${suffix}`;
    let counter = 2;
    while (this.used.has(portableCollisionKey(candidate))) {
      const numberedSuffix = ` [${stableSuffix(stableId)}-${counter}]`;
      candidate = `${truncateUtf8(
        base,
        MAX_PORTABLE_COMPONENT_BYTES - encoder.encode(numberedSuffix).byteLength,
      ).replace(/[ .]+$/gu, "")}${numberedSuffix}`;
      counter += 1;
    }
    this.used.add(portableCollisionKey(candidate));
    return candidate;
  }
}

function assertPortablePath(path: string): void {
  if (
    path.startsWith("/")
    || path.includes("\\")
    || path.split("/").some((component) => component === "" || component === "." || component === "..")
    || encoder.encode(path).byteLength > MAX_PORTABLE_PATH_BYTES
  ) {
    throw new Error("portable_path_invalid");
  }
}

function extensionForMime(mimeType: string, filename: string | null): string {
  const normalized = mimeType.toLowerCase();
  const known: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/flac": "flac",
    "audio/ogg": "ogg",
  };
  if (known[normalized]) return known[normalized];
  const suffix = filename?.match(/\.([a-z0-9]{1,10})$/iu)?.[1]?.toLowerCase();
  return suffix && /^[a-z0-9]+$/u.test(suffix) ? suffix : "bin";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function recordGroups(records: SnapshotRecord[]): Map<string, Array<Record<string, JsonValue>>> {
  const groups = new Map<string, Array<Record<string, JsonValue>>>();
  const identities = new Set<string>();
  for (const record of [...records].sort((left, right) => (
    left.kind.localeCompare(right.kind) || left.orderKey.localeCompare(right.orderKey)
      || left.key.localeCompare(right.key)
  ))) {
    if (!INCLUDED_SOURCE_TABLES.includes(record.kind as (typeof INCLUDED_SOURCE_TABLES)[number])) {
      throw new Error("portable_record_kind_unknown");
    }
    const identity = `${record.kind}\0${record.key}`;
    if (identities.has(identity)) throw new Error("portable_record_duplicate");
    identities.add(identity);
    const values = groups.get(record.kind) ?? [];
    values.push(record.data);
    groups.set(record.kind, values);
  }
  return groups;
}

function rows(
  groups: Map<string, Array<Record<string, JsonValue>>>,
  kind: string,
): Array<Record<string, JsonValue>> {
  return groups.get(kind) ?? [];
}

function byId(
  groups: Map<string, Array<Record<string, JsonValue>>>,
  kind: string,
  field = "id",
): Map<string, Record<string, JsonValue>> {
  return new Map(rows(groups, kind).map((row) => [stringValue(row, field)!, row]));
}

function sourceExtension(row: Record<string, JsonValue>): { musicLibrary: { source: Record<string, JsonValue> } } {
  return { musicLibrary: { source: row } };
}

function portableEntity(
  row: Record<string, JsonValue>,
  type: string,
  idField = "id",
): Record<string, JsonValue> {
  return {
    id: stringValue(row, idField)!,
    type,
    extensions: sourceExtension(row) as unknown as JsonValue,
  };
}

function collectActorIds(groups: Map<string, Array<Record<string, JsonValue>>>): string[] {
  const identities = new Set<string>();
  for (const row of rows(groups, "app_users")) identities.add(stringValue(row, "identity")!);
  for (const tableRows of groups.values()) {
    for (const row of tableRows) {
      for (const [key, value] of Object.entries(row)) {
        if (
          typeof value === "string"
          && (key.endsWith("_by") || key === "moved_by" || key === "replaced_by")
        ) {
          identities.add(value);
        }
      }
    }
  }
  return [...identities].sort();
}

function mediaRepresentation(
  row: Record<string, JsonValue>,
  path: string,
  role: string,
): PortableRepresentation {
  const sha256 = stringValue(row, "sha256")!;
  const byteSize = numberValue(row, "byte_size");
  const mimeType = stringValue(row, "mime_type", false) ?? "application/octet-stream";
  if (!SHA256.test(sha256) || byteSize < 1) throw new Error("portable_media_fixity_invalid");
  assertPortablePath(path);
  return {
    id: `media:${stringValue(row, "id")}`,
    type: "MediaRepresentation",
    mediaId: stringValue(row, "id")!,
    semanticRole: role,
    path,
    mimeType,
    originalFilename: stringValue(row, "original_filename", false),
    byteSize,
    sha256,
    state: stringValue(row, "state")!,
    createdAt: stringValue(row, "created_at")!,
    createdBy: stringValue(row, "created_by")!,
    trashedAt: stringValue(row, "trashed_at", false),
    trashedBy: stringValue(row, "trashed_by", false),
    extensions: sourceExtension(row),
  };
}

function optimizedScanRepresentation(
  row: Record<string, JsonValue>,
  path: string,
): PortableRepresentation {
  const sourceId = stringValue(row, "source_media_id")!;
  const proxy: Record<string, JsonValue> = {
    id: `scan-readability:${sourceId}`,
    original_filename: null,
    mime_type: stringValue(row, "mime_type")!,
    byte_size: numberValue(row, "byte_size"),
    sha256: stringValue(row, "sha256")!,
    state: "active",
    created_at: stringValue(row, "created_at")!,
    created_by: stringValue(row, "created_by")!,
    trashed_at: null,
    trashed_by: null,
    provenance: row,
  };
  return mediaRepresentation(proxy, path, "scan_optimized");
}

type PortableScanReadabilityChoice = {
  mode: "direct" | "optimized" | "optimized_legacy" | "original_fallback";
  derivative: Record<string, JsonValue> | null;
  selection: Record<string, JsonValue> | null;
};

function scanReadabilityChoice(
  media: Record<string, JsonValue>,
  derivative: Record<string, JsonValue> | undefined,
  selection: Record<string, JsonValue> | undefined,
): PortableScanReadabilityChoice {
  const mediaId = stringValue(media, "id")!;
  if (!selection) {
    return {
      mode: derivative ? "optimized_legacy" : "original_fallback",
      derivative: derivative ?? null,
      selection: null,
    };
  }
  if (
    stringValue(selection, "source_media_id") !== mediaId
    || stringValue(selection, "source_sha256") !== stringValue(media, "sha256")
    || numberValue(selection, "source_byte_size") !== numberValue(media, "byte_size")
    || numberValue(selection, "source_width") < 1
    || numberValue(selection, "source_height") < 1
    || stringValue(selection, "policy_id") !== "scan-readability-selection-v2"
  ) {
    throw new Error("portable_scan_selection_provenance_invalid");
  }
  const representation = stringValue(selection, "representation_kind");
  const basis = stringValue(selection, "selection_basis");
  if (representation === "source") {
    if (basis !== "direct_safe_source" || derivative) {
      throw new Error("portable_scan_direct_selection_invalid");
    }
    return { mode: "direct", derivative: null, selection };
  }
  if (
    representation !== "derivative"
    || (basis !== "required_normalization" && basis !== "optional_material_savings")
    || !derivative
    || numberValue(selection, "candidate_byte_size") !== numberValue(derivative, "byte_size")
  ) {
    throw new Error("portable_scan_derivative_selection_invalid");
  }
  return { mode: "optimized", derivative, selection };
}

function sortRows(
  values: Array<Record<string, JsonValue>>,
  orderField: string,
  idField = "id",
): Array<Record<string, JsonValue>> {
  return [...values].sort((left, right) => {
    const leftOrder = nullableNumber(left, orderField) ?? 0;
    const rightOrder = nullableNumber(right, orderField) ?? 0;
    return leftOrder - rightOrder
      || (stringValue(left, idField) ?? "").localeCompare(stringValue(right, idField) ?? "");
  });
}

export async function buildPortableExportModel(
  session: FrozenExportSession,
  snapshotRecords: SnapshotRecord[],
  frozenItems: FrozenExportItem[],
): Promise<PortableExportModel> {
  if (!EXPORT_ID.test(session.id) || !SHA256.test(session.planDigest)) {
    throw new Error("portable_session_invalid");
  }
  if (session.sourceSchemaVersion !== PORTABLE_SCHEMA_VERSION) {
    throw new Error("portable_source_schema_unsupported");
  }
  if (snapshotRecords.length !== session.recordCount) {
    throw new Error("portable_record_count_mismatch");
  }
  const groups = recordGroups(snapshotRecords);
  const mediaById = byId(groups, "media_objects");
  const songById = byId(groups, "songs");
  const scanById = byId(groups, "scans");
  const recordingById = byId(groups, "recordings");
  const notebookById = byId(groups, "notebooks");
  const readabilityBySource = byId(groups, "scan_readability_derivatives", "source_media_id");
  const selectionBySource = byId(groups, "scan_readability_selections", "source_media_id");

  const itemBySource = new Map<string, FrozenExportItem>();
  for (const item of frozenItems) {
    if (
      !EXPORT_ID.test(item.id)
      || !SHA256.test(item.sha256)
      || !Number.isSafeInteger(item.byteSize)
      || item.byteSize < 1
      || !item.contentPath.startsWith(`/api/admin/portable-exports/${session.id}/items/`)
    ) {
      throw new Error("portable_item_invalid");
    }
    const sourceKey = `${item.sourceKind}:${item.sourceId}`;
    if (itemBySource.has(sourceKey)) throw new Error("portable_item_duplicate");
    itemBySource.set(sourceKey, item);
  }
  if (frozenItems.length !== session.itemCount) throw new Error("portable_item_count_mismatch");
  if (frozenItems.reduce((total, item) => total + item.byteSize, 0) !== session.plannedBytes) {
    throw new Error("portable_item_bytes_mismatch");
  }

  const songFolderAllocators = {
    active: new SiblingNameAllocator(),
    trashed: new SiblingNameAllocator(),
  };
  const songFolders = new Map<string, string>();
  for (const song of rows(groups, "songs")) {
    const id = stringValue(song, "id")!;
    const status = stringValue(song, "trashed_at", false) ? "trashed" : "active";
    const component = songFolderAllocators[status].allocate(stringValue(song, "title_latin")!, id);
    songFolders.set(id, `songs/${status}/${component}`);
  }

  const payloadPathBySource = new Map<string, string>();
  const claimPayload = (sourceKey: string, path: string) => {
    assertPortablePath(path);
    if (!payloadPathBySource.has(sourceKey)) payloadPathBySource.set(sourceKey, path);
  };

  const scansBySong = new Map<string, Array<Record<string, JsonValue>>>();
  for (const scan of rows(groups, "scans")) {
    const songId = stringValue(scan, "song_id")!;
    if (!songById.has(songId)) throw new Error("portable_scan_song_orphan");
    scansBySong.set(songId, [...(scansBySong.get(songId) ?? []), scan]);
  }
  const recordingsBySong = new Map<string, Array<Record<string, JsonValue>>>();
  for (const recording of rows(groups, "recordings")) {
    const songId = stringValue(recording, "song_id")!;
    if (!songById.has(songId)) throw new Error("portable_recording_song_orphan");
    recordingsBySong.set(songId, [...(recordingsBySong.get(songId) ?? []), recording]);
  }

  for (const song of rows(groups, "songs")) {
    const songId = stringValue(song, "id")!;
    const folder = songFolders.get(songId)!;
    const scanNames = new SiblingNameAllocator();
    const songScans = [...(scansBySong.get(songId) ?? [])].sort((left, right) => (
      (stringValue(left, "created_at") ?? "").localeCompare(stringValue(right, "created_at") ?? "")
      || stringValue(left, "id")!.localeCompare(stringValue(right, "id")!)
    ));
    songScans.forEach((scan, index) => {
      const id = stringValue(scan, "id")!;
      const mediaId = stringValue(scan, "media_id")!;
      const media = mediaById.get(mediaId);
      if (!media) throw new Error("portable_scan_media_orphan");
      const notebookId = stringValue(scan, "notebook_id", false);
      const notebook = notebookId ? notebookById.get(notebookId) : null;
      if (notebookId && !notebook) throw new Error("portable_scan_notebook_orphan");
      const label = [
        notebook ? stringValue(notebook, "display_name") : null,
        stringValue(scan, "page_label", false),
      ].filter(Boolean).join(" · ") || "Scanned page";
      const base = scanNames.allocate(
        `${String(index + 1).padStart(2, "0")} — ${label}`,
        id,
      );
      const trash = stringValue(scan, "trashed_at", false) ? "Trash/" : "";
      const extension = extensionForMime(
        stringValue(media, "mime_type", false) ?? "application/octet-stream",
        stringValue(media, "original_filename", false),
      );
      claimPayload(`media_object:${mediaId}`, `${folder}/${trash}Scans/${base} — original.${extension}`);
      if (readabilityBySource.has(mediaId)) {
        claimPayload(
          `scan_readability:${mediaId}`,
          `${folder}/${trash}Scans/${base} — optimized.jpg`,
        );
      }
    });

    const recordingNames = new SiblingNameAllocator();
    const songRecordings = [...(recordingsBySong.get(songId) ?? [])].sort((left, right) => (
      (stringValue(left, "created_at") ?? "").localeCompare(stringValue(right, "created_at") ?? "")
      || stringValue(left, "id")!.localeCompare(stringValue(right, "id")!)
    ));
    songRecordings.forEach((recording) => {
      const id = stringValue(recording, "id")!;
      const originalId = stringValue(recording, "original_media_id")!;
      const original = mediaById.get(originalId);
      if (!original) throw new Error("portable_recording_media_orphan");
      const base = recordingNames.allocate(stringValue(recording, "description")!, id);
      const trash = stringValue(recording, "trashed_at", false) ? "Trash/" : "";
      const extension = extensionForMime(
        stringValue(original, "mime_type", false) ?? "application/octet-stream",
        stringValue(original, "original_filename", false),
      );
      claimPayload(
        `media_object:${originalId}`,
        `${folder}/${trash}Recordings/${base} — original.${extension}`,
      );
      const playbackId = stringValue(recording, "playback_media_id", false);
      if (playbackId && playbackId !== originalId) {
        if (!mediaById.has(playbackId)) throw new Error("portable_recording_playback_orphan");
        claimPayload(
          `media_object:${playbackId}`,
          `${folder}/${trash}Recordings/${base} — optimized.mp3`,
        );
      }
    });
  }

  for (const history of rows(groups, "scan_media_history")) {
    const scanId = stringValue(history, "scan_id")!;
    const scan = scanById.get(scanId);
    if (!scan) throw new Error("portable_scan_history_orphan");
    const mediaId = stringValue(history, "media_id")!;
    const media = mediaById.get(mediaId);
    if (!media) throw new Error("portable_scan_history_media_orphan");
    const folder = songFolders.get(stringValue(scan, "song_id")!)!;
    const extension = extensionForMime(
      stringValue(media, "mime_type", false) ?? "application/octet-stream",
      stringValue(media, "original_filename", false),
    );
    const marker = safePortableComponent(
      `${stringValue(history, "replaced_at")} — revision ${numberValue(history, "revision_at_replacement")}`,
      stringValue(history, "id")!,
    );
    claimPayload(
      `media_object:${mediaId}`,
      `${folder}/History/Scans/${marker} — original.${extension}`,
    );
    if (readabilityBySource.has(mediaId)) {
      claimPayload(
        `scan_readability:${mediaId}`,
        `${folder}/History/Scans/${marker} — optimized.jpg`,
      );
    }
  }
  for (const history of rows(groups, "recording_media_history")) {
    const recordingId = stringValue(history, "recording_id")!;
    const recording = recordingById.get(recordingId);
    if (!recording) throw new Error("portable_recording_history_orphan");
    const folder = songFolders.get(stringValue(recording, "song_id")!)!;
    const marker = safePortableComponent(
      `${stringValue(recording, "description")} — ${stringValue(history, "replaced_at")} — revision ${numberValue(history, "revision_at_replacement")}`,
      stringValue(history, "id")!,
    );
    const originalId = stringValue(history, "original_media_id")!;
    const original = mediaById.get(originalId);
    if (!original) throw new Error("portable_recording_history_media_orphan");
    claimPayload(
      `media_object:${originalId}`,
      `${folder}/History/Recordings/${marker} — original.${extensionForMime(
        stringValue(original, "mime_type", false) ?? "application/octet-stream",
        stringValue(original, "original_filename", false),
      )}`,
    );
    const playbackId = stringValue(history, "playback_media_id", false);
    if (playbackId && playbackId !== originalId) {
      if (!mediaById.has(playbackId)) throw new Error("portable_recording_history_playback_orphan");
      claimPayload(
        `media_object:${playbackId}`,
        `${folder}/History/Recordings/${marker} — optimized.mp3`,
      );
    }
  }

  const unassigned: PortableRepresentation[] = [];
  for (const media of rows(groups, "media_objects")) {
    const id = stringValue(media, "id")!;
    const key = `media_object:${id}`;
    if (!payloadPathBySource.has(key)) {
      const extension = extensionForMime(
        stringValue(media, "mime_type", false) ?? "application/octet-stream",
        stringValue(media, "original_filename", false),
      );
      claimPayload(key, `unassigned-media/${safePortableComponent(
        `${stringValue(media, "kind")} ${id}`,
        id,
      )}.${extension}`);
      unassigned.push(mediaRepresentation(media, payloadPathBySource.get(key)!, "unassigned"));
    }
  }
  for (const derivative of rows(groups, "scan_readability_derivatives")) {
    const sourceId = stringValue(derivative, "source_media_id")!;
    const key = `scan_readability:${sourceId}`;
    if (!payloadPathBySource.has(key)) {
      claimPayload(
        key,
        `unassigned-media/${safePortableComponent(`scan readability ${sourceId}`, sourceId)}.jpg`,
      );
      unassigned.push(optimizedScanRepresentation(derivative, payloadPathBySource.get(key)!));
    }
  }

  const planItems = [...frozenItems].map((item) => {
    const path = payloadPathBySource.get(`${item.sourceKind}:${item.sourceId}`);
    if (!path) throw new Error("portable_item_source_orphan");
    const source = item.sourceKind === "media_object"
      ? mediaById.get(item.sourceId)
      : readabilityBySource.get(item.sourceId);
    if (!source) throw new Error("portable_item_source_orphan");
    if (
      numberValue(source, "byte_size") !== item.byteSize
      || stringValue(source, "sha256") !== item.sha256
      || (stringValue(source, "mime_type", false) ?? "application/octet-stream") !== item.mimeType
    ) {
      throw new Error("portable_item_source_mismatch");
    }
    return { ...item, payloadPath: path };
  }).sort((left, right) => (
    left.payloadPath.localeCompare(right.payloadPath) || left.id.localeCompare(right.id)
  ));
  if (payloadPathBySource.size !== planItems.length) throw new Error("portable_source_item_mismatch");
  const pathKeys = new Set<string>();
  for (const item of planItems) {
    const key = portableCollisionKey(item.payloadPath);
    if (pathKeys.has(key)) throw new Error("portable_payload_path_collision");
    pathKeys.add(key);
  }

  const lyricsBySong = new Map<string, Array<Record<string, JsonValue>>>();
  for (const lyric of rows(groups, "lyric_texts")) {
    const songId = stringValue(lyric, "song_id")!;
    if (!songById.has(songId)) throw new Error("portable_lyric_song_orphan");
    lyricsBySong.set(songId, [...(lyricsBySong.get(songId) ?? []), lyric]);
  }
  const aliasesBySong = new Map<string, Array<Record<string, JsonValue>>>();
  for (const alias of rows(groups, "song_aliases")) {
    const songId = stringValue(alias, "song_id")!;
    if (!songById.has(songId)) throw new Error("portable_alias_song_orphan");
    aliasesBySong.set(songId, [...(aliasesBySong.get(songId) ?? []), alias]);
  }
  const languageLinksBySong = new Map<string, Array<Record<string, JsonValue>>>();
  for (const link of rows(groups, "song_languages")) {
    const songId = stringValue(link, "song_id")!;
    languageLinksBySong.set(songId, [...(languageLinksBySong.get(songId) ?? []), link]);
  }
  const tagLinksBySong = new Map<string, Array<Record<string, JsonValue>>>();
  for (const link of rows(groups, "song_tags")) {
    const songId = stringValue(link, "song_id")!;
    tagLinksBySong.set(songId, [...(tagLinksBySong.get(songId) ?? []), link]);
  }
  const creditsBySong = new Map<string, Array<Record<string, JsonValue>>>();
  for (const credit of rows(groups, "song_credits")) {
    const songId = stringValue(credit, "song_id")!;
    creditsBySong.set(songId, [...(creditsBySong.get(songId) ?? []), credit]);
  }
  const creditsByRecording = new Map<string, Array<Record<string, JsonValue>>>();
  for (const credit of rows(groups, "recording_credits")) {
    const recordingId = stringValue(credit, "recording_id")!;
    creditsByRecording.set(
      recordingId,
      [...(creditsByRecording.get(recordingId) ?? []), credit],
    );
  }
  const scanHistoryByScan = new Map<string, Array<Record<string, JsonValue>>>();
  for (const history of rows(groups, "scan_media_history")) {
    const scanId = stringValue(history, "scan_id")!;
    scanHistoryByScan.set(scanId, [...(scanHistoryByScan.get(scanId) ?? []), history]);
  }
  const recordingHistoryByRecording = new Map<string, Array<Record<string, JsonValue>>>();
  for (const history of rows(groups, "recording_media_history")) {
    const recordingId = stringValue(history, "recording_id")!;
    recordingHistoryByRecording.set(
      recordingId,
      [...(recordingHistoryByRecording.get(recordingId) ?? []), history],
    );
  }

  const portableSongs: Array<Record<string, JsonValue>> = [];
  for (const song of rows(groups, "songs")) {
    const id = stringValue(song, "id")!;
    const folderPath = songFolders.get(id)!;
    const lyricChildren = [];
    const lyricNames = new SiblingNameAllocator();
    for (const lyric of sortRows(lyricsBySong.get(id) ?? [], "sort_order")) {
      const lyricId = stringValue(lyric, "id")!;
      const position = numberValue(lyric, "sort_order") + 1;
      const filename = lyricNames.allocate(
        `${String(position).padStart(2, "0")} — Typed lyrics.txt`,
        lyricId,
      );
      const trash = stringValue(lyric, "trashed_at", false) ? "Trash/" : "";
      const payloadPath = `${folderPath}/${trash}Lyrics/${filename}`;
      assertPortablePath(payloadPath);
      const content = stringValue(lyric, "content")!;
      const contentBytes = encoder.encode(content);
      lyricChildren.push({
        ...portableEntity(lyric, "LyricText"),
        songId: id,
        sortOrder: numberValue(lyric, "sort_order"),
        origin: stringValue(lyric, "origin"),
        revision: numberValue(lyric, "revision"),
        content,
        payloadPath,
        byteSize: contentBytes.byteLength,
        sha256: await sha256Hex(contentBytes),
        createdAt: stringValue(lyric, "created_at"),
        createdBy: stringValue(lyric, "created_by"),
        updatedAt: stringValue(lyric, "updated_at"),
        updatedBy: stringValue(lyric, "updated_by"),
        trashedAt: stringValue(lyric, "trashed_at", false),
        trashedBy: stringValue(lyric, "trashed_by", false),
      });
    }

    const scanChildren = (scansBySong.get(id) ?? []).map((scan) => {
      const scanId = stringValue(scan, "id")!;
      const mediaId = stringValue(scan, "media_id")!;
      const media = mediaById.get(mediaId)!;
      const original = mediaRepresentation(
        media,
        payloadPathBySource.get(`media_object:${mediaId}`)!,
        "scan_original",
      );
      const choice = scanReadabilityChoice(
        media,
        readabilityBySource.get(mediaId),
        selectionBySource.get(mediaId),
      );
      const optimized = choice.derivative
        ? optimizedScanRepresentation(
          choice.derivative,
          payloadPathBySource.get(`scan_readability:${mediaId}`)!,
        )
        : null;
      const history = (scanHistoryByScan.get(scanId) ?? []).map((entry) => {
        const historicalMediaId = stringValue(entry, "media_id")!;
        const historicalMedia = mediaById.get(historicalMediaId)!;
        const historicalChoice = scanReadabilityChoice(
          historicalMedia,
          readabilityBySource.get(historicalMediaId),
          selectionBySource.get(historicalMediaId),
        );
        const historicalOriginalPath = payloadPathBySource.get(
          `media_object:${historicalMediaId}`,
        )!;
        const historicalOptimized = historicalChoice.derivative
          ? optimizedScanRepresentation(
            historicalChoice.derivative,
            payloadPathBySource.get(`scan_readability:${historicalMediaId}`)!,
          )
          : null;
        return {
          ...portableEntity(entry, "ScanReplacement"),
          mediaId: historicalMediaId,
          path: historicalOriginalPath,
          original: mediaRepresentation(
            historicalMedia,
            historicalOriginalPath,
            "scan_historical_original",
          ) as unknown as JsonValue,
          optimized: historicalOptimized as unknown as JsonValue,
          readability: historicalChoice.mode,
          readabilityPath: historicalOptimized?.path ?? historicalOriginalPath,
          readabilitySelection: historicalChoice.selection as unknown as JsonValue,
          replacedAt: stringValue(entry, "replaced_at"),
          replacedBy: stringValue(entry, "replaced_by"),
          revisionAtReplacement: numberValue(entry, "revision_at_replacement"),
        };
      });
      return {
        ...portableEntity(scan, "Scan"),
        songId: id,
        notebookId: stringValue(scan, "notebook_id", false),
        pageLabel: stringValue(scan, "page_label", false),
        rotationQuarterTurns: numberValue(scan, "rotation_quarter_turns"),
        revision: numberValue(scan, "revision"),
        original: original as unknown as JsonValue,
        optimized: optimized as unknown as JsonValue,
        readability: choice.mode,
        readabilityPath: optimized?.path ?? original.path,
        readabilitySelection: choice.selection as unknown as JsonValue,
        replacementHistory: history as unknown as JsonValue,
        createdAt: stringValue(scan, "created_at"),
        createdBy: stringValue(scan, "created_by"),
        updatedAt: stringValue(scan, "updated_at"),
        updatedBy: stringValue(scan, "updated_by"),
        trashedAt: stringValue(scan, "trashed_at", false),
        trashedBy: stringValue(scan, "trashed_by", false),
      };
    });
    const recordingChildren = (recordingsBySong.get(id) ?? []).map((recording) => {
      const recordingId = stringValue(recording, "id")!;
      const originalId = stringValue(recording, "original_media_id")!;
      const playbackId = stringValue(recording, "playback_media_id", false);
      const original = mediaRepresentation(
        mediaById.get(originalId)!,
        payloadPathBySource.get(`media_object:${originalId}`)!,
        "recording_original",
      );
      let playback: string;
      let playbackPath: string | null;
      let optimized: PortableRepresentation | null = null;
      if (playbackId && playbackId !== originalId) {
        playback = "optimized";
        playbackPath = payloadPathBySource.get(`media_object:${playbackId}`)!;
        optimized = mediaRepresentation(
          mediaById.get(playbackId)!,
          playbackPath,
          "recording_playback",
        );
      } else if (
        stringValue(recording, "processing_state") === "ready"
        && (stringValue(mediaById.get(originalId)!, "mime_type", false) === "audio/mpeg")
      ) {
        playback = "original";
        playbackPath = original.path;
      } else {
        playback = "unavailable";
        playbackPath = null;
      }
      const history = (recordingHistoryByRecording.get(recordingId) ?? []).map((entry) => {
        const historicalOriginalId = stringValue(entry, "original_media_id")!;
        const historicalOriginalPath = payloadPathBySource.get(
          `media_object:${historicalOriginalId}`,
        )!;
        const historicalPlaybackId = stringValue(entry, "playback_media_id", false);
        const distinctPlayback = historicalPlaybackId
          && historicalPlaybackId !== historicalOriginalId;
        const historicalPlaybackPath = historicalPlaybackId
          ? payloadPathBySource.get(`media_object:${historicalPlaybackId}`) ?? null
          : null;
        return {
          ...portableEntity(entry, "RecordingReplacement"),
          originalMediaId: historicalOriginalId,
          originalPath: historicalOriginalPath,
          original: mediaRepresentation(
            mediaById.get(historicalOriginalId)!,
            historicalOriginalPath,
            "recording_historical_original",
          ) as unknown as JsonValue,
          playbackMediaId: historicalPlaybackId,
          playback: historicalPlaybackId
            ? distinctPlayback ? "optimized" : "original"
            : "unavailable",
          playbackPath: historicalPlaybackPath,
          optimized: distinctPlayback
            ? mediaRepresentation(
              mediaById.get(historicalPlaybackId)!,
              historicalPlaybackPath!,
              "recording_historical_playback",
            ) as unknown as JsonValue
            : null,
          replacedAt: stringValue(entry, "replaced_at"),
          replacedBy: stringValue(entry, "replaced_by"),
          revisionAtReplacement: numberValue(entry, "revision_at_replacement"),
        };
      });
      return {
        ...portableEntity(recording, "Recording"),
        songId: id,
        description: stringValue(recording, "description"),
        normalizedDescription: stringValue(recording, "normalized_description"),
        recordedOn: stringValue(recording, "recorded_on", false),
        processingState: stringValue(recording, "processing_state"),
        processingError: stringValue(recording, "processing_error", false),
        revision: numberValue(recording, "revision"),
        original: original as unknown as JsonValue,
        playback,
        playbackPath,
        optimized: optimized as unknown as JsonValue,
        credits: sortRows(creditsByRecording.get(recordingId) ?? [], "sort_order")
          .map((credit) => portableEntity(credit, "RecordingCredit")) as unknown as JsonValue,
        replacementHistory: history as unknown as JsonValue,
        createdAt: stringValue(recording, "created_at"),
        createdBy: stringValue(recording, "created_by"),
        updatedAt: stringValue(recording, "updated_at"),
        updatedBy: stringValue(recording, "updated_by"),
        trashedAt: stringValue(recording, "trashed_at", false),
        trashedBy: stringValue(recording, "trashed_by", false),
      };
    });
    portableSongs.push({
      ...portableEntity(song, "Song"),
      titleLatin: stringValue(song, "title_latin"),
      titleNative: stringValue(song, "title_native", false),
      normalizedTitleLatin: stringValue(song, "normalized_title_latin"),
      status: stringValue(song, "status"),
      notes: stringValue(song, "notes", false),
      revision: numberValue(song, "revision"),
      lastMutationId: stringValue(song, "last_mutation_id", false),
      folderPath,
      languageIds: sortRows(languageLinksBySong.get(id) ?? [], "sort_order", "language_id")
        .map((link) => stringValue(link, "language_id")) as unknown as JsonValue,
      tagIds: sortRows(tagLinksBySong.get(id) ?? [], "sort_order", "tag_id")
        .map((link) => stringValue(link, "tag_id")) as unknown as JsonValue,
      aliases: sortRows(aliasesBySong.get(id) ?? [], "sort_order")
        .map((alias) => portableEntity(alias, "SongAlias")) as unknown as JsonValue,
      credits: sortRows(creditsBySong.get(id) ?? [], "sort_order")
        .map((credit) => portableEntity(credit, "SongCredit")) as unknown as JsonValue,
      lyricTexts: lyricChildren as unknown as JsonValue,
      scans: scanChildren as unknown as JsonValue,
      recordings: recordingChildren as unknown as JsonValue,
      createdAt: stringValue(song, "created_at"),
      createdBy: stringValue(song, "created_by"),
      updatedAt: stringValue(song, "updated_at"),
      updatedBy: stringValue(song, "updated_by"),
      trashedAt: stringValue(song, "trashed_at", false),
      trashedBy: stringValue(song, "trashed_by", false),
    });
  }

  const appUsers = byId(groups, "app_users", "identity");
  const actors = collectActorIds(groups).map((identity) => {
    const user = appUsers.get(identity);
    return {
      id: identity,
      type: identity.startsWith("system:") ? "SystemActor" : "HistoricalActor",
      identity,
      displayName: user ? stringValue(user, "display_name", false) : null,
      observedRole: user ? stringValue(user, "role") : null,
      observedActive: user ? numberValue(user, "is_active") === 1 : false,
      restoreAsActive: false,
      createdAt: user ? stringValue(user, "created_at") : null,
      updatedAt: user ? stringValue(user, "updated_at") : null,
      extensions: {
        musicLibrary: { source: user ?? { identity, inferred: true } },
      },
    } as unknown as Record<string, JsonValue>;
  });

  const sourceRecords = Object.fromEntries(
    [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
  const counts: Record<string, number> = {};
  for (const [kind, values] of Object.entries(sourceRecords)) counts[kind] = values.length;
  counts.activeSongs = rows(groups, "songs").filter((row) => !stringValue(row, "trashed_at", false)).length;
  counts.trashedSongs = rows(groups, "songs").length - counts.activeSongs;
  counts.activeLyrics = rows(groups, "lyric_texts").filter((row) => !stringValue(row, "trashed_at", false)).length;
  counts.trashedLyrics = rows(groups, "lyric_texts").length - counts.activeLyrics;
  counts.activeScans = rows(groups, "scans").filter((row) => !stringValue(row, "trashed_at", false)).length;
  counts.trashedScans = rows(groups, "scans").length - counts.activeScans;
  counts.activeRecordings = rows(groups, "recordings").filter((row) => !stringValue(row, "trashed_at", false)).length;
  counts.trashedRecordings = rows(groups, "recordings").length - counts.activeRecordings;
  counts.unassignedMedia = unassigned.length;

  return {
    catalog: {
      profile: {
        id: PORTABLE_PROFILE_ID,
        version: PORTABLE_PROFILE_VERSION,
        bagItVersion: "1.0",
        roCrateVersion: "1.3",
      },
      export: {
        id: session.id,
        snapshotAt: session.snapshotAt,
        expiresAt: session.expiresAt,
        planDigest: session.planDigest,
        exporterVersion: PORTABLE_TOOL_VERSION,
        builderVersion: PORTABLE_TOOL_VERSION,
      },
      source: {
        commit: session.sourceCommit,
        schemaVersion: session.sourceSchemaVersion,
        environment: session.sourceEnvironment,
        includedTables: [...INCLUDED_SOURCE_TABLES],
        excludedTables: [...EXCLUDED_SOURCE_TABLES],
      },
      collection: {
        counts,
        plannedObjects: planItems.length,
        plannedBytes: planItems.reduce((total, item) => total + item.byteSize, 0),
      },
      actors,
      languages: rows(groups, "languages").map((row) => portableEntity(row, "Language")),
      tags: rows(groups, "tags").map((row) => portableEntity(row, "Tag")),
      notebooks: rows(groups, "notebooks").map((row) => portableEntity(row, "Notebook")),
      people: rows(groups, "people").map((row) => portableEntity(row, "Person")),
      songs: portableSongs,
      unassignedMedia: unassigned.sort((left, right) => left.path.localeCompare(right.path)),
      relationshipHistory: rows(groups, "media_parent_moves")
        .map((row) => portableEntity(row, "MediaParentMove")),
      extensions: {
        musicLibrary: {
          sourceCoverageVersion: "1.0.0",
          sourceRecords,
        },
      },
    },
    items: planItems,
  };
}
