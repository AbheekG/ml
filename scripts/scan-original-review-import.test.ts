import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importScanOriginalReview } from "./scan-original-review-import";

describe("scan original review import", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("binds a complete export to the report and writes a combined private confirmation", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "scan-review-import-"));
    roots.push(projectRoot);
    const output = resolve(projectRoot, "notes/private/recovery");
    const review = resolve(output, "review");
    await mkdir(review, { recursive: true });
    const report = {
      decisions: [
        { currentToken: "current-0001", status: "confirmed_replacement", proposedAction: "replace_after_approval", genuineToken: "genuine-0001" },
        { currentToken: "current-0002", status: "owner_review_probable", proposedAction: "owner_review", genuineToken: "genuine-0002" },
        { currentToken: "current-0003", status: "owner_review_ambiguous", proposedAction: "owner_review", genuineToken: "genuine-0003" },
        { currentToken: "current-0004", status: "owner_review_probable", proposedAction: "owner_review", genuineToken: "genuine-0004" },
      ],
      inventories: {
        genuineImages: [
          { token: "genuine-0001", sha256: "hash-1" },
          { token: "genuine-0002", sha256: "hash-2" },
          { token: "genuine-0003", sha256: "hash-3" },
          { token: "genuine-0004", sha256: "hash-4" },
        ],
      },
    };
    const reportBytes = Buffer.from(`${JSON.stringify(report)}\n`);
    const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");
    await writeFile(resolve(output, "match-report.json"), reportBytes);
    await writeFile(resolve(output, "owner-approved-confirmed-replacements.json"), `${JSON.stringify({
      reportSha256,
      count: 1,
      mappings: [{ currentToken: "current-0001", genuineToken: "genuine-0001" }],
    })}\n`);
    await writeFile(resolve(review, "remaining.html"), `
      <article class="review-card" id="item-current-0002" data-status="owner_review_probable" data-review="" data-owner-approved="false"></article>
      <article class="review-card" id="item-current-0003" data-status="owner_review_ambiguous" data-review="" data-owner-approved="false"></article>
      <article class="review-card" id="item-current-0004" data-status="owner_review_probable" data-review="" data-owner-approved="false"></article>
    `);
    const input = resolve(projectRoot, "export.json");
    await writeFile(input, `${JSON.stringify({
      schemaVersion: 1,
      reportSha256,
      scope: "remaining",
      itemCount: 3,
      reviewedCount: 2,
      updatedAt: "2026-07-16T00:00:00.000Z",
      decisions: { "current-0002": "correct", "current-0003": "issue" },
    })}\n`);

    const result = await importScanOriginalReview({
      inputPath: input,
      outputDirectory: output,
      expectedCorrect: 1,
      expectedIssue: 1,
      expectedUnreviewed: 1,
      writeConfirmation: true,
      projectRoot,
    });
    expect(result).toMatchObject({
      mode: "write-confirmation",
      originalConfirmed: 1,
      additionalConfirmed: 1,
      combinedConfirmed: 2,
      issues: 1,
      unreviewed: 1,
      activationAuthorized: false,
    });
    const confirmation = JSON.parse(await readFile(
      resolve(output, "owner-confirmed-matches.json"),
      "utf8",
    ));
    expect(confirmation.confirmedMappings).toHaveLength(2);
    expect(confirmation.unresolved).toHaveLength(2);
    expect(confirmation.invariants).toMatchObject({
      exactReportBinding: true,
      exactReviewScope: true,
      activationAuthorized: false,
    });
  });
});
