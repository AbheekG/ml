from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from pathlib import Path

from .batch import (
    BatchManifest,
    BatchManifestError,
    load_batch_manifest,
    run_batch,
)
from .safety import PROTECTED_OUTPUT_ROOTS, is_within
from .tools import FFmpegTools, MediaToolError


def validate_detail_report_path(
    path: Path,
    *,
    batch_manifest_path: Path,
    manifest: BatchManifest,
) -> Path:
    resolved = path.resolve(strict=False)
    if any(
        is_within(resolved, root.resolve())
        for root in PROTECTED_OUTPUT_ROOTS
    ):
        raise BatchManifestError("report_inside_protected_legacy_root")
    if resolved == batch_manifest_path.resolve(strict=True):
        raise BatchManifestError("report_replaces_batch_manifest")
    if is_within(resolved, manifest.output_root):
        raise BatchManifestError("report_inside_batch_output_root")
    if any(resolved == job.source for job in manifest.jobs):
        raise BatchManifestError("report_replaces_batch_input")
    return resolved


def _write_json_atomic(path: Path, payload: dict[str, object]) -> None:
    resolved = path.resolve(strict=False)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    temporary = resolved.parent / f".{resolved.name}.{uuid.uuid4().hex}.temporary"
    try:
        with temporary.open("x", encoding="utf-8") as destination:
            json.dump(payload, destination, indent=2, sort_keys=True)
            destination.write("\n")
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(temporary, resolved)
    finally:
        temporary.unlink(missing_ok=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate or execute an opaque audio-conversion batch manifest.",
    )
    parser.add_argument("manifest", type=Path)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Create verified derivatives. Default mode is read-only.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=min(4, os.cpu_count() or 1),
    )
    parser.add_argument("--details", type=Path)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    return parser


def main(arguments: list[str] | None = None) -> int:
    options = build_parser().parse_args(arguments)
    tools = FFmpegTools(ffmpeg=options.ffmpeg, ffprobe=options.ffprobe)
    last_reported = 0

    def report_progress(completed: int, total: int) -> None:
        nonlocal last_reported
        interval = max(1, total // 20)
        if completed == total or completed - last_reported >= interval:
            last_reported = completed
            print(
                json.dumps({"completed": completed, "total": total}),
                file=sys.stderr,
                flush=True,
            )

    try:
        tools.require_available()
        manifest = load_batch_manifest(options.manifest)
        detail_path = None
        if options.details is not None:
            detail_path = validate_detail_report_path(
                options.details,
                batch_manifest_path=options.manifest,
                manifest=manifest,
            )
        batch = run_batch(
            tools,
            manifest,
            execute=options.execute,
            workers=options.workers,
            on_progress=report_progress,
        )
        if detail_path is not None:
            _write_json_atomic(detail_path, batch.details())
    except (BatchManifestError, MediaToolError, OSError, ValueError) as error:
        print(
            json.dumps(
                {
                    "status": "error",
                    "error": getattr(error, "code", "batch_configuration_error"),
                },
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 2

    print(json.dumps(batch.aggregate(), indent=2, sort_keys=True))
    return 1 if batch.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
