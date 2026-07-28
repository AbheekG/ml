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
import type { FrozenExportItem, SnapshotRecord } from "./portable-model";

const stamp = "2026-07-24T10:00:00.000Z";
const actor = "system:synthetic-cross-language";

function record(
  kind: string,
  key: string,
  data: SnapshotRecord["data"],
): SnapshotRecord {
  return { kind, key, orderKey: key, data };
}

async function digest(value: Uint8Array): Promise<string> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

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
      const media = new TextEncoder().encode("synthetic-media");
      const mediaSha256 = await digest(media);
      const records: SnapshotRecord[] = [
        record("app_users", actor, {
          identity: actor,
          display_name: "Synthetic actor",
          role: "admin",
          is_active: 1,
          created_at: stamp,
          updated_at: stamp,
        }),
        record("songs", "song-synthetic-1", {
          id: "song-synthetic-1",
          title_latin: "Synthetic Song",
          title_native: null,
          status: "checked",
          notes: null,
          revision: 1,
          created_at: stamp,
          created_by: actor,
          updated_at: stamp,
          updated_by: actor,
          trashed_at: null,
          trashed_by: null,
          normalized_title_latin: "synthetic song",
          last_mutation_id: "synthetic-mutation",
        }),
        record("media_objects", "media-synthetic-1", {
          id: "media-synthetic-1",
          original_filename: "synthetic.jpg",
          mime_type: "image/jpeg",
          byte_size: media.byteLength,
          sha256: mediaSha256,
          kind: "scan",
          state: "active",
          created_at: stamp,
          created_by: actor,
          trashed_at: null,
          trashed_by: null,
        }),
        record("media_objects", "media-history-1", {
          id: "media-history-1",
          original_filename: "historical.jpg",
          mime_type: "image/jpeg",
          byte_size: media.byteLength,
          sha256: mediaSha256,
          kind: "scan",
          state: "active",
          created_at: stamp,
          created_by: actor,
          trashed_at: null,
          trashed_by: null,
        }),
        record("scan_readability_selections", "media-synthetic-1", {
          source_media_id: "media-synthetic-1",
          source_sha256: mediaSha256,
          source_byte_size: media.byteLength,
          source_width: 10,
          source_height: 10,
          representation_kind: "source",
          selection_basis: "direct_safe_source",
          candidate_byte_size: null,
          policy_id: "scan-readability-selection-v2",
          created_at: stamp,
          created_by: actor,
        }),
        record("scans", "scan-synthetic-1", {
          id: "scan-synthetic-1",
          song_id: "song-synthetic-1",
          media_id: "media-synthetic-1",
          notebook_id: null,
          page_label: "1",
          legacy_version: null,
          legacy_captured_on: null,
          legacy_source: "Synthetic",
          legacy_scan_text: null,
          legacy_notes: null,
          revision: 1,
          created_at: stamp,
          created_by: actor,
          updated_at: stamp,
          updated_by: actor,
          trashed_at: null,
          trashed_by: null,
          rotation_quarter_turns: 0,
        }),
        record("scan_media_history", "scan-history-synthetic-1", {
          id: "scan-history-synthetic-1",
          scan_id: "scan-synthetic-1",
          media_id: "media-history-1",
          replaced_at: stamp,
          replaced_by: actor,
          revision_at_replacement: 1,
        }),
      ];
      const session: PortableExportSession = {
        id: "a".repeat(32),
        profileVersion: "1.0.0",
        state: "ready",
        sourceSchemaVersion: "0023",
        sourceCommit: "1234567",
        sourceEnvironment: "synthetic-cross-language",
        snapshotAt: "2026-07-24T10:00:00.000Z",
        createdAt: "2026-07-24T10:00:00.000Z",
        expiresAt: "2026-07-25T10:00:00.000Z",
        recordCount: records.length,
        itemCount: 2,
        plannedBytes: media.byteLength * 2,
        planDigest: "b".repeat(64),
        readyAt: "2026-07-24T10:00:00.000Z",
        revokedAt: null,
        expiredAt: null,
        failedAt: null,
        failureCode: null,
        detailPurgedAt: null,
        activeSongs: 1,
        trashedSongs: 0,
        activeLyrics: 0,
        trashedLyrics: 0,
        activeScans: 1,
        trashedScans: 0,
        activeRecordings: 0,
        trashedRecordings: 0,
        historyRelationships: 1,
        unassignedMedia: 0,
      };
      const items: FrozenExportItem[] = [
        "media-synthetic-1",
        "media-history-1",
      ].map((sourceId, index) => {
        const itemId = (index + 1).toString(16).padStart(32, "0");
        return {
          id: itemId,
          sourceKind: "media_object",
          sourceId,
          representation: "scan_original",
          mimeType: "image/jpeg",
          byteSize: media.byteLength,
          sha256: mediaSha256,
          contentPath: `/api/admin/portable-exports/${session.id}/items/${itemId}/content`,
        };
      });
      const kit = await buildPrivateExportKit(
        session,
        records,
        items,
        "https://library.example.invalid",
      );
      const kitDirectory = join(root, "kit");
      mkdirSync(kitDirectory, { mode: 0o700 });
      const paths = extractStoredKit(kit.bytes, kitDirectory);
      expect(paths).toContain("KIT-MANIFEST.sha256");
      expect(paths).toContain("tools/music_library_archive.py");
      expect(readFileSync(join(kitDirectory, "README.html"), "utf8")).toContain(
        "outside any Git",
      );

      const archive = join(root, "preservation.zip");
      const pythonBuild = String.raw`
import importlib.util
import io
import pathlib
import sys

tool_path, kit_path, archive_path, media_hex = sys.argv[1:]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("music_library_archive", tool_path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
media = bytes.fromhex(media_hex)

class Response(io.BytesIO):
    status = 200
    def __init__(self):
        super().__init__(media)
        self.headers = {
            "Content-Length": str(len(media)),
            "X-Portable-Representation": "scan_original",
        }
    def getcode(self):
        return self.status

class Opener:
    def open(self, request, timeout=60):
        assert request.full_url.endswith("/content")
        assert request.get_header("Cf-access-token") == "synthetic-token"
        return Response()

module.build_archive(
    pathlib.Path(kit_path),
    pathlib.Path(archive_path),
    token_provider=lambda refresh: "synthetic-token",
    opener=Opener(),
)
`;
      const buildOutput = execFileSync(
        "python3",
        [
          "-c",
          pythonBuild,
          join(kitDirectory, "tools/music_library_archive.py"),
          kitDirectory,
          archive,
          Array.from(media, (byte) => byte.toString(16).padStart(2, "0")).join(""),
        ],
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
      const restoreDirectory = join(root, "restore");
      const dryRun = JSON.parse(execFileSync(
        "python3",
        [
          join(kitDirectory, "tools/music_library_archive.py"),
          "restore-local",
          archive,
          "--destination",
          restoreDirectory,
          "--dry-run",
        ],
        { encoding: "utf8" },
      )) as { verified: boolean; dryRun: boolean; wouldWrite: boolean };
      expect(dryRun).toMatchObject({
        verified: true,
        dryRun: true,
        wouldWrite: false,
      });
      const restore = JSON.parse(execFileSync(
        "python3",
        [
          join(kitDirectory, "tools/music_library_archive.py"),
          "restore-local",
          archive,
          "--destination",
          restoreDirectory,
        ],
        { encoding: "utf8" },
      )) as { verified: boolean; sourceRecords: number; restoredPayloads: number };
      expect(restore).toMatchObject({
        verified: true,
        sourceRecords: records.length,
        restoredPayloads: 2,
      });
      expect(readFileSync(
        join(
          restoreDirectory,
          "media",
          "songs",
          "active",
          "Synthetic Song",
          "Scans",
          "01 — 1 — original.jpg",
        ),
      )).toEqual(Buffer.from(media));
      expect(readFileSync(join(kitDirectory, "KIT-MANIFEST.sha256"), "utf8"))
        .not.toContain("cf-access-token");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
