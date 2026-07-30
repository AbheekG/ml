from __future__ import annotations

import io
import json
import os
import shutil
import stat
import sys
import tempfile
import unittest
import urllib.error
import zipfile
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any
from unittest import mock


TOOLS_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = TOOLS_ROOT.parent
sys.path.insert(0, str(TOOLS_ROOT))

import music_library_archive as archive  # noqa: E402


STAMP = "2026-07-24T10:00:00.000Z"
EXPIRY = "2026-07-25T10:00:00.000Z"
EXPORT_ID = "a" * 32
PLAN_DIGEST = "b" * 64
ITEM_ID = "1".zfill(32)
MEDIA_BYTES = b"\xff\xd8\xff\xe0synthetic-jpeg\xff\xd9"
MEDIA_HASH = archive._sha256_bytes(MEDIA_BYTES)
LYRIC_CONTENT = "Synthetic line one\r\nSynthetic line two"
LYRIC_BYTES = LYRIC_CONTENT.encode("utf-8")
LYRIC_HASH = archive._sha256_bytes(LYRIC_BYTES)
MEDIA_PATH = "songs/active/Synthetic Song/Scans/01 — Page 1 — original.jpg"
LYRIC_PATH = "songs/active/Synthetic Song/Lyrics/01 — Typed lyrics.txt"


def representation() -> dict[str, Any]:
    source = {
        "id": "media-1",
        "original_filename": "synthetic.jpg",
        "mime_type": "image/jpeg",
        "byte_size": len(MEDIA_BYTES),
        "sha256": MEDIA_HASH,
        "kind": "scan",
        "state": "active",
        "created_at": STAMP,
        "created_by": "system:synthetic",
        "trashed_at": None,
        "trashed_by": None,
    }
    return {
        "id": "media:media-1",
        "type": "MediaRepresentation",
        "mediaId": "media-1",
        "semanticRole": "scan_original",
        "path": MEDIA_PATH,
        "mimeType": "image/jpeg",
        "originalFilename": "synthetic.jpg",
        "byteSize": len(MEDIA_BYTES),
        "sha256": MEDIA_HASH,
        "state": "active",
        "createdAt": STAMP,
        "createdBy": "system:synthetic",
        "trashedAt": None,
        "trashedBy": None,
        "extensions": {"musicLibrary": {"source": source}},
    }


