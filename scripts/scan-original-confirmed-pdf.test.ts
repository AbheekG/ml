import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { generateConfirmedPdf } from "./scan-original-confirmed-pdf";

describe("confirmed scan-original review PDF", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("binds confirmed mappings and embeds two JPEG comparisons on one A4 page", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "confirmed-scan-pdf-"));
    roots.push(projectRoot);
    const output = resolve(projectRoot, "notes/private/recovery");
    const review = resolve(output, "review");
    await mkdir(review, { recursive: true });
    const report = {
      decisions: [
        { currentToken: "current-0001", genuineToken: "genuine-0001" },
        { currentToken: "current-0002", genuineToken: "genuine-0002" },
      ],
    };
    const reportBytes = Buffer.from(`${JSON.stringify(report)}\n`);
    const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");
    await writeFile(resolve(output, "match-report.json"), reportBytes);
    await writeFile(resolve(output, "owner-confirmed-matches.json"), `${JSON.stringify({
      schemaVersion: 1,
      reportSha256,
      counts: { combinedConfirmed: 2 },
      confirmedMappings: [
        { currentToken: "current-0001", genuineToken: "genuine-0001" },
        { currentToken: "current-0002", genuineToken: "genuine-0002" },
      ],
      invariants: { activationAuthorized: false },
    })}\n`);
    const aid = await sharp({
      create: { width: 126, height: 63, channels: 3, background: "white" },
    }).jpeg().toBuffer();
    await Promise.all([
      writeFile(resolve(review, "current-0001.jpg"), aid),
      writeFile(resolve(review, "current-0002.jpg"), aid),
    ]);

    const result = await generateConfirmedPdf({ outputDirectory: output, projectRoot });
    expect(result).toMatchObject({
      confirmedMappings: 2,
      comparisonsPerPage: 2,
      pages: 1,
      reportSha256,
      activationAuthorized: false,
    });
    const pdf = await readFile(resolve(output, "confirmed-final-review.pdf"));
    expect(pdf.subarray(0, 8).toString("ascii")).toBe("%PDF-1.4");
    expect(pdf.toString("binary").match(/\/Subtype \/Image/gu)).toHaveLength(2);
    expect(pdf.toString("binary")).toContain("/MediaBox [0 0 841.89 595.28]");
  });
});
