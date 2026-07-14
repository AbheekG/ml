from __future__ import annotations

import json
from collections import Counter, defaultdict
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

from .safety import is_opaque_label, is_within, validate_output_path
from .service import (
    AudioTools,
    PreparationError,
    PreparationResult,
    manifest_path,
    prepare,
)
from .tools import MediaToolError


BATCH_MANIFEST_SCHEMA_VERSION = 1


class BatchManifestError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class BatchJob:
    label: str
    source: Path
    output: Path


@dataclass(frozen=True)
class BatchManifest:
    output_root: Path
    jobs: tuple[BatchJob, ...]


@dataclass(frozen=True)
class BatchEntry:
    label: str
    result: PreparationResult | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, object]:
        if self.result is not None:
            return self.result.to_dict(self.label)
        return {
            "label": self.label,
            "status": "error",
            "error": self.error,
        }


@dataclass(frozen=True)
class BatchRun:
    execute: bool
    entries: tuple[BatchEntry, ...]
    unexpected_output_files: int

    @property
    def failed(self) -> int:
        return sum(entry.error is not None for entry in self.entries)

    def aggregate(self) -> dict[str, object]:
        statuses: Counter[str] = Counter()
        decisions: Counter[str] = Counter()
        codecs: Counter[str] = Counter()
        containers: Counter[str] = Counter()
        errors: Counter[str] = Counter()
        source_hash_labels: dict[str, list[str]] = defaultdict(list)
        original_bytes = 0
        derivative_bytes = 0
        source_decode_warnings = 0

        for entry in self.entries:
            if entry.error is not None:
                errors[entry.error] += 1
                continue
            if entry.result is None:
                errors["missing_batch_result"] += 1
                continue
            result = entry.result
            statuses[result.status] += 1
            decisions[result.decision.kind.value] += 1
            codecs[result.original.codec] += 1
            containers["+".join(result.original.containers)] += 1
            original_bytes += result.original.byte_size
            if result.original.had_decode_warnings:
                source_decode_warnings += 1
            source_hash_labels[result.original.sha256].append(entry.label)
            if result.derivative is not None:
                derivative_bytes += result.derivative.byte_size

        duplicate_groups = [
            labels
            for labels in source_hash_labels.values()
            if len(labels) > 1
        ]
        successful = len(self.entries) - sum(errors.values())
        return {
            "schemaVersion": 1,
            "mode": "execute" if self.execute else "dry-run",
            "jobs": len(self.entries),
            "successful": successful,
            "failed": sum(errors.values()),
            "unexpectedOutputFiles": self.unexpected_output_files,
            "statusCounts": dict(sorted(statuses.items())),
            "decisionCounts": dict(sorted(decisions.items())),
            "sourceCodecCounts": dict(sorted(codecs.items())),
            "sourceContainerCounts": dict(sorted(containers.items())),
            "sourceFilesWithRecoverableDecodeErrors": source_decode_warnings,
            "sourceBytes": original_bytes,
            "verifiedDerivativeBytes": derivative_bytes,
            "duplicateContentGroups": len(duplicate_groups),
            "duplicateContentFiles": sum(len(group) for group in duplicate_groups),
            "errorCounts": dict(sorted(errors.items())),
        }

    def details(self) -> dict[str, object]:
        return {
            "schemaVersion": 1,
            "mode": "execute" if self.execute else "dry-run",
            "entries": [
                entry.to_dict()
                for entry in sorted(self.entries, key=lambda item: item.label)
            ],
        }


def _resolve_manifest_path(base: Path, value: object, code: str) -> Path:
    if not isinstance(value, str) or not value:
        raise BatchManifestError(code)
    path = Path(value)
    if not path.is_absolute():
        path = base / path
    return path.resolve(strict=False)


