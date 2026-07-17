import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  buildScanOriginalRecoveryReport,
  runScanOriginalRecovery,
  ScanOriginalRecoveryError,
} from "./scan-original-recovery";

function syntheticPage(seed: number, width = 1200, height = 1600): Buffer {
  const lines = Array.from({ length: 15 }, (_value, index) => {
    const y = 180 + index * 78;
    const inset = (seed * 31 + index * 17) % 140;
    const length = 670 + ((seed * 53 + index * 29) % 260);
    return `<path d="M${130 + inset} ${y} h${length}" stroke="#111" stroke-width="${8 + (index % 3)}"/>`;
  }).join("");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#fffdf6"/>
    <rect x="70" y="60" width="${width - 140}" height="${height - 120}" fill="none" stroke="#555" stroke-width="7"/>
    <circle cx="${220 + seed * 43}" cy="${110 + seed * 19}" r="${24 + seed}" fill="#8b2f2f"/>
    ${lines}
    <path d="M${160 + seed * 11} ${1390 - seed * 9} q250 -${90 + seed * 7} 520 0" fill="none" stroke="#173b78" stroke-width="12"/>
  </svg>`);
}

async function hash(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "scan-original-recovery-"));
  const currentRoot = resolve(root, "legacy/appsheet");
  const currentScans = resolve(currentRoot, "scans");
  const genuineRoot = resolve(root, "legacy/drive/Final");
  const output = resolve(root, "notes/private/scan-original-recovery");
  const catalogPath = resolve(root, "data/import-output/catalog.json");
  const folders = ["Synthetic Alpha", "Synthetic Beta", "Synthetic Gamma", "Unrelated Extras"];
  await Promise.all([
    mkdir(currentScans, { recursive: true }),
    mkdir(resolve(root, "data/import-output"), { recursive: true }),
    ...folders.map((folder) => mkdir(resolve(genuineRoot, folder), { recursive: true })),
  ]);

  const exact = await sharp(syntheticPage(1)).png().toBuffer();
  const betaOriginal = await sharp(syntheticPage(2, 1500, 2100)).jpeg({ quality: 96 }).toBuffer();
  const betaCurrent = await sharp(betaOriginal)
    .extract({ left: 8, top: 10, width: 1480, height: 2080 })
    .resize(720, 1012)
    .jpeg({ quality: 55 })
    .toBuffer();
  const gammaOriginal = await sharp(syntheticPage(3)).png().toBuffer();
  const gammaCurrent = await sharp(gammaOriginal).resize(900, 1200).jpeg({ quality: 70 }).toBuffer();
  const unmatchedCurrent = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="850" height="1133">
    <rect width="850" height="1133" fill="#111"/>
    <path d="M20 20 L830 1113 M830 20 L20 1113" stroke="#fff" stroke-width="90"/>
    <circle cx="425" cy="566" r="180" fill="#d5b22f"/>
  </svg>`)).jpeg({ quality: 65 }).toBuffer();

  const currentBytes = [exact, betaCurrent, gammaCurrent, unmatchedCurrent];
  await Promise.all([
    ...currentBytes.map((bytes, index) => writeFile(resolve(currentScans, `${index + 1}.jpg`), bytes)),
    writeFile(resolve(currentScans, "unreferenced.jpg"), await sharp(syntheticPage(9)).jpeg().toBuffer()),
    writeFile(resolve(genuineRoot, "Synthetic Alpha/one.png"), exact),
    writeFile(resolve(genuineRoot, "Synthetic Beta/two.jpg"), betaOriginal),
    writeFile(resolve(genuineRoot, "Synthetic Gamma/three-a.png"), gammaOriginal),
    writeFile(resolve(genuineRoot, "Synthetic Gamma/three-b.png"), gammaOriginal),
    writeFile(resolve(genuineRoot, "Unrelated Extras/extra.png"), await sharp(syntheticPage(12)).png().toBuffer()),
    writeFile(resolve(genuineRoot, "Unrelated Extras/disguised.bin"), await sharp({
      create: { width: 100, height: 100, channels: 3, background: "#1b6b9d" },
    }).jpeg().toBuffer()),
    writeFile(resolve(genuineRoot, "Unrelated Extras/notes.txt"), "synthetic non-image fixture\n"),
  ]);

  const songs = ["Synthetic Alpha", "Synthetic Beta", "Synthetic Gamma", "Synthetic Delta"]
    .map((titleLatin, index) => ({ id: `song-${index + 1}`, titleLatin, titleNative: null }));
  const mediaObjects = currentBytes.map((bytes, index) => ({
    id: `media-${index + 1}`,
    objectKey: `scans/${index + 1}.jpg`,
    originalFilename: `${index + 1}.jpg`,
    byteSize: bytes.byteLength,
    sha256: null,
    kind: "scan",
    state: "active",
  }));
  const scans = currentBytes.map((_bytes, index) => ({
    id: `scan-${index + 1}`,
    songId: `song-${index + 1}`,
    mediaId: `media-${index + 1}`,
    notebookId: null,
    pageLabel: "1",
  }));
  await writeFile(catalogPath, `${JSON.stringify({
    schemaVersion: 2,
    songs,
    songAliases: [],
    mediaObjects,
    scans,
  })}\n`);
  const options = {
    catalogPath,
    currentRoot,
    genuineRoot,
    outputDirectory: output,
    workers: 2,
    writeReport: false,
    writeReview: false,
    reviewLimit: 10,
    stagingScanCount: 5,
    projectRoot: root,
  };
  return { root, currentRoot, genuineRoot, output, catalogPath, options };
}

