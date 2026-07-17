import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import {
  type ConfirmedMapping,
  writeScanComparisonPdf,
} from "./scan-original-confirmed-pdf";

const PROJECT_ROOT = resolve(".");
const RECOVERY_ROOT = resolve("notes/private/scan-original-recovery");
const EXECUTION_ROOT = resolve(RECOVERY_ROOT, "cloud-swap");
const REPORT_PATH = resolve(RECOVERY_ROOT, "match-report.json");
const CONFIRMATION_PATH = resolve(RECOVERY_ROOT, "owner-confirmed-matches.json");
const SCAN_CORRECTIONS_PATH = resolve(RECOVERY_ROOT, "owner-scan-corrections.json");
const SOURCE_PREFERENCES_PATH = resolve(RECOVERY_ROOT, "owner-source-preference-overrides.json");
const PLAN_PATH = resolve(EXECUTION_ROOT, "plan.json");
const STATE_PATH = resolve(EXECUTION_ROOT, "state.json");
const DERIVATIVE_ROOT = resolve(EXECUTION_ROOT, "readability");
const COMPARISON_ROOT = resolve(EXECUTION_ROOT, "postflight-comparisons");
const PDF_PATH = resolve(EXECUTION_ROOT, "post-swap-verification.pdf");
const WRANGLER = resolve("node_modules/.bin/wrangler");
const DATABASE = "music-library-staging-apac";
const BUCKET = "music-library-media-staging";
const ACTOR = "migration:scan-original-recovery-v1";
const POLICY_ID = "scan-jpeg-v1-2400-q85";
const DEPLOYED_UPLOADER_URL = "https://scan-original-recovery-upload-session.musiclibrary.workers.dev";
const MAX_PIXELS = 100_000_000;
const MAX_BYTES = 20_000_000;
const SHA256 = /^[0-9a-f]{64}$/u;

type JsonObject = Record<string, unknown>;

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type CommandRunner = (
  executable: string,
  arguments_: string[],
) => Promise<CommandResult>;

type ReportCurrent = {
  token: string;
  scanId: string;
  songId: string;
  mediaId: string;
  relativePath: string;
  byteSize: number;
  sha256: string;
  width: number;
  height: number;
  format: string;
};

type ReportGenuine = {
  token: string;
  relativePath: string;
  byteSize: number;
  sha256: string;
  width: number;
  height: number;
  format: string;
};

type OwnerMapping = ConfirmedMapping & {
  proposedAction: string;
  confirmationSource: string;
  sourceTransform?: {
    preserveOriginalBytes: true;
    displayRotationDegrees: 180;
  };
};

type LiveRow = {
  scanId: string;
  songId: string;
  mediaId: string;
  scanRevision: number;
  scanTrashedAt: string | null;
  scanTrashedBy: string | null;
  scanUpdatedAt: string;
  scanUpdatedBy: string;
  sourceObjectKey: string;
  sourceFilename: string;
  sourceMimeType: string;
  sourceByteSize: number;
  sourceSha256: string;
  sourceState: string;
  sourceTrashedAt: string | null;
  sourceTrashedBy: string | null;
  derivativeObjectKey: string | null;
  derivativeMimeType: string | null;
  derivativeByteSize: number | null;
  derivativeSha256: string | null;
  derivativeWidth: number | null;
  derivativeHeight: number | null;
  derivativePolicyId: string | null;
  songRevision: number;
  songTrashedAt: string | null;
};

type DerivativeFacts = {
  localPath: string;
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
};

export type SwapReplacement = {
  currentToken: string;
  genuineToken: string;
  scanId: string;
  songId: string;
  expectedRevision: number;
  formerMediaId: string;
  formerObjectKey: string;
  formerFilename: string;
  formerMimeType: string;
  formerByteSize: number;
  formerSha256: string;
  formerDerivativeObjectKey: string;
  formerDerivativeByteSize: number;
  formerDerivativeSha256: string;
  genuineLocalPath: string;
  genuineRelativePath: string;
  genuineFilename: string;
  genuineMimeType: "image/jpeg";
  genuineByteSize: number;
  genuineSha256: string;
  genuineWidth: number;
  genuineHeight: number;
  displayRotationDegrees: 0 | 180;
  newMediaId: string;
  historyId: string;
  newObjectKey: string;
  derivativeObjectKey: string;
  derivativeLocalPath: string;
  derivativeByteSize: number;
  derivativeSha256: string;
  derivativeWidth: number;
  derivativeHeight: number;
};

export type SwapTrashAction = {
  currentToken: string;
  scanId: string;
  songId: string;
  expectedRevision: number;
  mediaId: string;
  sourceObjectKey: string;
  sourceByteSize: number;
  sourceSha256: string;
  derivativeObjectKey: string;
  derivativeByteSize: number;
  derivativeSha256: string;
};

export type ScanSwapPlan = {
  schemaVersion: 1;
  operationId: string;
  reportSha256: string;
  confirmationSha256: string;
  ownerScanCorrectionsSha256: string;
  ownerSourcePreferenceOverridesSha256: string;
  database: string;
  bucket: string;
  actor: string;
  policyId: typeof POLICY_ID;
  replacements: SwapReplacement[];
  trashActions: SwapTrashAction[];
  aggregate: {
    replacements: number;
    trashActions: number;
    sourceBytes: number;
    derivativeBytes: number;
    r2Objects: number;
  };
};

type ObjectCheckpoint = {
  objectKey: string;
  sha256: string;
  byteSize: number;
};

type SwapState = {
  schemaVersion: 1;
  planSha256: string;
  verifiedFormer: Record<string, true>;
  stagedObjects: Record<string, ObjectCheckpoint>;
  uploadedObjects: Record<string, ObjectCheckpoint>;
  d1Applied: Record<string, true>;
  postflightVerified: Record<string, true>;
};

type Mode = "prepare" | "upload-r2" | "apply-d1" | "postflight" | "pdf";

type Options = {
  mode: Mode;
  concurrency: number;
  confirmPlanSha256?: string;
  uploaderUrl?: string;
};

export class ScanSwapError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function objectValue(value: unknown, code: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ScanSwapError(code);
  }
  return value as JsonObject;
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ScanSwapError(code);
  return value;
}

function integerValue(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ScanSwapError(code);
  return Number(value);
}

function nullableString(value: unknown, code: string): string | null {
  if (value === null) return null;
  return stringValue(value, code);
}

function sha256Value(value: unknown, code: string): string {
  const result = stringValue(value, code);
  if (!SHA256.test(result)) throw new ScanSwapError(code);
  return result;
}

function isWithin(path: string, root: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  } catch {
    throw new ScanSwapError("file_hash_failed");
  }
  return hash.digest("hex");
}