def catalog() -> dict[str, Any]:
    actor_row = {
        "identity": "system:synthetic",
        "display_name": "Synthetic actor",
        "role": "admin",
        "is_active": 1,
        "created_at": STAMP,
        "updated_at": STAMP,
    }
    language_row = {
        "id": "language-1",
        "display_name": "Language One",
        "bcp47_tag": "und",
        "sort_order": 0,
        "normalized_name": "language one",
    }
    song_row = {
        "id": "song-1",
        "title_latin": "Synthetic Song",
        "title_native": None,
        "status": "checked",
        "notes": None,
        "revision": 1,
        "created_at": STAMP,
        "created_by": "system:synthetic",
        "updated_at": STAMP,
        "updated_by": "system:synthetic",
        "trashed_at": None,
        "trashed_by": None,
        "normalized_title_latin": "synthetic song",
        "last_mutation_id": "mutation-1",
    }
    language_link = {
        "song_id": "song-1",
        "language_id": "language-1",
        "sort_order": 0,
    }
    lyric_row = {
        "id": "lyric-1",
        "song_id": "song-1",
        "content": LYRIC_CONTENT,
        "origin": "legacy_import",
        "sort_order": 0,
        "revision": 1,
        "created_at": STAMP,
        "created_by": "system:synthetic",
        "updated_at": STAMP,
        "updated_by": "system:synthetic",
        "trashed_at": None,
        "trashed_by": None,
    }
    media_row = representation()["extensions"]["musicLibrary"]["source"]
    selection_row = {
        "source_media_id": "media-1",
        "source_sha256": MEDIA_HASH,
        "source_byte_size": len(MEDIA_BYTES),
        "source_width": 10,
        "source_height": 10,
        "representation_kind": "source",
        "selection_basis": "direct_safe_source",
        "candidate_byte_size": None,
        "policy_id": "scan-readability-selection-v2",
        "created_at": STAMP,
        "created_by": "system:synthetic",
    }
    scan_row = {
        "id": "scan-1",
        "song_id": "song-1",
        "media_id": "media-1",
        "notebook_id": None,
        "page_label": "1",
        "legacy_version": None,
        "legacy_captured_on": None,
        "legacy_source": "External",
        "legacy_scan_text": None,
        "legacy_notes": None,
        "revision": 1,
        "created_at": STAMP,
        "created_by": "system:synthetic",
        "updated_at": STAMP,
        "updated_by": "system:synthetic",
        "trashed_at": None,
        "trashed_by": None,
        "rotation_quarter_turns": 0,
    }
    actor = {
        "id": "system:synthetic",
        "type": "SystemActor",
        "identity": "system:synthetic",
        "displayName": "Synthetic actor",
        "observedRole": "admin",
        "observedActive": True,
        "restoreAsActive": False,
        "createdAt": STAMP,
        "updatedAt": STAMP,
        "extensions": {"musicLibrary": {"source": actor_row}},
    }
    language = {
        "id": "language-1",
        "type": "Language",
        "extensions": {"musicLibrary": {"source": language_row}},
    }
    lyric = {
        "id": "lyric-1",
        "type": "LyricText",
        "songId": "song-1",
        "sortOrder": 0,
        "origin": "legacy_import",
        "revision": 1,
        "content": LYRIC_CONTENT,
        "payloadPath": LYRIC_PATH,
        "byteSize": len(LYRIC_BYTES),
        "sha256": LYRIC_HASH,
        "createdAt": STAMP,
        "createdBy": "system:synthetic",
        "updatedAt": STAMP,
        "updatedBy": "system:synthetic",
        "trashedAt": None,
        "trashedBy": None,
        "extensions": {"musicLibrary": {"source": lyric_row}},
    }
    scan = {
        "id": "scan-1",
        "type": "Scan",
        "songId": "song-1",
        "notebookId": None,
        "pageLabel": "1",
        "rotationQuarterTurns": 0,
        "revision": 1,
        "original": representation(),
        "optimized": None,
        "readability": "direct",
        "readabilityPath": MEDIA_PATH,
        "readabilitySelection": selection_row,
        "replacementHistory": [],
        "createdAt": STAMP,
        "createdBy": "system:synthetic",
        "updatedAt": STAMP,
        "updatedBy": "system:synthetic",
        "trashedAt": None,
        "trashedBy": None,
        "extensions": {"musicLibrary": {"source": scan_row}},
    }
    song = {
        "id": "song-1",
        "type": "Song",
        "titleLatin": "Synthetic Song",
        "titleNative": None,
        "normalizedTitleLatin": "synthetic song",
        "status": "checked",
        "notes": None,
        "revision": 1,
        "lastMutationId": "mutation-1",
        "folderPath": "songs/active/Synthetic Song",
        "languageIds": ["language-1"],
        "tagIds": [],
        "aliases": [],
        "credits": [],
        "lyricTexts": [lyric],
        "scans": [scan],
        "recordings": [],
        "createdAt": STAMP,
        "createdBy": "system:synthetic",
        "updatedAt": STAMP,
        "updatedBy": "system:synthetic",
        "trashedAt": None,
        "trashedBy": None,
        "extensions": {"musicLibrary": {"source": song_row}},
    }
    return {
        "profile": {
            "id": archive.PROFILE_ID,
            "version": archive.PROFILE_VERSION,
            "bagItVersion": "1.0",
            "roCrateVersion": "1.3",
        },
        "export": {
            "id": EXPORT_ID,
            "snapshotAt": STAMP,
            "expiresAt": EXPIRY,
            "planDigest": PLAN_DIGEST,
            "exporterVersion": "1.0.0",
            "builderVersion": "1.0.0",
        },
        "source": {
            "commit": "1234567890abcdef1234567890abcdef12345678",
            "schemaVersion": "0023",
            "environment": "synthetic-test",
            "includedTables": sorted(archive.ALLOWED_SOURCE_TABLES),
            "excludedTables": [
                *sorted(archive.EXCLUDED_SOURCE_TABLES),
            ],
        },
        "collection": {
            "counts": {
                "app_users": 1,
                "songs": 1,
                "activeSongs": 1,
                "trashedSongs": 0,
                "activeLyrics": 1,
                "trashedLyrics": 0,
                "activeScans": 1,
                "trashedScans": 0,
                "activeRecordings": 0,
                "trashedRecordings": 0,
                "languages": 1,
                "lyric_texts": 1,
                "scans": 1,
                "media_objects": 1,
                "scan_readability_selections": 1,
                "song_languages": 1,
                "unassignedMedia": 0,
            },
            "plannedObjects": 1,
            "plannedBytes": len(MEDIA_BYTES),
        },
        "actors": [actor],
        "languages": [language],
        "tags": [],
        "notebooks": [],
        "people": [],
        "songs": [song],
        "unassignedMedia": [],
        "relationshipHistory": [],
        "extensions": {
            "musicLibrary": {
                "sourceCoverageVersion": "1.0.0",
                "sourceRecords": {
                    "app_users": [actor_row],
                    "languages": [language_row],
                    "songs": [song_row],
                    "song_languages": [language_link],
                    "lyric_texts": [lyric_row],
                    "media_objects": [media_row],
                    "scan_readability_selections": [selection_row],
                    "scans": [scan_row],
                },
            }
        },
    }


