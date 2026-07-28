#!/usr/bin/env python3
"""Build, verify, inspect, and locally restore Music Library archive profile 1.0."""

from __future__ import annotations

import argparse
import concurrent.futures
import contextlib
import dataclasses
import datetime as dt
import hashlib
import html
import http.client
import json
import os
import random
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Callable, Iterable, Iterator, Mapping, Sequence


PROFILE_ID = "urn:music-library:portable-archive-profile:1"
PROFILE_VERSION = "1.0.0"
TOOL_VERSION = "1.0.0"
SOURCE_SCHEMA_VERSION = "0023"
RO_CRATE_CONTEXT = "https://w3id.org/ro/crate/1.1/context"
RO_CRATE_VERSION = "1.3"
DEFAULT_CONCURRENCY = 4
MAX_CONCURRENCY = 8
CHUNK_SIZE = 1024 * 1024
MAX_RETRIES = 4
MAX_KIT_ENTRY_BYTES = 64 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 100_000
MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024 * 1024
MAX_PATH_BYTES = 512
MAX_COMPONENT_BYTES = 120
DISK_MARGIN_BYTES = 512 * 1024 * 1024
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
OPAQUE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
SOURCE_COMMIT_RE = re.compile(r"^(?:[0-9a-f]{7,40}|local-development)$")
WINDOWS_RESERVED_RE = re.compile(
    r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.IGNORECASE
)
DRIVE_PATH_RE = re.compile(r"^[a-zA-Z]:")
REQUIRED_KIT_FILES = {
    "README.html",
    "export-plan.json",
    "metadata/catalog.json",
    "metadata/profile.json",
    "metadata/schemas/catalog.schema.json",
    "metadata/schemas/export-plan.schema.json",
    "metadata/schemas/export-report.schema.json",
    "metadata/schemas/profile.schema.json",
    "tools/music_library_archive.py",
}
ALLOWED_SOURCE_TABLES = {
    "app_users",
    "audio_derivatives",
    "languages",
    "lyric_texts",
    "media_objects",
    "media_parent_moves",
    "notebooks",
    "people",
    "recording_credits",
    "recording_media_history",
    "recordings",
    "scan_fingerprint_members",
    "scan_fingerprints",
    "scan_media_history",
    "scan_readability_derivatives",
    "scan_readability_selections",
    "scans",
    "song_aliases",
    "song_credits",
    "song_languages",
    "song_tags",
    "songs",
    "tags",
}
EXCLUDED_SOURCE_TABLES = {
    "audio_processing_dispatch_attempts",
    "audio_processing_jobs",
    "recording_upload_credits",
    "recording_upload_intents",
    "recording_upload_parts",
    "recording_upload_sessions",
    "scan_maintenance_failures",
    "scan_maintenance_leases",
    "d1_migrations",
    "portable_export_sessions",
    "portable_export_records",
    "portable_export_items",
    "portable_export_item_chunks",
}
CONTRACT_SHA256 = {
    "metadata/profile.json":
        "18012b5e2f195ffd6479be2c4a7ee74d3d95dc9d4cd191b4e98a5bd77a457887",
    "metadata/schemas/catalog.schema.json":
        "c1b68975f33e35bc0611ed72f881f946826e8a961d2405f0dca1a2f62e5536cd",
    "metadata/schemas/export-plan.schema.json":
        "565d9620cebf02f22ffeefe0af0f73ff837f0872cf65050075f13e83b569889e",
    "metadata/schemas/export-report.schema.json":
        "129153da656d22ac529314e6fddaf2cc945d1aaa677aba093f947e2c857e956f",
    "metadata/schemas/profile.schema.json":
        "dfafa995d6c9ec170dc59193fc2ddb84fa19658daa0b4773ea78a2ba1fa1c1d4",
}
FIXED_ARCHIVE_PAYLOADS = {
    "README.html",
    "ro-crate-metadata.json",
    "ro-crate-preview.html",
    "metadata/catalog.json",
    "metadata/export-report.json",
    *CONTRACT_SHA256,
    "tools/music_library_archive.py",
}
REPORT_GATES = {
    "kit",
    "downloads",
    "container",
    "bagit",
    "roCrate",
    "profile",
    "relations",
    "representations",
    "reconciliation",
}
FORBIDDEN_KEYS = {
    "object_key",
    "objectKey",
    "r2_upload_id",
    "r2UploadId",
    "etag",
    "lease_token",
    "leaseToken",
    "lease_token_hash",
    "leaseTokenHash",
    "access_token",
    "accessToken",
    "token",
}


class ArchiveError(RuntimeError):
    """Privacy-safe user-facing archive failure."""


@dataclasses.dataclass(frozen=True)
class KitItem:
    item_id: str
    source_kind: str
    source_id: str
    representation: str
    content_path: str
    payload_path: str
    mime_type: str
    byte_size: int
    sha256: str


@dataclasses.dataclass(frozen=True)
class Kit:
    root: Path
    plan: dict[str, Any]
    catalog: dict[str, Any]
    profile: dict[str, Any]
    items: tuple[KitItem, ...]
    file_hashes: Mapping[str, str]


@dataclasses.dataclass
class DownloadStats:
    attempts: int = 0
    resumes: int = 0
    transferred_bytes: int = 0
    verified: int = 0
    reused: int = 0
    lock: threading.Lock = dataclasses.field(default_factory=threading.Lock, repr=False)

    def add(self, **values: int) -> None:
        with self.lock:
            for key, value in values.items():
                setattr(self, key, getattr(self, key) + value)


@dataclasses.dataclass(frozen=True)
class VerificationResult:
    archive: Path
    root: str
    catalog: dict[str, Any]
    report: dict[str, Any]
    payload_manifest: Mapping[str, str]
    payload_sizes: Mapping[str, int]
    archive_sha256: str