async function addAsymmetricallyCroppedPair(
  item: Awaited<ReturnType<typeof fixture>>,
  duplicateCandidate = false,
) {
  const original = await sharp(syntheticPage(17, 1500, 2100)).png().toBuffer();
  const current = await sharp(original)
    .extract({ left: 300, top: 0, width: 1200, height: 2100 })
    .resize({ width: 700 })
    .jpeg({ quality: 52 })
    .toBuffer();
  const writes = [
    writeFile(resolve(item.currentRoot, "scans/5.jpg"), current),
    writeFile(resolve(item.genuineRoot, "Unrelated Extras/asymmetric-original.png"), original),
  ];
  if (duplicateCandidate) {
    writes.push(writeFile(
      resolve(item.genuineRoot, "Unrelated Extras/asymmetric-duplicate.png"),
      original,
    ));
  }
  await Promise.all(writes);
  const catalog = JSON.parse(await readFile(item.catalogPath, "utf8")) as {
    songs: Array<Record<string, unknown>>;
    mediaObjects: Array<Record<string, unknown>>;
    scans: Array<Record<string, unknown>>;
  };
  catalog.songs.push({ id: "song-5", titleLatin: "Synthetic Epsilon", titleNative: null });
  catalog.mediaObjects.push({
    id: "media-5",
    objectKey: "scans/5.jpg",
    originalFilename: "5.jpg",
    byteSize: current.byteLength,
    sha256: null,
    kind: "scan",
    state: "active",
  });
  catalog.scans.push({
    id: "scan-5",
    songId: "song-5",
    mediaId: "media-5",
    notebookId: null,
    pageLabel: "1",
  });
  await writeFile(item.catalogPath, `${JSON.stringify(catalog)}\n`);
  return {
    ...item.options,
    stagingScanCount: 6,
  };
}