class FakeResponse(io.BytesIO):
    def __init__(self, data: bytes, status: int, headers: dict[str, str]) -> None:
        super().__init__(data)
        self.status = status
        self.headers = headers

    def getcode(self) -> int:
        return self.status

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()


class FailingStreamResponse(FakeResponse):
    def __init__(self, data: bytes, status: int, headers: dict[str, str]) -> None:
        super().__init__(data, status, headers)
        self.first_read = True

    def read(self, size: int = -1) -> bytes:
        if self.first_read:
            self.first_read = False
            return super().read(5)
        raise OSError("synthetic stream interruption")


class FakeOpener:
    def __init__(
        self,
        *,
        ignore_range_once: bool = False,
        reject_token_once: bool = False,
        stream_fail_once: bool = False,
    ) -> None:
        self.ignore_range_once = ignore_range_once
        self.reject_token_once = reject_token_once
        self.stream_fail_once = stream_fail_once
        self.calls: list[dict[str, str]] = []

    def open(self, request: Any, timeout: int = 0) -> FakeResponse:
        headers = {key.casefold(): value for key, value in request.header_items()}
        self.calls.append(headers)
        if self.reject_token_once:
            self.reject_token_once = False
            raise urllib.error.HTTPError(
                request.full_url, 403, "forbidden", {}, io.BytesIO()
            )
        range_value = headers.get("range")
        if range_value and not self.ignore_range_once:
            offset = int(range_value.removeprefix("bytes=").removesuffix("-"))
            data = MEDIA_BYTES[offset:]
            status = 206
            content_range = f"bytes {offset}-{len(MEDIA_BYTES) - 1}/{len(MEDIA_BYTES)}"
        else:
            if range_value:
                self.ignore_range_once = False
            data = MEDIA_BYTES
            status = 200
            content_range = None
        response_headers = {
            "Content-Length": str(len(data)),
            "X-Portable-Representation": "scan_original",
        }
        if content_range:
            response_headers["Content-Range"] = content_range
        if self.stream_fail_once:
            self.stream_fail_once = False
            return FailingStreamResponse(data, status, response_headers)
        return FakeResponse(data, status, response_headers)


