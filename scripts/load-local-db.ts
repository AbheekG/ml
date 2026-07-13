import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";

type JsonRow = Record<string, unknown>;
type Catalog = Record<string, unknown> & {
  schemaVersion: number;
};

type TableMapping = {
  table: string;
  catalogKey: string;
  columns: Array<[databaseColumn: string, jsonProperty: string]>;
};

const TABLE_MAPPINGS: TableMapping[] = [
  {
    table: "languages",
    catalogKey: "languages",
    columns: [["id", "id"], ["display_name", "displayName"], ["normalized_name", "normalizedName"], ["bcp47_tag", "bcp47Tag"], ["sort_order", "sortOrder"]],
  },
  {
    table: "tags",
    catalogKey: "tags",
    columns: [["id", "id"], ["display_name", "displayName"], ["normalized_name", "normalizedName"], ["sort_order", "sortOrder"]],
  },
  {
    table: "notebooks",
    catalogKey: "notebooks",
    columns: [["id", "id"], ["display_name", "displayName"], ["normalized_name", "normalizedName"], ["sort_order", "sortOrder"]],
  },
  {
    table: "people",
    catalogKey: "people",
    columns: [["id", "id"], ["full_name", "fullName"], ["normalized_name", "normalizedName"], ["created_at", "createdAt"], ["updated_at", "updatedAt"]],
  },
  {
    table: "songs",
    catalogKey: "songs",
    columns: [
      ["id", "id"], ["title_latin", "titleLatin"], ["normalized_title_latin", "normalizedTitleLatin"], ["title_native", "titleNative"],
      ["status", "status"], ["notes", "notes"], ["revision", "revision"],
      ["created_at", "createdAt"], ["created_by", "createdBy"],
      ["updated_at", "updatedAt"], ["updated_by", "updatedBy"],
      ["trashed_at", "trashedAt"], ["trashed_by", "trashedBy"],
    ],
  },
  {
    table: "song_aliases",
    catalogKey: "songAliases",
    columns: [["id", "id"], ["song_id", "songId"], ["alias", "alias"], ["normalized_alias", "normalizedAlias"], ["sort_order", "sortOrder"]],
  },
  {
    table: "song_languages",
    catalogKey: "songLanguages",
    columns: [["song_id", "songId"], ["language_id", "languageId"], ["sort_order", "sortOrder"]],
  },
  {
    table: "song_tags",
    catalogKey: "songTags",
    columns: [["song_id", "songId"], ["tag_id", "tagId"], ["sort_order", "sortOrder"]],
  },
  {
    table: "song_credits",
    catalogKey: "songCredits",
    columns: [["id", "id"], ["song_id", "songId"], ["person_id", "personId"], ["role", "role"], ["sort_order", "sortOrder"]],
  },
  {
    table: "lyric_texts",
    catalogKey: "lyricTexts",
    columns: [
      ["id", "id"], ["song_id", "songId"], ["content", "content"], ["origin", "origin"],
      ["sort_order", "sortOrder"], ["revision", "revision"],
      ["created_at", "createdAt"], ["created_by", "createdBy"],
      ["updated_at", "updatedAt"], ["updated_by", "updatedBy"],
      ["trashed_at", "trashedAt"], ["trashed_by", "trashedBy"],
    ],
  },
  {
    table: "media_objects",
    catalogKey: "mediaObjects",
    columns: [
      ["id", "id"], ["object_key", "objectKey"], ["original_filename", "originalFilename"],
      ["mime_type", "mimeType"], ["byte_size", "byteSize"], ["sha256", "sha256"],
      ["kind", "kind"], ["state", "state"], ["created_at", "createdAt"],
      ["created_by", "createdBy"], ["trashed_at", "trashedAt"], ["trashed_by", "trashedBy"],
    ],
  },
  {
    table: "scans",
    catalogKey: "scans",
    columns: [
      ["id", "id"], ["song_id", "songId"], ["media_id", "mediaId"],
      ["notebook_id", "notebookId"], ["page_label", "pageLabel"],
      ["legacy_version", "legacyVersion"], ["legacy_captured_on", "legacyCapturedOn"],
      ["legacy_source", "legacySource"], ["legacy_scan_text", "legacyScanText"],
      ["legacy_notes", "legacyNotes"], ["revision", "revision"],
      ["created_at", "createdAt"], ["created_by", "createdBy"],
      ["updated_at", "updatedAt"], ["updated_by", "updatedBy"],
      ["trashed_at", "trashedAt"], ["trashed_by", "trashedBy"],
    ],
  },
  {
    table: "recordings",
    catalogKey: "recordings",
    columns: [
      ["id", "id"], ["song_id", "songId"], ["original_media_id", "originalMediaId"],
      ["playback_media_id", "playbackMediaId"], ["description", "description"],
      ["normalized_description", "normalizedDescription"], ["recorded_on", "recordedOn"],
      ["processing_state", "processingState"], ["processing_error", "processingError"],
      ["legacy_version", "legacyVersion"], ["legacy_notes", "legacyNotes"], ["revision", "revision"],
      ["created_at", "createdAt"], ["created_by", "createdBy"],
      ["updated_at", "updatedAt"], ["updated_by", "updatedBy"],
      ["trashed_at", "trashedAt"], ["trashed_by", "trashedBy"],
    ],
  },
  {
    table: "recording_credits",
    catalogKey: "recordingCredits",
    columns: [["id", "id"], ["recording_id", "recordingId"], ["person_id", "personId"], ["role", "role"], ["sort_order", "sortOrder"]],
  },
];