describe("Scan original recovery", () => {
  it("locks only deterministic one-to-one exact and corroborated visual matches", async () => {
    const item = await fixture();
    const result = await buildScanOriginalRecoveryReport(item.options);

    expect(result.aggregate).toMatchObject({
      mode: "dry-run",
      catalogScans: 4,
      stagingOnlyScansExcluded: 1,
      currentFiles: 5,
      currentReferencedFiles: 4,
      currentUnreferencedFiles: 1,
      genuineFiles: 7,
      genuineImageCandidates: 6,
      genuineNonImageFiles: 1,
      exactAlreadyGenuine: 1,
      confirmedReplacements: 1,
      ownerReviewAmbiguous: 1,
      unmatchedCurrent: 1,
      confirmedOneToOne: true,
    });
    expect(result.decisions.map((decision) => decision.status)).toEqual([
      "exact_bytes_already_genuine",
      "confirmed_replacement",
      "owner_review_ambiguous",
      "unmatched",
    ]);
    expect(result.report.invariants).toEqual({
      everyCatalogScanHasOneCurrentFile: true,
      confirmedCurrentUnique: true,
      confirmedGenuineUnique: true,
      confirmedGenuineHashesUnique: true,
      confirmedReplacementHashCollisionFree: true,
      legacyInputsWritten: false,
      cloudContacted: false,
    });
    expect(result.report.conflicts.oneToMany).toContainEqual({
      currentToken: "current-0003",
      genuineTokens: ["genuine-0003", "genuine-0004"],
    });
  });

  it("is deterministic, aggregate-only on stdout, and writes only private review output", async () => {
    const item = await fixture();
    const before = await hash(resolve(item.currentRoot, "scans/2.jpg"));
    const first = await runScanOriginalRecovery(item.options);
    const second = await runScanOriginalRecovery({
      ...item.options,
      writeReport: true,
      writeReview: true,
      reviewLimit: 3,
      ownerApproveConfirmedReplacements: true,
    });
    const third = await runScanOriginalRecovery({
      ...item.options,
      writeReport: true,
      writeReview: true,
      reviewLimit: 3,
    });

    expect(second.reportSha256).toBe(first.reportSha256);
    expect(third.reportSha256).toBe(first.reportSha256);
    expect(JSON.stringify(second)).not.toContain(item.root);
    expect(JSON.stringify(second)).not.toContain("song-");
    expect(JSON.parse(await readFile(resolve(item.output, "match-report.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      methodVersion: "scan-original-recovery-v1",
    });
    expect((await stat(resolve(item.output, "review/index.md"))).isFile()).toBe(true);
    const reviewIndex = await readFile(resolve(item.output, "review/index.md"), "utf8");
    const reviewStatuses = [...reviewIndex.matchAll(/^- current-\d{4}: ([a-z_]+)/gmu)]
      .map((match) => match[1]);
    expect(reviewStatuses).toEqual([
      "confirmed_replacement",
      "owner_review_ambiguous",
      "unmatched",
    ]);
    const gallery = await readFile(resolve(item.output, "review/gallery.html"), "utf8");
    expect(gallery.match(/class="review-card"/gu)).toHaveLength(3);
    expect(gallery).toContain("current source | proposed genuine candidate | amplified difference");
    expect(gallery.indexOf("confirmed_replacement"))
      .toBeLessThan(gallery.indexOf("owner_review_ambiguous"));
    expect(gallery).toContain('data-owner-approved="true"');
    expect(gallery).toContain("Confirmed by owner");
    expect(gallery).toContain('id="export-reviews"');
    expect(gallery).toContain("reviewDecision");
    expect(gallery).not.toMatch(/https?:\/\//u);
    expect(gallery).not.toContain(item.root);
    const approval = JSON.parse(await readFile(
      resolve(item.output, "owner-approved-confirmed-replacements.json"),
      "utf8",
    ));
    expect(approval).toMatchObject({
      schemaVersion: 1,
      reportSha256: first.reportSha256,
      ownerDecision: "approved_all_confirmed_replacements",
      count: 1,
    });
    expect(approval.mappings).toHaveLength(1);
    const remaining = await readFile(resolve(item.output, "review/remaining.html"), "utf8");
    expect(remaining.match(/class="review-card"/gu)).toHaveLength(1);
    expect(remaining).toContain("owner_review_ambiguous");
    const deferred = await readFile(resolve(item.output, "review/deferred-unmatched.html"), "utf8");
    expect(deferred.match(/class="review-card"/gu)).toHaveLength(1);
    expect(deferred).toContain('data-status="unmatched"');
    expect((await readdir(resolve(item.output, "feature-cache/current"))).length).toBe(4);
    expect((await readdir(resolve(item.output, "feature-cache/genuine"))).length).toBe(6);
    expect(await hash(resolve(item.currentRoot, "scans/2.jpg"))).toBe(before);
  });

  it("refuses report output outside an ignored private root", async () => {
    const item = await fixture();
    await expect(runScanOriginalRecovery({
      ...item.options,
      outputDirectory: resolve(item.root, "public"),
      writeReport: true,
    })).rejects.toEqual(expect.objectContaining({ code: "output_must_be_private" }));
    await expect(runScanOriginalRecovery({
      ...item.options,
      outputDirectory: resolve(item.root, "legacy/report"),
      writeReport: true,
    })).rejects.toBeInstanceOf(ScanOriginalRecoveryError);
  });

  it("surfaces a uniquely registered asymmetric crop only for experimental owner review", async () => {
    const item = await fixture();
    const options = await addAsymmetricallyCroppedPair(item);
    const baseline = await buildScanOriginalRecoveryReport(options);
    const experimental = await buildScanOriginalRecoveryReport({
      ...options,
      experimentalUnmatched: true,
    });

    expect(baseline.report.methodVersion).toBe("scan-original-recovery-v1");
    expect(experimental.report.methodVersion).toBe("scan-original-recovery-v2");
    expect(baseline.decisions.at(-1)?.status).toBe("unmatched");
    expect(experimental.decisions.at(-1)).toMatchObject({
      status: "owner_review_probable",
      confidenceTier: "probable",
      proposedAction: "owner_review",
      lockedStage: null,
    });
    expect(experimental.decisions.at(-1)?.reasonCodes).toContain(
      "registered_asymmetric_crop_or_shear_match",
    );
  });

  it("keeps duplicate registered candidates ambiguous", async () => {
    const item = await fixture();
    const options = await addAsymmetricallyCroppedPair(item, true);
    const experimental = await buildScanOriginalRecoveryReport({
      ...options,
      experimentalUnmatched: true,
    });

    expect(experimental.decisions.at(-1)).toMatchObject({
      status: "owner_review_ambiguous",
      confidenceTier: "ambiguous",
      proposedAction: "owner_review",
      lockedStage: null,
    });
  });
});
