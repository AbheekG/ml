import Dexie, { type EntityTable } from "dexie";

export type CatalogSong = {
  id: string;
  titleLatin: string;
  titleNative: string | null;
  updatedAt: string;
  languageIds: string[];
  lyricCount: number;
  scanCount: number;
  recordingCount: number;
};

type Credit = {
  personId: string;
  fullName: string;
  role: string;
};

export type SongScan = {
  id: string;
  mediaId: string;
  notebookId: string | null;
  notebookName: string | null;
  pageLabel: string | null;
  revision: number;
  filename: string;
};

export type SongDetail = {
  id: string;
  titleLatin: string;
  titleNative: string | null;
  status: string | null;
  notes: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  aliases: string[];
  languages: Array<{ id: string; displayName: string }>;
  tags: Array<{ id: string; displayName: string }>;
  credits: Credit[];
  lyricTexts: Array<{
    id: string;
    content: string;
    origin: "user" | "legacy_import";
    revision: number;
  }>;
  scans: SongScan[];
  recordings: Array<{
    id: string;
    originalMediaId: string;
    playbackMediaId: string | null;
    description: string;
    recordedOn: string | null;
    revision: number;
    processingState: "processing" | "ready" | "failed";
    filename: string;
    hasPlaybackMedia: boolean;
    credits: Credit[];
  }>;
};

type CatalogMetadata = {
  key: "catalog";
  syncedAt: string;
};

const database = new Dexie("music-library") as Dexie & {
  songs: EntityTable<CatalogSong, "id">;
  songDetails: EntityTable<SongDetail, "id">;
  metadata: EntityTable<CatalogMetadata, "key">;
};

database.version(1).stores({
  songs: "id, titleLatin, titleNative, updatedAt, *languageIds",
  metadata: "key",
});

database.version(2).stores({
  songs: "id, titleLatin, titleNative, updatedAt, *languageIds",
  songDetails: "id, titleLatin, updatedAt",
  metadata: "key",
});

export async function readCachedCatalog(): Promise<{
  songs: CatalogSong[];
  syncedAt: string | null;
}> {
  const [songs, metadata] = await Promise.all([
    database.songs.orderBy("titleLatin").toArray(),
    database.metadata.get("catalog"),
  ]);
  return { songs, syncedAt: metadata?.syncedAt ?? null };
}

export async function refreshCatalog(): Promise<{
  songs: CatalogSong[];
  syncedAt: string;
}> {
  const response = await fetch("/api/catalog", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Catalog request failed (${response.status})`);

  const payload = await response.json() as { songs: CatalogSong[] };
  const syncedAt = new Date().toISOString();
  await database.transaction("rw", database.songs, database.metadata, async () => {
    await database.songs.clear();
    await database.songs.bulkPut(payload.songs);
    await database.metadata.put({ key: "catalog", syncedAt });
  });
  return { songs: payload.songs, syncedAt };
}

function summarizeSong(song: SongDetail): CatalogSong {
  return {
    id: song.id,
    titleLatin: song.titleLatin,
    titleNative: song.titleNative,
    updatedAt: song.updatedAt,
    languageIds: song.languages.map((language) => language.id),
    lyricCount: song.lyricTexts.length,
    scanCount: song.scans.length,
    recordingCount: song.recordings.length,
  };
}

export async function refreshOfflineLibrary(): Promise<{
  songs: CatalogSong[];
  syncedAt: string;
}> {
  const response = await fetch("/api/offline-library", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Offline library request failed (${response.status})`);

  const payload = await response.json() as { songs: SongDetail[] };
  const songs = payload.songs.map(summarizeSong);
  const syncedAt = new Date().toISOString();
  await database.transaction("rw", database.songs, database.songDetails, database.metadata, async () => {
    await Promise.all([database.songs.clear(), database.songDetails.clear()]);
    await Promise.all([
      database.songs.bulkPut(songs),
      database.songDetails.bulkPut(payload.songs),
      database.metadata.put({ key: "catalog", syncedAt }),
    ]);
  });
  return { songs, syncedAt };
}

