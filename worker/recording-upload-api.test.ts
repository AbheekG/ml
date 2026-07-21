import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app, type AppRole } from "./index";
import {
  parseRecordingUploadCreate,
  recordingUploadRequestFingerprint,
} from "./recording-upload";

type FakeStatement = D1PreparedStatement & { query: string; values: unknown[] };

const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const ABC_MANIFEST_SHA256 = "f36315554ddc5c72d9dc86d42c7b9c6ff64bad9ba13dd761069c204540a4a51a";

function bindings(database: D1Database, media: R2Bucket, role: AppRole = "admin") {
  return {
    DB: database,
    MEDIA: media,
    AUTH_MODE: "local" as const,
    ACCESS_AUD: "unused-locally",
    ACCESS_ISSUER: "unused-locally",
    ACCESS_JWKS_URL: "unused-locally",
    LOCAL_ROLE: role,
  };
}

function statement(query: string): FakeStatement {
  const value = {
    query,
    values: [] as unknown[],
    bind(...values: unknown[]) {
      value.values = values;
      return value;
    },
  };
  return value as unknown as FakeStatement;
}

class ApiTestDigestStream extends WritableStream<ArrayBuffer | ArrayBufferView> {
  declare readonly bytesWritten: number;
  readonly digest: Promise<ArrayBuffer>;

  constructor() {
    const chunks: Uint8Array[] = [];
    let byteSize = 0;
    let resolveDigest!: (digest: ArrayBuffer) => void;
    let rejectDigest!: (error: unknown) => void;
    const digest = new Promise<ArrayBuffer>((resolve, reject) => {
      resolveDigest = resolve;
      rejectDigest = reject;
    });
    super({
      write: (chunk) => {
        const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        chunks.push(bytes.slice());
        byteSize += bytes.byteLength;
      },
      close: async () => {
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
      abort: rejectDigest,
    });
    Object.defineProperty(this, "bytesWritten", { get: () => byteSize });
    this.digest = digest;
  }
}

function installTestDigestStream(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "DigestStream");
  Object.defineProperty(crypto, "DigestStream", {
    configurable: true,
    value: ApiTestDigestStream,
  });
  return () => {
    if (descriptor) Object.defineProperty(crypto, "DigestStream", descriptor);
    else Reflect.deleteProperty(crypto, "DigestStream");
  };
}

