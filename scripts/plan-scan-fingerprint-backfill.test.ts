import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  ScanFingerprintBackfillError,
  buildScanFingerprintBackfillPlan,
  writeScanFingerprintPlanAtomic,
} from "./plan-scan-fingerprint-backfill";

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scan-fingerprint-plan-"));
  const legacy = resolve(root, "legacy/appsheet", "scans");
  const output = resolve(root, "data", "import-output");
  await Promise.all([mkdir(legacy, { recursive: true }), mkdir(output, { recursive: true })]);
  const first = new Uint8Array([1, 2, 3, 4]);
  const second = new Uint8Array([1, 2, 3, 4]);
  const third = new Uint8Array([9, 8, 7]);
  await Promise.all([
    writeFile(resolve(legacy, "one.jpg"), first),
    writeFile(resolve(legacy, "two.jpg"), second),
    writeFile(resolve(legacy, "three.png"), third),
  ]);
  const catalogPath = resolve(output, "catalog.json");
  const planPath = resolve(output, "scan-plan.json");
  const catalog = {
    schemaVersion: 2,
    mediaObjects: [
      { id: "media-1", objectKey: "scans/one.jpg", byteSize: first.length, sha256: null, kind: "scan", state: "active" },
      { id: "media-2", objectKey: "scans/two.jpg", byteSize: second.length, sha256: null, kind: "scan", state: "active" },
      { id: "media-3", objectKey: "scans/three.png", byteSize: third.length, sha256: hash(third), kind: "scan", state: "active" },
      { id: "audio-1", objectKey: "recordings/one.mp3", byteSize: 100, sha256: null, kind: "original_audio", state: "active" },
    ],
    scans: [
      { id: "scan-1", mediaId: "media-1" },
      { id: "scan-2", mediaId: "media-2" },
      { id: "scan-3", mediaId: "media-3" },
    ],
  };
  await writeFile(catalogPath, `${JSON.stringify(catalog)}\n`);
  return { root, legacy, catalog, catalogPath, planPath, first, third };
}

describe("Scan fingerprint backfill planner", () => {
  it("deterministically hashes every referenced Scan and plans only missing fingerprints", async () => {
    const item = await fixture();
    const options = {
      catalogPath: item.catalogPath,
      planPath: item.planPath,
      writePlan: false,
      workers: 2,
      projectRoot: item.root,
    };
    const first = await buildScanFingerprintBackfillPlan(options);
    const second = await buildScanFingerprintBackfillPlan(options);

    expect(second).toEqual(first);
    expect(first.aggregate).toEqual({
      schemaVersion: 1,
      mode: "dry-run",
      scans: 3,
      scanMedia: 3,
      bytes: 11,
      alreadyHashed: 1,
      hashBackfills: 2,
      duplicateHashGroups: 1,
    });
    expect(first.plan.updates.map((update) => update.mediaId)).toEqual(["media-1", "media-2"]);
    expect(first.plan.updates[0]).toMatchObject({
      scanId: "scan-1",
      expectedObjectKey: "scans/one.jpg",
      expectedSha256: null,
      sha256: hash(item.first),
      byteSize: 4,
    });
  });

  it("rejects a changed source size or a mismatched existing fingerprint", async () => {
    const item = await fixture();
    await writeFile(resolve(item.legacy, "one.jpg"), new Uint8Array([1]));
    await expect(buildScanFingerprintBackfillPlan({
      catalogPath: item.catalogPath,
      planPath: item.planPath,
      writePlan: false,
      workers: 1,
      projectRoot: item.root,
    })).rejects.toEqual(expect.objectContaining({ code: "scan_byte_size_changed" }));

    item.catalog.mediaObjects[2].sha256 = "a".repeat(64);
    await writeFile(item.catalogPath, `${JSON.stringify(item.catalog)}\n`);
    await writeFile(resolve(item.legacy, "one.jpg"), item.first);
    await expect(buildScanFingerprintBackfillPlan({
      catalogPath: item.catalogPath,
      planPath: item.planPath,
      writePlan: false,
      workers: 1,
      projectRoot: item.root,
    })).rejects.toEqual(expect.objectContaining({ code: "existing_scan_hash_mismatch" }));
  });

  it("rejects traversal and incomplete Scan/media relationships", async () => {
    const item = await fixture();
    item.catalog.mediaObjects[0].objectKey = "../outside.jpg";
    await writeFile(item.catalogPath, `${JSON.stringify(item.catalog)}\n`);
    await expect(buildScanFingerprintBackfillPlan({
      catalogPath: item.catalogPath,
      planPath: item.planPath,
      writePlan: false,
      workers: 1,
      projectRoot: item.root,
    })).rejects.toBeInstanceOf(ScanFingerprintBackfillError);

    item.catalog.mediaObjects[0].objectKey = "scans/one.jpg";
    item.catalog.scans.pop();
    await writeFile(item.catalogPath, `${JSON.stringify(item.catalog)}\n`);
    await expect(buildScanFingerprintBackfillPlan({
      catalogPath: item.catalogPath,
      planPath: item.planPath,
      writePlan: false,
      workers: 1,
      projectRoot: item.root,
    })).rejects.toEqual(expect.objectContaining({ code: "unreferenced_scan_media" }));
  });

  it("writes details only to an ignored private root without changing legacy inputs", async () => {
    const item = await fixture();
    const before = await readFile(resolve(item.legacy, "one.jpg"));
    const result = await buildScanFingerprintBackfillPlan({
      catalogPath: item.catalogPath,
      planPath: item.planPath,
      writePlan: true,
      workers: 2,
      projectRoot: item.root,
    });
    expect(result.aggregate.mode).toBe("write-plan");
    await writeScanFingerprintPlanAtomic(item.planPath, result.plan, item.root);
    expect(JSON.parse(await readFile(item.planPath, "utf8"))).toEqual(result.plan);
    expect(await readFile(resolve(item.legacy, "one.jpg"))).toEqual(before);

    await expect(writeScanFingerprintPlanAtomic(
      resolve(item.root, "public-plan.json"),
      result.plan,
      item.root,
    )).rejects.toEqual(expect.objectContaining({ code: "plan_output_must_be_private" }));
    await expect(stat(resolve(item.root, "public-plan.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
