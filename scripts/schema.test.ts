import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeedSql } from "./load-local-db";

const migration = readFileSync(resolve("migrations/0001_initial.sql"), "utf8");
const timestamp = "2026-07-12T00:00:00.000Z";

function runSql(sql: string): string {
  return execFileSync("sqlite3", [":memory:"], {
    encoding: "utf8",
    input: `${migration}\n${sql}`,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("initial database schema", () => {
  it("loads successfully", () => {
    expect(() => runSql("PRAGMA foreign_key_check;")).not.toThrow();
  });

  it("rejects orphan lyric texts", () => {
    expect(() => runSql(`
      INSERT INTO lyric_texts (
        id, song_id, representation, content,
        created_at, created_by, updated_at, updated_by
      ) VALUES (
        'lyrics-1', 'missing-song', 'original', 'text',
        '${timestamp}', 'test', '${timestamp}', 'test'
      );
    `)).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("refuses to delete a song with content", () => {
    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', '${timestamp}', 'test', '${timestamp}', 'test');
      INSERT INTO lyric_texts (
        id, song_id, representation, content,
        created_at, created_by, updated_at, updated_by
      ) VALUES (
        'lyrics-1', 'song-1', 'original', 'text',
        '${timestamp}', 'test', '${timestamp}', 'test'
      );
      DELETE FROM songs WHERE id = 'song-1';
    `)).toThrow(/song_has_content/);
  });

  it("allows an empty song to be removed by later admin cleanup", () => {
    expect(() => runSql(`
      INSERT INTO songs (
        id, title_latin, created_at, created_by, updated_at, updated_by
      ) VALUES ('song-1', 'Test', '${timestamp}', 'test', '${timestamp}', 'test');
      DELETE FROM songs WHERE id = 'song-1';
      SELECT CASE WHEN COUNT(*) = 0 THEN 'ok' ELSE 'failed' END FROM songs;
    `)).not.toThrow();
  });

  it("escapes private text safely in generated seed SQL", () => {
    const sql = createSeedSql({
      schemaVersion: 1,
      languages: [], tags: [], notebooks: [], people: [],
      songs: [{
        id: "song-1", titleLatin: "Singer's song", titleNative: null, status: null,
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
});
