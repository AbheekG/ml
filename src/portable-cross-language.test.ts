/// <reference types="node" />

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  buildPrivateExportKit,
  type PortableExportSession,
} from "./portable-export";

function extractStoredKit(bytes: Uint8Array, destination: string): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const paths: string[] = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    expect(method).toBe(0);
    const nameStart = offset + 30;
    const contentStart = nameStart + nameLength + extraLength;
    const path = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    expect(path).toMatch(/^(?!\/)(?!.*(?:^|\/)\.\.?\/)[^\\\0]+$/u);
    const destinationPath = join(destination, ...path.split("/"));
    mkdirSync(join(destinationPath, ".."), { recursive: true });
    writeFileSync(destinationPath, bytes.slice(contentStart, contentStart + size), {
      mode: 0o600,
    });
    paths.push(path);
    offset = contentStart + size;
  }
  expect(view.getUint32(offset, true)).toBe(0x02014b50);
  return paths;
}

describe("browser kit and Python archive interoperability", () => {
  it("builds, verifies, inspects, and dry-run restores a browser-produced kit", async () => {
    const root = mkdtempSync(join(tmpdir(), "music-library-portable-cross-language-"));
    try {
      const session: PortableExportSession = {
        id: "a".repeat(32),
        profileVersion: "1.0.0",
        state: "ready",
        sourceSchemaVersion: "0021",
        sourceCommit: "1234567",
        sourceEnvironment: "synthetic-cross-language",
        snapshotAt: "2026-07-24T10:00:00.000Z",
        createdAt: "2026-07-24T10:00:00.000Z",
        expiresAt: "2026-07-25T10:00:00.000Z",
        recordCount: 0,
        itemCount: 0,
        plannedBytes: 0,
        planDigest: "b".repeat(64),
        readyAt: "2026-07-24T10:00:00.000Z",
        revokedAt: null,
        expiredAt: null,
        failedAt: null,
        failureCode: null,
        detailPurgedAt: null,
        activeSongs: 0,
        trashedSongs: 0,
        activeLyrics: 0,
        trashedLyrics: 0,
        activeScans: 0,
        trashedScans: 0,
        activeRecordings: 0,
        trashedRecordings: 0,
        historyRelationships: 0,
        unassignedMedia: 0,
      };
      const kit = await buildPrivateExportKit(
        session,
        [],
        [],
        "https://library.example.invalid",
      );
      const kitDirectory = join(root, "kit");
      mkdirSync(kitDirectory, { mode: 0o700 });
      const paths = extractStoredKit(kit.bytes, kitDirectory);
      expect(paths).toContain("KIT-MANIFEST.sha256");
      expect(paths).toContain("tools/music_library_archive.py");

      const archive = join(root, "preservation.zip");
      const buildOutput = execFileSync(
        "python3",
        [join(kitDirectory, "tools/music_library_archive.py"), "build", "--kit", kitDirectory, "--output", archive],
        { encoding: "utf8" },
      );
      expect(buildOutput).toContain("VERIFIED:");
      const verify = JSON.parse(execFileSync(
        "python3",
        [join(kitDirectory, "tools/music_library_archive.py"), "verify", archive],
        { encoding: "utf8" },
      )) as { status: string; exportId: string };
      expect(verify).toMatchObject({ status: "VERIFIED", exportId: session.id });
      const inspect = execFileSync(
        "python3",
        [join(kitDirectory, "tools/music_library_archive.py"), "inspect", archive],
        { encoding: "utf8" },
      );
      expect(inspect).not.toContain("library.example.invalid");
      const restore = JSON.parse(execFileSync(
        "python3",
        [
          join(kitDirectory, "tools/music_library_archive.py"),
          "restore-local",
          archive,
          "--destination",
          join(root, "restore"),
          "--dry-run",
        ],
        { encoding: "utf8" },
      )) as { verified: boolean; dryRun: boolean; wouldWrite: boolean };
      expect(restore).toMatchObject({
        verified: true,
        dryRun: true,
        wouldWrite: false,
      });
      expect(readFileSync(join(kitDirectory, "KIT-MANIFEST.sha256"), "utf8"))
        .not.toContain("cf-access-token");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
