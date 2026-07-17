import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

type JsonObject = Record<string, unknown>;

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (
  executable: string,
  args: string[],
) => Promise<CommandResult>;

export type R2Observation =
  | { status: "missing" }
  | { status: "present"; byteSize: number; sha256: string };

export type ObjectObserver = (
  bucket: string,
  objectKey: string,
) => Promise<R2Observation>;

export type CleanupPlannerOptions = {
  database: string;
  bucket: string;
  graceDays: number;
};

export type CleanupCliOptions = CleanupPlannerOptions & {
  reportPath: string;
  writeReport: boolean;
};

type UploadStatus =
  | "creating"
  | "open"
  | "completing"
  | "stored"
  | "duplicate"
  | "finalized"
  | "aborted"
  | "failed";

export type UploadSession = {
  sessionId: string;
  objectKey: string;
  status: UploadStatus;
  byteSize: number;
  sha256: string | null;
  errorCode: string | null;
  updatedAt: string;
  r2UploadId: string | null;
  duplicateMediaId: string | null;
  recordingId: string | null;
  intentCount: number;
  mediaReferenceCount: number;
};

export type CleanupReason =
  | "session_not_failed"
  | "error_not_user_discarded"
  | "missing_completed_upload"
  | "missing_sha256"
  | "recording_reference_present"
  | "duplicate_reference_present"
  | "media_reference_present"
  | "missing_upload_intent"
  | "invalid_upload_intent_count"
  | "grace_period_not_elapsed"
  | "r2_object_missing"
  | "r2_byte_size_mismatch"
  | "r2_sha256_mismatch";

export type CleanupPlanItem = {
  sessionId: string;
  objectKey: string;
  status: "failed" | "aborted";
  errorCode: string | null;
  updatedAt: string;
  expectedByteSize: number;
  expectedSha256: string | null;
  intentCount: number;
  mediaReferenceCount: number;
  decision: "eligible" | "manual_review" | "already_absent";
  reasons: CleanupReason[];
  r2: R2Observation;
};

export type RecordingUploadCleanupPlan = {
  schemaVersion: 1;
  policyId: "recording-upload-object-cleanup-v1";
  capturedAt: string;
  cutoffAt: string;
  database: string;
  bucket: string;
  graceDays: number;
  totalUploadSessions: number;
  items: CleanupPlanItem[];
  planSha256: string;
};

export type RecordingUploadCleanupSummary = {
  schemaVersion: 1;
  policyId: "recording-upload-object-cleanup-v1";
  capturedAt: string;
  graceDays: number;
  totalUploadSessions: number;
  terminalSessionsInspected: number;
  r2ObjectsPresent: number;
  r2ObjectsAlreadyAbsent: number;
  eligibleObjects: number;
  eligibleBytes: number;
  manualReviewObjects: number;
  reasonCounts: Partial<Record<CleanupReason, number>>;
  reportWritten: boolean;
};

export class RecordingUploadCleanupError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const PROJECT_ROOT = resolve(".");
const WRANGLER = resolve("node_modules/.bin/wrangler");
const DEFAULT_DATABASE = "music-library-staging-apac";
const DEFAULT_BUCKET = "music-library-media-staging";
const DEFAULT_GRACE_DAYS = 30;
const MINIMUM_GRACE_DAYS = 7;
const MAXIMUM_GRACE_DAYS = 3_650;
const DEFAULT_REPORT_PATH = resolve(
  "notes/private/recording-upload-object-cleanup-plan.json",
);
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const UPLOAD_STATUSES = new Set<UploadStatus>([
  "creating",
  "open",
  "completing",
  "stored",
  "duplicate",
  "finalized",
  "aborted",
  "failed",
]);

