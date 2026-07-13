import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeedSql } from "./load-local-db";

const initialMigration = readFileSync(resolve("migrations/0001_initial.sql"), "utf8");
const editingMigration = readFileSync(resolve("migrations/0002_editing_foundation.sql"), "utf8");
const songWritesMigration = readFileSync(resolve("migrations/0003_song_writes.sql"), "utf8");
const migration = `${initialMigration}\n${editingMigration}\n${songWritesMigration}`;
const timestamp = "2026-07-12T00:00:00.000Z";

function runSql(sql: string): string {
  return execFileSync("sqlite3", [":memory:"], {
    encoding: "utf8",
    input: `${migration}\n${sql}`,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function migrateLegacy(beforeMigration: string, afterMigration: string): string {
  return execFileSync("sqlite3", [":memory:"], {
    encoding: "utf8",
    input: `${initialMigration}\n${beforeMigration}\n${editingMigration}\n${songWritesMigration}\n${afterMigration}`,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("initial database schema", () => {
  it("loads successfully", () => {
    expect(() => runSql("PRAGMA foreign_key_check;")).not.toThrow();
  });

  it("losslessly transforms legacy lyrics, Recording metadata, and credit roles", () => {
    const output = migrateLegacy(`
      INSERT INTO songs (
        id, title_latin, status, created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO people (
        id, full_name, normalized_name, created_at, updated_at
      ) VALUES ('person-1', 'Writer', 'writer', '${timestamp}', '${timestamp}');
      INSERT INTO song_credits (id, song_id, person_id, role)
      VALUES ('credit-1', 'song-1', 'person-1', 'Writer');
      INSERT INTO lyric_texts (
        id, song_id, representation, content, created_at, created_by, updated_at, updated_by
      ) VALUES ('lyrics-1', 'song-1', 'legacy_combined', 'lyrics', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO media_objects (
        id, object_key, original_filename, byte_size, kind, created_at, created_by
      ) VALUES ('media-1', 'recordings/test.mp3', 'test.mp3', 1, 'original_audio', '${timestamp}', 'test');
      INSERT INTO recordings (
        id, song_id, original_media_id, version, notes,
        created_at, created_by, updated_at, updated_by
      ) VALUES (
        'recording-1', 'song-1', 'media-1', 'Old verse', 'Different tune',
        '${timestamp}', 'test', '${timestamp}', 'test'
      );
    `, `
      SELECT origin FROM lyric_texts;
      SELECT role FROM song_credits;
      SELECT description FROM recordings;
      SELECT legacy_version || '|' || legacy_notes FROM recordings;
    `);

    expect(output).toBe("legacy_import\nlyrics\nOld verse\n\nDifferent tune\nOld verse|Different tune\n");
  });

  it("rejects orphan lyric texts", () => {
    expect(() => runSql(`
      INSERT INTO lyric_texts (
        id, song_id, content,
        created_at, created_by, updated_at, updated_by
      ) VALUES (
        'lyrics-1', 'missing-song', 'text',
        '${timestamp}', 'test', '${timestamp}', 'test'
      );
    `)).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("refuses to delete a song with content", () => {
    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO lyric_texts (
        id, song_id, content,
        created_at, created_by, updated_at, updated_by
      ) VALUES (
        'lyrics-1', 'song-1', 'text',
        '${timestamp}', 'test', '${timestamp}', 'test'
      );
      DELETE FROM songs WHERE id = 'song-1';
    `)).toThrow(/song_has_content/);
  });

  it("allows an empty song to be removed by later admin cleanup", () => {
    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      DELETE FROM songs WHERE id = 'song-1';
      SELECT CASE WHEN COUNT(*) = 0 THEN 'ok' ELSE 'failed' END FROM songs;
    `)).not.toThrow();
  });

  it("escapes private text safely in generated seed SQL", () => {
    const sql = createSeedSql({
      schemaVersion: 2,
      languages: [], tags: [], notebooks: [], people: [],
      songs: [{
        id: "song-1", titleLatin: "Singer's song", normalizedTitleLatin: "singer's song",
        titleNative: null, status: "draft",
        notes: "line one\nline two", revision: 1,
        createdAt: timestamp, createdBy: "test", updatedAt: timestamp, updatedBy: "test",
        trashedAt: null, trashedBy: null,
      }],
      songAliases: [], songLanguages: [], songTags: [], songCredits: [], lyricTexts: [],
      mediaObjects: [], scans: [], recordings: [], recordingCredits: [],
    });

    expect(() => execFileSync("sqlite3", [":memory:"], {
      encoding: "utf8",
      input: `${migration}\n${sql}`,
      stdio: ["pipe", "pipe", "pipe"],
    })).not.toThrow();
    expect(sql).toContain("Singer''s song");
  });

  it("enforces Song status and normalized active-title uniqueness", () => {
    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'unknown', '${timestamp}', 'test', '${timestamp}', 'test');
    `)).toThrow(/invalid_song_values/);

    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'same', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-2', 'Same', 'same', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
    `)).toThrow(/UNIQUE constraint failed/);
  });

  it("prevents removing the last Language from an active Song", () => {
    expect(() => runSql(`
      INSERT INTO languages (id, display_name, normalized_name) VALUES ('en', 'English', 'english');
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO song_languages (song_id, language_id) VALUES ('song-1', 'en');
      DELETE FROM song_languages WHERE song_id = 'song-1' AND language_id = 'en';
    `)).toThrow(/song_requires_language/);
  });

  it("allows one Person to hold both Song roles but rejects a duplicate role", () => {
    const output = runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO people (
        id, full_name, normalized_name, created_at, updated_at
      ) VALUES ('person-1', 'Contributor', 'contributor', '${timestamp}', '${timestamp}');
      INSERT INTO song_credits (id, song_id, person_id, role, sort_order) VALUES
        ('credit-1', 'song-1', 'person-1', 'lyrics', 0),
        ('credit-2', 'song-1', 'person-1', 'music', 1);
      SELECT group_concat(role, '|') FROM (
        SELECT role FROM song_credits ORDER BY sort_order
      );
    `);
    expect(output).toBe("lyrics|music\n");

    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO people (
        id, full_name, normalized_name, created_at, updated_at
      ) VALUES ('person-1', 'Contributor', 'contributor', '${timestamp}', '${timestamp}');
      INSERT INTO song_credits (id, song_id, person_id, role)
      VALUES ('credit-1', 'song-1', 'person-1', 'lyrics');
      INSERT INTO song_credits (id, song_id, person_id, role)
      VALUES ('credit-2', 'song-1', 'person-1', 'lyrics');
    `)).toThrow(/UNIQUE constraint failed/);
  });

  it("blocks trashing a Song while active child content exists", () => {
    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO lyric_texts (
        id, song_id, content, created_at, created_by, updated_at, updated_by
      ) VALUES ('lyrics-1', 'song-1', 'text', '${timestamp}', 'test', '${timestamp}', 'test');
      UPDATE songs SET trashed_at = '${timestamp}', trashed_by = 'test' WHERE id = 'song-1';
    `)).toThrow(/song_has_active_content/);
  });

  it("can trash and restore a Song without changing metadata, relationships, or child Trash state", () => {
    const output = runSql(`
      INSERT INTO languages (id, display_name, normalized_name)
      VALUES ('en', 'English', 'english');
      INSERT INTO tags (id, display_name, normalized_name)
      VALUES ('tag-1', 'Test tag', 'test tag');
      INSERT INTO people (id, full_name, normalized_name, created_at, updated_at)
      VALUES ('person-1', 'Contributor', 'contributor', '${timestamp}', '${timestamp}');
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, title_native, status, notes,
        created_at, created_by, updated_at, updated_by
      ) VALUES (
        'song-1', 'Test Song', 'test song', 'Native', 'checked', 'Song note',
        '${timestamp}', 'test', '${timestamp}', 'test'
      );
      INSERT INTO song_languages (song_id, language_id) VALUES ('song-1', 'en');
      INSERT INTO song_tags (song_id, tag_id) VALUES ('song-1', 'tag-1');
      INSERT INTO song_aliases (id, song_id, alias, normalized_alias)
      VALUES ('alias-1', 'song-1', 'Old title', 'old title');
      INSERT INTO song_credits (id, song_id, person_id, role)
      VALUES ('credit-1', 'song-1', 'person-1', 'lyrics');
      INSERT INTO lyric_texts (
        id, song_id, content, created_at, created_by, updated_at, updated_by
      ) VALUES ('lyrics-1', 'song-1', 'text', '${timestamp}', 'test', '${timestamp}', 'test');
      UPDATE lyric_texts
      SET trashed_at = '${timestamp}', trashed_by = 'test', revision = revision + 1
      WHERE id = 'lyrics-1';
      UPDATE songs
      SET trashed_at = '${timestamp}', trashed_by = 'test', revision = revision + 1
      WHERE id = 'song-1';
      UPDATE songs
      SET trashed_at = NULL, trashed_by = NULL, revision = revision + 1
      WHERE id = 'song-1';
      SELECT
        songs.title_latin || '|' || songs.title_native || '|' || songs.status || '|' ||
        songs.notes || '|' || songs.revision || '|' ||
        (SELECT COUNT(*) FROM song_languages WHERE song_id = songs.id) || '|' ||
        (SELECT COUNT(*) FROM song_tags WHERE song_id = songs.id) || '|' ||
        (SELECT COUNT(*) FROM song_aliases WHERE song_id = songs.id) || '|' ||
        (SELECT COUNT(*) FROM song_credits WHERE song_id = songs.id) || '|' ||
        (SELECT CASE WHEN trashed_at IS NULL THEN 0 ELSE 1 END FROM lyric_texts WHERE song_id = songs.id)
      FROM songs WHERE id = 'song-1';
    `);

    expect(output).toBe("Test Song|Native|checked|Song note|3|1|1|1|1|1\n");
  });

  it("can trash and restore typed lyrics without changing their content", () => {
    const output = runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO lyric_texts (
        id, song_id, content, created_at, created_by, updated_at, updated_by
      ) VALUES ('lyrics-1', 'song-1', 'line one' || char(10) || char(10) || 'line two', '${timestamp}', 'test', '${timestamp}', 'test');
      UPDATE lyric_texts
      SET trashed_at = '${timestamp}', trashed_by = 'test', revision = revision + 1
      WHERE id = 'lyrics-1';
      UPDATE lyric_texts
      SET trashed_at = NULL, trashed_by = NULL, revision = revision + 1
      WHERE id = 'lyrics-1';
      SELECT content || '|' || revision FROM lyric_texts WHERE id = 'lyrics-1';
    `);

    expect(output).toBe("line one\n\nline two|3\n");
  });

  it("can trash and restore a Scan and its media without changing either record", () => {
    const output = runSql(`
      INSERT INTO notebooks (id, display_name, normalized_name, sort_order)
      VALUES ('notebook-1', 'Blue notebook', 'blue notebook', 1);
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO media_objects (
        id, object_key, original_filename, mime_type, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES (
        'media-1', 'scans/test.jpg', 'page.jpg', 'image/jpeg', 1234, 'hash-1', 'scan',
        '${timestamp}', 'test'
      );
      INSERT INTO scans (
        id, song_id, media_id, notebook_id, page_label,
        created_at, created_by, updated_at, updated_by
      ) VALUES (
        'scan-1', 'song-1', 'media-1', 'notebook-1', 'Page 12',
        '${timestamp}', 'test', '${timestamp}', 'test'
      );
      UPDATE scans
      SET trashed_at = '${timestamp}', trashed_by = 'test', revision = revision + 1
      WHERE id = 'scan-1';
      UPDATE media_objects
      SET state = 'trashed', trashed_at = '${timestamp}', trashed_by = 'test'
      WHERE id = 'media-1';
      UPDATE scans
      SET trashed_at = NULL, trashed_by = NULL, revision = revision + 1
      WHERE id = 'scan-1';
      UPDATE media_objects
      SET state = 'active', trashed_at = NULL, trashed_by = NULL
      WHERE id = 'media-1';
      SELECT
        scans.notebook_id || '|' || scans.page_label || '|' || scans.revision || '|' ||
        media_objects.object_key || '|' || media_objects.original_filename || '|' ||
        media_objects.byte_size || '|' || media_objects.sha256 || '|' || media_objects.state
      FROM scans
      JOIN media_objects ON media_objects.id = scans.media_id
      WHERE scans.id = 'scan-1';
    `);

    expect(output).toBe("notebook-1|Page 12|3|scans/test.jpg|page.jpg|1234|hash-1|active\n");
  });

  it("can trash and restore a Recording, its credits, and both private media records", () => {
    const output = runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO people (
        id, full_name, normalized_name, created_at, updated_at
      ) VALUES ('person-1', 'Singer', 'singer', '${timestamp}', '${timestamp}');
      INSERT INTO media_objects (
        id, object_key, original_filename, mime_type, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES
        ('original-1', 'recordings/original.wav', 'original.wav', 'audio/wav', 4321, 'original-hash', 'original_audio', '${timestamp}', 'test'),
        ('playback-1', 'recordings/playback.mp3', 'playback.mp3', 'audio/mpeg', 1234, 'playback-hash', 'playback_audio', '${timestamp}', 'test');
      INSERT INTO recordings (
        id, song_id, original_media_id, playback_media_id,
        description, normalized_description, recorded_on,
        created_at, created_by, updated_at, updated_by
      ) VALUES (
        'recording-1', 'song-1', 'original-1', 'playback-1',
        'Old verse', 'old verse', '2020-02-29',
        '${timestamp}', 'test', '${timestamp}', 'test'
      );
      INSERT INTO recording_credits (id, recording_id, person_id, role, sort_order)
      VALUES ('credit-1', 'recording-1', 'person-1', 'vocals', 0);
      UPDATE recordings
      SET trashed_at = '${timestamp}', trashed_by = 'test', revision = revision + 1
      WHERE id = 'recording-1';
      UPDATE media_objects
      SET state = 'trashed', trashed_at = '${timestamp}', trashed_by = 'test'
      WHERE id IN ('original-1', 'playback-1');
      UPDATE recordings
      SET trashed_at = NULL, trashed_by = NULL, revision = revision + 1
      WHERE id = 'recording-1';
      UPDATE media_objects
      SET state = 'active', trashed_at = NULL, trashed_by = NULL
      WHERE id IN ('original-1', 'playback-1');
      SELECT
        recordings.description || '|' || recordings.recorded_on || '|' || recordings.revision || '|' ||
        original_media.object_key || '|' || original_media.state || '|' ||
        playback_media.object_key || '|' || playback_media.state || '|' ||
        recording_credits.role || '|' || people.full_name
      FROM recordings
      JOIN media_objects AS original_media ON original_media.id = recordings.original_media_id
      JOIN media_objects AS playback_media ON playback_media.id = recordings.playback_media_id
      JOIN recording_credits ON recording_credits.recording_id = recordings.id
      JOIN people ON people.id = recording_credits.person_id
      WHERE recordings.id = 'recording-1';
    `);

    expect(output).toBe("Old verse|2020-02-29|3|recordings/original.wav|active|recordings/playback.mp3|active|vocals|Singer\n");
  });

  it("rejects restoring typed lyrics when identical active content now exists", () => {
    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, normalized_title_latin, status,
        created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', 'test', 'draft', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO lyric_texts (
        id, song_id, content, created_at, created_by, updated_at, updated_by
      ) VALUES ('lyrics-1', 'song-1', 'same text', '${timestamp}', 'test', '${timestamp}', 'test');
      UPDATE lyric_texts
      SET trashed_at = '${timestamp}', trashed_by = 'test'
      WHERE id = 'lyrics-1';
      INSERT INTO lyric_texts (
        id, song_id, content, created_at, created_by, updated_at, updated_by
      ) VALUES ('lyrics-2', 'song-1', 'same text', '${timestamp}', 'test', '${timestamp}', 'test');
      UPDATE lyric_texts
      SET trashed_at = NULL, trashed_by = NULL
      WHERE id = 'lyrics-1';
    `)).toThrow(/UNIQUE constraint failed/);
  });
});
