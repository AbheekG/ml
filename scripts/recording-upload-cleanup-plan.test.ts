import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRecordingUploadCleanupPlan,
  classifyCleanupItem,
  parseArguments,
  RecordingUploadCleanupError,
  summarizeRecordingUploadCleanupPlan,
  writePrivateCleanupReport,
  type CommandRunner,
  type ObjectObserver,
  type R2Observation,
  type UploadSession,
} from "./recording-upload-cleanup-plan";

const now = new Date("2026-07-17T12:00:00.000Z");
const oldTimestamp = "2026-06-01T12:00:00.000Z";
const recentTimestamp = "2026-07-16T12:00:00.000Z";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

function session(overrides: Partial<UploadSession> = {}): UploadSession {
  const sessionId = overrides.sessionId ?? "session-1";
  return {
    sessionId,
    objectKey: `recordings/original/${sessionId}`,
    status: "failed",
    byteSize: 12,
    sha256: hashA,
    errorCode: "user_discarded",
    updatedAt: oldTimestamp,
    r2UploadId: "multipart-id",
    duplicateMediaId: null,
    recordingId: null,
    intentCount: 1,
    mediaReferenceCount: 0,
    ...overrides,
  };
}

function d1Row(value: UploadSession): Record<string, unknown> {
  return {
    row_type: "session",
    session_id: value.sessionId,
    object_key: value.objectKey,
    status: value.status,
    byte_size: value.byteSize,
    sha256: value.sha256,
    error_code: value.errorCode,
    updated_at: value.updatedAt,
    r2_upload_id: value.r2UploadId,
    duplicate_media_id: value.duplicateMediaId,
    recording_id: value.recordingId,
    intent_count: value.intentCount,
    media_reference_count: value.mediaReferenceCount,
    foreign_key_errors: 0,
  };
}

function runnerFor(values: UploadSession[], foreignKeyErrors = 0): CommandRunner {
  return async (_executable, args) => ({
    exitCode: args.includes("execute") ? 0 : 1,
    stdout: JSON.stringify([{
      success: true,
      results: [
        {
          row_type: "meta",
          foreign_key_errors: foreignKeyErrors,
        },
        ...values.map(d1Row),
      ],
    }]),
    stderr: "",
  });
}

function observerFor(values: Record<string, R2Observation>): {
  observer: ObjectObserver;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    observer: async (_bucket, objectKey) => {
      calls.push(objectKey);
      const value = values[objectKey];
      if (!value) throw new Error("unexpected object observation");
      return value;
    },
  };
}

