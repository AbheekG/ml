import { Hono } from "hono";
import { verifyWithJwks } from "hono/jwt";

type Bindings = {
  DB: D1Database;
  MEDIA: R2Bucket;
  AUTH_MODE: "access" | "local";
  ACCESS_AUD: string;
  ACCESS_ISSUER: string;
  ACCESS_JWKS_URL: string;
};

type Variables = {
  accessIdentity: {
    email: string;
    subject: string;
  };
};

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
  createdAt: string;
  updatedAt: string;
};

type RecordingCreditRow = {
  recordingId: string;
  personId: string;
  fullName: string;
  role: string;
  notes: string | null;
};

type MediaRow = {
  id: string;
  objectKey: string;
  filename: string;
  mimeType: string | null;
};

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

export const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use("/api/*", async (context, next) => {
  if (context.env.AUTH_MODE === "local") {
    context.set("accessIdentity", { email: "local@example.invalid", subject: "local-development" });
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

  try {
    const payload = await verifyWithJwks(token, {
      jwks_uri: context.env.ACCESS_JWKS_URL,
      allowedAlgorithms: ["RS256"],
      verification: {
        aud: context.env.ACCESS_AUD,
        iss: context.env.ACCESS_ISSUER,
      },
    });

    if (typeof payload.email !== "string" || typeof payload.sub !== "string") {
      return context.json({ error: "invalid_identity" }, 401);
    }

    context.set("accessIdentity", { email: payload.email, subject: payload.sub });
  } catch {
    return context.json({ error: "invalid_access_token" }, 401);
  }

  await next();
});

app.get("/api/health", (context) => {
  return context.json({
    service: "music-library",
    status: "ok",
  });
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

app.get("/api/songs/:songId", async (context) => {
  const songId = context.req.param("songId");
  const song = await context.env.DB.prepare(`
    SELECT
      id,
      title_latin AS titleLatin,
      title_native AS titleNative,
      status,
      notes,
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
        song_credits.role,
        song_credits.notes
      FROM song_credits
      JOIN people ON people.id = song_credits.person_id
      WHERE song_credits.song_id = ?
      ORDER BY song_credits.sort_order, people.full_name
    `).bind(songId).all<{ personId: string; fullName: string; role: string; notes: string | null }>(),
    context.env.DB.prepare(`
      SELECT
        lyric_texts.id,
        lyric_texts.language_id AS languageId,
        languages.display_name AS languageName,
        lyric_texts.script_code AS scriptCode,
        lyric_texts.representation,
        lyric_texts.label,
        lyric_texts.content
      FROM lyric_texts
      LEFT JOIN languages ON languages.id = lyric_texts.language_id
      WHERE lyric_texts.song_id = ? AND lyric_texts.trashed_at IS NULL
      ORDER BY lyric_texts.sort_order, lyric_texts.id
    `).bind(songId).all<{
      id: string;
      languageId: string | null;
      languageName: string | null;
      scriptCode: string | null;
      representation: string;
      label: string | null;
      content: string;
    }>(),
    context.env.DB.prepare(`
      SELECT
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
      WHERE scans.song_id = ? AND scans.trashed_at IS NULL
      ORDER BY scans.captured_on, scans.id
    `).bind(songId).all<{
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
    context.env.DB.prepare(`
      SELECT
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
      WHERE recordings.song_id = ? AND recordings.trashed_at IS NULL
      ORDER BY recordings.recorded_on, recordings.id
    `).bind(songId).all<{
      id: string;
      originalMediaId: string;
      playbackMediaId: string | null;
      version: string | null;
      recordedOn: string | null;
      notes: string | null;
      filename: string;
      hasPlaybackMedia: number;
    }>(),
    context.env.DB.prepare(`
      SELECT
        recording_credits.recording_id AS recordingId,
        people.id AS personId,
        people.full_name AS fullName,
        recording_credits.role,
        recording_credits.notes
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
      scans: scans.results,
      recordings: recordings.results.map((recording) => ({
        ...recording,
        hasPlaybackMedia: recording.hasPlaybackMedia === 1,
        credits: creditsByRecording.get(recording.id) ?? [],
      })),
    },
  });
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
          WHERE scans.media_id = media_objects.id AND scans.trashed_at IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM recordings
          WHERE (
            recordings.original_media_id = media_objects.id
            OR recordings.playback_media_id = media_objects.id
          ) AND recordings.trashed_at IS NULL
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
  headers.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(media.filename)}`);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, max-age=3600");
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

app.notFound((context) => {
  return context.json(
    {
      error: "not_found",
    },
    404,
  );
});

export default app;
