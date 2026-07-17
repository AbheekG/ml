import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { applyUnassignedDriveFeedback } from "./scan-original-unassigned-drive-feedback";

describe("unassigned Drive owner feedback", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("records seven dispositions and confirms only the rotated unreviewed mapping", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "unassigned-drive-feedback-"));
    roots.push(projectRoot);
    const output = resolve(projectRoot, "notes/private/recovery");
    const genuineRoot = resolve(projectRoot, "legacy/drive/Final");
    await Promise.all([mkdir(output, { recursive: true }), mkdir(genuineRoot, { recursive: true })]);
    const images = [];
    for (let index = 0; index < 8; index += 1) {
      const bytes = await sharp({
        create: { width: 24 + index, height: 18 + index, channels: 3, background: { r: index * 20, g: 0, b: 0 } },
      }).jpeg().toBuffer();
      const filename = `image-${index + 1}.jpg`;
      await writeFile(resolve(genuineRoot, filename), bytes);
      images.push({
        token: `genuine-${String(index + 1).padStart(4, "0")}`,
        relativePath: filename,
        byteSize: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    const report = {
      inventories: { genuineImages: images },
      decisions: [
        { currentToken: "current-0001", status: "confirmed_replacement", proposedAction: "replace_after_approval", genuineToken: "genuine-0001" },
        { currentToken: "current-0002", status: "owner_review_probable", proposedAction: "owner_review", genuineToken: "genuine-0007" },
        { currentToken: "current-0003", status: "owner_review_ambiguous", proposedAction: "owner_review", genuineToken: "genuine-0007" },
        { currentToken: "current-0004", status: "unmatched", proposedAction: "owner_review", genuineToken: "genuine-0004" },
      ],
    };
    const reportBytes = Buffer.from(`${JSON.stringify(report)}\n`);
    const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");
    await writeFile(resolve(output, "match-report.json"), reportBytes);
    await writeFile(resolve(output, "owner-confirmed-matches.json"), `${JSON.stringify({
      schemaVersion: 1,
      reportSha256,
      reviewExportSha256: "export",
      ownerDecision: "initial",
      counts: { originalConfirmed: 1, additionalConfirmed: 0, combinedConfirmed: 1, issues: 1, unsure: 0, unreviewed: 1 },
      confirmedMappings: [{ currentToken: "current-0001", genuineToken: "genuine-0001", reportStatus: "confirmed_replacement", proposedAction: "replace_after_approval", confirmationSource: "original" }],
      unresolved: [
        { currentToken: "current-0002", genuineToken: "genuine-0007", reportStatus: "owner_review_probable", proposedAction: "owner_review", confirmationSource: "review", reviewDecision: "unreviewed" },
        { currentToken: "current-0003", genuineToken: "genuine-0007", reportStatus: "owner_review_ambiguous", proposedAction: "owner_review", confirmationSource: "review", reviewDecision: "issue" },
      ],
      safetyHolds: {},
      invariants: { activationAuthorized: false },
    })}\n`);
    await writeFile(resolve(output, "review-state-remaining.json"), `${JSON.stringify({
      schemaVersion: 1,
      reportSha256,
      scope: "remaining",
      itemCount: 2,
      reviewedCount: 1,
      updatedAt: null,
      decisions: { "current-0003": "issue" },
    })}\n`);

    const options = { outputDirectory: output, genuineRoot, projectRoot };
    const result = await applyUnassignedDriveFeedback(options);
    expect(result).toMatchObject({
      reviewedCandidates: 7,
      ignoredCandidates: 3,
      laterManualUploadCandidates: 3,
      rotatedConfirmedCandidates: 1,
      combinedConfirmed: 2,
      issuesRemaining: 1,
      unreviewedRemaining: 0,
      unassignedGenuineImagesRemaining: 6,
      legacyInputsWritten: false,
      activationAuthorized: false,
    });
    expect(await applyUnassignedDriveFeedback(options)).toEqual(result);
    const confirmation = JSON.parse(await readFile(resolve(output, "owner-confirmed-matches.json"), "utf8"));
    expect(confirmation.confirmedMappings).toHaveLength(2);
    expect(confirmation.confirmedMappings[1]).toMatchObject({
      currentToken: "current-0002",
      genuineToken: "genuine-0007",
      sourceTransform: { preserveOriginalBytes: true, displayRotationDegrees: 180 },
    });
    expect(confirmation.unresolved).toHaveLength(1);
    const feedback = JSON.parse(await readFile(resolve(output, "owner-unassigned-drive-decisions.json"), "utf8"));
    expect(feedback.decisions.map((item: { ownerDisposition: string }) => item.ownerDisposition)).toEqual([
      "ignore", "ignore", "ignore", "later_manual_upload", "later_manual_upload",
      "confirm_existing_scan", "later_manual_upload",
    ]);
  });
});
