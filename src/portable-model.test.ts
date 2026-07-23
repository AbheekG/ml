import { describe, expect, it } from "vitest";
import {
  buildPortableExportModel,
  portableCollisionKey,
  safePortableComponent,
  type FrozenExportItem,
  type FrozenExportSession,
  type SnapshotRecord,
} from "./portable-model";

const stamp = "2026-07-24T10:00:00.000Z";
const actor = "system:synthetic-editor";
const hashes = {
  scan: "1".repeat(64),
  optimizedScan: "2".repeat(64),
  directAudio: "3".repeat(64),
  originalAudio: "4".repeat(64),
  playbackAudio: "5".repeat(64),
  historicalAudio: "6".repeat(64),
  unassigned: "7".repeat(64),
};

function record(
  kind: string,
  key: string,
  data: Record<string, string | number | boolean | null>,
): SnapshotRecord {
  return { kind, key, orderKey: key, data };
}

function media(
  id: string,
  filename: string,
  mimeType: string,
  byteSize: number,
  sha256: string,
  kind: string,
  state = "active",
): SnapshotRecord {
  return record("media_objects", id, {
    id,
    original_filename: filename,
    mime_type: mimeType,
    byte_size: byteSize,
    sha256,
    kind,
    state,
    created_at: stamp,
    created_by: actor,
    trashed_at: state === "trashed" ? stamp : null,
    trashed_by: state === "trashed" ? actor : null,
  });
}

const session: FrozenExportSession = {
  id: "a".repeat(32),
  snapshotAt: stamp,
  expiresAt: "2026-07-25T10:00:00.000Z",
  planDigest: "b".repeat(64),
  sourceCommit: "1234567890abcdef1234567890abcdef12345678",
  sourceSchemaVersion: "0021",
  sourceEnvironment: "synthetic-test",
  recordCount: 0,
  itemCount: 7,
  plannedBytes: 280,
};

