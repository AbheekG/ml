import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const PROJECT_ROOT = resolve(".");
const DEFAULT_CATALOG = resolve("data/import-output/catalog.json");
const DEFAULT_PLAN = resolve("data/import-output/scan-fingerprint-backfill-plan.json");
const SHA256 = /^[0-9a-f]{64}$/u;

type JsonObject = Record<string, unknown>;

type ScanMedia = {
  id: string;
  objectKey: string;
  byteSize: number;
  sha256: string | null;
  kind: "scan";
  state: string;
};

type Scan = { id: string; mediaId: string };

export type ScanFingerprintBackfillPlan = {
  schemaVersion: 1;
  catalogSchemaVersion: 2;
  catalogSha256: string;
  updates: Array<{
    scanId: string;
    mediaId: string;
    expectedObjectKey: string;
    expectedSha256: string | null;
    sha256: string;
    byteSize: number;
  }>;
};

export type ScanFingerprintBackfillAggregate = {
  schemaVersion: 1;
  mode: "dry-run" | "write-plan";
  scans: number;
  scanMedia: number;
  bytes: number;
  alreadyHashed: number;
  hashBackfills: number;
  duplicateHashGroups: number;
};

export type ScanFingerprintPlannerOptions = {
  catalogPath: string;
  planPath: string;
  writePlan: boolean;
  workers: number;
  projectRoot?: string;
};

export class ScanFingerprintBackfillError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function objectValue(value: unknown, code: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ScanFingerprintBackfillError(code);
  }
  return value as JsonObject;
}

function arrayValue(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) throw new ScanFingerprintBackfillError(code);
  return value;
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ScanFingerprintBackfillError(code);
  }
  return value;
}

function integerValue(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ScanFingerprintBackfillError(code);
  }
  return value as number;
}

function nullableHash(value: unknown, code: string): string | null {
  if (value === null) return null;
  const hash = stringValue(value, code);
  if (!SHA256.test(hash)) throw new ScanFingerprintBackfillError(code);
  return hash;
}

