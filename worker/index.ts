import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { verifyWithJwks } from "hono/jwt";
import { loadOfflineLibrary } from "./offline-library";
import {
  parseLyricCreate,
  parseLyricRevision,
  parseLyricUpdate,
  type LyricUpdateInput,
} from "./lyric-writes";
import {
  parseScanRevision,
  parseScanUpdate,
  type ScanUpdateInput,
} from "./scan-writes";
import {
  parseSongCreate,
  parseSongUpdate,
  type SongWriteInput,
  type SongUpdateInput,
} from "./song-writes";

export type AppRole = "viewer" | "editor" | "admin";
export type AppUser = {
  identity: string;
  displayName: string | null;
  role: AppRole;
};

type Bindings = {
  DB: D1Database;
  MEDIA: R2Bucket;
  AUTH_MODE: "access" | "local";
  ACCESS_AUD: string;
  ACCESS_ISSUER: string;
  ACCESS_JWKS_URL: string;
  LOCAL_ROLE?: AppRole;
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

type ScanStateRow = {
  revision: number;
  trashedAt: string | null;
  songTrashedAt: string | null;
  mediaState: "active" | "trashed";
};

type LookupTable = "languages" | "tags" | "notebooks";

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

function scanWriteError(error: unknown): { error: string; status: 400 | 500 } {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("FOREIGN KEY") || message.includes("CHECK constraint")) {
    return { error: "invalid_scan_reference", status: 400 };
  }
  return { error: "scan_write_failed", status: 500 };
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

async function loadScanState(
  database: D1Database,
  songId: string,
  scanId: string,
): Promise<ScanStateRow | null> {
  return database.prepare(`
    SELECT
      scans.revision,
      scans.trashed_at AS trashedAt,
      songs.trashed_at AS songTrashedAt,
      media_objects.state AS mediaState
    FROM scans
    JOIN songs ON songs.id = scans.song_id
    JOIN media_objects ON media_objects.id = scans.media_id
    WHERE scans.id = ? AND scans.song_id = ?
  `).bind(scanId, songId).first<ScanStateRow>();
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

app.get("/api/health", (context) => {
  return context.json({
    service: "music-library",
    status: "ok",
  });
});

app.get("/api/session", (context) => {
  const user = context.get("appUser");
  return context.json({
    user: {
      displayName: user.displayName,
      role: user.role,
    },
  });
});

app.get("/api/song-editor/options", requireRole("editor"), async (context) => {
  const [languages, tags] = await Promise.all([
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
  ]);
  return context.json({
    languages: languages.results,
    tags: tags.results,
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
  const [languagesExist, tagsExist] = await Promise.all([
    lookupIdsExist(context.env.DB, "languages", song.languageIds),
    lookupIdsExist(context.env.DB, "tags", song.tagIds),
  ]);
  if (!languagesExist || !tagsExist) {
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
  const [languagesExist, tagsExist] = await Promise.all([
    lookupIdsExist(context.env.DB, "languages", song.languageIds),
    lookupIdsExist(context.env.DB, "tags", song.tagIds),
  ]);
  if (!languagesExist || !tagsExist) {
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
  const lyricId = crypto.randomUUID();
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
      `).bind(
        lyricId, parsed.data.content,
        timestamp, actor, timestamp, actor,
        songId,
      ),
      context.env.DB.prepare(`
        UPDATE songs
        SET updated_at = ?, updated_by = ?
        WHERE id = ? AND trashed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM lyric_texts
            WHERE id = ? AND song_id = songs.id
          )
      `).bind(timestamp, actor, songId, lyricId),
    ]);
    if (results[0].meta.changes === 0) {
      return context.json({ error: "song_not_found" }, 404);
    }
    return context.json({ lyric: { id: lyricId, revision: 1 } }, 201);
  } catch (error) {
    const response = lyricWriteError(error);
    return context.json({ error: response.error }, response.status);
  }
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

app.get("/api/trash", requireRole("editor"), async (context) => {
  const [lyrics, scans] = await Promise.all([
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
        media_objects.original_filename AS filename,
        notebooks.display_name AS notebookName,
        scans.page_label AS pageLabel,
        scans.revision,
        scans.trashed_at AS trashedAt,
        CASE WHEN songs.trashed_at IS NULL THEN 0 ELSE 1 END AS songIsTrashed
      FROM scans
      JOIN songs ON songs.id = scans.song_id
      JOIN media_objects ON media_objects.id = scans.media_id
      LEFT JOIN notebooks ON notebooks.id = scans.notebook_id
      WHERE scans.trashed_at IS NOT NULL
      ORDER BY scans.trashed_at DESC, scans.id
    `).all<{
      id: string;
      songId: string;
      songTitle: string;
      filename: string;
      notebookName: string | null;
      pageLabel: string | null;
      revision: number;
      trashedAt: string;
      songIsTrashed: number;
    }>(),
  ]);
  return context.json({
    lyrics: lyrics.results.map((lyric) => ({
      ...lyric,
      songIsTrashed: lyric.songIsTrashed === 1,
    })),
    scans: scans.results.map((scan) => ({
      ...scan,
      songIsTrashed: scan.songIsTrashed === 1,
    })),
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
        media_objects.original_filename AS filename
      FROM scans
      JOIN media_objects ON media_objects.id = scans.media_id
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
      filename: string;
    }>(),
    context.env.DB.prepare(`
      SELECT
        recordings.id,
        recordings.original_media_id AS originalMediaId,
        recordings.playback_media_id AS playbackMediaId,
        recordings.description,
        recordings.recorded_on AS recordedOn,
        recordings.processing_state AS processingState,
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
      description: string;
      recordedOn: string | null;
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