const records: SnapshotRecord[] = [
  record("app_users", actor, {
    identity: actor,
    display_name: "Synthetic editor",
    role: "admin",
    is_active: 1,
    created_at: stamp,
    updated_at: stamp,
  }),
  record("languages", "language-1", {
    id: "language-1",
    display_name: "Language One",
    bcp47_tag: "und",
    sort_order: 0,
    normalized_name: "language one",
  }),
  record("tags", "tag-1", {
    id: "tag-1",
    display_name: "Tag One",
    sort_order: 0,
    normalized_name: "tag one",
  }),
  record("notebooks", "notebook-1", {
    id: "notebook-1",
    display_name: "Notebook One",
    sort_order: 0,
    normalized_name: "notebook one",
  }),
  record("people", "person-1", {
    id: "person-1",
    full_name: "Synthetic Person",
    normalized_name: "synthetic person",
    created_at: stamp,
    updated_at: stamp,
  }),
  record("songs", "song-active-0001", {
    id: "song-active-0001",
    title_latin: "Example / Song.",
    title_native: "示例",
    status: "checked",
    notes: "Synthetic note",
    revision: 3,
    created_at: stamp,
    created_by: actor,
    updated_at: stamp,
    updated_by: actor,
    trashed_at: null,
    trashed_by: null,
    normalized_title_latin: "example / song.",
    last_mutation_id: "mutation-1",
  }),
  record("songs", "song-trashed-0002", {
    id: "song-trashed-0002",
    title_latin: "example \\ song",
    title_native: null,
    status: "draft",
    notes: null,
    revision: 2,
    created_at: stamp,
    created_by: actor,
    updated_at: stamp,
    updated_by: actor,
    trashed_at: stamp,
    trashed_by: actor,
    normalized_title_latin: "example \\ song",
    last_mutation_id: null,
  }),
  record("song_languages", "song-active-0001:language-1", {
    song_id: "song-active-0001",
    language_id: "language-1",
    sort_order: 0,
  }),
  record("song_tags", "song-active-0001:tag-1", {
    song_id: "song-active-0001",
    tag_id: "tag-1",
    sort_order: 0,
  }),
  record("song_aliases", "alias-1", {
    id: "alias-1",
    song_id: "song-active-0001",
    alias: "Neutral Alias",
    normalized_alias: "neutral alias",
    sort_order: 0,
  }),
  record("song_credits", "song-credit-1", {
    id: "song-credit-1",
    song_id: "song-active-0001",
    person_id: "person-1",
    role: "lyrics",
    sort_order: 0,
  }),
  record("lyric_texts", "lyric-active-1", {
    id: "lyric-active-1",
    song_id: "song-active-0001",
    content: "Synthetic line one\r\nSynthetic line two",
    origin: "legacy_import",
    sort_order: 0,
    revision: 1,
    created_at: stamp,
    created_by: actor,
    updated_at: stamp,
    updated_by: actor,
    trashed_at: null,
    trashed_by: null,
  }),
  record("lyric_texts", "lyric-trashed-2", {
    id: "lyric-trashed-2",
    song_id: "song-active-0001",
    content: "Synthetic removed block",
    origin: "user",
    sort_order: 1,
    revision: 2,
    created_at: stamp,
    created_by: actor,
    updated_at: stamp,
    updated_by: actor,
    trashed_at: stamp,
    trashed_by: actor,
  }),
  media("scan-media-1", "device-name.jpeg", "image/jpeg", 10, hashes.scan, "scan"),
  media("audio-direct-1", "direct.mp3", "audio/mpeg", 20, hashes.directAudio, "original_audio"),
  media("audio-original-2", "source.wav", "audio/wav", 30, hashes.originalAudio, "original_audio", "trashed"),
  media("audio-playback-2", "playback.mp3", "audio/mpeg", 40, hashes.playbackAudio, "playback_audio", "trashed"),
  media("audio-history-2", "history.flac", "audio/flac", 50, hashes.historicalAudio, "original_audio"),
  media("unassigned-1", "loose.ogg", "audio/ogg", 60, hashes.unassigned, "original_audio"),
  record("scan_readability_derivatives", "scan-media-1", {
    source_media_id: "scan-media-1",
    source_sha256: hashes.scan,
    source_byte_size: 10,
    mime_type: "image/jpeg",
    byte_size: 70,
    sha256: hashes.optimizedScan,
    width: 100,
    height: 200,
    policy_id: "scan-jpeg-v1-2400-q85",
    created_at: stamp,
    created_by: "system:scan-maintenance",
  }),
  record("scans", "scan-1", {
    id: "scan-1",
    song_id: "song-active-0001",
    media_id: "scan-media-1",
    notebook_id: "notebook-1",
    page_label: "1 / 2",
    legacy_version: "v1",
    legacy_captured_on: null,
    legacy_source: "Notebook",
    legacy_scan_text: null,
    legacy_notes: null,
    revision: 1,
    created_at: stamp,
    created_by: actor,
    updated_at: stamp,
    updated_by: actor,
    trashed_at: null,
    trashed_by: null,
    rotation_quarter_turns: 3,
  }),
  record("recordings", "recording-direct-1", {
    id: "recording-direct-1",
    song_id: "song-active-0001",
    original_media_id: "audio-direct-1",
    playback_media_id: null,
    legacy_version: null,
    recorded_on: "2026-07-01",
    legacy_notes: null,
    revision: 1,
    created_at: stamp,
    created_by: actor,
    updated_at: stamp,
    updated_by: actor,
    trashed_at: null,
    trashed_by: null,
    description: "Direct playback",
    normalized_description: "direct playback",
    processing_state: "ready",
    processing_error: null,
  }),
  record("recordings", "recording-optimized-2", {
    id: "recording-optimized-2",
    song_id: "song-trashed-0002",
    original_media_id: "audio-original-2",
    playback_media_id: "audio-playback-2",
    legacy_version: "take",
    recorded_on: null,
    legacy_notes: "Synthetic legacy note",
    revision: 2,
    created_at: stamp,
    created_by: actor,
    updated_at: stamp,
    updated_by: actor,
    trashed_at: stamp,
    trashed_by: actor,
    description: "Optimized playback",
    normalized_description: "optimized playback",
    processing_state: "ready",
    processing_error: null,
  }),
  record("recording_credits", "recording-credit-1", {
    id: "recording-credit-1",
    recording_id: "recording-direct-1",
    person_id: "person-1",
    role: "vocals",
    sort_order: 0,
  }),
  record("recording_media_history", "recording-history-1", {
    id: "recording-history-1",
    recording_id: "recording-optimized-2",
    original_media_id: "audio-history-2",
    playback_media_id: null,
    replaced_at: stamp,
    replaced_by: actor,
    revision_at_replacement: 1,
  }),
  record("scan_fingerprints", hashes.scan, {
    sha256: hashes.scan,
    canonical_media_id: "scan-media-1",
    first_seen_at: stamp,
  }),
  record("scan_fingerprint_members", "scan-media-1", {
    media_id: "scan-media-1",
    sha256: hashes.scan,
    is_historical_duplicate: 0,
    registered_at: stamp,
  }),
  record("audio_derivatives", "audio-playback-2", {
    playback_media_id: "audio-playback-2",
    source_media_id: "audio-original-2",
    policy_id: "mp3-v1-libmp3lame-q2",
    source_sha256: hashes.originalAudio,
    source_byte_size: 30,
    derivative_sha256: hashes.playbackAudio,
    derivative_byte_size: 40,
  }),
  record("media_parent_moves", "move-1", {
    id: "move-1",
    scan_id: null,
    recording_id: "recording-optimized-2",
    from_song_id: "song-active-0001",
    to_song_id: "song-trashed-0002",
    moved_at: stamp,
    moved_by: actor,
  }),
];