describe("Recording upload API", () => {
  let restoreSuiteDigestStream: () => void;
  beforeAll(() => { restoreSuiteDigestStream = installTestDigestStream(); });
  afterAll(() => { restoreSuiteDigestStream(); });

  it("creates one idempotent private multipart session without exposing storage identity", async () => {
    type Session = {
      id: string; songId: string; requestFingerprint: string; fileManifestSha256: string;
      filename: string;
      byteSize: number; partCount: number; objectKey: string; uploadId: string | null;
      status: "creating" | "open"; revision: number; expiresAt: string; recordingId: null;
    };
    let session: Session | null = null;
    const database = {
      prepare: (query: string) => {
        const prepared = statement(query);
        prepared.first = async () => {
          if (query.includes("SELECT id FROM songs")) return { id: "song-1" };
          if (query.includes("FROM recording_upload_sessions")) return session;
          return null;
        };
        prepared.run = (async () => {
          if (query.includes("SET r2_upload_id")) {
            if (!session || session.status !== "creating") return { meta: { changes: 0 } };
            session = { ...session, uploadId: "private-multipart-id", status: "open", revision: 2 };
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }) as FakeStatement["run"];
        return prepared;
      },
      batch: async (statements: FakeStatement[]) => {
        const values = statements[0].values;
        session = {
          id: String(values[0]),
          songId: "song-1",
          requestFingerprint: String(values[2]),
          fileManifestSha256: String(values[3]),
          filename: String(values[6]),
          byteSize: Number(values[8]),
          partCount: Number(values[10]),
          objectKey: String(values[11]),
          uploadId: null,
          status: "creating",
          revision: 1,
          expiresAt: String(values[12]),
          recordingId: null,
        };
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    } as unknown as D1Database;
    let createdObjectKey = "";
    const media = {
      createMultipartUpload: async (key: string) => {
        createdObjectKey = key;
        return { key, uploadId: "private-multipart-id", abort: async () => undefined };
      },
    } as unknown as R2Bucket;
    const body = {
      clientMutationId: "3f2a1dc0-49aa-4e52-a27a-74d1372aa219",
      fileManifestSha256: "e".repeat(64),
      filename: "private-take.m4a",
      mimeType: "audio/mp4",
      byteSize: 123,
      description: "Early take",
      recordedOn: null,
      creditPersonIds: [],
    };

    const first = await app.request(
      "http://local.test/api/songs/song-1/recording-uploads",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      bindings(database, media),
    );
    expect(first.status).toBe(201);
    expect(createdObjectKey).toMatch(/^recordings\/original\/[a-f0-9-]+$/u);
    const firstText = await first.text();
    expect(firstText).not.toContain(createdObjectKey);
    expect(firstText).not.toContain("private-multipart-id");
    expect(JSON.parse(firstText)).toMatchObject({ upload: { status: "open", partCount: 1, revision: 2 } });

    const retry = await app.request(
      "http://local.test/api/songs/song-1/recording-uploads",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      bindings(database, media),
    );
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ upload: { id: session!.id, status: "open" } });

    const conflicting = await app.request(
      "http://local.test/api/songs/song-1/recording-uploads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, byteSize: 124 }),
      },
      bindings(database, media),
    );
    expect(conflicting.status).toBe(409);
    await expect(conflicting.json()).resolves.toEqual({ error: "recording_upload_mutation_reused" });
  });

  it("auto-aborts an expired unprovisioned session so it cannot strand its Song", async () => {
    const body = {
      clientMutationId: "3f2a1dc0-49aa-4e52-a27a-74d1372aa219",
      fileManifestSha256: "e".repeat(64),
      filename: "private-take.m4a",
      mimeType: "audio/mp4",
      byteSize: 123,
      description: "Early take",
      recordedOn: null,
      creditPersonIds: [],
    };
    const parsed = parseRecordingUploadCreate(body);
    if (!parsed.success) throw new Error("invalid test upload");
    const fingerprint = await recordingUploadRequestFingerprint("song-1", parsed.data);
    let session = {
      id: "upload-expired", songId: "song-1", requestFingerprint: fingerprint,
      fileManifestSha256: "e".repeat(64),
      filename: "private-take.m4a", byteSize: 123, partCount: 1,
      objectKey: "recordings/original/upload-expired", uploadId: null,
      status: "creating", revision: 1, expiresAt: "2000-01-01T00:00:00.000Z",
      sha256: null, duplicateMediaId: null, recordingId: null,
    };
    const database = {
      prepare: (query: string) => {
        const prepared = statement(query);
        prepared.first = async () => {
          if (query.includes("SELECT id FROM songs")) return { id: "song-1" };
          if (query.includes("FROM recording_upload_sessions")) return session;
          return null;
        };
        prepared.all = (async () => ({ results: [] })) as unknown as FakeStatement["all"];
        prepared.run = (async () => {
          if (query.includes("SET status = 'aborted'")) {
            session = { ...session, status: "aborted", revision: 2 };
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }) as FakeStatement["run"];
        return prepared;
      },
    } as unknown as D1Database;
    let touchedR2 = false;
    const media = {
      createMultipartUpload: () => { touchedR2 = true; return {}; },
    } as unknown as R2Bucket;
    const response = await app.request(
      "http://local.test/api/songs/song-1/recording-uploads",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      bindings(database, media),
    );
    expect(response.status).toBe(410);
    expect(touchedR2).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      error: "recording_upload_expired",
      upload: { id: "upload-expired", status: "aborted", revision: 2 },
    });
  });

  it("streams an exact raw part to R2 and checkpoints only its number", async () => {
    const session = {
      id: "upload-1", songId: "song-1", requestFingerprint: "a".repeat(64),
      fileManifestSha256: ABC_MANIFEST_SHA256,
      filename: "take.mp3", byteSize: 3, partCount: 1,
      objectKey: "recordings/original/upload-1", uploadId: "multipart-1",
      status: "open", revision: 2, expiresAt: "2999-01-01T00:00:00.000Z", recordingId: null,
    };
    const database = {
      prepare: (query: string) => {
        const prepared = statement(query);
        prepared.first = async () => query.includes("FROM recording_upload_sessions") ? session : null;
        return prepared;
      },
      batch: async (statements: FakeStatement[]) => statements.map(() => ({ meta: { changes: 1 } })),
    } as unknown as D1Database;
    let stored = "";
    const media = {
      resumeMultipartUpload: () => ({
        uploadPart: async (_partNumber: number, body: ReadableStream) => {
          stored = await new Response(body).text();
          return { partNumber: 1, etag: "server-etag" };
        },
      }),
    } as unknown as R2Bucket;

    const response = await app.request(
      "http://local.test/api/recording-uploads/upload-1/parts/1",
      {
        method: "PUT",
        headers: {
          "Content-Length": "3",
          "X-Upload-Part-Sha256": ABC_SHA256,
          "X-Upload-File-Manifest": ABC_MANIFEST_SHA256,
        },
        body: "abc",
      },
      bindings(database, media),
    );
    expect(response.status).toBe(200);
    expect(stored).toBe("abc");
    const text = await response.text();
    expect(text).not.toContain("server-etag");
    expect(JSON.parse(text)).toEqual({ part: { partNumber: 1 }, upload: { revision: 3 } });
  });

  it("rejects a different same-size resumable file before touching private storage", async () => {
    const session = {
      id: "upload-1", songId: "song-1", requestFingerprint: "a".repeat(64),
      fileManifestSha256: ABC_MANIFEST_SHA256,
      filename: "take.mp3", byteSize: 3, partCount: 1,
      objectKey: "recordings/original/upload-1", uploadId: "multipart-1",
      status: "open", revision: 2, expiresAt: "2999-01-01T00:00:00.000Z", recordingId: null,
    };
    const database = {
      prepare: (query: string) => {
        const prepared = statement(query);
        prepared.first = async () => session;
        return prepared;
      },
    } as unknown as D1Database;
    let touchedR2 = false;
    const media = {
      resumeMultipartUpload: () => { touchedR2 = true; return {}; },
    } as unknown as R2Bucket;

    const response = await app.request(
      "http://local.test/api/recording-uploads/upload-1/verify-file",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileManifestSha256: "e".repeat(64) }),
      },
      bindings(database, media),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "recording_upload_file_mismatch" });
    expect(touchedR2).toBe(false);
  });

  it("does not checkpoint a part whose measured hash differs from its claim", async () => {
    const session = {
      id: "upload-1", songId: "song-1", requestFingerprint: "a".repeat(64),
      fileManifestSha256: ABC_MANIFEST_SHA256,
      filename: "take.mp3", byteSize: 3, partCount: 1,
      objectKey: "recordings/original/upload-1", uploadId: "multipart-1",
      status: "open", revision: 2, expiresAt: "2999-01-01T00:00:00.000Z", recordingId: null,
    };
    let checkpointed = false;
    const database = {
      prepare: (query: string) => {
        const prepared = statement(query);
        prepared.first = async () => session;
        return prepared;
      },
      batch: async () => { checkpointed = true; return []; },
    } as unknown as D1Database;
    let stored = "";
    const media = {
      resumeMultipartUpload: () => ({
        uploadPart: async (_partNumber: number, body: ReadableStream) => {
          stored = await new Response(body).text();
          return { partNumber: 1, etag: "untrusted-etag" };
        },
      }),
    } as unknown as R2Bucket;

    const response = await app.request(
      "http://local.test/api/recording-uploads/upload-1/parts/1",
      {
        method: "PUT",
        headers: {
          "Content-Length": "3",
          "X-Upload-Part-Sha256": "0".repeat(64),
          "X-Upload-File-Manifest": ABC_MANIFEST_SHA256,
        },
        body: "abc",
      },
      bindings(database, media),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "recording_upload_part_hash_mismatch" });
    expect(stored).toBe("abc");
    expect(checkpointed).toBe(false);
  });

  it("rejects a wrong part length before touching R2", async () => {
    const session = {
      id: "upload-1", songId: "song-1", requestFingerprint: "a".repeat(64),
      fileManifestSha256: ABC_MANIFEST_SHA256,
      filename: "take.mp3", byteSize: 3, partCount: 1,
      objectKey: "recordings/original/upload-1", uploadId: "multipart-1",
      status: "open", revision: 2, expiresAt: "2999-01-01T00:00:00.000Z", recordingId: null,
    };
    const database = {
      prepare: (query: string) => {
        const prepared = statement(query);
        prepared.first = async () => session;
        return prepared;
      },
    } as unknown as D1Database;
    let touchedR2 = false;
    const media = {
      resumeMultipartUpload: () => { touchedR2 = true; return {}; },
    } as unknown as R2Bucket;
    const response = await app.request(
      "http://local.test/api/recording-uploads/upload-1/parts/1",
      { method: "PUT", headers: { "Content-Length": "2" }, body: "ab" },
      bindings(database, media),
    );
    expect(response.status).toBe(400);
    expect(touchedR2).toBe(false);
  });

  it("leaves an R2-success/D1-failure part safely uncheckpointed for retry", async () => {
    const session = {
      id: "upload-1", songId: "song-1", requestFingerprint: "a".repeat(64),
      fileManifestSha256: ABC_MANIFEST_SHA256,
      filename: "take.mp3", byteSize: 3, partCount: 1,
      objectKey: "recordings/original/upload-1", uploadId: "multipart-1",
      status: "open", revision: 2, expiresAt: "2999-01-01T00:00:00.000Z", recordingId: null,
    };
    const database = {
      prepare: (query: string) => {
        const prepared = statement(query);
        prepared.first = async () => session;
        return prepared;
      },
      batch: async () => { throw new Error("D1 unavailable"); },
    } as unknown as D1Database;
    let storedInR2 = false;
    const media = {
      resumeMultipartUpload: () => ({
        uploadPart: async () => {
          storedInR2 = true;
          return { partNumber: 1, etag: "uncheckpointed-etag" };
        },
      }),
    } as unknown as R2Bucket;
    const response = await app.request(
      "http://local.test/api/recording-uploads/upload-1/parts/1",
      {
        method: "PUT",
        headers: {
          "Content-Length": "3",
          "X-Upload-Part-Sha256": ABC_SHA256,
          "X-Upload-File-Manifest": ABC_MANIFEST_SHA256,
        },
        body: "abc",
      },
      bindings(database, media),
    );
    expect(response.status).toBe(503);
    expect(storedInR2).toBe(true);
    const text = await response.text();
    expect(text).not.toContain("uncheckpointed-etag");
    expect(JSON.parse(text)).toEqual({ error: "recording_upload_checkpoint_failed" });
  });

  it("completes with only server-held ETags and stream-hashes the private object", async () => {
    let session = {
      id: "upload-1", songId: "song-1", requestFingerprint: "a".repeat(64),
      fileManifestSha256: ABC_MANIFEST_SHA256,
      filename: "take.mp3", byteSize: 3, partCount: 1,
      objectKey: "recordings/original/upload-1", uploadId: "multipart-1",
      status: "open", revision: 3, expiresAt: "2000-01-01T00:00:00.000Z",
      sha256: null as string | null, duplicateMediaId: null, recordingId: null,
    };
    const parts = [{ partNumber: 1, etag: "server-etag", byteSize: 3, sha256: ABC_SHA256 }];
    const queries: string[] = [];
    const database = {
      prepare: (query: string) => {
        queries.push(query);
        const prepared = statement(query);
        prepared.first = async () => {
          if (query.includes("FROM recording_upload_sessions")) return session;
          return null;
        };
        prepared.all = (async () => ({ results: parts })) as FakeStatement["all"];
        prepared.run = (async () => {
          if (query.includes("SET status = 'completing'")) {
            session = { ...session, status: "completing", revision: 4 };
            return { meta: { changes: 1 } };
          }
          if (query.includes("SET status = 'stored'")) {
            session = {
              ...session,
              status: "stored",
              revision: 5,
              sha256: String(prepared.values[0]),
            };
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }) as FakeStatement["run"];
        return prepared;
      },
    } as unknown as D1Database;
    let completedWith: R2UploadedPart[] = [];
    const object = {
      key: session.objectKey,
      size: 3,
      body: new Response("abc").body,
    };
    const media = {
      head: async () => null,
      resumeMultipartUpload: () => ({
        complete: async (uploadedParts: R2UploadedPart[]) => {
          completedWith = uploadedParts;
          return object;
        },
      }),
      get: async () => object,
    } as unknown as R2Bucket;
    const restoreDigestStream = installTestDigestStream();
    try {
      const response = await app.request(
        "http://local.test/api/recording-uploads/upload-1/complete",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision: 3 }),
        },
        bindings(database, media),
      );
      expect(response.status).toBe(200);
      expect(completedWith).toEqual([{ partNumber: 1, etag: "server-etag" }]);
      const text = await response.text();
      expect(text).not.toContain("server-etag");
      expect(text).not.toContain(session.objectKey);
      expect(text).not.toContain(session.sha256!);
      expect(JSON.parse(text)).toMatchObject({ upload: { status: "stored", revision: 5 } });
      expect(queries.some((query) => query.includes("INSERT INTO recordings"))).toBe(false);
    } finally {
      restoreDigestStream();
    }
  });

  it("recovers a completed R2 object and stops a duplicate before Recording creation", async () => {
    let session = {
      id: "upload-1", songId: "song-1", requestFingerprint: "a".repeat(64),
      fileManifestSha256: ABC_MANIFEST_SHA256,
      filename: "take.mp3", byteSize: 3, partCount: 1,
      objectKey: "recordings/original/upload-1", uploadId: "multipart-1",
      status: "completing", revision: 4, expiresAt: "2000-01-01T00:00:00.000Z",
      sha256: null as string | null, duplicateMediaId: null as string | null,
      recordingId: null,
    };
    const parts = [{ partNumber: 1, etag: "server-etag", byteSize: 3, sha256: ABC_SHA256 }];
    const duplicate = {
      mediaId: "existing-media", recordingId: "existing-recording",
      songId: "existing-song", recordingTrashedAt: null, recordingRevision: 2,
    };
    const queries: string[] = [];
    const database = {
      prepare: (query: string) => {
        queries.push(query);
        const prepared = statement(query);
        prepared.first = async () => {
          if (query.includes("FROM recording_upload_sessions")) return session;
          if (query.includes("FROM media_objects")) return duplicate;
          return null;
        };
        prepared.all = (async () => ({ results: parts })) as FakeStatement["all"];
        prepared.run = (async () => {
          if (query.includes("SET status = 'stored'")) {
            session = {
              ...session,
              status: "stored",
              revision: 5,
              sha256: String(prepared.values[0]),
            };
            return { meta: { changes: 1 } };
          }
          if (query.includes("SET status = 'duplicate'")) {
            session = {
              ...session,
              status: "duplicate",
              revision: 6,
              duplicateMediaId: duplicate.mediaId,
            };
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }) as FakeStatement["run"];
        return prepared;
      },
    } as unknown as D1Database;
    let attemptedMultipartComplete = false;
    const object = {
      key: session.objectKey,
      size: 3,
      body: new Response("abc").body,
    };
    const media = {
      head: async () => object,
      resumeMultipartUpload: () => {
        attemptedMultipartComplete = true;
        return {};
      },
      get: async () => object,
    } as unknown as R2Bucket;
    const restoreDigestStream = installTestDigestStream();
    try {
      const response = await app.request(
        "http://local.test/api/recording-uploads/upload-1/complete",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision: 4 }),
        },
        bindings(database, media),
      );
      expect(response.status).toBe(200);
      expect(attemptedMultipartComplete).toBe(false);
      await expect(response.json()).resolves.toMatchObject({
        upload: {
          status: "duplicate",
          revision: 6,
          recordingId: null,
          duplicateRecording: {
            id: "existing-recording",
            songId: "existing-song",
            trashed: false,
          },
        },
      });
      expect(queries.some((query) => query.includes("INSERT INTO recordings"))).toBe(false);
      expect(queries.some((query) => (
        query.includes("FROM media_objects")
        && query.includes("playback_audio")
        && query.includes("recordings.playback_media_id")
      ))).toBe(true);
    } finally {
      restoreDigestStream();
    }
  });

  it("reopens a checkpointed session when R2 completion fails without an object", async () => {
    let session = {
      id: "upload-1", songId: "song-1", requestFingerprint: "a".repeat(64),
      fileManifestSha256: ABC_MANIFEST_SHA256,
      filename: "take.mp3", byteSize: 3, partCount: 1,
      objectKey: "recordings/original/upload-1", uploadId: "multipart-1",
      status: "open", revision: 3, expiresAt: "2999-01-01T00:00:00.000Z",
      sha256: null, duplicateMediaId: null, recordingId: null,
    };
    const database = {
      prepare: (query: string) => {
        const prepared = statement(query);
        prepared.first = async () => session;
        prepared.all = (async () => ({
          results: [{ partNumber: 1, etag: "server-etag", byteSize: 3, sha256: ABC_SHA256 }],
        })) as FakeStatement["all"];
        prepared.run = (async () => {
          if (query.includes("SET status = 'completing'")) {
            session = { ...session, status: "completing", revision: 4 };
            return { meta: { changes: 1 } };
          }
          if (query.includes("SET status = 'open'")) {
            session = { ...session, status: "open", revision: 5 };
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }) as FakeStatement["run"];
        return prepared;
      },
    } as unknown as D1Database;
    let getAttempted = false;
    const media = {
      head: async () => null,
      resumeMultipartUpload: () => ({
        complete: async () => { throw new Error("temporary R2 failure"); },
      }),
      get: async () => { getAttempted = true; return null; },
    } as unknown as R2Bucket;
    const response = await app.request(
      "http://local.test/api/recording-uploads/upload-1/complete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 3 }),
      },
      bindings(database, media),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "recording_upload_storage_completion_failed",
    });
    expect(session).toMatchObject({ status: "open", revision: 5 });
    expect(getAttempted).toBe(false);
  });

  it("fails closed when the completed private object has the wrong size", async () => {
    let session = {
      id: "upload-1", songId: "song-1", requestFingerprint: "a".repeat(64),
      fileManifestSha256: ABC_MANIFEST_SHA256,
      filename: "take.mp3", byteSize: 3, partCount: 1,
      objectKey: "recordings/original/upload-1", uploadId: "multipart-1",
      status: "completing", revision: 4, expiresAt: "2999-01-01T00:00:00.000Z",
      sha256: null, duplicateMediaId: null, recordingId: null,
    };
    const database = {
      prepare: (query: string) => {
        const prepared = statement(query);
        prepared.first = async () => session;
        prepared.all = (async () => ({
          results: [{ partNumber: 1, etag: "server-etag", byteSize: 3, sha256: ABC_SHA256 }],
        })) as FakeStatement["all"];
        prepared.run = (async () => {
          if (query.includes("SET status = 'failed'")) {
            session = { ...session, status: "failed", revision: 5 };
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }) as FakeStatement["run"];
        return prepared;
      },
    } as unknown as D1Database;
    let getAttempted = false;
    const media = {
      head: async () => ({ key: session.objectKey, size: 4 }),
      get: async () => { getAttempted = true; return null; },
    } as unknown as R2Bucket;
    const response = await app.request(
      "http://local.test/api/recording-uploads/upload-1/complete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 4 }),
      },
      bindings(database, media),
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "recording_upload_stored_object_mismatch",
    });
    expect(session).toMatchObject({ status: "failed", revision: 5 });
    expect(getAttempted).toBe(false);
  });

  it("rejects an expired upload before touching R2", async () => {
    const session = {
      id: "upload-1", songId: "song-1", requestFingerprint: "a".repeat(64),
      fileManifestSha256: ABC_MANIFEST_SHA256,
      filename: "take.mp3", byteSize: 3, partCount: 1,
      objectKey: "recordings/original/upload-1", uploadId: "multipart-1",
      status: "open", revision: 2, expiresAt: "2000-01-01T00:00:00.000Z", recordingId: null,
    };
    const database = {
      prepare: (query: string) => {
        const prepared = statement(query);
        prepared.first = async () => session;
        return prepared;
      },
    } as unknown as D1Database;
    let touchedR2 = false;
    const media = {
      resumeMultipartUpload: () => { touchedR2 = true; return {}; },
    } as unknown as R2Bucket;
    const response = await app.request(
      "http://local.test/api/recording-uploads/upload-1/parts/1",
      { method: "PUT", headers: { "Content-Length": "3" }, body: "abc" },
      bindings(database, media),
    );
    expect(response.status).toBe(410);
    expect(touchedR2).toBe(false);
  });

  it("returns only resumable part numbers and aborts D1 before best-effort R2 cleanup", async () => {
    let session = {
      id: "upload-1", songId: "song-1", requestFingerprint: "a".repeat(64),
      fileManifestSha256: "e".repeat(64),
      filename: "take.mp3", byteSize: 9_000_000, partCount: 2,
      objectKey: "recordings/original/upload-1", uploadId: "multipart-1",
      status: "open", revision: 4, expiresAt: "2999-01-01T00:00:00.000Z", recordingId: null,
    };
    const database = {
      prepare: (query: string) => {
        const prepared = statement(query);
        prepared.first = async () => query.includes("FROM recording_upload_sessions") ? session : null;
        prepared.all = (async () => ({ results: [{ partNumber: 1 }, { partNumber: 2 }] })) as FakeStatement["all"];
        prepared.run = (async () => {
          session = { ...session, status: "aborted", revision: 5 };
          return { meta: { changes: 1 } };
        }) as FakeStatement["run"];
        return prepared;
      },
    } as unknown as D1Database;
    let abortAttempted = false;
    const media = {
      resumeMultipartUpload: () => ({
        abort: async () => { abortAttempted = true; throw new Error("temporary R2 failure"); },
      }),
    } as unknown as R2Bucket;

    const status = await app.request(
      "http://local.test/api/recording-uploads/upload-1",
      undefined,
      bindings(database, media),
    );
    const statusText = await status.text();
    expect(statusText).not.toContain("multipart-1");
    expect(statusText).not.toContain("recordings/original");
    expect(JSON.parse(statusText)).toMatchObject({ upload: { completedParts: [1, 2] } });

    const aborted = await app.request(
      "http://local.test/api/recording-uploads/upload-1/abort",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 4 }),
      },
      bindings(database, media),
    );
    expect(aborted.status).toBe(200);
    expect(abortAttempted).toBe(true);
    await expect(aborted.json()).resolves.toMatchObject({
      upload: { status: "aborted", revision: 5 },
      cleanupDeferred: true,
    });
  });

  it("blocks viewers before upload parsing or storage access", async () => {
    let touched = false;
    const database = { prepare: () => { touched = true; return {}; } } as unknown as D1Database;
    const media = { createMultipartUpload: () => { touched = true; } } as unknown as R2Bucket;
    const response = await app.request(
      "http://local.test/api/songs/song-1/recording-uploads",
      { method: "POST", body: "{}" },
      bindings(database, media, "viewer"),
    );
    expect(response.status).toBe(403);
    expect(touched).toBe(false);
  });
});
