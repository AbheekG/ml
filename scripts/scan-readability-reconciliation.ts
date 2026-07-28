import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import {
  SCAN_IMAGE_MAX_PIXELS,
  SCAN_OPTIONAL_CANDIDATE_MIN_SOURCE_BYTES,
  scanCandidateHasMaterialSavings,
  scanJpegIsDirectlyUsable,
} from "../worker/scan-readability";

const PROJECT_ROOT = resolve(".");
const PRIVATE_ROOT = resolve("notes/private/scan-readability-reconciliation");
const CACHE_ROOT = resolve(PRIVATE_ROOT, "r2-cache");
const PLAN_PATH = resolve(PRIVATE_ROOT, "plan.json");
const APPLY_SQL_PATH = resolve(PRIVATE_ROOT, "apply-d1.sql");
const STATE_PATH = resolve(PRIVATE_ROOT, "state.json");
const RECOVERY_PLAN_PATH = resolve(
  "notes/private/scan-original-recovery/cloud-swap/plan.json",
);
const WRANGLER = resolve("node_modules/.bin/wrangler");
const DATABASE = "music-library-staging-apac";
const BUCKET = "music-library-media-staging";
const RECOVERY_ACTOR = "migration:scan-original-recovery-v1";
const RECONCILIATION_ACTOR = "migration:scan-readability-policy-v2";
const DERIVATIVE_POLICY = "scan-jpeg-v1-2400-q85";
const SELECTION_POLICY = "scan-readability-selection-v2";
const EXPECTED_CURRENT_SCANS = 499;
const EXPECTED_RECOVERY_HISTORIES = 446;
const EXPECTED_PRESERVED_HISTORIES = 1;
const SHA256 = /^[0-9a-f]{64}$/u;

type JsonObject = Record<string, unknown>;

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (
  executable: string,
  arguments_: string[],
) => Promise<CommandResult>;

export type CurrentScanRow = {
  scanId: string;
  mediaId: string;
  sourceObjectKey: string;
  sourceMimeType: "image/jpeg" | "image/png" | "image/webp";
  sourceByteSize: number;
  sourceSha256: string;
  derivativeObjectKey: string;
  derivativeByteSize: number;
  derivativeSha256: string;
  derivativeWidth: number;
  derivativeHeight: number;
  derivativePolicyId: string;
  selectionPolicyId: string | null;
};

export type RecoveryHistoryRow = {
  historyId: string;
  scanId: string;
  mediaId: string;
  replacedBy: string;
  sourceObjectKey: string;
  sourceByteSize: number;
  sourceSha256: string;
  derivativeObjectKey: string;
  derivativeByteSize: number;
  derivativeSha256: string;
};

export type ReadabilityDecision = {
  sourceMediaId: string;
  sourceSha256: string;
  sourceByteSize: number;
  sourceWidth: number;
  sourceHeight: number;
  representationKind: "source" | "derivative";
  selectionBasis:
    | "direct_safe_source"
    | "required_normalization"
    | "optional_material_savings";
  candidateByteSize: number | null;
  derivativeObjectKey: string;
};

export type RecoveryDelete = {
  historyId: string;
  scanId: string;
  mediaId: string;
  sourceObjectKey: string;
  derivativeObjectKey: string;
};

export type ReconciliationPlan = {
  schemaVersion: 1;
  database: typeof DATABASE;
  bucket: typeof BUCKET;
  recoveryActor: typeof RECOVERY_ACTOR;
  reconciliationActor: typeof RECONCILIATION_ACTOR;
  derivativePolicy: typeof DERIVATIVE_POLICY;
  selectionPolicy: typeof SELECTION_POLICY;
  recoveryPlanSha256: string;
  inventoryDigest: string;
  createdAt: string;
  decisions: ReadabilityDecision[];
  recoveryDeletes: RecoveryDelete[];
  r2DeleteKeys: string[];
  aggregate: {
    currentScans: number;
    directSources: number;
    requiredDerivatives: number;
    materialDerivatives: number;
    recoveryHistoriesDeleted: number;
    preservedHistories: number;
    d1DerivativeRowsDeleted: number;
    r2ObjectsDeleted: number;
  };
};

type RecoveryPlanReplacement = {
  historyId: string;
  scanId: string;
  formerMediaId: string;
  formerObjectKey: string;
  formerByteSize: number;
  formerSha256: string;
  formerDerivativeObjectKey: string;
  formerDerivativeByteSize: number;
  formerDerivativeSha256: string;
};

type ReconciliationState = {
  schemaVersion: 1;
  planSha256: string;
  d1Applied: boolean;
  deletedR2Keys: string[];
};

type Mode = "plan" | "apply-d1" | "delete-r2" | "postflight";

type Options = {
  mode: Mode;
  concurrency: number;
  confirmPlanSha256?: string;
};

export class ScanReconciliationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function objectValue(value: unknown, code: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ScanReconciliationError(code);
  }
  return value as JsonObject;
}

function arrayValue(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) throw new ScanReconciliationError(code);
  return value;
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ScanReconciliationError(code);
  }
  return value;
}

function nullableString(value: unknown, code: string): string | null {
  return value === null ? null : stringValue(value, code);
}

function integerValue(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ScanReconciliationError(code);
  }
  return Number(value);
}

