import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type CoverageTable = {
  treatment: string;
  includedColumns?: string[];
  excludedColumns?: string[];
  serverOnlyColumns?: Record<string, string>;
};

type Coverage = {
  version: string;
  sourceSchema: string;
  databaseSchemaThrough: string;
  tables: Record<string, CoverageTable>;
};

const coverage = JSON.parse(
  readFileSync(resolve("portable/source-schema-coverage.json"), "utf8"),
) as Coverage;
const migrationFiles = readdirSync(resolve("migrations"))
  .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
  .sort();
const migrationSql = migrationFiles
  .map((name) => readFileSync(resolve("migrations", name), "utf8"))
  .join("\n");

function currentSchema(): Record<string, string[]> {
  const output = execFileSync("sqlite3", [":memory:"], {
    encoding: "utf8",
    input: `${migrationSql}
      SELECT m.name || '|' || p.name
      FROM sqlite_master AS m
      JOIN pragma_table_info(m.name) AS p
      WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
      ORDER BY m.name, p.cid;
    `,
  });
  const schema: Record<string, string[]> = {};
  for (const line of output.trim().split("\n").filter(Boolean)) {
    const [table, column] = line.split("|");
    if (!table || !column) throw new Error("invalid schema inventory");
    (schema[table] ??= []).push(column);
  }
  return schema;
}

describe("portable source schema coverage", () => {
  it("explicitly covers every source table and column through the declared migration", () => {
    expect(migrationFiles.at(-1)?.slice(0, 4)).toBe(coverage.databaseSchemaThrough);
    const schema = currentSchema();
    expect(Object.keys(coverage.tables).sort()).toEqual(Object.keys(schema).sort());

    for (const [table, columns] of Object.entries(schema)) {
      const mapping = coverage.tables[table]!;
      expect(mapping.treatment).toMatch(/^(?:included|excluded)/u);
      const mapped = [
        ...(mapping.includedColumns ?? []),
        ...(mapping.excludedColumns ?? []),
        ...Object.keys(mapping.serverOnlyColumns ?? {}),
      ];
      expect([...new Set(mapped)].sort(), table).toEqual([...columns].sort());
      expect(new Set(mapped).size, `${table} maps a column twice`).toBe(mapped.length);
      for (const reason of Object.values(mapping.serverOnlyColumns ?? {})) {
        expect(reason.length).toBeGreaterThan(20);
      }
    }
  });

  it("keeps all storage/capability fields outside portable records", () => {
    const sensitive = [
      ["media_objects", "object_key"],
      ["scan_readability_derivatives", "object_key"],
      ["recording_upload_parts", "etag"],
      ["recording_upload_sessions", "r2_upload_id"],
      ["audio_processing_jobs", "lease_token_hash"],
    ] as const;
    for (const [table, column] of sensitive) {
      expect(coverage.tables[table]?.includedColumns ?? []).not.toContain(column);
    }
  });
});
