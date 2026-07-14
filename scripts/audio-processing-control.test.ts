/// <reference types="@cloudflare/workers-types" />

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../worker/index";

const migrationNames = [
  "initial",
  "editing_foundation",
  "song_writes",
  "audio_derivatives",
  "audio_processing_jobs",
  "recording_upload_sessions",
  "audio_processing_control",
  "audio_processing_concurrency",
];
const migration = migrationNames.map((name, index) => readFileSync(
  resolve(`migrations/${String(index + 1).padStart(4, "0")}_${name}.sql`),
  "utf8",
)).join("\n");

const processorToken = "processor-test-token-with-at-least-32-characters";
const actor = "local@example.invalid";
const seedTimestamp = "2026-07-12T00:00:00.000Z";

type NativeRunResult = { changes: number | bigint };

function d1Result<T>(results: T[], changes = 0): D1Result<T> {
  return {
    success: true,
    results,
    meta: { changes },
  } as unknown as D1Result<T>;
}

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    readonly query: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteD1Statement(this.database, this.query, values) as unknown as D1PreparedStatement;
  }

  private nativeStatement() {
    return this.database.prepare(this.query);
  }

  private nativeValues(): never[] {
    return this.values.map((value) => value === undefined ? null : value) as never[];
  }

  runSync<T = Record<string, unknown>>(): D1Result<T> {
    const native = this.nativeStatement().run(...this.nativeValues()) as NativeRunResult;
    return d1Result<T>([], Number(native.changes));
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.runSync<T>();
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.nativeStatement().get(...this.nativeValues()) as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return d1Result(this.nativeStatement().all(...this.nativeValues()) as T[]);
  }
}