def _canonical_json(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        text = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
            separators=(",", ": "),
        ) + "\n"
    else:
        text = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    return text.encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _hash_file(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(CHUNK_SIZE):
            size += len(chunk)
            digest.update(chunk)
    return size, digest.hexdigest()


def _parse_utc(value: Any, field: str) -> dt.datetime:
    if not isinstance(value, str) or len(value) > 40:
        raise ArchiveError(f"invalid_{field}")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ArchiveError(f"invalid_{field}") from error
    if parsed.tzinfo is None:
        raise ArchiveError(f"invalid_{field}")
    return parsed.astimezone(dt.timezone.utc)


def _safe_relative_path(value: Any, *, allow_top: bool = True) -> str:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > MAX_PATH_BYTES:
        raise ArchiveError("unsafe_path")
    if (
        value.startswith(("/", "\\"))
        or "\\" in value
        or "\x00" in value
        or DRIVE_PATH_RE.match(value)
        or unicodedata.normalize("NFC", value) != value
    ):
        raise ArchiveError("unsafe_path")
    parts = value.split("/")
    if not allow_top and len(parts) < 2:
        raise ArchiveError("unsafe_path")
    for part in parts:
        if (
            not part
            or part in {".", ".."}
            or len(part.encode("utf-8")) > MAX_COMPONENT_BYTES
            or part.rstrip(" .") != part
            or WINDOWS_RESERVED_RE.match(part)
            or any(ord(character) < 32 or 127 <= ord(character) <= 159 for character in part)
        ):
            raise ArchiveError("unsafe_path")
    return value


def _collision_key(value: str) -> str:
    return "/".join(
        unicodedata.normalize("NFC", part).casefold().rstrip(" .")
        for part in value.split("/")
    )


def _validate_path_set(paths: Iterable[str]) -> None:
    exact: set[str] = set()
    portable: set[str] = set()
    for value in paths:
        path = _safe_relative_path(value)
        if path in exact:
            raise ArchiveError("duplicate_path")
        key = _collision_key(path)
        if key in portable:
            raise ArchiveError("portable_path_collision")
        exact.add(path)
        portable.add(key)


def _read_json(path: Path, maximum: int = MAX_KIT_ENTRY_BYTES) -> Any:
    try:
        size = path.stat().st_size
        if size < 2 or size > maximum or path.is_symlink() or not path.is_file():
            raise ArchiveError("invalid_json_file")
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ArchiveError("invalid_json_file") from error


def _walk_json(value: Any) -> Iterator[tuple[str, Any]]:
    if isinstance(value, dict):
        for key, child in value.items():
            yield key, child
            yield from _walk_json(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_json(child)


def _assert_no_capabilities(value: Any) -> None:
    for key, child in _walk_json(value):
        if key in FORBIDDEN_KEYS:
            raise ArchiveError("forbidden_capability_field")
        if isinstance(child, str) and (
            child.startswith((
                "scans/readability/",
                "scans/readability-v2/",
                "recordings/original/",
                "recordings/playback/",
            ))
            and key not in {"path", "payloadPath"}
        ):
            raise ArchiveError("forbidden_storage_locator")


def _parse_manifest_bytes(data: bytes, *, label: str) -> dict[str, str]:
    try:
        text = data.decode("utf-8")
    except UnicodeError as error:
        raise ArchiveError(f"invalid_{label}") from error
    if not text.endswith("\n"):
        raise ArchiveError(f"invalid_{label}")
    result: dict[str, str] = {}
    for line in text.splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        if not match:
            raise ArchiveError(f"invalid_{label}")
        digest, path = match.groups()
        _safe_relative_path(path)
        if path in result:
            raise ArchiveError(f"duplicate_{label}_path")
        result[path] = digest
    return result


def _manifest_bytes(entries: Mapping[str, str]) -> bytes:
    return "".join(
        f"{digest}  {path}\n"
        for path, digest in sorted(entries.items(), key=lambda entry: entry[0].encode("utf-8"))
    ).encode("utf-8")


def _validate_contract_digests(
    manifest: Mapping[str, str],
    *,
    prefix: str = "",
) -> None:
    for path, expected in CONTRACT_SHA256.items():
        if manifest.get(f"{prefix}{path}") != expected:
            raise ArchiveError("profile_contract_mismatch")


def _validate_profile(profile: Any) -> dict[str, Any]:
    if not isinstance(profile, dict):
        raise ArchiveError("invalid_profile")
    required = {
        "id": PROFILE_ID,
        "version": PROFILE_VERSION,
        "bagItVersion": "1.0",
        "roCrateVersion": RO_CRATE_VERSION,
        "hashAlgorithm": "sha256",
        "zipCompression": "stored",
        "zip64": True,
        "textEncoding": "UTF-8",
    }
    for key, expected in required.items():
        if profile.get(key) != expected:
            raise ArchiveError("unsupported_profile")
    path_rules = profile.get("pathRules")
    limits = profile.get("limits")
    if not isinstance(path_rules, dict) or not isinstance(limits, dict):
        raise ArchiveError("invalid_profile")
    if (
        path_rules.get("normalization") != "NFC"
        or path_rules.get("caseCollision") != "unicode-casefold-approximation"
        or path_rules.get("maxComponentUtf8Bytes") != MAX_COMPONENT_BYTES
        or path_rules.get("maxPathUtf8Bytes") != MAX_PATH_BYTES
        or path_rules.get("stableIdSuffixLength") != 8
        or limits.get("maxCatalogBytes") != MAX_KIT_ENTRY_BYTES
        or limits.get("maxKitEntryBytes") != MAX_KIT_ENTRY_BYTES
        or limits.get("maxArchiveEntries") != MAX_ARCHIVE_ENTRIES
        or limits.get("maxArchiveBytes") != MAX_ARCHIVE_BYTES
        or limits.get("maxExpansionRatio") != 1
    ):
        raise ArchiveError("unsupported_path_profile")
    return profile


def _source_rows(catalog: Mapping[str, Any]) -> dict[str, list[dict[str, Any]]]:
    try:
        rows = catalog["extensions"]["musicLibrary"]["sourceRecords"]
    except (KeyError, TypeError) as error:
        raise ArchiveError("missing_source_records") from error
    if not isinstance(rows, dict) or set(rows) - ALLOWED_SOURCE_TABLES:
        raise ArchiveError("invalid_source_records")
    result: dict[str, list[dict[str, Any]]] = {}
    for table, values in rows.items():
        if not isinstance(values, list) or any(not isinstance(row, dict) for row in values):
            raise ArchiveError("invalid_source_records")
        result[table] = values
    return result


def _unique_rows(
    source: Mapping[str, list[dict[str, Any]]],
    table: str,
    field: str,
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for row in source.get(table, []):
        value = row.get(field)
        if not isinstance(value, str) or not value or value in result:
            raise ArchiveError(f"invalid_{table}")
        result[value] = row
    return result


def _validate_source_relations(catalog: Mapping[str, Any]) -> None:
    source = _source_rows(catalog)
    songs = _unique_rows(source, "songs", "id")
    languages = _unique_rows(source, "languages", "id")
    tags = _unique_rows(source, "tags", "id")
    notebooks = _unique_rows(source, "notebooks", "id")
    people = _unique_rows(source, "people", "id")
    lyrics = _unique_rows(source, "lyric_texts", "id")
    scans = _unique_rows(source, "scans", "id")
    recordings = _unique_rows(source, "recordings", "id")
    media = _unique_rows(source, "media_objects", "id")

    for row in lyrics.values():
        if row.get("song_id") not in songs:
            raise ArchiveError("orphan_lyric")
        if not isinstance(row.get("content"), str) or not row["content"]:
            raise ArchiveError("invalid_lyric")
    for row in scans.values():
        if row.get("song_id") not in songs or row.get("media_id") not in media:
            raise ArchiveError("orphan_scan")
        if row.get("notebook_id") is not None and row.get("notebook_id") not in notebooks:
            raise ArchiveError("orphan_scan_notebook")
    for row in recordings.values():
        if row.get("song_id") not in songs or row.get("original_media_id") not in media:
            raise ArchiveError("orphan_recording")
        if row.get("playback_media_id") is not None and row.get("playback_media_id") not in media:
            raise ArchiveError("orphan_recording_playback")
    link_specs = [
        ("song_languages", "song_id", songs, "language_id", languages),
        ("song_tags", "song_id", songs, "tag_id", tags),
        ("song_credits", "song_id", songs, "person_id", people),
        ("recording_credits", "recording_id", recordings, "person_id", people),
    ]
    for table, left_field, left, right_field, right in link_specs:
        seen: set[tuple[Any, Any, Any]] = set()
        for row in source.get(table, []):
            if row.get(left_field) not in left or row.get(right_field) not in right:
                raise ArchiveError(f"orphan_{table}")
            identity = (row.get(left_field), row.get(right_field), row.get("role"))
            if identity in seen:
                raise ArchiveError(f"duplicate_{table}")
            seen.add(identity)
    for row in source.get("song_aliases", []):
        if row.get("song_id") not in songs:
            raise ArchiveError("orphan_song_alias")
    for row in source.get("scan_media_history", []):
        if row.get("scan_id") not in scans or row.get("media_id") not in media:
            raise ArchiveError("orphan_scan_history")
    for row in source.get("recording_media_history", []):
        if row.get("recording_id") not in recordings or row.get("original_media_id") not in media:
            raise ArchiveError("orphan_recording_history")
        if row.get("playback_media_id") is not None and row.get("playback_media_id") not in media:
            raise ArchiveError("orphan_recording_history")
    for row in source.get("media_parent_moves", []):
        scan_id, recording_id = row.get("scan_id"), row.get("recording_id")
        if (scan_id is None) == (recording_id is None):
            raise ArchiveError("invalid_parent_move")
        if scan_id is not None and scan_id not in scans:
            raise ArchiveError("orphan_parent_move")
        if recording_id is not None and recording_id not in recordings:
            raise ArchiveError("orphan_parent_move")
        if row.get("from_song_id") not in songs or row.get("to_song_id") not in songs:
            raise ArchiveError("orphan_parent_move")
    for row in source.get("audio_derivatives", []):
        source_media = media.get(row.get("source_media_id"))
        playback = media.get(row.get("playback_media_id"))
        if not source_media or not playback:
            raise ArchiveError("orphan_audio_derivative")
        if (
            row.get("source_sha256") != source_media.get("sha256")
            or row.get("source_byte_size") != source_media.get("byte_size")
            or row.get("derivative_sha256") != playback.get("sha256")
            or row.get("derivative_byte_size") != playback.get("byte_size")
        ):
            raise ArchiveError("invalid_audio_derivative_provenance")
    scan_derivatives = _unique_rows(
        source, "scan_readability_derivatives", "source_media_id"
    )
    for row in scan_derivatives.values():
        source_media = media.get(row.get("source_media_id"))
        if not source_media or (
            row.get("source_sha256") != source_media.get("sha256")
            or row.get("source_byte_size") != source_media.get("byte_size")
        ):
            raise ArchiveError("invalid_scan_derivative_provenance")
    scan_selections = _unique_rows(
        source, "scan_readability_selections", "source_media_id"
    )
    for media_id, row in scan_selections.items():
        source_media = media.get(media_id)
        derivative = scan_derivatives.get(media_id)
        representation = row.get("representation_kind")
        basis = row.get("selection_basis")
        if (
            not source_media
            or source_media.get("kind") != "scan"
            or row.get("source_sha256") != source_media.get("sha256")
            or row.get("source_byte_size") != source_media.get("byte_size")
            or row.get("policy_id") != "scan-readability-selection-v2"
            or not isinstance(row.get("source_width"), int)
            or not isinstance(row.get("source_height"), int)
            or row["source_width"] < 1
            or row["source_height"] < 1
            or row["source_width"] * row["source_height"] > 100_000_000
        ):
            raise ArchiveError("invalid_scan_selection_provenance")
        if representation == "source":
            if basis != "direct_safe_source" or derivative is not None:
                raise ArchiveError("invalid_scan_direct_selection")
        elif representation == "derivative":
            if (
                basis not in {"required_normalization", "optional_material_savings"}
                or derivative is None
                or row.get("candidate_byte_size") != derivative.get("byte_size")
            ):
                raise ArchiveError("invalid_scan_derivative_selection")
        else:
            raise ArchiveError("invalid_scan_selection_provenance")
    if any(row.get("media_id") not in scan_selections for row in scans.values()):
        raise ArchiveError("missing_current_scan_selection")
    fingerprints = _unique_rows(source, "scan_fingerprints", "sha256")
    for row in source.get("scan_fingerprint_members", []):
        if row.get("media_id") not in media or row.get("sha256") not in fingerprints:
            raise ArchiveError("orphan_scan_fingerprint")


def _validate_catalog(catalog: Any, profile: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(catalog, dict):
        raise ArchiveError("invalid_catalog")
    for key in (
        "profile",
        "export",
        "source",
        "collection",
        "actors",
        "languages",
        "tags",
        "notebooks",
        "people",
        "songs",
        "unassignedMedia",
        "relationshipHistory",
        "extensions",
    ):
        if key not in catalog:
            raise ArchiveError("invalid_catalog")
    profile_ref = catalog.get("profile")
    if not isinstance(profile_ref, dict) or (
        profile_ref.get("id") != PROFILE_ID
        or profile_ref.get("version") != PROFILE_VERSION
        or profile_ref.get("bagItVersion") != "1.0"
        or profile_ref.get("roCrateVersion") != RO_CRATE_VERSION
    ):
        raise ArchiveError("catalog_profile_mismatch")
    source = catalog.get("source")
    export = catalog.get("export")
    collection = catalog.get("collection")
    if (
        not isinstance(source, dict)
        or source.get("schemaVersion") != SOURCE_SCHEMA_VERSION
        or not SOURCE_COMMIT_RE.fullmatch(str(source.get("commit", "")))
        or not isinstance(export, dict)
        or not OPAQUE_ID_RE.fullmatch(str(export.get("id", "")))
        or not SHA256_RE.fullmatch(str(export.get("planDigest", "")))
        or not isinstance(collection, dict)
        or not isinstance(source.get("environment"), str)
        or not 1 <= len(source["environment"]) <= 100
        or any(character in source["environment"] for character in "\r\n")
        or not isinstance(source.get("includedTables"), list)
        or len(source["includedTables"]) != len(ALLOWED_SOURCE_TABLES)
        or set(source["includedTables"]) != ALLOWED_SOURCE_TABLES
        or not isinstance(source.get("excludedTables"), list)
        or len(source["excludedTables"]) != len(EXCLUDED_SOURCE_TABLES)
        or set(source["excludedTables"]) != EXCLUDED_SOURCE_TABLES
    ):
        raise ArchiveError("invalid_catalog_header")
    _parse_utc(export.get("snapshotAt"), "snapshot_time")
    _parse_utc(export.get("expiresAt"), "expiry_time")
    if not all(isinstance(catalog.get(key), list) for key in (
        "actors", "languages", "tags", "notebooks", "people", "songs",
        "unassignedMedia", "relationshipHistory"
    )):
        raise ArchiveError("invalid_catalog_collections")
    _assert_no_capabilities(catalog)
    _validate_source_relations(catalog)
    source_rows = _source_rows(catalog)
    counts = collection.get("counts")
    expected_counts = {
        table: len(values) for table, values in source_rows.items()
    }
    expected_counts["activeSongs"] = sum(
        row.get("trashed_at") is None for row in source_rows.get("songs", [])
    )
    expected_counts["trashedSongs"] = (
        len(source_rows.get("songs", [])) - expected_counts["activeSongs"]
    )
    expected_counts["activeLyrics"] = sum(
        row.get("trashed_at") is None
        for row in source_rows.get("lyric_texts", [])
    )
    expected_counts["trashedLyrics"] = (
        len(source_rows.get("lyric_texts", [])) - expected_counts["activeLyrics"]
    )
    expected_counts["activeScans"] = sum(
        row.get("trashed_at") is None for row in source_rows.get("scans", [])
    )
    expected_counts["trashedScans"] = (
        len(source_rows.get("scans", [])) - expected_counts["activeScans"]
    )
    expected_counts["activeRecordings"] = sum(
        row.get("trashed_at") is None
        for row in source_rows.get("recordings", [])
    )
    expected_counts["trashedRecordings"] = (
        len(source_rows.get("recordings", []))
        - expected_counts["activeRecordings"]
    )
    expected_counts["unassignedMedia"] = len(catalog["unassignedMedia"])
    if counts != expected_counts:
        raise ArchiveError("catalog_count_mismatch")

    actor_ids: set[str] = set()
    for actor in catalog["actors"]:
        if (
            not isinstance(actor, dict)
            or not isinstance(actor.get("id"), str)
            or actor["id"] in actor_ids
            or actor.get("restoreAsActive") is not False
        ):
            raise ArchiveError("invalid_actor")
        actor_ids.add(actor["id"])
    if not {
        row.get("identity") for row in source_rows.get("app_users", [])
    }.issubset(actor_ids):
        raise ArchiveError("catalog_actor_mismatch")

    for collection_name, table in (
        ("languages", "languages"),
        ("tags", "tags"),
        ("notebooks", "notebooks"),
        ("people", "people"),
    ):
        portable_ids = {
            value.get("id")
            for value in catalog[collection_name]
            if isinstance(value, dict)
        }
        source_ids = {value.get("id") for value in source_rows.get(table, [])}
        if portable_ids != source_ids or None in portable_ids:
            raise ArchiveError("catalog_entity_mismatch")

    song_ids: set[str] = set()
    lyric_ids: set[str] = set()
    scan_ids: set[str] = set()
    recording_ids: set[str] = set()
    declared_paths: list[str] = []
    for song in catalog["songs"]:
        if not isinstance(song, dict) or not isinstance(song.get("id"), str):
            raise ArchiveError("invalid_song")
        if song["id"] in song_ids:
            raise ArchiveError("duplicate_song")
        song_ids.add(song["id"])
        declared_paths.append(_safe_relative_path(song.get("folderPath")))
        for key, seen, expected_type in (
            ("lyricTexts", lyric_ids, "LyricText"),
            ("scans", scan_ids, "Scan"),
            ("recordings", recording_ids, "Recording"),
        ):
            children = song.get(key)
            if not isinstance(children, list):
                raise ArchiveError("invalid_song_children")
            for child in children:
                if (
                    not isinstance(child, dict)
                    or child.get("type") != expected_type
                    or not isinstance(child.get("id"), str)
                    or child["id"] in seen
                    or child.get("songId") != song["id"]
                ):
                    raise ArchiveError("invalid_song_child")
                seen.add(child["id"])
        for lyric in song["lyricTexts"]:
            content = lyric.get("content")
            path = _safe_relative_path(lyric.get("payloadPath"))
            if not isinstance(content, str):
                raise ArchiveError("invalid_lyric")
            encoded = content.encode("utf-8")
            if lyric.get("byteSize") != len(encoded) or lyric.get("sha256") != _sha256_bytes(encoded):
                raise ArchiveError("invalid_lyric_fixity")
            declared_paths.append(path)
        for scan in song["scans"]:
            original = scan.get("original")
            optimized = scan.get("optimized")
            readability = scan.get("readability")
            if not isinstance(original, dict):
                raise ArchiveError("missing_scan_original")
            if readability == "direct":
                if (
                    optimized is not None
                    or scan.get("readabilityPath") != original.get("path")
                    or not isinstance(scan.get("readabilitySelection"), dict)
                ):
                    raise ArchiveError("invalid_scan_direct_selection")
            elif readability == "optimized":
                if (
                    not isinstance(optimized, dict)
                    or scan.get("readabilityPath") != optimized.get("path")
                    or not isinstance(scan.get("readabilitySelection"), dict)
                ):
                    raise ArchiveError("invalid_scan_optimized_selection")
            else:
                raise ArchiveError("invalid_current_scan_readability")
            history = scan.get("replacementHistory")
            if not isinstance(history, list):
                raise ArchiveError("invalid_scan_history")
            for replacement in history:
                if (
                    not isinstance(replacement, dict)
                    or not isinstance(replacement.get("original"), dict)
                ):
                    raise ArchiveError("invalid_scan_history")
                history_original = replacement["original"]
                history_optimized = replacement.get("optimized")
                history_readability = replacement.get("readability")
                if history_readability in {"direct", "original_fallback"}:
                    if (
                        history_optimized is not None
                        or replacement.get("readabilityPath") != history_original.get("path")
                    ):
                        raise ArchiveError("invalid_scan_history_readability")
                elif history_readability in {"optimized", "optimized_legacy"}:
                    if (
                        not isinstance(history_optimized, dict)
                        or replacement.get("readabilityPath") != history_optimized.get("path")
                    ):
                        raise ArchiveError("invalid_scan_history_readability")
                else:
                    raise ArchiveError("invalid_scan_history_readability")
        for recording in song["recordings"]:
            original = recording.get("original")
            playback = recording.get("playback")
            optimized = recording.get("optimized")
            if not isinstance(original, dict):
                raise ArchiveError("missing_recording_original")
            if playback == "original":
                if recording.get("playbackPath") != original.get("path") or optimized is not None:
                    raise ArchiveError("invalid_original_playback")
            elif playback == "optimized":
                if (
                    not isinstance(optimized, dict)
                    or recording.get("playbackPath") != optimized.get("path")
                    or recording.get("playbackPath") == original.get("path")
                ):
                    raise ArchiveError("invalid_optimized_playback")
            elif playback == "unavailable":
                if recording.get("playbackPath") is not None or optimized is not None:
                    raise ArchiveError("invalid_unavailable_playback")
            else:
                raise ArchiveError("invalid_playback_selection")
    if song_ids != {
        row.get("id") for row in source_rows.get("songs", [])
    }:
        raise ArchiveError("catalog_song_mismatch")
    if lyric_ids != {
        row.get("id") for row in source_rows.get("lyric_texts", [])
    }:
        raise ArchiveError("catalog_lyric_mismatch")
    if scan_ids != {
        row.get("id") for row in source_rows.get("scans", [])
    }:
        raise ArchiveError("catalog_scan_mismatch")
    if recording_ids != {
        row.get("id") for row in source_rows.get("recordings", [])
    }:
        raise ArchiveError("catalog_recording_mismatch")
    _validate_path_set(declared_paths)
    return catalog


def _representation_map(catalog: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            if value.get("type") == "MediaRepresentation":
                path = _safe_relative_path(value.get("path"))
                if path in result and result[path].get("id") != value.get("id"):
                    raise ArchiveError("representation_path_conflict")
                if (
                    not isinstance(value.get("byteSize"), int)
                    or value["byteSize"] < 1
                    or not SHA256_RE.fullmatch(str(value.get("sha256", "")))
                    or not isinstance(value.get("mimeType"), str)
                ):
                    raise ArchiveError("invalid_representation")
                result[path] = value
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(catalog)
    return result


def _validate_plan(
    plan: Any,
    catalog: Mapping[str, Any],
    profile: Mapping[str, Any],
) -> tuple[KitItem, ...]:
    if not isinstance(plan, dict):
        raise ArchiveError("invalid_export_plan")
    profile_ref = plan.get("profile")
    export = catalog["export"]
    if (
        not isinstance(profile_ref, dict)
        or profile_ref.get("id") != PROFILE_ID
        or profile_ref.get("version") != PROFILE_VERSION
        or plan.get("toolVersion") != TOOL_VERSION
        or plan.get("creatorBound") is not True
        or plan.get("exportId") != export.get("id")
        or plan.get("planDigest") != export.get("planDigest")
        or not SHA256_RE.fullmatch(str(plan.get("catalogSha256", "")))
        or plan.get("catalogSha256") != _sha256_bytes(_canonical_json(catalog, pretty=True))
    ):
        raise ArchiveError("export_plan_catalog_mismatch")
    origin = plan.get("origin")
    if not isinstance(origin, str):
        raise ArchiveError("invalid_export_origin")
    parsed_origin = urllib.parse.urlsplit(origin)
    if (
        parsed_origin.scheme != "https"
        or not parsed_origin.netloc
        or parsed_origin.path
        or parsed_origin.query
        or parsed_origin.fragment
        or parsed_origin.username
        or parsed_origin.password
    ):
        raise ArchiveError("invalid_export_origin")
    if plan.get("snapshotAt") != export.get("snapshotAt") or plan.get("expiresAt") != export.get("expiresAt"):
        raise ArchiveError("export_plan_time_mismatch")
    _parse_utc(plan.get("snapshotAt"), "snapshot_time")
    _parse_utc(plan.get("expiresAt"), "expiry_time")
    raw_items = plan.get("items")
    if not isinstance(raw_items, list):
        raise ArchiveError("invalid_export_items")
    representations = _representation_map(catalog)
    items: list[KitItem] = []
    ids: set[str] = set()
    sources: set[tuple[str, str]] = set()
    paths: list[str] = []
    total = 0
    for raw in raw_items:
        if not isinstance(raw, dict):
            raise ArchiveError("invalid_export_item")
        item_id = raw.get("id")
        source_kind = raw.get("sourceKind")
        source_id = raw.get("sourceId")
        representation = raw.get("representation")
        content_path = raw.get("contentPath")
        payload_path = _safe_relative_path(raw.get("payloadPath"))
        mime_type = raw.get("mimeType")
        byte_size = raw.get("byteSize")
        sha256 = raw.get("sha256")
        expected_content = (
            f"/api/admin/portable-exports/{plan.get('exportId')}/items/{item_id}/content"
        )
        if (
            not isinstance(item_id, str)
            or not OPAQUE_ID_RE.fullmatch(item_id)
            or item_id in ids
            or source_kind not in {"media_object", "scan_readability"}
            or not isinstance(source_id, str)
            or not source_id
            or (source_kind, source_id) in sources
            or representation not in {
                "scan_original", "scan_optimized",
                "recording_original", "recording_playback",
            }
            or content_path != expected_content
            or not isinstance(mime_type, str)
            or len(mime_type) > 200
            or not isinstance(byte_size, int)
            or byte_size < 1
            or not isinstance(sha256, str)
            or not SHA256_RE.fullmatch(sha256)
        ):
            raise ArchiveError("invalid_export_item")
        declared = representations.get(payload_path)
        if not declared or (
            declared.get("byteSize") != byte_size
            or declared.get("sha256") != sha256
            or declared.get("mimeType") != mime_type
        ):
            raise ArchiveError("export_item_representation_mismatch")
        ids.add(item_id)
        sources.add((source_kind, source_id))
        paths.append(payload_path)
        total += byte_size
        items.append(KitItem(
            item_id=item_id,
            source_kind=source_kind,
            source_id=source_id,
            representation=representation,
            content_path=content_path,
            payload_path=payload_path,
            mime_type=mime_type,
            byte_size=byte_size,
            sha256=sha256,
        ))
    _validate_path_set(paths)
    if set(paths) != set(representations):
        raise ArchiveError("export_item_inventory_mismatch")
    if plan.get("objectCount") != len(items) or plan.get("plannedBytes") != total:
        raise ArchiveError("export_plan_aggregate_mismatch")
    if catalog["collection"].get("plannedObjects") != len(items) or catalog["collection"].get("plannedBytes") != total:
        raise ArchiveError("catalog_aggregate_mismatch")
    return tuple(sorted(items, key=lambda item: (item.payload_path.encode("utf-8"), item.item_id)))


def load_kit(root: Path) -> Kit:
    root = root.resolve()
    if not root.is_dir() or root.is_symlink():
        raise ArchiveError("kit_directory_invalid")
    manifest_path = root / "KIT-MANIFEST.sha256"
    try:
        manifest_bytes = manifest_path.read_bytes()
    except OSError as error:
        raise ArchiveError("kit_manifest_missing") from error
    if len(manifest_bytes) > 1024 * 1024:
        raise ArchiveError("kit_manifest_invalid")
    manifest = _parse_manifest_bytes(manifest_bytes, label="kit_manifest")
    if not REQUIRED_KIT_FILES.issubset(manifest):
        raise ArchiveError("kit_files_missing")
    actual: set[str] = set()
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ArchiveError("kit_symlink_rejected")
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        _safe_relative_path(relative)
        actual.add(relative)
    if actual != set(manifest) | {"KIT-MANIFEST.sha256"}:
        raise ArchiveError("kit_inventory_mismatch")
    for relative, expected in manifest.items():
        path = root / relative
        size, digest = _hash_file(path)
        if size > MAX_KIT_ENTRY_BYTES or digest != expected:
            raise ArchiveError("kit_integrity_failed")
    _validate_contract_digests(manifest)
    profile = _validate_profile(_read_json(root / "metadata/profile.json"))
    catalog = _validate_catalog(_read_json(root / "metadata/catalog.json"), profile)
    plan = _read_json(root / "export-plan.json")
    _assert_no_capabilities(plan)
    items = _validate_plan(plan, catalog, profile)
    return Kit(
        root=root,
        plan=plan,
        catalog=catalog,
        profile=profile,
        items=items,
        file_hashes=manifest,
    )


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        request: urllib.request.Request,
        file_pointer: BinaryIO,
        code: int,
        message: str,
        headers: Mapping[str, str],
        new_url: str,
    ) -> None:
        return None


class AccessTokenManager:
    def __init__(
        self,
        origin: str,
        provider: Callable[[bool], str] | None = None,
    ) -> None:
        self.origin = origin
        self.provider = provider
        self._token: str | None = None
        self._lock = threading.Lock()
        self._logged_in = False

    def token(self, refresh: bool = False) -> str:
        with self._lock:
            if self._token is not None and not refresh:
                return self._token
            token = self.provider(refresh) if self.provider else self._cloudflared(refresh)
            if (
                not isinstance(token, str)
                or not token
                or len(token) > 32_768
                or any(character.isspace() for character in token)
            ):
                raise ArchiveError("access_authentication_failed")
            self._token = token
            return token

    def _cloudflared(self, refresh: bool) -> str:
        executable = shutil.which("cloudflared")
        if executable is None:
            raise ArchiveError("cloudflared_not_found")
        if refresh or not self._logged_in:
            print("Authenticating the administrator with Cloudflare Access…", flush=True)
            try:
                subprocess.run(
                    [executable, "access", "login", self.origin],
                    stdin=subprocess.DEVNULL,
                    check=True,
                    timeout=300,
                )
            except (OSError, subprocess.SubprocessError) as error:
                raise ArchiveError("access_authentication_failed") from error
            self._logged_in = True
        try:
            completed = subprocess.run(
                [executable, "access", "token", f"-app={self.origin}"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                check=True,
                timeout=60,
                text=True,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise ArchiveError("access_token_unavailable") from error
        return completed.stdout.strip()


def _repo_root(path: Path) -> Path | None:
    current = path.resolve()
    for candidate in (current, *current.parents):
        if (candidate / ".git").exists():
            return candidate
    return None


def _unsafe_broad_path(path: Path, kit_root: Path | None = None) -> bool:
    resolved = path.resolve()
    home = Path.home().resolve()
    if resolved in {Path(resolved.anchor), home}:
        return True
    if kit_root is not None and (resolved == kit_root or kit_root in resolved.parents):
        return True
    repository = _repo_root(resolved)
    if repository is not None:
        return True
    return "legacy" in {part.casefold() for part in resolved.parts}


def _existing_ancestor(path: Path) -> Path:
    candidate = path.resolve()
    while not candidate.exists():
        parent = candidate.parent
        if parent == candidate:
            raise ArchiveError("filesystem_preflight_failed")
        candidate = parent
    return candidate


def _same_device(left: Path, right: Path) -> bool:
    left_probe = _existing_ancestor(left if left.exists() else left.parent)
    right_probe = _existing_ancestor(right if right.exists() else right.parent)
    return left_probe.stat().st_dev == right_probe.stat().st_dev


def _preflight_disk(kit: Kit, work: Path, output: Path) -> None:
    planned = sum(item.byte_size for item in kit.items)
    output_estimate = planned + max(DISK_MARGIN_BYTES, len(_canonical_json(kit.catalog)) * 4)
    work_required = planned + DISK_MARGIN_BYTES
    output_required = output_estimate + DISK_MARGIN_BYTES
    if _same_device(work, output):
        required = work_required + output_required
        available = shutil.disk_usage(_existing_ancestor(work.parent)).free
        if available < required:
            raise ArchiveError("insufficient_disk_space")
    else:
        if shutil.disk_usage(_existing_ancestor(work.parent)).free < work_required:
            raise ArchiveError("insufficient_work_disk_space")
        if shutil.disk_usage(_existing_ancestor(output.parent)).free < output_required:
            raise ArchiveError("insufficient_output_disk_space")


def _atomic_json(path: Path, value: Any) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as destination:
            destination.write(_canonical_json(value, pretty=True))
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(temporary, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()


def _quarantine(path: Path) -> None:
    if not path.exists():
        return
    target = path.with_name(f"{path.name}.corrupt-{uuid.uuid4().hex[:8]}")
    os.replace(path, target)


def _download_one(
    kit: Kit,
    item: KitItem,
    objects: Path,
    tokens: AccessTokenManager,
    stats: DownloadStats,
    checkpoint: Callable[[], None],
    opener: urllib.request.OpenerDirector,
) -> Path:
    final_path = objects / f"{item.item_id}-{item.sha256}"
    partial_path = final_path.with_suffix(".partial")
    if final_path.exists():
        size, digest = _hash_file(final_path)
        if size == item.byte_size and digest == item.sha256:
            stats.add(reused=1, verified=1)
            checkpoint()
            return final_path
        _quarantine(final_path)
    if partial_path.exists() and partial_path.stat().st_size > item.byte_size:
        _quarantine(partial_path)
    if partial_path.exists() and partial_path.stat().st_size == item.byte_size:
        size, digest = _hash_file(partial_path)
        if size == item.byte_size and digest == item.sha256:
            os.replace(partial_path, final_path)
            stats.add(verified=1)
            checkpoint()
            return final_path
        _quarantine(partial_path)

    auth_renewed = False
    transport_attempt = 0
    while True:
        offset = partial_path.stat().st_size if partial_path.exists() else 0
        headers = {
            "cf-access-token": tokens.token(),
            "Accept": "application/octet-stream",
            "User-Agent": f"music-library-archive/{TOOL_VERSION}",
        }
        if offset:
            headers["Range"] = f"bytes={offset}-"
        request = urllib.request.Request(
            kit.plan["origin"] + item.content_path,
            headers=headers,
            method="GET",
        )
        stats.add(attempts=1)
        try:
            response = opener.open(request, timeout=60)
        except urllib.error.HTTPError as error:
            code = error.code
            with contextlib.suppress(Exception):
                error.close()
            if code in {301, 302, 303, 307, 308, 401} and not auth_renewed:
                tokens.token(refresh=True)
                auth_renewed = True
                continue
            if code == 403:
                if not auth_renewed:
                    tokens.token(refresh=True)
                    auth_renewed = True
                    continue
                raise ArchiveError("portable_export_access_denied") from error
            if code in {404, 409, 410}:
                raise ArchiveError("portable_export_item_unavailable") from error
            if code == 429 or 500 <= code <= 599:
                transport_attempt += 1
                if transport_attempt <= MAX_RETRIES:
                    time.sleep(min(8.0, (2 ** (transport_attempt - 1)) + random.random()))
                    continue
            raise ArchiveError("portable_export_download_failed") from error
        except (OSError, TimeoutError, urllib.error.URLError, http.client.HTTPException) as error:
            transport_attempt += 1
            if transport_attempt <= MAX_RETRIES:
                time.sleep(min(8.0, (2 ** (transport_attempt - 1)) + random.random()))
                continue
            raise ArchiveError("portable_export_download_failed") from error

        try:
            with response:
                status = getattr(response, "status", response.getcode())
                if offset and status == 206:
                    expected_range = f"bytes {offset}-{item.byte_size - 1}/{item.byte_size}"
                    if response.headers.get("Content-Range") != expected_range:
                        raise ArchiveError("portable_export_range_mismatch")
                    mode = "ab"
                    stats.add(resumes=1)
                elif status == 200:
                    mode = "wb"
                    offset = 0
                else:
                    raise ArchiveError("portable_export_response_invalid")
                if response.headers.get("X-Portable-Representation") != item.representation:
                    raise ArchiveError("portable_export_representation_mismatch")
                expected_length = item.byte_size - offset
                try:
                    declared_length = int(response.headers.get("Content-Length", ""))
                except ValueError as error:
                    raise ArchiveError("portable_export_length_invalid") from error
                if declared_length != expected_length:
                    raise ArchiveError("portable_export_length_invalid")
                transferred = 0
                with partial_path.open(mode) as destination:
                    os.chmod(partial_path, 0o600)
                    while chunk := response.read(CHUNK_SIZE):
                        transferred += len(chunk)
                        if offset + transferred > item.byte_size:
                            raise ArchiveError("portable_export_response_overflow")
                        destination.write(chunk)
                        stats.add(transferred_bytes=len(chunk))
                    destination.flush()
                    os.fsync(destination.fileno())
                if transferred != expected_length:
                    transport_attempt += 1
                    if transport_attempt <= MAX_RETRIES:
                        continue
                    raise ArchiveError("portable_export_response_truncated")
        except (OSError, TimeoutError, http.client.HTTPException):
            transport_attempt += 1
            if transport_attempt <= MAX_RETRIES:
                time.sleep(min(8.0, (2 ** (transport_attempt - 1)) + random.random()))
                continue
            raise ArchiveError("portable_export_download_failed") from None
        size, digest = _hash_file(partial_path)
        if size != item.byte_size or digest != item.sha256:
            _quarantine(partial_path)
            raise ArchiveError("portable_export_item_fixity_failed")
        os.replace(partial_path, final_path)
        stats.add(verified=1)
        checkpoint()
        return final_path


def download_items(
    kit: Kit,
    work: Path,
    concurrency: int,
    *,
    token_provider: Callable[[bool], str] | None = None,
    opener: urllib.request.OpenerDirector | None = None,
) -> tuple[dict[str, Path], DownloadStats]:
    objects = work / "objects"
    objects.mkdir(parents=True, exist_ok=True, mode=0o700)
    checkpoint_path = work / "checkpoint.json"
    stats = DownloadStats()
    token_manager = AccessTokenManager(kit.plan["origin"], token_provider)
    request_opener = opener or urllib.request.build_opener(_NoRedirect())
    completed: dict[str, Path] = {}
    completed_lock = threading.Lock()

    def checkpoint() -> None:
        with completed_lock:
            verified_ids = sorted(completed)
            snapshot = {
                "version": 1,
                "exportId": kit.plan["exportId"],
                "verifiedItemIds": verified_ids,
                "verifiedCount": stats.verified,
                "plannedCount": len(kit.items),
                "transferredBytes": stats.transferred_bytes,
            }
            _atomic_json(checkpoint_path, snapshot)

    def task(item: KitItem) -> tuple[str, Path]:
        path = _download_one(
            kit, item, objects, token_manager, stats, checkpoint, request_opener
        )
        with completed_lock:
            completed[item.item_id] = path
        checkpoint()
        return item.item_id, path

    try:
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=concurrency,
            thread_name_prefix="portable-download",
        ) as executor:
            futures = [executor.submit(task, item) for item in kit.items]
            for future in concurrent.futures.as_completed(futures):
                item_id, path = future.result()
                completed[item_id] = path
                print(
                    f"Media progress: {len(completed)}/{len(kit.items)} objects verified",
                    flush=True,
                )
    except KeyboardInterrupt:
        checkpoint()
        raise ArchiveError("build_interrupted_resumable")
    if len(completed) != len(kit.items):
        raise ArchiveError("portable_export_download_incomplete")
    return completed, stats


def _privacy_counts(catalog: Mapping[str, Any]) -> dict[str, int]:
    collection = catalog.get("collection", {})
    raw = collection.get("counts", {}) if isinstance(collection, dict) else {}
    counts = {
        key: value
        for key, value in raw.items()
        if isinstance(key, str) and isinstance(value, int) and value >= 0
    } if isinstance(raw, dict) else {}
    counts["songs"] = len(catalog.get("songs", []))
    counts["actors"] = len(catalog.get("actors", []))
    counts["unassignedMedia"] = len(catalog.get("unassignedMedia", []))
    return dict(sorted(counts.items()))


def _readme_html() -> bytes:
    return b"""<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Music Library preservation archive</title>
<body><h1>Music Library preservation archive</h1>
<p><strong>Private:</strong> this archive contains catalog text, lyrics, attribution, filenames, and media.</p>
<p>Friendly folders separate active Songs, Trash, and replacement history. Original and optimized
files both appear only when distinct stored representations exist. Stable IDs and relationships in
<code>metadata/catalog.json</code> are authoritative; filenames are descriptive only.</p>
<p>Run <code>python3 tools/music_library_archive.py verify ARCHIVE.zip</code> for independent fixity
and relationship verification, or <code>inspect</code> for a privacy-conscious aggregate summary.</p>
<p>Archived actor roles are historical observations, not credentials. Application deployment,
Cloudflare Access policy, infrastructure, and secrets are separate recovery inputs.</p></body></html>
"""


def _preview_html(catalog: Mapping[str, Any]) -> bytes:
    export = catalog["export"]
    counts = _privacy_counts(catalog)
    count_items = "".join(
        f"<li>{html.escape(key)}: {value}</li>" for key, value in counts.items()
    )
    song_links = "".join(
        f'<li><a href="{html.escape(str(song["folderPath"]), quote=True)}/">'
        f'{html.escape(str(song.get("titleLatin", "Song")))}</a></li>'
        for song in catalog.get("songs", [])
    )
    return (
        "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\">"
        "<title>Music Library archive preview</title><body>"
        "<h1>Music Library preservation archive</h1>"
        "<p><strong>Private archive:</strong> do not publish or commit these files.</p>"
        f"<p>Snapshot: {html.escape(str(export['snapshotAt']))}. "
        f"Profile: {html.escape(PROFILE_ID)} {PROFILE_VERSION}.</p>"
        f"<ul>{count_items}</ul>"
        "<p>Verify with the bundled trusted tool before relying on this archive.</p>"
        "<p><a href=\"metadata/catalog.json\">Consolidated catalog metadata</a></p>"
        f"<h2>Songs</h2><ul>{song_links}</ul>"
        "</body></html>"
    ).encode("utf-8")


def _lyric_entries(catalog: Mapping[str, Any]) -> dict[str, bytes]:
    entries: dict[str, bytes] = {}
    for song in catalog.get("songs", []):
        for lyric in song.get("lyricTexts", []):
            path = _safe_relative_path(lyric.get("payloadPath"))
            content = lyric.get("content")
            if not isinstance(content, str):
                raise ArchiveError("invalid_lyric")
            value = content.encode("utf-8")
            if (
                lyric.get("byteSize") != len(value)
                or lyric.get("sha256") != _sha256_bytes(value)
            ):
                raise ArchiveError("invalid_lyric_fixity")
            if path in entries:
                raise ArchiveError("duplicate_lyric_path")
            entries[path] = value
    return entries


def _ro_crate(
    catalog: Mapping[str, Any],
    payload_fixity: Mapping[str, tuple[int, str, str]],
) -> bytes:
    export = catalog["export"]
    parts = []
    graph: list[dict[str, Any]] = [
        {
            "@id": "ro-crate-metadata.json",
            "@type": "CreativeWork",
            "about": {"@id": "./"},
            "conformsTo": {"@id": "https://w3id.org/ro/crate/1.1"},
        },
        {
            "@id": "./",
            "@type": "Dataset",
            "name": "Private Music Library preservation snapshot",
            "dateCreated": export["snapshotAt"],
            "identifier": export["id"],
            "conformsTo": [
                {"@id": "https://w3id.org/ro/crate/1.1"},
                {"@id": PROFILE_ID},
            ],
            "hasPart": parts,
        },
        {
            "@id": PROFILE_ID,
            "@type": "CreativeWork",
            "name": f"Music Library portable archive profile {PROFILE_VERSION}",
            "version": PROFILE_VERSION,
        },
    ]
    for path, (size, digest, mime_type) in sorted(
        payload_fixity.items(), key=lambda entry: entry[0].encode("utf-8")
    ):
        parts.append({"@id": path})
        graph.append({
            "@id": path,
            "@type": "File",
            "encodingFormat": mime_type,
            "contentSize": str(size),
            "sha256": digest,
        })
    return _canonical_json({"@context": RO_CRATE_CONTEXT, "@graph": graph}, pretty=True)


def _mime_for_payload(path: str, item_mimes: Mapping[str, str]) -> str:
    if path in item_mimes:
        return item_mimes[path]
    if path.endswith(".json"):
        return "application/json"
    if path.endswith(".html"):
        return "text/html"
    if path.endswith(".txt"):
        return "text/plain"
    if path.endswith(".py"):
        return "text/x-python"
    return "application/octet-stream"


def _bag_info(
    kit: Kit,
    payload_bytes: int,
    payload_count: int,
) -> bytes:
    counts = _privacy_counts(kit.catalog)
    lines = [
        f"Bagging-Date: {kit.plan['snapshotAt'][:10]}",
        f"External-Identifier: {kit.plan['exportId']}",
        f"Bag-Software-Agent: Music Library archive tool {TOOL_VERSION}",
        f"Payload-Oxum: {payload_bytes}.{payload_count}",
        f"Bag-Size: {payload_bytes} bytes",
        "Source-Organization: Music Library",
        f"Music-Library-Profile: {PROFILE_ID} {PROFILE_VERSION}",
        f"Music-Library-Snapshot-Time: {kit.plan['snapshotAt']}",
        f"Music-Library-Source-Schema: {kit.catalog['source']['schemaVersion']}",
        f"Music-Library-Source-Commit: {kit.catalog['source']['commit']}",
    ]
    for key in ("activeSongs", "trashedSongs", "media_objects"):
        if key in counts:
            lines.append(f"Music-Library-{key}: {counts[key]}")
    return ("\n".join(lines) + "\n").encode("utf-8")


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o600) << 16
    info.flag_bits |= 0x800
    return info


def _write_zip_entry(
    archive: zipfile.ZipFile,
    name: str,
    source: bytes | Path,
) -> None:
    info = _zip_info(name)
    with archive.open(info, "w", force_zip64=True) as destination:
        if isinstance(source, bytes):
            destination.write(source)
        else:
            with source.open("rb") as input_file:
                shutil.copyfileobj(input_file, destination, CHUNK_SIZE)


def _catalog_reconciliation_digest(catalog: Mapping[str, Any]) -> str:
    payloads = [
        {
            "path": path,
            "size": representation["byteSize"],
            "sha256": representation["sha256"],
        }
        for path, representation in _representation_map(catalog).items()
    ]
    for song in catalog["songs"]:
        for lyric in song.get("lyricTexts", []):
            payloads.append({
                "path": lyric["payloadPath"],
                "size": lyric["byteSize"],
                "sha256": lyric["sha256"],
            })
    payloads.sort(key=lambda value: value["path"].encode("utf-8"))
    return _sha256_bytes(_canonical_json({
        "catalog": catalog,
        "durablePayloadManifest": payloads,
    }))


def _archive_root(kit: Kit) -> str:
    date = _parse_utc(kit.plan["snapshotAt"], "snapshot_time").date().isoformat()
    return f"music-library-preservation-{date}-{kit.plan['exportId'][:8]}"


def _payload_inputs(
    kit: Kit,
    object_paths: Mapping[str, Path],
    stats: DownloadStats,
    archive_filename: str,
    archive_bytes: int,
) -> tuple[dict[str, bytes | Path], dict[str, str], dict[str, Any]]:
    payload: dict[str, bytes | Path] = {
        "README.html": _readme_html(),
        "ro-crate-preview.html": _preview_html(kit.catalog),
        "metadata/catalog.json": _canonical_json(kit.catalog, pretty=True),
        "metadata/profile.json": (kit.root / "metadata/profile.json").read_bytes(),
        "metadata/schemas/catalog.schema.json": (
            kit.root / "metadata/schemas/catalog.schema.json"
        ).read_bytes(),
        "metadata/schemas/export-plan.schema.json": (
            kit.root / "metadata/schemas/export-plan.schema.json"
        ).read_bytes(),
        "metadata/schemas/export-report.schema.json": (
            kit.root / "metadata/schemas/export-report.schema.json"
        ).read_bytes(),
        "metadata/schemas/profile.schema.json": (
            kit.root / "metadata/schemas/profile.schema.json"
        ).read_bytes(),
        "tools/music_library_archive.py": (
            kit.root / "tools/music_library_archive.py"
        ).read_bytes(),
    }
    payload.update(_lyric_entries(kit.catalog))
    item_mimes: dict[str, str] = {}
    for item in kit.items:
        source = object_paths.get(item.item_id)
        if source is None:
            raise ArchiveError("verified_object_missing")
        size, digest = _hash_file(source)
        if size != item.byte_size or digest != item.sha256:
            raise ArchiveError("verified_object_changed")
        if item.payload_path in payload:
            raise ArchiveError("payload_path_conflict")
        payload[item.payload_path] = source
        item_mimes[item.payload_path] = item.mime_type

    reconciliation_digest = _catalog_reconciliation_digest(kit.catalog)
    snapshot = kit.plan["snapshotAt"]
    report: dict[str, Any] = {
        "profile": {"id": PROFILE_ID, "version": PROFILE_VERSION},
        "exportId": kit.plan["exportId"],
        "snapshotAt": snapshot,
        "toolVersion": TOOL_VERSION,
        "archiveFilename": archive_filename,
        "archiveBytes": archive_bytes,
        "counts": _privacy_counts(kit.catalog),
        "download": {
            "attempts": stats.attempts,
            "resumes": stats.resumes,
            "transferredBytes": stats.transferred_bytes,
        },
        "manifestEntries": 0,
        "verificationStartedAt": snapshot,
        "verificationCompletedAt": snapshot,
        "gates": {
            "kit": "passed",
            "downloads": "passed",
            "container": "passed",
            "bagit": "passed",
            "roCrate": "passed",
            "profile": "passed",
            "relations": "passed",
            "representations": "passed",
            "reconciliation": "passed",
        },
        "reconciliationDigest": reconciliation_digest,
        "verified": True,
    }
    payload["metadata/export-report.json"] = _canonical_json(report, pretty=True)

    preliminary: dict[str, tuple[int, str, str]] = {}
    for path, source in payload.items():
        if isinstance(source, bytes):
            size, digest = len(source), _sha256_bytes(source)
        else:
            size, digest = _hash_file(source)
        preliminary[path] = (size, digest, _mime_for_payload(path, item_mimes))
    payload["ro-crate-metadata.json"] = _ro_crate(kit.catalog, preliminary)
    report["manifestEntries"] = len(payload)
    payload["metadata/export-report.json"] = _canonical_json(report, pretty=True)
    # The report changed only by its final manifest count; rebuild its RO-Crate
    # entity so the descriptor carries the final report fixity.
    preliminary = {}
    for path, source in payload.items():
        if path == "ro-crate-metadata.json":
            continue
        if isinstance(source, bytes):
            size, digest = len(source), _sha256_bytes(source)
        else:
            size, digest = _hash_file(source)
        preliminary[path] = (size, digest, _mime_for_payload(path, item_mimes))
    payload["ro-crate-metadata.json"] = _ro_crate(kit.catalog, preliminary)
    _validate_path_set(payload)
    return payload, item_mimes, report


def _write_archive_candidate(
    kit: Kit,
    object_paths: Mapping[str, Path],
    stats: DownloadStats,
    partial: Path,
    final_filename: str,
    candidate_size: int,
) -> int:
    payload, _, _ = _payload_inputs(
        kit, object_paths, stats, final_filename, candidate_size
    )
    payload_hashes: dict[str, str] = {}
    payload_bytes = 0
    for path, source in payload.items():
        if isinstance(source, bytes):
            size, digest = len(source), _sha256_bytes(source)
        else:
            size, digest = _hash_file(source)
        payload_bytes += size
        payload_hashes[f"data/{path}"] = digest
    bagit = b"BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n"
    bag_info = _bag_info(kit, payload_bytes, len(payload))
    manifest = _manifest_bytes(payload_hashes)
    tag_hashes = {
        "bag-info.txt": _sha256_bytes(bag_info),
        "bagit.txt": _sha256_bytes(bagit),
        "manifest-sha256.txt": _sha256_bytes(manifest),
    }
    tag_manifest = _manifest_bytes(tag_hashes)
    root = _archive_root(kit)
    entries: dict[str, bytes | Path] = {
        "bagit.txt": bagit,
        "bag-info.txt": bag_info,
        "manifest-sha256.txt": manifest,
        "tagmanifest-sha256.txt": tag_manifest,
        **{f"data/{path}": source for path, source in payload.items()},
    }
    temporary = partial.with_name(f".{partial.name}.{uuid.uuid4().hex}.tmp")
    try:
        with zipfile.ZipFile(
            temporary,
            "w",
            compression=zipfile.ZIP_STORED,
            allowZip64=True,
            strict_timestamps=True,
        ) as archive:
            for relative, source in sorted(
                entries.items(), key=lambda entry: entry[0].encode("utf-8")
            ):
                _write_zip_entry(archive, f"{root}/{relative}", source)
        with temporary.open("rb") as archive_file:
            os.fsync(archive_file.fileno())
        os.replace(temporary, partial)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()
    return partial.stat().st_size


def assemble_archive(
    kit: Kit,
    object_paths: Mapping[str, Path],
    stats: DownloadStats,
    output: Path,
) -> VerificationResult:
    partial = output.with_name(f"{output.name}.partial")
    if partial.exists():
        _quarantine(partial)
    candidate = 0
    for _ in range(6):
        actual = _write_archive_candidate(
            kit, object_paths, stats, partial, output.name, candidate
        )
        if actual == candidate:
            break
        candidate = actual
    else:
        raise ArchiveError("archive_size_did_not_stabilize")
    result = verify_archive(partial)
    if result.report.get("archiveBytes") != partial.stat().st_size:
        raise ArchiveError("archive_size_reconciliation_failed")
    # Read and hash the complete container after every structural/payload check.
    full_size, full_digest = _hash_file(partial)
    if full_size != partial.stat().st_size or full_digest != result.archive_sha256:
        raise ArchiveError("archive_final_readback_failed")
    os.replace(partial, output)
    return dataclasses.replace(result, archive=output)


def build_archive(
    kit_root: Path,
    output: Path,
    *,
    work: Path | None = None,
    concurrency: int = DEFAULT_CONCURRENCY,
    token_provider: Callable[[bool], str] | None = None,
    opener: urllib.request.OpenerDirector | None = None,
) -> VerificationResult:
    if sys.version_info < (3, 11):
        raise ArchiveError("python_3_11_required")
    if concurrency < 1 or concurrency > MAX_CONCURRENCY:
        raise ArchiveError("invalid_concurrency")
    kit = load_kit(kit_root)
    output = output.expanduser().resolve()
    work = (
        work.expanduser().resolve()
        if work is not None
        else output.with_name(f".music-library-export-{kit.plan['exportId']}.work")
    )
    if output.suffix.lower() != ".zip" or output.exists():
        raise ArchiveError("output_must_be_new_zip")
    if partial := output.with_name(f"{output.name}.partial"):
        if partial.exists():
            raise ArchiveError("partial_archive_already_exists")
    if _unsafe_broad_path(output, kit.root) or _unsafe_broad_path(work, kit.root):
        raise ArchiveError(
            "unsafe_output_or_work_path: place the archive and work directory "
            "outside the export kit, Git repositories, the home-directory root, "
            "and legacy folders"
        )
    _preflight_disk(kit, work, output)
    output.parent.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(work, 0o700)
    print(
        f"Plan prepared: {len(kit.items)} private objects, "
        f"{sum(item.byte_size for item in kit.items)} bytes. "
        "The archive is not complete until VERIFIED.",
        flush=True,
    )
    object_paths, stats = download_items(
        kit,
        work,
        concurrency,
        token_provider=token_provider,
        opener=opener,
    )
    print("Media complete. Building and fully reading the private archive…", flush=True)
    result = assemble_archive(kit, object_paths, stats, output)
    print(
        f"VERIFIED: {result.report['counts'].get('songs', 0)} Songs, "
        f"{len(kit.items)} stored objects, {output.stat().st_size} archive bytes.",
        flush=True,
    )
    return result


def _zip_member_mode(info: zipfile.ZipInfo) -> int:
    return (info.external_attr >> 16) & 0xFFFF


def _read_zip_bounded(
    archive: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    maximum: int,
) -> bytes:
    if info.file_size > maximum:
        raise ArchiveError("archive_entry_too_large")
    with archive.open(info, "r") as source:
        data = source.read(maximum + 1)
    if len(data) != info.file_size or len(data) > maximum:
        raise ArchiveError("archive_entry_size_mismatch")
    return data


def _validate_zip_container(
    archive: zipfile.ZipFile,
) -> tuple[str, dict[str, zipfile.ZipInfo]]:
    infos = archive.infolist()
    if not infos or len(infos) > MAX_ARCHIVE_ENTRIES:
        raise ArchiveError("archive_entry_count_invalid")
    if sum(info.file_size for info in infos) > MAX_ARCHIVE_BYTES:
        raise ArchiveError("archive_declared_size_invalid")
    names: list[str] = []
    entries: dict[str, zipfile.ZipInfo] = {}
    root: str | None = None
    for info in infos:
        name = info.filename
        _safe_relative_path(name, allow_top=False)
        if info.is_dir() or name.endswith("/"):
            raise ArchiveError("archive_directory_entry_rejected")
        if info.compress_type != zipfile.ZIP_STORED:
            raise ArchiveError("archive_compression_rejected")
        if info.compress_size != info.file_size:
            raise ArchiveError("archive_size_ratio_rejected")
        mode = _zip_member_mode(info)
        file_type = stat.S_IFMT(mode)
        if file_type not in {0, stat.S_IFREG}:
            raise ArchiveError("archive_special_file_rejected")
        parts = name.split("/")
        if root is None:
            root = parts[0]
        elif root != parts[0]:
            raise ArchiveError("archive_multiple_roots")
        if name in entries:
            raise ArchiveError("archive_duplicate_entry")
        entries[name] = info
        names.append(name)
    _validate_path_set(names)
    if root is None or not re.fullmatch(
        r"music-library-preservation-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}", root
    ):
        raise ArchiveError("archive_root_invalid")
    return root, entries


def _bag_info_values(data: bytes) -> dict[str, str]:
    try:
        text = data.decode("utf-8")
    except UnicodeError as error:
        raise ArchiveError("bag_info_invalid") from error
    values: dict[str, str] = {}
    for line in text.splitlines():
        if ": " not in line:
            raise ArchiveError("bag_info_invalid")
        key, value = line.split(": ", 1)
        if not key or key in values or not value:
            raise ArchiveError("bag_info_invalid")
        values[key] = value
    required = {
        "Bagging-Date",
        "External-Identifier",
        "Bag-Software-Agent",
        "Payload-Oxum",
        "Bag-Size",
        "Source-Organization",
        "Music-Library-Profile",
        "Music-Library-Snapshot-Time",
        "Music-Library-Source-Schema",
        "Music-Library-Source-Commit",
    }
    if not required.issubset(values):
        raise ArchiveError("bag_info_missing")
    if any(
        forbidden in values
        for forbidden in ("Administrator", "Access-Token", "R2-Key", "Local-Path")
    ):
        raise ArchiveError("bag_info_private_operational_field")
    return values


def _validate_ro_crate(
    crate: Any,
    payload_relative: set[str],
    payload_manifest: Mapping[str, str],
    payload_sizes: Mapping[str, int],
) -> None:
    if not isinstance(crate, dict) or crate.get("@context") != RO_CRATE_CONTEXT:
        raise ArchiveError("ro_crate_context_invalid")
    graph = crate.get("@graph")
    if not isinstance(graph, list):
        raise ArchiveError("ro_crate_graph_invalid")
    entities: dict[str, dict[str, Any]] = {}
    for entity in graph:
        if (
            not isinstance(entity, dict)
            or not isinstance(entity.get("@id"), str)
            or entity["@id"] in entities
        ):
            raise ArchiveError("ro_crate_entity_invalid")
        entities[entity["@id"]] = entity
    descriptor = entities.get("ro-crate-metadata.json")
    root = entities.get("./")
    profile = entities.get(PROFILE_ID)
    if (
        not descriptor
        or descriptor.get("about") != {"@id": "./"}
        or not root
        or root.get("@type") != "Dataset"
        or not profile
        or profile.get("version") != PROFILE_VERSION
    ):
        raise ArchiveError("ro_crate_required_entity_missing")
    parts = root.get("hasPart")
    if not isinstance(parts, list):
        raise ArchiveError("ro_crate_parts_invalid")
    part_ids = {
        part.get("@id")
        for part in parts
        if isinstance(part, dict) and isinstance(part.get("@id"), str)
    }
    expected_described = payload_relative - {"ro-crate-metadata.json"}
    if part_ids != expected_described:
        raise ArchiveError("ro_crate_inventory_mismatch")
    for path in expected_described:
        entity = entities.get(path)
        manifest_path = f"data/{path}"
        if (
            not entity
            or entity.get("@type") != "File"
            or entity.get("sha256") != payload_manifest.get(manifest_path)
            or entity.get("contentSize") != str(payload_sizes.get(manifest_path))
        ):
            raise ArchiveError("ro_crate_fixity_mismatch")


def _validate_archive_catalog(
    catalog: dict[str, Any],
    manifest: Mapping[str, str],
    sizes: Mapping[str, int],
) -> None:
    representations = _representation_map(catalog)
    lyric_paths: set[str] = set()
    for song in catalog["songs"]:
        for lyric in song.get("lyricTexts", []):
            path = _safe_relative_path(lyric["payloadPath"])
            lyric_paths.add(path)
            manifest_path = f"data/{path}"
            if (
                manifest.get(manifest_path) != lyric.get("sha256")
                or sizes.get(manifest_path) != lyric.get("byteSize")
            ):
                raise ArchiveError("archive_lyric_fixity_mismatch")
    for path, representation in representations.items():
        manifest_path = f"data/{path}"
        if (
            manifest.get(manifest_path) != representation.get("sha256")
            or sizes.get(manifest_path) != representation.get("byteSize")
        ):
            raise ArchiveError("archive_representation_fixity_mismatch")
    durable_paths = set(representations) | lyric_paths
    expected_payloads = {
        f"data/{path}" for path in FIXED_ARCHIVE_PAYLOADS | durable_paths
    }
    if set(manifest) != expected_payloads:
        raise ArchiveError("archive_payload_inventory_mismatch")
    if (
        catalog["collection"].get("plannedObjects") != len(representations)
        or catalog["collection"].get("plannedBytes")
        != sum(value["byteSize"] for value in representations.values())
    ):
        raise ArchiveError("archive_collection_aggregate_mismatch")


def verify_archive(path: Path) -> VerificationResult:
    path = path.expanduser().resolve()
    if not path.is_file() or path.is_symlink():
        raise ArchiveError("archive_file_invalid")
    try:
        with zipfile.ZipFile(path, "r") as archive:
            root, entries = _validate_zip_container(archive)
            required_tags = {
                "bagit.txt",
                "bag-info.txt",
                "manifest-sha256.txt",
                "tagmanifest-sha256.txt",
            }
            for relative in required_tags:
                if f"{root}/{relative}" not in entries:
                    raise ArchiveError("bag_tag_missing")
            bagit = _read_zip_bounded(
                archive, entries[f"{root}/bagit.txt"], 1024
            )
            if bagit != b"BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n":
                raise ArchiveError("bagit_declaration_invalid")
            bag_info_data = _read_zip_bounded(
                archive, entries[f"{root}/bag-info.txt"], 64 * 1024
            )
            bag_info = _bag_info_values(bag_info_data)
            manifest_data = _read_zip_bounded(
                archive, entries[f"{root}/manifest-sha256.txt"], 32 * 1024 * 1024
            )
            tag_manifest_data = _read_zip_bounded(
                archive,
                entries[f"{root}/tagmanifest-sha256.txt"],
                1024 * 1024,
            )
            payload_manifest = _parse_manifest_bytes(
                manifest_data, label="payload_manifest"
            )
            tag_manifest = _parse_manifest_bytes(
                tag_manifest_data, label="tag_manifest"
            )
            expected_tags = {
                "bag-info.txt": _sha256_bytes(bag_info_data),
                "bagit.txt": _sha256_bytes(bagit),
                "manifest-sha256.txt": _sha256_bytes(manifest_data),
            }
            if tag_manifest != expected_tags:
                raise ArchiveError("tag_manifest_mismatch")
            payload_entries = {
                name.removeprefix(f"{root}/"): info
                for name, info in entries.items()
                if name.startswith(f"{root}/data/")
            }
            if set(payload_entries) != set(payload_manifest):
                raise ArchiveError("payload_inventory_mismatch")
            payload_sizes: dict[str, int] = {}
            payload_total = 0
            for relative, expected_digest in payload_manifest.items():
                info = payload_entries[relative]
                digest = hashlib.sha256()
                measured = 0
                with archive.open(info, "r") as source:
                    while chunk := source.read(CHUNK_SIZE):
                        measured += len(chunk)
                        digest.update(chunk)
                if measured != info.file_size or digest.hexdigest() != expected_digest:
                    raise ArchiveError("payload_fixity_failed")
                payload_sizes[relative] = measured
                payload_total += measured
            if bag_info["Payload-Oxum"] != f"{payload_total}.{len(payload_manifest)}":
                raise ArchiveError("payload_oxum_mismatch")
            if bag_info["Bag-Size"] != f"{payload_total} bytes":
                raise ArchiveError("bag_size_mismatch")
            required_payloads = {
                "data/README.html",
                "data/ro-crate-metadata.json",
                "data/ro-crate-preview.html",
                "data/metadata/catalog.json",
                "data/metadata/export-report.json",
                "data/metadata/profile.json",
                "data/metadata/schemas/catalog.schema.json",
                "data/metadata/schemas/export-plan.schema.json",
                "data/metadata/schemas/export-report.schema.json",
                "data/metadata/schemas/profile.schema.json",
                "data/tools/music_library_archive.py",
            }
            if not required_payloads.issubset(payload_manifest):
                raise ArchiveError("profile_payload_missing")
            _validate_contract_digests(payload_manifest, prefix="data/")
            profile = _validate_profile(json.loads(_read_zip_bounded(
                archive, payload_entries["data/metadata/profile.json"], MAX_KIT_ENTRY_BYTES
            )))
            catalog = _validate_catalog(json.loads(_read_zip_bounded(
                archive, payload_entries["data/metadata/catalog.json"], MAX_KIT_ENTRY_BYTES
            )), profile)
            report = json.loads(_read_zip_bounded(
                archive,
                payload_entries["data/metadata/export-report.json"],
                MAX_KIT_ENTRY_BYTES,
            ))
            expected_gates = {key: "passed" for key in REPORT_GATES}
            download = report.get("download") if isinstance(report, dict) else None
            if (
                not isinstance(report, dict)
                or report.get("verified") is not True
                or report.get("exportId") != catalog["export"]["id"]
                or report.get("snapshotAt") != catalog["export"]["snapshotAt"]
                or report.get("profile") != {
                    "id": PROFILE_ID, "version": PROFILE_VERSION
                }
                or report.get("toolVersion") != TOOL_VERSION
                or report.get("manifestEntries") != len(payload_manifest)
                or report.get("archiveBytes") != path.stat().st_size
                or report.get("counts") != _privacy_counts(catalog)
                or report.get("reconciliationDigest")
                != _catalog_reconciliation_digest(catalog)
                or report.get("gates") != expected_gates
                or not isinstance(download, dict)
                or set(download) != {"attempts", "resumes", "transferredBytes"}
                or any(
                    not isinstance(value, int) or value < 0
                    for value in download.values()
                )
            ):
                raise ArchiveError("export_report_invalid")
            _parse_utc(report.get("verificationStartedAt"), "verification_start")
            _parse_utc(report.get("verificationCompletedAt"), "verification_end")
            _validate_archive_catalog(catalog, payload_manifest, payload_sizes)
            crate = json.loads(_read_zip_bounded(
                archive,
                payload_entries["data/ro-crate-metadata.json"],
                MAX_KIT_ENTRY_BYTES,
            ))
            _validate_ro_crate(
                crate,
                {path.removeprefix("data/") for path in payload_manifest},
                payload_manifest,
                payload_sizes,
            )
    except (zipfile.BadZipFile, OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ArchiveError("archive_verification_failed") from error
    size, digest = _hash_file(path)
    if size != path.stat().st_size:
        raise ArchiveError("archive_final_readback_failed")
    return VerificationResult(
        archive=path,
        root=root,
        catalog=catalog,
        report=report,
        payload_manifest=payload_manifest,
        payload_sizes=payload_sizes,
        archive_sha256=digest,
    )


def inspect_archive(path: Path, *, show_paths: bool = False) -> dict[str, Any]:
    result = verify_archive(path)
    summary: dict[str, Any] = {
        "verified": True,
        "profile": PROFILE_VERSION,
        "exportId": result.catalog["export"]["id"],
        "snapshotAt": result.catalog["export"]["snapshotAt"],
        "sourceSchema": result.catalog["source"]["schemaVersion"],
        "sourceCommit": result.catalog["source"]["commit"],
        "counts": _privacy_counts(result.catalog),
        "plannedObjects": result.catalog["collection"]["plannedObjects"],
        "plannedBytes": result.catalog["collection"]["plannedBytes"],
        "archiveBytes": result.archive.stat().st_size,
        "archiveSha256": result.archive_sha256,
    }
    if show_paths:
        summary["privatePaths"] = sorted(
            path.removeprefix("data/")
            for path in result.payload_manifest
            if path.startswith(("data/songs/", "data/unassigned-media/"))
        )
    return summary


REFERENCE_SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE restore_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE entities (
  entity_key TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  parent_key TEXT REFERENCES entities(entity_key) ON DELETE RESTRICT,
  sort_order INTEGER,
  state TEXT NOT NULL CHECK (state IN ('active', 'trashed', 'historical', 'inactive')),
  canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),
  UNIQUE (entity_type, source_id)
);
CREATE TABLE actors (
  entity_key TEXT PRIMARY KEY REFERENCES entities(entity_key) ON DELETE RESTRICT,
  observed_role TEXT,
  observed_active INTEGER NOT NULL CHECK (observed_active IN (0, 1)),
  restore_as_active INTEGER NOT NULL CHECK (restore_as_active = 0)
);
CREATE TABLE representations (
  entity_key TEXT PRIMARY KEY REFERENCES entities(entity_key) ON DELETE RESTRICT,
  media_id TEXT NOT NULL,
  semantic_role TEXT NOT NULL,
  payload_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64
    AND sha256 = lower(sha256)
    AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  media_state TEXT NOT NULL
);
CREATE TABLE relationships (
  id TEXT PRIMARY KEY,
  relationship_type TEXT NOT NULL,
  from_key TEXT NOT NULL REFERENCES entities(entity_key) ON DELETE RESTRICT,
  to_key TEXT NOT NULL REFERENCES entities(entity_key) ON DELETE RESTRICT,
  sort_order INTEGER,
  event_at TEXT,
  canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json))
);
CREATE TABLE source_records (
  table_name TEXT NOT NULL,
  record_key TEXT NOT NULL,
  canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),
  PRIMARY KEY (table_name, record_key)
);
CREATE TABLE payloads (
  payload_path TEXT PRIMARY KEY,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64
    AND sha256 = lower(sha256)
    AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  local_path TEXT NOT NULL UNIQUE
);
"""


def _entity_key(entity_type: str, source_id: str) -> str:
    return f"{entity_type}:{source_id}"


def _insert_entity(
    database: sqlite3.Connection,
    entity: Mapping[str, Any],
    entity_type: str,
    *,
    parent_key: str | None = None,
    sort_order: int | None = None,
    state: str = "active",
) -> str:
    source_id = entity.get("id")
    if not isinstance(source_id, str) or not source_id:
        raise ArchiveError("restore_entity_id_invalid")
    key = _entity_key(entity_type, source_id)
    database.execute(
        """
        INSERT INTO entities (
          entity_key, source_id, entity_type, parent_key, sort_order, state,
          canonical_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            key,
            source_id,
            entity_type,
            parent_key,
            sort_order,
            state,
            _canonical_json(entity).decode("utf-8"),
        ),
    )
    return key


def _representation_entities(catalog: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    return _representation_map(catalog)


def _populate_reference_database(
    database: sqlite3.Connection,
    result: VerificationResult,
) -> None:
    catalog = result.catalog
    database.executescript(REFERENCE_SCHEMA)
    database.executemany(
        "INSERT INTO restore_metadata (key, value) VALUES (?, ?)",
        [
            ("profile", PROFILE_VERSION),
            ("export_id", catalog["export"]["id"]),
            ("plan_digest", catalog["export"]["planDigest"]),
            ("catalog_sha256", _sha256_bytes(_canonical_json(catalog, pretty=True))),
            ("archive_sha256", result.archive_sha256),
        ],
    )
    keys: dict[tuple[str, str], str] = {}
    for actor in catalog["actors"]:
        key = _insert_entity(database, actor, "actor", state="inactive")
        keys[("actor", actor["id"])] = key
        database.execute(
            """
            INSERT INTO actors (
              entity_key, observed_role, observed_active, restore_as_active
            ) VALUES (?, ?, ?, 0)
            """,
            (
                key,
                actor.get("observedRole"),
                1 if actor.get("observedActive") else 0,
            ),
        )
    for collection, entity_type in (
        ("languages", "language"),
        ("tags", "tag"),
        ("notebooks", "notebook"),
        ("people", "person"),
    ):
        for entity in catalog[collection]:
            key = _insert_entity(database, entity, entity_type)
            keys[(entity_type, entity["id"])] = key
    for song in catalog["songs"]:
        state = "trashed" if song.get("trashedAt") else "active"
        song_key = _insert_entity(database, song, "song", state=state)
        keys[("song", song["id"])] = song_key
        for collection, entity_type in (
            ("lyricTexts", "lyric"),
            ("scans", "scan"),
            ("recordings", "recording"),
        ):
            for child in song[collection]:
                child_state = "trashed" if child.get("trashedAt") else state
                child_key = _insert_entity(
                    database,
                    child,
                    entity_type,
                    parent_key=song_key,
                    sort_order=child.get("sortOrder"),
                    state=child_state,
                )
                keys[(entity_type, child["id"])] = child_key
    for event in catalog["relationshipHistory"]:
        event_key = _insert_entity(database, event, "relationship_history", state="historical")
        keys[("relationship_history", event["id"])] = event_key
    for path, representation in _representation_entities(catalog).items():
        representation_key = _insert_entity(
            database,
            representation,
            "representation",
            state="trashed" if representation.get("state") == "trashed" else "active",
        )
        database.execute(
            """
            INSERT INTO representations (
              entity_key, media_id, semantic_role, payload_path, mime_type,
              byte_size, sha256, media_state
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                representation_key,
                representation.get("mediaId"),
                representation.get("semanticRole"),
                path,
                representation.get("mimeType"),
                representation.get("byteSize"),
                representation.get("sha256"),
                representation.get("state"),
            ),
        )
        keys[("representation", str(representation.get("mediaId")))] = representation_key
    source = _source_rows(catalog)
    relationship_index = 0

    def add_relationship(
        relationship_type: str,
        from_key: str,
        to_key: str,
        row: Mapping[str, Any],
        *,
        sort_order: int | None = None,
        event_at: str | None = None,
    ) -> None:
        nonlocal relationship_index
        relationship_index += 1
        source_id = row.get("id")
        identity = (
            f"{relationship_type}:{source_id}"
            if isinstance(source_id, str)
            else f"{relationship_type}:{relationship_index:010d}"
        )
        database.execute(
            """
            INSERT INTO relationships (
              id, relationship_type, from_key, to_key, sort_order, event_at,
              canonical_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                identity,
                relationship_type,
                from_key,
                to_key,
                sort_order,
                event_at,
                _canonical_json(row).decode("utf-8"),
            ),
        )

    for table, relationship_type, left_type, left_field, right_type, right_field in (
        ("song_languages", "song_language", "song", "song_id", "language", "language_id"),
        ("song_tags", "song_tag", "song", "song_id", "tag", "tag_id"),
        ("song_credits", "song_credit", "song", "song_id", "person", "person_id"),
        (
            "recording_credits", "recording_credit", "recording",
            "recording_id", "person", "person_id",
        ),
    ):
        for row in source.get(table, []):
            left = keys.get((left_type, str(row.get(left_field))))
            right = keys.get((right_type, str(row.get(right_field))))
            if left is None or right is None:
                raise ArchiveError("restore_relationship_orphan")
            add_relationship(
                relationship_type,
                left,
                right,
                row,
                sort_order=row.get("sort_order") if isinstance(row.get("sort_order"), int) else None,
            )
    for row in source.get("scans", []):
        left = keys.get(("scan", str(row.get("id"))))
        right = keys.get(("representation", str(row.get("media_id"))))
        if left is None or right is None:
            raise ArchiveError("restore_scan_media_orphan")
        add_relationship("scan_original", left, right, row)
    for row in source.get("recordings", []):
        left = keys.get(("recording", str(row.get("id"))))
        original = keys.get(("representation", str(row.get("original_media_id"))))
        if left is None or original is None:
            raise ArchiveError("restore_recording_media_orphan")
        add_relationship("recording_original", left, original, row)
        playback_id = row.get("playback_media_id")
        if playback_id is not None:
            playback = keys.get(("representation", str(playback_id)))
            if playback is None:
                raise ArchiveError("restore_recording_media_orphan")
            add_relationship("recording_playback", left, playback, row)
    for row in source.get("media_parent_moves", []):
        child_type = "scan" if row.get("scan_id") is not None else "recording"
        child_id = row.get("scan_id") or row.get("recording_id")
        child = keys.get((child_type, str(child_id)))
        target = keys.get(("song", str(row.get("to_song_id"))))
        if child is None or target is None:
            raise ArchiveError("restore_parent_move_orphan")
        add_relationship(
            "parent_move",
            child,
            target,
            row,
            event_at=row.get("moved_at") if isinstance(row.get("moved_at"), str) else None,
        )
    for table, rows in sorted(source.items()):
        for index, row in enumerate(rows):
            key = next(
                (
                    str(row[field])
                    for field in (
                        "id", "identity", "playback_media_id", "source_media_id",
                        "media_id", "sha256"
                    )
                    if isinstance(row.get(field), str)
                ),
                f"{index:010d}",
            )
            database.execute(
                """
                INSERT INTO source_records (table_name, record_key, canonical_json)
                VALUES (?, ?, ?)
                """,
                (table, key, _canonical_json(row).decode("utf-8")),
            )
    database.execute("PRAGMA foreign_key_check")


def _copy_restored_payloads(
    result: VerificationResult,
    temporary: Path,
) -> None:
    media_root = temporary / "media"
    media_root.mkdir(mode=0o700)
    durable: set[str] = set(_representation_entities(result.catalog))
    for song in result.catalog["songs"]:
        durable.update(
            lyric["payloadPath"] for lyric in song.get("lyricTexts", [])
        )
    with zipfile.ZipFile(result.archive, "r") as archive:
        for payload_path in sorted(durable, key=lambda value: value.encode("utf-8")):
            safe = _safe_relative_path(payload_path)
            member = f"{result.root}/data/{safe}"
            info = archive.getinfo(member)
            destination = media_root / PurePosixPath(safe)
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with archive.open(info, "r") as source, destination.open("xb") as output:
                os.chmod(destination, 0o600)
                digest = hashlib.sha256()
                size = 0
                while chunk := source.read(CHUNK_SIZE):
                    output.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
            manifest_path = f"data/{safe}"
            if (
                size != result.payload_sizes[manifest_path]
                or digest.hexdigest() != result.payload_manifest[manifest_path]
            ):
                raise ArchiveError("restore_payload_fixity_failed")


def _restore_reconciliation(
    result: VerificationResult,
    restored_payloads: int,
    source_records: int,
) -> dict[str, Any]:
    return {
        "profile": PROFILE_VERSION,
        "exportId": result.catalog["export"]["id"],
        "planDigest": result.catalog["export"]["planDigest"],
        "catalogSha256": _sha256_bytes(_canonical_json(result.catalog, pretty=True)),
        "archiveSha256": result.archive_sha256,
        "sourceRecords": source_records,
        "restoredPayloads": restored_payloads,
        "actorsRestoredActive": 0,
        "verified": True,
    }


def _verify_existing_restore(
    destination: Path,
    expected: Mapping[str, Any],
    result: VerificationResult,
) -> None:
    reconciliation_path = destination / "reconciliation.json"
    database_path = destination / "library.sqlite3"
    media_root = destination / "media"
    actual = _read_json(reconciliation_path)
    if actual != expected or not database_path.is_file() or not media_root.is_dir():
        raise ArchiveError("restore_destination_conflict")
    try:
        database = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)
        metadata = dict(database.execute("SELECT key, value FROM restore_metadata"))
        actor_violations = database.execute(
            "SELECT COUNT(*) FROM actors WHERE restore_as_active <> 0"
        ).fetchone()[0]
        source_count = database.execute("SELECT COUNT(*) FROM source_records").fetchone()[0]
        database.close()
    except sqlite3.Error as error:
        raise ArchiveError("restore_destination_conflict") from error
    if (
        metadata.get("export_id") != expected["exportId"]
        or metadata.get("catalog_sha256") != expected["catalogSha256"]
        or actor_violations
        or source_count != expected["sourceRecords"]
    ):
        raise ArchiveError("restore_destination_conflict")
    for path, representation in _representation_entities(result.catalog).items():
        restored = media_root / PurePosixPath(path)
        if not restored.is_file():
            raise ArchiveError("restore_destination_conflict")
        size, digest = _hash_file(restored)
        if size != representation["byteSize"] or digest != representation["sha256"]:
            raise ArchiveError("restore_destination_conflict")


def restore_local(
    archive: Path,
    destination: Path,
    *,
    dry_run: bool = False,
) -> dict[str, Any]:
    result = verify_archive(archive)
    destination = destination.expanduser().resolve()
    if _unsafe_broad_path(destination):
        raise ArchiveError("unsafe_restore_destination")
    source_records = sum(len(rows) for rows in _source_rows(result.catalog).values())
    durable_paths = set(_representation_entities(result.catalog))
    for song in result.catalog["songs"]:
        durable_paths.update(
            lyric["payloadPath"] for lyric in song.get("lyricTexts", [])
        )
    reconciliation = _restore_reconciliation(
        result, len(durable_paths), source_records
    )
    if dry_run:
        return {**reconciliation, "dryRun": True, "wouldWrite": False}
    if destination.exists():
        _verify_existing_restore(destination, reconciliation, result)
        return {**reconciliation, "idempotent": True}
    parent = destination.parent
    parent.mkdir(parents=True, exist_ok=True)
    temporary = parent / f".{destination.name}.partial-{uuid.uuid4().hex}"
    temporary.mkdir(mode=0o700)
    try:
        database_path = temporary / "library.sqlite3"
        database = sqlite3.connect(database_path)
        try:
            database.execute("PRAGMA journal_mode = DELETE")
            database.execute("BEGIN IMMEDIATE")
            _populate_reference_database(database, result)
            database.commit()
        except Exception:
            database.rollback()
            raise
        finally:
            database.close()
        os.chmod(database_path, 0o600)
        _copy_restored_payloads(result, temporary)
        reconciliation_path = temporary / "reconciliation.json"
        _atomic_json(reconciliation_path, reconciliation)
        os.replace(temporary, destination)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return {**reconciliation, "idempotent": False}


def zip64_required(
    entry_count: int,
    largest_entry: int,
    total_uncompressed: int,
) -> bool:
    return (
        entry_count >= zipfile.ZIP_FILECOUNT_LIMIT
        or largest_entry >= zipfile.ZIP64_LIMIT
        or total_uncompressed >= zipfile.ZIP64_LIMIT
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Music Library portable preservation archive tool"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    build = subparsers.add_parser("build", help="download and build a verified archive")
    build.add_argument("--kit", required=True, type=Path)
    build.add_argument("--output", required=True, type=Path)
    build.add_argument("--work-dir", type=Path)
    build.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)
    verify = subparsers.add_parser("verify", help="fully verify an archive")
    verify.add_argument("archive", type=Path)
    inspect = subparsers.add_parser("inspect", help="verify and print an aggregate summary")
    inspect.add_argument("archive", type=Path)
    inspect.add_argument(
        "--show-paths",
        action="store_true",
        help="explicitly print private friendly payload paths",
    )
    restore = subparsers.add_parser(
        "restore-local", help="verify and restore into a constrained local reference model"
    )
    restore.add_argument("archive", type=Path)
    restore.add_argument("--destination", required=True, type=Path)
    restore.add_argument("--dry-run", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "build":
            build_archive(
                args.kit,
                args.output,
                work=args.work_dir,
                concurrency=args.concurrency,
            )
        elif args.command == "verify":
            result = verify_archive(args.archive)
            print(json.dumps({
                "status": "VERIFIED",
                "profile": PROFILE_VERSION,
                "exportId": result.catalog["export"]["id"],
                "archiveBytes": result.archive.stat().st_size,
                "archiveSha256": result.archive_sha256,
                "counts": _privacy_counts(result.catalog),
            }, sort_keys=True))
        elif args.command == "inspect":
            print(json.dumps(
                inspect_archive(args.archive, show_paths=args.show_paths),
                ensure_ascii=False,
                sort_keys=True,
                indent=2,
            ))
        elif args.command == "restore-local":
            print(json.dumps(
                restore_local(
                    args.archive,
                    args.destination,
                    dry_run=args.dry_run,
                ),
                sort_keys=True,
                indent=2,
            ))
        return 0
    except ArchiveError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
