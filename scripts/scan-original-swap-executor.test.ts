import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type SwapReplacement,
  type SwapTrashAction,
  replacementSql,
  trashSql,
} from "./scan-original-swap-executor";

const migration = Array.from({ length: 13 }, (_, index) => {
  const prefix = String(index + 1).padStart(4, "0");
  const names = {
    "0001": "initial",
    "0002": "editing_foundation",
    "0003": "song_writes",
    "0004": "audio_derivatives",
    "0005": "audio_processing_jobs",
    "0006": "recording_upload_sessions",
    "0007": "audio_processing_control",
    "0008": "audio_processing_concurrency",
    "0009": "media_replacements",
    "0010": "non_unique_audio_processing_jobs",
    "0011": "audio_dispatch_and_replacement_guards",
    "0012": "scan_integrity_and_readability",
    "0013": "scan_maintenance_leases",
  } as Record<string, string>;
  return readFileSync(resolve(`migrations/${prefix}_${names[prefix]}.sql`), "utf8");
}).join("\n");

const timestamp = "2026-07-17T00:00:00.000Z";
const formerHash = "a".repeat(64);
const formerDerivativeHash = "b".repeat(64);
const genuineHash = "c".repeat(64);
const newDerivativeHash = "d".repeat(64);

function seed(): string {
  return `
    INSERT INTO songs (
      id, title_latin, normalized_title_latin, status, revision,
      created_at, created_by, updated_at, updated_by
    ) VALUES (
      'song-1', 'Test', 'test', 'draft', 1,
      '${timestamp}', 'test', '${timestamp}', 'test'
    );
    INSERT INTO media_objects (
      id, object_key, original_filename, mime_type, byte_size, sha256,
      kind, state, created_at, created_by
    ) VALUES (
      'media-old', 'scans/old.jpg', 'old.jpg', 'image/jpeg', 10, '${formerHash}',
      'scan', 'active', '${timestamp}', 'test'
    );
    INSERT INTO scans (
      id, song_id, media_id, revision,
      created_at, created_by, updated_at, updated_by
    ) VALUES (
      'scan-1', 'song-1', 'media-old', 1,
      '${timestamp}', 'test', '${timestamp}', 'test'
    );
    INSERT INTO scan_readability_derivatives (
      source_media_id, source_sha256, source_byte_size, object_key,
      mime_type, byte_size, sha256, width, height, policy_id,
      created_at, created_by
    ) VALUES (
      'media-old', '${formerHash}', 10, 'scans/readability/media-old.jpg',
      'image/jpeg', 8, '${formerDerivativeHash}', 100, 200,
      'scan-jpeg-v1-2400-q85', '${timestamp}', 'test'
    );
  `;
}

function run(sql: string, query: string): string {
  return execFileSync("sqlite3", [":memory:"], {
    encoding: "utf8",
    input: `${migration}\n${seed()}\n${sql}\n${query}`,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

const replacement: SwapReplacement = {
  currentToken: "current-0001",
  genuineToken: "genuine-0001",
  scanId: "scan-1",
  songId: "song-1",
  expectedRevision: 1,
  formerMediaId: "media-old",
  formerObjectKey: "scans/old.jpg",
  formerFilename: "old.jpg",
  formerMimeType: "image/jpeg",
  formerByteSize: 10,
  formerSha256: formerHash,
  formerDerivativeObjectKey: "scans/readability/media-old.jpg",
  formerDerivativeByteSize: 8,
  formerDerivativeSha256: formerDerivativeHash,
  genuineLocalPath: "legacy/drive/Final/test/new.jpg",
  genuineRelativePath: "test/new.jpg",
  genuineFilename: "new.jpg",
  genuineMimeType: "image/jpeg",
  genuineByteSize: 20,
  genuineSha256: genuineHash,
  genuineWidth: 1000,
  genuineHeight: 2000,
  displayRotationDegrees: 0,
  newMediaId: "media-new",
  historyId: "history-1",
  newObjectKey: "scans/recovered/op/media-new.jpg",
  derivativeObjectKey: "scans/readability/media-new.jpg",
  derivativeLocalPath: "notes/private/test/media-new.jpg",
  derivativeByteSize: 12,
  derivativeSha256: newDerivativeHash,
  derivativeWidth: 1200,
  derivativeHeight: 2400,
};

describe("scan-original guarded D1 changes", () => {
  it("replaces one Scan atomically, retains history, and is idempotent", () => {
    const sql = replacementSql(replacement);
    const output = run(`${sql}\n${sql}`, `
      SELECT
        scans.media_id || '|' || scans.revision || '|' ||
        (SELECT count(*) FROM scan_media_history) || '|' ||
        (SELECT count(*) FROM scan_readability_derivatives) || '|' ||
        (SELECT count(*) FROM pragma_foreign_key_check)
      FROM scans WHERE id = 'scan-1';
    `);
    expect(output).toBe("media-new|2|1|2|0\n");
  });

  it("trashes the wrong-song Scan and its media recoverably", () => {
    const action: SwapTrashAction = {
      currentToken: "current-0002",
      scanId: "scan-1",
      songId: "song-1",
      expectedRevision: 1,
      mediaId: "media-old",
      sourceObjectKey: "scans/old.jpg",
      sourceByteSize: 10,
      sourceSha256: formerHash,
      derivativeObjectKey: "scans/readability/media-old.jpg",
      derivativeByteSize: 8,
      derivativeSha256: formerDerivativeHash,
    };
    const sql = trashSql(action);
    const output = run(`${sql}\n${sql}`, `
      SELECT
        CASE WHEN scans.trashed_at IS NULL THEN 0 ELSE 1 END || '|' ||
        scans.revision || '|' || media_objects.state || '|' ||
        (SELECT count(*) FROM pragma_foreign_key_check)
      FROM scans JOIN media_objects ON media_objects.id = scans.media_id
      WHERE scans.id = 'scan-1';
    `);
    expect(output).toBe("1|2|trashed|0\n");
  });
});
