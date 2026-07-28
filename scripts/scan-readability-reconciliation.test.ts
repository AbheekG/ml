import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertAcceptedScope,
  buildReconciliationSql,
  decideExistingReadability,
  downloadR2,
  ScanReconciliationError,
  type CurrentScanRow,
  type ReadabilityDecision,
  type ReconciliationPlan,
  type RecoveryHistoryRow,
} from "./scan-readability-reconciliation";

function jpeg(
  totalBytes: number,
  options: { width?: number; height?: number; metadata?: boolean } = {},
): Uint8Array {
  const width = options.width ?? 1200;
  const height = options.height ?? 900;
  const header = [
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    ...(options.metadata ? [0xff, 0xe1, 0x00, 0x04, 0x00, 0x00] : []),
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x0c,
    0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00,
  ];
  const bytes = new Uint8Array(Math.max(totalBytes, header.length + 2));
  bytes.set(header);
  bytes.set([0xff, 0xd9], bytes.length - 2);
  return bytes;
}

function currentRow(index = 0, sourceBytes = 500_000, derivativeBytes = 200_000): CurrentScanRow {
  const mediaId = `media-${index}`;
  return {
    scanId: `scan-${index}`,
    mediaId,
    sourceObjectKey: `scans/original/${mediaId}`,
    sourceMimeType: "image/jpeg",
    sourceByteSize: sourceBytes,
    sourceSha256: index.toString(16).padStart(64, "0"),
    derivativeObjectKey: `scans/readability/${mediaId}.jpg`,
    derivativeByteSize: derivativeBytes,
    derivativeSha256: (index + 1).toString(16).padStart(64, "0"),
    derivativeWidth: 1200,
    derivativeHeight: 900,
    derivativePolicyId: "scan-jpeg-v1-2400-q85",
    selectionPolicyId: null,
  };
}

function image(bytes: Uint8Array, width = 1200, height = 900) {
  return { bytes, format: "jpeg", width, height };
}

function scopeFixtures() {
  const current = Array.from({ length: 499 }, (_, index) => currentRow(index));
  const recovery = Array.from({ length: 446 }, (_, index): RecoveryHistoryRow => ({
    historyId: `history-${index}`,
    scanId: `recovered-scan-${index}`,
    mediaId: `former-media-${index}`,
    replacedBy: "migration:scan-original-recovery-v1",
    sourceObjectKey: `scans/former-${index}.jpg`,
    sourceByteSize: 100 + index,
    sourceSha256: (index + 500).toString(16).padStart(64, "0"),
    derivativeObjectKey: `scans/readability/former-media-${index}.jpg`,
    derivativeByteSize: 50 + index,
    derivativeSha256: (index + 1000).toString(16).padStart(64, "0"),
  }));
  const replacements = recovery.map((row) => ({
    historyId: row.historyId,
    scanId: row.scanId,
    formerMediaId: row.mediaId,
    formerObjectKey: row.sourceObjectKey,
    formerByteSize: row.sourceByteSize,
    formerSha256: row.sourceSha256,
    formerDerivativeObjectKey: row.derivativeObjectKey,
    formerDerivativeByteSize: row.derivativeByteSize,
    formerDerivativeSha256: row.derivativeSha256,
  }));
  return { current, recovery, replacements };
}

function plan(): ReconciliationPlan {
  const decisions = Array.from({ length: 499 }, (_, index): ReadabilityDecision => ({
    sourceMediaId: `current-media-${index}`,
    sourceSha256: (index + 1).toString(16).padStart(64, "0"),
    sourceByteSize: 500_000,
    sourceWidth: 1200,
    sourceHeight: 900,
    representationKind: "source",
    selectionBasis: "direct_safe_source",
    candidateByteSize: null,
    formerDerivativeObjectKey: `scans/readability/current-media-${index}.jpg`,
    candidateObjectKey: `scans/readability-v2/current-media-${index}.jpg`,
    candidateSha256: (index + 1000).toString(16).padStart(64, "0"),
    candidateWidth: 1200,
    candidateHeight: 900,
    candidateLocalPath: null,
  }));
  const recoveryDeletes = Array.from({ length: 446 }, (_, index) => ({
    historyId: `recovery-history-${index}`,
    scanId: `recovery-scan-${index}`,
    mediaId: `recovery-media-${index}`,
    sourceObjectKey: `scans/recovery-${index}.jpg`,
    derivativeObjectKey: `scans/readability/recovery-media-${index}.jpg`,
  }));
  const r2DeleteKeys = [
    ...decisions.map((row) => row.formerDerivativeObjectKey),
    ...recoveryDeletes.flatMap((row) => [row.sourceObjectKey, row.derivativeObjectKey]),
  ].sort();
  return {
    schemaVersion: 1,
    database: "music-library-staging-apac",
    bucket: "music-library-media-staging",
    recoveryActor: "migration:scan-original-recovery-v1",
    reconciliationActor: "migration:scan-readability-policy-v2",
    derivativePolicy: "scan-jpeg-v1-2400-q85",
    selectionPolicy: "scan-readability-selection-v2",
    recoveryPlanSha256: "a".repeat(64),
    inventoryDigest: "b".repeat(64),
    createdAt: "2026-07-28T00:00:00.000Z",
    decisions,
    recoveryDeletes,
    r2DeleteKeys,
    aggregate: {
      currentScans: 499,
      directSources: 499,
      requiredDerivatives: 0,
      materialDerivatives: 0,
      recoveryHistoriesDeleted: 446,
      preservedHistories: 1,
      d1DerivativeRowsDeleted: 945,
      d1DerivativeRowsInserted: 0,
      r2ObjectsUploaded: 0,
      r2ObjectsDeleted: r2DeleteKeys.length,
    },
  };
}

