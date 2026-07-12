type SongRow = {
  id: string;
  titleLatin: string;
  titleNative: string | null;
  status: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

type SongChild = { songId: string };
type RecordingCredit = {
  recordingId: string;
  personId: string;
  fullName: string;
  role: string;
  notes: string | null;
};

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const row of rows) {
    const value = key(row);
    const group = groups.get(value) ?? [];
    group.push(row);
    groups.set(value, group);
  }
  return groups;
}

function withoutSongId<T extends SongChild>(row: T): Omit<T, "songId"> {
  const { songId: _songId, ...value } = row;
  return value;
}

export async function loadOfflineLibrary(database: D1Database) {
  const [songs, aliases, languages, tags, credits, lyricTexts, scans, recordings, recordingCredits] = await Promise.all([
    database.prepare(`
      SELECT
        id,
        title_latin AS titleLatin,
        title_native AS titleNative,
        status,
        notes,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM songs
      WHERE trashed_at IS NULL
      ORDER BY title_latin COLLATE NOCASE, id
    `).all<SongRow>(),
    database.prepare(`
      SELECT song_id AS songId, alias
      FROM song_aliases
      ORDER BY song_id, sort_order, alias
    `).all<SongChild & { alias: string }>(),
    database.prepare(`
      SELECT song_languages.song_id AS songId, languages.id, languages.display_name AS displayName
      FROM song_languages
      JOIN languages ON languages.id = song_languages.language_id
      ORDER BY song_languages.song_id, song_languages.sort_order, languages.display_name
    `).all<SongChild & { id: string; displayName: string }>(),
    database.prepare(`
      SELECT song_tags.song_id AS songId, tags.id, tags.display_name AS displayName
      FROM song_tags
      JOIN tags ON tags.id = song_tags.tag_id
      ORDER BY song_tags.song_id, song_tags.sort_order, tags.display_name
    `).all<SongChild & { id: string; displayName: string }>(),
    database.prepare(`
      SELECT
        song_credits.song_id AS songId,
        people.id AS personId,
        people.full_name AS fullName,
        song_credits.role,
        song_credits.notes
      FROM song_credits
      JOIN people ON people.id = song_credits.person_id
      ORDER BY song_credits.song_id, song_credits.sort_order, people.full_name
    `).all<SongChild & { personId: string; fullName: string; role: string; notes: string | null }>(),
    database.prepare(`
      SELECT
        lyric_texts.song_id AS songId,
        lyric_texts.id,
        lyric_texts.language_id AS languageId,
        languages.display_name AS languageName,
        lyric_texts.script_code AS scriptCode,
        lyric_texts.representation,
        lyric_texts.label,
        lyric_texts.content
      FROM lyric_texts
      LEFT JOIN languages ON languages.id = lyric_texts.language_id
      WHERE lyric_texts.trashed_at IS NULL
      ORDER BY lyric_texts.song_id, lyric_texts.sort_order, lyric_texts.id
    `).all<SongChild & {
      id: string;
      languageId: string | null;
      languageName: string | null;
      scriptCode: string | null;
      representation: string;
      label: string | null;
      content: string;
    }>(),
    database.prepare(`
      SELECT
        scans.song_id AS songId,
        scans.id,
        media_objects.id AS mediaId,
        scans.version,
        scans.captured_on AS capturedOn,
        scans.source,
        notebooks.display_name AS notebookName,
        scans.page_label AS pageLabel,
        scans.scan_text AS scanText,
        scans.notes,
        media_objects.original_filename AS filename
      FROM scans
      JOIN media_objects ON media_objects.id = scans.media_id
      LEFT JOIN notebooks ON notebooks.id = scans.notebook_id
      WHERE scans.trashed_at IS NULL
      ORDER BY scans.song_id, scans.captured_on, scans.id
    `).all<SongChild & {
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
    }>(),
    database.prepare(`
      SELECT
        recordings.song_id AS songId,
        recordings.id,
        recordings.original_media_id AS originalMediaId,
        recordings.playback_media_id AS playbackMediaId,
        recordings.version,
        recordings.recorded_on AS recordedOn,
        recordings.notes,
        media_objects.original_filename AS filename,
        CASE WHEN recordings.playback_media_id IS NULL THEN 0 ELSE 1 END AS hasPlaybackMedia
      FROM recordings
      JOIN media_objects ON media_objects.id = recordings.original_media_id
      WHERE recordings.trashed_at IS NULL
      ORDER BY recordings.song_id, recordings.recorded_on, recordings.id
    `).all<SongChild & {
      id: string;
      originalMediaId: string;
      playbackMediaId: string | null;
      version: string | null;
      recordedOn: string | null;
      notes: string | null;
      filename: string;
      hasPlaybackMedia: number;
    }>(),
    database.prepare(`
      SELECT
        recording_credits.recording_id AS recordingId,
        people.id AS personId,
        people.full_name AS fullName,
        recording_credits.role,
        recording_credits.notes
      FROM recording_credits
      JOIN recordings ON recordings.id = recording_credits.recording_id
      JOIN people ON people.id = recording_credits.person_id
      WHERE recordings.trashed_at IS NULL
      ORDER BY recording_credits.recording_id, recording_credits.sort_order, people.full_name
    `).all<RecordingCredit>(),
  ]);

  const aliasesBySong = groupBy(aliases.results, (row) => row.songId);
  const languagesBySong = groupBy(languages.results, (row) => row.songId);
  const tagsBySong = groupBy(tags.results, (row) => row.songId);
  const creditsBySong = groupBy(credits.results, (row) => row.songId);
  const lyricsBySong = groupBy(lyricTexts.results, (row) => row.songId);
  const scansBySong = groupBy(scans.results, (row) => row.songId);
  const recordingsBySong = groupBy(recordings.results, (row) => row.songId);
  const creditsByRecording = groupBy(recordingCredits.results, (row) => row.recordingId);

  return songs.results.map((song) => ({
    ...song,
    aliases: (aliasesBySong.get(song.id) ?? []).map((row) => row.alias),
    languages: (languagesBySong.get(song.id) ?? []).map(withoutSongId),
    tags: (tagsBySong.get(song.id) ?? []).map(withoutSongId),
    credits: (creditsBySong.get(song.id) ?? []).map(withoutSongId),
    lyricTexts: (lyricsBySong.get(song.id) ?? []).map(withoutSongId),
    scans: (scansBySong.get(song.id) ?? []).map(withoutSongId),
    recordings: (recordingsBySong.get(song.id) ?? []).map((row) => ({
      ...withoutSongId(row),
      hasPlaybackMedia: row.hasPlaybackMedia === 1,
      credits: (creditsByRecording.get(row.id) ?? []).map(({ recordingId: _recordingId, ...credit }) => credit),
    })),
  }));
}
