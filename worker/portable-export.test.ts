import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "./index";
import {
  cleanupPortableExports,
  createPortableExport,
  loadCurrentPortableExport,
  loadPortableExport,
  pagePortableExportItems,
  pagePortableExportRecords,
  parsePortableRange,
  resolvePortableSourceCommit,
  type PortableExportItem,
  type PortableExportRecord,
  PORTABLE_EXPORT_CLEANUP_GRACE_MS,
  PORTABLE_EXPORT_ITEM_CHUNK_SIZE,
  PORTABLE_EXPORT_RECORD_CHUNK_SIZE,
  PORTABLE_SNAPSHOT_STATEMENT_COUNT,
  validPortableSourceCommit,
} from "./portable-export";

type BoundValue = string | number | null;

class TestD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    readonly sql: string,
    readonly bindings: BoundValue[] = [],
  ) {}

  bind(...values: BoundValue[]): TestD1Statement {
    return new TestD1Statement(this.database, this.sql, values);
  }

  private statement(): StatementSync {
    return this.database.prepare(this.sql);
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.statement().run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  async all<T>(): Promise<{ success: true; results: T[]; meta: { changes: number } }> {
    return {
      success: true,
      results: this.statement().all(...this.bindings) as T[],
      meta: { changes: 0 },
    };
  }

  async first<T>(): Promise<T | null> {
    return (this.statement().get(...this.bindings) as T | undefined) ?? null;
  }
}

class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  enforceD1CompoundSelectLimit = false;

  prepare(sql: string): TestD1Statement {
    return new TestD1Statement(this.sqlite, sql);
  }

  async batch(statements: TestD1Statement[]): Promise<Array<{ success: true; meta: { changes: number } }>> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) {
        if (
          this.enforceD1CompoundSelectLimit
          && (statement.sql.match(/\bUNION(?:\s+ALL)?\b/giu)?.length ?? 0) >= 5
        ) {
          throw new Error("too many terms in compound SELECT: SQLITE_ERROR [code: 7500]");
        }
        results.push(await statement.run());
      }
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.sqlite.close();
  }
}

class TestR2 {
  readonly objects = new Map<string, Uint8Array>([
    ["scans/original/scan-media-1", new Uint8Array([1, 2, 3, 4])],
    ["scans/readability-v2/scan-media-1.jpg", new Uint8Array([5, 6, 7])],
    ["recordings/original/audio-media-1", new Uint8Array([8, 9, 10, 11, 12])],
  ]);
  reads = 0;
  sizeAdjustment = 0;
  failReads = false;

  async get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<R2ObjectBody | null> {
    this.reads += 1;
    if (this.failReads) throw new Error("synthetic R2 failure");
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    const range = options?.range;
    const selected = range ? bytes.slice(range.offset, range.offset + range.length) : bytes;
    return {
      key,
      version: "test",
      size: bytes.byteLength + this.sizeAdjustment,
      etag: "not-exposed",
      httpEtag: '"not-exposed"',
      uploaded: new Date("2026-07-24T00:00:00.000Z"),
      checksums: {},
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {},
      storageClass: "Standard",
      range: range ? { offset: range.offset, length: range.length } : undefined,
      body: new Response(selected).body!,
      bodyUsed: false,
      arrayBuffer: () => Promise.resolve(selected.buffer.slice(
        selected.byteOffset,
        selected.byteOffset + selected.byteLength,
      ) as ArrayBuffer),
      bytes: () => Promise.resolve(selected),
      text: () => Promise.resolve(new TextDecoder().decode(selected)),
      json: () => Promise.reject(new Error("not json")),
      blob: () => Promise.resolve(new Blob([selected])),
      writeHttpMetadata: () => undefined,
    } as unknown as R2ObjectBody;
  }
}

function applyMigrations(database: DatabaseSync): void {
  for (const name of readdirSync(resolve("migrations"))
    .filter((entry) => /^\d{4}_.+\.sql$/u.test(entry))
    .sort()) {
    database.exec(readFileSync(resolve("migrations", name), "utf8"));
  }
}

