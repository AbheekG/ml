import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  buildScanFingerprintBackfillPlan,
  type ScanFingerprintBackfillPlan,
} from "./plan-scan-fingerprint-backfill";

const PROJECT_ROOT = resolve(".");
const DEFAULT_CATALOG = resolve("data/import-output/catalog.json");
const DEFAULT_PLAN = resolve("data/import-output/scan-fingerprint-backfill-plan.json");
const DEFAULT_DATABASE = resolve("data/local/music-library.sqlite");
const SHA256 = /^[0-9a-f]{64}$/u;

type JsonObject = Record<string, unknown>;

export type ScanFingerprintExecutorMode = "dry-run" | "apply-local";

export type ScanFingerprintExecutorOptions = {
  mode: ScanFingerprintExecutorMode;
  catalogPath: string;
  planPath: string;
  databasePath: string;
  workers: number;
  confirmPlanSha256?: string;
  projectRoot?: string;
};

export type ScanFingerprintExecutorAggregate = {
  schemaVersion: 1;
  mode: ScanFingerprintExecutorMode;
  planSha256: string;
  catalogSha256: string;
  scans: number;
  sourceBytes: number;
  alreadyApplied: number;
  pendingBackfills: number;
  appliedBackfills: number;
  duplicateHashGroups: number;
  foreignKeyProblems: number;
};

export class ScanFingerprintExecutionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function objectValue(value: unknown, code: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ScanFingerprintExecutionError(code);
  }
  return value as JsonObject;
}

function arrayValue(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) throw new ScanFingerprintExecutionError(code);
  return value;
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ScanFingerprintExecutionError(code);
  }
  return value;
}

function sha256Value(value: unknown, code: string): string {
  const hash = stringValue(value, code);
  if (!SHA256.test(hash)) throw new ScanFingerprintExecutionError(code);
  return hash;
}

function integerValue(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ScanFingerprintExecutionError(code);
  }
  return value as number;
}

