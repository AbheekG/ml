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
});