describe("Scan readability reconciliation", () => {
  it("retries transient R2 reads but fails a genuinely missing object immediately", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "scan-readability-r2-"));
    try {
      const destination = resolve(directory, "verified.jpg");
      let attempts = 0;
      await downloadR2("scans/readability-v2/synthetic.jpg", destination, async (
        _executable,
        arguments_,
      ) => {
        attempts += 1;
        if (attempts < 3) {
          return { exitCode: 1, stdout: "", stderr: "temporary upstream failure" };
        }
        const outputPath = arguments_[arguments_.indexOf("--file") + 1]!;
        await writeFile(outputPath, new Uint8Array([1, 2, 3]));
        return { exitCode: 0, stdout: "", stderr: "" };
      });
      expect(attempts).toBe(3);
      expect(new Uint8Array(await readFile(destination))).toEqual(
        new Uint8Array([1, 2, 3]),
      );

      attempts = 0;
      await expect(downloadR2(
        "scans/readability-v2/missing.jpg",
        destination,
        async () => {
          attempts += 1;
          return { exitCode: 1, stdout: "", stderr: "NoSuchKey" };
        },
      )).rejects.toMatchObject({ code: "remote_r2_object_missing" });
      expect(attempts).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the same direct, material-savings, and required-normalization policy", () => {
    const small = currentRow(1, 500_000, 200_000);
    expect(decideExistingReadability(
      small,
      image(jpeg(small.sourceByteSize)),
      image(jpeg(small.derivativeByteSize)),
    )).toMatchObject({
      representationKind: "source",
      selectionBasis: "direct_safe_source",
      candidateByteSize: null,
    });

    const material = currentRow(2, 1_500_000, 700_000);
    const materialDecision = decideExistingReadability(
      material,
      image(jpeg(material.sourceByteSize)),
      image(jpeg(material.derivativeByteSize)),
    );
    expect(materialDecision).toMatchObject({
      representationKind: "derivative",
      selectionBasis: "optional_material_savings",
      candidateByteSize: 700_000,
      candidateObjectKey: "scans/readability-v2/media-2.jpg",
    });

    const metadata = currentRow(3, 500_000, 200_000);
    expect(decideExistingReadability(
      metadata,
      image(jpeg(metadata.sourceByteSize, { metadata: true })),
      image(jpeg(metadata.derivativeByteSize)),
    )).toMatchObject({
      representationKind: "derivative",
      selectionBasis: "required_normalization",
    });

    const legacyMetadata = currentRow(4, 500_000, 200_000);
    const legacyDecision = decideExistingReadability(
      legacyMetadata,
      image(jpeg(legacyMetadata.sourceByteSize, { metadata: true })),
      image(jpeg(legacyMetadata.derivativeByteSize, { metadata: true })),
    );
    expect(legacyDecision).toMatchObject({
      representationKind: "derivative",
      selectionBasis: "required_normalization",
      candidateByteSize: legacyMetadata.derivativeByteSize - 6,
    });
  });

  it("binds exactly the accepted recovery scope and protects every current source", () => {
    const fixtures = scopeFixtures();
    expect(() => assertAcceptedScope(
      fixtures.current,
      fixtures.recovery,
      fixtures.replacements,
      1,
    )).not.toThrow();
    fixtures.recovery[0] = {
      ...fixtures.recovery[0]!,
      mediaId: fixtures.current[0]!.mediaId,
    };
    expect(() => assertAcceptedScope(
      fixtures.current,
      fixtures.recovery,
      fixtures.replacements,
      1,
    )).toThrow(ScanReconciliationError);
  });

  it("generates one guarded D1 transaction before any separately planned R2 deletion", () => {
    const sql = buildReconciliationSql(plan());
    expect(sql).toContain("BEGIN TRANSACTION;");
    expect(sql).toContain("DROP TRIGGER prevent_scan_media_history_delete;");
    expect(sql).toContain("CREATE TRIGGER prevent_scan_media_history_delete");
    expect(sql).toContain("changes() = 446");
    expect(sql).toContain("changes() = 499");
    expect(sql).toContain("'recovery-history-445'");
    expect(sql).toContain("'current-media-498'");
    expect(sql).not.toContain("synthetic-history-to-preserve");
    expect(sql.indexOf("DELETE FROM scan_readability_derivatives"))
      .toBeLessThan(sql.indexOf("DELETE FROM media_objects"));
    expect(sql.indexOf("DELETE FROM media_objects"))
      .toBeLessThan(sql.indexOf("INSERT INTO scan_readability_selections"));
    expect(sql).not.toContain("r2 object delete");
    expect(sql.trimEnd()).toMatch(/COMMIT;$/u);
  });

  it("replays the exact guarded cleanup atomically while preserving one test history", () => {
    const database = new DatabaseSync(":memory:");
    try {
      for (const name of readdirSync(resolve("migrations"))
        .filter((entry) => /^\d{4}_.+\.sql$/u.test(entry))
        .sort()) {
        database.exec(readFileSync(resolve("migrations", name), "utf8"));
      }
      const timestamp = "2026-07-28T00:00:00.000Z";
      database.exec(`
        INSERT INTO songs (
          id, title_latin, normalized_title_latin, status,
          created_at, created_by, updated_at, updated_by
        ) VALUES (
          'song-1', 'Synthetic', 'synthetic', 'checked',
          '${timestamp}', 'test', '${timestamp}', 'test'
        );
      `);
      const mediaInsert = database.prepare(`
        INSERT INTO media_objects (
          id, object_key, original_filename, mime_type, byte_size, sha256, kind,
          created_at, created_by
        ) VALUES (?, ?, 'synthetic.jpg', 'image/jpeg', ?, ?, 'scan', ?, 'test')
      `);
      const derivativeInsert = database.prepare(`
        INSERT INTO scan_readability_derivatives (
          source_media_id, source_sha256, source_byte_size, object_key,
          mime_type, byte_size, sha256, width, height, policy_id,
          created_at, created_by
        ) VALUES (
          ?, ?, ?, ?, 'image/jpeg', 200000, ?, 1200, 900,
          'scan-jpeg-v1-2400-q85', ?, 'test'
        )
      `);
      const scanInsert = database.prepare(`
        INSERT INTO scans (
          id, song_id, media_id, revision,
          created_at, created_by, updated_at, updated_by
        ) VALUES (?, 'song-1', ?, 1, ?, 'test', ?, 'test')
      `);
      const historyInsert = database.prepare(`
        INSERT INTO scan_media_history (
          id, scan_id, media_id, replaced_at, replaced_by, revision_at_replacement
        ) VALUES (?, ?, ?, ?, ?, 1)
      `);
      const sourceHash = (index: number) => (index + 1).toString(16).padStart(64, "0");
      const derivativeHash = (index: number) => (
        index + 2000
      ).toString(16).padStart(64, "0");
      const decisions: ReadabilityDecision[] = [];
      const recoveryDeletes: ReconciliationPlan["recoveryDeletes"] = [];
      database.exec("BEGIN");
      for (let index = 0; index < 499; index += 1) {
        const scanId = `scan-${index}`;
        const currentMediaId = `current-media-${index}`;
        if (index < 446 || index === 446) {
          const historicalMediaId = index < 446
            ? `recovery-media-${index}`
            : "synthetic-history-media";
          const historicalHistoryId = index < 446
            ? `recovery-history-${index}`
            : "synthetic-history-to-preserve";
          const historicalActor = index < 446
            ? "migration:scan-original-recovery-v1"
            : "synthetic:test";
          const historicalObjectKey = `scans/${historicalMediaId}.jpg`;
          const historicalDerivativeKey = `scans/readability/${historicalMediaId}.jpg`;
          const historicalHash = sourceHash(index);
          mediaInsert.run(
            historicalMediaId,
            historicalObjectKey,
            500000,
            historicalHash,
            timestamp,
          );
          derivativeInsert.run(
            historicalMediaId,
            historicalHash,
            500000,
            historicalDerivativeKey,
            derivativeHash(index),
            timestamp,
          );
          scanInsert.run(scanId, historicalMediaId, timestamp, timestamp);
          historyInsert.run(
            historicalHistoryId,
            scanId,
            historicalMediaId,
            timestamp,
            historicalActor,
          );
          if (index < 446) {
            recoveryDeletes.push({
              historyId: historicalHistoryId,
              scanId,
              mediaId: historicalMediaId,
              sourceObjectKey: historicalObjectKey,
              derivativeObjectKey: historicalDerivativeKey,
            });
          }
        }
        const currentHash = sourceHash(index + 500);
        const currentObjectKey = `scans/${currentMediaId}.jpg`;
        const currentDerivativeKey = `scans/readability/${currentMediaId}.jpg`;
        mediaInsert.run(
          currentMediaId,
          currentObjectKey,
          500000,
          currentHash,
          timestamp,
        );
        derivativeInsert.run(
          currentMediaId,
          currentHash,
          500000,
          currentDerivativeKey,
          derivativeHash(index + 500),
          timestamp,
        );
        if (index <= 446) {
          database.prepare(`
            UPDATE scans SET media_id = ?, revision = 2 WHERE id = ?
          `).run(currentMediaId, scanId);
        } else {
          scanInsert.run(scanId, currentMediaId, timestamp, timestamp);
        }
        decisions.push({
          sourceMediaId: currentMediaId,
          sourceSha256: currentHash,
          sourceByteSize: 500000,
          sourceWidth: 1200,
          sourceHeight: 900,
          representationKind: "source",
          selectionBasis: "direct_safe_source",
          candidateByteSize: null,
          formerDerivativeObjectKey: currentDerivativeKey,
          candidateObjectKey: `scans/readability-v2/${currentMediaId}.jpg`,
          candidateSha256: derivativeHash(index + 500),
          candidateWidth: 1200,
          candidateHeight: 900,
          candidateLocalPath: null,
        });
      }
      database.exec("COMMIT");
      decisions[498] = {
        ...decisions[498]!,
        representationKind: "derivative",
        selectionBasis: "required_normalization",
        candidateByteSize: 200000,
        candidateLocalPath: resolve(
          "notes/private/scan-readability-reconciliation/prepared/synthetic-candidate.jpg",
        ),
      };
      const completePlan = plan();
      completePlan.decisions = decisions;
      completePlan.recoveryDeletes = recoveryDeletes;
      completePlan.r2DeleteKeys = [
        ...decisions.map((row) => row.formerDerivativeObjectKey),
        ...recoveryDeletes.flatMap(
          (row) => [row.sourceObjectKey, row.derivativeObjectKey],
        ),
      ].sort();
      completePlan.aggregate.directSources = 498;
      completePlan.aggregate.requiredDerivatives = 1;
      completePlan.aggregate.d1DerivativeRowsDeleted = 945;
      completePlan.aggregate.d1DerivativeRowsInserted = 1;
      completePlan.aggregate.r2ObjectsUploaded = 1;
      database.exec(buildReconciliationSql(completePlan));
      expect(database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM scans) AS scans,
          (SELECT COUNT(*) FROM media_objects WHERE kind = 'scan') AS media,
          (SELECT COUNT(*) FROM scan_media_history) AS histories,
          (SELECT COUNT(*) FROM scan_readability_derivatives) AS derivatives,
          (SELECT COUNT(*) FROM scan_readability_selections) AS selections,
          (SELECT COUNT(*) FROM scan_fingerprint_members) AS fingerprints,
          (SELECT COUNT(*) FROM pragma_foreign_key_check) AS foreignKeys,
          (SELECT COUNT(*) FROM sqlite_master
            WHERE type = 'trigger'
              AND name = 'prevent_scan_media_history_delete') AS retentionTrigger
      `).get()).toEqual({
        scans: 499,
        media: 500,
        histories: 1,
        derivatives: 2,
        selections: 499,
        fingerprints: 500,
        foreignKeys: 0,
        retentionTrigger: 1,
      });
      expect(database.prepare(`
        SELECT id, media_id, replaced_by FROM scan_media_history
      `).get()).toEqual({
        id: "synthetic-history-to-preserve",
        media_id: "synthetic-history-media",
        replaced_by: "synthetic:test",
      });
      expect(database.prepare(`
        SELECT object_key
        FROM scan_readability_derivatives
        WHERE source_media_id = 'current-media-498'
      `).get()).toEqual({
        object_key: "scans/readability-v2/current-media-498.jpg",
      });
    } finally {
      database.close();
    }
  });
});
