import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

type ReportDecision = {
  currentToken: string;
  status: string;
  proposedAction: string;
  genuineToken: string | null;
};

type GenuineImage = {
  token: string;
  relativePath: string;
  byteSize: number;
  sha256: string;
};

type ConfirmedMapping = {
  currentToken: string;
  genuineToken: string;
  reportStatus: string;
  proposedAction: string;
  confirmationSource: string;
  sourceTransform?: {
    preserveOriginalBytes: true;
    displayRotationDegrees: 180;
  };
};

type UnresolvedMapping = ConfirmedMapping & {
  reviewDecision: "issue" | "unsure" | "unreviewed";
};

type FeedbackOptions = {
  outputDirectory: string;
  genuineRoot: string;
  projectRoot?: string;
};

export type FeedbackAggregate = {
  schemaVersion: 1;
  reviewedCandidates: 7;
  ignoredCandidates: 3;
  laterManualUploadCandidates: 3;
  rotatedConfirmedCandidates: 1;
  combinedConfirmed: number;
  issuesRemaining: number;
  unreviewedRemaining: number;
  deferredUnmatchedRemaining: number;
  unassignedGenuineImagesRemaining: number;
  legacyInputsWritten: false;
  activationAuthorized: false;
};

function isWithin(path: string, root: string): boolean {
  const absolute = resolve(path);
  const base = resolve(root);
  return absolute === base || absolute.startsWith(`${base}${sep}`);
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

export async function applyUnassignedDriveFeedback(options: FeedbackOptions): Promise<FeedbackAggregate> {
  const projectRoot = resolve(options.projectRoot ?? ".");
  const outputDirectory = resolve(options.outputDirectory);
  const genuineRoot = resolve(options.genuineRoot);
  if (!isWithin(outputDirectory, resolve(projectRoot, "notes/private"))) {
    throw new Error("output_must_be_private");
  }
  if (!isWithin(genuineRoot, resolve(projectRoot, "legacy"))) {
    throw new Error("genuine_root_must_be_legacy_read_only");
  }
  const [reportBytes, confirmationBytes, stateBytes] = await Promise.all([
    readFile(resolve(outputDirectory, "match-report.json")),
    readFile(resolve(outputDirectory, "owner-confirmed-matches.json")),
    readFile(resolve(outputDirectory, "review-state-remaining.json")),
  ]);
  const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");
  const report = JSON.parse(reportBytes.toString("utf8")) as {
    inventories: { genuineImages: GenuineImage[] };
    decisions: ReportDecision[];
  };
  const confirmation = JSON.parse(confirmationBytes.toString("utf8")) as {
    schemaVersion: 1;
    reportSha256: string;
    reviewExportSha256: string;
    ownerDecision: string;
    counts: {
      originalConfirmed: number;
      additionalConfirmed: number;
      combinedConfirmed: number;
      issues: number;
      unsure: number;
      unreviewed: number;
    };
    confirmedMappings: ConfirmedMapping[];
    unresolved: UnresolvedMapping[];
    safetyHolds: Record<string, unknown>;
    invariants: Record<string, boolean>;
    unassignedDriveFeedbackSha256?: string;
  };
  const state = JSON.parse(stateBytes.toString("utf8")) as {
    schemaVersion: 1;
    reportSha256: string;
    scope: "remaining";
    itemCount: number;
    reviewedCount: number;
    updatedAt: string | null;
    decisions: Record<string, "correct" | "issue" | "unsure">;
    ownerFeedbackDate?: string;
  };
  if (confirmation.reportSha256 !== reportSha256 || state.reportSha256 !== reportSha256
    || confirmation.invariants.activationAuthorized !== false) {
    throw new Error("feedback_binding_mismatch");
  }
  if (confirmation.unassignedDriveFeedbackSha256) {
    const feedbackBytes = await readFile(resolve(outputDirectory, "owner-unassigned-drive-decisions.json"));
    const feedbackSha256 = createHash("sha256").update(feedbackBytes).digest("hex");
    const appliedTransforms = confirmation.confirmedMappings.filter((mapping) =>
      mapping.confirmationSource === "unassigned_drive_candidate_6_rotate_180"
      && mapping.sourceTransform?.preserveOriginalBytes === true
      && mapping.sourceTransform.displayRotationDegrees === 180);
    if (feedbackSha256 !== confirmation.unassignedDriveFeedbackSha256
      || confirmation.counts.combinedConfirmed !== confirmation.confirmedMappings.length
      || confirmation.counts.unreviewed !== 0 || appliedTransforms.length !== 1) {
      throw new Error("existing_feedback_mismatch");
    }
    return {
      schemaVersion: 1,
      reviewedCandidates: 7,
      ignoredCandidates: 3,
      laterManualUploadCandidates: 3,
      rotatedConfirmedCandidates: 1,
      combinedConfirmed: confirmation.counts.combinedConfirmed,
      issuesRemaining: confirmation.counts.issues,
      unreviewedRemaining: confirmation.counts.unreviewed,
      deferredUnmatchedRemaining: report.decisions.filter((item) => item.status === "unmatched").length,
      unassignedGenuineImagesRemaining: report.inventories.genuineImages.length
        - new Set([
          ...confirmation.confirmedMappings.map((item) => item.genuineToken),
          ...report.decisions.filter((item) => item.status === "exact_bytes_already_genuine").map((item) => item.genuineToken!),
        ]).size,
      legacyInputsWritten: false,
      activationAuthorized: false,
    };
  }
  const assigned = new Set(confirmation.confirmedMappings.map((mapping) => mapping.genuineToken));
  for (const decision of report.decisions) {
    if (decision.status === "exact_bytes_already_genuine" && decision.genuineToken) assigned.add(decision.genuineToken);
  }
  const unassigned = report.inventories.genuineImages
    .filter((image) => !assigned.has(image.token))
    .sort((left, right) => left.token.localeCompare(right.token, "en"));
  if (unassigned.length !== 7) throw new Error("unexpected_unassigned_candidate_count");
  for (const image of unassigned) {
    const sourcePath = resolve(genuineRoot, image.relativePath);
    if (!isWithin(sourcePath, genuineRoot)) throw new Error("feedback_source_outside_root");
    const [sourceStats, sourceHash] = await Promise.all([stat(sourcePath), sha256File(sourcePath)]);
    if (sourceStats.size !== image.byteSize || sourceHash !== image.sha256) {
      throw new Error("feedback_source_changed");
    }
  }
  const rotateCandidate = unassigned[5];
  const relatedUnresolved = confirmation.unresolved.filter((item) => item.genuineToken === rotateCandidate.token);
  const unreviewed = relatedUnresolved.filter((item) => item.reviewDecision === "unreviewed");
  const issue = relatedUnresolved.filter((item) => item.reviewDecision === "issue");
  if (unreviewed.length !== 1 || issue.length !== 1) {
    throw new Error("rotate_candidate_relationship_mismatch");
  }
  const target = unreviewed[0];
  const targetReport = report.decisions.find((item) => item.currentToken === target.currentToken);
  if (!targetReport || targetReport.genuineToken !== rotateCandidate.token) {
    throw new Error("rotate_target_mismatch");
  }
  const decisions = unassigned.map((image, index) => {
    const ordinal = index + 1;
    const base = { ordinal, genuineToken: image.token, genuineSha256: image.sha256 };
    if (ordinal === 1) return { ...base, ownerDisposition: "ignore", reason: "old_version_better_copy_already_present" };
    if (ordinal === 2 || ordinal === 3) return { ...base, ownerDisposition: "ignore", reason: "owner_rejected_for_current_library" };
    if (ordinal === 4 || ordinal === 5 || ordinal === 7) {
      return { ...base, ownerDisposition: "later_manual_upload", reason: "related_to_song_but_not_current_scan" };
    }
    return {
      ...base,
      ownerDisposition: "confirm_existing_scan",
      currentToken: target.currentToken,
      sourceTransform: { preserveOriginalBytes: true, displayRotationDegrees: 180 },
    };
  });
  const feedback = {
    schemaVersion: 1,
    reportSha256,
    ownerDecisionDate: "2026-07-17",
    inspectionScope: { candidates: 7, order: "opaque_genuine_token_ascending" },
    decisions,
    invariants: {
      allCandidatesDecided: decisions.length === 7,
      sourceHashesVerified: true,
      legacyInputsWritten: false,
      activationAuthorized: false,
    },
  };
  const feedbackJson = `${JSON.stringify(feedback, null, 2)}\n`;
  const feedbackSha256 = createHash("sha256").update(feedbackJson).digest("hex");
  const confirmedTarget: ConfirmedMapping = {
    currentToken: target.currentToken,
    genuineToken: target.genuineToken,
    reportStatus: target.reportStatus,
    proposedAction: target.proposedAction,
    confirmationSource: "unassigned_drive_candidate_6_rotate_180",
    sourceTransform: { preserveOriginalBytes: true, displayRotationDegrees: 180 },
  };
  const nextMappings = [...confirmation.confirmedMappings, confirmedTarget];
  if (new Set(nextMappings.map((item) => item.currentToken)).size !== nextMappings.length
    || new Set(nextMappings.map((item) => item.genuineToken)).size !== nextMappings.length) {
    throw new Error("feedback_mapping_not_one_to_one");
  }
  const nextUnresolved = confirmation.unresolved.filter((item) => item.currentToken !== target.currentToken);
  const nextConfirmation = {
    ...confirmation,
    unassignedDriveFeedbackSha256: feedbackSha256,
    counts: {
      ...confirmation.counts,
      additionalConfirmed: confirmation.counts.additionalConfirmed + 1,
      combinedConfirmed: confirmation.counts.combinedConfirmed + 1,
      unreviewed: confirmation.counts.unreviewed - 1,
    },
    confirmedMappings: nextMappings,
    unresolved: nextUnresolved,
    safetyHolds: {
      ...confirmation.safetyHolds,
      displayTransformRequired: [confirmedTarget],
    },
    invariants: {
      ...confirmation.invariants,
      currentTokensUnique: true,
      genuineTokensUnique: true,
      activationAuthorized: false,
    },
  };
  const nextState = {
    ...state,
    reviewedCount: state.reviewedCount + 1,
    ownerFeedbackDate: "2026-07-17",
    decisions: Object.fromEntries(Object.entries({
      ...state.decisions,
      [target.currentToken]: "correct",
    }).sort(([left], [right]) => left.localeCompare(right, "en"))),
  };
  if (Object.keys(nextState.decisions).length !== nextState.reviewedCount
    || nextState.reviewedCount !== nextState.itemCount) {
    throw new Error("feedback_state_count_mismatch");
  }
  const sourcePath = resolve(genuineRoot, rotateCandidate.relativePath);
  const rotatedPreview = await sharp(sourcePath, { limitInputPixels: 120_000_000 })
    .rotate(180)
    .resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "white" })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
  await writeAtomic(
    resolve(outputDirectory, "unassigned-drive-review/drive-unassigned-06.jpg"),
    rotatedPreview,
  );
  await writeAtomic(resolve(outputDirectory, "owner-unassigned-drive-decisions.json"), feedbackJson);
  await writeAtomic(
    resolve(outputDirectory, "review-state-remaining.json"),
    `${JSON.stringify(nextState, null, 2)}\n`,
  );
  await writeAtomic(
    resolve(outputDirectory, "owner-confirmed-matches.json"),
    `${JSON.stringify(nextConfirmation, null, 2)}\n`,
  );
  return {
    schemaVersion: 1,
    reviewedCandidates: 7,
    ignoredCandidates: 3,
    laterManualUploadCandidates: 3,
    rotatedConfirmedCandidates: 1,
    combinedConfirmed: nextConfirmation.counts.combinedConfirmed,
    issuesRemaining: nextConfirmation.counts.issues,
    unreviewedRemaining: nextConfirmation.counts.unreviewed,
    deferredUnmatchedRemaining: report.decisions.filter((item) => item.status === "unmatched").length,
    unassignedGenuineImagesRemaining: unassigned.length - 1,
    legacyInputsWritten: false,
    activationAuthorized: false,
  };
}

async function main(): Promise<void> {
  const aggregate = await applyUnassignedDriveFeedback({
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
