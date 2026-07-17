import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseAllowedItems } from "./scan-original-review-server";

type ReviewChoice = "correct" | "issue" | "unsure";

type ExportedReviewState = {
  schemaVersion: 1;
  reportSha256: string;
  scope: "remaining";
  itemCount: number;
  reviewedCount: number;
  updatedAt: string | null;
  decisions: Record<string, ReviewChoice>;
};

type ReportDecision = {
  currentToken: string;
  status: string;
  proposedAction: string;
  genuineToken: string | null;
};

type ReviewImportOptions = {
  inputPath: string;
  outputDirectory: string;
  expectedCorrect: number;
  expectedIssue: number;
  expectedUnreviewed: number;
  writeConfirmation: boolean;
  projectRoot?: string;
};

type ReviewImportAggregate = {
  mode: "dry-run" | "write-confirmation";
  schemaVersion: 1;
  reportSha256: string;
  reviewExportSha256: string;
  originalConfirmed: number;
  additionalConfirmed: number;
  combinedConfirmed: number;
  issues: number;
  unsure: number;
  unreviewed: number;
  currentTokensUnique: boolean;
  genuineTokensUnique: boolean;
  duplicateGenuineHashGroups: number;
  duplicateGenuineHashMappings: number;
  noChangeSafetyHolds: number;
  qualitySafetyHolds: number;
  activationAuthorized: false;
};