async function readJson(path: string, code: string): Promise<JsonObject> {
  try {
    return objectValue(JSON.parse(await readFile(path, "utf8")), code);
  } catch (error) {
    if (error instanceof ScanSwapError) throw error;
    throw new ScanSwapError(code);
  }
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  if (!isWithin(path, resolve(PROJECT_ROOT, "notes/private"))) {
    throw new ScanSwapError("output_must_be_private");
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

async function uploadR2ViaPipe(
  objectKey: string,
  localPath: string,
): Promise<CommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(WRANGLER, [
      "r2", "object", "put", `${BUCKET}/${objectKey}`,
      "--remote", "--pipe",
      "--content-type", "image/jpeg",
      "--content-disposition", "inline",
      "--cache-control", "private, max-age=3600",
      "--force",
    ], {
      cwd: PROJECT_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    const source = createReadStream(localPath);
    source.on("error", reject);
    source.pipe(child.stdin);
    child.on("close", (code) => {
      resolvePromise({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

async function uploadR2ViaDevWorker(
  uploaderUrl: string,
  planSha256: string,
  object: UploadObject,
): Promise<CommandResult> {
  const localPath = resolve(PROJECT_ROOT, object.localPath);
  let response: Response;
  try {
    response = await fetch(`${uploaderUrl}/object`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${planSha256}`,
        "content-type": "image/jpeg",
        "x-object-key": object.objectKey,
        "x-object-sha256": object.sha256,
        "x-object-size": String(object.byteSize),
      },
      body: await readFile(localPath),
    });
  } catch {
    throw new ScanSwapError("dev_uploader_request_failed");
  }
  const body = await response.text();
  return {
    exitCode: response.ok ? 0 : 1,
    stdout: response.ok ? body : "",
    stderr: response.ok ? "" : body,
  };
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
      output[index] = await operation(values[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(limit, values.length) },
    () => worker(),
  ));
  return output;
}

function deterministicUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

async function queryD1(
  sql: string,
  runner: CommandRunner,
): Promise<JsonObject[]> {
  const result = await runner(WRANGLER, [
    "d1", "execute", DATABASE,
    "--remote", "--json", "--command", sql,
  ]);
  if (result.exitCode !== 0) throw new ScanSwapError("remote_d1_query_failed");
  try {
    const payload = JSON.parse(result.stdout) as Array<{ results?: unknown[] }>;
    if (!Array.isArray(payload) || !Array.isArray(payload[0]?.results)) {
      throw new ScanSwapError("invalid_remote_d1_response");
    }
    return payload[0].results.map((row) => objectValue(row, "invalid_remote_d1_row"));
  } catch (error) {
    if (error instanceof ScanSwapError) throw error;
    throw new ScanSwapError("invalid_remote_d1_response");
  }
}

function parseLiveRow(row: JsonObject): LiveRow {
  return {
    scanId: stringValue(row.scanId, "invalid_live_scan_id"),
    songId: stringValue(row.songId, "invalid_live_song_id"),
    mediaId: stringValue(row.mediaId, "invalid_live_media_id"),
    scanRevision: integerValue(row.scanRevision, "invalid_live_scan_revision"),
    scanTrashedAt: nullableString(row.scanTrashedAt, "invalid_live_scan_trash"),
    scanTrashedBy: nullableString(row.scanTrashedBy, "invalid_live_scan_trash"),
    scanUpdatedAt: stringValue(row.scanUpdatedAt, "invalid_live_scan_audit"),
    scanUpdatedBy: stringValue(row.scanUpdatedBy, "invalid_live_scan_audit"),
    sourceObjectKey: stringValue(row.sourceObjectKey, "invalid_live_source_key"),
    sourceFilename: stringValue(row.sourceFilename, "invalid_live_source_filename"),
    sourceMimeType: stringValue(row.sourceMimeType, "invalid_live_source_mime"),
    sourceByteSize: integerValue(row.sourceByteSize, "invalid_live_source_size"),
    sourceSha256: sha256Value(row.sourceSha256, "invalid_live_source_hash"),
    sourceState: stringValue(row.sourceState, "invalid_live_source_state"),
    sourceTrashedAt: nullableString(row.sourceTrashedAt, "invalid_live_source_trash"),
    sourceTrashedBy: nullableString(row.sourceTrashedBy, "invalid_live_source_trash"),
    derivativeObjectKey: nullableString(row.derivativeObjectKey, "invalid_live_derivative_key"),
    derivativeMimeType: nullableString(row.derivativeMimeType, "invalid_live_derivative_mime"),
    derivativeByteSize: row.derivativeByteSize === null
      ? null
      : integerValue(row.derivativeByteSize, "invalid_live_derivative_size"),
    derivativeSha256: row.derivativeSha256 === null
      ? null
      : sha256Value(row.derivativeSha256, "invalid_live_derivative_hash"),
    derivativeWidth: row.derivativeWidth === null
      ? null
      : integerValue(row.derivativeWidth, "invalid_live_derivative_dimensions"),
    derivativeHeight: row.derivativeHeight === null
      ? null
      : integerValue(row.derivativeHeight, "invalid_live_derivative_dimensions"),
    derivativePolicyId: nullableString(row.derivativePolicyId, "invalid_live_derivative_policy"),
    songRevision: integerValue(row.songRevision, "invalid_live_song_revision"),
    songTrashedAt: nullableString(row.songTrashedAt, "invalid_live_song_trash"),
  };
}

const LIVE_SCAN_SQL = `
SELECT
  scans.id AS scanId,
  scans.song_id AS songId,
  scans.media_id AS mediaId,
  scans.revision AS scanRevision,
  scans.trashed_at AS scanTrashedAt,
  scans.trashed_by AS scanTrashedBy,
  scans.updated_at AS scanUpdatedAt,
  scans.updated_by AS scanUpdatedBy,
  media_objects.object_key AS sourceObjectKey,
  media_objects.original_filename AS sourceFilename,
  media_objects.mime_type AS sourceMimeType,
  media_objects.byte_size AS sourceByteSize,
  media_objects.sha256 AS sourceSha256,
  media_objects.state AS sourceState,
  media_objects.trashed_at AS sourceTrashedAt,
  media_objects.trashed_by AS sourceTrashedBy,
  scan_readability_derivatives.object_key AS derivativeObjectKey,
  scan_readability_derivatives.mime_type AS derivativeMimeType,
  scan_readability_derivatives.byte_size AS derivativeByteSize,
  scan_readability_derivatives.sha256 AS derivativeSha256,
  scan_readability_derivatives.width AS derivativeWidth,
  scan_readability_derivatives.height AS derivativeHeight,
  scan_readability_derivatives.policy_id AS derivativePolicyId,
  songs.revision AS songRevision,
  songs.trashed_at AS songTrashedAt
FROM scans
JOIN songs ON songs.id = scans.song_id
JOIN media_objects ON media_objects.id = scans.media_id
LEFT JOIN scan_readability_derivatives
  ON scan_readability_derivatives.source_media_id = media_objects.id
ORDER BY scans.id`;

async function loadLiveRows(runner: CommandRunner): Promise<Map<string, LiveRow>> {
  const rows = (await queryD1(LIVE_SCAN_SQL, runner)).map(parseLiveRow);
  if (rows.length !== 498 || new Set(rows.map((row) => row.scanId)).size !== rows.length) {
    throw new ScanSwapError("unexpected_live_scan_inventory");
  }
  return new Map(rows.map((row) => [row.scanId, row]));
}

function requireLiveActive(row: LiveRow, current: ReportCurrent): void {
  if (
    row.scanId !== current.scanId
    || row.songId !== current.songId
    || row.mediaId !== current.mediaId
    || row.scanTrashedAt !== null
    || row.scanTrashedBy !== null
    || row.songTrashedAt !== null
    || row.sourceState !== "active"
    || row.sourceTrashedAt !== null
    || row.sourceTrashedBy !== null
    || row.sourceObjectKey !== `scans/${current.relativePath}`
    || row.sourceByteSize !== current.byteSize
    || row.sourceSha256 !== current.sha256
    || row.derivativeObjectKey !== `scans/readability/${current.mediaId}.jpg`
    || row.derivativeMimeType !== "image/jpeg"
    || row.derivativeByteSize === null
    || row.derivativeSha256 === null
    || row.derivativeWidth === null
    || row.derivativeHeight === null
    || row.derivativePolicyId !== POLICY_ID
  ) {
    throw new ScanSwapError("live_scan_drift");
  }
}

async function derivativeFacts(
  sourcePath: string,
  destination: string,
  rotation: 0 | 180,
): Promise<DerivativeFacts> {
  if (!isWithin(sourcePath, resolve(PROJECT_ROOT, "legacy/drive/Final"))) {
    throw new ScanSwapError("genuine_source_outside_read_only_root");
  }
  if (!isWithin(destination, DERIVATIVE_ROOT)) {
    throw new ScanSwapError("derivative_outside_private_root");
  }
  const sourceMetadata = await sharp(sourcePath, {
    failOn: "error",
    limitInputPixels: MAX_PIXELS,
  }).metadata();
  if (
    sourceMetadata.format !== "jpeg"
    || !sourceMetadata.width
    || !sourceMetadata.height
    || sourceMetadata.width * sourceMetadata.height > MAX_PIXELS
  ) {
    throw new ScanSwapError("invalid_genuine_source_image");
  }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.temporary`;
  try {
    let pipeline = sharp(sourcePath, {
      failOn: "error",
      limitInputPixels: MAX_PIXELS,
    }).autoOrient();
    if (rotation === 180) pipeline = pipeline.rotate(180);
    await pipeline
      .resize({
        width: 2400,
        height: 2400,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 85, progressive: false })
      .toFile(temporary);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  const [metadata, fileStats, sha256] = await Promise.all([
    sharp(destination, { failOn: "error", limitInputPixels: MAX_PIXELS }).metadata(),
    stat(destination),
    sha256File(destination),
  ]);
  if (
    metadata.format !== "jpeg"
    || !metadata.width
    || !metadata.height
    || metadata.width > 2400
    || metadata.height > 2400
    || fileStats.size < 1
    || fileStats.size > MAX_BYTES
  ) {
    throw new ScanSwapError("invalid_generated_derivative");
  }
  return {
    localPath: relative(PROJECT_ROOT, destination).split(sep).join("/"),
    sha256,
    byteSize: fileStats.size,
    width: metadata.width,
    height: metadata.height,
  };
}

async function buildPlan(
  concurrency: number,
  runner: CommandRunner,
): Promise<{ plan: ScanSwapPlan; planSha256: string }> {
  const [reportBytes, confirmationBytes, correctionBytes, preferenceBytes, liveByScan] = await Promise.all([
    readFile(REPORT_PATH),
    readFile(CONFIRMATION_PATH),
    readFile(SCAN_CORRECTIONS_PATH),
    readFile(SOURCE_PREFERENCES_PATH),
    loadLiveRows(runner),
  ]);
  const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");
  const confirmationSha256 = createHash("sha256").update(confirmationBytes).digest("hex");
  const correctionSha256 = createHash("sha256").update(correctionBytes).digest("hex");
  const preferenceSha256 = createHash("sha256").update(preferenceBytes).digest("hex");
  const report = objectValue(JSON.parse(reportBytes.toString("utf8")), "invalid_report");
  const confirmation = objectValue(
    JSON.parse(confirmationBytes.toString("utf8")),
    "invalid_confirmation",
  );
  if (
    confirmation.schemaVersion !== 1
    || confirmation.reportSha256 !== reportSha256
    || confirmation.ownerScanCorrectionsSha256 !== correctionSha256
    || confirmation.ownerSourcePreferenceOverridesSha256 !== preferenceSha256
  ) {
    throw new ScanSwapError("owner_binding_mismatch");
  }
  const counts = objectValue(confirmation.counts, "invalid_confirmation_counts");
  const rawMappings = confirmation.confirmedMappings;
  if (!Array.isArray(rawMappings) || rawMappings.length !== 446
    || counts.combinedConfirmed !== rawMappings.length) {
    throw new ScanSwapError("unexpected_confirmed_mapping_count");
  }
  const mappings = rawMappings.map((value) => {
    const row = objectValue(value, "invalid_confirmed_mapping");
    const sourceTransform = row.sourceTransform === undefined
      ? undefined
      : objectValue(row.sourceTransform, "invalid_source_transform");
    if (sourceTransform && (
      sourceTransform.preserveOriginalBytes !== true
      || sourceTransform.displayRotationDegrees !== 180
    )) {
      throw new ScanSwapError("invalid_source_transform");
    }
    return {
      currentToken: stringValue(row.currentToken, "invalid_current_token"),
      genuineToken: stringValue(row.genuineToken, "invalid_genuine_token"),
      proposedAction: stringValue(row.proposedAction, "invalid_proposed_action"),
      confirmationSource: stringValue(row.confirmationSource, "invalid_confirmation_source"),
      ...(sourceTransform
        ? { sourceTransform: { preserveOriginalBytes: true as const, displayRotationDegrees: 180 as const } }
        : {}),
    };
  });
  if (
    mappings.some((mapping) => mapping.proposedAction === "retain_current")
    || new Set(mappings.map((mapping) => mapping.currentToken)).size !== mappings.length
    || new Set(mappings.map((mapping) => mapping.genuineToken)).size !== mappings.length
  ) {
    throw new ScanSwapError("invalid_final_mapping_set");
  }
  const inventories = objectValue(report.inventories, "invalid_report_inventories");
  if (!Array.isArray(inventories.current) || !Array.isArray(inventories.genuineImages)) {
    throw new ScanSwapError("invalid_report_inventories");
  }
  const currentByToken = new Map(inventories.current.map((value) => {
    const row = objectValue(value, "invalid_report_current");
    const current: ReportCurrent = {
      token: stringValue(row.token, "invalid_report_current"),
      scanId: stringValue(row.scanId, "invalid_report_current"),
      songId: stringValue(row.songId, "invalid_report_current"),
      mediaId: stringValue(row.mediaId, "invalid_report_current"),
      relativePath: stringValue(row.relativePath, "invalid_report_current"),
      byteSize: integerValue(row.byteSize, "invalid_report_current"),
      sha256: sha256Value(row.sha256, "invalid_report_current"),
      width: integerValue(row.width, "invalid_report_current"),
      height: integerValue(row.height, "invalid_report_current"),
      format: stringValue(row.format, "invalid_report_current"),
    };
    return [current.token, current] as const;
  }));
  const genuineByToken = new Map(inventories.genuineImages.map((value) => {
    const row = objectValue(value, "invalid_report_genuine");
    const genuine: ReportGenuine = {
      token: stringValue(row.token, "invalid_report_genuine"),
      relativePath: stringValue(row.relativePath, "invalid_report_genuine"),
      byteSize: integerValue(row.byteSize, "invalid_report_genuine"),
      sha256: sha256Value(row.sha256, "invalid_report_genuine"),
      width: integerValue(row.width, "invalid_report_genuine"),
      height: integerValue(row.height, "invalid_report_genuine"),
      format: stringValue(row.format, "invalid_report_genuine"),
    };
    return [genuine.token, genuine] as const;
  }));
  const genuineHashes = mappings.map((mapping) => {
    const genuine = genuineByToken.get(mapping.genuineToken);
    if (!genuine) throw new ScanSwapError("confirmed_genuine_missing");
    return genuine.sha256;
  });
  if (new Set(genuineHashes).size !== genuineHashes.length) {
    throw new ScanSwapError("duplicate_final_genuine_hash");
  }
  const registeredHashes = new Set((await queryD1(
    "SELECT sha256 FROM scan_fingerprints ORDER BY sha256",
    runner,
  )).map((row) => sha256Value(row.sha256, "invalid_live_fingerprint")));
  if (genuineHashes.some((hash) => registeredHashes.has(hash))) {
    throw new ScanSwapError("genuine_hash_already_registered");
  }
  const operationId = `scan-original-v1-${confirmationSha256.slice(0, 12)}`;
  const replacements = await mapLimit(mappings, concurrency, async (mapping) => {
    const current = currentByToken.get(mapping.currentToken);
    const genuine = genuineByToken.get(mapping.genuineToken);
    if (!current || !genuine || current.format !== "jpeg" || genuine.format !== "jpeg") {
      throw new ScanSwapError("mapping_inventory_mismatch");
    }
    const live = liveByScan.get(current.scanId);
    if (!live) throw new ScanSwapError("live_scan_missing");
    requireLiveActive(live, current);
    const currentLocalPath = resolve(PROJECT_ROOT, "legacy/appsheet/scans", current.relativePath);
    const genuineLocalPath = resolve(PROJECT_ROOT, "legacy/drive/Final", genuine.relativePath);
    if (!isWithin(currentLocalPath, resolve(PROJECT_ROOT, "legacy/appsheet/scans"))) {
      throw new ScanSwapError("current_source_outside_read_only_root");
    }
    const [currentStats, currentHash, genuineStats, genuineHash] = await Promise.all([
      stat(currentLocalPath),
      sha256File(currentLocalPath),
      stat(genuineLocalPath),
      sha256File(genuineLocalPath),
    ]);
    if (
      currentStats.size !== current.byteSize
      || currentHash !== current.sha256
      || genuineStats.size !== genuine.byteSize
      || genuineHash !== genuine.sha256
      || genuine.byteSize > MAX_BYTES
    ) {
      throw new ScanSwapError("local_source_drift");
    }
    const newMediaId = deterministicUuid(`${operationId}\0media\0${mapping.currentToken}\0${mapping.genuineToken}`);
    const historyId = deterministicUuid(`${operationId}\0history\0${mapping.currentToken}`);
    const derivativePath = resolve(DERIVATIVE_ROOT, `${newMediaId}.jpg`);
    const rotation = mapping.sourceTransform?.displayRotationDegrees ?? 0;
    const derivative = await derivativeFacts(genuineLocalPath, derivativePath, rotation);
    return {
      currentToken: mapping.currentToken,
      genuineToken: mapping.genuineToken,
      scanId: current.scanId,
      songId: current.songId,
      expectedRevision: live.scanRevision,
      formerMediaId: current.mediaId,
      formerObjectKey: live.sourceObjectKey,
      formerFilename: live.sourceFilename,
      formerMimeType: live.sourceMimeType,
      formerByteSize: live.sourceByteSize,
      formerSha256: live.sourceSha256,
      formerDerivativeObjectKey: live.derivativeObjectKey!,
      formerDerivativeByteSize: live.derivativeByteSize!,
      formerDerivativeSha256: live.derivativeSha256!,
      genuineLocalPath: relative(PROJECT_ROOT, genuineLocalPath).split(sep).join("/"),
      genuineRelativePath: genuine.relativePath,
      genuineFilename: basename(genuine.relativePath),
      genuineMimeType: "image/jpeg" as const,
      genuineByteSize: genuine.byteSize,
      genuineSha256: genuine.sha256,
      genuineWidth: genuine.width,
      genuineHeight: genuine.height,
      displayRotationDegrees: rotation,
      newMediaId,
      historyId,
      newObjectKey: `scans/recovered/${operationId}/${newMediaId}.jpg`,
      derivativeObjectKey: `scans/readability/${newMediaId}.jpg`,
      derivativeLocalPath: derivative.localPath,
      derivativeByteSize: derivative.byteSize,
      derivativeSha256: derivative.sha256,
      derivativeWidth: derivative.width,
      derivativeHeight: derivative.height,
    } satisfies SwapReplacement;
  });
  replacements.sort((left, right) => left.currentToken.localeCompare(right.currentToken, "en"));
  const rawActions = confirmation.nonReplacementActions;
  if (!Array.isArray(rawActions) || rawActions.length !== 1) {
    throw new ScanSwapError("unexpected_nonreplacement_action_count");
  }
  const action = objectValue(rawActions[0], "invalid_nonreplacement_action");
  if (action.action !== "trash_current_scan") {
    throw new ScanSwapError("invalid_nonreplacement_action");
  }
  const actionToken = stringValue(action.currentToken, "invalid_nonreplacement_action");
  const actionCurrent = currentByToken.get(actionToken);
  if (!actionCurrent || mappings.some((mapping) => mapping.currentToken === actionToken)) {
    throw new ScanSwapError("trash_action_mapping_conflict");
  }
  const actionLive = liveByScan.get(actionCurrent.scanId);
  if (!actionLive) throw new ScanSwapError("trash_live_scan_missing");
  requireLiveActive(actionLive, actionCurrent);
  const trashActions: SwapTrashAction[] = [{
    currentToken: actionToken,
    scanId: actionCurrent.scanId,
    songId: actionCurrent.songId,
    expectedRevision: actionLive.scanRevision,
    mediaId: actionCurrent.mediaId,
    sourceObjectKey: actionLive.sourceObjectKey,
    sourceByteSize: actionLive.sourceByteSize,
    sourceSha256: actionLive.sourceSha256,
    derivativeObjectKey: actionLive.derivativeObjectKey!,
    derivativeByteSize: actionLive.derivativeByteSize!,
    derivativeSha256: actionLive.derivativeSha256!,
  }];
  const plan: ScanSwapPlan = {
    schemaVersion: 1,
    operationId,
    reportSha256,
    confirmationSha256,
    ownerScanCorrectionsSha256: correctionSha256,
    ownerSourcePreferenceOverridesSha256: preferenceSha256,
    database: DATABASE,
    bucket: BUCKET,
    actor: ACTOR,
    policyId: POLICY_ID,
    replacements,
    trashActions,
    aggregate: {
      replacements: replacements.length,
      trashActions: trashActions.length,
      sourceBytes: replacements.reduce((sum, row) => sum + row.genuineByteSize, 0),
      derivativeBytes: replacements.reduce((sum, row) => sum + row.derivativeByteSize, 0),
      r2Objects: replacements.length * 2,
    },
  };
  const planJson = `${JSON.stringify(plan, null, 2)}\n`;
  const planSha256 = createHash("sha256").update(planJson).digest("hex");
  await writeAtomic(PLAN_PATH, planJson);
  return { plan, planSha256 };
}

function parseReplacement(value: unknown): SwapReplacement {
  const row = objectValue(value, "invalid_plan_replacement");
  const rotation = integerValue(row.displayRotationDegrees, "invalid_plan_rotation");
  if (rotation !== 0 && rotation !== 180) throw new ScanSwapError("invalid_plan_rotation");
  if (row.genuineMimeType !== "image/jpeg") throw new ScanSwapError("invalid_plan_mime");
  return {
    currentToken: stringValue(row.currentToken, "invalid_plan_replacement"),
    genuineToken: stringValue(row.genuineToken, "invalid_plan_replacement"),
    scanId: stringValue(row.scanId, "invalid_plan_replacement"),
    songId: stringValue(row.songId, "invalid_plan_replacement"),
    expectedRevision: integerValue(row.expectedRevision, "invalid_plan_replacement"),
    formerMediaId: stringValue(row.formerMediaId, "invalid_plan_replacement"),
    formerObjectKey: stringValue(row.formerObjectKey, "invalid_plan_replacement"),
    formerFilename: stringValue(row.formerFilename, "invalid_plan_replacement"),
    formerMimeType: stringValue(row.formerMimeType, "invalid_plan_replacement"),
    formerByteSize: integerValue(row.formerByteSize, "invalid_plan_replacement"),
    formerSha256: sha256Value(row.formerSha256, "invalid_plan_replacement"),
    formerDerivativeObjectKey: stringValue(row.formerDerivativeObjectKey, "invalid_plan_replacement"),
    formerDerivativeByteSize: integerValue(row.formerDerivativeByteSize, "invalid_plan_replacement"),
    formerDerivativeSha256: sha256Value(row.formerDerivativeSha256, "invalid_plan_replacement"),
    genuineLocalPath: stringValue(row.genuineLocalPath, "invalid_plan_replacement"),
    genuineRelativePath: stringValue(row.genuineRelativePath, "invalid_plan_replacement"),
    genuineFilename: stringValue(row.genuineFilename, "invalid_plan_replacement"),
    genuineMimeType: "image/jpeg",
    genuineByteSize: integerValue(row.genuineByteSize, "invalid_plan_replacement"),
    genuineSha256: sha256Value(row.genuineSha256, "invalid_plan_replacement"),
    genuineWidth: integerValue(row.genuineWidth, "invalid_plan_replacement"),
    genuineHeight: integerValue(row.genuineHeight, "invalid_plan_replacement"),
    displayRotationDegrees: rotation,
    newMediaId: stringValue(row.newMediaId, "invalid_plan_replacement"),
    historyId: stringValue(row.historyId, "invalid_plan_replacement"),
    newObjectKey: stringValue(row.newObjectKey, "invalid_plan_replacement"),
    derivativeObjectKey: stringValue(row.derivativeObjectKey, "invalid_plan_replacement"),
    derivativeLocalPath: stringValue(row.derivativeLocalPath, "invalid_plan_replacement"),
    derivativeByteSize: integerValue(row.derivativeByteSize, "invalid_plan_replacement"),
    derivativeSha256: sha256Value(row.derivativeSha256, "invalid_plan_replacement"),
    derivativeWidth: integerValue(row.derivativeWidth, "invalid_plan_replacement"),
    derivativeHeight: integerValue(row.derivativeHeight, "invalid_plan_replacement"),
  };
}

function parseTrash(value: unknown): SwapTrashAction {
  const row = objectValue(value, "invalid_plan_trash");
  return {
    currentToken: stringValue(row.currentToken, "invalid_plan_trash"),
    scanId: stringValue(row.scanId, "invalid_plan_trash"),
    songId: stringValue(row.songId, "invalid_plan_trash"),
    expectedRevision: integerValue(row.expectedRevision, "invalid_plan_trash"),
    mediaId: stringValue(row.mediaId, "invalid_plan_trash"),
    sourceObjectKey: stringValue(row.sourceObjectKey, "invalid_plan_trash"),
    sourceByteSize: integerValue(row.sourceByteSize, "invalid_plan_trash"),
    sourceSha256: sha256Value(row.sourceSha256, "invalid_plan_trash"),
    derivativeObjectKey: stringValue(row.derivativeObjectKey, "invalid_plan_trash"),
    derivativeByteSize: integerValue(row.derivativeByteSize, "invalid_plan_trash"),
    derivativeSha256: sha256Value(row.derivativeSha256, "invalid_plan_trash"),
  };
}

async function loadPlan(): Promise<{ plan: ScanSwapPlan; planSha256: string }> {
  const [bytes, raw] = await Promise.all([
    readFile(PLAN_PATH),
    readJson(PLAN_PATH, "invalid_swap_plan"),
  ]);
  const planSha256 = createHash("sha256").update(bytes).digest("hex");
  if (
    raw.schemaVersion !== 1
    || raw.database !== DATABASE
    || raw.bucket !== BUCKET
    || raw.actor !== ACTOR
    || raw.policyId !== POLICY_ID
    || !Array.isArray(raw.replacements)
    || !Array.isArray(raw.trashActions)
  ) {
    throw new ScanSwapError("invalid_swap_plan");
  }
  const plan: ScanSwapPlan = {
    schemaVersion: 1,
    operationId: stringValue(raw.operationId, "invalid_swap_plan"),
    reportSha256: sha256Value(raw.reportSha256, "invalid_swap_plan"),
    confirmationSha256: sha256Value(raw.confirmationSha256, "invalid_swap_plan"),
    ownerScanCorrectionsSha256: sha256Value(raw.ownerScanCorrectionsSha256, "invalid_swap_plan"),
    ownerSourcePreferenceOverridesSha256: sha256Value(raw.ownerSourcePreferenceOverridesSha256, "invalid_swap_plan"),
    database: DATABASE,
    bucket: BUCKET,
    actor: ACTOR,
    policyId: POLICY_ID,
    replacements: raw.replacements.map(parseReplacement),
    trashActions: raw.trashActions.map(parseTrash),
    aggregate: objectValue(raw.aggregate, "invalid_swap_plan") as ScanSwapPlan["aggregate"],
  };
  if (
    plan.replacements.length !== 446
    || plan.trashActions.length !== 1
    || new Set(plan.replacements.map((row) => row.scanId)).size !== 446
    || new Set(plan.replacements.map((row) => row.genuineSha256)).size !== 446
  ) {
    throw new ScanSwapError("invalid_swap_plan_counts");
  }
  return { plan, planSha256 };
}

async function loadState(planSha256: string): Promise<SwapState> {
  let raw: JsonObject;
  try {
    raw = await readJson(STATE_PATH, "invalid_swap_state");
  } catch (error) {
    if (error instanceof ScanSwapError && error.code === "invalid_swap_state") {
      try {
        await stat(STATE_PATH);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") {
          return {
            schemaVersion: 1,
            planSha256,
            verifiedFormer: {},
            stagedObjects: {},
            uploadedObjects: {},
            d1Applied: {},
            postflightVerified: {},
          };
        }
      }
    }
    throw error;
  }
  if (raw.schemaVersion !== 1 || raw.planSha256 !== planSha256) {
    throw new ScanSwapError("swap_state_plan_mismatch");
  }
  const trueRecord = (value: unknown, code: string): Record<string, true> => {
    const record = objectValue(value, code);
    for (const item of Object.values(record)) if (item !== true) throw new ScanSwapError(code);
    return record as Record<string, true>;
  };
  const checkpointRecord = (value: unknown): Record<string, ObjectCheckpoint> => {
    const rawRecord = objectValue(value, "invalid_swap_state");
    const record: Record<string, ObjectCheckpoint> = {};
    for (const [key, item] of Object.entries(rawRecord)) {
      const row = objectValue(item, "invalid_swap_state");
      record[key] = {
        objectKey: stringValue(row.objectKey, "invalid_swap_state"),
        sha256: sha256Value(row.sha256, "invalid_swap_state"),
        byteSize: integerValue(row.byteSize, "invalid_swap_state"),
      };
    }
    return record;
  };
  const uploadedObjects = checkpointRecord(raw.uploadedObjects);
  const stagedObjects = raw.stagedObjects === undefined
    ? { ...uploadedObjects }
    : checkpointRecord(raw.stagedObjects);
  return {
    schemaVersion: 1,
    planSha256,
    verifiedFormer: trueRecord(raw.verifiedFormer, "invalid_swap_state"),
    stagedObjects,
    uploadedObjects,
    d1Applied: trueRecord(raw.d1Applied, "invalid_swap_state"),
    postflightVerified: trueRecord(raw.postflightVerified, "invalid_swap_state"),
  };
}

async function saveState(state: SwapState): Promise<void> {
  await writeAtomic(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function remoteMissing(result: CommandResult): boolean {
  return /NoSuchKey|not found|does not exist|10007/iu.test(`${result.stdout}\n${result.stderr}`);
}

async function downloadR2(
  objectKey: string,
  destination: string,
  runner: CommandRunner,
): Promise<"downloaded" | "missing"> {
  const result = await runner(WRANGLER, [
    "r2", "object", "get", `${BUCKET}/${objectKey}`,
    "--remote", "--file", destination,
  ]);
  if (result.exitCode !== 0) {
    if (remoteMissing(result)) return "missing";
    throw new ScanSwapError("remote_r2_read_failed");
  }
  return "downloaded";
}

async function downloadR2WithRetries(
  objectKey: string,
  destinationPrefix: string,
  runner: CommandRunner,
): Promise<string> {
  let lastWasMissing = false;
  for (const [attempt, delay] of [0, 1_000, 3_000].entries()) {
    if (delay > 0) {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, delay));
    }
    const destination = `${destinationPrefix}.${attempt}`;
    await rm(destination, { force: true });
    try {
      const status = await downloadR2(objectKey, destination, runner);
      if (status === "downloaded") return destination;
      lastWasMissing = true;
    } catch (error) {
      if (!(error instanceof ScanSwapError) || error.code !== "remote_r2_read_failed") throw error;
    }
  }
  throw new ScanSwapError(lastWasMissing ? "remote_r2_object_missing" : "remote_r2_read_failed");
}

async function verifyFile(
  path: string,
  byteSize: number,
  sha256: string,
): Promise<void> {
  const [fileStats, hash] = await Promise.all([stat(path), sha256File(path)]);
  if (!fileStats.isFile() || fileStats.size !== byteSize || hash !== sha256) {
    throw new ScanSwapError("r2_object_content_mismatch");
  }
}

async function verifyR2Object(
  objectKey: string,
  byteSize: number,
  sha256: string,
  temporaryRoot: string,
  runner: CommandRunner,
): Promise<void> {
  const destination = resolve(
    temporaryRoot,
    `${createHash("sha256").update(objectKey).digest("hex")}.object`,
  );
  const status = await downloadR2(objectKey, destination, runner);
  if (status !== "downloaded") throw new ScanSwapError("remote_r2_object_missing");
  await verifyFile(destination, byteSize, sha256);
}

async function verifyFormerObjects(
  plan: ScanSwapPlan,
  state: SwapState,
  concurrency: number,
  runner: CommandRunner,
): Promise<void> {
  const items = [
    ...plan.replacements.map((row) => ({
      token: row.currentToken,
      source: {
        key: row.formerObjectKey,
        byteSize: row.formerByteSize,
        sha256: row.formerSha256,
      },
      derivative: {
        key: row.formerDerivativeObjectKey,
        byteSize: row.formerDerivativeByteSize,
        sha256: row.formerDerivativeSha256,
      },
    })),
    ...plan.trashActions.map((row) => ({
      token: row.currentToken,
      source: {
        key: row.sourceObjectKey,
        byteSize: row.sourceByteSize,
        sha256: row.sourceSha256,
      },
      derivative: {
        key: row.derivativeObjectKey,
        byteSize: row.derivativeByteSize,
        sha256: row.derivativeSha256,
      },
    })),
  ].filter((item) => !state.verifiedFormer[item.token]);
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "scan-swap-former-"));
  let queue = Promise.resolve();
  try {
    await mapLimit(items, concurrency, async (item) => {
      await Promise.all([
        verifyR2Object(
          item.source.key,
          item.source.byteSize,
          item.source.sha256,
          temporaryRoot,
          runner,
        ),
        verifyR2Object(
          item.derivative.key,
          item.derivative.byteSize,
          item.derivative.sha256,
          temporaryRoot,
          runner,
        ),
      ]);
      state.verifiedFormer[item.token] = true;
      queue = queue.then(() => saveState(state));
      await queue;
    });
  } finally {
    await queue;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

type UploadObject = {
  objectKey: string;
  localPath: string;
  byteSize: number;
  sha256: string;
};

function uploadObjects(plan: ScanSwapPlan): UploadObject[] {
  return plan.replacements.flatMap((row) => [
    {
      objectKey: row.newObjectKey,
      localPath: row.genuineLocalPath,
      byteSize: row.genuineByteSize,
      sha256: row.genuineSha256,
    },
    {
      objectKey: row.derivativeObjectKey,
      localPath: row.derivativeLocalPath,
      byteSize: row.derivativeByteSize,
      sha256: row.derivativeSha256,
    },
  ]);
}

async function uploadR2(
  plan: ScanSwapPlan,
  planSha256: string,
  state: SwapState,
  concurrency: number,
  runner: CommandRunner,
  uploaderUrl?: string,
): Promise<void> {
  const objects = uploadObjects(plan);
  for (const object of objects) {
    for (const checkpoint of [
      state.stagedObjects[object.objectKey],
      state.uploadedObjects[object.objectKey],
    ]) {
      if (checkpoint && (
        checkpoint.objectKey !== object.objectKey
        || checkpoint.sha256 !== object.sha256
        || checkpoint.byteSize !== object.byteSize
      )) {
        throw new ScanSwapError("uploaded_state_mismatch");
      }
    }
    const localPath = resolve(PROJECT_ROOT, object.localPath);
    if (!isWithin(localPath, resolve(PROJECT_ROOT, "legacy/drive/Final"))
      && !isWithin(localPath, EXECUTION_ROOT)) {
      throw new ScanSwapError("upload_source_outside_approved_roots");
    }
    await verifyFile(localPath, object.byteSize, object.sha256);
  }
  const pending = objects.filter((object) => !state.stagedObjects[object.objectKey]);
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "scan-swap-upload-"));
  let queue = Promise.resolve();
  let deferredStaging = 0;
  try {
    await mapLimit(pending, concurrency, async (object) => {
      const before = resolve(
        temporaryRoot,
        `${createHash("sha256").update(object.objectKey).digest("hex")}.before`,
      );
      const existing = await downloadR2(object.objectKey, before, runner);
      if (existing === "downloaded") {
        await verifyFile(before, object.byteSize, object.sha256);
        state.uploadedObjects[object.objectKey] = {
          objectKey: object.objectKey,
          sha256: object.sha256,
          byteSize: object.byteSize,
        };
      } else {
        let result: CommandResult | undefined;
        for (const delay of [0, 1_000, 3_000]) {
          if (delay > 0) {
            await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, delay));
          }
          result = uploaderUrl
            ? await uploadR2ViaDevWorker(uploaderUrl, planSha256, object)
            : await uploadR2ViaPipe(
              object.objectKey,
              resolve(PROJECT_ROOT, object.localPath),
            );
          if (result.exitCode === 0) break;
          if (/content_mismatch|invalid_upload_contract|existing_object_mismatch/iu.test(result.stderr)) {
            throw new ScanSwapError("remote_r2_upload_content_conflict");
          }
        }
        if (!result || result.exitCode !== 0) {
          deferredStaging += 1;
          return;
        }
      }
      state.stagedObjects[object.objectKey] = {
        objectKey: object.objectKey,
        sha256: object.sha256,
        byteSize: object.byteSize,
      };
      queue = queue.then(() => saveState(state));
      await queue;
    });
    let deferredVerification = 0;
    const unverified = objects.filter((object) => !state.uploadedObjects[object.objectKey]);
    await mapLimit(unverified, concurrency, async (object) => {
      const destination = resolve(
        temporaryRoot,
        `${createHash("sha256").update(object.objectKey).digest("hex")}.independent`,
      );
      let downloaded: "downloaded" | "missing" = "missing";
      let transportFailed = false;
      for (const delay of [0, 1_000, 3_000]) {
        if (delay > 0) {
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, delay));
        }
        try {
          downloaded = await downloadR2(object.objectKey, destination, runner);
          transportFailed = false;
          break;
        } catch (error) {
          if (!(error instanceof ScanSwapError) || error.code !== "remote_r2_read_failed") throw error;
          transportFailed = true;
        }
      }
      if (transportFailed) {
        deferredVerification += 1;
        return;
      }
      if (downloaded !== "downloaded") {
        deferredVerification += 1;
        return;
      }
      await verifyFile(destination, object.byteSize, object.sha256);
      state.uploadedObjects[object.objectKey] = {
        objectKey: object.objectKey,
        sha256: object.sha256,
        byteSize: object.byteSize,
      };
      queue = queue.then(() => saveState(state));
      await queue;
    });
    if (deferredStaging > 0 || deferredVerification > 0) {
      throw new ScanSwapError("r2_upload_verification_deferred");
    }
  } finally {
    await queue;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function sqlText(value: string): string {
  if (value.includes("\0")) throw new ScanSwapError("invalid_sql_value");
  return `'${value.replaceAll("'", "''")}'`;
}

function guard(table: string, condition: string): string {
  return `INSERT INTO ${table} (ok) SELECT CASE WHEN ${condition} THEN 1 ELSE 0 END;`;
}

export function replacementSql(row: SwapReplacement): string {
  const table = `__scan_swap_guard_${row.currentToken.replaceAll("-", "_")}`;
  const scanId = sqlText(row.scanId);
  const songId = sqlText(row.songId);
  const formerId = sqlText(row.formerMediaId);
  const newId = sqlText(row.newMediaId);
  const historyId = sqlText(row.historyId);
  const actor = sqlText(ACTOR);
  const finalRevision = row.expectedRevision + 1;
  const lines = [
    "PRAGMA foreign_keys = ON;",
    `CREATE TABLE ${table} (ok INTEGER NOT NULL CHECK (ok = 1));`,
    guard(table, `(EXISTS (
      SELECT 1 FROM scans JOIN media_objects ON media_objects.id = scans.media_id
      WHERE scans.id = ${scanId} AND scans.song_id = ${songId}
        AND scans.media_id = ${formerId} AND scans.revision = ${row.expectedRevision}
        AND scans.trashed_at IS NULL
        AND media_objects.object_key = ${sqlText(row.formerObjectKey)}
        AND media_objects.sha256 = ${sqlText(row.formerSha256)}
        AND media_objects.byte_size = ${row.formerByteSize}
        AND media_objects.kind = 'scan' AND media_objects.state = 'active'
    )) OR (EXISTS (
      SELECT 1 FROM scans
      WHERE id = ${scanId} AND song_id = ${songId}
        AND media_id = ${newId} AND revision = ${finalRevision}
        AND trashed_at IS NULL
    ))`),
    guard(table, `(NOT EXISTS (
      SELECT 1 FROM media_objects
      WHERE id = ${newId} OR object_key = ${sqlText(row.newObjectKey)}
    )) OR (EXISTS (
      SELECT 1 FROM media_objects
      WHERE id = ${newId} AND object_key = ${sqlText(row.newObjectKey)}
        AND original_filename = ${sqlText(row.genuineFilename)}
        AND mime_type = 'image/jpeg' AND byte_size = ${row.genuineByteSize}
        AND sha256 = ${sqlText(row.genuineSha256)}
        AND kind = 'scan' AND state = 'active'
    ))`),
    guard(table, `NOT EXISTS (
      SELECT 1 FROM scan_fingerprints WHERE sha256 = ${sqlText(row.genuineSha256)}
    ) OR EXISTS (
      SELECT 1 FROM scan_fingerprints
      WHERE sha256 = ${sqlText(row.genuineSha256)} AND canonical_media_id = ${newId}
    )`),
    `INSERT INTO media_objects (
      id, object_key, original_filename, mime_type, byte_size, sha256,
      kind, state, created_at, created_by
    )
    SELECT ${newId}, ${sqlText(row.newObjectKey)}, ${sqlText(row.genuineFilename)},
      'image/jpeg', ${row.genuineByteSize}, ${sqlText(row.genuineSha256)},
      'scan', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${actor}
    WHERE NOT EXISTS (SELECT 1 FROM media_objects WHERE id = ${newId});`,
    `INSERT INTO scan_readability_derivatives (
      source_media_id, source_sha256, source_byte_size, object_key,
      mime_type, byte_size, sha256, width, height, policy_id,
      created_at, created_by
    )
    SELECT ${newId}, ${sqlText(row.genuineSha256)}, ${row.genuineByteSize},
      ${sqlText(row.derivativeObjectKey)}, 'image/jpeg', ${row.derivativeByteSize},
      ${sqlText(row.derivativeSha256)}, ${row.derivativeWidth}, ${row.derivativeHeight},
      ${sqlText(POLICY_ID)}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${actor}
    WHERE NOT EXISTS (
      SELECT 1 FROM scan_readability_derivatives WHERE source_media_id = ${newId}
    );`,
    `INSERT INTO scan_media_history (
      id, scan_id, media_id, replaced_at, replaced_by, revision_at_replacement
    )
    SELECT ${historyId}, id, media_id,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${actor}, revision
    FROM scans
    WHERE id = ${scanId} AND song_id = ${songId}
      AND media_id = ${formerId} AND revision = ${row.expectedRevision}
      AND trashed_at IS NULL;`,
    `UPDATE songs
    SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_by = ${actor}
    WHERE id = ${songId} AND trashed_at IS NULL
      AND EXISTS (
        SELECT 1 FROM scans
        WHERE id = ${scanId} AND song_id = songs.id
          AND media_id = ${formerId} AND revision = ${row.expectedRevision}
          AND trashed_at IS NULL
      );`,
    `UPDATE scans
    SET media_id = ${newId}, revision = revision + 1,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_by = ${actor}
    WHERE id = ${scanId} AND song_id = ${songId}
      AND media_id = ${formerId} AND revision = ${row.expectedRevision}
      AND trashed_at IS NULL
      AND EXISTS (SELECT 1 FROM songs WHERE id = ${songId} AND trashed_at IS NULL);`,
    guard(table, `EXISTS (
      SELECT 1 FROM scans
      WHERE id = ${scanId} AND song_id = ${songId}
        AND media_id = ${newId} AND revision = ${finalRevision}
        AND trashed_at IS NULL
    )`),
    guard(table, `EXISTS (
      SELECT 1 FROM scan_media_history
      WHERE id = ${historyId} AND scan_id = ${scanId}
        AND media_id = ${formerId}
        AND revision_at_replacement = ${row.expectedRevision}
        AND replaced_by = ${actor}
    )`),
    guard(table, `EXISTS (
      SELECT 1 FROM scan_readability_derivatives
      WHERE source_media_id = ${newId}
        AND source_sha256 = ${sqlText(row.genuineSha256)}
        AND source_byte_size = ${row.genuineByteSize}
        AND object_key = ${sqlText(row.derivativeObjectKey)}
        AND byte_size = ${row.derivativeByteSize}
        AND sha256 = ${sqlText(row.derivativeSha256)}
        AND width = ${row.derivativeWidth} AND height = ${row.derivativeHeight}
        AND policy_id = ${sqlText(POLICY_ID)}
    )`),
    guard(table, "NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)"),
    `DROP TABLE ${table};`,
  ];
  return `${lines.join("\n")}\n`;
}

export function trashSql(row: SwapTrashAction): string {
  const table = `__scan_swap_guard_${row.currentToken.replaceAll("-", "_")}`;
  const scanId = sqlText(row.scanId);
  const songId = sqlText(row.songId);
  const mediaId = sqlText(row.mediaId);
  const actor = sqlText(ACTOR);
  const finalRevision = row.expectedRevision + 1;
  return `${[
    "PRAGMA foreign_keys = ON;",
    `CREATE TABLE ${table} (ok INTEGER NOT NULL CHECK (ok = 1));`,
    guard(table, `(EXISTS (
      SELECT 1 FROM scans JOIN media_objects ON media_objects.id = scans.media_id
      WHERE scans.id = ${scanId} AND scans.song_id = ${songId}
        AND scans.media_id = ${mediaId} AND scans.revision = ${row.expectedRevision}
        AND scans.trashed_at IS NULL
        AND media_objects.kind = 'scan' AND media_objects.state = 'active'
        AND media_objects.object_key = ${sqlText(row.sourceObjectKey)}
        AND media_objects.byte_size = ${row.sourceByteSize}
        AND media_objects.sha256 = ${sqlText(row.sourceSha256)}
    )) OR (EXISTS (
      SELECT 1 FROM scans JOIN media_objects ON media_objects.id = scans.media_id
      WHERE scans.id = ${scanId} AND scans.song_id = ${songId}
        AND scans.media_id = ${mediaId} AND scans.revision = ${finalRevision}
        AND scans.trashed_at IS NOT NULL AND scans.trashed_by = ${actor}
        AND media_objects.state = 'trashed' AND media_objects.trashed_by = ${actor}
    ))`),
    `UPDATE songs
    SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_by = ${actor}
    WHERE id = ${songId} AND trashed_at IS NULL
      AND EXISTS (
        SELECT 1 FROM scans
        WHERE id = ${scanId} AND song_id = songs.id
          AND media_id = ${mediaId} AND revision = ${row.expectedRevision}
          AND trashed_at IS NULL
      );`,
    `UPDATE scans
    SET trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      trashed_by = ${actor}, revision = revision + 1,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_by = ${actor}
    WHERE id = ${scanId} AND song_id = ${songId}
      AND media_id = ${mediaId} AND revision = ${row.expectedRevision}
      AND trashed_at IS NULL
      AND EXISTS (SELECT 1 FROM songs WHERE id = ${songId} AND trashed_at IS NULL);`,
    `UPDATE media_objects
    SET state = 'trashed',
      trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), trashed_by = ${actor}
    WHERE id = ${mediaId} AND kind = 'scan' AND state = 'active'
      AND EXISTS (
        SELECT 1 FROM scans
        WHERE id = ${scanId} AND media_id = media_objects.id
          AND revision = ${finalRevision} AND trashed_at IS NOT NULL
          AND trashed_by = ${actor}
      );`,
    guard(table, `EXISTS (
      SELECT 1 FROM scans JOIN media_objects ON media_objects.id = scans.media_id
      WHERE scans.id = ${scanId} AND scans.song_id = ${songId}
        AND scans.media_id = ${mediaId} AND scans.revision = ${finalRevision}
        AND scans.trashed_at IS NOT NULL AND scans.trashed_by = ${actor}
        AND media_objects.state = 'trashed' AND media_objects.trashed_by = ${actor}
    )`),
    guard(table, "NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)"),
    `DROP TABLE ${table};`,
  ].join("\n")}\n`;
}

async function applyD1(
  plan: ScanSwapPlan,
  state: SwapState,
  runner: CommandRunner,
): Promise<void> {
  if (Object.keys(state.uploadedObjects).length !== plan.aggregate.r2Objects) {
    throw new ScanSwapError("r2_upload_incomplete");
  }
  const actions: Array<{ key: string; sql: string }> = [
    ...plan.replacements.map((row) => ({
      key: row.currentToken,
      sql: replacementSql(row),
    })),
    ...plan.trashActions.map((row) => ({
      key: row.currentToken,
      sql: trashSql(row),
    })),
  ];
  for (const action of actions) {
    if (state.d1Applied[action.key]) continue;
    const result = await runner(WRANGLER, [
      "d1", "execute", DATABASE,
      "--remote", "--yes", "--json", "--command", action.sql,
    ]);
    if (result.exitCode !== 0) throw new ScanSwapError("remote_d1_apply_failed");
    state.d1Applied[action.key] = true;
    await saveState(state);
  }
}

function validateFinalD1(plan: ScanSwapPlan, liveByScan: Map<string, LiveRow>): void {
  for (const row of plan.replacements) {
    const live = liveByScan.get(row.scanId);
    if (
      !live
      || live.songId !== row.songId
      || live.mediaId !== row.newMediaId
      || live.scanRevision !== row.expectedRevision + 1
      || live.scanTrashedAt !== null
      || live.sourceObjectKey !== row.newObjectKey
      || live.sourceFilename !== row.genuineFilename
      || live.sourceMimeType !== "image/jpeg"
      || live.sourceByteSize !== row.genuineByteSize
      || live.sourceSha256 !== row.genuineSha256
      || live.sourceState !== "active"
      || live.derivativeObjectKey !== row.derivativeObjectKey
      || live.derivativeMimeType !== "image/jpeg"
      || live.derivativeByteSize !== row.derivativeByteSize
      || live.derivativeSha256 !== row.derivativeSha256
      || live.derivativeWidth !== row.derivativeWidth
      || live.derivativeHeight !== row.derivativeHeight
      || live.derivativePolicyId !== POLICY_ID
    ) {
      throw new ScanSwapError("postflight_d1_replacement_mismatch");
    }
  }
  for (const row of plan.trashActions) {
    const live = liveByScan.get(row.scanId);
    if (
      !live
      || live.mediaId !== row.mediaId
      || live.scanRevision !== row.expectedRevision + 1
      || live.scanTrashedAt === null
      || live.scanTrashedBy !== ACTOR
      || live.sourceState !== "trashed"
      || live.sourceTrashedAt === null
      || live.sourceTrashedBy !== ACTOR
    ) {
      throw new ScanSwapError("postflight_d1_trash_mismatch");
    }
  }
}

async function createComparison(
  row: SwapReplacement,
  activatedDerivativePath: string,
): Promise<void> {
  const currentPath = resolve(
    PROJECT_ROOT,
    "legacy/appsheet/scans",
    basename(row.formerObjectKey),
  );
  if (!isWithin(currentPath, resolve(PROJECT_ROOT, "legacy/appsheet/scans"))) {
    throw new ScanSwapError("comparison_current_outside_root");
  }
  const panelWidth = 600;
  const panelHeight = 570;
  const headerHeight = 50;
  const [current, activated] = await Promise.all([
    sharp(currentPath, { failOn: "error", limitInputPixels: MAX_PIXELS })
      .autoOrient()
      .resize({ width: panelWidth, height: panelHeight, fit: "contain", background: "#ffffff" })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 90 })
      .toBuffer(),
    sharp(activatedDerivativePath, { failOn: "error", limitInputPixels: MAX_PIXELS })
      .resize({ width: panelWidth, height: panelHeight, fit: "contain", background: "#ffffff" })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 90 })
      .toBuffer(),
  ]);
  const header = Buffer.from(`
    <svg width="1240" height="50" xmlns="http://www.w3.org/2000/svg">
      <rect width="1240" height="50" fill="#111111"/>
      <text x="20" y="32" font-family="Arial, sans-serif" font-size="20" fill="white">${row.currentToken}  —  former current</text>
      <text x="660" y="32" font-family="Arial, sans-serif" font-size="20" fill="white">activated Drive original</text>
    </svg>`);
  await mkdir(COMPARISON_ROOT, { recursive: true });
  const destination = resolve(COMPARISON_ROOT, `${row.currentToken}.jpg`);
  const temporary = `${destination}.${process.pid}.temporary`;
  try {
    await sharp({
      create: {
        width: 1240,
        height: panelHeight + headerHeight,
        channels: 3,
        background: "#ffffff",
      },
    }).composite([
      { input: header, left: 0, top: 0 },
      { input: current, left: 0, top: headerHeight },
      { input: activated, left: 640, top: headerHeight },
    ]).jpeg({ quality: 90 }).toFile(temporary);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function postflight(
  plan: ScanSwapPlan,
  state: SwapState,
  concurrency: number,
  runner: CommandRunner,
): Promise<void> {
  if (Object.keys(state.d1Applied).length !== plan.replacements.length + plan.trashActions.length) {
    throw new ScanSwapError("d1_apply_incomplete");
  }
  const liveByScan = await loadLiveRows(runner);
  validateFinalD1(plan, liveByScan);
  const historyRows = await queryD1(`
    SELECT COUNT(*) AS count
    FROM scan_media_history
    WHERE replaced_by = ${sqlText(ACTOR)}`, runner);
  if (Number(historyRows[0]?.count) !== plan.replacements.length) {
    throw new ScanSwapError("postflight_history_count_mismatch");
  }
  const integrityRows = await queryD1(`
    SELECT
      (SELECT COUNT(*) FROM pragma_foreign_key_check) AS foreignKeyErrors,
      (SELECT COUNT(*) FROM scan_fingerprints) AS fingerprints,
      (SELECT COUNT(*) FROM scan_fingerprint_members) AS fingerprintMembers,
      (SELECT COUNT(*) FROM scan_readability_derivatives) AS derivatives,
      (SELECT COUNT(*) FROM scans WHERE trashed_at IS NOT NULL) AS trashedScans`, runner);
  if (Number(integrityRows[0]?.foreignKeyErrors) !== 0) {
    throw new ScanSwapError("postflight_foreign_key_error");
  }
  const pending = plan.replacements.filter((row) => !state.postflightVerified[row.currentToken]);
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "scan-swap-postflight-"));
  let queue = Promise.resolve();
  try {
    await mapLimit(pending, concurrency, async (row) => {
      const [sourcePath, derivativePath] = await Promise.all([
        downloadR2WithRetries(
          row.newObjectKey,
          resolve(temporaryRoot, `${row.currentToken}.source`),
          runner,
        ),
        downloadR2WithRetries(
          row.derivativeObjectKey,
          resolve(temporaryRoot, `${row.currentToken}.derivative.jpg`),
          runner,
        ),
      ]);
      await Promise.all([
        verifyFile(sourcePath, row.genuineByteSize, row.genuineSha256),
        verifyFile(derivativePath, row.derivativeByteSize, row.derivativeSha256),
      ]);
      await createComparison(row, derivativePath);
      state.postflightVerified[row.currentToken] = true;
      queue = queue.then(() => saveState(state));
      await queue;
    });
  } finally {
    await queue;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function generatePdf(plan: ScanSwapPlan, state: SwapState): Promise<{
  pages: number;
  bytes: number;
  sha256: string;
}> {
  if (Object.keys(state.postflightVerified).length !== plan.replacements.length) {
    throw new ScanSwapError("postflight_incomplete");
  }
  for (const row of plan.replacements) {
    const derivativePath = resolve(PROJECT_ROOT, row.derivativeLocalPath);
    await verifyFile(
      derivativePath,
      row.derivativeByteSize,
      row.derivativeSha256,
    );
    await createComparison(row, derivativePath);
    const comparisonPath = resolve(COMPARISON_ROOT, `${row.currentToken}.jpg`);
    const metadata = await sharp(comparisonPath, { failOn: "error" }).metadata();
    if (metadata.format !== "jpeg" || metadata.width !== 1240 || metadata.height !== 620) {
      throw new ScanSwapError("postflight_comparison_invalid");
    }
  }
  await mkdir(dirname(PDF_PATH), { recursive: true });
  const temporary = `${PDF_PATH}.${process.pid}.temporary`;
  try {
    const pages = await writeScanComparisonPdf(
      temporary,
      plan.replacements.map((row) => ({
        currentToken: row.currentToken,
        genuineToken: row.genuineToken,
      })),
      COMPARISON_ROOT,
      {
        title: "Post-swap scan-original verification",
        creator: "Music Library guarded staging recovery",
        subject: `${plan.replacements.length} activated replacements verified against staging D1 and R2`,
        label: "Post-swap comparisons",
      },
    );
    await rename(temporary, PDF_PATH);
    const [fileStats, sha256] = await Promise.all([stat(PDF_PATH), sha256File(PDF_PATH)]);
    return { pages, bytes: fileStats.size, sha256 };
  } finally {
    await rm(temporary, { force: true });
  }
}

function requireConfirmation(options: Options, planSha256: string): void {
  if (options.confirmPlanSha256 !== planSha256) {
    throw new ScanSwapError("confirmed_plan_hash_required");
  }
}

function parseArguments(arguments_: string[]): Options {
  let mode: Mode = "prepare";
  let concurrency = 3;
  let confirmPlanSha256: string | undefined;
  let uploaderUrl: string | undefined;
  const modeFlags = new Set<string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const next = arguments_[index + 1];
    if (["--prepare", "--upload-r2", "--apply-d1", "--postflight", "--pdf"].includes(argument)) {
      modeFlags.add(argument);
      mode = argument.slice(2) as Mode;
    } else if (argument === "--concurrency" && next) {
      concurrency = Number(next);
      index += 1;
    } else if (argument === "--confirm-plan-sha256" && next) {
      confirmPlanSha256 = next;
      index += 1;
    } else if (argument === "--uploader-url" && next) {
      uploaderUrl = next.replace(/\/$/u, "");
      index += 1;
    } else {
      throw new ScanSwapError("unknown_or_incomplete_argument");
    }
  }
  if (modeFlags.size > 1 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) {
    throw new ScanSwapError("invalid_executor_arguments");
  }
  if (uploaderUrl
    && uploaderUrl !== DEPLOYED_UPLOADER_URL
    && !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/u.test(uploaderUrl)) {
    throw new ScanSwapError("invalid_uploader_url");
  }
  return {
    mode,
    concurrency,
    ...(confirmPlanSha256 ? { confirmPlanSha256 } : {}),
    ...(uploaderUrl ? { uploaderUrl } : {}),
  };
}

export async function runScanSwapExecutor(
  options: Options,
  runner: CommandRunner = defaultCommandRunner,
): Promise<JsonObject> {
  let loaded: { plan: ScanSwapPlan; planSha256: string };
  if (options.mode === "prepare") {
    loaded = await buildPlan(options.concurrency, runner);
  } else {
    loaded = await loadPlan();
  }
  const { plan, planSha256 } = loaded;
  const state = await loadState(planSha256);
  if (options.mode === "prepare") {
    await verifyFormerObjects(plan, state, options.concurrency, runner);
  } else if (options.mode === "upload-r2") {
    requireConfirmation(options, planSha256);
    await uploadR2(
      plan,
      planSha256,
      state,
      options.concurrency,
      runner,
      options.uploaderUrl,
    );
  } else if (options.mode === "apply-d1") {
    requireConfirmation(options, planSha256);
    await applyD1(plan, state, runner);
  } else if (options.mode === "postflight") {
    requireConfirmation(options, planSha256);
    await postflight(plan, state, options.concurrency, runner);
  } else if (options.mode === "pdf") {
    requireConfirmation(options, planSha256);
    const pdf = await generatePdf(plan, state);
    return {
      schemaVersion: 1,
      mode: options.mode,
      planSha256,
      replacements: plan.replacements.length,
      trashActions: plan.trashActions.length,
      pdfPages: pdf.pages,
      pdfBytes: pdf.bytes,
      pdfSha256: pdf.sha256,
    };
  }
  return {
    schemaVersion: 1,
    mode: options.mode,
    planSha256,
    replacements: plan.replacements.length,
    trashActions: plan.trashActions.length,
    r2Objects: plan.aggregate.r2Objects,
    r2Bytes: plan.aggregate.sourceBytes + plan.aggregate.derivativeBytes,
    formerVerified: Object.keys(state.verifiedFormer).length,
    stagedObjects: Object.keys(state.stagedObjects).length,
    uploadedObjects: Object.keys(state.uploadedObjects).length,
    d1Applied: Object.keys(state.d1Applied).length,
    postflightVerified: Object.keys(state.postflightVerified).length,
  };
}

async function main(): Promise<void> {
  const result = await runScanSwapExecutor(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (isDirectRun) {
  main().catch((error: unknown) => {
    const code = error instanceof ScanSwapError ? error.code : "scan_swap_executor_failed";
    process.stderr.write(`${JSON.stringify({ status: "error", error: code })}\n`);
    process.exitCode = 1;
  });
}
