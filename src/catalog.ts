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
  notes: string | null;
};

export type SongDetail = {
  id: string;
  titleLatin: string;
  titleNative: string | null;
  status: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  aliases: string[];
  languages: Array<{ id: string; displayName: string }>;
  tags: Array<{ id: string; displayName: string }>;
  credits: Credit[];
  lyricTexts: Array<{
    id: string;
    languageId: string | null;
    languageName: string | null;
    scriptCode: string | null;
    representation: string;
    label: string | null;
    content: string;
  }>;
  scans: Array<{
    id: string;
    mediaId: string;
    version: string | null;
    capturedOn: string | null;
    source: string;
    notebookName: string | null;
    pageLabel: string | null;
    scanText: string | null;
    notes: string | null;
    filename: string;
  }>;
  recordings: Array<{
    id: string;
    originalMediaId: string;
    playbackMediaId: string | null;
    version: string | null;
    recordedOn: string | null;
    notes: string | null;
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
