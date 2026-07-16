import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type JsonObject = Record<string, unknown>;

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (
  executable: string,
  args: string[],
) => Promise<CommandResult>;

export type ProcessorOpsSnapshotOptions = {
  projectId: string;
  region: string;
  runJob: string;
  schedulerJob: string;
  d1Database: string;
  artifactRepo: string;
  stdoutLimit: number;
  systemLimit: number;
  executionLimit: number;
  alertLookbackHours: number;
  summary: boolean;
  includeExecutionDetails: boolean;
  enforce: boolean;
};

export type ProcessorOpsSnapshot = {
  schemaVersion: 1;
  capturedAt: string;
  scheduler: {
    state: string;
    schedule: string;
    lastAttemptTime: string | null;
    nextScheduleTime: string | null;
    attemptDeadline: string | null;
    maxRetryAttempts: number | null;
    targetUri: string | null;
    oauthServiceAccountEmail: string | null;
    oauthScope: string | null;
  };
  runJob: {
    name: string;
    executionCount: number;
    latestExecutionName: string | null;
    latestExecutionCompletionStatus: string | null;
    image: string | null;
  };
  executions: {
    totalObserved: number;
    byStatus: Record<string, number>;
    latest: Array<{
      name: string;
      status: string;
      createTime: string | null;
      startTime: string | null;
      completionTime: string | null;
    }>;
  };
  logs: {
    stdout: {
      totalEntries: number;
      aggregateEntries: number;
      byOutcome: Record<string, number>;
      keyShapes: Record<string, number>;
      latest: Array<{
        timestamp: string | null;
        outcome: string;
        policyId: string | null;
        keys: string[];
      }>;
    };
    system: {
      totalEntries: number;
      exitLines: Record<string, number>;
      latest: Array<{
        timestamp: string | null;
        text: string;
      }>;
    };
  };
  d1: {
    totalJobs: number;
    pendingJobs: number;
    runningJobs: number;
    succeededJobs: number;
    failedJobs: number;
    startedDispatchAttempts: number;
    failedDispatchAttempts: number;
    staleDispatchAttempts: number;
    recoverableUploadSessions: number;
    unclassifiedUploadSessions: number;
    missingScanHashes: number;
    missingScanDerivatives: number;
    scanMaintenanceFailures: number;
    expiredScanMaintenanceLeases: number;
    foreignKeyErrors: number;
  };
  costSurface: {
    artifactRepoSizeBytes: number | null;
    schedulerJobsCount: number;
  };
  alerts: Array<{
    code: string;
    severity: "critical" | "warning" | "info";
    detail: string;
  }>;
};

export type ProcessorOpsSnapshotSummary = {
  schemaVersion: 1;
  capturedAt: string;
  schedulerState: string;
  runJob: {
    name: string;
    executionCount: number;
    latestExecutionCompletionStatus: string | null;
  };
  d1: ProcessorOpsSnapshot["d1"];
  alerts: ProcessorOpsSnapshot["alerts"];
  alertCounts: Record<"critical" | "warning" | "info", number>;
};

export class ProcessorOpsSnapshotError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
  }
}

const DEFAULT_OPTIONS: ProcessorOpsSnapshotOptions = {
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
};

const ALLOWED_STDOUT_KEY_SHAPES = new Set([
  "elapsedMilliseconds,outcome,policyId",
  "elapsedMilliseconds,outcome,playbackKind,policyId",
  "elapsedMilliseconds,errorCode,outcome,policyId",
]);

function objectValue(value: unknown, code: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProcessorOpsSnapshotError(code);
  }
  return value as JsonObject;
}

function arrayValue(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) throw new ProcessorOpsSnapshotError(code);
  return value;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value)) throw new ProcessorOpsSnapshotError(code);
  return value as number;
}

function mapCounts(values: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], "en")));
}

function parseJson(text: string, code: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const extracted = extractJsonFragment(text);
    if (extracted !== null) {
      try {
        return JSON.parse(extracted);
      } catch {
        throw new ProcessorOpsSnapshotError(code);
      }
    }
    throw new ProcessorOpsSnapshotError(code);
  }
}

