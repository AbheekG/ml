import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AudioIntegrationPlan } from "./plan-audio-integration";
import {
  generateD1IntegrationSql,
  runAudioIntegrationExecutor,
  type CommandRunner,
  type ExecutorOptions,
  type IntegrationState,
  uploadR2Objects,
} from "./audio-integration-executor";

const roots: string[] = [];
const policyId = "mp3-v1-libmp3lame-q2";

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function fixture(): Promise<{
  root: string;
  plan: AudioIntegrationPlan;
  planPath: string;
  statePath: string;
  d1SqlPath: string;
  derivativeBytes: Buffer;
}> {
  const root = await mkdtemp(resolve(tmpdir(), "audio-executor-"));
  roots.push(root);
  const derivativeBytes = Buffer.from("synthetic playback bytes");
  const sourceBytes = Buffer.from("synthetic original bytes");
  const derivativeHash = hash(derivativeBytes);
  const sourceHash = hash(sourceBytes);
  const localPath = "notes/private/audio-migration-output/media-fixture.mp3";
  const planPath = resolve(root, "data/import-output/audio-integration-plan.json");
  const statePath = resolve(root, "data/import-output/audio-integration-state.json");
  const d1SqlPath = resolve(root, "data/import-output/audio-integration.sql");
  await mkdir(resolve(root, dirname(localPath)), { recursive: true });
  await writeFile(resolve(root, localPath), derivativeBytes);

  const plan: AudioIntegrationPlan = {
    schemaVersion: 1,
    catalogSchemaVersion: 2,
    catalogSha256: "c".repeat(64),
    policyId,
    originalHashUpdates: [{
      mediaId: "media-original-fixture",
      expectedObjectKey: "recordings/fixture-original.bin",
      expectedSha256: null,
      sha256: sourceHash,
      byteSize: sourceBytes.length,
    }],
    playbackMediaInserts: [{
      id: "media-playback-fixture",
      objectKey: `recordings/playback/${policyId}/media-fixture.mp3`,
      originalFilename: "media-fixture.mp3",
      mimeType: "audio/mpeg",
      byteSize: derivativeBytes.length,
      sha256: derivativeHash,
      kind: "playback_audio",
      state: "active",
      localPath,
    }],
    derivativeProvenanceInserts: [{
      playbackMediaId: "media-playback-fixture",
      sourceMediaId: "media-original-fixture",
      policyId,
      sourceSha256: sourceHash,
      sourceByteSize: sourceBytes.length,
      derivativeSha256: derivativeHash,
      derivativeByteSize: derivativeBytes.length,
    }],
    recordingPlaybackUpdates: [{
      recordingId: "recording-fixture",
      expectedOriginalMediaId: "media-original-fixture",
      expectedPlaybackMediaId: null,
      expectedRevision: 1,
      playbackMediaId: "media-playback-fixture",
    }],
  };
  await writeJson(planPath, plan);
  return { root, plan, planPath, statePath, d1SqlPath, derivativeBytes };
}

function options(
  item: Awaited<ReturnType<typeof fixture>>,
  mode: ExecutorOptions["mode"] = "dry-run",
): ExecutorOptions {
  return {
    mode,
    planPath: item.planPath,
    statePath: item.statePath,
    d1SqlPath: item.d1SqlPath,
    bucket: "fixture-private-bucket",
    database: "fixture-database",
    concurrency: 2,
    projectRoot: item.root,
  };
}