function isWithin(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

async function readCatalog(path: string): Promise<{
  catalog: JsonObject;
  sha256: string;
}> {
  try {
    const bytes = await readFile(path);
    return {
      catalog: objectValue(JSON.parse(bytes.toString("utf8")), "invalid_catalog"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (error instanceof ScanFingerprintBackfillError) throw error;
    throw new ScanFingerprintBackfillError("invalid_catalog");
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  } catch {
    throw new ScanFingerprintBackfillError("scan_file_unreadable");
  }
  return hash.digest("hex");
}

async function mapLimit<T, U>(
  values: readonly T[],
  limit: number,
  operation: (value: T) => Promise<U>,
): Promise<U[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ScanFingerprintBackfillError("workers_must_be_positive");
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
  await Promise.all(Array.from(
    { length: Math.min(limit, Math.max(1, values.length)) },
    () => worker(),
  ));
  return output;
}

function parseScanMedia(value: unknown): ScanMedia | null {
  const row = objectValue(value, "invalid_catalog_media");
  if (row.kind !== "scan") return null;
  return {
    id: stringValue(row.id, "invalid_scan_media_id"),
    objectKey: stringValue(row.objectKey, "invalid_scan_object_key"),
    byteSize: integerValue(row.byteSize, "invalid_scan_byte_size"),
    sha256: nullableHash(row.sha256, "invalid_scan_sha256"),
    kind: "scan",
    state: stringValue(row.state, "invalid_scan_media_state"),
  };
}

function parseScan(value: unknown): Scan {
  const row = objectValue(value, "invalid_catalog_scan");
  return {
    id: stringValue(row.id, "invalid_scan_id"),
    mediaId: stringValue(row.mediaId, "invalid_scan_media_reference"),
  };
}

function duplicateGroupCount(values: string[]): number {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.values()].filter((count) => count > 1).length;
}

export async function buildScanFingerprintBackfillPlan(
  options: ScanFingerprintPlannerOptions,
): Promise<{
  plan: ScanFingerprintBackfillPlan;
  aggregate: ScanFingerprintBackfillAggregate;
}> {
  const projectRoot = resolve(options.projectRoot ?? PROJECT_ROOT);
  const catalogPath = resolve(options.catalogPath);
  const legacyRoot = resolve(projectRoot, "appsheet");
  const [{ catalog, sha256: catalogSha256 }, legacyRootReal] = await Promise.all([
    readCatalog(catalogPath),
    realpath(legacyRoot).catch(() => {
      throw new ScanFingerprintBackfillError("legacy_root_unreadable");
    }),
  ]);
  if (catalog.schemaVersion !== 2) {
    throw new ScanFingerprintBackfillError("unsupported_catalog_version");
  }

  const media = arrayValue(catalog.mediaObjects, "catalog_media_required")
    .map(parseScanMedia)
    .filter((row): row is ScanMedia => row !== null);
  const scans = arrayValue(catalog.scans, "catalog_scans_required").map(parseScan);
  const mediaById = new Map(media.map((row) => [row.id, row]));
  if (mediaById.size !== media.length) {
    throw new ScanFingerprintBackfillError("duplicate_scan_media_id");
  }
  const scanByMediaId = new Map<string, Scan>();
  for (const scan of scans) {
    if (!mediaById.has(scan.mediaId)) {
      throw new ScanFingerprintBackfillError("scan_media_missing");
    }
    if (scanByMediaId.has(scan.mediaId)) {
      throw new ScanFingerprintBackfillError("scan_media_reused");
    }
    scanByMediaId.set(scan.mediaId, scan);
  }
  if (scanByMediaId.size !== media.length) {
    throw new ScanFingerprintBackfillError("unreferenced_scan_media");
  }

  const hashed = await mapLimit(media, options.workers, async (row) => {
    if (row.state !== "active") {
      throw new ScanFingerprintBackfillError("scan_media_not_active");
    }
    if (row.objectKey.includes("\\")) {
      throw new ScanFingerprintBackfillError("unsafe_scan_object_key");
    }
    const candidatePath = resolve(legacyRoot, row.objectKey);
    if (candidatePath === legacyRoot || !isWithin(candidatePath, legacyRoot)) {
      throw new ScanFingerprintBackfillError("unsafe_scan_object_key");
    }
    let path: string;
    try {
      path = await realpath(candidatePath);
    } catch {
      throw new ScanFingerprintBackfillError("scan_file_unreadable");
    }
    if (path === legacyRootReal || !isWithin(path, legacyRootReal)) {
      throw new ScanFingerprintBackfillError("unsafe_scan_object_key");
    }
    let fileStats;
    try {
      fileStats = await stat(path);
    } catch {
      throw new ScanFingerprintBackfillError("scan_file_unreadable");
    }
    if (!fileStats.isFile()) throw new ScanFingerprintBackfillError("scan_path_not_file");
    if (fileStats.size !== row.byteSize) {
      throw new ScanFingerprintBackfillError("scan_byte_size_changed");
    }
    const sha256 = await sha256File(path);
    if (row.sha256 !== null && row.sha256 !== sha256) {
      throw new ScanFingerprintBackfillError("existing_scan_hash_mismatch");
    }
    return { row, sha256 };
  });

  const updates = hashed
    .filter(({ row }) => row.sha256 === null)
    .map(({ row, sha256 }) => ({
      scanId: scanByMediaId.get(row.id)!.id,
      mediaId: row.id,
      expectedObjectKey: row.objectKey,
      expectedSha256: row.sha256,
      sha256,
      byteSize: row.byteSize,
    }))
    .sort((left, right) => left.mediaId.localeCompare(right.mediaId, "en"));
  const plan: ScanFingerprintBackfillPlan = {
    schemaVersion: 1,
    catalogSchemaVersion: 2,
    catalogSha256,
    updates,
  };
  const aggregate: ScanFingerprintBackfillAggregate = {
    schemaVersion: 1,
    mode: options.writePlan ? "write-plan" : "dry-run",
    scans: scans.length,
    scanMedia: media.length,
    bytes: media.reduce((total, row) => total + row.byteSize, 0),
    alreadyHashed: media.length - updates.length,
    hashBackfills: updates.length,
    duplicateHashGroups: duplicateGroupCount(hashed.map(({ sha256 }) => sha256)),
  };
  return { plan, aggregate };
}

export async function writeScanFingerprintPlanAtomic(
  path: string,
  plan: ScanFingerprintBackfillPlan,
  projectRoot: string,
): Promise<void> {
  const resolved = resolve(path);
  const privateRoots = [
    resolve(projectRoot, "data/import-output"),
    resolve(projectRoot, "notes/private"),
  ];
  const protectedRoots = [resolve(projectRoot, "appsheet"), resolve(projectRoot, "woodchime")];
  if (!privateRoots.some((root) => isWithin(resolved, root))) {
    throw new ScanFingerprintBackfillError("plan_output_must_be_private");
  }
  if (protectedRoots.some((root) => isWithin(resolved, root))) {
    throw new ScanFingerprintBackfillError("plan_output_inside_legacy_root");
  }
  await mkdir(dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.temporary`;
  try {
    await writeFile(temporary, `${JSON.stringify(plan, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, resolved);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseArguments(arguments_: string[]): ScanFingerprintPlannerOptions {
  let catalogPath = DEFAULT_CATALOG;
  let planPath = DEFAULT_PLAN;
  let workers = 4;
  let writePlan = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const next = arguments_[index + 1];
    if (argument === "--catalog" && next) {
      catalogPath = resolve(next);
      index += 1;
    } else if (argument === "--plan" && next) {
      planPath = resolve(next);
      index += 1;
    } else if (argument === "--workers" && next) {
      workers = Number(next);
      index += 1;
    } else if (argument === "--write-plan") {
      writePlan = true;
    } else {
      throw new ScanFingerprintBackfillError("invalid_argument");
    }
  }
  return { catalogPath, planPath, workers, writePlan };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const result = await buildScanFingerprintBackfillPlan(options);
  if (options.writePlan) {
    await writeScanFingerprintPlanAtomic(options.planPath, result.plan, PROJECT_ROOT);
  }
  process.stdout.write(`${JSON.stringify(result.aggregate)}\n`);
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isDirectRun) {
  void main().catch((error: unknown) => {
    const code = error instanceof ScanFingerprintBackfillError
      ? error.code
      : "scan_fingerprint_backfill_failed";
    process.stderr.write(`${JSON.stringify({ error: code })}\n`);
    process.exitCode = 1;
  });
}