function extractJsonFragment(text: string): string | null {
  for (let start = 0; start < text.length; start += 1) {
    const first = text[start];
    if (first !== "{" && first !== "[") continue;

    const stack: string[] = [first === "{" ? "}" : "]"];
    let inString = false;
    let escaping = false;

    for (let index = start + 1; index < text.length; index += 1) {
      const character = text[index];

      if (inString) {
        if (escaping) {
          escaping = false;
          continue;
        }
        if (character === "\\") {
          escaping = true;
          continue;
        }
        if (character === '"') {
          inString = false;
        }
        continue;
      }

      if (character === '"') {
        inString = true;
        continue;
      }

      if (character === "{") {
        stack.push("}");
        continue;
      }
      if (character === "[") {
        stack.push("]");
        continue;
      }

      const expected = stack[stack.length - 1];
      if (character === expected) {
        stack.pop();
        if (stack.length === 0) {
          return text.slice(start, index + 1);
        }
      }
    }
  }
  return null;
}

function latestFirst<T>(values: T[], key: (value: T) => string | null): T[] {
  return [...values].sort((left, right) => {
    const leftKey = key(left) ?? "";
    const rightKey = key(right) ?? "";
    return rightKey.localeCompare(leftKey, "en");
  });
}

function isoToMilliseconds(value: string | null): number | null {
  if (value === null) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return milliseconds;
}

function withinLookbackWindow(
  timestamp: string | null,
  capturedAtMilliseconds: number,
  lookbackHours: number,
): boolean {
  const timestampMilliseconds = isoToMilliseconds(timestamp);
  if (timestampMilliseconds === null) return false;
  const lookbackMilliseconds = lookbackHours * 60 * 60 * 1000;
  return timestampMilliseconds >= (capturedAtMilliseconds - lookbackMilliseconds)
    && timestampMilliseconds <= capturedAtMilliseconds;
}