function asSqlValue(value: unknown): SQLInputValue {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new Error(`Unsupported database value type: ${typeof value}`);
}

function rowsFor(catalog: Catalog, key: string): JsonRow[] {
  const value = catalog[key];
  if (!Array.isArray(value)) throw new Error(`Catalog property ${key} must be an array`);
  return value as JsonRow[];
}

function insertTable(database: DatabaseSync, catalog: Catalog, mapping: TableMapping): number {
  const rows = rowsFor(catalog, mapping.catalogKey);
  if (rows.length === 0) return 0;

  const columns = mapping.columns.map(([column]) => column);
  const placeholders = columns.map(() => "?");
  const statement = database.prepare(
    `INSERT INTO ${mapping.table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
  );

  for (const row of rows) {
    statement.run(...mapping.columns.map(([, property]) => asSqlValue(row[property])));
  }

  return rows.length;
}

function sqlLiteral(value: unknown): string {
  const sqlValue = asSqlValue(value);
  if (sqlValue === null) return "NULL";
  if (typeof sqlValue === "number") {
    if (!Number.isFinite(sqlValue)) throw new Error("Non-finite numbers cannot be written to seed SQL");
    return String(sqlValue);
  }
  if (typeof sqlValue === "bigint") return String(sqlValue);

  const text = String(sqlValue);
  if (text.includes("\0")) {
    return `CAST(X'${Buffer.from(text, "utf8").toString("hex")}' AS TEXT)`;
  }
  return `'${text.replaceAll("'", "''")}'`;
}

export function createSeedSql(catalog: Catalog): string {
  // Wrangler/D1 wraps imports itself and rejects or ignores explicit transaction wrappers.
  const statements = ["PRAGMA foreign_keys = ON;"];

  for (const mapping of TABLE_MAPPINGS) {
    const rows = rowsFor(catalog, mapping.catalogKey);
    const columns = mapping.columns.map(([column]) => column).join(", ");
    for (const row of rows) {
      const values = mapping.columns.map(([, property]) => sqlLiteral(row[property])).join(", ");
      statements.push(`INSERT INTO ${mapping.table} (${columns}) VALUES (${values});`);
    }
  }

  statements.push("PRAGMA foreign_key_check;");
  return `${statements.join("\n")}\n`;
}

function parseArguments(arguments_: string[]): {
  catalogPath: string;
  databasePath: string;
  seedSqlPath: string;
} {
  let catalogPath = "data/import-output/catalog.json";
  let databasePath = "data/local/music-library.sqlite";
  let seedSqlPath = "data/import-output/seed.sql";

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const next = arguments_[index + 1];
    if (argument === "--catalog" && next) {
      catalogPath = next;
      index += 1;
    } else if (argument === "--database" && next) {
      databasePath = next;
      index += 1;
    } else if (argument === "--seed-sql" && next) {
      seedSqlPath = next;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }

  return {
    catalogPath: resolve(catalogPath),
    databasePath: resolve(databasePath),
    seedSqlPath: resolve(seedSqlPath),
  };
}

export async function loadLocalDatabase(
  catalogPath: string,
  databasePath: string,
): Promise<Record<string, number>> {
  const migrationsDirectory = resolve("migrations");
  const migrationNames = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  const [catalogJson, migrations] = await Promise.all([
    readFile(catalogPath, "utf8"),
    Promise.all(migrationNames.map((name) => readFile(resolve(migrationsDirectory, name), "utf8"))),
  ]);
  const catalog = JSON.parse(catalogJson) as Catalog;
  if (catalog.schemaVersion !== 2) throw new Error(`Unsupported catalog schema: ${catalog.schemaVersion}`);

  await mkdir(dirname(databasePath), { recursive: true });
  const temporaryPath = `${databasePath}.tmp`;
  await rm(temporaryPath, { force: true });

  const database = new DatabaseSync(temporaryPath);
  const counts: Record<string, number> = {};

  try {
    for (const migration of migrations) database.exec(migration);
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const mapping of TABLE_MAPPINGS) {
        counts[mapping.table] = insertTable(database, catalog, mapping);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    const foreignKeyProblems = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyProblems.length > 0) {
      throw new Error(`Foreign-key validation failed with ${foreignKeyProblems.length} problem(s)`);
    }
  } finally {
    database.close();
  }

  await rename(temporaryPath, databasePath);
  return counts;
}

async function main(): Promise<void> {
  const { catalogPath, databasePath, seedSqlPath } = parseArguments(process.argv.slice(2));
  const counts = await loadLocalDatabase(catalogPath, databasePath);
  const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as Catalog;
  await mkdir(dirname(seedSqlPath), { recursive: true });
  await writeFile(seedSqlPath, createSeedSql(catalog));
  process.stdout.write(`${JSON.stringify({ database: databasePath, seedSql: seedSqlPath, rows: counts }, null, 2)}\n`);
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isDirectRun) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Local database load failed: ${message}\n`);
    process.exitCode = 1;
  });
}
