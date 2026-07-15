import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  buildScanFingerprintBackfillPlan,
  writeScanFingerprintPlanAtomic,
} from "./plan-scan-fingerprint-backfill";
import {
  ScanFingerprintExecutionError,
  executeScanFingerprintBackfill,
} from "./scan-fingerprint-backfill-executor";

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "scan-fingerprint-executor-"));
  const legacy = resolve(root, "appsheet/scans");
  const output = resolve(root, "data/import-output");
  const databasePath = resolve(root, "catalog.sqlite");
  const catalogPath = resolve(output, "catalog.json");
  const planPath = resolve(output, "plan.json");
  await Promise.all([mkdir(legacy, { recursive: true }), mkdir(output, { recursive: true })]);
  const files = [Buffer.from("first scan"), Buffer.from("second scan")];
  await Promise.all(files.map((bytes, index) => (
    writeFile(resolve(legacy, `${index + 1}.jpg`), bytes)
  )));
  const catalog = {
    schemaVersion: 2,
    mediaObjects: files.map((bytes, index) => ({
      id: `media-${index + 1}`,
      objectKey: `scans/${index + 1}.jpg`,
      byteSize: bytes.length,
      sha256: null,
      kind: "scan",
      state: "active",
    })),
    scans: files.map((_bytes, index) => ({
      id: `scan-${index + 1}`,
      mediaId: `media-${index + 1}`,
    })),
  };
  await writeFile(catalogPath, `${JSON.stringify(catalog)}\n`);
  const planned = await buildScanFingerprintBackfillPlan({
    catalogPath,
    planPath,
    writePlan: false,
    workers: 2,
    projectRoot: root,
  });
  await writeScanFingerprintPlanAtomic(planPath, planned.plan, root);
  const planSha256 = createHash("sha256").update(await readFile(planPath)).digest("hex");

  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE media_objects (
      id TEXT PRIMARY KEY,
      object_key TEXT NOT NULL UNIQUE,
      byte_size INTEGER NOT NULL,
      sha256 TEXT,
      kind TEXT NOT NULL,
      state TEXT NOT NULL
    );
    CREATE TABLE scans (
      id TEXT PRIMARY KEY,
      media_id TEXT NOT NULL UNIQUE REFERENCES media_objects(id) ON DELETE RESTRICT
    );
  `);
  const insertMedia = database.prepare(`
    INSERT INTO media_objects (id, object_key, byte_size, sha256, kind, state)
    VALUES (?, ?, ?, NULL, 'scan', 'active')
  `);
  const insertScan = database.prepare("INSERT INTO scans (id, media_id) VALUES (?, ?)");
  for (const update of planned.plan.updates) {
    insertMedia.run(update.mediaId, update.expectedObjectKey, update.byteSize);
    insertScan.run(update.scanId, update.mediaId);
  }
  database.close();
  const options = {
    mode: "dry-run" as const,
    catalogPath,
    planPath,
    databasePath,
    workers: 2,
    projectRoot: root,
  };
  return { root, legacy, catalog, files, planned, planSha256, options };
}

function hashes(databasePath: string): Array<string | null> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare("SELECT sha256 FROM media_objects ORDER BY id").all() as Array<{
      sha256: string | null;
    }>).map((row) => row.sha256);
  } finally {
    database.close();
  }
}

describe("Scan fingerprint backfill executor", () => {
  it("previews, atomically applies, and exactly reconciles an idempotent rerun", async () => {
    const item = await fixture();
    const preview = await executeScanFingerprintBackfill(item.options);
    expect(preview).toMatchObject({
      mode: "dry-run",
      scans: 2,
      alreadyApplied: 0,
      pendingBackfills: 2,
      appliedBackfills: 0,
      foreignKeyProblems: 0,
    });
    expect(JSON.stringify(preview)).not.toContain("media-1");
    expect(JSON.stringify(preview)).not.toContain(item.root);
    expect(hashes(item.options.databasePath)).toEqual([null, null]);

    const applied = await executeScanFingerprintBackfill({
      ...item.options,
      mode: "apply-local",
      confirmPlanSha256: item.planSha256,
    });
    expect(applied).toMatchObject({
      mode: "apply-local",
      alreadyApplied: 0,
      pendingBackfills: 2,
      appliedBackfills: 2,
    });
    expect(hashes(item.options.databasePath)).toEqual(
      item.planned.plan.updates.map((update) => update.sha256),
    );

    const repeated = await executeScanFingerprintBackfill({
      ...item.options,
      mode: "apply-local",
      confirmPlanSha256: item.planSha256,
    });
    expect(repeated).toMatchObject({
      alreadyApplied: 2,
      pendingBackfills: 0,
      appliedBackfills: 0,
    });
  });

  it("requires the exact plan hash before opening an apply transaction", async () => {
    const item = await fixture();
    await expect(executeScanFingerprintBackfill({
      ...item.options,
      mode: "apply-local",
    })).rejects.toEqual(expect.objectContaining({ code: "plan_confirmation_required" }));
    await expect(executeScanFingerprintBackfill({
      ...item.options,
      mode: "apply-local",
      confirmPlanSha256: "0".repeat(64),
    })).rejects.toEqual(expect.objectContaining({ code: "plan_confirmation_mismatch" }));
    expect(hashes(item.options.databasePath)).toEqual([null, null]);
  });

  it("rejects changed source bytes or catalog content as a stale plan", async () => {
    const item = await fixture();
    await writeFile(resolve(item.legacy, "1.jpg"), Buffer.from("changed!!!"));
    await expect(executeScanFingerprintBackfill(item.options)).rejects.toBeInstanceOf(Error);

    await writeFile(resolve(item.legacy, "1.jpg"), item.files[0]);
    (item.catalog as Record<string, unknown>).extra = [];
    await writeFile(item.options.catalogPath, `${JSON.stringify(item.catalog)}\n`);
    await expect(executeScanFingerprintBackfill(item.options)).rejects.toEqual(
      expect.objectContaining({ code: "scan_plan_stale" }),
    );
  });

  it("rolls back earlier updates when a later live hash conflicts", async () => {
    const item = await fixture();
    const database = new DatabaseSync(item.options.databasePath);
    database.prepare("UPDATE media_objects SET sha256 = ? WHERE id = ?")
      .run("f".repeat(64), "media-2");
    database.close();

    await expect(executeScanFingerprintBackfill({
      ...item.options,
      mode: "apply-local",
      confirmPlanSha256: item.planSha256,
    })).rejects.toEqual(expect.objectContaining({ code: "scan_database_hash_conflict" }));
    expect(hashes(item.options.databasePath)).toEqual([null, "f".repeat(64)]);
  });

  it("rejects a changed live Scan relationship without modifying hashes", async () => {
    const item = await fixture();
    const database = new DatabaseSync(item.options.databasePath);
    database.prepare("UPDATE scans SET id = 'different-scan' WHERE id = 'scan-1'").run();
    database.close();
    await expect(executeScanFingerprintBackfill({
      ...item.options,
      mode: "apply-local",
      confirmPlanSha256: item.planSha256,
    })).rejects.toEqual(expect.objectContaining({ code: "scan_database_precondition_failed" }));
    expect(hashes(item.options.databasePath)).toEqual([null, null]);
  });

  it("refuses database paths inside either protected legacy tree", async () => {
    const item = await fixture();
    const unsafe = resolve(item.root, "appsheet/catalog.sqlite");
    await mkdir(dirname(unsafe), { recursive: true });
    await writeFile(unsafe, "not a database");
    await expect(executeScanFingerprintBackfill({
      ...item.options,
      databasePath: unsafe,
    })).rejects.toBeInstanceOf(ScanFingerprintExecutionError);
  });
});
