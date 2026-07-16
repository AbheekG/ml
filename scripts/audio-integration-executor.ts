import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { AudioIntegrationPlan } from "./plan-audio-integration";

const PROJECT_ROOT = resolve(".");
const DEFAULT_PLAN = resolve("data/import-output/audio-integration-plan.json");
const DEFAULT_STATE = resolve("data/import-output/audio-integration-state.json");
const DEFAULT_D1_SQL = resolve("data/import-output/audio-integration.sql");
const WRANGLER = resolve("node_modules/.bin/wrangler");
const DEFAULT_BUCKET = "music-library-media-staging";
const DEFAULT_DATABASE = "music-library-staging-apac";
const INTEGRATION_ACTOR = "migration:audio-derivative-v1";
const SHA256 = /^[0-9a-f]{64}$/;
const OPAQUE_PATH_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type JsonObject = Record<string, unknown>;

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (
  executable: string,
  arguments_: string[],
) => Promise<CommandResult>;

export type IntegrationState = {
  schemaVersion: 1;
  planSha256: string;
  bucket: string;
  completed: Record<string, {
    objectKey: string;
    sha256: string;
    byteSize: number;
  }>;
  d1AppliedPlanSha256?: string;
};

export type ExecutorMode =
  | "dry-run"
  | "write-d1-sql"
  | "verify-r2"
  | "upload-r2"
  | "apply-d1";

export type ExecutorOptions = {
  mode: ExecutorMode;
  planPath: string;
  statePath: string;
  d1SqlPath: string;
  bucket: string;
  database: string;
  concurrency: number;
  confirmPlanSha256?: string;
  projectRoot?: string;
};

export type ExecutorAggregate = {
  schemaVersion: 1;
  mode: ExecutorMode;
  planSha256: string;
  policyId: string;
  originalHashUpdates: number;
  playbackMedia: number;
  derivativeProvenance: number;
  recordingPlaybackUpdates: number;
  r2Objects: number;
  r2Bytes: number;
  r2StateCompleted: number;
  r2StatePending: number;
  remoteR2Verified?: number;
  remoteR2Missing?: number;
  d1SqlBytes: number;
  d1Applied: boolean;
};

export class AudioIntegrationExecutionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function objectValue(value: unknown, code: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AudioIntegrationExecutionError(code);
  }
  return value as JsonObject;
}

function arrayValue(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) throw new AudioIntegrationExecutionError(code);
  return value;
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AudioIntegrationExecutionError(code);
  }
  return value;
}

function nullableString(value: unknown, code: string): string | null {
  if (value === null) return null;
  return stringValue(value, code);
}

function integerValue(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AudioIntegrationExecutionError(code);
  }
  return value as number;
}

function sha256Value(value: unknown, code: string): string {
  const hash = stringValue(value, code);
  if (!SHA256.test(hash)) throw new AudioIntegrationExecutionError(code);
  return hash;
}

function isWithin(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  } catch {
    throw new AudioIntegrationExecutionError("file_hash_failed");
  }
  return hash.digest("hex");
}

async function readJson(path: string, code: string): Promise<JsonObject> {
  try {
    return objectValue(JSON.parse(await readFile(path, "utf8")), code);
  } catch (error) {
    if (error instanceof AudioIntegrationExecutionError) throw error;
    throw new AudioIntegrationExecutionError(code);
  }
}