function createCatalogDatabase(plan: AudioIntegrationPlan): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE media_objects (
      id TEXT PRIMARY KEY,
      object_key TEXT NOT NULL UNIQUE,
      original_filename TEXT NOT NULL,
      mime_type TEXT,
      byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
      sha256 TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('scan', 'original_audio', 'playback_audio')),
      state TEXT NOT NULL CHECK (state IN ('active', 'trashed')),
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      trashed_at TEXT,
      trashed_by TEXT
    );
    CREATE TABLE recordings (
      id TEXT PRIMARY KEY,
      original_media_id TEXT NOT NULL UNIQUE REFERENCES media_objects(id) ON DELETE RESTRICT,
      playback_media_id TEXT REFERENCES media_objects(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK (revision > 0),
      processing_state TEXT NOT NULL CHECK (processing_state IN ('processing', 'ready', 'failed')),
      processing_error TEXT,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );
  `);
  const insertMedia = database.prepare(`
    INSERT INTO media_objects (
      id, object_key, original_filename, mime_type, byte_size, sha256,
      kind, state, created_at, created_by
    ) VALUES (?, ?, ?, ?, ?, NULL, 'original_audio', 'active', ?, ?)
  `);
  for (const original of plan.originalHashUpdates) {
    insertMedia.run(
      original.mediaId,
      original.expectedObjectKey,
      `${original.mediaId}.bin`,
      "application/octet-stream",
      original.byteSize,
      "2026-01-01T00:00:00.000Z",
      "fixture",
    );
  }
  const insertRecording = database.prepare(`
    INSERT INTO recordings (
      id, original_media_id, playback_media_id, revision,
      processing_state, processing_error, updated_at, updated_by
    ) VALUES (?, ?, ?, ?, 'ready', NULL, ?, ?)
  `);
  for (const recording of plan.recordingPlaybackUpdates) {
    insertRecording.run(
      recording.recordingId,
      recording.expectedOriginalMediaId,
      recording.expectedPlaybackMediaId,
      recording.expectedRevision,
      "2026-01-01T00:00:00.000Z",
      "fixture",
    );
  }
  return database;
}

async function addDerivativeMigration(database: DatabaseSync): Promise<void> {
  database.exec(await readFile(
    resolve("migrations/0004_audio_derivatives.sql"),
    "utf8",
  ));
}

function applyAtomically(database: DatabaseSync, sql: string): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(sql);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function fakeR2(
  objects: Map<string, Buffer>,
): { runner: CommandRunner; gets: string[]; puts: string[] } {
  const gets: string[] = [];
  const puts: string[] = [];
  const runner: CommandRunner = async (_executable, arguments_) => {
    const operation = arguments_[2];
    const key = arguments_[3];
    if (arguments_[0] !== "r2" || arguments_[1] !== "object" || !key) {
      throw new Error("unexpected fake command");
    }
    const fileIndex = arguments_.indexOf("--file");
    const file = arguments_[fileIndex + 1];
    if (!file) throw new Error("missing fake file argument");
    if (operation === "get") {
      gets.push(key);
      const bytes = objects.get(key);
      if (!bytes) return { exitCode: 1, stdout: "", stderr: "NoSuchKey" };
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (operation === "put") {
      puts.push(key);
      objects.set(key, await readFile(file));
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw new Error("unexpected fake R2 operation");
  };
  return { runner, gets, puts };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("audio integration D1 phase", () => {
  it("applies atomically and is idempotent", async () => {
    const item = await fixture();
    const database = createCatalogDatabase(item.plan);
    await addDerivativeMigration(database);
    const sql = generateD1IntegrationSql(item.plan);

    applyAtomically(database, sql);
    expect(database.prepare(`
      SELECT sha256 FROM media_objects WHERE id = 'media-original-fixture'
    `).get()).toEqual({ sha256: item.plan.originalHashUpdates[0].sha256 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audio_derivatives").get())
      .toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT playback_media_id, revision, updated_by
      FROM recordings WHERE id = 'recording-fixture'
    `).get()).toEqual({
      playback_media_id: "media-playback-fixture",
      revision: 2,
      updated_by: "migration:audio-derivative-v1",
    });

    applyAtomically(database, sql);
    expect(database.prepare(`
      SELECT playback_media_id, revision
      FROM recordings WHERE id = 'recording-fixture'
    `).get()).toEqual({
      playback_media_id: "media-playback-fixture",
      revision: 2,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audio_derivatives").get())
      .toEqual({ count: 1 });
    database.close();
  });

  it("rolls back every earlier write when a live precondition changed", async () => {
    const item = await fixture();
    const database = createCatalogDatabase(item.plan);
    await addDerivativeMigration(database);
    database.exec("UPDATE recordings SET revision = 7");

    expect(() => applyAtomically(
      database,
      generateD1IntegrationSql(item.plan),
    )).toThrow();
    expect(database.prepare(`
      SELECT sha256 FROM media_objects WHERE id = 'media-original-fixture'
    `).get()).toEqual({ sha256: null });
    expect(database.prepare("SELECT COUNT(*) AS count FROM media_objects").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audio_derivatives").get())
      .toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = '__audio_integration_guard_v1'
    `).get()).toEqual({ count: 0 });
    database.close();
  });

  it("supports a guarded direct-original playback update without provenance", async () => {
    const item = await fixture();
    item.plan.originalHashUpdates.push({
      mediaId: "media-direct-fixture",
      expectedObjectKey: "recordings/direct-fixture.mp3",
      expectedSha256: null,
      sha256: "d".repeat(64),
      byteSize: 42,
    });
    item.plan.recordingPlaybackUpdates.push({
      recordingId: "recording-direct-fixture",
      expectedOriginalMediaId: "media-direct-fixture",
      expectedPlaybackMediaId: null,
      expectedRevision: 3,
      playbackMediaId: "media-direct-fixture",
    });
    await writeJson(item.planPath, item.plan);
    const aggregate = await runAudioIntegrationExecutor(options(item));
    expect(aggregate.recordingPlaybackUpdates).toBe(2);

    const database = createCatalogDatabase(item.plan);
    await addDerivativeMigration(database);
    applyAtomically(database, generateD1IntegrationSql(item.plan));
    expect(database.prepare(`
      SELECT playback_media_id, revision
      FROM recordings WHERE id = 'recording-direct-fixture'
    `).get()).toEqual({
      playback_media_id: "media-direct-fixture",
      revision: 4,
    });
    database.close();
  });
});

describe("audio integration R2 phase", () => {
  it("uploads, verifies, checkpoints, and resumes without another write", async () => {
    const item = await fixture();
    const state: IntegrationState = {
      schemaVersion: 1,
      planSha256: "a".repeat(64),
      bucket: "fixture-private-bucket",
      completed: {},
    };
    const objects = new Map<string, Buffer>();
    const remote = fakeR2(objects);
    const uploadOptions = {
      bucket: state.bucket,
      concurrency: 2,
      statePath: item.statePath,
      projectRoot: item.root,
    };

    await uploadR2Objects(item.plan, state, uploadOptions, remote.runner);
    expect(remote.puts).toHaveLength(1);
    expect(remote.gets).toHaveLength(2);
    expect(objects.get(`${state.bucket}/${item.plan.playbackMediaInserts[0].objectKey}`))
      .toEqual(item.derivativeBytes);
    expect(JSON.parse(await readFile(item.statePath, "utf8"))).toEqual(state);

    const callCounts = { gets: remote.gets.length, puts: remote.puts.length };
    await uploadR2Objects(item.plan, state, uploadOptions, remote.runner);
    expect(remote.gets).toHaveLength(callCounts.gets);
    expect(remote.puts).toHaveLength(callCounts.puts);
  });

  it("reuses matching remote bytes and refuses a conflicting object", async () => {
    const item = await fixture();
    const objectName = `fixture-private-bucket/${item.plan.playbackMediaInserts[0].objectKey}`;
    const matchingState: IntegrationState = {
      schemaVersion: 1,
      planSha256: "a".repeat(64),
      bucket: "fixture-private-bucket",
      completed: {},
    };
    const matching = fakeR2(new Map([[objectName, item.derivativeBytes]]));
    await uploadR2Objects(item.plan, matchingState, {
      bucket: matchingState.bucket,
      concurrency: 1,
      statePath: item.statePath,
      projectRoot: item.root,
    }, matching.runner);
    expect(matching.puts).toHaveLength(0);
    expect(Object.keys(matchingState.completed)).toEqual(["media-playback-fixture"]);

    const conflictingState: IntegrationState = {
      schemaVersion: 1,
      planSha256: "b".repeat(64),
      bucket: "fixture-private-bucket",
      completed: {},
    };
    const conflicting = fakeR2(new Map([[objectName, Buffer.from("other bytes")]]));
    await expect(uploadR2Objects(item.plan, conflictingState, {
      bucket: conflictingState.bucket,
      concurrency: 1,
      statePath: resolve(item.root, "data/import-output/conflicting-state.json"),
      projectRoot: item.root,
    }, conflicting.runner)).rejects.toMatchObject({
      code: "remote_object_content_mismatch",
    });
    expect(conflicting.puts).toHaveLength(0);
    expect(conflictingState.completed).toEqual({});
  });
});

describe("audio integration executor safety", () => {
  it("defaults to a private aggregate-only local dry run", async () => {
    const item = await fixture();
    const runner: CommandRunner = async () => {
      throw new Error("dry run contacted a remote service");
    };

    const aggregate = await runAudioIntegrationExecutor(options(item), runner);

    expect(aggregate).toMatchObject({
      mode: "dry-run",
      originalHashUpdates: 1,
      playbackMedia: 1,
      derivativeProvenance: 1,
      recordingPlaybackUpdates: 1,
      r2Objects: 1,
      r2StateCompleted: 0,
      r2StatePending: 1,
      d1Applied: false,
    });
    expect(JSON.stringify(aggregate)).not.toContain("media-original-fixture");
    expect(JSON.stringify(aggregate)).not.toContain(item.root);
    await expect(stat(item.statePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(item.d1SqlPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires the exact plan hash before any remote write", async () => {
    const item = await fixture();
    const runner: CommandRunner = async () => {
      throw new Error("unconfirmed execution contacted a remote service");
    };

    await expect(runAudioIntegrationExecutor(
      options(item, "upload-r2"),
      runner,
    )).rejects.toMatchObject({ code: "confirmed_plan_hash_required" });
    await expect(stat(item.statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("marks D1 complete only after verified R2 bytes and a successful import", async () => {
    const item = await fixture();
    const planSha256 = hash(await readFile(item.planPath));
    const media = item.plan.playbackMediaInserts[0];
    const state: IntegrationState = {
      schemaVersion: 1,
      planSha256,
      bucket: "fixture-private-bucket",
      completed: {
        [media.id]: {
          objectKey: media.objectKey,
          sha256: media.sha256,
          byteSize: media.byteSize,
        },
      },
    };
    await writeJson(item.statePath, state);
    let importSucceeds = false;
    const runner: CommandRunner = async (_executable, arguments_) => {
      if (arguments_[0] === "r2" && arguments_[2] === "get") {
        const file = arguments_[arguments_.indexOf("--file") + 1];
        await writeFile(file, item.derivativeBytes);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (arguments_[0] === "d1" && arguments_.includes("--command")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ results: [{ count: 1 }] }]),
          stderr: "",
        };
      }
      if (arguments_[0] === "d1" && arguments_.includes("--file")) {
        return importSucceeds
          ? { exitCode: 0, stdout: "[]", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "fixture import failure" };
      }
      throw new Error("unexpected fake command");
    };
    const applyOptions = options(item, "apply-d1");
    applyOptions.confirmPlanSha256 = planSha256;

    await expect(runAudioIntegrationExecutor(applyOptions, runner))
      .rejects.toMatchObject({ code: "remote_d1_apply_failed" });
    expect(JSON.parse(await readFile(item.statePath, "utf8")))
      .not.toHaveProperty("d1AppliedPlanSha256");

    importSucceeds = true;
    const aggregate = await runAudioIntegrationExecutor(applyOptions, runner);
    expect(aggregate.d1Applied).toBe(true);
    expect(JSON.parse(await readFile(item.statePath, "utf8")))
      .toHaveProperty("d1AppliedPlanSha256", planSha256);
  });

  it("refuses generated SQL outside ignored private roots", async () => {
    const item = await fixture();
    const unsafeOptions = options(item, "write-d1-sql");
    unsafeOptions.d1SqlPath = resolve(item.root, "tracked-output.sql");

    await expect(runAudioIntegrationExecutor(unsafeOptions)).rejects.toMatchObject({
      code: "executor_output_must_be_private",
    });
    await expect(stat(unsafeOptions.d1SqlPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