def load_batch_manifest(path: Path) -> BatchManifest:
    try:
        manifest_path_value = path.resolve(strict=True)
        payload = json.loads(manifest_path_value.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BatchManifestError("invalid_batch_manifest") from error
    if not isinstance(payload, dict):
        raise BatchManifestError("invalid_batch_manifest")
    if payload.get("schemaVersion") != BATCH_MANIFEST_SCHEMA_VERSION:
        raise BatchManifestError("unsupported_batch_manifest_version")

    base = manifest_path_value.parent
    output_root = _resolve_manifest_path(
        base,
        payload.get("outputRoot"),
        "invalid_batch_output_root",
    )
    raw_jobs = payload.get("jobs")
    if not isinstance(raw_jobs, list) or not raw_jobs:
        raise BatchManifestError("batch_jobs_required")

    jobs = []
    labels: set[str] = set()
    sources: set[Path] = set()
    outputs: set[Path] = set()
    for raw_job in raw_jobs:
        if not isinstance(raw_job, dict):
            raise BatchManifestError("invalid_batch_job")
        label = raw_job.get("label")
        if not isinstance(label, str) or not is_opaque_label(label):
            raise BatchManifestError("invalid_batch_label")
        source = _resolve_manifest_path(
            base,
            raw_job.get("input"),
            "invalid_batch_input",
        )
        output = _resolve_manifest_path(
            base,
            raw_job.get("output"),
            "invalid_batch_output",
        )
        try:
            validate_output_path(output)
        except PreparationError as error:
            raise BatchManifestError(error.code) from error
        if not is_within(output, output_root):
            raise BatchManifestError("batch_output_outside_output_root")
        if source == output:
            raise BatchManifestError("batch_output_replaces_input")
        if label in labels:
            raise BatchManifestError("duplicate_batch_label")
        if source in sources:
            raise BatchManifestError("duplicate_batch_input")
        if output in outputs:
            raise BatchManifestError("duplicate_batch_output")
        labels.add(label)
        sources.add(source)
        outputs.add(output)
        jobs.append(BatchJob(label=label, source=source, output=output))

    return BatchManifest(output_root=output_root, jobs=tuple(jobs))


def find_unexpected_output_files(manifest: BatchManifest) -> tuple[Path, ...]:
    if not manifest.output_root.exists():
        return ()
    if not manifest.output_root.is_dir():
        raise BatchManifestError("batch_output_root_is_not_directory")
    expected = {
        path
        for job in manifest.jobs
        for path in (job.output, manifest_path(job.output))
    }
    actual = {
        path.resolve()
        for path in manifest.output_root.rglob("*")
        if path.is_file()
    }
    return tuple(sorted(actual - expected))


PrepareOne = Callable[..., PreparationResult]
ProgressCallback = Callable[[int, int], None]


def run_batch(
    tools: AudioTools,
    manifest: BatchManifest,
    *,
    execute: bool,
    workers: int,
    prepare_one: PrepareOne = prepare,
    on_progress: ProgressCallback | None = None,
) -> BatchRun:
    if workers < 1:
        raise ValueError("workers must be positive")
    unexpected = find_unexpected_output_files(manifest)
    if unexpected:
        raise BatchManifestError("unexpected_batch_output_files")

    def process(job: BatchJob) -> BatchEntry:
        try:
            result = prepare_one(
                tools,
                job.source,
                output=job.output,
                execute=execute,
            )
        except (MediaToolError, PreparationError, OSError) as error:
            return BatchEntry(
                label=job.label,
                error=getattr(error, "code", "filesystem_error"),
            )
        return BatchEntry(label=job.label, result=result)

    entries = []
    total = len(manifest.jobs)
    if workers == 1:
        for job in manifest.jobs:
            entries.append(process(job))
            if on_progress is not None:
                on_progress(len(entries), total)
    else:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(process, job): job
                for job in manifest.jobs
            }
            for future in as_completed(futures):
                entries.append(future.result())
                if on_progress is not None:
                    on_progress(len(entries), total)

    return BatchRun(
        execute=execute,
        entries=tuple(entries),
        unexpected_output_files=0,
    )