export async function readCachedSong(songId: string): Promise<SongDetail | undefined> {
  return database.songDetails.get(songId);
}

export async function refreshSong(songId: string): Promise<SongDetail> {
  const response = await fetch(`/api/songs/${encodeURIComponent(songId)}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Song request failed (${response.status})`);

  const payload = await response.json() as { song: SongDetail };
  await database.songDetails.put(payload.song);
  return payload.song;
}

export type AppSession = {
  displayName: string | null;
  role: "viewer" | "editor" | "admin";
};

export type SongEditorOptions = {
  languages: Array<{ id: string; displayName: string }>;
  tags: Array<{ id: string; displayName: string }>;
  people: Array<{ id: string; fullName: string }>;
  statuses: Array<"draft" | "checked">;
};

export type SongWritePayload = {
  titleLatin: string;
  titleNative: string | null;
  status: "draft" | "checked";
  languageIds: string[];
  tagIds: string[];
  aliases: string[];
  credits: Array<{ personId: string; role: "lyrics" | "music" }>;
  notes: string | null;
};

export type TrashedLyric = {
  id: string;
  songId: string;
  songTitle: string;
  content: string;
  origin: "user" | "legacy_import";
  revision: number;
  trashedAt: string;
  songIsTrashed: boolean;
};

export type TrashedSong = {
  id: string;
  titleLatin: string;
  titleNative: string | null;
  revision: number;
  trashedAt: string;
  lyricCount: number;
  scanCount: number;
  recordingCount: number;
};

export type TrashedScan = {
  id: string;
  songId: string;
  songTitle: string;
  filename: string;
  notebookName: string | null;
  pageLabel: string | null;
  revision: number;
  trashedAt: string;
  songIsTrashed: boolean;
};

export type ScanEditorOptions = {
  notebooks: Array<{ id: string; displayName: string }>;
};

export type TrashedRecording = {
  id: string;
  songId: string;
  songTitle: string;
  description: string;
  recordedOn: string | null;
  filename: string;
  revision: number;
  trashedAt: string;
  songIsTrashed: boolean;
};

export type RecordingEditorOptions = {
  people: Array<{ id: string; fullName: string }>;
};

export const LOOKUP_KINDS = ["languages", "tags", "notebooks", "people"] as const;
export type LookupKind = typeof LOOKUP_KINDS[number];
export type LookupItem = { id: string; name: string };
export type LookupCollections = Record<LookupKind, LookupItem[]>;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly fields?: Record<string, string[]>,
  ) {
    super(message);
  }
}

function apiErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    duplicate_song_title: "Another active song already has this title.",
    duplicate_song_alias: "This song has duplicate aliases.",
    edit_conflict: "This song changed after you opened it. Reload it and try again.",
    invalid_reference: "A selected Language, Tag, or contributor no longer exists. Reload the form.",
    insufficient_role: "Your account cannot edit songs.",
    song_not_found: "This song is no longer available.",
    song_has_active_content: "Move this Song’s active typed lyrics, Scans, and Recordings to Trash first.",
    song_trash_conflict: "This Song changed after you opened it. Reload and try again.",
    song_already_trashed: "This Song is already in Trash.",
    song_not_trashed: "This Song has already been restored.",
    duplicate_lyric_text: "This song already has an identical typed-lyrics block.",
    lyric_edit_conflict: "These typed lyrics changed after you opened them. Reload and try again.",
    lyric_not_found: "These typed lyrics are no longer available.",
    lyric_already_trashed: "These typed lyrics are already in Trash.",
    lyric_not_trashed: "These typed lyrics have already been restored.",
    lyric_parent_trashed: "Restore the parent Song before restoring these typed lyrics.",
    invalid_scan_reference: "The selected Notebook is no longer available. Reload the form.",
    scan_edit_conflict: "This Scan changed after you opened it. Reload and try again.",
    scan_not_found: "This Scan is no longer available.",
    scan_already_trashed: "This Scan is already in Trash.",
    scan_not_trashed: "This Scan has already been restored.",
    scan_parent_trashed: "Restore the parent Song before restoring this Scan.",
    scan_media_unavailable: "The Scan file is not in the expected recovery state.",
    duplicate_recording_description: "This Song already has an active Recording with the same description.",
    invalid_recording_reference: "A selected contributor is no longer available. Reload the form.",
    recording_edit_conflict: "This Recording changed after you opened it. Reload and try again.",
    recording_not_found: "This Recording is no longer available.",
    recording_already_trashed: "This Recording is already in Trash.",
    recording_not_trashed: "This Recording has already been restored.",
    recording_parent_trashed: "Restore the parent Song before restoring this Recording.",
    recording_media_unavailable: "The Recording files are not in the expected recovery state.",
    duplicate_lookup_name: "That name already exists in this list.",
    lookup_edit_conflict: "This name changed after you opened it. Reload the list and try again.",
    lookup_not_found: "This list item is no longer available.",
    invalid_lookup: "Enter a valid name.",
  };
  return messages[code] ?? "The change could not be saved.";
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", ...init?.headers },
  });
  const payload = await response.json().catch(() => ({})) as {
    error?: string;
    fields?: Record<string, string[]>;
  } & T;
  if (!response.ok) {
    const code = payload.error ?? "request_failed";
    throw new ApiError(apiErrorMessage(code), response.status, code, payload.fields);
  }
  return payload;
}

export async function loadSession(): Promise<AppSession> {
  const payload = await apiJson<{ user: AppSession }>("/api/session");
  return payload.user;
}

export async function loadSongEditorOptions(): Promise<SongEditorOptions> {
  return apiJson<SongEditorOptions>("/api/song-editor/options");
}

export async function loadLookups(): Promise<LookupCollections> {
  return apiJson<LookupCollections>("/api/lookups");
}

export async function createLookup(kind: LookupKind, name: string): Promise<LookupItem> {
  const response = await apiJson<{ item: LookupItem }>(`/api/lookups/${encodeURIComponent(kind)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return response.item;
}

export async function updateLookup(
  kind: LookupKind,
  id: string,
  name: string,
  currentName: string,
): Promise<LookupItem> {
  const response = await apiJson<{ item: LookupItem }>(
    `/api/lookups/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, currentName }),
    },
  );
  return response.item;
}

export async function createSong(payload: SongWritePayload): Promise<{ id: string; revision: number }> {
  const response = await apiJson<{ song: { id: string; revision: number } }>("/api/songs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.song;
}

export async function updateSong(
  songId: string,
  payload: SongWritePayload & { revision: number },
): Promise<{ id: string; revision: number }> {
  const response = await apiJson<{ song: { id: string; revision: number } }>(
    `/api/songs/${encodeURIComponent(songId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  return response.song;
}

export async function trashSong(songId: string, revision: number): Promise<{ id: string; revision: number }> {
  const response = await apiJson<{ song: { id: string; revision: number } }>(
    `/api/songs/${encodeURIComponent(songId)}/trash`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision }),
    },
  );
  return response.song;
}

export async function restoreSong(songId: string, revision: number): Promise<{ id: string; revision: number }> {
  const response = await apiJson<{ song: { id: string; revision: number } }>(
    `/api/trash/songs/${encodeURIComponent(songId)}/restore`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision }),
    },
  );
  return response.song;
}

export async function createLyric(
  songId: string,
  content: string,
): Promise<{ id: string; revision: number }> {
  const response = await apiJson<{ lyric: { id: string; revision: number } }>(
    `/api/songs/${encodeURIComponent(songId)}/lyrics`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
  return response.lyric;
}

export async function updateLyric(
  songId: string,
  lyricId: string,
  content: string,
  revision: number,
): Promise<{ id: string; revision: number }> {
  const response = await apiJson<{ lyric: { id: string; revision: number } }>(
    `/api/songs/${encodeURIComponent(songId)}/lyrics/${encodeURIComponent(lyricId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, revision }),
    },
  );
  return response.lyric;
}