function isWithin(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

function parsePlan(value: JsonObject): ScanFingerprintBackfillPlan {
  if (value.schemaVersion !== 1 || value.catalogSchemaVersion !== 2) {
    throw new ScanFingerprintExecutionError("unsupported_scan_plan_version");
  }
  const seenScans = new Set<string>();
  const seenMedia = new Set<string>();
  const updates = arrayValue(value.updates, "invalid_scan_plan_updates").map((item) => {
    const row = objectValue(item, "invalid_scan_plan_update");
    const scanId = stringValue(row.scanId, "invalid_scan_plan_scan_id");
    const mediaId = stringValue(row.mediaId, "invalid_scan_plan_media_id");
    const expectedObjectKey = stringValue(
      row.expectedObjectKey,
      "invalid_scan_plan_object_key",
    );
    if (expectedObjectKey.includes("\\") || seenScans.has(scanId) || seenMedia.has(mediaId)) {
      throw new ScanFingerprintExecutionError("invalid_scan_plan_relationship");
    }
    if (row.expectedSha256 !== null) {
      throw new ScanFingerprintExecutionError("scan_plan_not_null_backfill");
    }
    seenScans.add(scanId);
    seenMedia.add(mediaId);
    return {
      scanId,
      mediaId,
      expectedObjectKey,
      expectedSha256: null,
      sha256: sha256Value(row.sha256, "invalid_scan_plan_sha256"),
      byteSize: integerValue(row.byteSize, "invalid_scan_plan_byte_size"),
    };
  });
  for (let index = 1; index < updates.length; index += 1) {
    if (updates[index - 1].mediaId.localeCompare(updates[index].mediaId, "en") >= 0) {
      throw new ScanFingerprintExecutionError("scan_plan_updates_not_sorted");
    }
  }
  return {
    schemaVersion: 1,
    catalogSchemaVersion: 2,
    catalogSha256: sha256Value(value.catalogSha256, "invalid_scan_plan_catalog_hash"),
    updates,
  };
}

async function readPlan(path: string): Promise<{
  plan: ScanFingerprintBackfillPlan;
  sha256: string;
}> {
  try {
    const bytes = await readFile(path);
    return {
      plan: parsePlan(objectValue(JSON.parse(bytes.toString("utf8")), "invalid_scan_plan")),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (error instanceof ScanFingerprintExecutionError) throw error;
    throw new ScanFingerprintExecutionError("invalid_scan_plan");
  }
}

async function validateDatabasePath(
  path: string,
  projectRoot: string,
): Promise<string> {
  const protectedRoots = [resolve(projectRoot, "appsheet"), resolve(projectRoot, "woodchime")];
  const resolved = resolve(path);
  if (protectedRoots.some((root) => isWithin(resolved, root))) {
    throw new ScanFingerprintExecutionError("database_inside_legacy_root");
  }
  let actual: string;
  let fileStats;
  try {
    [actual, fileStats] = await Promise.all([realpath(resolved), stat(resolved)]);
  } catch {
    throw new ScanFingerprintExecutionError("local_database_unreadable");
  }
  const roots = await Promise.all([
    realpath(resolve(projectRoot, "data/local")).catch(() => resolve(projectRoot, "data/local")),
    realpath(tmpdir()).catch(() => resolve(tmpdir())),
    realpath("/tmp").catch(() => resolve("/tmp")),
  ]);
  if (!fileStats.isFile() || !roots.some((root) => isWithin(actual, root))) {
    throw new ScanFingerprintExecutionError("database_must_be_local_or_temporary");
  }
  return actual;
}

type DatabaseRow = {
  scanId: string;
  mediaId: string;
  objectKey: string;
  byteSize: number;
  sha256: string | null;
  kind: string;
  state: string;
};

function reconcileDatabase(
  databasePath: string,
  plan: ScanFingerprintBackfillPlan,
  mode: ScanFingerprintExecutorMode,
): {
  alreadyApplied: number;
  pendingBackfills: number;
  appliedBackfills: number;
  foreignKeyProblems: number;
} {
  const database = new DatabaseSync(databasePath, { readOnly: mode === "dry-run" });
  let transactionOpen = false;
  let alreadyApplied = 0;
  let pendingBackfills = 0;
  let appliedBackfills = 0;
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(mode === "apply-local" ? "BEGIN IMMEDIATE" : "BEGIN");
    transactionOpen = true;
    const select = database.prepare(`
      SELECT
        scans.id AS scanId,
        media_objects.id AS mediaId,
        media_objects.object_key AS objectKey,
        media_objects.byte_size AS byteSize,
        media_objects.sha256,
        media_objects.kind,
        media_objects.state
      FROM media_objects
      LEFT JOIN scans ON scans.media_id = media_objects.id
      WHERE media_objects.id = ?
    `);
    const update = mode === "apply-local"
      ? database.prepare("UPDATE media_objects SET sha256 = ? WHERE id = ? AND sha256 IS NULL")
      : null;

    for (const planned of plan.updates) {
      const row = select.get(planned.mediaId) as DatabaseRow | undefined;
      if (
        row === undefined
        || row.scanId !== planned.scanId
        || row.mediaId !== planned.mediaId
        || row.objectKey !== planned.expectedObjectKey
        || row.byteSize !== planned.byteSize
        || row.kind !== "scan"
        || row.state !== "active"
      ) {
        throw new ScanFingerprintExecutionError("scan_database_precondition_failed");
      }
      if (row.sha256 === planned.sha256) {
        alreadyApplied += 1;
        continue;
      }
      if (row.sha256 !== null) {
        throw new ScanFingerprintExecutionError("scan_database_hash_conflict");
      }
      pendingBackfills += 1;
      if (update !== null) {
        const result = update.run(planned.sha256, planned.mediaId);
        if (result.changes !== 1) {
          throw new ScanFingerprintExecutionError("scan_database_update_conflict");
        }
        appliedBackfills += 1;
      }
    }

    if (mode === "apply-local") {
      for (const planned of plan.updates) {
        const row = select.get(planned.mediaId) as DatabaseRow | undefined;
        if (
          row === undefined
          || row.scanId !== planned.scanId
          || row.sha256 !== planned.sha256
          || row.byteSize !== planned.byteSize
          || row.kind !== "scan"
          || row.state !== "active"
        ) {
          throw new ScanFingerprintExecutionError("scan_database_final_state_failed");
        }
      }
    }

    const foreignKeyProblems = database.prepare("PRAGMA foreign_key_check").all().length;
    if (foreignKeyProblems !== 0) {
      throw new ScanFingerprintExecutionError("scan_database_foreign_key_failure");
    }
    if (transactionOpen) {
      database.exec("COMMIT");
      transactionOpen = false;
    }
    return { alreadyApplied, pendingBackfills, appliedBackfills, foreignKeyProblems };
  } catch (error) {
    if (transactionOpen) database.exec("ROLLBACK");
    if (error instanceof ScanFingerprintExecutionError) throw error;
    throw new ScanFingerprintExecutionError("scan_database_reconciliation_failed");
  } finally {
    database.close();
  }
}

export async function executeScanFingerprintBackfill(
  options: ScanFingerprintExecutorOptions,
): Promise<ScanFingerprintExecutorAggregate> {
  const projectRoot = resolve(options.projectRoot ?? PROJECT_ROOT);
  if (!Number.isInteger(options.workers) || options.workers < 1) {
    throw new ScanFingerprintExecutionError("workers_must_be_positive");
  }
  const [{ plan, sha256: planSha256 }, databasePath] = await Promise.all([
    readPlan(resolve(options.planPath)),
    validateDatabasePath(options.databasePath, projectRoot),
  ]);
  if (options.mode === "apply-local") {
    if (options.confirmPlanSha256 === undefined) {
      throw new ScanFingerprintExecutionError("plan_confirmation_required");
    }
    if (options.confirmPlanSha256 !== planSha256) {
      throw new ScanFingerprintExecutionError("plan_confirmation_mismatch");
    }
  } else if (options.confirmPlanSha256 !== undefined) {
    throw new ScanFingerprintExecutionError("plan_confirmation_not_allowed_in_dry_run");
  }

  const current = await buildScanFingerprintBackfillPlan({
    catalogPath: resolve(options.catalogPath),
    planPath: resolve(options.planPath),
    writePlan: false,
    workers: options.workers,
    projectRoot,
  });
  if (JSON.stringify(current.plan) !== JSON.stringify(plan)) {
    throw new ScanFingerprintExecutionError("scan_plan_stale");
  }
  const database = reconcileDatabase(databasePath, plan, options.mode);
  return {
    schemaVersion: 1,
    mode: options.mode,
    planSha256,
    catalogSha256: plan.catalogSha256,
    scans: current.aggregate.scanMedia,
    sourceBytes: current.aggregate.bytes,
    alreadyApplied: database.alreadyApplied,
    pendingBackfills: database.pendingBackfills,
    appliedBackfills: database.appliedBackfills,
    duplicateHashGroups: current.aggregate.duplicateHashGroups,
    foreignKeyProblems: database.foreignKeyProblems,
  };
}

function parseArguments(arguments_: string[]): ScanFingerprintExecutorOptions {
  let mode: ScanFingerprintExecutorMode = "dry-run";
  let catalogPath = DEFAULT_CATALOG;
  let planPath = DEFAULT_PLAN;
  let databasePath = DEFAULT_DATABASE;
  let workers = 4;
  let confirmPlanSha256: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const next = arguments_[index + 1];
    if (argument === "--catalog" && next) {
      catalogPath = resolve(next);
      index += 1;
    } else if (argument === "--plan" && next) {
      planPath = resolve(next);
      index += 1;
    } else if (argument === "--database" && next) {
      databasePath = resolve(next);
      index += 1;
    } else if (argument === "--workers" && next) {
      workers = Number(next);
      index += 1;
    } else if (argument === "--apply-local") {
      mode = "apply-local";
    } else if (argument === "--confirm-plan-sha256" && next) {
      confirmPlanSha256 = next;
      index += 1;
    } else {
      throw new ScanFingerprintExecutionError("invalid_argument");
    }
  }
  return { mode, catalogPath, planPath, databasePath, workers, confirmPlanSha256 };
}

async function main(): Promise<void> {
  const aggregate = await executeScanFingerprintBackfill(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(aggregate)}\n`);
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isDirectRun) {
  void main().catch((error: unknown) => {
    const code = error instanceof ScanFingerprintExecutionError
      ? error.code
      : "scan_fingerprint_backfill_failed";
    process.stderr.write(`${JSON.stringify({ error: code })}\n`);
    process.exitCode = 1;
  });
}