const SNAPSHOT_SQL = `
SELECT
  'meta' AS row_type,
  NULL AS session_id,
  NULL AS object_key,
  NULL AS status,
  NULL AS byte_size,
  NULL AS sha256,
  NULL AS error_code,
  NULL AS updated_at,
  NULL AS r2_upload_id,
  NULL AS duplicate_media_id,
  NULL AS recording_id,
  NULL AS intent_count,
  NULL AS media_reference_count,
  (SELECT COUNT(*) FROM pragma_foreign_key_check) AS foreign_key_errors
UNION ALL
SELECT
  'session' AS row_type,
  sessions.id AS session_id,
  sessions.object_key,
  sessions.status,
  sessions.byte_size,
  sessions.sha256,
  sessions.error_code,
  sessions.updated_at,
  sessions.r2_upload_id,
  sessions.duplicate_media_id,
  sessions.recording_id,
  (SELECT COUNT(*) FROM recording_upload_intents WHERE session_id = sessions.id) AS intent_count,
  (SELECT COUNT(*) FROM media_objects WHERE object_key = sessions.object_key) AS media_reference_count,
  0 AS foreign_key_errors
FROM recording_upload_sessions AS sessions
ORDER BY row_type, updated_at, session_id;
`.trim();

function objectValue(value: unknown, code: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RecordingUploadCleanupError(code);
  }
  return value as JsonObject;
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RecordingUploadCleanupError(code);
  }
  return value;
}

function nullableString(value: unknown, code: string): string | null {
  if (value === null) return null;
  return stringValue(value, code);
}

function nonnegativeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RecordingUploadCleanupError(code);
  }
  return value as number;
}

function positiveInteger(value: unknown, code: string): number {
  const parsed = nonnegativeInteger(value, code);
  if (parsed === 0) throw new RecordingUploadCleanupError(code);
  return parsed;
}

function isoTimestamp(value: unknown, code: string): string {
  const timestamp = stringValue(value, code);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    throw new RecordingUploadCleanupError(code);
  }
  return timestamp;
}

function extractJsonFragment(text: string): string | null {
  for (let start = 0; start < text.length; start += 1) {
    const first = text[start];
    if (first !== "{" && first !== "[") continue;
    const stack: string[] = [first === "{" ? "}" : "]"];
    let inString = false;
    let escaping = false;
    for (let index = start + 1; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaping) escaping = false;
        else if (character === "\\") escaping = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") stack.push("}");
      else if (character === "[") stack.push("]");
      else if (character === stack[stack.length - 1]) {
        stack.pop();
        if (stack.length === 0) return text.slice(start, index + 1);
      }
    }
  }
  return null;
}

function parseJson(text: string, code: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const fragment = extractJsonFragment(text);
    if (fragment === null) throw new RecordingUploadCleanupError(code);
    try {
      return JSON.parse(fragment);
    } catch {
      throw new RecordingUploadCleanupError(code);
    }
  }
}

function parseD1Rows(stdout: string): JsonObject[] {
  const payload = parseJson(stdout, "invalid_d1_cleanup_snapshot");
  if (!Array.isArray(payload) || payload.length !== 1) {
    throw new RecordingUploadCleanupError("invalid_d1_cleanup_snapshot");
  }
  const result = objectValue(payload[0], "invalid_d1_cleanup_snapshot");
  if (result.success !== true || !Array.isArray(result.results)) {
    throw new RecordingUploadCleanupError("invalid_d1_cleanup_snapshot");
  }
  return result.results.map((row) => objectValue(row, "invalid_d1_cleanup_row"));
}

