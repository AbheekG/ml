import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

type ReportDecision = {
  currentToken: string;
  status: string;
  genuineToken: string | null;
};

type GenuineImage = {
  token: string;
  relativePath: string;
  byteSize: number;
  sha256: string;
  width: number;
  height: number;
  format: string;
};

type ReviewRelation = {
  currentToken: string;
  reportStatus: string;
  ownerReview: "issue" | "unreviewed" | "deferred_unmatched";
};

export type UnassignedDriveReviewOptions = {
  outputDirectory: string;
  genuineRoot: string;
  projectRoot?: string;
};

export type UnassignedDriveReviewAggregate = {
  schemaVersion: 1;
  reportSha256: string;
  genuineImageCandidates: number;
  assignedGenuineImages: number;
  unassignedGenuineImages: number;
  previewsWritten: number;
  issueRelations: number;
  unreviewedRelations: number;
  deferredUnmatchedRelations: number;
  sourcesHashVerified: boolean;
  legacyInputsWritten: false;
};

function isWithin(path: string, root: string): boolean {
  const absolute = resolve(path);
  const base = resolve(root);
  return absolute === base || absolute.startsWith(`${base}${sep}`);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function encodeRelativeLink(path: string): string {
  return path.split(sep).map((part) => part === ".." ? part : encodeURIComponent(part)).join("/");
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function writeAtomic(path: string, contents: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.temporary`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function relationLabel(relation: ReviewRelation): string {
  if (relation.ownerReview === "issue") return "Marked incorrect during owner review";
  if (relation.ownerReview === "unreviewed") return "Unreviewed / upside-down comparison";
  return "Weak primary candidate for a deferred unmatched App scan";
}

export async function generateUnassignedDriveReview(
  options: UnassignedDriveReviewOptions,
): Promise<UnassignedDriveReviewAggregate> {
  const projectRoot = resolve(options.projectRoot ?? ".");
  const outputDirectory = resolve(options.outputDirectory);
  const reviewDirectory = resolve(outputDirectory, "unassigned-drive-review");
  const genuineRoot = resolve(options.genuineRoot);
  if (!isWithin(outputDirectory, resolve(projectRoot, "notes/private"))) {
    throw new Error("output_must_be_private");
  }
  if (!isWithin(genuineRoot, resolve(projectRoot, "legacy"))) {
    throw new Error("genuine_root_must_be_legacy_read_only");
  }
  const [reportBytes, confirmationBytes] = await Promise.all([
    readFile(resolve(outputDirectory, "match-report.json")),
    readFile(resolve(outputDirectory, "owner-confirmed-matches.json")),
  ]);
  const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");
  const report = JSON.parse(reportBytes.toString("utf8")) as {
    aggregate: { genuineImageCandidates: number };
    inventories: { genuineImages: GenuineImage[] };
    decisions: ReportDecision[];
  };
  const confirmation = JSON.parse(confirmationBytes.toString("utf8")) as {
    reportSha256: string;
    confirmedMappings: Array<{ currentToken: string; genuineToken: string }>;
    unresolved: Array<{ currentToken: string; genuineToken: string; reviewDecision: string }>;
  };
  if (confirmation.reportSha256 !== reportSha256
    || report.aggregate.genuineImageCandidates !== report.inventories.genuineImages.length) {
    throw new Error("unassigned_review_binding_mismatch");
  }
  const assigned = new Set(confirmation.confirmedMappings.map((mapping) => mapping.genuineToken));
  for (const decision of report.decisions) {
    if (decision.status === "exact_bytes_already_genuine" && decision.genuineToken) {
      assigned.add(decision.genuineToken);
    }
  }
  const unassigned = report.inventories.genuineImages
    .filter((image) => !assigned.has(image.token))
    .sort((left, right) => left.token.localeCompare(right.token, "en"));
  const unresolvedByCurrent = new Map(confirmation.unresolved.map((item) => [item.currentToken, item]));
  const relations = new Map<string, ReviewRelation[]>();
  for (const decision of report.decisions) {
    if (!decision.genuineToken || !unassigned.some((image) => image.token === decision.genuineToken)) continue;
    const owner = unresolvedByCurrent.get(decision.currentToken);
    const ownerReview = owner?.reviewDecision === "issue"
      ? "issue"
      : owner?.reviewDecision === "unreviewed"
        ? "unreviewed"
        : decision.status === "unmatched"
          ? "deferred_unmatched"
          : null;
    if (!ownerReview) continue;
    const current = relations.get(decision.genuineToken) ?? [];
    current.push({ currentToken: decision.currentToken, reportStatus: decision.status, ownerReview });
    relations.set(decision.genuineToken, current);
  }
  await mkdir(reviewDirectory, { recursive: true });
  for (const entry of await readdir(reviewDirectory, { withFileTypes: true })) {
    if (entry.isFile() && /^drive-unassigned-\d{2}\.jpg$/u.test(entry.name)) {
      await rm(resolve(reviewDirectory, entry.name));
    }
  }
  const cards: string[] = [];
  let sourcesHashVerified = true;
  for (let index = 0; index < unassigned.length; index += 1) {
    const image = unassigned[index];
    const sourcePath = resolve(genuineRoot, image.relativePath);
    if (!isWithin(sourcePath, genuineRoot)) throw new Error("unassigned_source_outside_root");
    const sourceStats = await stat(sourcePath);
    const sourceHash = await sha256File(sourcePath);
    if (sourceStats.size !== image.byteSize || sourceHash !== image.sha256) {
      sourcesHashVerified = false;
      throw new Error("unassigned_source_changed");
    }
    const previewName = `drive-unassigned-${String(index + 1).padStart(2, "0")}.jpg`;
    const preview = await sharp(sourcePath, { limitInputPixels: 120_000_000 })
      .rotate()
      .resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "white" })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();
    await writeAtomic(resolve(reviewDirectory, previewName), preview);
    const itemRelations = relations.get(image.token) ?? [];
    const relationHtml = itemRelations.length > 0
      ? `<ul>${itemRelations.map((relation) => {
        const aidPath = resolve(outputDirectory, "review", `${relation.currentToken}.jpg`);
        const aidLink = encodeRelativeLink(relative(reviewDirectory, aidPath));
        return `<li>${escapeHtml(relationLabel(relation))} — <a href="${aidLink}">${escapeHtml(relation.currentToken)} comparison</a></li>`;
      }).join("")}</ul>`
      : "<p>No unresolved App scan currently uses this as its primary candidate. It may still appear among weaker alternatives.</p>";
    const originalLink = encodeRelativeLink(relative(reviewDirectory, sourcePath));
    cards.push(`
      <article>
        <header><span>${index + 1} / ${unassigned.length}</span><strong>Unassigned Drive candidate ${index + 1}</strong></header>
        <a href="${originalLink}" title="Open the read-only original"><img src="${previewName}" alt="Preview of unassigned Drive candidate ${index + 1}" loading="lazy"></a>
        <dl>
          <dt>Filename</dt><dd>${escapeHtml(basename(image.relativePath))}</dd>
          <dt>Path within drive/Final</dt><dd><code>${escapeHtml(image.relativePath)}</code></dd>
          <dt>Original</dt><dd>${escapeHtml(image.format.toUpperCase())}, ${image.width} × ${image.height}, ${formatBytes(image.byteSize)} — <a href="${originalLink}">open file</a></dd>
          <dt>Known primary relationships</dt><dd>${relationHtml}</dd>
        </dl>
      </article>`);
  }
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; connect-src 'none';">
  <title>Unassigned drive/Final scan candidates</title>
  <style>
    :root { color-scheme: light dark; font: 15px/1.45 system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { max-width: 1500px; margin: auto; padding: 1rem; }
    h1 { margin-bottom: .3rem; }
    .intro { margin-top: 0; color: color-mix(in srgb, CanvasText 72%, transparent); }
    main { display: grid; gap: 1.5rem; }
    article { overflow: hidden; border: 1px solid color-mix(in srgb, CanvasText 24%, transparent); border-radius: .6rem; }
    article header { display: flex; gap: 1rem; padding: .7rem 1rem; background: color-mix(in srgb, CanvasText 8%, Canvas); }
    article header span { color: color-mix(in srgb, CanvasText 65%, transparent); }
    article > a { display: block; background: white; text-align: center; }
    img { display: block; width: 100%; max-height: 80vh; object-fit: contain; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: .45rem 1rem; margin: 0; padding: 1rem; }
    dt { font-weight: 700; }
    dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
    ul { margin: 0; padding-left: 1.2rem; }
    code { user-select: all; }
    @media (max-width: 700px) { dl { grid-template-columns: 1fr; } dt { margin-top: .5rem; } }
  </style>
</head>
<body>
  <h1>Seven unassigned drive/Final image candidates</h1>
  <p class="intro">These files are not assigned to the 17 exact or 446 owner-confirmed App mappings. Click a preview to open its unchanged read-only original. Filenames and paths are private and remain only in this ignored report.</p>
  <main>${cards.join("")}</main>
</body>
</html>
`;
  await writeAtomic(resolve(reviewDirectory, "index.html"), html);
  const allRelations = [...relations.values()].flat();
  return {
    schemaVersion: 1,
    reportSha256,
    genuineImageCandidates: report.inventories.genuineImages.length,
    assignedGenuineImages: assigned.size,
    unassignedGenuineImages: unassigned.length,
    previewsWritten: unassigned.length,
    issueRelations: allRelations.filter((item) => item.ownerReview === "issue").length,
    unreviewedRelations: allRelations.filter((item) => item.ownerReview === "unreviewed").length,
    deferredUnmatchedRelations: allRelations.filter((item) => item.ownerReview === "deferred_unmatched").length,
    sourcesHashVerified,
    legacyInputsWritten: false,
  };
}

async function main(): Promise<void> {
  const aggregate = await generateUnassignedDriveReview({
    outputDirectory: resolve("notes/private/scan-original-recovery"),
    genuineRoot: resolve("legacy/drive/Final"),
  });
  process.stdout.write(`${JSON.stringify(aggregate)}\n`);
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (isDirectRun) {
  main().catch((error: unknown) => {
    const code = error instanceof Error ? error.message : "unexpected_error";
    process.stderr.write(`${JSON.stringify({ error: code })}\n`);
    process.exitCode = 1;
  });
}
