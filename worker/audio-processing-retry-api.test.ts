import { describe, expect, it } from "vitest";
import { app, type AppRole } from "./index";

type FakeStatement = D1PreparedStatement & { query: string; values: unknown[] };

type Job = {
  id: string;
  recordingId: string;
  songId: string;
  sourceMediaId: string;
  sourceObjectKey: string;
  sourceMediaState: "active";
  sourceSha256: string;
  sourceByteSize: number;
  policyId: string;
  status: "failed" | "pending" | "running" | "succeeded";
  attemptCount: number;
  leaseTokenHash: string | null;
  leaseExpiresAt: string | null;
  playbackKind: null;
  derivativeMediaId: null;
  derivativeObjectKey: null;
  derivativeSha256: null;
  derivativeByteSize: null;
  errorCode: string | null;
  recordingRevision: number;
  recordingProcessingState: "failed" | "processing" | "ready";
  recordingTrashedAt: string | null;
};

function bindings(database: D1Database, role: AppRole = "editor") {
  return {
    DB: database,
    MEDIA: {} as R2Bucket,
    AUTH_MODE: "local" as const,
    ACCESS_AUD: "unused-locally",
    ACCESS_ISSUER: "unused-locally",
    ACCESS_JWKS_URL: "unused-locally",
    LOCAL_ROLE: role,
  };
}

function failedJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    recordingId: "recording-1",
    songId: "song-1",
    sourceMediaId: "source-1",
    sourceObjectKey: "private-source-key",
    sourceMediaState: "active",
    sourceSha256: "a".repeat(64),
    sourceByteSize: 100,
    policyId: "mp3-v1-libmp3lame-q2",
    status: "failed",
    attemptCount: 2,
    leaseTokenHash: null,
    leaseExpiresAt: null,
    playbackKind: null,
    derivativeMediaId: null,
    derivativeObjectKey: null,
    derivativeSha256: null,
    derivativeByteSize: null,
    errorCode: "source_decode_failed",
    recordingRevision: 4,
    recordingProcessingState: "failed",
    recordingTrashedAt: null,
    ...overrides,
  };
}

function retryDatabase(initial: Job, batchChanges = [1, 1, 1]) {
  let job = initial;
  let batchCalls = 0;
  const database = {
    prepare: (query: string) => {
      const prepared = {
        query,
        values: [] as unknown[],
        bind(...values: unknown[]) {
          prepared.values = values;
          return prepared;
        },
        first: async () => query.includes("SELECT id FROM audio_processing_jobs WHERE recording_id")
          ? { id: job.id }
          : job,
      } as unknown as FakeStatement;
      return prepared;
    },
    batch: async (statements: FakeStatement[]) => {
      batchCalls += 1;
      expect(statements).toHaveLength(3);
      if (batchChanges[2] === 1) {
        job = {
          ...job,
          status: "pending",
          errorCode: null,
          recordingRevision: job.recordingRevision + 1,
          recordingProcessingState: "processing",
        };
      }
      return batchChanges.map((changes) => ({ meta: { changes } }));
    },
  } as unknown as D1Database;
  return { database, batchCalls: () => batchCalls };
}

describe("audio processing editor retry API", () => {
  it("blocks viewers before reading a processing job", async () => {
    let prepared = false;
    const database = {
      prepare: () => {
        prepared = true;
        throw new Error("viewer reached database");
      },
    } as unknown as D1Database;
    const response = await app.request(
      "http://local.test/api/recordings/recording-1/retry-processing",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 4 }),
      },
      bindings(database, "viewer"),
    );

    expect(response.status).toBe(403);
    expect(prepared).toBe(false);
  });

  it("moves only the matching failed Recording and job back to processing/pending", async () => {
    const fake = retryDatabase(failedJob());
    const response = await app.request(
      "http://local.test/api/recordings/recording-1/retry-processing",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 4 }),
      },
      bindings(fake.database),
    );

    expect(response.status).toBe(200);
    expect(fake.batchCalls()).toBe(1);
    await expect(response.json()).resolves.toEqual({
      job: { status: "pending", attemptCount: 2 },
      recording: { id: "recording-1", revision: 5, processingState: "processing" },
    });
  });

  it("rejects a stale Recording revision without changing state", async () => {
    const fake = retryDatabase(failedJob());
    const response = await app.request(
      "http://local.test/api/recordings/recording-1/retry-processing",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 3 }),
      },
      bindings(fake.database),
    );

    expect(response.status).toBe(409);
    expect(fake.batchCalls()).toBe(0);
    await expect(response.json()).resolves.toEqual({ error: "audio_processing_retry_conflict" });
  });

  it("rejects active and already-succeeded jobs without requeueing", async () => {
    for (const [status, expected] of [
      ["running", "audio_processing_already_active"],
      ["succeeded", "audio_processing_already_succeeded"],
    ] as const) {
      const fake = retryDatabase(failedJob({
        status,
        recordingProcessingState: status === "succeeded" ? "ready" : "processing",
        errorCode: null,
      }));
      const response = await app.request(
        "http://local.test/api/recordings/recording-1/retry-processing",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision: 4 }),
        },
        bindings(fake.database),
      );
      expect(response.status).toBe(409);
      expect(fake.batchCalls()).toBe(0);
      await expect(response.json()).resolves.toEqual({ error: expected });
    }
  });
});
