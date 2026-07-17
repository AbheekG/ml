import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { generateUnassignedDriveReview } from "./scan-original-unassigned-drive-review";

describe("unassigned Drive candidate review", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("hash-verifies read-only sources and writes a private filename inspection page", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "unassigned-drive-review-"));
    roots.push(projectRoot);
    const output = resolve(projectRoot, "notes/private/recovery");
    const genuineRoot = resolve(projectRoot, "legacy/drive/Final");
    await Promise.all([mkdir(output, { recursive: true }), mkdir(resolve(genuineRoot, "folder"), { recursive: true })]);
    const first = await sharp({ create: { width: 40, height: 20, channels: 3, background: "white" } }).jpeg().toBuffer();
    const second = await sharp({ create: { width: 30, height: 50, channels: 3, background: "black" } }).jpeg().toBuffer();
    await Promise.all([
      writeFile(resolve(genuineRoot, "assigned.jpg"), first),
      writeFile(resolve(genuineRoot, "folder/unassigned example.jpg"), second),
    ]);
    const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const report = {
      aggregate: { genuineImageCandidates: 2 },
      inventories: {
        genuineImages: [
          { token: "genuine-0001", relativePath: "assigned.jpg", byteSize: first.length, sha256: hash(first), width: 40, height: 20, format: "jpeg" },
          { token: "genuine-0002", relativePath: "folder/unassigned example.jpg", byteSize: second.length, sha256: hash(second), width: 30, height: 50, format: "jpeg" },
        ],
      },
      decisions: [
        { currentToken: "current-0001", status: "confirmed_replacement", genuineToken: "genuine-0001" },
        { currentToken: "current-0002", status: "owner_review_probable", genuineToken: "genuine-0002" },
      ],
    };
    const reportBytes = Buffer.from(`${JSON.stringify(report)}\n`);
    const reportSha256 = hash(reportBytes);
    await writeFile(resolve(output, "match-report.json"), reportBytes);
    await writeFile(resolve(output, "owner-confirmed-matches.json"), `${JSON.stringify({
      reportSha256,
      confirmedMappings: [{ currentToken: "current-0001", genuineToken: "genuine-0001" }],
      unresolved: [{ currentToken: "current-0002", genuineToken: "genuine-0002", reviewDecision: "issue" }],
    })}\n`);

    const result = await generateUnassignedDriveReview({ outputDirectory: output, genuineRoot, projectRoot });
    expect(result).toMatchObject({
      genuineImageCandidates: 2,
      assignedGenuineImages: 1,
      unassignedGenuineImages: 1,
      previewsWritten: 1,
      issueRelations: 1,
      sourcesHashVerified: true,
      legacyInputsWritten: false,
    });
    const html = await readFile(resolve(output, "unassigned-drive-review/index.html"), "utf8");
    expect(html).toContain("unassigned example.jpg");
    expect(html).toContain("folder/unassigned example.jpg");
    expect(html).not.toMatch(/https?:\/\//u);
  });
});