function seedSource(database: DatabaseSync): void {
  const timestamp = "2026-07-24T00:00:00.000Z";
  database.exec(`
    INSERT INTO app_users (
      identity, display_name, role, is_active, created_at, updated_at
    ) VALUES ('local@example.invalid', 'Synthetic admin', 'admin', 1, '${timestamp}', '${timestamp}');
    INSERT INTO languages (id, display_name, bcp47_tag, sort_order, normalized_name)
    VALUES ('language-1', 'Language One', 'und', 0, 'language one');
    INSERT INTO tags (id, display_name, sort_order, normalized_name)
    VALUES ('tag-1', 'Tag One', 0, 'tag one');
    INSERT INTO notebooks (id, display_name, sort_order, normalized_name)
    VALUES ('notebook-1', 'Notebook One', 0, 'notebook one');
    INSERT INTO people (id, full_name, normalized_name, created_at, updated_at)
    VALUES ('person-1', 'Synthetic Person', 'synthetic person', '${timestamp}', '${timestamp}');
    INSERT INTO songs (
      id, title_latin, title_native, status, notes, revision,
      created_at, created_by, updated_at, updated_by,
      normalized_title_latin, last_mutation_id
    ) VALUES (
      'song-1', 'Synthetic Song', NULL, 'checked', 'Synthetic note', 1,
      '${timestamp}', 'local@example.invalid', '${timestamp}', 'local@example.invalid',
      'synthetic song', 'mutation-1'
    );
    INSERT INTO song_languages (song_id, language_id, sort_order)
    VALUES ('song-1', 'language-1', 0);
    INSERT INTO song_tags (song_id, tag_id, sort_order)
    VALUES ('song-1', 'tag-1', 0);
    INSERT INTO song_aliases (id, song_id, alias, normalized_alias, sort_order)
    VALUES ('alias-1', 'song-1', 'Neutral Alias', 'neutral alias', 0);
    INSERT INTO song_credits (id, song_id, person_id, role, sort_order)
    VALUES ('credit-1', 'song-1', 'person-1', 'lyrics', 0);
    INSERT INTO lyric_texts (
      id, song_id, content, origin, sort_order, revision,
      created_at, created_by, updated_at, updated_by
    ) VALUES (
      'lyric-1', 'song-1', 'Synthetic text', 'user', 0, 1,
      '${timestamp}', 'local@example.invalid', '${timestamp}', 'local@example.invalid'
    );
    INSERT INTO media_objects (
      id, object_key, original_filename, mime_type, byte_size, sha256, kind,
      created_at, created_by
    ) VALUES (
      'scan-media-1', 'scans/original/scan-media-1', 'scan.jpg', 'image/jpeg',
      4, '${"1".repeat(64)}', 'scan', '${timestamp}', 'local@example.invalid'
    );
    INSERT INTO scans (
      id, song_id, media_id, notebook_id, page_label, revision,
      created_at, created_by, updated_at, updated_by, rotation_quarter_turns
    ) VALUES (
      'scan-1', 'song-1', 'scan-media-1', 'notebook-1', '1', 1,
      '${timestamp}', 'local@example.invalid', '${timestamp}', 'local@example.invalid', 0
    );
    INSERT INTO scan_readability_derivatives (
      source_media_id, source_sha256, source_byte_size, object_key,
      mime_type, byte_size, sha256, width, height, policy_id, created_at, created_by
    ) VALUES (
      'scan-media-1', '${"1".repeat(64)}', 4, 'scans/readability-v2/scan-media-1.jpg',
      'image/jpeg', 3, '${"2".repeat(64)}', 10, 10, 'scan-jpeg-v1-2400-q85',
      '${timestamp}', 'system:scan-maintenance'
    );
    INSERT INTO scan_readability_selections (
      source_media_id, source_sha256, source_byte_size,
      source_width, source_height, representation_kind, selection_basis,
      candidate_byte_size, policy_id, created_at, created_by
    ) VALUES (
      'scan-media-1', '${"1".repeat(64)}', 4, 10, 10,
      'derivative', 'required_normalization', 3,
      'scan-readability-selection-v2', '${timestamp}', 'system:scan-maintenance'
    );
    INSERT INTO media_objects (
      id, object_key, original_filename, mime_type, byte_size, sha256, kind,
      created_at, created_by
    ) VALUES (
      'audio-media-1', 'recordings/original/audio-media-1', 'recording.mp3', 'audio/mpeg',
      5, '${"3".repeat(64)}', 'original_audio', '${timestamp}', 'local@example.invalid'
    );
    INSERT INTO recordings (
      id, song_id, original_media_id, description, normalized_description,
      processing_state, revision, created_at, created_by, updated_at, updated_by
    ) VALUES (
      'recording-1', 'song-1', 'audio-media-1', 'Synthetic take', 'synthetic take',
      'ready', 1, '${timestamp}', 'local@example.invalid', '${timestamp}', 'local@example.invalid'
    );
    INSERT INTO recording_credits (id, recording_id, person_id, role, sort_order)
    VALUES ('recording-credit-1', 'recording-1', 'person-1', 'vocals', 0);
  `);
}