function parseSnapshot(rows: JsonObject[]): UploadSession[] {
  const metaRows = rows.filter((row) => row.row_type === "meta");
  if (metaRows.length !== 1) {
    throw new RecordingUploadCleanupError("invalid_d1_cleanup_meta");
  }
  if (nonnegativeInteger(
    metaRows[0]?.foreign_key_errors,
    "invalid_d1_foreign_key_count",
  ) !== 0) {
    throw new RecordingUploadCleanupError("d1_foreign_key_errors");
  }

  return rows.filter((row) => row.row_type === "session").map((row) => {
    const sessionId = stringValue(row.session_id, "invalid_upload_session_id");
    const objectKey = stringValue(row.object_key, "invalid_upload_object_key");
    if (objectKey !== `recordings/original/${sessionId}`) {
      throw new RecordingUploadCleanupError("invalid_upload_object_key");
    }
    const status = stringValue(row.status, "invalid_upload_status");
    if (!UPLOAD_STATUSES.has(status as UploadStatus)) {
      throw new RecordingUploadCleanupError("invalid_upload_status");
    }
    const sha256 = nullableString(row.sha256, "invalid_upload_sha256");
    if (sha256 !== null && !SHA256.test(sha256)) {
      throw new RecordingUploadCleanupError("invalid_upload_sha256");
    }
    const intentCount = nonnegativeInteger(row.intent_count, "invalid_upload_intent_count");
    if (intentCount > 1) {
      throw new RecordingUploadCleanupError("invalid_upload_intent_count");
    }
    return {
      sessionId,
      objectKey,
      status: status as UploadStatus,
      byteSize: positiveInteger(row.byte_size, "invalid_upload_byte_size"),
      sha256,
      errorCode: nullableString(row.error_code, "invalid_upload_error_code"),
      updatedAt: isoTimestamp(row.updated_at, "invalid_upload_updated_at"),
      r2UploadId: nullableString(row.r2_upload_id, "invalid_upload_r2_id"),
      duplicateMediaId: nullableString(
        row.duplicate_media_id,
        "invalid_upload_duplicate_media_id",
      ),
      recordingId: nullableString(row.recording_id, "invalid_upload_recording_id"),
      intentCount,
      mediaReferenceCount: nonnegativeInteger(
        row.media_reference_count,
        "invalid_upload_media_reference_count",
      ),
    };
  });
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function planDigest(value: Omit<RecordingUploadCleanupPlan, "planSha256">): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function reasonsFor(
  session: UploadSession,
  observation: R2Observation,
  cutoffMilliseconds: number,
): CleanupReason[] {
  const reasons: CleanupReason[] = [];
  if (session.status !== "failed") reasons.push("session_not_failed");
  if (session.errorCode !== "user_discarded") reasons.push("error_not_user_discarded");
  if (session.r2UploadId === null) reasons.push("missing_completed_upload");
  if (session.sha256 === null) reasons.push("missing_sha256");
  if (session.recordingId !== null) reasons.push("recording_reference_present");
  if (session.duplicateMediaId !== null) reasons.push("duplicate_reference_present");
  if (session.mediaReferenceCount > 0) reasons.push("media_reference_present");
  if (session.intentCount === 0) reasons.push("missing_upload_intent");
  if (session.intentCount > 1) reasons.push("invalid_upload_intent_count");
  if (Date.parse(session.updatedAt) > cutoffMilliseconds) {
    reasons.push("grace_period_not_elapsed");
  }
  if (observation.status === "missing") {
    reasons.push("r2_object_missing");
  } else {
    if (observation.byteSize !== session.byteSize) reasons.push("r2_byte_size_mismatch");
    if (session.sha256 !== null && observation.sha256 !== session.sha256) {
      reasons.push("r2_sha256_mismatch");
    }
  }
  return reasons;
}

export function classifyCleanupItem(
  session: UploadSession,
  observation: R2Observation,
  cutoffAt: string,
): CleanupPlanItem {
  const cutoffMilliseconds = Date.parse(cutoffAt);
  if (!Number.isFinite(cutoffMilliseconds)) {
    throw new RecordingUploadCleanupError("invalid_cleanup_cutoff");
  }
  if (session.status !== "failed" && session.status !== "aborted") {
    throw new RecordingUploadCleanupError("nonterminal_cleanup_session");
  }
  const reasons = reasonsFor(session, observation, cutoffMilliseconds);
  const hasReferences = session.recordingId !== null
    || session.duplicateMediaId !== null
    || session.mediaReferenceCount > 0;
  const decision = observation.status === "missing" && !hasReferences
    ? "already_absent"
    : reasons.length === 0
      ? "eligible"
      : "manual_review";
  return {
    sessionId: session.sessionId,
    objectKey: session.objectKey,
    status: session.status,
    errorCode: session.errorCode,
    updatedAt: session.updatedAt,
    expectedByteSize: session.byteSize,
    expectedSha256: session.sha256,
    intentCount: session.intentCount,
    mediaReferenceCount: session.mediaReferenceCount,
    decision,
    reasons,
    r2: observation,
  };
}

async function loadUploadSessions(
  database: string,
  runner: CommandRunner,
): Promise<UploadSession[]> {
  if (!SAFE_RESOURCE_NAME.test(database)) {
    throw new RecordingUploadCleanupError("invalid_cleanup_database");
  }
  const result = await runner(WRANGLER, [
    "d1",
    "execute",
    database,
    "--remote",
    "--json",
    "--command",
    SNAPSHOT_SQL,
  ]);
  if (result.exitCode !== 0) {
    throw new RecordingUploadCleanupError("d1_cleanup_snapshot_failed");
  }
  return parseSnapshot(parseD1Rows(result.stdout));
}

export async function buildRecordingUploadCleanupPlan(
  options: CleanupPlannerOptions,
  runner: CommandRunner,
  observer: ObjectObserver,
  now = new Date(),
): Promise<RecordingUploadCleanupPlan> {
  validatePlannerOptions(options);
  if (!Number.isFinite(now.getTime())) {
    throw new RecordingUploadCleanupError("invalid_cleanup_time");
  }
  const sessions = await loadUploadSessions(options.database, runner);
  const terminal = sessions.filter((session): session is UploadSession & {
    status: "failed" | "aborted";
  } => session.status === "failed" || session.status === "aborted");
  const capturedAt = now.toISOString();
  const cutoffAt = new Date(
    now.getTime() - (options.graceDays * 24 * 60 * 60 * 1_000),
  ).toISOString();
  const items: CleanupPlanItem[] = [];
  for (const session of terminal) {
    const observation = await observer(options.bucket, session.objectKey);
    items.push(classifyCleanupItem(session, observation, cutoffAt));
  }
  const base: Omit<RecordingUploadCleanupPlan, "planSha256"> = {
    schemaVersion: 1,
    policyId: "recording-upload-object-cleanup-v1",
    capturedAt,
    cutoffAt,
    database: options.database,
    bucket: options.bucket,
    graceDays: options.graceDays,
    totalUploadSessions: sessions.length,
    items,
  };
  return { ...base, planSha256: planDigest(base) };
}

export function summarizeRecordingUploadCleanupPlan(
  plan: RecordingUploadCleanupPlan,
  reportWritten: boolean,
): RecordingUploadCleanupSummary {
  const eligible = plan.items.filter((item) => item.decision === "eligible");
  const reasonCounts = new Map<CleanupReason, number>();
  for (const item of plan.items) {
    for (const reason of item.reasons) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
  }
  return {
    schemaVersion: 1,
    policyId: plan.policyId,
    capturedAt: plan.capturedAt,
    graceDays: plan.graceDays,
    totalUploadSessions: plan.totalUploadSessions,
    terminalSessionsInspected: plan.items.length,
    r2ObjectsPresent: plan.items.filter((item) => item.r2.status === "present").length,
    r2ObjectsAlreadyAbsent: plan.items.filter((item) => item.decision === "already_absent").length,
    eligibleObjects: eligible.length,
    eligibleBytes: eligible.reduce((total, item) => total + item.expectedByteSize, 0),
    manualReviewObjects: plan.items.filter((item) => item.decision === "manual_review").length,
    reasonCounts: Object.fromEntries(
      [...reasonCounts.entries()].sort((left, right) => left[0].localeCompare(right[0], "en")),
    ),
    reportWritten,
  };
}

function validatePlannerOptions(options: CleanupPlannerOptions): void {
  if (!SAFE_RESOURCE_NAME.test(options.database)) {
    throw new RecordingUploadCleanupError("invalid_cleanup_database");
  }
  if (!SAFE_RESOURCE_NAME.test(options.bucket)) {
    throw new RecordingUploadCleanupError("invalid_cleanup_bucket");
  }
  if (
    !Number.isSafeInteger(options.graceDays)
    || options.graceDays < MINIMUM_GRACE_DAYS
    || options.graceDays > MAXIMUM_GRACE_DAYS
  ) {
    throw new RecordingUploadCleanupError("invalid_cleanup_grace_days");
  }
}

function isWithin(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

export async function writePrivateCleanupReport(
  plan: RecordingUploadCleanupPlan,
  reportPath: string,
  projectRoot = PROJECT_ROOT,
): Promise<void> {
  const destination = resolve(reportPath);
  const allowedRoots = [
    resolve(projectRoot, "notes/private"),
    resolve(projectRoot, "data/import-output"),
  ];
  if (!allowedRoots.some((root) => isWithin(destination, root))) {
    throw new RecordingUploadCleanupError("cleanup_report_must_be_private");
  }
  if (isWithin(destination, resolve(projectRoot, "legacy"))) {
    throw new RecordingUploadCleanupError("cleanup_report_inside_legacy");
  }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.temporary`;
  try {
    await writeFile(temporary, `${JSON.stringify(plan, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function parseArguments(args: string[]): CleanupCliOptions {
  let graceDays = DEFAULT_GRACE_DAYS;
  let writeReport = false;
  let reportPath = DEFAULT_REPORT_PATH;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--write-report") {
      writeReport = true;
      continue;
    }
    if (argument === "--grace-days") {
      const value = args[index + 1];
      if (value === undefined || !/^\d+$/u.test(value)) {
        throw new RecordingUploadCleanupError("invalid_cleanup_grace_days");
      }
      graceDays = Number(value);
      index += 1;
      continue;
    }
    if (argument === "--report-path") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        throw new RecordingUploadCleanupError("missing_cleanup_report_path");
      }
      reportPath = resolve(value);
      index += 1;
      continue;
    }
    throw new RecordingUploadCleanupError("unknown_cleanup_argument");
  }
  const options = {
    database: DEFAULT_DATABASE,
    bucket: DEFAULT_BUCKET,
    graceDays,
    writeReport,
    reportPath,
  };
  validatePlannerOptions(options);
  if (!writeReport && reportPath !== DEFAULT_REPORT_PATH) {
    throw new RecordingUploadCleanupError("cleanup_report_path_without_write");
  }
  return options;
}

export const defaultCommandRunner: CommandRunner = async (executable, args) => new Promise(
  (resolvePromise, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 5_000_000) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 100_000) child.kill("SIGKILL");
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({
      exitCode: code ?? 1,
      stdout,
      stderr,
    }));
  },
);

