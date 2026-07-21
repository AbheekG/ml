import { mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeOutputPath, writeSafeOutputFile } from "./safe-output";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "music-library-safe-output-"));
  await Promise.all([
    mkdir(join(root, "data/local"), { recursive: true }),
    mkdir(join(root, "data/import-output"), { recursive: true }),
    mkdir(join(root, "legacy/appsheet"), { recursive: true }),
    mkdir(join(root, "outside"), { recursive: true }),
  ]);
  return root;
}

describe("generated output path safety", () => {
  it("atomically writes private files only inside an allowlisted ignored root", async () => {
    const root = await fixture();
    const destination = join(root, "data/import-output/report.json");
    await writeSafeOutputFile(destination, "first", {
      projectRoot: root,
      allowedRoots: ["data/import-output"],
      outsideCode: "report_output_must_be_private",
    });
    await writeSafeOutputFile(destination, "second", {
      projectRoot: root,
      allowedRoots: ["data/import-output"],
      outsideCode: "report_output_must_be_private",
    });
    expect(await readFile(destination, "utf8")).toBe("second");
  });

  it("rejects arbitrary and legacy destinations before a write", async () => {
    const root = await fixture();
    const options = {
      projectRoot: root,
      allowedRoots: ["data/local"],
      kind: "file" as const,
      outsideCode: "database_output_must_be_local",
    };
    await expect(assertSafeOutputPath(join(root, "outside/db.sqlite"), options))
      .rejects.toThrow("database_output_must_be_local");
    await expect(assertSafeOutputPath(join(root, "legacy/appsheet/db.sqlite"), options))
      .rejects.toThrow("output_inside_legacy_root");
  });

  it("rejects a symlink inside an otherwise allowed path", async () => {
    const root = await fixture();
    await symlink(join(root, "legacy/appsheet"), join(root, "data/local/escape"));
    await expect(assertSafeOutputPath(join(root, "data/local/escape/db.sqlite"), {
      projectRoot: root,
      allowedRoots: ["data/local"],
      kind: "file",
      outsideCode: "database_output_must_be_local",
    })).rejects.toThrow("output_path_contains_symlink");
  });
});