function env(database: TestD1, media: TestR2, role: "viewer" | "editor" | "admin" = "admin") {
  return {
    DB: database as unknown as D1Database,
    MEDIA: media as unknown as R2Bucket,
    IMAGES: {} as ImagesBinding,
    AUTH_MODE: "local",
    LOCAL_ROLE: role,
    ACCESS_AUD: "",
    ACCESS_ISSUER: "",
    ACCESS_JWKS_URL: "",
    SOURCE_COMMIT: "1234567890abcdef1234567890abcdef12345678",
  };
}

async function json(response: Response): Promise<Record<string, any>> {
  return response.json() as Promise<Record<string, any>>;
}

async function allRecordPages(
  database: TestD1,
  exportId: string,
  now = new Date("2026-07-24T01:01:00.000Z"),
) {
  const records: PortableExportRecord[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await pagePortableExportRecords(
      database as unknown as D1Database,
      exportId,
      "local@example.invalid",
      { limit: 200, offset },
      now,
    );
    if (!page) throw new Error("synthetic portable page unavailable");
    records.push(...page.records);
    offset = page.nextOffset;
  }
  return records;
}

async function allItemPages(
  database: TestD1,
  exportId: string,
  now = new Date("2026-07-24T01:01:00.000Z"),
) {
  const items: PortableExportItem[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await pagePortableExportItems(
      database as unknown as D1Database,
      exportId,
      "local@example.invalid",
      { limit: 200, offset },
      now,
    );
    if (!page) throw new Error("synthetic portable item page unavailable");
    items.push(...page.items);
    offset = page.nextOffset;
  }
  return items;
}