export const defaultObjectObserver: ObjectObserver = async (bucket, objectKey) => {
  if (!SAFE_RESOURCE_NAME.test(bucket) || !/^recordings\/original\/[A-Za-z0-9._-]+$/u.test(objectKey)) {
    throw new RecordingUploadCleanupError("invalid_r2_cleanup_target");
  }
  return new Promise<R2Observation>((resolvePromise, reject) => {
    const child = spawn(WRANGLER, [
      "r2",
      "object",
      "get",
      `${bucket}/${objectKey}`,
      "--remote",
      "--pipe",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const hash = createHash("sha256");
    let byteSize = 0;
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      byteSize += chunk.length;
      hash.update(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 100_000) stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ status: "present", byteSize, sha256: hash.digest("hex") });
        return;
      }
      if (stderr.includes("The specified key does not exist.")) {
        resolvePromise({ status: "missing" });
        return;
      }
      reject(new RecordingUploadCleanupError("r2_cleanup_observation_failed"));
    });
  });
};

export async function main(
  args = process.argv.slice(2),
  runner: CommandRunner = defaultCommandRunner,
  observer: ObjectObserver = defaultObjectObserver,
): Promise<number> {
  try {
    const options = parseArguments(args);
    const plan = await buildRecordingUploadCleanupPlan(options, runner, observer);
    if (options.writeReport) {
      await writePrivateCleanupReport(plan, options.reportPath);
    }
    process.stdout.write(`${JSON.stringify(
      summarizeRecordingUploadCleanupPlan(plan, options.writeReport),
    )}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof RecordingUploadCleanupError
      ? error.code
      : "recording_upload_cleanup_unexpected";
    process.stderr.write(`${code}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