function isWithin(path: string, root: string): boolean {
  const absolute = resolve(path);
  const base = resolve(root);
  return absolute === base || absolute.startsWith(`${base}${sep}`);
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.temporary`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseJson<T>(bytes: Buffer, code: string): T {
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    throw new Error(code);
  }
}

function countDuplicates(values: string[]): number {
  return values.length - new Set(values).size;
}

export async function importScanOriginalReview(
  options: ReviewImportOptions,
): Promise<ReviewImportAggregate> {
  const projectRoot = resolve(options.projectRoot ?? ".");
  const outputDirectory = resolve(options.outputDirectory);
  if (!isWithin(outputDirectory, resolve(projectRoot, "notes/private"))) {
    throw new Error("output_must_be_private");
  }
  const [inputBytes, reportBytes, approvalBytes, galleryBytes] = await Promise.all([
    readFile(resolve(options.inputPath)),
    readFile(resolve(outputDirectory, "match-report.json")),
    readFile(resolve(outputDirectory, "owner-approved-confirmed-replacements.json")),
    readFile(resolve(outputDirectory, "review/remaining.html")),
  ]);
  const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");
  const reviewExportSha256 = createHash("sha256").update(inputBytes).digest("hex");
  const exported = parseJson<ExportedReviewState>(inputBytes, "review_export_invalid_json");
  const report = parseJson<{
    decisions: ReportDecision[];
    inventories: { genuineImages: Array<{ token: string; sha256: string }> };
  }>(reportBytes, "report_invalid_json");
  const originalApproval = parseJson<{
    reportSha256: string;
    count: number;
    mappings: Array<{ currentToken: string; genuineToken: string }>;
  }>(approvalBytes, "owner_approval_invalid_json");
  const allowed = parseAllowedItems(galleryBytes.toString("utf8"));
  if (exported.schemaVersion !== 1 || exported.scope !== "remaining"
    || exported.reportSha256 !== reportSha256 || exported.itemCount !== allowed.size
    || originalApproval.reportSha256 !== reportSha256
    || originalApproval.count !== originalApproval.mappings.length
    || !Number.isInteger(exported.reviewedCount)
    || typeof exported.decisions !== "object" || exported.decisions === null) {
    throw new Error("review_export_report_mismatch");
  }
  const valid = new Set<ReviewChoice>(["correct", "issue", "unsure"]);
  for (const [token, decision] of Object.entries(exported.decisions)) {
    if (!allowed.has(token) || !valid.has(decision)) throw new Error("review_export_invalid_decision");
  }
  if (Object.keys(exported.decisions).length !== exported.reviewedCount) {
    throw new Error("review_export_count_mismatch");
  }
  const byCurrent = new Map(report.decisions.map((decision) => [decision.currentToken, decision]));
  const byGenuine = new Map(report.inventories.genuineImages.map((item) => [item.token, item]));
  for (const [token, status] of allowed) {
    if (byCurrent.get(token)?.status !== status.matchStatus) {
      throw new Error("review_export_status_mismatch");
    }
  }
  const tokenGroups = { correct: [] as string[], issue: [] as string[], unsure: [] as string[], unreviewed: [] as string[] };
  for (const token of allowed.keys()) {
    const decision = exported.decisions[token] ?? "unreviewed";
    tokenGroups[decision].push(token);
  }
  if (tokenGroups.correct.length !== options.expectedCorrect
    || tokenGroups.issue.length !== options.expectedIssue
    || tokenGroups.unreviewed.length !== options.expectedUnreviewed) {
    throw new Error("review_export_expected_counts_mismatch");
  }
  const mappingFor = (token: string, confirmationSource: string) => {
    const decision = byCurrent.get(token);
    if (!decision?.genuineToken || !byGenuine.has(decision.genuineToken)) {
      throw new Error("review_export_candidate_missing");
    }
    return {
      currentToken: token,
      genuineToken: decision.genuineToken,
      reportStatus: decision.status,
      proposedAction: decision.proposedAction,
      confirmationSource,
    };
  };
  const originalMappings = originalApproval.mappings.map((mapping) => {
    const expected = mappingFor(mapping.currentToken, "original_confirmed_replacement");
    if (expected.genuineToken !== mapping.genuineToken || expected.reportStatus !== "confirmed_replacement") {
      throw new Error("owner_approval_mapping_mismatch");
    }
    return expected;
  });
  const additionalMappings = tokenGroups.correct.map((token) =>
    mappingFor(token, "remaining_review_correct"));
  const combinedMappings = [...originalMappings, ...additionalMappings];
  const currentTokensUnique = countDuplicates(combinedMappings.map((item) => item.currentToken)) === 0;
  const genuineTokensUnique = countDuplicates(combinedMappings.map((item) => item.genuineToken)) === 0;
  if (!currentTokensUnique || !genuineTokensUnique) throw new Error("confirmed_mapping_not_one_to_one");
  const mappingsByHash = new Map<string, typeof combinedMappings>();
  for (const mapping of combinedMappings) {
    const hash = byGenuine.get(mapping.genuineToken)!.sha256;
    const group = mappingsByHash.get(hash) ?? [];
    group.push(mapping);
    mappingsByHash.set(hash, group);
  }
  const duplicateHashGroups = [...mappingsByHash.entries()].filter(([, mappings]) => mappings.length > 1);
  const noChangeHolds = additionalMappings.filter((item) =>
    item.reportStatus === "confirmed_visual_equivalent_no_change");
  const qualityHolds = additionalMappings.filter((item) => item.reportStatus === "owner_review_quality");
  const unresolved = (tokens: string[], reviewDecision: "issue" | "unsure" | "unreviewed") =>
    tokens.map((token) => ({ ...mappingFor(token, `remaining_review_${reviewDecision}`), reviewDecision }));
  const confirmation = {
    schemaVersion: 1,
    reportSha256,
    reviewExportSha256,
    ownerDecision: "confirm_all_remaining_review_items_marked_correct",
    counts: {
      originalConfirmed: originalMappings.length,
      additionalConfirmed: additionalMappings.length,
      combinedConfirmed: combinedMappings.length,
      issues: tokenGroups.issue.length,
      unsure: tokenGroups.unsure.length,
      unreviewed: tokenGroups.unreviewed.length,
    },
    confirmedMappings: combinedMappings,
    unresolved: [
      ...unresolved(tokenGroups.issue, "issue"),
      ...unresolved(tokenGroups.unsure, "unsure"),
      ...unresolved(tokenGroups.unreviewed, "unreviewed"),
    ],
    safetyHolds: {
      retainCurrentNoChange: noChangeHolds,
      qualityRegression: qualityHolds,
      duplicateGenuineHashes: duplicateHashGroups.map(([sha256, mappings]) => ({ sha256, mappings })),
    },
    invariants: {
      exactReportBinding: true,
      exactReviewScope: true,
      currentTokensUnique,
      genuineTokensUnique,
      genuineHashesUnique: duplicateHashGroups.length === 0,
      activationAuthorized: false,
    },
  };
  const normalizedState: ExportedReviewState = {
    schemaVersion: 1,
    reportSha256,
    scope: "remaining",
    itemCount: allowed.size,
    reviewedCount: exported.reviewedCount,
    updatedAt: exported.updatedAt,
    decisions: Object.fromEntries(Object.entries(exported.decisions).sort(([left], [right]) =>
      left.localeCompare(right, "en"))),
  };
  if (options.writeConfirmation) {
    await Promise.all([
      writeAtomic(
        resolve(outputDirectory, "owner-confirmed-matches.json"),
        `${JSON.stringify(confirmation, null, 2)}\n`,
      ),
      writeAtomic(
        resolve(outputDirectory, "review-state-remaining.json"),
        `${JSON.stringify(normalizedState, null, 2)}\n`,
      ),
    ]);
  }
  return {
    mode: options.writeConfirmation ? "write-confirmation" : "dry-run",
    schemaVersion: 1,
    reportSha256,
    reviewExportSha256,
    originalConfirmed: originalMappings.length,
    additionalConfirmed: additionalMappings.length,
    combinedConfirmed: combinedMappings.length,
    issues: tokenGroups.issue.length,
    unsure: tokenGroups.unsure.length,
    unreviewed: tokenGroups.unreviewed.length,
    currentTokensUnique,
    genuineTokensUnique,
    duplicateGenuineHashGroups: duplicateHashGroups.length,
    duplicateGenuineHashMappings: duplicateHashGroups.reduce((total, [, mappings]) => total + mappings.length, 0),
    noChangeSafetyHolds: noChangeHolds.length,
    qualitySafetyHolds: qualityHolds.length,
    activationAuthorized: false,
  };
}

function parseArguments(arguments_: string[]): ReviewImportOptions {
  let inputPath = "";
  let outputDirectory = resolve("notes/private/scan-original-recovery");
  let expectedCorrect = -1;
  let expectedIssue = -1;
  let expectedUnreviewed = -1;
  let writeConfirmation = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const next = arguments_[index + 1];
    if (argument === "--input" && next) {
      inputPath = resolve(next);
      index += 1;
    } else if (argument === "--output" && next) {
      outputDirectory = resolve(next);
      index += 1;
    } else if (argument === "--expect-correct" && next) {
      expectedCorrect = Number(next);
      index += 1;
    } else if (argument === "--expect-issue" && next) {
      expectedIssue = Number(next);
      index += 1;
    } else if (argument === "--expect-unreviewed" && next) {
      expectedUnreviewed = Number(next);
      index += 1;
    } else if (argument === "--write-confirmation") {
      writeConfirmation = true;
    } else {
      throw new Error("invalid_argument");
    }
  }
  if (!inputPath || ![expectedCorrect, expectedIssue, expectedUnreviewed].every(Number.isInteger)
    || expectedCorrect < 0 || expectedIssue < 0 || expectedUnreviewed < 0) {
    throw new Error("missing_expected_review_counts");
  }
  return {
    inputPath,
    outputDirectory,
    expectedCorrect,
    expectedIssue,
    expectedUnreviewed,
    writeConfirmation,
  };
}

async function main(): Promise<void> {
  const aggregate = await importScanOriginalReview(parseArguments(process.argv.slice(2)));
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