export async function runCommand(
  executable: string,
  args: string[],
): Promise<CommandResult> {
  return await new Promise((resolvePromise) => {
    const child = spawn(executable, args, {
      cwd: resolve("."),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      stderr += error.message;
    });
    child.on("close", (exitCode) => {
      resolvePromise({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

async function runJsonCommand(
  runner: CommandRunner,
  executable: string,
  args: string[],
  code: string,
): Promise<unknown> {
  const result = await runner(executable, args);
  if (result.exitCode !== 0) {
    throw new ProcessorOpsSnapshotError(code, result.stderr.trim() || result.stdout.trim());
  }
  return parseJson(result.stdout, code);
}

function executionStatus(row: JsonObject): string {
  const explicit = stringOrNull(row.completionStatus);
  if (explicit !== null && explicit.length > 0) return explicit;
  const status = objectValue(row.status ?? {}, "invalid_execution_status");
  const conditions = arrayValue(status.conditions ?? [], "invalid_execution_conditions");
  const completed = conditions
    .map((item) => objectValue(item, "invalid_execution_condition"))
    .find((condition) => condition.type === "Completed");
  if (completed === undefined) return "UNKNOWN";
  const completedStatus = stringOrNull(completed.status);
  if (completedStatus === "True") return "EXECUTION_SUCCEEDED";
  if (completedStatus === "False") return "EXECUTION_FAILED";
  if (completedStatus === "Unknown") return "EXECUTION_RUNNING";
  return "UNKNOWN";
}

function executionName(row: JsonObject): string {
  const top = stringOrNull(row.name);
  if (top !== null) return top;
  const metadata = objectValue(row.metadata ?? {}, "invalid_execution_metadata");
  const nested = stringOrNull(metadata.name);
  if (nested !== null) return nested;
  throw new ProcessorOpsSnapshotError("invalid_execution_name");
}

function stdoutEntry(row: JsonObject): {
  timestamp: string | null;
  outcome: string;
  policyId: string | null;
  keys: string[];
} | null {
  const payloadUnknown = row.jsonPayload;
  if (payloadUnknown === undefined || payloadUnknown === null) return null;
  const payload = objectValue(payloadUnknown, "invalid_stdout_payload");
  const outcome = stringOrNull(payload.outcome);
  if (outcome === null) return null;
  const keys = Object.keys(payload).sort((left, right) => left.localeCompare(right, "en"));
  return {
    timestamp: stringOrNull(row.timestamp),
    outcome,
    policyId: stringOrNull(payload.policyId),
    keys,
  };
}

function d1ResultRow(raw: unknown): JsonObject {
  const root = arrayValue(raw, "invalid_d1_json_root");
  if (root.length !== 1) throw new ProcessorOpsSnapshotError("invalid_d1_json_count");
  const statement = objectValue(root[0], "invalid_d1_json_statement");
  if (statement.success !== true) {
    throw new ProcessorOpsSnapshotError("d1_query_unsuccessful");
  }
  const results = arrayValue(statement.results, "invalid_d1_json_results");
  if (results.length !== 1) {
    throw new ProcessorOpsSnapshotError("invalid_d1_result_rows");
  }
  return objectValue(results[0], "invalid_d1_result_row");
}

export function evaluateAlerts(snapshot: Omit<ProcessorOpsSnapshot, "alerts">): ProcessorOpsSnapshot["alerts"] {
  const alerts: ProcessorOpsSnapshot["alerts"] = [];
  if (snapshot.d1.foreignKeyErrors > 0) {
    alerts.push({
      code: "d1_foreign_key_errors",
      severity: "critical",
      detail: `foreignKeyErrors=${snapshot.d1.foreignKeyErrors}`,
    });
  }
  if (snapshot.d1.runningJobs > 0) {
    alerts.push({
      code: "d1_running_jobs_present",
      severity: "warning",
      detail: `runningJobs=${snapshot.d1.runningJobs}`,
    });
  }
  if (snapshot.d1.pendingJobs > 0) {
    alerts.push({
      code: "d1_pending_jobs_present",
      severity: "warning",
      detail: `pendingJobs=${snapshot.d1.pendingJobs}`,
    });
  }
  if (snapshot.d1.staleDispatchAttempts > 0) {
    alerts.push({
      code: "d1_stale_audio_dispatch_attempts",
      severity: "warning",
      detail: `staleDispatchAttempts=${snapshot.d1.staleDispatchAttempts}`,
    });
  }
  if (snapshot.d1.unclassifiedUploadSessions > 0) {
    alerts.push({
      code: "d1_unclassified_upload_sessions",
      severity: "warning",
      detail: `unclassifiedUploadSessions=${snapshot.d1.unclassifiedUploadSessions}`,
    });
  }
  if (snapshot.d1.missingScanHashes > 0) {
    alerts.push({
      code: "d1_missing_scan_hashes",
      severity: "warning",
      detail: `missingScanHashes=${snapshot.d1.missingScanHashes}`,
    });
  }
  if (snapshot.d1.missingScanDerivatives > 0 || snapshot.d1.scanMaintenanceFailures > 0) {
    alerts.push({
      code: "d1_scan_maintenance_incomplete",
      severity: "warning",
      detail: `missingDerivatives=${snapshot.d1.missingScanDerivatives},failures=${snapshot.d1.scanMaintenanceFailures}`,
    });
  }
  if (snapshot.d1.expiredScanMaintenanceLeases > 0) {
    alerts.push({
      code: "d1_expired_scan_maintenance_leases",
      severity: "warning",
      detail: `expiredScanMaintenanceLeases=${snapshot.d1.expiredScanMaintenanceLeases}`,
    });
  }

  const badShapes = Object.entries(snapshot.logs.stdout.keyShapes)
    .filter(([shape]) => !ALLOWED_STDOUT_KEY_SHAPES.has(shape));
  if (badShapes.length > 0) {
    alerts.push({
      code: "stdout_non_aggregate_shape",
      severity: "critical",
      detail: badShapes.map(([shape, count]) => `${shape}:${count}`).join(","),
    });
  }

  const failedOutcomes = snapshot.logs.stdout.byOutcome.failed ?? 0;
  if (failedOutcomes > 0) {
    alerts.push({
      code: "stdout_failed_outcomes_present",
      severity: "warning",
      detail: `failedOutcomes=${failedOutcomes}`,
    });
  }

  const nonZeroExits = Object.entries(snapshot.logs.system.exitLines)
    .filter(([line]) => line !== "Container called exit(0).");
  if (nonZeroExits.length > 0) {
    alerts.push({
      code: "system_non_zero_exit_lines",
      severity: "warning",
      detail: nonZeroExits.map(([line, count]) => `${line}:${count}`).join(","),
    });
  }

  if (snapshot.scheduler.state === "PAUSED") {
    alerts.push({
      code: "scheduler_paused",
      severity: "info",
      detail: "scheduler is paused",
    });
  }

  return alerts;
}

export function evaluateAlertsWithLookback(
  snapshot: Omit<ProcessorOpsSnapshot, "alerts">,
  options: Pick<ProcessorOpsSnapshotOptions, "alertLookbackHours">,
): ProcessorOpsSnapshot["alerts"] {
  const alerts = evaluateAlerts({
    ...snapshot,
    logs: {
      ...snapshot.logs,
      stdout: {
        ...snapshot.logs.stdout,
        byOutcome: {},
      },
      system: {
        ...snapshot.logs.system,
        exitLines: {},
      },
    },
  });

  const capturedAtMilliseconds = isoToMilliseconds(snapshot.capturedAt);
  if (capturedAtMilliseconds === null) {
    throw new ProcessorOpsSnapshotError("invalid_captured_at");
  }

  const recentStdoutEntries = snapshot.logs.stdout.latest
    .filter((entry) => withinLookbackWindow(entry.timestamp, capturedAtMilliseconds, options.alertLookbackHours));
  const recentByOutcome = mapCounts(recentStdoutEntries.map((entry) => entry.outcome));

  const recentSystemEntries = snapshot.logs.system.latest
    .filter((entry) => withinLookbackWindow(entry.timestamp, capturedAtMilliseconds, options.alertLookbackHours));

  const recentExitLines = mapCounts(
    recentSystemEntries
      .map((entry) => entry.text)
      .filter((line) => line.startsWith("Container called exit(")),
  );

  const recentFailedOutcomes = recentByOutcome.failed ?? 0;
  if (recentFailedOutcomes > 0) {
    alerts.push({
      code: "stdout_failed_outcomes_present",
      severity: "warning",
      detail: `failedOutcomes=${recentFailedOutcomes},lookbackHours=${options.alertLookbackHours}`,
    });
  } else {
    const totalFailedOutcomes = snapshot.logs.stdout.byOutcome.failed ?? 0;
    if (totalFailedOutcomes > 0) {
      alerts.push({
        code: "stdout_failed_outcomes_historical",
        severity: "info",
        detail: `historicalFailedOutcomes=${totalFailedOutcomes},lookbackHours=${options.alertLookbackHours}`,
      });
    }
  }

  const recentNonZeroExits = Object.entries(recentExitLines)
    .filter(([line]) => line !== "Container called exit(0).");
  if (recentNonZeroExits.length > 0) {
    alerts.push({
      code: "system_non_zero_exit_lines",
      severity: "warning",
      detail: `${recentNonZeroExits.map(([line, count]) => `${line}:${count}`).join(",")},lookbackHours=${options.alertLookbackHours}`,
    });
  } else {
    const historicalNonZeroExits = Object.entries(snapshot.logs.system.exitLines)
      .filter(([line]) => line !== "Container called exit(0).");
    if (historicalNonZeroExits.length > 0) {
      alerts.push({
        code: "system_non_zero_exit_lines_historical",
        severity: "info",
        detail: `${historicalNonZeroExits.map(([line, count]) => `${line}:${count}`).join(",")},lookbackHours=${options.alertLookbackHours}`,
      });
    }
  }

  return alerts;
}

export function buildProcessorOpsSnapshotSummary(
  snapshot: ProcessorOpsSnapshot,
): ProcessorOpsSnapshotSummary {
  const alertCounts: ProcessorOpsSnapshotSummary["alertCounts"] = {
    critical: 0,
    warning: 0,
    info: 0,
  };
  for (const alert of snapshot.alerts) {
    alertCounts[alert.severity] += 1;
  }

  return {
    schemaVersion: snapshot.schemaVersion,
    capturedAt: snapshot.capturedAt,
    schedulerState: snapshot.scheduler.state,
    runJob: {
      name: snapshot.runJob.name,
      executionCount: snapshot.runJob.executionCount,
      latestExecutionCompletionStatus: snapshot.runJob.latestExecutionCompletionStatus,
    },
    d1: snapshot.d1,
    alerts: snapshot.alerts,
    alertCounts,
  };
}

export async function buildProcessorOpsSnapshot(
  options: ProcessorOpsSnapshotOptions,
  runner: CommandRunner = runCommand,
): Promise<ProcessorOpsSnapshot> {
  const schedulerUnknown = await runJsonCommand(
    runner,
    "gcloud",
    [
      "scheduler",
      "jobs",
      "describe",
      options.schedulerJob,
      "--project",
      options.projectId,
      "--location",
      options.region,
      "--format=json",
    ],
    "scheduler_describe_failed",
  );
  const scheduler = objectValue(schedulerUnknown, "invalid_scheduler_json");

  const runJobUnknown = await runJsonCommand(
    runner,
    "gcloud",
    [
      "run",
      "jobs",
      "describe",
      options.runJob,
      "--project",
      options.projectId,
      "--region",
      options.region,
      "--format=json",
    ],
    "run_job_describe_failed",
  );
  const runJob = objectValue(runJobUnknown, "invalid_run_job_json");

  const executionsUnknown = await runJsonCommand(
    runner,
    "gcloud",
    [
      "run",
      "jobs",
      "executions",
      "list",
      "--job",
      options.runJob,
      "--project",
      options.projectId,
      "--region",
      options.region,
      "--limit",
      String(options.executionLimit),
      "--format=json",
    ],
    "run_executions_list_failed",
  );
  const executionRows = arrayValue(executionsUnknown, "invalid_executions_json")
    .map((item) => objectValue(item, "invalid_execution_row"));

  const stdoutUnknown = await runJsonCommand(
    runner,
    "gcloud",
    [
      "logging",
      "read",
      `resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"${options.runJob}\" AND resource.labels.location=\"${options.region}\" AND logName=\"projects/${options.projectId}/logs/run.googleapis.com%2Fstdout\"`,
      "--project",
      options.projectId,
      "--limit",
      String(options.stdoutLimit),
      "--format=json",
    ],
    "stdout_logs_read_failed",
  );
  const stdoutRows = arrayValue(stdoutUnknown, "invalid_stdout_logs_json")
    .map((item) => objectValue(item, "invalid_stdout_log_row"));

  const systemUnknown = await runJsonCommand(
    runner,
    "gcloud",
    [
      "logging",
      "read",
      `resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"${options.runJob}\" AND resource.labels.location=\"${options.region}\" AND logName=\"projects/${options.projectId}/logs/run.googleapis.com%2Fvarlog%2Fsystem\"`,
      "--project",
      options.projectId,
      "--limit",
      String(options.systemLimit),
      "--format=json",
    ],
    "system_logs_read_failed",
  );
  const systemRows = arrayValue(systemUnknown, "invalid_system_logs_json")
    .map((item) => objectValue(item, "invalid_system_log_row"));

  const d1Unknown = await runJsonCommand(
    runner,
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      options.d1Database,
      "--remote",
      "--json",
      "--command",
      "SELECT COUNT(*) AS total_jobs, COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS pending_jobs, COALESCE(SUM(CASE WHEN status='running' THEN 1 ELSE 0 END),0) AS running_jobs, COALESCE(SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END),0) AS succeeded_jobs, COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failed_jobs, (SELECT COUNT(*) FROM audio_processing_dispatch_attempts WHERE status='started') AS started_dispatch_attempts, (SELECT COUNT(*) FROM audio_processing_dispatch_attempts WHERE status='failed') AS failed_dispatch_attempts, (SELECT COUNT(*) FROM audio_processing_dispatch_attempts WHERE status='started' AND requested_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')) AS stale_dispatch_attempts, (SELECT COUNT(*) FROM recording_upload_sessions WHERE status IN ('open','completing','stored','duplicate')) AS recoverable_upload_sessions, (SELECT COUNT(*) FROM recording_upload_sessions LEFT JOIN recording_upload_intents ON recording_upload_intents.session_id=recording_upload_sessions.id WHERE recording_upload_intents.session_id IS NULL) AS unclassified_upload_sessions, (SELECT COUNT(*) FROM media_objects WHERE kind='scan' AND sha256 IS NULL) AS missing_scan_hashes, (SELECT COUNT(*) FROM media_objects LEFT JOIN scan_readability_derivatives ON scan_readability_derivatives.source_media_id=media_objects.id WHERE media_objects.kind='scan' AND scan_readability_derivatives.source_media_id IS NULL) AS missing_scan_derivatives, (SELECT COUNT(*) FROM scan_maintenance_failures) AS scan_maintenance_failures, (SELECT COUNT(*) FROM scan_maintenance_leases WHERE lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS expired_scan_maintenance_leases, (SELECT COUNT(*) FROM pragma_foreign_key_check) AS foreign_key_errors FROM audio_processing_jobs;",
    ],
    "d1_query_failed",
  );
  const d1Row = d1ResultRow(d1Unknown);

  const artifactUnknown = await runJsonCommand(
    runner,
    "gcloud",
    [
      "artifacts",
      "repositories",
      "describe",
      options.artifactRepo,
      "--location",
      options.region,
      "--format=json",
    ],
    "artifact_describe_failed",
  );
  const artifact = objectValue(artifactUnknown, "invalid_artifact_json");

  const schedulerListUnknown = await runJsonCommand(
    runner,
    "gcloud",
    [
      "scheduler",
      "jobs",
      "list",
      "--project",
      options.projectId,
      "--location",
      options.region,
      "--format=json",
    ],
    "scheduler_list_failed",
  );
  const schedulerList = arrayValue(schedulerListUnknown, "invalid_scheduler_list_json");

  const executionRowsWithStatus = executionRows.map((row) => {
    const status = executionStatus(row);
    const statusObject = objectValue(row.status ?? {}, "invalid_execution_status_object");
    const metadata = objectValue(row.metadata ?? {}, "invalid_execution_metadata_object");
    return {
      name: executionName(row),
      status,
      createTime: stringOrNull(row.createTime) ?? stringOrNull(metadata.creationTimestamp),
      startTime: stringOrNull(row.startTime) ?? stringOrNull(statusObject.startTime),
      completionTime: stringOrNull(row.completionTime) ?? stringOrNull(statusObject.completionTime),
    };
  });

  const stdoutAggregateEntries = stdoutRows
    .map(stdoutEntry)
    .filter((entry): entry is NonNullable<ReturnType<typeof stdoutEntry>> => entry !== null);

  const systemExitLines = systemRows
    .map((row) => stringOrNull(row.textPayload) ?? "")
    .filter((line) => line.startsWith("Container called exit("));

  const capturedAt = new Date().toISOString();

  const spec = objectValue(runJob.spec ?? {}, "invalid_run_job_spec");
  const template = objectValue(spec.template ?? {}, "invalid_run_job_template");
  const templateSpec = objectValue(template.spec ?? {}, "invalid_run_job_template_spec");
  const nestedTemplate = objectValue(templateSpec.template ?? {}, "invalid_run_job_nested_template");
  const nestedSpec = objectValue(nestedTemplate.spec ?? {}, "invalid_run_job_nested_spec");
  const containers = arrayValue(nestedSpec.containers ?? [], "invalid_run_job_containers");
  const firstContainer = containers.length > 0
    ? objectValue(containers[0], "invalid_run_job_container")
    : {};

  const runStatus = objectValue(runJob.status ?? {}, "invalid_run_job_status");
  const latestCreatedExecution = objectValue(
    runStatus.latestCreatedExecution ?? {},
    "invalid_latest_created_execution",
  );

  const snapshotBase: Omit<ProcessorOpsSnapshot, "alerts"> = {
    schemaVersion: 1,
    capturedAt,
    scheduler: {
      state: stringOrNull(scheduler.state) ?? "UNKNOWN",
      schedule: stringOrNull(scheduler.schedule) ?? "",
      lastAttemptTime: stringOrNull(scheduler.lastAttemptTime),
      nextScheduleTime: stringOrNull(scheduler.scheduleTime),
      attemptDeadline: stringOrNull(scheduler.attemptDeadline),
      maxRetryAttempts: parseInteger(
        objectValue(scheduler.retryConfig ?? {}, "invalid_scheduler_retry_config").maxRetryAttempts ?? 0,
        "invalid_scheduler_max_retries",
      ),
      targetUri: stringOrNull(objectValue(scheduler.httpTarget ?? {}, "invalid_scheduler_http_target").uri),
      oauthServiceAccountEmail: stringOrNull(
        objectValue(
          objectValue(scheduler.httpTarget ?? {}, "invalid_scheduler_http_target").oauthToken ?? {},
          "invalid_scheduler_oauth",
        ).serviceAccountEmail,
      ),
      oauthScope: stringOrNull(
        objectValue(
          objectValue(scheduler.httpTarget ?? {}, "invalid_scheduler_http_target").oauthToken ?? {},
          "invalid_scheduler_oauth",
        ).scope,
      ),
    },
    runJob: {
      name: stringOrNull(runJob.metadata && objectValue(runJob.metadata, "invalid_run_job_metadata").name)
        ?? options.runJob,
      executionCount: parseInteger(runStatus.executionCount ?? 0, "invalid_execution_count"),
      latestExecutionName: stringOrNull(latestCreatedExecution.name),
      latestExecutionCompletionStatus: stringOrNull(latestCreatedExecution.completionStatus),
      image: stringOrNull(firstContainer.image),
    },
    executions: {
      totalObserved: executionRowsWithStatus.length,
      byStatus: mapCounts(executionRowsWithStatus.map((row) => row.status)),
      latest: options.includeExecutionDetails
        ? latestFirst(executionRowsWithStatus, (row) => row.createTime).slice(0, 10)
        : [],
    },
    logs: {
      stdout: {
        totalEntries: stdoutRows.length,
        aggregateEntries: stdoutAggregateEntries.length,
        byOutcome: mapCounts(stdoutAggregateEntries.map((entry) => entry.outcome)),
        keyShapes: mapCounts(stdoutAggregateEntries.map((entry) => entry.keys.join(","))),
        latest: latestFirst(stdoutAggregateEntries, (entry) => entry.timestamp),
      },
      system: {
        totalEntries: systemRows.length,
        exitLines: mapCounts(systemExitLines),
        latest: latestFirst(
          systemRows.map((row) => ({
            timestamp: stringOrNull(row.timestamp),
            text: stringOrNull(row.textPayload) ?? "",
          })),
          (row) => row.timestamp,
        ),
      },
    },
    d1: {
      totalJobs: parseInteger(d1Row.total_jobs, "invalid_d1_total_jobs"),
      pendingJobs: parseInteger(d1Row.pending_jobs, "invalid_d1_pending_jobs"),
      runningJobs: parseInteger(d1Row.running_jobs, "invalid_d1_running_jobs"),
      succeededJobs: parseInteger(d1Row.succeeded_jobs, "invalid_d1_succeeded_jobs"),
      failedJobs: parseInteger(d1Row.failed_jobs, "invalid_d1_failed_jobs"),
      startedDispatchAttempts: parseInteger(
        d1Row.started_dispatch_attempts,
        "invalid_d1_started_dispatch_attempts",
      ),
      failedDispatchAttempts: parseInteger(
        d1Row.failed_dispatch_attempts,
        "invalid_d1_failed_dispatch_attempts",
      ),
      staleDispatchAttempts: parseInteger(
        d1Row.stale_dispatch_attempts,
        "invalid_d1_stale_dispatch_attempts",
      ),
      recoverableUploadSessions: parseInteger(
        d1Row.recoverable_upload_sessions,
        "invalid_d1_recoverable_upload_sessions",
      ),
      unclassifiedUploadSessions: parseInteger(
        d1Row.unclassified_upload_sessions,
        "invalid_d1_unclassified_upload_sessions",
      ),
      missingScanHashes: parseInteger(d1Row.missing_scan_hashes, "invalid_d1_missing_scan_hashes"),
      missingScanDerivatives: parseInteger(
        d1Row.missing_scan_derivatives,
        "invalid_d1_missing_scan_derivatives",
      ),
      scanMaintenanceFailures: parseInteger(
        d1Row.scan_maintenance_failures,
        "invalid_d1_scan_maintenance_failures",
      ),
      expiredScanMaintenanceLeases: parseInteger(
        d1Row.expired_scan_maintenance_leases,
        "invalid_d1_expired_scan_maintenance_leases",
      ),
      foreignKeyErrors: parseInteger(d1Row.foreign_key_errors, "invalid_d1_fk_errors"),
    },
    costSurface: {
      artifactRepoSizeBytes: numberOrNull(artifact.sizeBytes),
      schedulerJobsCount: schedulerList.length,
    },
  };

  const alerts = evaluateAlertsWithLookback(snapshotBase, {
    alertLookbackHours: options.alertLookbackHours,
  });
  snapshotBase.logs.stdout.latest = snapshotBase.logs.stdout.latest.slice(0, 10);
  snapshotBase.logs.system.latest = snapshotBase.logs.system.latest.slice(0, 10);
  return { ...snapshotBase, alerts };
}

function parseArguments(args: string[]): ProcessorOpsSnapshotOptions {
  let options: ProcessorOpsSnapshotOptions = { ...DEFAULT_OPTIONS };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    switch (arg) {
      case "--project-id":
        if (next === undefined) throw new ProcessorOpsSnapshotError("missing_project_id");
        options = { ...options, projectId: next };
        index += 1;
        break;
      case "--region":
        if (next === undefined) throw new ProcessorOpsSnapshotError("missing_region");
        options = { ...options, region: next };
        index += 1;
        break;
      case "--run-job":
        if (next === undefined) throw new ProcessorOpsSnapshotError("missing_run_job");
        options = { ...options, runJob: next };
        index += 1;
        break;
      case "--scheduler-job":
        if (next === undefined) throw new ProcessorOpsSnapshotError("missing_scheduler_job");
        options = { ...options, schedulerJob: next };
        index += 1;
        break;
      case "--d1-database":
        if (next === undefined) throw new ProcessorOpsSnapshotError("missing_d1_database");
        options = { ...options, d1Database: next };
        index += 1;
        break;
      case "--artifact-repo":
        if (next === undefined) throw new ProcessorOpsSnapshotError("missing_artifact_repo");
        options = { ...options, artifactRepo: next };
        index += 1;
        break;
      case "--stdout-limit":
        if (next === undefined) throw new ProcessorOpsSnapshotError("missing_stdout_limit");
        options = { ...options, stdoutLimit: Number.parseInt(next, 10) };
        index += 1;
        break;
      case "--system-limit":
        if (next === undefined) throw new ProcessorOpsSnapshotError("missing_system_limit");
        options = { ...options, systemLimit: Number.parseInt(next, 10) };
        index += 1;
        break;
      case "--execution-limit":
        if (next === undefined) throw new ProcessorOpsSnapshotError("missing_execution_limit");
        options = { ...options, executionLimit: Number.parseInt(next, 10) };
        index += 1;
        break;
      case "--alert-lookback-hours":
        if (next === undefined) throw new ProcessorOpsSnapshotError("missing_alert_lookback_hours");
        options = { ...options, alertLookbackHours: Number.parseInt(next, 10) };
        index += 1;
        break;
      case "--summary":
        options = { ...options, summary: true };
        break;
      case "--no-execution-details":
        options = { ...options, includeExecutionDetails: false };
        break;
      case "--enforce":
        options = { ...options, enforce: true };
        break;
      default:
        throw new ProcessorOpsSnapshotError("unknown_argument", arg);
    }
  }

  for (const [name, value] of [
    ["stdoutLimit", options.stdoutLimit],
    ["systemLimit", options.systemLimit],
    ["executionLimit", options.executionLimit],
    ["alertLookbackHours", options.alertLookbackHours],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ProcessorOpsSnapshotError("invalid_limit", name);
    }
  }

  return options;
}

export async function main(args: string[]): Promise<number> {
  const options = parseArguments(args);
  const snapshot = await buildProcessorOpsSnapshot(options);
  const output = options.summary
    ? buildProcessorOpsSnapshotSummary(snapshot)
    : snapshot;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (options.enforce && snapshot.alerts.some((alert) => alert.severity === "critical")) {
    return 2;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "processor_ops_snapshot_failed";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    },
  );
}
