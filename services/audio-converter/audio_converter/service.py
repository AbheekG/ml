from __future__ import annotations

import hashlib
import json
import os
import uuid
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Protocol

from .models import (
    AudioInfo,
    DecodeResult,
    Decision,
    DecisionKind,
    DerivativeValidation,
    ProcessingPolicy,
)
from .policy import decide, validate_derivative


class AudioTools(Protocol):
    def probe(self, source: Path) -> AudioInfo: ...

    def decode_check(
        self,
        source: Path,
        stream_index: int,
        *,
        strict: bool,
    ) -> DecodeResult: ...

    def transcode(
        self,
        source: Path,
        output: Path,
        source_info: AudioInfo,
    ) -> None: ...


class PreparationError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class FileSummary:
    sha256: str
    byte_size: int
    codec: str
    containers: tuple[str, ...]
    duration_seconds: float
    bit_rate: int
    sample_rate: int
    channels: int
    had_decode_warnings: bool


@dataclass(frozen=True)
class PreparationResult:
    status: str
    decision: Decision
    original: FileSummary
    derivative: FileSummary | None = None
    validation: DerivativeValidation | None = None

    def to_dict(self, label: str) -> dict[str, object]:
        return {
            "label": label,
            "status": self.status,
            "decision": asdict(self.decision),
            "original": asdict(self.original),
            "derivative": (
                asdict(self.derivative) if self.derivative is not None else None
            ),
            "validation": (
                asdict(self.validation) if self.validation is not None else None
            ),
        }


MANIFEST_SCHEMA_VERSION = 1


def manifest_path(output: Path) -> Path:
    return output.with_suffix(f"{output.suffix}.json")


def _read_manifest(path: Path) -> dict[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise PreparationError("invalid_derivative_manifest") from error
    if not isinstance(payload, dict):
        raise PreparationError("invalid_derivative_manifest")
    return payload


def _write_manifest_atomic(path: Path, payload: dict[str, object]) -> None:
    temporary_path = path.parent / f".{path.name}.{uuid.uuid4().hex}.temporary"
    try:
        with temporary_path.open("x", encoding="utf-8") as destination:
            json.dump(payload, destination, indent=2, sort_keys=True)
            destination.write("\n")
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def summarize(path: Path, info: AudioInfo) -> FileSummary:
    return FileSummary(
        sha256=sha256_file(path),
        byte_size=info.byte_size,
        codec=info.codec_name,
        containers=info.container_names,
        duration_seconds=info.duration_seconds,
        bit_rate=info.effective_bit_rate,
        sample_rate=info.sample_rate,
        channels=info.channels,
        had_decode_warnings=info.had_decode_warnings,
    )


def _inspect_and_decode(
    tools: AudioTools,
    source: Path,
    *,
    strict: bool,
) -> AudioInfo:
    info = tools.probe(source)
    decoded = tools.decode_check(source, info.stream_index, strict=strict)
    if not strict:
        maximum_difference = max(1.0, info.duration_seconds * 0.05)
        if abs(decoded.duration_seconds - info.duration_seconds) > maximum_difference:
            raise PreparationError("source_decoded_duration_mismatch")
    return replace(
        info,
        duration_seconds=decoded.duration_seconds,
        had_decode_warnings=decoded.had_recoverable_errors,
    )


def _validate_existing_output(
    tools: AudioTools,
    source_info: AudioInfo,
    output: Path,
    original: FileSummary,
    decision: Decision,
    policy: ProcessingPolicy,
) -> tuple[AudioInfo, DerivativeValidation]:
    provenance_path = manifest_path(output)
    if not provenance_path.is_file():
        raise PreparationError("existing_output_missing_manifest")
    provenance = _read_manifest(provenance_path)
    expected_provenance = {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "policyId": policy.policy_id,
        "sourceSha256": original.sha256,
        "sourceByteSize": original.byte_size,
    }
    if any(
        provenance.get(key) != value
        for key, value in expected_provenance.items()
    ):
        raise PreparationError("existing_output_provenance_mismatch")

    derivative_info = _inspect_and_decode(tools, output, strict=True)
    validation = validate_derivative(
        source_info,
        derivative_info,
        decision,
        policy,
    )
    if not validation.accepted:
        raise PreparationError("existing_output_does_not_match_policy")
    if provenance.get("derivativeByteSize") != derivative_info.byte_size:
        raise PreparationError("existing_output_provenance_mismatch")
    if provenance.get("derivativeSha256") != sha256_file(output):
        raise PreparationError("existing_output_provenance_mismatch")
    return derivative_info, validation


def prepare(
    tools: AudioTools,
    source: Path,
    *,
    output: Path | None,
    execute: bool,
    policy: ProcessingPolicy = ProcessingPolicy(),
) -> PreparationResult:
    source = source.resolve(strict=True)
    if not source.is_file():
        raise PreparationError("source_is_not_a_file")

    source_info = _inspect_and_decode(tools, source, strict=False)
    source_decision = decide(source_info, policy)
    original_summary = summarize(source, source_info)

    if output is not None:
        output = output.resolve(strict=False)
        if output == source:
            raise PreparationError("output_must_not_replace_original")

    if source_decision.kind is DecisionKind.USE_ORIGINAL:
        if output is not None and (
            output.exists() or manifest_path(output).exists()
        ):
            raise PreparationError("unneeded_output_for_original")
        return PreparationResult(
            status="original_is_playback",
            decision=source_decision,
            original=original_summary,
        )

    if output is not None and output.exists():
        if not output.is_file():
            raise PreparationError("existing_output_is_not_a_file")
        derivative_info, validation = _validate_existing_output(
            tools,
            source_info,
            output,
            original_summary,
            source_decision,
            policy,
        )
        return PreparationResult(
            status="verified_existing_derivative",
            decision=source_decision,
            original=original_summary,
            derivative=summarize(output, derivative_info),
            validation=validation,
        )

    if output is not None and manifest_path(output).exists():
        raise PreparationError("derivative_manifest_without_output")

    if not execute:
        return PreparationResult(
            status="would_create_derivative",
            decision=source_decision,
            original=original_summary,
        )

    if output is None:
        raise PreparationError("output_required_for_execute")

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output.parent / (
        f".{output.name}.{uuid.uuid4().hex}.temporary.mp3"
    )
    try:
        tools.transcode(source, temporary_output, source_info)
        derivative_info = _inspect_and_decode(
            tools,
            temporary_output,
            strict=True,
        )
        validation = validate_derivative(
            source_info,
            derivative_info,
            source_decision,
            policy,
        )
        if not validation.accepted:
            if validation.reason == "oversized_mp3_saving_not_material":
                return PreparationResult(
                    status="candidate_discarded_original_is_playback",
                    decision=source_decision,
                    original=original_summary,
                    validation=validation,
                )
            raise PreparationError(validation.reason)

        derivative_summary = summarize(temporary_output, derivative_info)
        os.replace(temporary_output, output)
        try:
            _write_manifest_atomic(
                manifest_path(output),
                {
                    "schemaVersion": MANIFEST_SCHEMA_VERSION,
                    "policyId": policy.policy_id,
                    "sourceSha256": original_summary.sha256,
                    "sourceByteSize": original_summary.byte_size,
                    "derivativeSha256": derivative_summary.sha256,
                    "derivativeByteSize": derivative_summary.byte_size,
                },
            )
        except OSError:
            output.unlink(missing_ok=True)
            raise
        return PreparationResult(
            status="created_derivative",
            decision=source_decision,
            original=original_summary,
            derivative=derivative_summary,
            validation=validation,
        )
    finally:
        temporary_output.unlink(missing_ok=True)