describe("portable export server", () => {
  let database: TestD1;
  let mediaBucket: TestR2;

  beforeEach(() => {
    database = new TestD1();
    applyMigrations(database.sqlite);
    seedSource(database.sqlite);
    mediaBucket = new TestR2();
  });

  afterEach(() => database.close());

  it("rejects missing or malformed protected source provenance before snapshot writes", async () => {
    expect(resolvePortableSourceCommit(undefined, "access")).toBeNull();
    expect(resolvePortableSourceCommit("", "access")).toBeNull();
    expect(resolvePortableSourceCommit("123456", "access")).toBeNull();
    expect(resolvePortableSourceCommit("123456A", "access")).toBeNull();
    expect(resolvePortableSourceCommit("local-development", "access")).toBeNull();
    expect(resolvePortableSourceCommit(undefined, "local")).toBe("local-development");
    expect(validPortableSourceCommit("1234567")).toBe(true);
    expect(validPortableSourceCommit("123456")).toBe(false);

    const response = await app.request("/api/admin/portable-exports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientMutationId: "invalid-source-commit" }),
    }, {
      ...env(database, mediaBucket),
      SOURCE_COMMIT: "malformed",
    });

    expect(response.status).toBe(503);
    expect(await json(response)).toEqual({ error: "portable_export_not_configured" });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_export_sessions")
      .get()).toEqual({ count: 0 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_export_records")
      .get()).toEqual({ count: 0 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_export_items")
      .get()).toEqual({ count: 0 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_export_item_chunks")
      .get()).toEqual({ count: 0 });
  });

  it("uses one bounded transactional batch, freezes later source edits, and replays exactly", async () => {
    database.enforceD1CompoundSelectLimit = true;
    expect(PORTABLE_SNAPSHOT_STATEMENT_COUNT).toBeLessThan(50);
    const first = await createPortableExport(
      database as unknown as D1Database,
      "local@example.invalid",
      "1234567890abcdef1234567890abcdef12345678",
      "synthetic",
      "mutation-1",
      new Date("2026-07-24T01:00:00.000Z"),
    );
    expect(first.state).toBe("ready");
    expect(first.itemCount).toBe(3);
    expect(first.plannedBytes).toBe(12);
    const physicalRecords = database.sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM portable_export_records
      WHERE export_id = ?
    `).get(first.id) as { count: number };
    const physicalItemChunks = database.sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM portable_export_item_chunks
      WHERE export_id = ?
    `).get(first.id) as { count: number };
    expect(first.recordCount).toBeGreaterThan(physicalRecords.count);
    expect(first.itemCount).toBeGreaterThan(physicalItemChunks.count);
    expect(database.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM portable_export_items WHERE export_id = ?
    `).get(first.id)).toEqual({ count: 0 });
    expect(first).toMatchObject({
      activeSongs: 1,
      trashedSongs: 0,
      activeLyrics: 1,
      trashedLyrics: 0,
      activeScans: 1,
      trashedScans: 0,
      activeRecordings: 1,
      trashedRecordings: 0,
      historyRelationships: 0,
      unassignedMedia: 0,
    });

    database.sqlite.exec("UPDATE songs SET title_latin = 'Later edit' WHERE id = 'song-1'");
    const records = await allRecordPages(database, first.id);
    const items = await allItemPages(database, first.id);
    expect(records).toHaveLength(first.recordCount);
    expect(items).toHaveLength(first.itemCount);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    expect(records.find((entry) => entry.kind === "songs")?.data.title_latin)
      .toBe("Synthetic Song");

    const replay = await createPortableExport(
      database as unknown as D1Database,
      "local@example.invalid",
      "1234567890abcdef1234567890abcdef12345678",
      "synthetic",
      "mutation-1",
      new Date("2026-07-24T02:00:00.000Z"),
    );
    expect(replay.id).toBe(first.id);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_export_sessions")
      .get()).toEqual({ count: 1 });
  });

  it("stores bounded chunks, expands stable logical pages, and rejects a malformed chunk", async () => {
    const insertAlias = database.sqlite.prepare(`
      INSERT INTO song_aliases (id, song_id, alias, normalized_alias, sort_order)
      VALUES (?, 'song-1', ?, ?, ?)
    `);
    for (let index = 0; index < PORTABLE_EXPORT_RECORD_CHUNK_SIZE * 2; index += 1) {
      const suffix = index.toString().padStart(3, "0");
      insertAlias.run(
        `alias-many-${suffix}`,
        `Synthetic Alias ${suffix}`,
        `synthetic alias ${suffix}`,
        index + 1,
      );
    }
    const created = await createPortableExport(
      database as unknown as D1Database,
      "local@example.invalid",
      "1234567890abcdef1234567890abcdef12345678",
      "synthetic",
      "chunk-mutation",
      new Date("2026-07-24T01:00:00.000Z"),
    );
    expect(database.sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM portable_export_records
      WHERE export_id = ? AND record_kind = 'song_aliases'
    `).get(created.id)).toEqual({ count: 3 });

    const records = await allRecordPages(database, created.id);
    const aliases = records.filter((record) => record.kind === "song_aliases");
    expect(records).toHaveLength(created.recordCount);
    expect(aliases).toHaveLength(PORTABLE_EXPORT_RECORD_CHUNK_SIZE * 2 + 1);
    expect(new Set(aliases.map((record) => record.key)).size).toBe(aliases.length);
    expect(aliases.map((record) => record.orderKey)).toEqual(
      [...aliases.map((record) => record.orderKey)].sort(),
    );

    database.sqlite.exec("DROP TRIGGER prevent_portable_export_record_update");
    database.sqlite.prepare(`
      UPDATE portable_export_records
      SET frozen_json = '{"unexpected":"shape"}'
      WHERE export_id = ? AND record_kind = 'song_aliases' AND record_key = '@chunk:00000000'
    `).run(created.id);
    const corruptOffset = database.sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM portable_export_records
      WHERE export_id = ? AND record_kind < 'song_aliases'
    `).get(created.id) as { count: number };
    await expect(pagePortableExportRecords(
      database as unknown as D1Database,
      created.id,
      "local@example.invalid",
      { limit: 200, offset: corruptOffset.count },
      new Date("2026-07-24T01:01:00.000Z"),
    )).rejects.toThrow("portable_frozen_record_chunk_invalid");
  });

  it("stores opaque bounded item chunks and rejects malformed private item data", async () => {
    const insertMedia = database.sqlite.prepare(`
      INSERT INTO media_objects (
        id, object_key, original_filename, mime_type, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES (?, ?, ?, 'audio/mpeg', 1, ?, 'original_audio',
        '2026-07-24T00:00:00.000Z', 'local@example.invalid')
    `);
    for (let index = 0; index < PORTABLE_EXPORT_ITEM_CHUNK_SIZE * 2; index += 1) {
      const suffix = index.toString().padStart(3, "0");
      insertMedia.run(
        `unassigned-media-${suffix}`,
        `recordings/original/unassigned-media-${suffix}`,
        `synthetic-${suffix}.mp3`,
        index.toString(16).padStart(64, "0"),
      );
    }
    const created = await createPortableExport(
      database as unknown as D1Database,
      "local@example.invalid",
      "1234567890abcdef1234567890abcdef12345678",
      "synthetic",
      "item-chunk-mutation",
      new Date("2026-07-24T01:00:00.000Z"),
    );
    expect(database.sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM portable_export_item_chunks
      WHERE export_id = ?
    `).get(created.id)).toEqual({ count: 3 });
    const firstPage = await pagePortableExportItems(
      database as unknown as D1Database,
      created.id,
      "local@example.invalid",
      { limit: 200, offset: 0 },
      new Date("2026-07-24T01:01:00.000Z"),
    );
    expect(firstPage?.items).toHaveLength(created.itemCount);
    expect(firstPage?.nextOffset).toBeNull();
    const items = await allItemPages(database, created.id);
    expect(items).toHaveLength(created.itemCount);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    expect(items.every((item) => /^[0-9a-f]{32}$/u.test(item.id))).toBe(true);

    database.sqlite.exec("DROP TRIGGER prevent_portable_export_item_chunk_update");
    database.sqlite.prepare(`
      UPDATE portable_export_item_chunks
      SET item_count = 1,
          planned_bytes = 1,
          frozen_json = '[{"sourceKind":"media_object"}]'
      WHERE export_id = ? AND chunk_key = '@chunk:00000000'
    `).run(created.id);
    await expect(pagePortableExportItems(
      database as unknown as D1Database,
      created.id,
      "local@example.invalid",
      { limit: 200, offset: 0 },
      new Date("2026-07-24T01:01:00.000Z"),
    )).rejects.toThrow("portable_frozen_item_chunk_invalid");
  });

  it("rolls back an invalid snapshot and retains only a bounded failed replay stub", async () => {
    database.sqlite.exec(`
      INSERT INTO media_objects (
        id, object_key, original_filename, mime_type, byte_size, sha256, kind,
        created_at, created_by
      ) VALUES (
        'invalid-audio', 'recordings/original/invalid', 'invalid.wav', 'audio/wav',
        1, NULL, 'original_audio', '2026-07-24T00:00:00.000Z', 'local@example.invalid'
      )
    `);
    const failed = await createPortableExport(
      database as unknown as D1Database,
      "local@example.invalid",
      "1234567890abcdef1234567890abcdef12345678",
      "synthetic",
      "mutation-failed",
      new Date("2026-07-24T01:00:00.000Z"),
    );
    expect(failed.state).toBe("failed");
    expect(failed.failureCode).toBe("snapshot_precondition_failed");
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_export_records")
      .get()).toEqual({ count: 0 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_export_items")
      .get()).toEqual({ count: 0 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_export_item_chunks")
      .get()).toEqual({ count: 0 });

    database.batch = async () => {
      throw new Error("synthetic execution boundary");
    };
    const executionFailed = await createPortableExport(
      database as unknown as D1Database,
      "local@example.invalid",
      "1234567890abcdef1234567890abcdef12345678",
      "synthetic",
      "mutation-execution-failed",
      new Date("2026-07-24T01:00:00.000Z"),
    );
    expect(executionFailed).toMatchObject({
      state: "failed",
      failureCode: "snapshot_execution_failed",
    });
  });

  it("enforces role, active Access middleware, creator binding, mutation media type, and private paging", async () => {
    const viewerResponse = await app.request("/api/admin/portable-exports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientMutationId: "viewer-mutation" }),
    }, env(database, mediaBucket, "viewer"));
    expect(viewerResponse.status).toBe(403);

    const wrongType = await app.request("/api/admin/portable-exports", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    }, env(database, mediaBucket));
    expect(wrongType.status).toBe(415);

    const response = await app.request("/api/admin/portable-exports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientMutationId: "admin-mutation" }),
    }, env(database, mediaBucket));
    expect(response.status).toBe(201);
    const exportId = (await json(response)).export.id as string;

    const currentResponse = await app.request(
      "/api/admin/portable-exports/current",
      {},
      env(database, mediaBucket),
    );
    expect(currentResponse.status).toBe(200);
    expect((await json(currentResponse)).export.id).toBe(exportId);
    expect((await loadCurrentPortableExport(
      database as unknown as D1Database,
      "local@example.invalid",
    ))?.id).toBe(exportId);

    const duplicatePrepare = await app.request("/api/admin/portable-exports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientMutationId: "another-admin-mutation" }),
    }, env(database, mediaBucket));
    expect(duplicatePrepare.status).toBe(200);
    expect((await json(duplicatePrepare)).export.id).toBe(exportId);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_export_sessions")
      .get()).toEqual({ count: 1 });

    const recordsResponse = await app.request(
      `/api/admin/portable-exports/${exportId}/records?limit=1`,
      {},
      env(database, mediaBucket),
    );
    expect(recordsResponse.status).toBe(200);
    expect(recordsResponse.headers.get("Cache-Control")).toBe("private, no-store");
    expect(recordsResponse.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((await json(recordsResponse)).nextOffset).toBe(1);

    const itemResponse = await app.request(
      `/api/admin/portable-exports/${exportId}/items?limit=200`,
      {},
      env(database, mediaBucket),
    );
    const itemText = await itemResponse.text();
    expect(itemResponse.status).toBe(200);
    expect(itemText).not.toContain("objectKey");
    expect(itemText).not.toContain("scans/original");
    expect(itemText).not.toContain("local@example.invalid");

    expect(await loadPortableExport(
      database as unknown as D1Database,
      exportId,
      "another@example.invalid",
    )).toBeNull();

    const accessResponse = await app.request("/api/admin/portable-exports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://app.example",
      },
      body: JSON.stringify({ clientMutationId: "access-mutation" }),
    }, {
      ...env(database, mediaBucket),
      AUTH_MODE: "access",
      ACCESS_AUD: "audience",
      ACCESS_ISSUER: "https://issuer.example",
      ACCESS_JWKS_URL: "https://issuer.example/certs",
    });
    expect(accessResponse.status).toBe(401);
  });

  it("streams only the server-resolved object with ordinary, open, and suffix single ranges", async () => {
    const prepared = await app.request("/api/admin/portable-exports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientMutationId: "range-mutation" }),
    }, env(database, mediaBucket));
    const exportId = (await json(prepared)).export.id as string;
    const listed = await app.request(
      `/api/admin/portable-exports/${exportId}/items?limit=200`,
      {},
      env(database, mediaBucket),
    );
    const items = (await json(listed)).items as Array<Record<string, any>>;
    const audio = items.find((item) => item.sourceId === "audio-media-1")!;
    const contentPath = audio.contentPath as string;

    const complete = await app.request(contentPath, {}, env(database, mediaBucket));
    expect(complete.status).toBe(200);
    expect([...new Uint8Array(await complete.arrayBuffer())]).toEqual([8, 9, 10, 11, 12]);
    expect(complete.headers.get("ETag")).toBeNull();
    expect(complete.headers.get("Content-Disposition")).toBe("attachment; filename=payload.bin");

    const open = await app.request(contentPath, {
      headers: { Range: "bytes=2-" },
    }, env(database, mediaBucket));
    expect(open.status).toBe(206);
    expect(open.headers.get("Content-Range")).toBe("bytes 2-4/5");
    expect([...new Uint8Array(await open.arrayBuffer())]).toEqual([10, 11, 12]);

    const suffix = await app.request(contentPath, {
      headers: { Range: "bytes=-2" },
    }, env(database, mediaBucket));
    expect(suffix.status).toBe(206);
    expect([...new Uint8Array(await suffix.arrayBuffer())]).toEqual([11, 12]);

    for (const invalid of ["bytes=0-1,3-4", "bytes=9-", "bytes=-0", "items=0-1"]) {
      const rejected = await app.request(contentPath, {
        headers: { Range: invalid },
      }, env(database, mediaBucket));
      expect(rejected.status, invalid).toBe(416);
    }
    expect(parsePortableRange("bytes=0-99", 5)).toEqual({ offset: 0, length: 5 });
  });

  it("fails closed for missing or changed R2 bytes without exposing locators", async () => {
    const created = await createPortableExport(
      database as unknown as D1Database,
      "local@example.invalid",
      "1234567890abcdef1234567890abcdef12345678",
      "synthetic",
      "storage-mutation",
    );
    const item = (await allItemPages(database, created.id))
      .find((candidate) => candidate.sourceId === "audio-media-1");
    if (!item) throw new Error("synthetic audio export item unavailable");
    const path = `/api/admin/portable-exports/${created.id}/items/${item.id}/content`;

    mediaBucket.objects.delete("recordings/original/audio-media-1");
    const missing = await app.request(path, {}, env(database, mediaBucket));
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain("recordings/original");

    mediaBucket.objects.set(
      "recordings/original/audio-media-1",
      new Uint8Array([8, 9, 10, 11, 12]),
    );
    mediaBucket.sizeAdjustment = 1;
    const changed = await app.request(path, {}, env(database, mediaBucket));
    expect(changed.status).toBe(409);

    mediaBucket.sizeAdjustment = 0;
    mediaBucket.failReads = true;
    const unavailable = await app.request(path, {}, env(database, mediaBucket));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("recordings/original");
  });

  it("revokes/expires and purges only export detail after the six-hour grace", async () => {
    const created = await createPortableExport(
      database as unknown as D1Database,
      "local@example.invalid",
      "1234567890abcdef1234567890abcdef12345678",
      "synthetic",
      "cleanup-mutation",
      new Date(),
    );
    const revoked = await app.request(`/api/admin/portable-exports/${created.id}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }, env(database, mediaBucket));
    expect(revoked.status).toBe(200);

    const beforeCounts = database.sqlite.prepare(`
      SELECT
        (SELECT COUNT(*) FROM songs) AS songs,
        (SELECT COUNT(*) FROM media_objects) AS media
    `).get();
    const cleanup = await cleanupPortableExports(
      database as unknown as D1Database,
      new Date(Date.now() + PORTABLE_EXPORT_CLEANUP_GRACE_MS + 1000),
    );
    expect(cleanup.purgedSessions).toBe(1);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_export_records")
      .get()).toEqual({ count: 0 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_export_items")
      .get()).toEqual({ count: 0 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_export_item_chunks")
      .get()).toEqual({ count: 0 });
    expect(database.sqlite.prepare(`
      SELECT
        (SELECT COUNT(*) FROM songs) AS songs,
        (SELECT COUNT(*) FROM media_objects) AS media
    `).get()).toEqual(beforeCounts);
    expect((database.sqlite.prepare(`
      SELECT state, detail_purged_at AS purged FROM portable_export_sessions WHERE id = ?
    `).get(created.id) as { state: string; purged: string | null }).state).toBe("revoked");
  });
});