def write_kit(root: Path, *, mutate: Any = None) -> dict[str, Any]:
    root.mkdir()
    (root / "metadata/schemas").mkdir(parents=True)
    (root / "tools").mkdir()
    data_catalog = catalog()
    if mutate:
        mutate(data_catalog)
    files: dict[str, bytes] = {
        "README.html": b"<p>Private synthetic kit</p>\n",
        "metadata/catalog.json": archive._canonical_json(data_catalog, pretty=True),
        "metadata/profile.json": (
            REPOSITORY_ROOT / "portable/profile.json"
        ).read_bytes(),
        "tools/music_library_archive.py": (
            REPOSITORY_ROOT / "tools/music_library_archive.py"
        ).read_bytes(),
    }
    for name in (
        "catalog.schema.json",
        "export-plan.schema.json",
        "export-report.schema.json",
        "profile.schema.json",
    ):
        files[f"metadata/schemas/{name}"] = (
            REPOSITORY_ROOT / "portable/schemas" / name
        ).read_bytes()
    plan = {
        "profile": {"id": archive.PROFILE_ID, "version": archive.PROFILE_VERSION},
        "toolVersion": archive.TOOL_VERSION,
        "creatorBound": True,
        "exportId": EXPORT_ID,
        "origin": "https://archive.invalid",
        "snapshotAt": STAMP,
        "expiresAt": EXPIRY,
        "planDigest": PLAN_DIGEST,
        "catalogSha256": archive._sha256_bytes(files["metadata/catalog.json"]),
        "objectCount": 1,
        "plannedBytes": len(MEDIA_BYTES),
        "items": [{
            "id": ITEM_ID,
            "sourceKind": "media_object",
            "sourceId": "media-1",
            "representation": "scan_original",
            "contentPath": (
                f"/api/admin/portable-exports/{EXPORT_ID}/items/{ITEM_ID}/content"
            ),
            "payloadPath": MEDIA_PATH,
            "mimeType": "image/jpeg",
            "byteSize": len(MEDIA_BYTES),
            "sha256": MEDIA_HASH,
        }],
    }
    files["export-plan.json"] = archive._canonical_json(plan, pretty=True)
    for relative, value in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value)
    manifest = {
        relative: archive._sha256_bytes(value) for relative, value in files.items()
    }
    (root / "KIT-MANIFEST.sha256").write_bytes(archive._manifest_bytes(manifest))
    return plan


class ArchiveToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.kit = self.root / "export-kit"
        write_kit(self.kit)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _build(
        self,
        *,
        opener: FakeOpener | None = None,
        provider: Any = None,
        partial: bytes | None = None,
    ) -> tuple[Path, archive.VerificationResult, FakeOpener]:
        output = self.root / "preservation.zip"
        work = self.root / "work"
        if partial is not None:
            objects = work / "objects"
            objects.mkdir(parents=True, exist_ok=True)
            (
                objects / f"{ITEM_ID}-{MEDIA_HASH}.partial"
            ).write_bytes(partial)
        fake = opener or FakeOpener()
        tokens = provider or (lambda refresh: "synthetic-token")
        result = archive.build_archive(
            self.kit,
            output,
            work=work,
            token_provider=tokens,
            opener=fake,
        )
        return output, result, fake

    def test_exact_synthetic_round_trip_build_verify_inspect_restore(self) -> None:
        output, built, fake = self._build()
        self.assertTrue(output.is_file())
        self.assertFalse(output.with_name(output.name + ".partial").exists())
        self.assertFalse((self.root / "work").exists())
        self.assertEqual(built.catalog["export"]["id"], EXPORT_ID)
        self.assertEqual(len(fake.calls), 1)

        verified = archive.verify_archive(output)
        self.assertEqual(verified.archive_sha256, archive._hash_file(output)[1])
        summary = archive.inspect_archive(output)
        self.assertTrue(summary["verified"])
        self.assertNotIn("privatePaths", summary)
        private_summary = archive.inspect_archive(output, show_paths=True)
        self.assertIn(MEDIA_PATH, private_summary["privatePaths"])

        destination = self.root / "restored"
        dry_run = archive.restore_local(output, destination, dry_run=True)
        self.assertTrue(dry_run["dryRun"])
        self.assertFalse(destination.exists())
        restored = archive.restore_local(output, destination)
        self.assertFalse(restored["idempotent"])
        self.assertTrue((destination / "library.sqlite3").is_file())
        self.assertEqual((destination / "media" / MEDIA_PATH).read_bytes(), MEDIA_BYTES)
        rerun = archive.restore_local(output, destination)
        self.assertTrue(rerun["idempotent"])

        database = archive.sqlite3.connect(destination / "library.sqlite3")
        self.assertEqual(
            database.execute(
                "SELECT COUNT(*) FROM actors WHERE restore_as_active <> 0"
            ).fetchone()[0],
            0,
        )
        self.assertEqual(
            database.execute("SELECT COUNT(*) FROM relationships").fetchone()[0],
            2,
        )
        database.close()

    def test_resume_ignored_range_restart_cache_and_one_auth_renewal(self) -> None:
        token_calls: list[bool] = []

        def provider(refresh: bool) -> str:
            token_calls.append(refresh)
            return "renewed-token" if refresh else "initial-token"

        opener = FakeOpener(reject_token_once=True)
        output, _, fake = self._build(
            opener=opener,
            provider=provider,
            partial=MEDIA_BYTES[:5],
        )
        self.assertTrue(output.is_file())
        self.assertEqual(token_calls, [False, True])
        self.assertEqual(fake.calls[-1].get("range"), "bytes=5-")

        output.unlink()
        resume_opener = FakeOpener(ignore_range_once=True)
        rebuilt, _, _ = self._build(
            opener=resume_opener,
            partial=MEDIA_BYTES[:3],
        )
        self.assertTrue(rebuilt.is_file())
        self.assertEqual(resume_opener.calls[0].get("range"), "bytes=3-")

    def test_stream_failure_resumes_and_cloudflared_token_stays_out_of_output(self) -> None:
        original_sleep = archive.time.sleep
        archive.time.sleep = lambda _: None
        try:
            output, _, opener = self._build(
                opener=FakeOpener(stream_fail_once=True),
            )
        finally:
            archive.time.sleep = original_sleep
        self.assertTrue(output.is_file())
        self.assertEqual(opener.calls[1].get("range"), "bytes=5-")

        calls: list[tuple[list[str], dict[str, Any]]] = []

        def run(arguments: list[str], **options: Any) -> Any:
            calls.append((arguments, options))
            if arguments[2] == "login":
                print("Open the synthetic browser URL")
                return mock.Mock(stdout="")
            return mock.Mock(stdout="synthetic-access-token\n")

        output_capture = io.StringIO()
        with (
            mock.patch.object(archive.shutil, "which", return_value="/bin/cloudflared"),
            mock.patch.object(archive.subprocess, "run", side_effect=run),
            redirect_stdout(output_capture),
        ):
            token = archive.AccessTokenManager("https://archive.invalid").token()
        self.assertEqual(token, "synthetic-access-token")
        self.assertIn("Open the synthetic browser URL", output_capture.getvalue())
        self.assertNotIn(token, output_capture.getvalue())
        self.assertEqual(calls[0][0], [
            "/bin/cloudflared", "access", "login", "https://archive.invalid"
        ])
        self.assertNotIn("stdout", calls[0][1])
        self.assertEqual(calls[1][0], [
            "/bin/cloudflared", "access", "token",
            "-app=https://archive.invalid",
        ])
        self.assertIs(calls[1][1]["stdout"], archive.subprocess.PIPE)

    def test_corrupt_cache_and_partial_are_quarantined_without_private_names(self) -> None:
        work = self.root / "work"
        objects = work / "objects"
        objects.mkdir(parents=True)
        cache = objects / f"{ITEM_ID}-{MEDIA_HASH}"
        cache.write_bytes(b"wrong")
        output = self.root / "preservation.zip"
        notice = io.StringIO()
        with (
            redirect_stdout(notice),
            mock.patch.object(
                archive,
                "assemble_archive",
                side_effect=archive.ArchiveError("synthetic_assembly_failure"),
            ),
            self.assertRaisesRegex(
                archive.ArchiveError,
                "synthetic_assembly_failure",
            ),
        ):
            archive.build_archive(
                self.kit,
                output,
                work=work,
                token_provider=lambda _: "token",
                opener=FakeOpener(),
            )
        self.assertIn("objects/ and checkpoint.json", notice.getvalue())
        self.assertIn("keep them to resume", notice.getvalue())
        self.assertIn("delete only those builder-owned entries", notice.getvalue())
        quarantined = list(objects.glob("*.corrupt-*"))
        self.assertEqual(len(quarantined), 1)
        checkpoint = json.loads((work / "checkpoint.json").read_text())
        checkpoint_text = json.dumps(checkpoint)
        self.assertNotIn("Synthetic Song", checkpoint_text)
        self.assertNotIn("synthetic.jpg", checkpoint_text)
        self.assertNotIn("token", checkpoint_text)

    def test_success_removes_only_builder_owned_work_files(self) -> None:
        work = self.root / "custom-work"
        work.mkdir()
        unrelated = work / "keep-me.txt"
        unrelated.write_text("unrelated", encoding="utf-8")
        output = self.root / "preservation.zip"
        notice = io.StringIO()
        with redirect_stdout(notice):
            archive.build_archive(
                self.kit,
                output,
                work=work,
                token_provider=lambda _: "token",
                opener=FakeOpener(),
            )
        self.assertTrue(output.is_file())
        self.assertEqual(unrelated.read_text(encoding="utf-8"), "unrelated")
        self.assertFalse((work / "objects").exists())
        self.assertFalse((work / "checkpoint.json").exists())
        self.assertIn("Temporary resumable work files reused", notice.getvalue())
        self.assertIn("delete only those builder-owned entries", notice.getvalue())

    def test_preview_groups_trash_and_does_not_link_an_empty_song(self) -> None:
        data = catalog()
        empty_song = {
            **data["songs"][0],
            "id": "song-empty",
            "titleLatin": "Synthetic Empty Song",
            "folderPath": "songs/trashed/Synthetic Empty Song",
            "lyricTexts": [],
            "scans": [],
            "recordings": [],
            "trashedAt": STAMP,
            "trashedBy": "system:synthetic",
        }
        data["songs"].append(empty_song)
        preview = archive._preview_html(data).decode("utf-8")
        self.assertIn("<h2>Active Songs</h2>", preview)
        self.assertIn("<h2>Trash</h2>", preview)
        self.assertIn(
            'href="songs/active/Synthetic Song/"',
            preview,
        )
        self.assertIn("Synthetic Empty Song", preview)
        self.assertIn("no exported files", preview)
        self.assertNotIn(
            'href="songs/trashed/Synthetic Empty Song/"',
            preview,
        )

    def test_kit_manifest_origin_plan_and_capability_validation(self) -> None:
        (self.kit / "metadata/catalog.json").write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(archive.ArchiveError, "kit_integrity_failed"):
            archive.load_kit(self.kit)

        shutil.rmtree(self.kit)
        write_kit(self.kit)
        plan_path = self.kit / "export-plan.json"
        plan = json.loads(plan_path.read_text())
        plan["origin"] = "http://archive.invalid"
        plan_path.write_bytes(archive._canonical_json(plan, pretty=True))
        self._refresh_manifest()
        with self.assertRaisesRegex(archive.ArchiveError, "invalid_export_origin"):
            archive.load_kit(self.kit)

        shutil.rmtree(self.kit)
        write_kit(
            self.kit,
            mutate=lambda value: value["extensions"]["musicLibrary"][
                "sourceRecords"
            ]["media_objects"][0].update({"object_key": "private/storage/key"}),
        )
        with self.assertRaisesRegex(
            archive.ArchiveError, "forbidden_capability_field"
        ):
            archive.load_kit(self.kit)

        with self.assertRaisesRegex(
            archive.ArchiveError, "forbidden_storage_locator"
        ):
            archive._assert_no_capabilities(
                {"opaqueValue": "scans/readability-v2/media-1.jpg"}
            )

        shutil.rmtree(self.kit)
        write_kit(self.kit)
        schema = self.kit / "metadata/schemas/catalog.schema.json"
        schema.write_text("{}\n", encoding="utf-8")
        self._refresh_manifest()
        with self.assertRaisesRegex(
            archive.ArchiveError, "profile_contract_mismatch"
        ):
            archive.load_kit(self.kit)

    def _refresh_manifest(self) -> None:
        files = {
            path.relative_to(self.kit).as_posix(): archive._hash_file(path)[1]
            for path in self.kit.rglob("*")
            if path.is_file() and path.name != "KIT-MANIFEST.sha256"
        }
        (self.kit / "KIT-MANIFEST.sha256").write_bytes(
            archive._manifest_bytes(files)
        )

    def test_original_playback_and_relationship_mutations_fail(self) -> None:
        data = catalog()
        recording = {
            "id": "recording-1",
            "type": "Recording",
            "songId": "song-1",
            "description": "Synthetic take",
            "original": representation(),
            "playback": "original",
            "playbackPath": "different/path.mp3",
            "optimized": None,
            "credits": [],
            "replacementHistory": [],
            "extensions": {"musicLibrary": {"source": {}}},
        }
        data["songs"][0]["recordings"] = [recording]
        with self.assertRaisesRegex(
            archive.ArchiveError, "invalid_original_playback"
        ):
            archive._validate_catalog(
                data, archive._validate_profile(json.loads(
                    (REPOSITORY_ROOT / "portable/profile.json").read_text()
                ))
            )

        orphan = catalog()
        orphan["extensions"]["musicLibrary"]["sourceRecords"][
            "song_languages"
        ][0]["language_id"] = "missing"
        with self.assertRaisesRegex(archive.ArchiveError, "orphan_song_languages"):
            archive._validate_catalog(
                orphan, archive._validate_profile(json.loads(
                    (REPOSITORY_ROOT / "portable/profile.json").read_text()
                ))
            )

        wrong_counts = catalog()
        wrong_counts["collection"]["counts"]["songs"] = 2
        with self.assertRaisesRegex(archive.ArchiveError, "catalog_count_mismatch"):
            archive._validate_catalog(
                wrong_counts, archive._validate_profile(json.loads(
                    (REPOSITORY_ROOT / "portable/profile.json").read_text()
                ))
            )

    def test_restore_detects_conflicting_existing_ids(self) -> None:
        output, _, _ = self._build()
        destination = self.root / "restored"
        archive.restore_local(output, destination)
        database = archive.sqlite3.connect(destination / "library.sqlite3")
        database.execute(
            "DELETE FROM source_records WHERE table_name = 'songs'"
        )
        database.commit()
        database.close()
        with self.assertRaisesRegex(
            archive.ArchiveError, "restore_destination_conflict"
        ):
            archive.restore_local(output, destination)

    def test_path_and_fake_zip64_boundaries(self) -> None:
        for value in (
            "../escape",
            "/absolute",
            "C:/drive",
            "one\\two",
            "folder/CON",
            "folder/trailing. ",
            "folder/\u0065\u0301.txt",
        ):
            with self.subTest(value=value):
                with self.assertRaises(archive.ArchiveError):
                    archive._safe_relative_path(value)
        archive._validate_path_set(["folder/Résumé", "folder/Other"])
        with self.assertRaisesRegex(
            archive.ArchiveError, "portable_path_collision"
        ):
            archive._validate_path_set(["folder/Résumé", "folder/RÉSUMÉ"])
        self.assertTrue(
            archive.zip64_required(
                zipfile.ZIP_FILECOUNT_LIMIT,
                1,
                1,
            )
        )
        self.assertTrue(
            archive.zip64_required(1, zipfile.ZIP64_LIMIT, zipfile.ZIP64_LIMIT)
        )
        self.assertFalse(archive.zip64_required(10, 100, 1000))

    def test_unsafe_output_and_insufficient_disk_fail_before_network(self) -> None:
        kit = archive.load_kit(self.kit)
        with self.assertRaisesRegex(
            archive.ArchiveError,
            "unsafe_output_or_work_path: place the archive and work directory "
            "outside the export kit, Git repositories",
        ):
            archive.build_archive(
                self.kit,
                self.root / "archive.zip",
                work=self.kit / "work",
                token_provider=lambda _: "token",
                opener=FakeOpener(),
            )
        original = archive.shutil.disk_usage
        usage = type("DiskUsage", (), {"total": 1, "used": 1, "free": 0})()
        archive.shutil.disk_usage = lambda _: usage
        try:
            with self.assertRaisesRegex(
                archive.ArchiveError, "insufficient_disk_space"
            ):
                archive._preflight_disk(
                    kit, self.root / "work", self.root / "output.zip"
                )
        finally:
            archive.shutil.disk_usage = original

        nested = self.root / "not-created" / "output"
        original = archive.shutil.disk_usage
        archive.shutil.disk_usage = lambda _: usage
        try:
            with self.assertRaisesRegex(
                archive.ArchiveError, "insufficient_disk_space"
            ):
                archive.build_archive(
                    self.kit,
                    nested / "archive.zip",
                    work=nested / "work",
                    token_provider=lambda _: "token",
                    opener=FakeOpener(),
                )
        finally:
            archive.shutil.disk_usage = original
        self.assertFalse((self.root / "not-created").exists())


class AdversarialArchiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        cls.kit = cls.root / "kit"
        write_kit(cls.kit)
        cls.valid = cls.root / "valid.zip"
        archive.build_archive(
            cls.kit,
            cls.valid,
            work=cls.root / "work",
            token_provider=lambda _: "token",
            opener=FakeOpener(),
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temporary.cleanup()

    def _rewrite(
        self,
        name: str,
        mutate: Any,
    ) -> Path:
        target = self.root / name
        with zipfile.ZipFile(self.valid, "r") as source, zipfile.ZipFile(
            target, "w", compression=zipfile.ZIP_STORED, allowZip64=True
        ) as destination:
            for info in source.infolist():
                data = source.read(info)
                mutate(destination, info, data)
        return target

    def test_rejects_traversal_absolute_backslash_and_extra_roots(self) -> None:
        for suffix in (
            "../escape",
            "/absolute",
            "C:/drive",
            "folder\\alternate",
        ):
            target = self._rewrite(
                f"unsafe-{abs(hash(suffix))}.zip",
                lambda destination, info, data: (
                    destination.writestr(info, data),
                    destination.writestr(suffix, b"x")
                    if info == zipfile.ZipFile(self.valid).infolist()[0]
                    else None,
                ),
            )
            with self.subTest(suffix=suffix):
                with self.assertRaises(archive.ArchiveError):
                    archive.verify_archive(target)

    def test_rejects_duplicate_case_collision_symlink_and_compression(self) -> None:
        with zipfile.ZipFile(self.valid, "r") as source:
            first = source.infolist()[0]
            first_data = source.read(first)

        duplicate = shutil.copy2(self.valid, self.root / "duplicate.zip")
        with zipfile.ZipFile(duplicate, "a", compression=zipfile.ZIP_STORED) as output:
            output.writestr(first.filename, first_data)
        with self.assertRaisesRegex(
            archive.ArchiveError, "archive_duplicate_entry"
        ):
            archive.verify_archive(duplicate)

        collision = shutil.copy2(self.valid, self.root / "collision.zip")
        with zipfile.ZipFile(collision, "a", compression=zipfile.ZIP_STORED) as output:
            root, relative = first.filename.split("/", 1)
            output.writestr(f"{root}/{relative.upper()}", b"x")
        with self.assertRaisesRegex(
            archive.ArchiveError, "portable_path_collision"
        ):
            archive.verify_archive(collision)

        symlink = self.root / "symlink.zip"
        with zipfile.ZipFile(symlink, "w") as output:
            info = zipfile.ZipInfo(
                "music-library-preservation-2026-07-24-aaaaaaaa/link"
            )
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            output.writestr(info, "target")
        with self.assertRaisesRegex(
            archive.ArchiveError, "archive_special_file_rejected"
        ):
            archive.verify_archive(symlink)

        compressed = self.root / "compressed.zip"
        with zipfile.ZipFile(compressed, "w", compression=zipfile.ZIP_DEFLATED) as output:
            output.writestr(
                "music-library-preservation-2026-07-24-aaaaaaaa/file",
                b"x" * 100,
            )
        with self.assertRaisesRegex(
            archive.ArchiveError, "archive_compression_rejected"
        ):
            archive.verify_archive(compressed)

    def test_rejects_mutated_missing_and_unmanifested_payloads(self) -> None:
        mutated_once = False

        def mutate_payload(destination: Any, info: Any, data: bytes) -> None:
            nonlocal mutated_once
            if "/data/songs/" in info.filename and not mutated_once:
                data = data[:-1] + bytes([data[-1] ^ 1])
                mutated_once = True
            destination.writestr(info, data)

        mutated = self._rewrite("mutated.zip", mutate_payload)
        with self.assertRaisesRegex(
            archive.ArchiveError, "payload_fixity_failed"
        ):
            archive.verify_archive(mutated)

        skipped = False

        def remove_payload(destination: Any, info: Any, data: bytes) -> None:
            nonlocal skipped
            if "/data/songs/" in info.filename and not skipped:
                skipped = True
                return
            destination.writestr(info, data)

        missing = self._rewrite("missing.zip", remove_payload)
        with self.assertRaisesRegex(
            archive.ArchiveError, "payload_inventory_mismatch"
        ):
            archive.verify_archive(missing)

        extra = shutil.copy2(self.valid, self.root / "extra.zip")
        with zipfile.ZipFile(extra, "a", compression=zipfile.ZIP_STORED) as output:
            root = archive.verify_archive(self.valid).root
            output.writestr(f"{root}/data/unmanifested.bin", b"x")
        with self.assertRaisesRegex(
            archive.ArchiveError, "payload_inventory_mismatch"
        ):
            archive.verify_archive(extra)


if __name__ == "__main__":
    unittest.main()