function createD1(): { binding: D1Database; native: DatabaseSync } {
  const native = new DatabaseSync(":memory:");
  native.exec(migration);
  const binding = {
    prepare(query: string) {
      return new SqliteD1Statement(native, query) as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      native.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => (
          statement as unknown as SqliteD1Statement
        ).runSync());
        native.exec("COMMIT");
        return results;
      } catch (error) {
        native.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { binding, native };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

class TestDigestStream extends WritableStream<Uint8Array> {
  declare readonly bytesWritten: number;
  readonly digest: Promise<ArrayBuffer>;

  constructor() {
    const chunks: Uint8Array[] = [];
    let byteSize = 0;
    let resolveDigest!: (value: ArrayBuffer) => void;
    let rejectDigest!: (reason: unknown) => void;
    const digest = new Promise<ArrayBuffer>((resolvePromise, rejectPromise) => {
      resolveDigest = resolvePromise;
      rejectDigest = rejectPromise;
    });
    super({
      write(chunk) {
        const copy = new Uint8Array(chunk);
        chunks.push(copy);
        byteSize += copy.byteLength;
      },
      async close() {
        try {
          const bytes = new Uint8Array(byteSize);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          resolveDigest(await crypto.subtle.digest("SHA-256", bytes));
        } catch (error) {
          rejectDigest(error);
        }
      },
      abort(reason) {
        rejectDigest(reason);
      },
    });
    this.digest = digest;
    Object.defineProperty(this, "bytesWritten", { get: () => byteSize });
  }
}

beforeAll(() => {
  Object.defineProperty(crypto, "DigestStream", {
    configurable: true,
    value: TestDigestStream,
  });
});

function r2Object(key: string, bytes: Uint8Array): R2ObjectBody {
  const copy = new Uint8Array(bytes);
  return {
    key,
    version: "test",
    size: copy.byteLength,
    etag: sha256(copy).slice(0, 32),
    httpEtag: `"${sha256(copy).slice(0, 32)}"`,
    uploaded: new Date(seedTimestamp),
    httpMetadata: {},
    customMetadata: {},
    range: { offset: 0, length: copy.byteLength },
    checksums: { toJSON: () => ({}) },
    storageClass: "Standard",
    ssecKeyMd5: undefined,
    body: new Blob([copy]).stream(),
    bodyUsed: false,
    arrayBuffer: async () => copy.slice().buffer,
    text: async () => new TextDecoder().decode(copy),
    json: async <T>() => JSON.parse(new TextDecoder().decode(copy)) as T,
    blob: async () => new Blob([copy]),
    writeHttpMetadata() {},
  } as unknown as R2ObjectBody;
}

async function bodyBytes(value: unknown): Promise<Uint8Array> {
  if (value instanceof ReadableStream) {
    return new Uint8Array(await new Response(value).arrayBuffer());
  }
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  throw new Error("unsupported_test_r2_body");
}

class MemoryR2 {
  readonly objects = new Map<string, Uint8Array>();

  seed(key: string, bytes: Uint8Array): void {
    this.objects.set(key, new Uint8Array(bytes));
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const bytes = this.objects.get(key);
    return bytes ? r2Object(key, bytes) : null;
  }

  async head(key: string): Promise<R2Object | null> {
    const object = await this.get(key);
    if (!object) return null;
    const { body: _body, ...head } = object as unknown as R2ObjectBody & Record<string, unknown>;
    return head as unknown as R2Object;
  }

  async put(key: string, value: unknown, options?: R2PutOptions): Promise<R2Object | null> {
    if (options?.onlyIf && !(options.onlyIf instanceof Headers)
      && options.onlyIf.etagDoesNotMatch === "*" && this.objects.has(key)) {
      return null;
    }
    const bytes = await bodyBytes(value);
    this.objects.set(key, bytes);
    return await this.head(key);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

function processorBindings(database: D1Database, media: MemoryR2) {
  return {
    DB: database,
    MEDIA: media as unknown as R2Bucket,
    AUTH_MODE: "access" as const,
    ACCESS_AUD: "unused-for-processor",
    ACCESS_ISSUER: "unused-for-processor",
    ACCESS_JWKS_URL: "unused-for-processor",
    AUDIO_PROCESSOR_TOKEN: processorToken,
    AUDIO_PROCESSOR_TRANSFER_ORIGIN: "https://app.example.invalid",
  };
}

function localBindings(database: D1Database, media: MemoryR2) {
  return {
    ...processorBindings(database, media),
    AUTH_MODE: "local" as const,
  };
}

function seedPendingJob(
  database: DatabaseSync,
  media: MemoryR2,
  sourceBytes: Uint8Array,
  fixtureId = "1",
): void {
  const sourceHash = sha256(sourceBytes);
  const songId = `song-${fixtureId}`;
  const recordingId = `recording-${fixtureId}`;
  const jobId = `job-${fixtureId}`;
  const sourceMediaId = fixtureId === "1" ? "source-media" : `source-media-${fixtureId}`;
  const objectKey = `recordings/original/${sourceMediaId}`;
  database.prepare(`
    INSERT INTO songs (
      id, title_latin, normalized_title_latin, status,
      created_at, created_by, updated_at, updated_by
    ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)
  `).run(
    songId, `Test ${fixtureId}`, `test ${fixtureId}`,
    seedTimestamp, actor, seedTimestamp, actor,
  );
  database.prepare(`
    INSERT INTO media_objects (
      id, object_key, original_filename, byte_size, sha256, kind,
      state, created_at, created_by
    ) VALUES (
      ?, ?, 'source.bin', ?, ?,
      'original_audio', 'active', ?, ?
    )
  `).run(sourceMediaId, objectKey, sourceBytes.byteLength, sourceHash, seedTimestamp, actor);
  database.prepare(`
    INSERT INTO recordings (
      id, song_id, original_media_id, playback_media_id,
      description, normalized_description, processing_state, revision,
      created_at, created_by, updated_at, updated_by
    ) VALUES (
      ?, ?, ?, NULL,
      ?, ?, 'processing', 1, ?, ?, ?, ?
    )
  `).run(
    recordingId, songId, sourceMediaId,
    `Recording ${fixtureId}`, `recording ${fixtureId}`,
    seedTimestamp, actor, seedTimestamp, actor,
  );
  database.prepare(`
    INSERT INTO audio_processing_jobs (
      id, recording_id, source_media_id, source_sha256, source_byte_size,
      policy_id, status, attempt_count, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      'mp3-v1-libmp3lame-q2', 'pending', 0, ?, ?
    )
  `).run(
    jobId, recordingId, sourceMediaId, sourceHash, sourceBytes.byteLength,
    seedTimestamp, seedTimestamp,
  );
  media.seed(objectKey, sourceBytes);
}

type Claim = {
  leaseExpiresAt: string;
  processingRequest: {
    jobId: string;
    sourceSha256: string;
    sourceByteSize: number;
    sourceDownloadUrl: string;
    derivativeUploadUrl: string;
  };
  resultUrl: string;
  failureUrl: string;
};

async function claim(bindings: ReturnType<typeof processorBindings>): Promise<Claim> {
  const response = await app.request("https://app.example.invalid/api/processing/jobs/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${processorToken}` },
  }, bindings);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  return await response.json() as Claim;
}

function hostedResult(
  sourceBytes: Uint8Array,
  derivativeBytes: Uint8Array | null,
): Record<string, unknown> {
  const source = {
    sha256: sha256(sourceBytes),
    byte_size: sourceBytes.byteLength,
    codec: derivativeBytes ? "aac" : "mp3",
    containers: derivativeBytes ? ["m4a"] : ["mp3"],
    duration_seconds: 10,
    bit_rate: 80_000,
    sample_rate: 44_100,
    channels: 2,
    had_decode_warnings: false,
  };
  return derivativeBytes
    ? {
      schemaVersion: 1,
      jobId: "job-1",
      policyId: "mp3-v1-libmp3lame-q2",
      status: "created_derivative",
      playbackKind: "derivative",
      original: source,
      derivative: {
        ...source,
        sha256: sha256(derivativeBytes),
        byte_size: derivativeBytes.byteLength,
        codec: "mp3",
        containers: ["mp3"],
      },
      decision: { kind: "require_derivative", reason: "non_mp3_source" },
      validation: { accepted: true, reason: "accepted", saving_fraction: null },
    }
    : {
      schemaVersion: 1,
      jobId: "job-1",
      policyId: "mp3-v1-libmp3lame-q2",
      status: "original_is_playback",
      playbackKind: "original",
      original: source,
      derivative: null,
      decision: { kind: "use_original", reason: "canonical_mp3" },
      validation: null,
    };
}

async function submitResult(
  url: string,
  result: Record<string, unknown>,
  bindings: ReturnType<typeof processorBindings>,
): Promise<Response> {
  const body = JSON.stringify(result);
  return app.request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${processorToken}`,
      "Content-Type": "application/json",
      "Content-Length": String(new TextEncoder().encode(body).byteLength),
    },
    body,
  }, bindings);
}

describe("audio processing Worker control plane", () => {
  it("separately authenticates a claim and exposes only expiring job-scoped capabilities", async () => {
    const { binding, native } = createD1();
    const media = new MemoryR2();
    try {
      const source = new TextEncoder().encode("private original bytes");
      seedPendingJob(native, media, source);
      const bindings = processorBindings(binding, media);

      const unconfigured = await app.request(
        "https://app.example.invalid/api/processing/jobs/claim",
        { method: "POST" },
        {
          ...bindings,
          AUDIO_PROCESSOR_TOKEN: undefined,
          AUDIO_PROCESSOR_TRANSFER_ORIGIN: undefined,
        },
      );
      expect(unconfigured.status).toBe(503);

      const unauthenticated = await app.request(
        "https://app.example.invalid/api/processing/jobs/claim",
        { method: "POST" },
        bindings,
      );
      expect(unauthenticated.status).toBe(401);

      const claimed = await claim(bindings);
      expect(claimed.processingRequest).toMatchObject({
        jobId: "job-1",
        sourceSha256: sha256(source),
        sourceByteSize: source.byteLength,
      });
      expect(claimed.processingRequest.sourceDownloadUrl)
        .not.toBe(claimed.processingRequest.derivativeUploadUrl);
      const serialized = JSON.stringify(claimed);
      expect(serialized).not.toContain("source.bin");
      expect(serialized).not.toContain("source-media");
      expect(serialized).not.toContain("recording-1");
      expect(serialized).not.toContain("song-1");
      expect(serialized).not.toContain(processorToken);

      const sourceResponse = await app.request(
        claimed.processingRequest.sourceDownloadUrl, undefined, bindings,
      );
      expect(sourceResponse.status).toBe(200);
      expect(sourceResponse.headers.get("Content-Disposition")).toBeNull();
      expect(sourceResponse.headers.get("Location")).toBeNull();
      expect(sourceResponse.headers.get("Cache-Control")).toBe("private, no-store");
      expect(new Uint8Array(await sourceResponse.arrayBuffer())).toEqual(source);
      const pathSwappedCapability = new URL(claimed.processingRequest.sourceDownloadUrl);
      pathSwappedCapability.pathname = pathSwappedCapability.pathname.replace("/source", "/derivative");
      const swapped = await app.request(pathSwappedCapability, {
        method: "PUT",
        headers: { "Content-Length": "1" },
        body: new Uint8Array([1]),
      }, bindings);
      expect(swapped.status).toBe(401);

      const storedLease = native.prepare(`
        SELECT status, attempt_count AS attemptCount,
               lease_token_hash AS leaseTokenHash, lease_expires_at AS leaseExpiresAt
        FROM audio_processing_jobs WHERE id = 'job-1'
      `).get() as Record<string, unknown>;
      const capabilityToken = new URL(claimed.processingRequest.sourceDownloadUrl)
        .searchParams.get("token")!;
      const leaseToken = capabilityToken.split(".")[0];
      expect(storedLease).toMatchObject({ status: "running", attemptCount: 1 });
      expect(storedLease.leaseTokenHash).toBe(sha256(new TextEncoder().encode(leaseToken)));
      expect(storedLease.leaseTokenHash).not.toBe(capabilityToken);
      expect(storedLease.leaseExpiresAt).toBe(claimed.leaseExpiresAt);

      const userPlayback = await app.request(
        "https://app.example.invalid/api/media/source-media",
        undefined,
        localBindings(binding, media),
      );
      expect(userPlayback.status).toBe(404);
    } finally {
      native.close();
    }
  });

  it("finalizes an immutable verified derivative atomically and idempotently", async () => {
    const { binding, native } = createD1();
    const media = new MemoryR2();
    try {
      const source = new TextEncoder().encode("non-mp3 private original");
      const derivative = new TextEncoder().encode("verified mp3 derivative");
      seedPendingJob(native, media, source);
      const bindings = processorBindings(binding, media);
      const claimed = await claim(bindings);

      const result = hostedResult(source, derivative);
      const beforeUpload = await submitResult(claimed.resultUrl, result, bindings);
      expect(beforeUpload.status).toBe(409);
      expect(native.prepare("SELECT status FROM audio_processing_jobs").get())
        .toEqual({ status: "running" });

      const upload = await app.request(claimed.processingRequest.derivativeUploadUrl, {
        method: "PUT",
        headers: { "Content-Length": String(derivative.byteLength) },
        body: derivative,
      }, bindings);
      expect(upload.status).toBe(201);
      const overwrite = await app.request(claimed.processingRequest.derivativeUploadUrl, {
        method: "PUT",
        headers: { "Content-Length": "4" },
        body: new Uint8Array([1, 2, 3, 4]),
      }, bindings);
      expect(overwrite.status).toBe(204);

      const finalized = await submitResult(claimed.resultUrl, result, bindings);
      expect(finalized.status).toBe(200);
      await expect(finalized.json()).resolves.toMatchObject({
        job: { id: "job-1", status: "succeeded", playbackKind: "derivative" },
      });
      const row = native.prepare(`
        SELECT
          audio_processing_jobs.status,
          audio_processing_jobs.playback_kind AS playbackKind,
          audio_processing_jobs.lease_token_hash AS leaseTokenHash,
          recordings.processing_state AS processingState,
          recordings.revision,
          media_objects.kind,
          media_objects.mime_type AS mimeType,
          media_objects.sha256,
          audio_derivatives.source_sha256 AS provenanceSourceSha256,
          audio_derivatives.derivative_sha256 AS provenanceDerivativeSha256
        FROM audio_processing_jobs
        JOIN recordings ON recordings.id = audio_processing_jobs.recording_id
        JOIN media_objects ON media_objects.id = recordings.playback_media_id
        JOIN audio_derivatives ON audio_derivatives.playback_media_id = media_objects.id
        WHERE audio_processing_jobs.id = 'job-1'
      `).get() as Record<string, unknown>;
      expect(row).toMatchObject({
        status: "succeeded",
        playbackKind: "derivative",
        leaseTokenHash: null,
        processingState: "ready",
        revision: 2,
        kind: "playback_audio",
        mimeType: "audio/mpeg",
        sha256: sha256(derivative),
        provenanceSourceSha256: sha256(source),
        provenanceDerivativeSha256: sha256(derivative),
      });
      expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      const lostResponseRetry = await submitResult(claimed.resultUrl, result, bindings);
      expect(lostResponseRetry.status).toBe(200);
      expect(native.prepare("SELECT COUNT(*) AS count FROM audio_derivatives").get())
        .toEqual({ count: 1 });

      const playbackMediaId = native.prepare(`
        SELECT playback_media_id AS id FROM recordings WHERE id = 'recording-1'
      `).get() as { id: string };
      const playback = await app.request(
        `https://app.example.invalid/api/media/${playbackMediaId.id}`,
        undefined,
        localBindings(binding, media),
      );
      expect(playback.status).toBe(200);
      expect(new Uint8Array(await playback.arrayBuffer())).toEqual(derivative);
    } finally {
      native.close();
    }
  });

  it("makes a verified canonical original ready without creating a derivative", async () => {
    const { binding, native } = createD1();
    const media = new MemoryR2();
    try {
      const source = new TextEncoder().encode("canonical mp3 original");
      seedPendingJob(native, media, source);
      const bindings = processorBindings(binding, media);
      const claimed = await claim(bindings);
      const finalized = await submitResult(claimed.resultUrl, hostedResult(source, null), bindings);
      expect(finalized.status).toBe(200);
      expect(native.prepare(`
        SELECT
          audio_processing_jobs.status,
          audio_processing_jobs.playback_kind AS playbackKind,
          recordings.processing_state AS processingState,
          recordings.playback_media_id AS playbackMediaId,
          media_objects.mime_type AS mimeType,
          (SELECT COUNT(*) FROM audio_derivatives) AS derivativeCount
        FROM audio_processing_jobs
        JOIN recordings ON recordings.id = audio_processing_jobs.recording_id
        JOIN media_objects ON media_objects.id = recordings.original_media_id
        WHERE audio_processing_jobs.id = 'job-1'
      `).get()).toEqual({
        status: "succeeded",
        playbackKind: "original",
        processingState: "ready",
        playbackMediaId: "source-media",
        mimeType: "audio/mpeg",
        derivativeCount: 0,
      });
    } finally {
      native.close();
    }
  });

  it("rejects stale leases, checkpoints safe failures, and supports explicit editor retry", async () => {
    const { binding, native } = createD1();
    const media = new MemoryR2();
    try {
      const source = new TextEncoder().encode("bad audio original");
      seedPendingJob(native, media, source);
      const processor = processorBindings(binding, media);
      const first = await claim(processor);
      const wrongCapability = new URL(first.processingRequest.sourceDownloadUrl);
      wrongCapability.searchParams.set("token", "wrong-token");
      expect((await app.request(wrongCapability, undefined, processor)).status).toBe(401);

      const failureBody = JSON.stringify({ errorCode: "source_decode_failed" });
      const failed = await app.request(first.failureUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${processorToken}`,
          "Content-Type": "application/json",
          "Content-Length": String(new TextEncoder().encode(failureBody).byteLength),
        },
        body: failureBody,
      }, processor);
      expect(failed.status).toBe(200);
      expect(native.prepare(`
        SELECT audio_processing_jobs.status, audio_processing_jobs.error_code AS errorCode,
               recordings.processing_state AS processingState,
               recordings.processing_error AS processingError
        FROM audio_processing_jobs
        JOIN recordings ON recordings.id = audio_processing_jobs.recording_id
      `).get()).toEqual({
        status: "failed",
        errorCode: "source_decode_failed",
        processingState: "failed",
        processingError: "source_decode_failed",
      });
      expect((await app.request(first.failureUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${processorToken}`,
          "Content-Type": "application/json",
          "Content-Length": String(new TextEncoder().encode(failureBody).byteLength),
        },
        body: failureBody,
      }, processor)).status).toBe(200);

      const viewerRetry = await app.request(
        "https://app.example.invalid/api/recordings/recording-1/retry-processing",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision: 2 }),
        },
        { ...localBindings(binding, media), LOCAL_ROLE: "viewer" as const },
      );
      expect(viewerRetry.status).toBe(403);
      const staleRevisionRetry = await app.request(
        "https://app.example.invalid/api/recordings/recording-1/retry-processing",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision: 1 }),
        },
        localBindings(binding, media),
      );
      expect(staleRevisionRetry.status).toBe(409);

      const retry = await app.request(
        "https://app.example.invalid/api/recordings/recording-1/retry-processing",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision: 2 }),
        },
        localBindings(binding, media),
      );
      expect(retry.status).toBe(200);
      await expect(retry.json()).resolves.toMatchObject({
        job: { status: "pending", attemptCount: 1 },
        recording: { revision: 3, processingState: "processing" },
      });
      const second = await claim(processor);
      const staleResult = await submitResult(first.resultUrl, hostedResult(source, null), processor);
      expect(staleResult.status).toBe(409);
      expect(new URL(second.resultUrl).searchParams.get("token"))
        .not.toBe(new URL(first.resultUrl).searchParams.get("token"));
      const mismatchedResult = hostedResult(source, null);
      mismatchedResult.original = {
        ...(mismatchedResult.original as Record<string, unknown>),
        sha256: "d".repeat(64),
      };
      expect((await submitResult(second.resultUrl, mismatchedResult, processor)).status).toBe(422);
      expect(native.prepare(`
        SELECT status, attempt_count AS attemptCount FROM audio_processing_jobs
      `).get()).toEqual({ status: "running", attemptCount: 2 });
    } finally {
      native.close();
    }
  });

  it("recovers an expired lease into a new immutable attempt", async () => {
    const { binding, native } = createD1();
    const media = new MemoryR2();
    try {
      const source = new TextEncoder().encode("retryable original");
      seedPendingJob(native, media, source);
      native.prepare(`
        UPDATE audio_processing_jobs
        SET status = 'running', attempt_count = 1,
            lease_token_hash = ?, lease_expires_at = '2026-07-13T00:00:00.000Z',
            updated_at = '2026-07-12T00:00:01.000Z'
        WHERE id = 'job-1'
      `).run("c".repeat(64));

      const claimed = await claim(processorBindings(binding, media));
      expect(native.prepare(`
        SELECT status, attempt_count AS attemptCount FROM audio_processing_jobs
      `).get()).toEqual({ status: "running", attemptCount: 2 });
      expect(claimed.processingRequest.derivativeUploadUrl)
        .toContain("/derivative?token=");
      expect(media.objects.has("recordings/playback/pending/job-1/attempt-1.mp3")).toBe(false);
    } finally {
      native.close();
    }
  });

  it("serializes overlapping claims across different pending jobs", async () => {
    const { binding, native } = createD1();
    const media = new MemoryR2();
    try {
      seedPendingJob(native, media, new TextEncoder().encode("first original"));
      seedPendingJob(native, media, new TextEncoder().encode("second original"), "2");
      const bindings = processorBindings(binding, media);
      const request = () => app.request(
        "https://app.example.invalid/api/processing/jobs/claim",
        { method: "POST", headers: { Authorization: `Bearer ${processorToken}` } },
        bindings,
      );
      const responses = await Promise.all([request(), request()]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 204]);
      expect(native.prepare(`
        SELECT
          SUM(status = 'running') AS runningCount,
          SUM(status = 'pending') AS pendingCount,
          SUM(attempt_count) AS totalAttempts
        FROM audio_processing_jobs
      `).get()).toEqual({ runningCount: 1, pendingCount: 1, totalAttempts: 1 });
    } finally {
      native.close();
    }
  });

  it("returns no work while a pre-existing lease is still running", async () => {
    const { binding, native } = createD1();
    const media = new MemoryR2();
    try {
      seedPendingJob(native, media, new TextEncoder().encode("leased original"));
      const bindings = processorBindings(binding, media);
      await claim(bindings);
      const duplicateExecution = await app.request(
        "https://app.example.invalid/api/processing/jobs/claim",
        { method: "POST", headers: { Authorization: `Bearer ${processorToken}` } },
        bindings,
      );
      expect(duplicateExecution.status).toBe(204);
      expect(native.prepare(`
        SELECT status, attempt_count AS attemptCount FROM audio_processing_jobs
      `).get()).toEqual({ status: "running", attemptCount: 1 });
    } finally {
      native.close();
    }
  });

  it("fails the third expired attempt and requires an explicit editor retry", async () => {
    const { binding, native } = createD1();
    const media = new MemoryR2();
    try {
      seedPendingJob(native, media, new TextEncoder().encode("repeatedly lost original"));
      native.prepare(`
        UPDATE audio_processing_jobs
        SET status = 'running', attempt_count = 1,
            lease_token_hash = ?, lease_expires_at = '2026-07-13T00:00:00.000Z',
            updated_at = '2026-07-12T00:00:01.000Z'
        WHERE id = 'job-1'
      `).run("c".repeat(64));
      native.prepare(`
        UPDATE audio_processing_jobs
        SET status = 'pending', lease_token_hash = NULL, lease_expires_at = NULL,
            updated_at = '2026-07-13T00:00:01.000Z'
        WHERE id = 'job-1'
      `).run();
      native.prepare(`
        UPDATE audio_processing_jobs
        SET status = 'running', attempt_count = 2,
            lease_token_hash = ?, lease_expires_at = '2026-07-13T01:00:00.000Z',
            updated_at = '2026-07-13T00:00:02.000Z'
        WHERE id = 'job-1'
      `).run("d".repeat(64));
      native.prepare(`
        UPDATE audio_processing_jobs
        SET status = 'pending', lease_token_hash = NULL, lease_expires_at = NULL,
            updated_at = '2026-07-13T01:00:01.000Z'
        WHERE id = 'job-1'
      `).run();
      native.prepare(`
        UPDATE audio_processing_jobs
        SET status = 'running', attempt_count = 3,
            lease_token_hash = ?, lease_expires_at = '2026-07-13T02:00:00.000Z',
            updated_at = '2026-07-13T01:00:02.000Z'
        WHERE id = 'job-1'
      `).run("e".repeat(64));
      expect(() => native.prepare(`
        UPDATE audio_processing_jobs
        SET status = 'pending', lease_token_hash = NULL, lease_expires_at = NULL,
            updated_at = '2026-07-13T02:00:01.000Z'
        WHERE id = 'job-1'
      `).run()).toThrow(/invalid_audio_processing_job_expired_recovery/u);

      const bindings = processorBindings(binding, media);
      const recovery = await app.request(
        "https://app.example.invalid/api/processing/jobs/claim",
        { method: "POST", headers: { Authorization: `Bearer ${processorToken}` } },
        bindings,
      );
      expect(recovery.status).toBe(204);
      expect(native.prepare(`
        SELECT audio_processing_jobs.status, audio_processing_jobs.attempt_count AS attemptCount,
               audio_processing_jobs.error_code AS errorCode,
               recordings.processing_state AS processingState,
               recordings.processing_error AS processingError,
               recordings.revision
        FROM audio_processing_jobs
        JOIN recordings ON recordings.id = audio_processing_jobs.recording_id
      `).get()).toEqual({
        status: "failed",
        attemptCount: 3,
        errorCode: "processing_lease_expired",
        processingState: "failed",
        processingError: "processing_lease_expired",
        revision: 2,
      });

      const retry = await app.request(
        "https://app.example.invalid/api/recordings/recording-1/retry-processing",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision: 2 }),
        },
        localBindings(binding, media),
      );
      expect(retry.status).toBe(200);
      await expect(retry.json()).resolves.toMatchObject({
        job: { status: "pending", attemptCount: 3 },
        recording: { revision: 3, processingState: "processing" },
      });
      await claim(bindings);
      expect(native.prepare(`
        SELECT status, attempt_count AS attemptCount FROM audio_processing_jobs
      `).get()).toEqual({ status: "running", attemptCount: 4 });
    } finally {
      native.close();
    }
  });

  it("independently rejects changed source bytes before they can become playback", async () => {
    const { binding, native } = createD1();
    const media = new MemoryR2();
    try {
      const source = new TextEncoder().encode("canonical source bytes");
      seedPendingJob(native, media, source);
      const bindings = processorBindings(binding, media);
      const claimed = await claim(bindings);
      media.seed(
        "recordings/original/source-media",
        new TextEncoder().encode("corrupted source bytes"),
      );

      const rejected = await submitResult(
        claimed.resultUrl, hostedResult(source, null), bindings,
      );
      expect(rejected.status).toBe(422);
      expect(native.prepare(`
        SELECT audio_processing_jobs.status, audio_processing_jobs.error_code AS errorCode,
               recordings.processing_state AS processingState,
               recordings.playback_media_id AS playbackMediaId
        FROM audio_processing_jobs
        JOIN recordings ON recordings.id = audio_processing_jobs.recording_id
      `).get()).toEqual({
        status: "failed",
        errorCode: "source_verification_failed",
        processingState: "failed",
        playbackMediaId: null,
      });
    } finally {
      native.close();
    }
  });

  it("fails closed on derivative mismatch and rolls catalog inserts back on a no-op prerequisite", async () => {
    const source = new TextEncoder().encode("non-mp3 source");
    const derivative = new TextEncoder().encode("real derivative bytes");

    const mismatchDatabase = createD1();
    const mismatchMedia = new MemoryR2();
    try {
      seedPendingJob(mismatchDatabase.native, mismatchMedia, source);
      const bindings = processorBindings(mismatchDatabase.binding, mismatchMedia);
      const claimed = await claim(bindings);
      expect((await app.request(claimed.processingRequest.derivativeUploadUrl, {
        method: "PUT",
        headers: { "Content-Length": String(derivative.byteLength) },
        body: derivative,
      }, bindings)).status).toBe(201);
      const wrongResult = hostedResult(source, new TextEncoder().encode("different derivative"));
      const rejected = await submitResult(claimed.resultUrl, wrongResult, bindings);
      expect(rejected.status).toBe(422);
      expect(mismatchDatabase.native.prepare(`
        SELECT status, error_code AS errorCode FROM audio_processing_jobs
      `).get()).toEqual({ status: "failed", errorCode: "derivative_verification_failed" });
      expect(mismatchDatabase.native.prepare(`
        SELECT COUNT(*) AS count FROM media_objects WHERE kind = 'playback_audio'
      `).get()).toEqual({ count: 0 });
    } finally {
      mismatchDatabase.native.close();
    }

    const rollbackDatabase = createD1();
    const rollbackMedia = new MemoryR2();
    try {
      seedPendingJob(rollbackDatabase.native, rollbackMedia, source);
      const bindings = processorBindings(rollbackDatabase.binding, rollbackMedia);
      const claimed = await claim(bindings);
      expect((await app.request(claimed.processingRequest.derivativeUploadUrl, {
        method: "PUT",
        headers: { "Content-Length": String(derivative.byteLength) },
        body: derivative,
      }, bindings)).status).toBe(201);
      rollbackDatabase.native.exec(`
        CREATE TRIGGER ignore_test_ready_recording
        BEFORE UPDATE OF playback_media_id ON recordings
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);
      const rejected = await submitResult(
        claimed.resultUrl, hostedResult(source, derivative), bindings,
      );
      expect(rejected.status).toBe(500);
      expect(rollbackDatabase.native.prepare(`
        SELECT
          (SELECT COUNT(*) FROM media_objects WHERE kind = 'playback_audio') AS mediaCount,
          (SELECT COUNT(*) FROM audio_derivatives) AS derivativeCount,
          (SELECT status FROM audio_processing_jobs WHERE id = 'job-1') AS jobStatus,
          (SELECT processing_state FROM recordings WHERE id = 'recording-1') AS recordingState
      `).get()).toEqual({
        mediaCount: 0,
        derivativeCount: 0,
        jobStatus: "running",
        recordingState: "processing",
      });
    } finally {
      rollbackDatabase.native.close();
    }
  });
});