async function writeTextAtomic(
  path: string,
  content: string,
  projectRoot: string,
): Promise<void> {
  const resolved = resolve(path);
  const privateRoots = [
    resolve(projectRoot, "data/import-output"),
    resolve(projectRoot, "notes/private"),
  ];
  if (!privateRoots.some((root) => isWithin(resolved, root))) {
    throw new AudioIntegrationExecutionError("executor_output_must_be_private");
  }
  if (["legacy/appsheet", "legacy/woodchime"].some((name) => (
    isWithin(resolved, resolve(projectRoot, name))
  ))) {
    throw new AudioIntegrationExecutionError("executor_output_inside_legacy_root");
  }
  await mkdir(dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${randomUUID()}.temporary`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, resolved);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parsePlan(value: JsonObject): AudioIntegrationPlan {
  if (value.schemaVersion !== 1 || value.catalogSchemaVersion !== 2) {
    throw new AudioIntegrationExecutionError("unsupported_audio_plan_version");
  }
  const policyId = stringValue(value.policyId, "invalid_audio_plan_policy");
  if (!OPAQUE_PATH_PART.test(policyId)) {
    throw new AudioIntegrationExecutionError("invalid_audio_plan_policy");
  }
  const catalogSha256 = sha256Value(
    value.catalogSha256,
    "invalid_audio_plan_catalog_hash",
  );

  const originalHashUpdates = arrayValue(
    value.originalHashUpdates,
    "invalid_original_hash_updates",
  ).map((item) => {
    const row = objectValue(item, "invalid_original_hash_update");
    const expectedSha256 = nullableString(
      row.expectedSha256,
      "invalid_expected_original_hash",
    );
    if (expectedSha256 !== null && !SHA256.test(expectedSha256)) {
      throw new AudioIntegrationExecutionError("invalid_expected_original_hash");
    }
    return {
      mediaId: stringValue(row.mediaId, "invalid_original_media_id"),
      expectedObjectKey: stringValue(
        row.expectedObjectKey,
        "invalid_original_object_key",
      ),
      expectedSha256,
      sha256: sha256Value(row.sha256, "invalid_original_hash"),
      byteSize: integerValue(row.byteSize, "invalid_original_size"),
    };
  });
  const playbackMediaInserts = arrayValue(
    value.playbackMediaInserts,
    "invalid_playback_media_inserts",
  ).map((item) => {
    const row = objectValue(item, "invalid_playback_media_insert");
    const objectKey = stringValue(row.objectKey, "invalid_playback_object_key");
    const expectedPrefix = `recordings/playback/${policyId}/`;
    if (
      !objectKey.startsWith(expectedPrefix)
      || !objectKey.endsWith(".mp3")
      || objectKey.includes("..")
    ) {
      throw new AudioIntegrationExecutionError("invalid_playback_object_key");
    }
    if (
      row.mimeType !== "audio/mpeg"
      || row.kind !== "playback_audio"
      || row.state !== "active"
    ) {
      throw new AudioIntegrationExecutionError("invalid_playback_media_values");
    }
    return {
      id: stringValue(row.id, "invalid_playback_media_id"),
      objectKey,
      originalFilename: stringValue(
        row.originalFilename,
        "invalid_playback_filename",
      ),
      mimeType: "audio/mpeg" as const,
      byteSize: integerValue(row.byteSize, "invalid_playback_size"),
      sha256: sha256Value(row.sha256, "invalid_playback_hash"),
      kind: "playback_audio" as const,
      state: "active" as const,
      localPath: stringValue(row.localPath, "invalid_playback_local_path"),
    };
  });
  const derivativeProvenanceInserts = arrayValue(
    value.derivativeProvenanceInserts,
    "invalid_derivative_provenance_inserts",
  ).map((item) => {
    const row = objectValue(item, "invalid_derivative_provenance_insert");
    if (row.policyId !== policyId) {
      throw new AudioIntegrationExecutionError("derivative_policy_mismatch");
    }
    return {
      playbackMediaId: stringValue(
        row.playbackMediaId,
        "invalid_provenance_playback_id",
      ),
      sourceMediaId: stringValue(
        row.sourceMediaId,
        "invalid_provenance_source_id",
      ),
      policyId,
      sourceSha256: sha256Value(
        row.sourceSha256,
        "invalid_provenance_source_hash",
      ),
      sourceByteSize: integerValue(
        row.sourceByteSize,
        "invalid_provenance_source_size",
      ),
      derivativeSha256: sha256Value(
        row.derivativeSha256,
        "invalid_provenance_derivative_hash",
      ),
      derivativeByteSize: integerValue(
        row.derivativeByteSize,
        "invalid_provenance_derivative_size",
      ),
    };
  });
  const recordingPlaybackUpdates = arrayValue(
    value.recordingPlaybackUpdates,
    "invalid_recording_playback_updates",
  ).map((item) => {
    const row = objectValue(item, "invalid_recording_playback_update");
    return {
      recordingId: stringValue(row.recordingId, "invalid_recording_id"),
      expectedOriginalMediaId: stringValue(
        row.expectedOriginalMediaId,
        "invalid_recording_original_id",
      ),
      expectedPlaybackMediaId: nullableString(
        row.expectedPlaybackMediaId,
        "invalid_expected_playback_id",
      ),
      expectedRevision: integerValue(
        row.expectedRevision,
        "invalid_recording_revision",
      ),
      playbackMediaId: stringValue(
        row.playbackMediaId,
        "invalid_recording_playback_id",
      ),
    };
  });

  const unique = (items: string[], code: string) => {
    if (new Set(items).size !== items.length) {
      throw new AudioIntegrationExecutionError(code);
    }
  };
  unique(originalHashUpdates.map((row) => row.mediaId), "duplicate_original_update");
  unique(playbackMediaInserts.map((row) => row.id), "duplicate_playback_media");
  unique(playbackMediaInserts.map((row) => row.objectKey), "duplicate_playback_key");
  unique(
    derivativeProvenanceInserts.map((row) => row.playbackMediaId),
    "duplicate_derivative_provenance",
  );
  unique(
    recordingPlaybackUpdates.map((row) => row.recordingId),
    "duplicate_recording_update",
  );
  const derivativePlaybackUpdates = recordingPlaybackUpdates.filter(
    (row) => row.playbackMediaId !== row.expectedOriginalMediaId,
  );
  unique(
    derivativePlaybackUpdates.map((row) => row.playbackMediaId),
    "duplicate_derivative_recording_playback",
  );
  if (
    playbackMediaInserts.length !== derivativeProvenanceInserts.length
    || playbackMediaInserts.length !== derivativePlaybackUpdates.length
  ) {
    throw new AudioIntegrationExecutionError("audio_plan_count_mismatch");
  }
  const mediaById = new Map(playbackMediaInserts.map((row) => [row.id, row]));
  const provenanceById = new Map(
    derivativeProvenanceInserts.map((row) => [row.playbackMediaId, row]),
  );
  for (const update of derivativePlaybackUpdates) {
    const media = mediaById.get(update.playbackMediaId);
    const provenance = provenanceById.get(update.playbackMediaId);
    if (
      !media
      || !provenance
      || provenance.sourceMediaId !== update.expectedOriginalMediaId
      || provenance.derivativeSha256 !== media.sha256
      || provenance.derivativeByteSize !== media.byteSize
    ) {
      throw new AudioIntegrationExecutionError("audio_plan_relationship_mismatch");
    }
  }

  return {
    schemaVersion: 1,
    catalogSchemaVersion: 2,
    catalogSha256,
    policyId,
    originalHashUpdates,
    playbackMediaInserts,
    derivativeProvenanceInserts,
    recordingPlaybackUpdates,
  };
}

function sqlText(value: string): string {
  if (value.includes("\0")) {
    throw new AudioIntegrationExecutionError("invalid_sql_text_value");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function nullableSqlPredicate(column: string, value: string | null): string {
  return value === null ? `${column} IS NULL` : `${column} = ${sqlText(value)}`;
}

function guard(condition: string): string {
  return `INSERT INTO __audio_integration_guard_v1 (ok) SELECT CASE WHEN ${condition} THEN 1 ELSE 0 END;`;
}

export function generateD1IntegrationSql(plan: AudioIntegrationPlan): string {
  const lines = [
    "PRAGMA foreign_keys = ON;",
    "CREATE TABLE __audio_integration_guard_v1 (ok INTEGER NOT NULL CHECK (ok = 1));",
    guard("EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audio_derivatives')"),
  ];

  for (const update of plan.originalHashUpdates) {
    const mediaId = sqlText(update.mediaId);
    const objectKey = sqlText(update.expectedObjectKey);
    const hash = sqlText(update.sha256);
    const expectedHash = update.expectedSha256 === null
      ? `sha256 IS NULL OR sha256 = ${hash}`
      : `sha256 = ${sqlText(update.expectedSha256)}`;
    lines.push(guard(`EXISTS (
      SELECT 1 FROM media_objects
      WHERE id = ${mediaId}
        AND object_key = ${objectKey}
        AND kind = 'original_audio'
        AND state = 'active'
        AND byte_size = ${update.byteSize}
        AND (${expectedHash})
    )`));
    lines.push(`UPDATE media_objects
      SET sha256 = ${hash}
      WHERE id = ${mediaId} AND sha256 IS NULL;`);
  }

  for (const media of plan.playbackMediaInserts) {
    const id = sqlText(media.id);
    const key = sqlText(media.objectKey);
    const filename = sqlText(media.originalFilename);
    const hash = sqlText(media.sha256);
    lines.push(guard(`(
      NOT EXISTS (
        SELECT 1 FROM media_objects
        WHERE id = ${id} OR object_key = ${key}
      )
      OR EXISTS (
        SELECT 1 FROM media_objects
        WHERE id = ${id}
          AND object_key = ${key}
          AND original_filename = ${filename}
          AND mime_type = 'audio/mpeg'
          AND byte_size = ${media.byteSize}
          AND sha256 = ${hash}
          AND kind = 'playback_audio'
          AND state = 'active'
      )
    )`));
    lines.push(`INSERT INTO media_objects (
      id, object_key, original_filename, mime_type, byte_size, sha256, kind,
      state, created_at, created_by
    )
    SELECT
      ${id}, ${key}, ${filename}, 'audio/mpeg', ${media.byteSize}, ${hash},
      'playback_audio', 'active',
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${sqlText(INTEGRATION_ACTOR)}
    WHERE NOT EXISTS (SELECT 1 FROM media_objects WHERE id = ${id});`);
  }

  for (const provenance of plan.derivativeProvenanceInserts) {
    const playbackId = sqlText(provenance.playbackMediaId);
    const sourceId = sqlText(provenance.sourceMediaId);
    const policyId = sqlText(provenance.policyId);
    const sourceHash = sqlText(provenance.sourceSha256);
    const derivativeHash = sqlText(provenance.derivativeSha256);
    lines.push(guard(`(
      NOT EXISTS (
        SELECT 1 FROM audio_derivatives
        WHERE playback_media_id = ${playbackId}
           OR (source_media_id = ${sourceId} AND policy_id = ${policyId})
      )
      OR EXISTS (
        SELECT 1 FROM audio_derivatives
        WHERE playback_media_id = ${playbackId}
          AND source_media_id = ${sourceId}
          AND policy_id = ${policyId}
          AND source_sha256 = ${sourceHash}
          AND source_byte_size = ${provenance.sourceByteSize}
          AND derivative_sha256 = ${derivativeHash}
          AND derivative_byte_size = ${provenance.derivativeByteSize}
      )
    )`));
    lines.push(`INSERT INTO audio_derivatives (
      playback_media_id, source_media_id, policy_id,
      source_sha256, source_byte_size, derivative_sha256, derivative_byte_size
    )
    SELECT
      ${playbackId}, ${sourceId}, ${policyId},
      ${sourceHash}, ${provenance.sourceByteSize},
      ${derivativeHash}, ${provenance.derivativeByteSize}
    WHERE NOT EXISTS (
      SELECT 1 FROM audio_derivatives WHERE playback_media_id = ${playbackId}
    );`);
  }

  for (const update of plan.recordingPlaybackUpdates) {
    const recordingId = sqlText(update.recordingId);
    const originalId = sqlText(update.expectedOriginalMediaId);
    const playbackId = sqlText(update.playbackMediaId);
    const expectedPlayback = nullableSqlPredicate(
      "playback_media_id",
      update.expectedPlaybackMediaId,
    );
    lines.push(guard(`(
      EXISTS (
        SELECT 1 FROM recordings
        WHERE id = ${recordingId}
          AND original_media_id = ${originalId}
          AND playback_media_id = ${playbackId}
      )
      OR EXISTS (
        SELECT 1 FROM recordings
        WHERE id = ${recordingId}
          AND original_media_id = ${originalId}
          AND ${expectedPlayback}
          AND revision = ${update.expectedRevision}
          AND processing_state = 'ready'
          AND processing_error IS NULL
      )
    )`));
    lines.push(`UPDATE recordings
      SET playback_media_id = ${playbackId},
          revision = revision + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          updated_by = ${sqlText(INTEGRATION_ACTOR)}
      WHERE id = ${recordingId}
        AND original_media_id = ${originalId}
        AND ${expectedPlayback}
        AND revision = ${update.expectedRevision};`);
  }

  for (const update of plan.originalHashUpdates) {
    lines.push(guard(`EXISTS (
      SELECT 1 FROM media_objects
      WHERE id = ${sqlText(update.mediaId)}
        AND sha256 = ${sqlText(update.sha256)}
        AND byte_size = ${update.byteSize}
        AND kind = 'original_audio'
    )`));
  }
  for (const media of plan.playbackMediaInserts) {
    lines.push(guard(`EXISTS (
      SELECT 1 FROM media_objects
      WHERE id = ${sqlText(media.id)}
        AND object_key = ${sqlText(media.objectKey)}
        AND sha256 = ${sqlText(media.sha256)}
        AND byte_size = ${media.byteSize}
        AND kind = 'playback_audio'
        AND state = 'active'
    )`));
  }
  for (const update of plan.recordingPlaybackUpdates) {
    lines.push(guard(`EXISTS (
      SELECT 1 FROM recordings
      WHERE id = ${sqlText(update.recordingId)}
        AND original_media_id = ${sqlText(update.expectedOriginalMediaId)}
        AND playback_media_id = ${sqlText(update.playbackMediaId)}
        AND processing_state = 'ready'
        AND processing_error IS NULL
        AND EXISTS (
          SELECT 1 FROM media_objects
          WHERE id = ${sqlText(update.expectedOriginalMediaId)}
            AND kind = 'original_audio'
            AND state = 'active'
        )
    )`));
  }
  lines.push(
    guard("NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)"),
    "DROP TABLE __audio_integration_guard_v1;",
  );
  return `${lines.join("\n")}\n`;
}

async function defaultCommandRunner(
  executable: string,
  arguments_: string[],
): Promise<CommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function remoteMissing(result: CommandResult): boolean {
  const text = `${result.stdout}\n${result.stderr}`;
  return /NoSuchKey|not found|does not exist|10007/i.test(text);
}

async function verifyDownloadedObject(
  path: string,
  expected: AudioIntegrationPlan["playbackMediaInserts"][number],
): Promise<void> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    throw new AudioIntegrationExecutionError("remote_object_download_missing");
  }
  if (
    !metadata.isFile()
    || metadata.size !== expected.byteSize
    || await sha256File(path) !== expected.sha256
  ) {
    throw new AudioIntegrationExecutionError("remote_object_content_mismatch");
  }
}

async function downloadRemoteObject(
  runner: CommandRunner,
  bucket: string,
  media: AudioIntegrationPlan["playbackMediaInserts"][number],
  destination: string,
): Promise<"verified" | "missing"> {
  const result = await runner(WRANGLER, [
    "r2", "object", "get", `${bucket}/${media.objectKey}`,
    "--remote", "--file", destination,
  ]);
  if (result.exitCode !== 0) {
    if (remoteMissing(result)) return "missing";
    throw new AudioIntegrationExecutionError("remote_r2_read_failed");
  }
  await verifyDownloadedObject(destination, media);
  return "verified";
}

async function uploadRemoteObject(
  runner: CommandRunner,
  bucket: string,
  projectRoot: string,
  media: AudioIntegrationPlan["playbackMediaInserts"][number],
): Promise<void> {
  const localPath = resolve(projectRoot, media.localPath);
  if (!isWithin(localPath, resolve(projectRoot, "notes/private"))) {
    throw new AudioIntegrationExecutionError("playback_source_must_be_private");
  }
  const result = await runner(WRANGLER, [
    "r2", "object", "put", `${bucket}/${media.objectKey}`,
    "--remote", "--file", localPath,
    "--content-type", "audio/mpeg",
    "--cache-control", "private, max-age=3600",
    "--force",
  ]);
  if (result.exitCode !== 0) {
    throw new AudioIntegrationExecutionError("remote_r2_upload_failed");
  }
}

async function mapLimit<T, U>(
  values: readonly T[],
  limit: number,
  operation: (value: T) => Promise<U>,
): Promise<U[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AudioIntegrationExecutionError("concurrency_must_be_positive");
  }
  const output = new Array<U>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next;
      next += 1;
      output[index] = await operation(values[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  return output;
}

async function validateLocalPlaybackFiles(
  plan: AudioIntegrationPlan,
  projectRoot: string,
  concurrency: number,
): Promise<void> {
  await mapLimit(plan.playbackMediaInserts, concurrency, async (media) => {
    const path = resolve(projectRoot, media.localPath);
    if (!isWithin(path, resolve(projectRoot, "notes/private"))) {
      throw new AudioIntegrationExecutionError("playback_source_must_be_private");
    }
    let metadata;
    try {
      metadata = await stat(path);
    } catch {
      throw new AudioIntegrationExecutionError("playback_source_missing");
    }
    if (
      !metadata.isFile()
      || metadata.size !== media.byteSize
      || await sha256File(path) !== media.sha256
    ) {
      throw new AudioIntegrationExecutionError("playback_source_mismatch");
    }
  });
}

async function loadState(
  path: string,
  planSha256: string,
  bucket: string,
): Promise<IntegrationState> {
  let payload: JsonObject;
  try {
    payload = await readJson(path, "invalid_audio_integration_state");
  } catch (error) {
    if (
      error instanceof AudioIntegrationExecutionError
      && error.code === "invalid_audio_integration_state"
    ) {
      try {
        await stat(path);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") {
          return {
            schemaVersion: 1,
            planSha256,
            bucket,
            completed: {},
          };
        }
      }
    }
    throw error;
  }
  if (
    payload.schemaVersion !== 1
    || payload.planSha256 !== planSha256
    || payload.bucket !== bucket
  ) {
    throw new AudioIntegrationExecutionError("audio_integration_state_mismatch");
  }
  const rawCompleted = objectValue(
    payload.completed,
    "invalid_audio_integration_state",
  );
  const completed: IntegrationState["completed"] = {};
  for (const [mediaId, rawEntry] of Object.entries(rawCompleted)) {
    const entry = objectValue(rawEntry, "invalid_audio_integration_state");
    completed[mediaId] = {
      objectKey: stringValue(entry.objectKey, "invalid_audio_integration_state"),
      sha256: sha256Value(entry.sha256, "invalid_audio_integration_state"),
      byteSize: integerValue(entry.byteSize, "invalid_audio_integration_state"),
    };
  }
  const d1AppliedPlanSha256 = payload.d1AppliedPlanSha256 === undefined
    ? undefined
    : sha256Value(payload.d1AppliedPlanSha256, "invalid_audio_integration_state");
  return {
    schemaVersion: 1,
    planSha256,
    bucket,
    completed,
    ...(d1AppliedPlanSha256 ? { d1AppliedPlanSha256 } : {}),
  };
}

async function saveState(
  path: string,
  state: IntegrationState,
  projectRoot: string,
): Promise<void> {
  await writeTextAtomic(
    path,
    `${JSON.stringify(state, null, 2)}\n`,
    projectRoot,
  );
}

function reconcileState(
  plan: AudioIntegrationPlan,
  state: IntegrationState,
): void {
  const planned = new Map(plan.playbackMediaInserts.map((media) => [media.id, media]));
  for (const [mediaId, completed] of Object.entries(state.completed)) {
    const media = planned.get(mediaId);
    if (
      !media
      || media.objectKey !== completed.objectKey
      || media.sha256 !== completed.sha256
      || media.byteSize !== completed.byteSize
    ) {
      throw new AudioIntegrationExecutionError("audio_integration_state_entry_mismatch");
    }
  }
}

export async function verifyRemoteR2Objects(
  plan: AudioIntegrationPlan,
  options: Pick<ExecutorOptions, "bucket" | "concurrency">,
  runner: CommandRunner = defaultCommandRunner,
): Promise<{ verified: number; missing: number }> {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "audio-r2-verify-"));
  try {
    const statuses = await mapLimit(
      plan.playbackMediaInserts,
      options.concurrency,
      async (media) => {
        const destination = resolve(temporaryRoot, `${randomUUID()}.mp3`);
        return await downloadRemoteObject(
          runner,
          options.bucket,
          media,
          destination,
        );
      },
    );
    return {
      verified: statuses.filter((status) => status === "verified").length,
      missing: statuses.filter((status) => status === "missing").length,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function uploadR2Objects(
  plan: AudioIntegrationPlan,
  state: IntegrationState,
  options: Pick<ExecutorOptions, "bucket" | "concurrency" | "statePath"> & {
    projectRoot: string;
  },
  runner: CommandRunner = defaultCommandRunner,
  pause: (milliseconds: number) => Promise<void> = async (milliseconds) => {
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, milliseconds);
    });
  },
): Promise<void> {
  reconcileState(plan, state);
  const pending = plan.playbackMediaInserts.filter((media) => !state.completed[media.id]);
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "audio-r2-upload-"));
  let saveQueue = Promise.resolve();
  let deferredVerification = 0;
  try {
    await mapLimit(pending, options.concurrency, async (media) => {
      const beforePath = resolve(temporaryRoot, `${randomUUID()}.before.mp3`);
      const before = await downloadRemoteObject(
        runner,
        options.bucket,
        media,
        beforePath,
      );
      if (before === "missing") {
        await uploadRemoteObject(
          runner,
          options.bucket,
          options.projectRoot,
          media,
        );
        let after: "verified" | "missing" = "missing";
        for (const delay of [0, 1_000, 2_000]) {
          if (delay > 0) await pause(delay);
          const afterPath = resolve(temporaryRoot, `${randomUUID()}.after.mp3`);
          after = await downloadRemoteObject(
            runner,
            options.bucket,
            media,
            afterPath,
          );
          if (after === "verified") break;
        }
        if (after !== "verified") {
          deferredVerification += 1;
          return;
        }
      }
      state.completed[media.id] = {
        objectKey: media.objectKey,
        sha256: media.sha256,
        byteSize: media.byteSize,
      };
      saveQueue = saveQueue.then(() => saveState(
        options.statePath,
        state,
        options.projectRoot,
      ));
      await saveQueue;
    });
    if (deferredVerification > 0) {
      throw new AudioIntegrationExecutionError("r2_upload_verification_deferred");
    }
  } finally {
    await saveQueue;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function requireConfirmedPlan(
  options: ExecutorOptions,
  planSha256: string,
): void {
  if (options.confirmPlanSha256 !== planSha256) {
    throw new AudioIntegrationExecutionError("confirmed_plan_hash_required");
  }
}

async function requireD1Migration(
  database: string,
  runner: CommandRunner,
): Promise<void> {
  const result = await runner(WRANGLER, [
    "d1", "execute", database,
    "--remote", "--json",
    "--command",
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'audio_derivatives'",
  ]);
  if (result.exitCode !== 0) {
    throw new AudioIntegrationExecutionError("remote_d1_preflight_failed");
  }
  try {
    const payload = JSON.parse(result.stdout) as Array<{ results?: Array<{ count?: number }> }>;
    if (Number(payload[0]?.results?.[0]?.count) !== 1) {
      throw new AudioIntegrationExecutionError("d1_migration_required");
    }
  } catch (error) {
    if (error instanceof AudioIntegrationExecutionError) throw error;
    throw new AudioIntegrationExecutionError("invalid_remote_d1_response");
  }
}

async function applyD1(
  options: ExecutorOptions,
  sql: string,
  state: IntegrationState,
  plan: AudioIntegrationPlan,
  runner: CommandRunner,
): Promise<void> {
  if (Object.keys(state.completed).length !== plan.playbackMediaInserts.length) {
    throw new AudioIntegrationExecutionError("r2_upload_incomplete");
  }
  const remote = await verifyRemoteR2Objects(
    plan,
    { bucket: options.bucket, concurrency: options.concurrency },
    runner,
  );
  if (remote.missing !== 0 || remote.verified !== plan.playbackMediaInserts.length) {
    throw new AudioIntegrationExecutionError("remote_r2_verification_incomplete");
  }
  await requireD1Migration(options.database, runner);
  const projectRoot = resolve(options.projectRoot ?? PROJECT_ROOT);
  await writeTextAtomic(options.d1SqlPath, sql, projectRoot);
  const result = await runner(WRANGLER, [
    "d1", "execute", options.database,
    "--remote", "--yes", "--json", "--file", resolve(options.d1SqlPath),
  ]);
  if (result.exitCode !== 0) {
    throw new AudioIntegrationExecutionError("remote_d1_apply_failed");
  }
  state.d1AppliedPlanSha256 = state.planSha256;
  await saveState(options.statePath, state, projectRoot);
}

async function loadPlanAndState(options: ExecutorOptions): Promise<{
  plan: AudioIntegrationPlan;
  planSha256: string;
  state: IntegrationState;
  sql: string;
  projectRoot: string;
}> {
  const projectRoot = resolve(options.projectRoot ?? PROJECT_ROOT);
  const planPath = resolve(options.planPath);
  const statePath = resolve(options.statePath);
  const d1SqlPath = resolve(options.d1SqlPath);
  const localPlaybackPaths = new Set<string>();
  if (planPath === statePath || planPath === d1SqlPath || statePath === d1SqlPath) {
    throw new AudioIntegrationExecutionError("executor_paths_must_be_separate");
  }
  const [rawPlan, planSha256] = await Promise.all([
    readJson(planPath, "invalid_audio_integration_plan"),
    sha256File(planPath),
  ]);
  const plan = parsePlan(rawPlan);
  for (const media of plan.playbackMediaInserts) {
    localPlaybackPaths.add(resolve(projectRoot, media.localPath));
  }
  if (localPlaybackPaths.has(statePath) || localPlaybackPaths.has(d1SqlPath)) {
    throw new AudioIntegrationExecutionError("executor_output_replaces_media");
  }
  await validateLocalPlaybackFiles(plan, projectRoot, options.concurrency);
  const state = await loadState(options.statePath, planSha256, options.bucket);
  reconcileState(plan, state);
  const sql = generateD1IntegrationSql(plan);
  return { plan, planSha256, state, sql, projectRoot };
}

export async function runAudioIntegrationExecutor(
  options: ExecutorOptions,
  runner: CommandRunner = defaultCommandRunner,
): Promise<ExecutorAggregate> {
  const { plan, planSha256, state, sql, projectRoot } = await loadPlanAndState(options);
  let remoteR2: { verified: number; missing: number } | undefined;

  if (options.mode === "write-d1-sql") {
    await writeTextAtomic(options.d1SqlPath, sql, projectRoot);
  } else if (options.mode === "verify-r2") {
    remoteR2 = await verifyRemoteR2Objects(
      plan,
      { bucket: options.bucket, concurrency: options.concurrency },
      runner,
    );
  } else if (options.mode === "upload-r2") {
    requireConfirmedPlan(options, planSha256);
    await uploadR2Objects(
      plan,
      state,
      {
        bucket: options.bucket,
        concurrency: options.concurrency,
        statePath: options.statePath,
        projectRoot,
      },
      runner,
    );
  } else if (options.mode === "apply-d1") {
    requireConfirmedPlan(options, planSha256);
    await applyD1(options, sql, state, plan, runner);
  }

  const completed = Object.keys(state.completed).length;
  return {
    schemaVersion: 1,
    mode: options.mode,
    planSha256,
    policyId: plan.policyId,
    originalHashUpdates: plan.originalHashUpdates.length,
    playbackMedia: plan.playbackMediaInserts.length,
    derivativeProvenance: plan.derivativeProvenanceInserts.length,
    recordingPlaybackUpdates: plan.recordingPlaybackUpdates.length,
    r2Objects: plan.playbackMediaInserts.length,
    r2Bytes: plan.playbackMediaInserts.reduce(
      (total, media) => total + media.byteSize,
      0,
    ),
    r2StateCompleted: completed,
    r2StatePending: plan.playbackMediaInserts.length - completed,
    ...(remoteR2
      ? {
          remoteR2Verified: remoteR2.verified,
          remoteR2Missing: remoteR2.missing,
        }
      : {}),
    d1SqlBytes: Buffer.byteLength(sql),
    d1Applied: state.d1AppliedPlanSha256 === planSha256,
  };
}

function parseArguments(arguments_: string[]): ExecutorOptions {
  let mode: ExecutorMode = "dry-run";
  let planPath = DEFAULT_PLAN;
  let statePath = DEFAULT_STATE;
  let d1SqlPath = DEFAULT_D1_SQL;
  let bucket = DEFAULT_BUCKET;
  let database = DEFAULT_DATABASE;
  let concurrency = 3;
  let confirmPlanSha256: string | undefined;
  const phaseFlags = new Set<string>();

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const next = arguments_[index + 1];
    if (["--write-d1-sql", "--verify-r2", "--upload-r2", "--apply-d1"].includes(argument)) {
      phaseFlags.add(argument);
      mode = ({
        "--write-d1-sql": "write-d1-sql",
        "--verify-r2": "verify-r2",
        "--upload-r2": "upload-r2",
        "--apply-d1": "apply-d1",
      } as Record<string, ExecutorMode>)[argument];
    } else if (argument === "--plan" && next) {
      planPath = resolve(next);
      index += 1;
    } else if (argument === "--state" && next) {
      statePath = resolve(next);
      index += 1;
    } else if (argument === "--d1-sql" && next) {
      d1SqlPath = resolve(next);
      index += 1;
    } else if (argument === "--bucket" && next) {
      bucket = next;
      index += 1;
    } else if (argument === "--database" && next) {
      database = next;
      index += 1;
    } else if (argument === "--concurrency" && next) {
      concurrency = Number(next);
      index += 1;
    } else if (argument === "--confirm-plan-sha256" && next) {
      confirmPlanSha256 = next;
      index += 1;
    } else {
      throw new AudioIntegrationExecutionError("unknown_or_incomplete_argument");
    }
  }
  if (phaseFlags.size > 1) {
    throw new AudioIntegrationExecutionError("executor_phases_are_separate");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new AudioIntegrationExecutionError("invalid_executor_concurrency");
  }
  return {
    mode,
    planPath,
    statePath,
    d1SqlPath,
    bucket,
    database,
    concurrency,
    ...(confirmPlanSha256 ? { confirmPlanSha256 } : {}),
  };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const aggregate = await runAudioIntegrationExecutor(options);
  process.stdout.write(`${JSON.stringify(aggregate, null, 2)}\n`);
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isDirectRun) {
  main().catch((error: unknown) => {
    const code = error instanceof AudioIntegrationExecutionError
      ? error.code
      : "audio_integration_executor_failed";
    process.stderr.write(`${JSON.stringify({ status: "error", error: code })}\n`);
    process.exitCode = 1;
  });
}
