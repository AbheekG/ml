import { describe, expect, it } from "vitest";
import {
  buildProcessorOpsSnapshot,
  buildProcessorOpsSnapshotSummary,
  ProcessorOpsSnapshotError,
  type CommandRunner,
  main,
} from "./processor-ops-snapshot";

const nowMilliseconds = Date.now();
const nowIso = new Date(nowMilliseconds).toISOString();
const tenMinutesAgoIso = new Date(nowMilliseconds - (10 * 60 * 1000)).toISOString();
const twoHoursAgoIso = new Date(nowMilliseconds - (2 * 60 * 60 * 1000)).toISOString();
const twoDaysAgoIso = new Date(nowMilliseconds - (48 * 60 * 60 * 1000)).toISOString();

function runnerFromMap(map: Record<string, unknown>): CommandRunner {
  return async (_executable, args) => {
    const key = args.join(" ");
    for (const [needle, value] of Object.entries(map)) {
      if (key.includes(needle)) {
        if (
          value !== null
          && typeof value === "object"
          && "__rawStdout" in (value as Record<string, unknown>)
          && typeof (value as Record<string, unknown>).__rawStdout === "string"
        ) {
          return {
            exitCode: 0,
            stdout: (value as { __rawStdout: string }).__rawStdout,
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(value)}\n`,
          stderr: "",
        };
      }
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `unexpected_command:${key}`,
    };
  };
}

const schedulerDescribe = {
  state: "PAUSED",
  schedule: "*/15 * * * *",
  lastAttemptTime: tenMinutesAgoIso,
  scheduleTime: twoHoursAgoIso,
  attemptDeadline: "30s",
  retryConfig: { maxRetryAttempts: 0 },
  httpTarget: {
    uri: "https://run.googleapis.com/v2/projects/music-library-audio-staging/locations/asia-south1/jobs/music-audio-processor:run",
    oauthToken: {
      serviceAccountEmail: "music-audio-scheduler@music-library-audio-staging.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/cloud-platform",
    },
  },
};

const runJobDescribe = {
  metadata: { name: "music-audio-processor" },
  status: {
    executionCount: 8,
    latestCreatedExecution: {
      name: "music-audio-processor-ndjpc",
      completionStatus: "EXECUTION_SUCCEEDED",
    },
  },
  spec: {
    template: {
      spec: {
        template: {
          spec: {
            containers: [
              {
                image: "asia-south1-docker.pkg.dev/music-library-audio-staging/music-audio/processor@sha256:test",
              },
            ],
          },
        },
      },
    },
  },
};

const executionsList = [
  {
    metadata: { name: "music-audio-processor-a", creationTimestamp: nowIso },
    status: {
      startTime: nowIso,
      completionTime: nowIso,
      conditions: [{ type: "Completed", status: "True" }],
    },
  },
  {
    metadata: { name: "music-audio-processor-b", creationTimestamp: twoHoursAgoIso },
    status: {
      startTime: twoHoursAgoIso,
      completionTime: twoHoursAgoIso,
      conditions: [{ type: "Completed", status: "True" }],
    },
  },
];

const stdoutLogs = [
  {
    timestamp: nowIso,
    jsonPayload: {
      elapsedMilliseconds: 820,
      outcome: "no_work",
      policyId: "mp3-v1-libmp3lame-q2",
    },
  },
  {
    timestamp: twoHoursAgoIso,
    jsonPayload: {
      elapsedMilliseconds: 1320,
      outcome: "succeeded",
      policyId: "mp3-v1-libmp3lame-q2",
      playbackKind: "derivative",
    },
  },
];

const systemLogs = [
  {
    timestamp: nowIso,
    textPayload: "Container called exit(0).",
  },
  {
    timestamp: twoHoursAgoIso,
    textPayload: "Container called exit(0).",
  },
];

const d1Json = [
  {
    success: true,
    results: [
      {
        total_jobs: 1,
        pending_jobs: 0,
        running_jobs: 0,
        succeeded_jobs: 1,
        failed_jobs: 0,
        started_dispatch_attempts: 0,
        failed_dispatch_attempts: 0,
        stale_dispatch_attempts: 0,
        recoverable_upload_sessions: 0,
        unclassified_upload_sessions: 0,
        active_unclassified_upload_sessions: 0,
        missing_scan_hashes: 0,
        missing_scan_derivatives: 0,
        scan_maintenance_failures: 0,
        expired_scan_maintenance_leases: 0,
        foreign_key_errors: 0,
      },
    ],
  },
];

const artifactDescribe = {
  sizeBytes: 429709000,
};

const schedulerList = [{ name: "music-audio-processor-quarter-hour" }];

describe("processor ops snapshot", () => {
  it("builds an aggregate snapshot with expected fields", async () => {
    const runner = runnerFromMap({
      "scheduler jobs describe": schedulerDescribe,
      "run jobs describe": runJobDescribe,
      "run jobs executions list": executionsList,
      "logs/run.googleapis.com%2Fstdout": stdoutLogs,
      "logs/run.googleapis.com%2Fvarlog%2Fsystem": systemLogs,
      "wrangler d1 execute": d1Json,
      "artifacts repositories describe": artifactDescribe,
      "scheduler jobs list": schedulerList,
    });

    const snapshot = await buildProcessorOpsSnapshot({
      projectId: "music-library-audio-staging",
      region: "asia-south1",
      runJob: "music-audio-processor",
      schedulerJob: "music-audio-processor-quarter-hour",
      d1Database: "music-library-staging-apac",
      artifactRepo: "music-audio",
      stdoutLimit: 200,
      systemLimit: 120,
      executionLimit: 200,
      alertLookbackHours: 24,
      summary: false,
      includeExecutionDetails: true,
      enforce: false,
    }, runner);

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.scheduler.state).toBe("PAUSED");
    expect(snapshot.runJob.executionCount).toBe(8);
    expect(snapshot.executions.totalObserved).toBe(2);
    expect(snapshot.executions.byStatus.EXECUTION_SUCCEEDED).toBe(2);
    expect(snapshot.logs.stdout.byOutcome.no_work).toBe(1);
    expect(snapshot.logs.stdout.byOutcome.succeeded).toBe(1);
    expect(snapshot.logs.system.exitLines["Container called exit(0)."]).toBe(2);
    expect(snapshot.d1.foreignKeyErrors).toBe(0);
    expect(snapshot.d1.missingScanDerivatives).toBe(0);
    expect(snapshot.costSurface.artifactRepoSizeBytes).toBe(429709000);
    expect(snapshot.costSurface.schedulerJobsCount).toBe(1);
    expect(snapshot.alerts.some((alert) => alert.code === "scheduler_paused")).toBe(true);
  });

  it("surfaces durable dispatch, upload-intent, and Scan-maintenance drift", async () => {
    const driftedD1 = structuredClone(d1Json);
    Object.assign(driftedD1[0].results[0], {
      stale_dispatch_attempts: 1,
      unclassified_upload_sessions: 2,
      active_unclassified_upload_sessions: 2,
      missing_scan_hashes: 3,
      missing_scan_derivatives: 4,
      scan_maintenance_failures: 1,
      expired_scan_maintenance_leases: 1,
    });
    const runner = runnerFromMap({
      "scheduler jobs describe": { ...schedulerDescribe, state: "ENABLED" },
      "run jobs describe": runJobDescribe,
      "run jobs executions list": executionsList,
      "logs/run.googleapis.com%2Fstdout": stdoutLogs,
      "logs/run.googleapis.com%2Fvarlog%2Fsystem": systemLogs,
      "wrangler d1 execute": driftedD1,
      "artifacts repositories describe": artifactDescribe,
      "scheduler jobs list": schedulerList,
    });

    const snapshot = await buildProcessorOpsSnapshot({
      projectId: "music-library-audio-staging",
      region: "asia-south1",
      runJob: "music-audio-processor",
      schedulerJob: "music-audio-processor-quarter-hour",
      d1Database: "music-library-staging-apac",
      artifactRepo: "music-audio",
      stdoutLimit: 200,
      systemLimit: 120,
      executionLimit: 200,
      alertLookbackHours: 24,
      summary: false,
      includeExecutionDetails: false,
      enforce: false,
    }, runner);

    expect(snapshot.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "d1_stale_audio_dispatch_attempts", severity: "warning" }),
      expect.objectContaining({ code: "d1_unclassified_upload_sessions", severity: "warning" }),
      expect.objectContaining({ code: "d1_missing_scan_hashes", severity: "warning" }),
      expect.objectContaining({ code: "d1_scan_maintenance_incomplete", severity: "warning" }),
      expect.objectContaining({ code: "d1_expired_scan_maintenance_leases", severity: "warning" }),
    ]));
  });

  it("keeps terminal pre-intent upload history informational", async () => {
    const historicalD1 = structuredClone(d1Json);
    Object.assign(historicalD1[0].results[0], {
      unclassified_upload_sessions: 8,
      active_unclassified_upload_sessions: 0,
    });
    const runner = runnerFromMap({
      "scheduler jobs describe": { ...schedulerDescribe, state: "ENABLED" },
      "run jobs describe": runJobDescribe,
      "run jobs executions list": executionsList,
      "logs/run.googleapis.com%2Fstdout": stdoutLogs,
      "logs/run.googleapis.com%2Fvarlog%2Fsystem": systemLogs,
      "wrangler d1 execute": historicalD1,
      "artifacts repositories describe": artifactDescribe,
      "scheduler jobs list": schedulerList,
    });

    const snapshot = await buildProcessorOpsSnapshot({
      projectId: "music-library-audio-staging",
      region: "asia-south1",
      runJob: "music-audio-processor",
      schedulerJob: "music-audio-processor-quarter-hour",
      d1Database: "music-library-staging-apac",
      artifactRepo: "music-audio",
      stdoutLimit: 200,
      systemLimit: 120,
      executionLimit: 200,
      alertLookbackHours: 24,
      summary: false,
      includeExecutionDetails: false,
      enforce: false,
    }, runner);

    expect(snapshot.d1.unclassifiedUploadSessions).toBe(8);
    expect(snapshot.d1.activeUnclassifiedUploadSessions).toBe(0);
    expect(snapshot.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "d1_unclassified_upload_sessions_historical",
        severity: "info",
      }),
    ]));
    expect(snapshot.alerts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "d1_unclassified_upload_sessions", severity: "warning" }),
    ]));
  });

  it("flags non-aggregate stdout payload shapes as critical", async () => {
    const runner = runnerFromMap({
      "scheduler jobs describe": { ...schedulerDescribe, state: "ENABLED" },
      "run jobs describe": runJobDescribe,
      "run jobs executions list": executionsList,
      "logs/run.googleapis.com%2Fstdout": [
        {
          timestamp: nowIso,
          jsonPayload: {
            elapsedMilliseconds: 820,
            outcome: "no_work",
            policyId: "mp3-v1-libmp3lame-q2",
            privateUrl: "https://example.invalid/private",
          },
        },
      ],
      "logs/run.googleapis.com%2Fvarlog%2Fsystem": systemLogs,
      "wrangler d1 execute": d1Json,
      "artifacts repositories describe": artifactDescribe,
      "scheduler jobs list": schedulerList,
    });

    const snapshot = await buildProcessorOpsSnapshot({
      projectId: "music-library-audio-staging",
      region: "asia-south1",
      runJob: "music-audio-processor",
      schedulerJob: "music-audio-processor-quarter-hour",
      d1Database: "music-library-staging-apac",
      artifactRepo: "music-audio",
      stdoutLimit: 200,
      systemLimit: 120,
      executionLimit: 200,
      alertLookbackHours: 24,
      summary: false,
      includeExecutionDetails: false,
      enforce: false,
    }, runner);

    expect(snapshot.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "stdout_non_aggregate_shape",
          severity: "critical",
        }),
      ]),
    );
  });

  it("main returns non-zero with --enforce when critical alerts exist", async () => {
    const originalEnv = process.env;
    const commands: Array<{ executable: string; args: string[] }> = [];
    try {
      process.env = { ...originalEnv };
      const runner = runnerFromMap({
        "scheduler jobs describe": { ...schedulerDescribe, state: "ENABLED" },
        "run jobs describe": runJobDescribe,
        "run jobs executions list": executionsList,
        "logs/run.googleapis.com%2Fstdout": [
          {
            timestamp: nowIso,
            jsonPayload: {
              elapsedMilliseconds: 820,
              outcome: "no_work",
              policyId: "mp3-v1-libmp3lame-q2",
              unexpected: "x",
            },
          },
        ],
        "logs/run.googleapis.com%2Fvarlog%2Fsystem": systemLogs,
        "wrangler d1 execute": d1Json,
        "artifacts repositories describe": artifactDescribe,
        "scheduler jobs list": schedulerList,
      });

      const code = await (async () => {
        const module = await import("./processor-ops-snapshot");
        return await module.buildProcessorOpsSnapshot({
          projectId: "music-library-audio-staging",
          region: "asia-south1",
          runJob: "music-audio-processor",
          schedulerJob: "music-audio-processor-quarter-hour",
          d1Database: "music-library-staging-apac",
          artifactRepo: "music-audio",
          stdoutLimit: 200,
          systemLimit: 120,
          executionLimit: 200,
          alertLookbackHours: 24,
          summary: false,
          includeExecutionDetails: false,
          enforce: true,
        }, async (executable, args) => {
          commands.push({ executable, args });
          return await runner(executable, args);
        });
      })();

      const critical = code.alerts.some((alert) => alert.severity === "critical");
      expect(critical).toBe(true);
      expect(commands.length).toBeGreaterThan(0);
    } finally {
      process.env = originalEnv;
    }
  });

  it("throws on malformed D1 json shape", async () => {
    const runner = runnerFromMap({
      "scheduler jobs describe": schedulerDescribe,
      "run jobs describe": runJobDescribe,
      "run jobs executions list": executionsList,
      "logs/run.googleapis.com%2Fstdout": stdoutLogs,
      "logs/run.googleapis.com%2Fvarlog%2Fsystem": systemLogs,
      "wrangler d1 execute": [{ success: true, results: [] }],
      "artifacts repositories describe": artifactDescribe,
      "scheduler jobs list": schedulerList,
    });

    await expect(buildProcessorOpsSnapshot({
      projectId: "music-library-audio-staging",
      region: "asia-south1",
      runJob: "music-audio-processor",
      schedulerJob: "music-audio-processor-quarter-hour",
      d1Database: "music-library-staging-apac",
      artifactRepo: "music-audio",
      stdoutLimit: 200,
      systemLimit: 120,
      executionLimit: 200,
      alertLookbackHours: 24,
      summary: false,
      includeExecutionDetails: true,
      enforce: false,
    }, runner)).rejects.toBeInstanceOf(ProcessorOpsSnapshotError);
  });

  it("main parses unknown args as failures", async () => {
    await expect(main(["--unknown-option"]))
      .rejects.toBeInstanceOf(ProcessorOpsSnapshotError);
  });

  it("downgrades historical failed outcomes and exits to info outside lookback", async () => {
    const runner = runnerFromMap({
      "scheduler jobs describe": { ...schedulerDescribe, state: "ENABLED" },
      "run jobs describe": runJobDescribe,
      "run jobs executions list": executionsList,
      "logs/run.googleapis.com%2Fstdout": [
        {
          timestamp: twoDaysAgoIso,
          jsonPayload: {
            elapsedMilliseconds: 250,
            outcome: "failed",
            errorCode: "historical_only",
            policyId: "mp3-v1-libmp3lame-q2",
          },
        },
      ],
      "logs/run.googleapis.com%2Fvarlog%2Fsystem": [
        {
          timestamp: twoDaysAgoIso,
          textPayload: "Container called exit(1).",
        },
      ],
      "wrangler d1 execute": d1Json,
      "artifacts repositories describe": artifactDescribe,
      "scheduler jobs list": schedulerList,
    });

    const snapshot = await buildProcessorOpsSnapshot({
      projectId: "music-library-audio-staging",
      region: "asia-south1",
      runJob: "music-audio-processor",
      schedulerJob: "music-audio-processor-quarter-hour",
      d1Database: "music-library-staging-apac",
      artifactRepo: "music-audio",
      stdoutLimit: 200,
      systemLimit: 120,
      executionLimit: 200,
      alertLookbackHours: 24,
      summary: false,
      includeExecutionDetails: false,
      enforce: false,
    }, runner);

    expect(snapshot.alerts.some((alert) => alert.code === "stdout_failed_outcomes_present")).toBe(false);
    expect(snapshot.alerts.some((alert) => alert.code === "system_non_zero_exit_lines")).toBe(false);
    expect(snapshot.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "stdout_failed_outcomes_historical", severity: "info" }),
        expect.objectContaining({ code: "system_non_zero_exit_lines_historical", severity: "info" }),
      ]),
    );
  });

  it("parses JSON from noisy CLI output with leading/trailing text", async () => {
    const noisyScheduler = {
      __rawStdout: `NOTICE: using cached auth context\n${JSON.stringify(schedulerDescribe)}\nDone.\n`,
    };
    const noisyD1 = {
      __rawStdout: `-- wrangler output --\n${JSON.stringify(d1Json)}\ncompleted\n`,
    };

    const runner = runnerFromMap({
      "scheduler jobs describe": noisyScheduler,
      "run jobs describe": runJobDescribe,
      "run jobs executions list": executionsList,
      "logs/run.googleapis.com%2Fstdout": stdoutLogs,
      "logs/run.googleapis.com%2Fvarlog%2Fsystem": systemLogs,
      "wrangler d1 execute": noisyD1,
      "artifacts repositories describe": artifactDescribe,
      "scheduler jobs list": schedulerList,
    });

    const snapshot = await buildProcessorOpsSnapshot({
      projectId: "music-library-audio-staging",
      region: "asia-south1",
      runJob: "music-audio-processor",
      schedulerJob: "music-audio-processor-quarter-hour",
      d1Database: "music-library-staging-apac",
      artifactRepo: "music-audio",
      stdoutLimit: 200,
      systemLimit: 120,
      executionLimit: 200,
      alertLookbackHours: 24,
      summary: false,
      includeExecutionDetails: false,
      enforce: false,
    }, runner);

    expect(snapshot.scheduler.state).toBe("PAUSED");
    expect(snapshot.d1.totalJobs).toBe(1);
    expect(snapshot.d1.foreignKeyErrors).toBe(0);
  });

  it("builds compact summary output with severity counts", async () => {
    const runner = runnerFromMap({
      "scheduler jobs describe": schedulerDescribe,
      "run jobs describe": runJobDescribe,
      "run jobs executions list": executionsList,
      "logs/run.googleapis.com%2Fstdout": [
        {
          timestamp: nowIso,
          jsonPayload: {
            elapsedMilliseconds: 100,
            outcome: "failed",
            errorCode: "recent_failure",
            policyId: "mp3-v1-libmp3lame-q2",
          },
        },
      ],
      "logs/run.googleapis.com%2Fvarlog%2Fsystem": [
        {
          timestamp: nowIso,
          textPayload: "Container called exit(1).",
        },
      ],
      "wrangler d1 execute": d1Json,
      "artifacts repositories describe": artifactDescribe,
      "scheduler jobs list": schedulerList,
    });

    const snapshot = await buildProcessorOpsSnapshot({
      projectId: "music-library-audio-staging",
      region: "asia-south1",
      runJob: "music-audio-processor",
      schedulerJob: "music-audio-processor-quarter-hour",
      d1Database: "music-library-staging-apac",
      artifactRepo: "music-audio",
      stdoutLimit: 200,
      systemLimit: 120,
      executionLimit: 200,
      alertLookbackHours: 24,
      summary: true,
      includeExecutionDetails: false,
      enforce: false,
    }, runner);

    const summary = buildProcessorOpsSnapshotSummary(snapshot);
    expect(summary.schedulerState).toBe("PAUSED");
    expect(summary.runJob.executionCount).toBe(8);
    expect(summary.d1.totalJobs).toBe(1);
    expect(summary.alertCounts.warning).toBeGreaterThan(0);
    expect(summary.alertCounts.info).toBeGreaterThan(0);
    expect(summary.alertCounts.critical).toBe(0);
  });
});