export async function trashLyric(
  songId: string,
  lyricId: string,
  revision: number,
): Promise<{ id: string; revision: number }> {
  const response = await apiJson<{ lyric: { id: string; revision: number } }>(
    `/api/songs/${encodeURIComponent(songId)}/lyrics/${encodeURIComponent(lyricId)}/trash`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision }),
    },
  );
  return response.lyric;
}

export async function loadTrash(): Promise<{
  songs: TrashedSong[];
  lyrics: TrashedLyric[];
  scans: TrashedScan[];
  recordings: TrashedRecording[];
}> {
  return apiJson<{
    songs: TrashedSong[];
    lyrics: TrashedLyric[];
    scans: TrashedScan[];
    recordings: TrashedRecording[];
  }>("/api/trash");
}

export async function restoreLyric(
  lyricId: string,
  revision: number,
): Promise<{ id: string; songId: string; revision: number }> {
  const response = await apiJson<{
    lyric: { id: string; songId: string; revision: number };
  }>(`/api/trash/lyrics/${encodeURIComponent(lyricId)}/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision }),
  });
  return response.lyric;
}

export async function loadScanEditorOptions(): Promise<ScanEditorOptions> {
  return apiJson<ScanEditorOptions>("/api/scan-editor/options");
}

export async function updateScan(
  songId: string,
  scanId: string,
  payload: { notebookId: string | null; pageLabel: string | null; revision: number },
): Promise<{ id: string; revision: number }> {
  const response = await apiJson<{ scan: { id: string; revision: number } }>(
    `/api/songs/${encodeURIComponent(songId)}/scans/${encodeURIComponent(scanId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  return response.scan;
}

export async function trashScan(
  songId: string,
  scanId: string,
  revision: number,
): Promise<{ id: string; revision: number }> {
  const response = await apiJson<{ scan: { id: string; revision: number } }>(
    `/api/songs/${encodeURIComponent(songId)}/scans/${encodeURIComponent(scanId)}/trash`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision }),
    },
  );
  return response.scan;
}

export async function restoreScan(
  scanId: string,
  revision: number,
): Promise<{ id: string; songId: string; revision: number }> {
  const response = await apiJson<{
    scan: { id: string; songId: string; revision: number };
  }>(`/api/trash/scans/${encodeURIComponent(scanId)}/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision }),
  });
  return response.scan;
}

export async function loadRecordingEditorOptions(): Promise<RecordingEditorOptions> {
  return apiJson<RecordingEditorOptions>("/api/recording-editor/options");
}

export async function updateRecording(
  songId: string,
  recordingId: string,
  payload: {
    description: string;
    recordedOn: string | null;
    creditPersonIds: string[];
    revision: number;
  },
): Promise<{ id: string; revision: number }> {
  const response = await apiJson<{ recording: { id: string; revision: number } }>(
    `/api/songs/${encodeURIComponent(songId)}/recordings/${encodeURIComponent(recordingId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  return response.recording;
}

export async function trashRecording(
  songId: string,
  recordingId: string,
  revision: number,
): Promise<{ id: string; revision: number }> {
  const response = await apiJson<{ recording: { id: string; revision: number } }>(
    `/api/songs/${encodeURIComponent(songId)}/recordings/${encodeURIComponent(recordingId)}/trash`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision }),
    },
  );
  return response.recording;
}

export async function restoreRecording(
  recordingId: string,
  revision: number,
): Promise<{ id: string; songId: string; revision: number }> {
  const response = await apiJson<{
    recording: { id: string; songId: string; revision: number };
  }>(`/api/trash/recordings/${encodeURIComponent(recordingId)}/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision }),
  });
  return response.recording;
}