function sha256Value(value: unknown, code: string): string {
  const result = stringValue(value, code);
  if (!SHA256.test(result)) throw new ScanReconciliationError(code);
  return result;
}

function isWithin(path: string, root: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Bytes(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function writePrivateAtomic(path: string, contents: string): Promise<void> {
  if (!isWithin(path, PRIVATE_ROOT)) {
    throw new ScanReconciliationError("output_must_be_private");
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.temporary`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
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

async function mapLimit<T, U>(
  values: readonly T[],
  limit: number,
  operation: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const output = new Array<U>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next;
      next += 1;
      output[index] = await operation(values[index]!, index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(limit, values.length) },
    () => worker(),
  ));
  return output;
}

async function queryD1(sql: string, runner: CommandRunner): Promise<JsonObject[]> {
  const result = await runner(WRANGLER, [
    "d1", "execute", DATABASE,
    "--remote", "--json", "--command", sql,
  ]);
  if (result.exitCode !== 0) throw new ScanReconciliationError("remote_d1_query_failed");
  try {
    const payload = JSON.parse(result.stdout) as Array<{ results?: unknown[] }>;
    if (!Array.isArray(payload) || !Array.isArray(payload[0]?.results)) {
      throw new ScanReconciliationError("invalid_remote_d1_response");
    }
    return payload[0].results.map((row) => objectValue(row, "invalid_remote_d1_row"));
  } catch (error) {
    if (error instanceof ScanReconciliationError) throw error;
    throw new ScanReconciliationError("invalid_remote_d1_response");
  }
}

const CURRENT_SCAN_SQL = `
SELECT
  scans.id AS scanId,
  media_objects.id AS mediaId,
  media_objects.object_key AS sourceObjectKey,
  media_objects.mime_type AS sourceMimeType,
  media_objects.byte_size AS sourceByteSize,
  media_objects.sha256 AS sourceSha256,
  scan_readability_derivatives.object_key AS derivativeObjectKey,
  scan_readability_derivatives.byte_size AS derivativeByteSize,
  scan_readability_derivatives.sha256 AS derivativeSha256,
  scan_readability_derivatives.width AS derivativeWidth,
  scan_readability_derivatives.height AS derivativeHeight,
  scan_readability_derivatives.policy_id AS derivativePolicyId,
  scan_readability_selections.policy_id AS selectionPolicyId
FROM scans
JOIN media_objects ON media_objects.id = scans.media_id
LEFT JOIN scan_readability_derivatives
  ON scan_readability_derivatives.source_media_id = media_objects.id
LEFT JOIN scan_readability_selections
  ON scan_readability_selections.source_media_id = media_objects.id
ORDER BY scans.id`;

const RECOVERY_HISTORY_SQL = `
SELECT
  scan_media_history.id AS historyId,
  scan_media_history.scan_id AS scanId,
  scan_media_history.media_id AS mediaId,
  scan_media_history.replaced_by AS replacedBy,
  media_objects.object_key AS sourceObjectKey,
  media_objects.byte_size AS sourceByteSize,
  media_objects.sha256 AS sourceSha256,
  scan_readability_derivatives.object_key AS derivativeObjectKey,
  scan_readability_derivatives.byte_size AS derivativeByteSize,
  scan_readability_derivatives.sha256 AS derivativeSha256
FROM scan_media_history
JOIN media_objects ON media_objects.id = scan_media_history.media_id
LEFT JOIN scan_readability_derivatives
  ON scan_readability_derivatives.source_media_id = media_objects.id
WHERE scan_media_history.replaced_by = '${RECOVERY_ACTOR}'
ORDER BY scan_media_history.id`;

function parseCurrentScan(row: JsonObject): CurrentScanRow {
  const sourceMimeType = stringValue(row.sourceMimeType, "invalid_source_mime");
  if (
    sourceMimeType !== "image/jpeg"
    && sourceMimeType !== "image/png"
    && sourceMimeType !== "image/webp"
  ) {
    throw new ScanReconciliationError("invalid_source_mime");
  }
  return {
    scanId: stringValue(row.scanId, "invalid_scan_id"),
    mediaId: stringValue(row.mediaId, "invalid_media_id"),
    sourceObjectKey: stringValue(row.sourceObjectKey, "invalid_source_key"),
    sourceMimeType,
    sourceByteSize: integerValue(row.sourceByteSize, "invalid_source_size"),
    sourceSha256: sha256Value(row.sourceSha256, "invalid_source_hash"),
    derivativeObjectKey: stringValue(row.derivativeObjectKey, "missing_current_derivative"),
    derivativeByteSize: integerValue(row.derivativeByteSize, "invalid_derivative_size"),
    derivativeSha256: sha256Value(row.derivativeSha256, "invalid_derivative_hash"),
    derivativeWidth: integerValue(row.derivativeWidth, "invalid_derivative_dimensions"),
    derivativeHeight: integerValue(row.derivativeHeight, "invalid_derivative_dimensions"),
    derivativePolicyId: stringValue(row.derivativePolicyId, "invalid_derivative_policy"),
    selectionPolicyId: nullableString(row.selectionPolicyId, "invalid_selection_policy"),
  };
}

function parseRecoveryHistory(row: JsonObject): RecoveryHistoryRow {
  return {
    historyId: stringValue(row.historyId, "invalid_history_id"),
    scanId: stringValue(row.scanId, "invalid_history_scan_id"),
    mediaId: stringValue(row.mediaId, "invalid_history_media_id"),
    replacedBy: stringValue(row.replacedBy, "invalid_history_actor"),
    sourceObjectKey: stringValue(row.sourceObjectKey, "invalid_history_source_key"),
    sourceByteSize: integerValue(row.sourceByteSize, "invalid_history_source_size"),
    sourceSha256: sha256Value(row.sourceSha256, "invalid_history_source_hash"),
    derivativeObjectKey: stringValue(
      row.derivativeObjectKey,
      "missing_history_derivative",
    ),
    derivativeByteSize: integerValue(
      row.derivativeByteSize,
      "invalid_history_derivative_size",
    ),
    derivativeSha256: sha256Value(
      row.derivativeSha256,
      "invalid_history_derivative_hash",
    ),
  };
}

function parseRecoveryReplacement(value: unknown): RecoveryPlanReplacement {
  const row = objectValue(value, "invalid_recovery_replacement");
  return {
    historyId: stringValue(row.historyId, "invalid_recovery_history_id"),
    scanId: stringValue(row.scanId, "invalid_recovery_scan_id"),
    formerMediaId: stringValue(row.formerMediaId, "invalid_recovery_media_id"),
    formerObjectKey: stringValue(row.formerObjectKey, "invalid_recovery_source_key"),
    formerByteSize: integerValue(row.formerByteSize, "invalid_recovery_source_size"),
    formerSha256: sha256Value(row.formerSha256, "invalid_recovery_source_hash"),
    formerDerivativeObjectKey: stringValue(
      row.formerDerivativeObjectKey,
      "invalid_recovery_derivative_key",
    ),
    formerDerivativeByteSize: integerValue(
      row.formerDerivativeByteSize,
      "invalid_recovery_derivative_size",
    ),
    formerDerivativeSha256: sha256Value(
      row.formerDerivativeSha256,
      "invalid_recovery_derivative_hash",
    ),
  };
}

export function assertAcceptedScope(
  currentRows: CurrentScanRow[],
  recoveryRows: RecoveryHistoryRow[],
  recoveryReplacements: RecoveryPlanReplacement[],
  preservedHistoryCount: number,
): void {
  if (
    currentRows.length !== EXPECTED_CURRENT_SCANS
    || new Set(currentRows.map((row) => row.scanId)).size !== EXPECTED_CURRENT_SCANS
    || new Set(currentRows.map((row) => row.mediaId)).size !== EXPECTED_CURRENT_SCANS
    || currentRows.some((row) => (
      row.selectionPolicyId !== null
      || row.derivativePolicyId !== DERIVATIVE_POLICY
      || row.derivativeObjectKey !== `scans/readability/${row.mediaId}.jpg`
    ))
    || recoveryRows.length !== EXPECTED_RECOVERY_HISTORIES
    || recoveryReplacements.length !== EXPECTED_RECOVERY_HISTORIES
    || preservedHistoryCount !== EXPECTED_PRESERVED_HISTORIES
  ) {
    throw new ScanReconciliationError("accepted_scope_mismatch");
  }
  const expected = new Map(recoveryReplacements.map((row) => [row.historyId, row]));
  if (expected.size !== EXPECTED_RECOVERY_HISTORIES) {
    throw new ScanReconciliationError("accepted_scope_mismatch");
  }
  const currentMedia = new Set(currentRows.map((row) => row.mediaId));
  for (const row of recoveryRows) {
    const match = expected.get(row.historyId);
    if (
      !match
      || row.replacedBy !== RECOVERY_ACTOR
      || row.scanId !== match.scanId
      || row.mediaId !== match.formerMediaId
      || row.sourceObjectKey !== match.formerObjectKey
      || row.sourceByteSize !== match.formerByteSize
      || row.sourceSha256 !== match.formerSha256
      || row.derivativeObjectKey !== match.formerDerivativeObjectKey
      || row.derivativeByteSize !== match.formerDerivativeByteSize
      || row.derivativeSha256 !== match.formerDerivativeSha256
      || currentMedia.has(row.mediaId)
    ) {
      throw new ScanReconciliationError("accepted_scope_mismatch");
    }
  }
}

function remoteMissing(result: CommandResult): boolean {
  return /NoSuchKey|not found|does not exist|10007/iu.test(
    `${result.stdout}\n${result.stderr}`,
  );
}

async function downloadR2(
  objectKey: string,
  destination: string,
  runner: CommandRunner,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.temporary`;
  await rm(temporary, { force: true });
  const result = await runner(WRANGLER, [
    "r2", "object", "get", `${BUCKET}/${objectKey}`,
    "--remote", "--file", temporary,
  ]);
  if (result.exitCode !== 0) {
    await rm(temporary, { force: true });
    throw new ScanReconciliationError(
      remoteMissing(result) ? "remote_r2_object_missing" : "remote_r2_read_failed",
    );
  }
  await rename(temporary, destination);
}

async function cachedVerifiedObject(
  identity: string,
  objectKey: string,
  byteSize: number,
  sha256: string,
  runner: CommandRunner,
): Promise<string> {
  const path = resolve(CACHE_ROOT, `${identity}-${sha256}`);
  if (!isWithin(path, CACHE_ROOT)) throw new ScanReconciliationError("invalid_cache_path");
  const verify = async (): Promise<boolean> => {
    try {
      const [facts, hash] = await Promise.all([stat(path), sha256File(path)]);
      return facts.isFile() && facts.size === byteSize && hash === sha256;
    } catch {
      return false;
    }
  };
  if (await verify()) return path;
  await rm(path, { force: true });
  await downloadR2(objectKey, path, runner);
  if (!(await verify())) throw new ScanReconciliationError("remote_r2_fixity_mismatch");
  return path;
}

async function fullyDecodedImage(
  path: string,
): Promise<{ bytes: Uint8Array; format: string; width: number; height: number }> {
  const bytes = new Uint8Array(await readFile(path));
  let metadata: sharp.Metadata;
  try {
    const image = sharp(bytes, { failOn: "error", limitInputPixels: SCAN_IMAGE_MAX_PIXELS });
    metadata = await image.metadata();
    await image.stats();
  } catch {
    throw new ScanReconciliationError("image_decode_failed");
  }
  if (
    !metadata.format
    || !metadata.width
    || !metadata.height
    || metadata.width * metadata.height > SCAN_IMAGE_MAX_PIXELS
  ) {
    throw new ScanReconciliationError("image_dimensions_invalid");
  }
  return {
    bytes,
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
  };
}

export function decideExistingReadability(
  row: CurrentScanRow,
  source: { bytes: Uint8Array; format: string; width: number; height: number },
  derivative: { bytes: Uint8Array; format: string; width: number; height: number },
): ReadabilityDecision {
  const expectedSourceFormat = row.sourceMimeType.slice("image/".length);
  if (
    source.format !== expectedSourceFormat
    || source.bytes.byteLength !== row.sourceByteSize
    || derivative.format !== "jpeg"
    || derivative.bytes.byteLength !== row.derivativeByteSize
    || derivative.width !== row.derivativeWidth
    || derivative.height !== row.derivativeHeight
    || derivative.width > 2400
    || derivative.height > 2400
    || !scanJpegIsDirectlyUsable(derivative.bytes, derivative)
  ) {
    throw new ScanReconciliationError("representation_facts_mismatch");
  }
  const directlyUsable = row.sourceMimeType === "image/jpeg"
    && source.width <= 2400
    && source.height <= 2400
    && scanJpegIsDirectlyUsable(source.bytes, source);
  const base = {
    sourceMediaId: row.mediaId,
    sourceSha256: row.sourceSha256,
    sourceByteSize: row.sourceByteSize,
    sourceWidth: source.width,
    sourceHeight: source.height,
    derivativeObjectKey: row.derivativeObjectKey,
  } as const;
  if (!directlyUsable) {
    return {
      ...base,
      representationKind: "derivative",
      selectionBasis: "required_normalization",
      candidateByteSize: row.derivativeByteSize,
    };
  }
  if (
    row.sourceByteSize >= SCAN_OPTIONAL_CANDIDATE_MIN_SOURCE_BYTES
    && scanCandidateHasMaterialSavings(row.sourceByteSize, row.derivativeByteSize)
  ) {
    return {
      ...base,
      representationKind: "derivative",
      selectionBasis: "optional_material_savings",
      candidateByteSize: row.derivativeByteSize,
    };
  }
  return {
    ...base,
    representationKind: "source",
    selectionBasis: "direct_safe_source",
    candidateByteSize: row.sourceByteSize < SCAN_OPTIONAL_CANDIDATE_MIN_SOURCE_BYTES
      ? null
      : row.derivativeByteSize,
  };
}

async function inventory(
  runner: CommandRunner,
): Promise<{
  currentRows: CurrentScanRow[];
  recoveryRows: RecoveryHistoryRow[];
  preservedHistoryCount: number;
}> {
  const [currentRaw, recoveryRaw, historyCounts] = await Promise.all([
    queryD1(CURRENT_SCAN_SQL, runner),
    queryD1(RECOVERY_HISTORY_SQL, runner),
    queryD1(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN replaced_by = '${RECOVERY_ACTOR}' THEN 1 ELSE 0 END) AS recovery
      FROM scan_media_history
    `, runner),
  ]);
  const total = integerValue(historyCounts[0]?.total, "invalid_history_count");
  const recovery = integerValue(historyCounts[0]?.recovery, "invalid_history_count");
  return {
    currentRows: currentRaw.map(parseCurrentScan),
    recoveryRows: recoveryRaw.map(parseRecoveryHistory),
    preservedHistoryCount: total - recovery,
  };
}

async function readRecoveryPlan(): Promise<{
  sha256: string;
  replacements: RecoveryPlanReplacement[];
}> {
  const bytes = await readFile(RECOVERY_PLAN_PATH);
  const value = objectValue(JSON.parse(bytes.toString("utf8")), "invalid_recovery_plan");
  if (
    value.schemaVersion !== 1
    || value.database !== DATABASE
    || value.bucket !== BUCKET
    || value.actor !== RECOVERY_ACTOR
  ) {
    throw new ScanReconciliationError("invalid_recovery_plan");
  }
  return {
    sha256: sha256Bytes(bytes),
    replacements: arrayValue(value.replacements, "invalid_recovery_plan")
      .map(parseRecoveryReplacement),
  };
}

async function createPlan(
  options: Options,
  runner: CommandRunner,
): Promise<{ plan: ReconciliationPlan; sha256: string }> {
  const [live, recoveryPlan] = await Promise.all([inventory(runner), readRecoveryPlan()]);
  assertAcceptedScope(
    live.currentRows,
    live.recoveryRows,
    recoveryPlan.replacements,
    live.preservedHistoryCount,
  );
  await mkdir(PRIVATE_ROOT, { recursive: true });
  const storage = await statfs(PRIVATE_ROOT);
  const requiredCacheBytes = [
    ...live.currentRows.flatMap((row) => [row.sourceByteSize, row.derivativeByteSize]),
    ...live.recoveryRows.flatMap((row) => [row.sourceByteSize, row.derivativeByteSize]),
  ].reduce((sum, value) => sum + value, 0);
  if (
    !Number.isSafeInteger(requiredCacheBytes)
    || storage.bavail * storage.bsize < requiredCacheBytes + (512 * 1024 * 1024)
  ) {
    throw new ScanReconciliationError("insufficient_private_cache_space");
  }
  const decisions = await mapLimit(
    live.currentRows,
    options.concurrency,
    async (row, index) => {
      const [sourcePath, derivativePath] = await Promise.all([
        cachedVerifiedObject(
          `${index.toString().padStart(4, "0")}-source`,
          row.sourceObjectKey,
          row.sourceByteSize,
          row.sourceSha256,
          runner,
        ),
        cachedVerifiedObject(
          `${index.toString().padStart(4, "0")}-derivative`,
          row.derivativeObjectKey,
          row.derivativeByteSize,
          row.derivativeSha256,
          runner,
        ),
      ]);
      const [source, derivative] = await Promise.all([
        fullyDecodedImage(sourcePath),
        fullyDecodedImage(derivativePath),
      ]);
      return decideExistingReadability(row, source, derivative);
    },
  );
  await mapLimit(live.recoveryRows, options.concurrency, async (row, index) => {
    await Promise.all([
      cachedVerifiedObject(
        `${index.toString().padStart(4, "0")}-history-source`,
        row.sourceObjectKey,
        row.sourceByteSize,
        row.sourceSha256,
        runner,
      ),
      cachedVerifiedObject(
        `${index.toString().padStart(4, "0")}-history-derivative`,
        row.derivativeObjectKey,
        row.derivativeByteSize,
        row.derivativeSha256,
        runner,
      ),
    ]);
  });
  decisions.sort((left, right) => left.sourceMediaId.localeCompare(right.sourceMediaId));
  const recoveryDeletes = live.recoveryRows.map((row) => ({
    historyId: row.historyId,
    scanId: row.scanId,
    mediaId: row.mediaId,
    sourceObjectKey: row.sourceObjectKey,
    derivativeObjectKey: row.derivativeObjectKey,
  })).sort((left, right) => left.historyId.localeCompare(right.historyId));
  const directDerivativeKeys = decisions
    .filter((decision) => decision.representationKind === "source")
    .map((decision) => decision.derivativeObjectKey);
  const r2DeleteKeys = [
    ...recoveryDeletes.flatMap((row) => [row.sourceObjectKey, row.derivativeObjectKey]),
    ...directDerivativeKeys,
  ].sort();
  if (new Set(r2DeleteKeys).size !== r2DeleteKeys.length) {
    throw new ScanReconciliationError("duplicate_delete_key");
  }
  const inventoryDigest = sha256Bytes(stableJson({
    current: live.currentRows,
    recovery: live.recoveryRows,
    preservedHistoryCount: live.preservedHistoryCount,
  }));
  const createdAt = new Date().toISOString();
  const plan: ReconciliationPlan = {
    schemaVersion: 1,
    database: DATABASE,
    bucket: BUCKET,
    recoveryActor: RECOVERY_ACTOR,
    reconciliationActor: RECONCILIATION_ACTOR,
    derivativePolicy: DERIVATIVE_POLICY,
    selectionPolicy: SELECTION_POLICY,
    recoveryPlanSha256: recoveryPlan.sha256,
    inventoryDigest,
    createdAt,
    decisions,
    recoveryDeletes,
    r2DeleteKeys,
    aggregate: {
      currentScans: decisions.length,
      directSources: decisions.filter((row) => row.representationKind === "source").length,
      requiredDerivatives: decisions.filter(
        (row) => row.selectionBasis === "required_normalization",
      ).length,
      materialDerivatives: decisions.filter(
        (row) => row.selectionBasis === "optional_material_savings",
      ).length,
      recoveryHistoriesDeleted: recoveryDeletes.length,
      preservedHistories: live.preservedHistoryCount,
      d1DerivativeRowsDeleted: recoveryDeletes.length + directDerivativeKeys.length,
      r2ObjectsDeleted: r2DeleteKeys.length,
    },
  };
  const json = `${JSON.stringify(plan, null, 2)}\n`;
  await writePrivateAtomic(PLAN_PATH, json);
  return { plan, sha256: sha256Bytes(json) };
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function inList(values: string[]): string {
  if (values.length === 0) return "(NULL)";
  return `(${values.map(sqlString).join(",")})`;
}

export function buildReconciliationSql(plan: ReconciliationPlan): string {
  if (
    plan.decisions.length !== EXPECTED_CURRENT_SCANS
    || plan.recoveryDeletes.length !== EXPECTED_RECOVERY_HISTORIES
    || plan.aggregate.preservedHistories !== EXPECTED_PRESERVED_HISTORIES
  ) {
    throw new ScanReconciliationError("plan_scope_mismatch");
  }
  const directMediaIds = plan.decisions
    .filter((row) => row.representationKind === "source")
    .map((row) => row.sourceMediaId);
  const recoveryMediaIds = plan.recoveryDeletes.map((row) => row.mediaId);
  const recoveryHistoryIds = plan.recoveryDeletes.map((row) => row.historyId);
  const derivativeDeleteIds = [...recoveryMediaIds, ...directMediaIds];
  const selectionValues = plan.decisions.map((row) => `(
    ${sqlString(row.sourceMediaId)},
    ${sqlString(row.sourceSha256)},
    ${row.sourceByteSize},
    ${row.sourceWidth},
    ${row.sourceHeight},
    ${sqlString(row.representationKind)},
    ${sqlString(row.selectionBasis)},
    ${row.candidateByteSize ?? "NULL"},
    ${sqlString(SELECTION_POLICY)},
    ${sqlString(plan.createdAt)},
    ${sqlString(RECONCILIATION_ACTOR)}
  )`).join(",\n");
  return `PRAGMA foreign_keys = ON;
BEGIN TRANSACTION;

CREATE TABLE scan_readability_reconciliation_guard (
  value INTEGER NOT NULL CHECK (value = 1)
);

INSERT INTO scan_readability_reconciliation_guard
SELECT CASE WHEN
  (SELECT COUNT(*) FROM scans) = ${EXPECTED_CURRENT_SCANS}
  AND (SELECT COUNT(*) FROM scan_readability_selections) = 0
  AND (
    SELECT COUNT(*) FROM scan_media_history
    WHERE replaced_by = ${sqlString(RECOVERY_ACTOR)}
  ) = ${EXPECTED_RECOVERY_HISTORIES}
  AND (SELECT COUNT(*) FROM scan_media_history) = ${
  EXPECTED_RECOVERY_HISTORIES + EXPECTED_PRESERVED_HISTORIES
}
  AND (
    SELECT COUNT(*) FROM media_objects
    WHERE id IN ${inList(recoveryMediaIds)}
  ) = ${EXPECTED_RECOVERY_HISTORIES}
THEN 1 ELSE 0 END;

DROP TRIGGER prevent_scan_media_history_delete;

DELETE FROM scan_readability_derivatives
WHERE source_media_id IN ${inList(derivativeDeleteIds)};
INSERT INTO scan_readability_reconciliation_guard
SELECT CASE WHEN changes() = ${derivativeDeleteIds.length} THEN 1 ELSE 0 END;

DELETE FROM scan_media_history
WHERE id IN ${inList(recoveryHistoryIds)}
  AND replaced_by = ${sqlString(RECOVERY_ACTOR)};
INSERT INTO scan_readability_reconciliation_guard
SELECT CASE WHEN changes() = ${EXPECTED_RECOVERY_HISTORIES} THEN 1 ELSE 0 END;

DELETE FROM media_objects
WHERE id IN ${inList(recoveryMediaIds)};
INSERT INTO scan_readability_reconciliation_guard
SELECT CASE WHEN changes() = ${EXPECTED_RECOVERY_HISTORIES} THEN 1 ELSE 0 END;

INSERT INTO scan_readability_selections (
  source_media_id,
  source_sha256,
  source_byte_size,
  source_width,
  source_height,
  representation_kind,
  selection_basis,
  candidate_byte_size,
  policy_id,
  created_at,
  created_by
) VALUES
${selectionValues};
INSERT INTO scan_readability_reconciliation_guard
SELECT CASE WHEN changes() = ${EXPECTED_CURRENT_SCANS} THEN 1 ELSE 0 END;

CREATE TRIGGER prevent_scan_media_history_delete
BEFORE DELETE ON scan_media_history
BEGIN
  SELECT RAISE(ABORT, 'scan_media_history_is_retained');
END;

INSERT INTO scan_readability_reconciliation_guard
SELECT CASE WHEN
  (SELECT COUNT(*) FROM scans) = ${EXPECTED_CURRENT_SCANS}
  AND (SELECT COUNT(*) FROM scan_readability_selections) = ${EXPECTED_CURRENT_SCANS}
  AND (
    SELECT COUNT(*) FROM scan_media_history
    WHERE replaced_by = ${sqlString(RECOVERY_ACTOR)}
  ) = 0
  AND (SELECT COUNT(*) FROM scan_media_history) = ${EXPECTED_PRESERVED_HISTORIES}
  AND (
    SELECT COUNT(*) FROM media_objects WHERE kind = 'scan'
  ) = ${EXPECTED_CURRENT_SCANS + EXPECTED_PRESERVED_HISTORIES}
  AND (
    SELECT COUNT(*) FROM scan_fingerprint_members
  ) = ${
  EXPECTED_CURRENT_SCANS + EXPECTED_PRESERVED_HISTORIES
}
  AND (SELECT COUNT(*) FROM pragma_foreign_key_check) = 0
THEN 1 ELSE 0 END;

DROP TABLE scan_readability_reconciliation_guard;
COMMIT;
`;
}

async function loadPlan(
  options: Options,
): Promise<{ plan: ReconciliationPlan; sha256: string }> {
  const bytes = await readFile(PLAN_PATH);
  const sha256 = sha256Bytes(bytes);
  if (!options.confirmPlanSha256 || options.confirmPlanSha256 !== sha256) {
    throw new ScanReconciliationError("plan_confirmation_mismatch");
  }
  const plan = objectValue(
    JSON.parse(bytes.toString("utf8")),
    "invalid_reconciliation_plan",
  ) as unknown as ReconciliationPlan;
  if (
    plan.schemaVersion !== 1
    || plan.database !== DATABASE
    || plan.bucket !== BUCKET
    || plan.recoveryActor !== RECOVERY_ACTOR
    || plan.reconciliationActor !== RECONCILIATION_ACTOR
    || plan.derivativePolicy !== DERIVATIVE_POLICY
    || plan.selectionPolicy !== SELECTION_POLICY
    || !Array.isArray(plan.decisions)
    || !Array.isArray(plan.recoveryDeletes)
    || !Array.isArray(plan.r2DeleteKeys)
  ) {
    throw new ScanReconciliationError("invalid_reconciliation_plan");
  }
  buildReconciliationSql(plan);
  return { plan, sha256 };
}

async function saveState(state: ReconciliationState): Promise<void> {
  await writePrivateAtomic(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

async function readState(planSha256: string): Promise<ReconciliationState> {
  try {
    const value = objectValue(
      JSON.parse(await readFile(STATE_PATH, "utf8")),
      "invalid_reconciliation_state",
    );
    if (
      value.schemaVersion !== 1
      || value.planSha256 !== planSha256
      || typeof value.d1Applied !== "boolean"
      || !Array.isArray(value.deletedR2Keys)
      || value.deletedR2Keys.some((key) => typeof key !== "string")
    ) {
      throw new ScanReconciliationError("invalid_reconciliation_state");
    }
    return value as unknown as ReconciliationState;
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return {
        schemaVersion: 1,
        planSha256,
        d1Applied: false,
        deletedR2Keys: [],
      };
    }
    throw error;
  }
}

async function assertPostD1(plan: ReconciliationPlan, runner: CommandRunner): Promise<void> {
  const rows = await queryD1(`
    SELECT
      (SELECT COUNT(*) FROM scans) AS scans,
      (SELECT COUNT(*) FROM scan_media_history) AS histories,
      (SELECT COUNT(*) FROM media_objects WHERE kind = 'scan') AS scanMedia,
      (SELECT COUNT(*) FROM scan_media_history
        WHERE replaced_by = '${RECOVERY_ACTOR}') AS recoveryHistories,
      (SELECT COUNT(*) FROM scan_readability_selections) AS selections,
      (SELECT COUNT(*) FROM scans
        LEFT JOIN scan_readability_selections
          ON scan_readability_selections.source_media_id = scans.media_id
        WHERE scan_readability_selections.source_media_id IS NULL) AS missingSelections,
      (SELECT COUNT(*) FROM scan_readability_derivatives) AS derivatives,
      (SELECT COUNT(*) FROM scan_fingerprint_members) AS fingerprintMembers,
      (SELECT COUNT(*) FROM pragma_foreign_key_check) AS foreignKeyErrors,
      (SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'trigger'
          AND name = 'prevent_scan_media_history_delete') AS retentionTriggers
  `, runner);
  const row = rows[0] ?? {};
  const keptCurrentDerivatives = plan.decisions.filter(
    (decision) => decision.representationKind === "derivative",
  ).length;
  if (
    integerValue(row.scans, "postflight_failed") !== EXPECTED_CURRENT_SCANS
    || integerValue(row.histories, "postflight_failed") !== EXPECTED_PRESERVED_HISTORIES
    || integerValue(row.scanMedia, "postflight_failed")
      !== EXPECTED_CURRENT_SCANS + EXPECTED_PRESERVED_HISTORIES
    || integerValue(row.recoveryHistories, "postflight_failed") !== 0
    || integerValue(row.selections, "postflight_failed") !== EXPECTED_CURRENT_SCANS
    || integerValue(row.missingSelections, "postflight_failed") !== 0
    || integerValue(row.derivatives, "postflight_failed") !== keptCurrentDerivatives + 1
    || integerValue(row.fingerprintMembers, "postflight_failed")
      !== EXPECTED_CURRENT_SCANS + EXPECTED_PRESERVED_HISTORIES
    || integerValue(row.foreignKeyErrors, "postflight_failed") !== 0
    || integerValue(row.retentionTriggers, "postflight_failed") !== 1
  ) {
    throw new ScanReconciliationError("postflight_failed");
  }
}

async function applyD1(
  options: Options,
  runner: CommandRunner,
): Promise<{ plan: ReconciliationPlan; sha256: string }> {
  const loaded = await loadPlan(options);
  const state = await readState(loaded.sha256);
  try {
    await assertPostD1(loaded.plan, runner);
    state.d1Applied = true;
    await saveState(state);
    return loaded;
  } catch (error) {
    if (
      !(error instanceof ScanReconciliationError)
      || error.code !== "postflight_failed"
    ) {
      throw error;
    }
  }
  const [live, recoveryPlan] = await Promise.all([inventory(runner), readRecoveryPlan()]);
  assertAcceptedScope(
    live.currentRows,
    live.recoveryRows,
    recoveryPlan.replacements,
    live.preservedHistoryCount,
  );
  const inventoryDigest = sha256Bytes(stableJson({
    current: live.currentRows,
    recovery: live.recoveryRows,
    preservedHistoryCount: live.preservedHistoryCount,
  }));
  if (
    inventoryDigest !== loaded.plan.inventoryDigest
    || recoveryPlan.sha256 !== loaded.plan.recoveryPlanSha256
  ) {
    throw new ScanReconciliationError("fresh_inventory_mismatch");
  }
  const sql = buildReconciliationSql(loaded.plan);
  await writePrivateAtomic(APPLY_SQL_PATH, sql);
  const result = await runner(WRANGLER, [
    "d1", "execute", DATABASE,
    "--remote", "--file", APPLY_SQL_PATH, "--yes",
  ]);
  if (result.exitCode !== 0) throw new ScanReconciliationError("d1_apply_failed");
  await assertPostD1(loaded.plan, runner);
  state.d1Applied = true;
  await saveState(state);
  return loaded;
}

async function deleteR2(
  options: Options,
  runner: CommandRunner,
): Promise<{ plan: ReconciliationPlan; sha256: string }> {
  const loaded = await loadPlan(options);
  await assertPostD1(loaded.plan, runner);
  const state = await readState(loaded.sha256);
  if (!state.d1Applied) throw new ScanReconciliationError("d1_not_checkpointed");
  const deleted = new Set(state.deletedR2Keys);
  const pending = loaded.plan.r2DeleteKeys.filter((key) => !deleted.has(key));
  await mapLimit(pending, options.concurrency, async (key) => {
    const result = await runner(WRANGLER, [
      "r2", "object", "delete", `${BUCKET}/${key}`, "--remote", "--force",
    ]);
    if (result.exitCode !== 0 && !remoteMissing(result)) {
      throw new ScanReconciliationError("r2_delete_failed");
    }
    deleted.add(key);
  });
  state.deletedR2Keys = [...deleted].sort();
  await saveState(state);
  return loaded;
}

async function verifyR2Deletes(
  plan: ReconciliationPlan,
  concurrency: number,
  runner: CommandRunner,
): Promise<void> {
  const probeRoot = resolve(PRIVATE_ROOT, "postflight-probes");
  await mkdir(probeRoot, { recursive: true });
  await mapLimit(plan.r2DeleteKeys, concurrency, async (key, index) => {
    const destination = resolve(probeRoot, `${index.toString().padStart(4, "0")}.probe`);
    await rm(destination, { force: true });
    const result = await runner(WRANGLER, [
      "r2", "object", "get", `${BUCKET}/${key}`,
      "--remote", "--file", destination,
    ]);
    await rm(destination, { force: true });
    if (result.exitCode === 0 || !remoteMissing(result)) {
      throw new ScanReconciliationError("r2_postflight_failed");
    }
  });
  await rm(probeRoot, { recursive: true, force: true });
}

async function postflight(
  options: Options,
  runner: CommandRunner,
): Promise<{ plan: ReconciliationPlan; sha256: string }> {
  const loaded = await loadPlan(options);
  const state = await readState(loaded.sha256);
  if (
    !state.d1Applied
    || state.deletedR2Keys.length !== loaded.plan.r2DeleteKeys.length
    || state.deletedR2Keys.some((key, index) => key !== [...loaded.plan.r2DeleteKeys].sort()[index])
  ) {
    throw new ScanReconciliationError("reconciliation_incomplete");
  }
  await assertPostD1(loaded.plan, runner);
  await verifyR2Deletes(loaded.plan, options.concurrency, runner);
  await rm(CACHE_ROOT, { recursive: true, force: true });
  return loaded;
}

function parseOptions(arguments_: string[]): Options {
  let mode: Mode | undefined;
  let concurrency = 4;
  let confirmPlanSha256: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--mode") {
      const value = arguments_[index + 1];
      if (
        value !== "plan"
        && value !== "apply-d1"
        && value !== "delete-r2"
        && value !== "postflight"
      ) {
        throw new ScanReconciliationError("invalid_mode");
      }
      mode = value;
      index += 1;
    } else if (argument === "--concurrency") {
      concurrency = Number(arguments_[index + 1]);
      index += 1;
    } else if (argument === "--confirm-plan-sha256") {
      confirmPlanSha256 = arguments_[index + 1];
      index += 1;
    } else {
      throw new ScanReconciliationError("unknown_argument");
    }
  }
  if (!mode || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new ScanReconciliationError("invalid_options");
  }
  if (confirmPlanSha256 !== undefined && !SHA256.test(confirmPlanSha256)) {
    throw new ScanReconciliationError("invalid_plan_confirmation");
  }
  return { mode, concurrency, confirmPlanSha256 };
}

async function main(
  arguments_: string[],
  runner: CommandRunner = defaultCommandRunner,
): Promise<void> {
  const options = parseOptions(arguments_);
  let result: { plan: ReconciliationPlan; sha256: string };
  if (options.mode === "plan") {
    result = await createPlan(options, runner);
  } else if (options.mode === "apply-d1") {
    result = await applyD1(options, runner);
  } else if (options.mode === "delete-r2") {
    result = await deleteR2(options, runner);
  } else {
    result = await postflight(options, runner);
  }
  process.stdout.write(`${JSON.stringify({
    mode: options.mode,
    planSha256: result.sha256,
    aggregate: result.plan.aggregate,
  }, null, 2)}\n`);
}

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (isEntrypoint) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const code = error instanceof ScanReconciliationError
      ? error.code
      : "scan_readability_reconciliation_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