const itemSpecs = [
  ["scan-media-1", "media_object", "scan_original", 10, hashes.scan, "image/jpeg"],
  ["scan-media-1", "scan_readability", "scan_optimized", 70, hashes.optimizedScan, "image/jpeg"],
  ["audio-direct-1", "media_object", "recording_original", 20, hashes.directAudio, "audio/mpeg"],
  ["audio-original-2", "media_object", "recording_original", 30, hashes.originalAudio, "audio/wav"],
  ["audio-playback-2", "media_object", "recording_playback", 40, hashes.playbackAudio, "audio/mpeg"],
  ["audio-history-2", "media_object", "recording_original", 50, hashes.historicalAudio, "audio/flac"],
  ["unassigned-1", "media_object", "recording_original", 60, hashes.unassigned, "audio/ogg"],
] as const;

const items: FrozenExportItem[] = itemSpecs.map((
  [sourceId, sourceKind, representation, byteSize, sha256, mimeType],
  index,
) => {
  const id = (index + 1).toString(16).padStart(32, "0");
  return {
    id,
    sourceKind,
    sourceId,
    representation,
    mimeType,
    byteSize,
    sha256,
    contentPath: `/api/admin/portable-exports/${session.id}/items/${id}/content`,
  };
});

describe("portable archive model", () => {
  it("normalizes unsafe components without splitting Unicode and detects portable collisions", () => {
    expect(safePortableComponent(" CON. ", "stable-1")).toBe("_CON");
    expect(safePortableComponent("one/two\\three\u0000", "stable-2")).toBe("one／two／three");
    expect(safePortableComponent("\ud800x", "stable-3")).toBe("\ufffdx");
    expect(portableCollisionKey("Résumé. ")).toBe(portableCollisionKey("RÉSUMÉ"));
    const long = safePortableComponent("🎼".repeat(100), "stable-long");
    expect(new TextEncoder().encode(long).byteLength).toBeLessThanOrEqual(120);
    expect(long).toMatch(/\[[a-z0-9]{8}\]$/u);
  });

  it("builds complete deterministic active, Trash, history, derivative, and unassigned paths", async () => {
    const first = await buildPortableExportModel(session, records, items);
    const second = await buildPortableExportModel(
      session,
      [...records].reverse(),
      [...items].reverse(),
    );
    expect(second).toEqual(first);
    expect(first.catalog.songs).toHaveLength(2);
    expect(first.catalog.collection.plannedObjects).toBe(7);
    expect(first.catalog.collection.plannedBytes).toBe(280);
    expect(first.catalog.collection.counts.trashedSongs).toBe(1);
    expect(first.catalog.collection.counts.trashedLyrics).toBe(1);
    expect(first.catalog.unassignedMedia).toHaveLength(1);
    expect(first.items.map((item) => item.payloadPath)).toEqual(expect.arrayContaining([
      expect.stringContaining("/Scans/"),
      expect.stringContaining("optimized.jpg"),
      expect.stringContaining("/Trash/Recordings/"),
      expect.stringContaining("/History/Recordings/"),
      expect.stringContaining("unassigned-media/"),
    ]));
    expect(JSON.stringify(first)).not.toContain("object_key");
    expect(JSON.stringify(first)).not.toContain("r2_upload_id");
  });

  it("stores original-as-playback once while retaining distinct derivative provenance", async () => {
    const model = await buildPortableExportModel(session, records, items);
    const active = model.catalog.songs.find((song) => song.id === "song-active-0001")!;
    const direct = (active.recordings as Array<Record<string, unknown>>)
      .find((recording) => recording.id === "recording-direct-1")!;
    expect(direct.playback).toBe("original");
    expect(direct.playbackPath).toBe((direct.original as Record<string, unknown>).path);
    expect(direct.optimized).toBeNull();
    expect(model.items.filter((item) => item.sourceId === "audio-direct-1")).toHaveLength(1);

    const trashed = model.catalog.songs.find((song) => song.id === "song-trashed-0002")!;
    const optimized = (trashed.recordings as Array<Record<string, unknown>>)[0]!;
    expect(optimized.playback).toBe("optimized");
    expect(optimized.playbackPath).not.toBe((optimized.original as Record<string, unknown>).path);
  });

  it("rejects missing plan items, altered fixity, and cross-platform path collisions", async () => {
    await expect(buildPortableExportModel(
      { ...session, itemCount: 6, plannedBytes: 270 },
      records,
      items.slice(1),
    )).rejects.toThrow("portable_source_item_mismatch");

    const corrupt = items.map((item, index) => index === 0 ? { ...item, sha256: "f".repeat(64) } : item);
    await expect(buildPortableExportModel(session, records, corrupt))
      .rejects.toThrow("portable_item_source_mismatch");
  });
});