describe("recording upload object cleanup planner", () => {
  it("marks only an old, exact, unreferenced discarded object eligible", () => {
    const value = session();
    const result = classifyCleanupItem(
      value,
      { status: "present", byteSize: 12, sha256: hashA },
      "2026-06-17T12:00:00.000Z",
    );
    expect(result).toMatchObject({ decision: "eligible", reasons: [] });
  });

  it("fails closed for every incomplete eligibility fact", () => {
    const cases: Array<{
      value: UploadSession;
      observation?: R2Observation;
      reason: string;
      decision?: "manual_review" | "already_absent";
    }> = [
      { value: session({ status: "aborted", sha256: null }), reason: "session_not_failed" },
      { value: session({ errorCode: "storage_hash_mismatch" }), reason: "error_not_user_discarded" },
      { value: session({ r2UploadId: null }), reason: "missing_completed_upload" },
      { value: session({ sha256: null }), reason: "missing_sha256" },
      { value: session({ recordingId: "recording-1" }), reason: "recording_reference_present" },
      { value: session({ duplicateMediaId: "media-1" }), reason: "duplicate_reference_present" },
      { value: session({ mediaReferenceCount: 1 }), reason: "media_reference_present" },
      { value: session({ intentCount: 0 }), reason: "missing_upload_intent" },
      { value: session({ updatedAt: recentTimestamp }), reason: "grace_period_not_elapsed" },
      {
        value: session(),
        observation: { status: "present", byteSize: 11, sha256: hashA },
        reason: "r2_byte_size_mismatch",
      },
      {
        value: session(),
        observation: { status: "present", byteSize: 12, sha256: hashB },
        reason: "r2_sha256_mismatch",
      },
      {
        value: session(),
        observation: { status: "missing" },
        reason: "r2_object_missing",
        decision: "already_absent",
      },
    ];
    for (const testCase of cases) {
      const result = classifyCleanupItem(
        testCase.value,
        testCase.observation ?? { status: "present", byteSize: 12, sha256: hashA },
        "2026-06-17T12:00:00.000Z",
      );
      expect(result.decision).toBe(testCase.decision ?? "manual_review");
      expect(result.reasons).toContain(testCase.reason);
    }
  });

  it("queries all sessions but probes only failed and aborted object keys", async () => {
    const failed = session({ sessionId: "failed-session" });
    const aborted = session({
      sessionId: "aborted-session",
      status: "aborted",
      sha256: null,
      errorCode: null,
      r2UploadId: null,
    });
    const finalized = session({
      sessionId: "finalized-session",
      status: "finalized",
      errorCode: null,
      recordingId: "recording-1",
    });
    const open = session({
      sessionId: "open-session",
      status: "open",
      sha256: null,
      errorCode: null,
    });
    const observations = observerFor({
      [failed.objectKey]: { status: "present", byteSize: 12, sha256: hashA },
      [aborted.objectKey]: { status: "missing" },
    });
    const plan = await buildRecordingUploadCleanupPlan(
      {
        database: "music-library-staging-apac",
        bucket: "music-library-media-staging",
        graceDays: 30,
      },
      runnerFor([failed, aborted, finalized, open]),
      observations.observer,
      now,
    );
    expect(plan.totalUploadSessions).toBe(4);
    expect(plan.items).toHaveLength(2);
    expect(observations.calls).toEqual([failed.objectKey, aborted.objectKey]);
    expect(plan.items.map((item) => item.decision)).toEqual(["eligible", "already_absent"]);
    expect(plan.planSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects malformed snapshots and foreign-key drift before R2 reads", async () => {
    const value = session({ objectKey: "recordings/original/not-the-session" });
    const observer = async () => {
      throw new Error("must not observe R2");
    };
    await expect(buildRecordingUploadCleanupPlan(
      {
        database: "music-library-staging-apac",
        bucket: "music-library-media-staging",
        graceDays: 30,
      },
      runnerFor([value]),
      observer,
      now,
    )).rejects.toMatchObject({ code: "invalid_upload_object_key" });
    await expect(buildRecordingUploadCleanupPlan(
      {
        database: "music-library-staging-apac",
        bucket: "music-library-media-staging",
        graceDays: 30,
      },
      runnerFor([], 1),
      observer,
      now,
    )).rejects.toMatchObject({ code: "d1_foreign_key_errors" });
  });

  it("emits only aggregate summary fields and keeps detailed reports private", async () => {
    const value = session({ sessionId: "private-session-token" });
    const observations = observerFor({
      [value.objectKey]: { status: "present", byteSize: 12, sha256: hashA },
    });
    const plan = await buildRecordingUploadCleanupPlan(
      {
        database: "music-library-staging-apac",
        bucket: "music-library-media-staging",
        graceDays: 30,
      },
      runnerFor([value]),
      observations.observer,
      now,
    );
    const summary = summarizeRecordingUploadCleanupPlan(plan, true);
    const rendered = JSON.stringify(summary);
    expect(rendered).not.toContain("private-session-token");
    expect(rendered).not.toContain(hashA);
    expect(rendered).not.toContain("recordings/original");

    const root = await mkdtemp(join(tmpdir(), "upload-cleanup-test-"));
    try {
      const reportPath = join(root, "notes/private/plan.json");
      await writePrivateCleanupReport(plan, reportPath, root);
      const metadata = await stat(reportPath);
      expect(metadata.mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
        planSha256: plan.planSha256,
        items: [expect.objectContaining({ sessionId: "private-session-token" })],
      });
      await expect(writePrivateCleanupReport(
        plan,
        join(root, "public-plan.json"),
        root,
      )).rejects.toMatchObject({ code: "cleanup_report_must_be_private" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces the grace floor and exposes no deletion mode", () => {
    expect(parseArguments([])).toMatchObject({ graceDays: 30, writeReport: false });
    expect(parseArguments(["--grace-days", "7", "--write-report"]))
      .toMatchObject({ graceDays: 7, writeReport: true });
    for (const args of [
      ["--grace-days", "6"],
      ["--delete"],
      ["--write"],
      ["--report-path", "notes/private/plan.json"],
    ]) {
      expect(() => parseArguments(args)).toThrow(RecordingUploadCleanupError);
    }
  });
});
