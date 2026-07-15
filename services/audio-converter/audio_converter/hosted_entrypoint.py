from __future__ import annotations

import json
import os
import re
import sys
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import TextIO

from .hosted_adapter import (
    HostedAdapterConfig,
    HostedAdapterError,
    HostedRunOutcome,
    run_hosted_job_once,
)
from .models import ProcessingPolicy


EXIT_OK = 0
EXIT_FAILED = 1
EXIT_RECONCILIATION_REQUIRED = 2

_PREFIX = "AUDIO_PROCESSOR_"
_REQUIRED_ENVIRONMENT = {
    "AUDIO_PROCESSOR_WORKER_ORIGIN",
    "AUDIO_PROCESSOR_ALLOWED_TRANSFER_ORIGINS_JSON",
    "AUDIO_PROCESSOR_TOKEN_FILE",
    "AUDIO_PROCESSOR_ACCESS_CREDENTIALS_FILE",
    "AUDIO_PROCESSOR_TEMPORARY_ROOT",
}
_OPTIONAL_ENVIRONMENT = {
    "AUDIO_PROCESSOR_REQUEST_TIMEOUT_SECONDS",
    "AUDIO_PROCESSOR_RETRY_ATTEMPTS",
    "AUDIO_PROCESSOR_RETRY_DELAY_SECONDS",
    "AUDIO_PROCESSOR_MAX_SOURCE_BYTES",
    "AUDIO_PROCESSOR_MAX_DERIVATIVE_BYTES",
    "AUDIO_PROCESSOR_MAX_GENERATED_OUTPUT_BYTES",
    "AUDIO_PROCESSOR_SOFT_DEADLINE_SECONDS",
    "AUDIO_PROCESSOR_MINIMUM_LEASE_REMAINING_SECONDS",
}
_ALLOWED_ENVIRONMENT = _REQUIRED_ENVIRONMENT | _OPTIONAL_ENVIRONMENT
_SAFE_CODE = re.compile(r"^[a-z][a-z0-9_]{0,99}$")


def _required_value(environment: Mapping[str, str], name: str) -> str:
    value = environment.get(name)
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise HostedAdapterError("missing_hosted_configuration")
    return value


def _parse_integer(environment: Mapping[str, str], name: str) -> int | None:
    raw = environment.get(name)
    if raw is None:
        return None
    if not isinstance(raw, str) or not raw.isascii() or not raw.isdecimal():
        raise HostedAdapterError("invalid_hosted_configuration")
    return int(raw)


def _parse_number(environment: Mapping[str, str], name: str) -> float | None:
    raw = environment.get(name)
    if raw is None:
        return None
    if (
        not isinstance(raw, str)
        or not raw.isascii()
        or re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", raw) is None
    ):
        raise HostedAdapterError("invalid_hosted_configuration")
    return float(raw)


def _read_processor_token(environment: Mapping[str, str]) -> str:
    raw_path = _required_value(environment, "AUDIO_PROCESSOR_TOKEN_FILE")
    path = Path(raw_path)
    if not path.is_absolute():
        raise HostedAdapterError("invalid_processor_token_file")
    try:
        resolved = path.resolve(strict=True)
        if not resolved.is_file():
            raise HostedAdapterError("invalid_processor_token_file")
        with resolved.open("rb") as source:
            raw_token = source.read(513)
            if source.read(1):
                raise HostedAdapterError("invalid_processor_token_file")
        token = raw_token.decode("ascii")
    except HostedAdapterError:
        raise
    except (OSError, UnicodeDecodeError, ValueError):
        raise HostedAdapterError("invalid_processor_token_file") from None
    if not 32 <= len(token) <= 512 or any(
        not 33 <= ord(character) <= 126 for character in token
    ):
        raise HostedAdapterError("invalid_processor_token_file")
    return token


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


def _read_access_credentials(
    environment: Mapping[str, str],
) -> tuple[str, str]:
    raw_path = _required_value(
        environment,
        "AUDIO_PROCESSOR_ACCESS_CREDENTIALS_FILE",
    )
    path = Path(raw_path)
    if not path.is_absolute():
        raise HostedAdapterError("invalid_access_credentials_file")
    try:
        resolved = path.resolve(strict=True)
        if not resolved.is_file():
            raise HostedAdapterError("invalid_access_credentials_file")
        with resolved.open("rb") as source:
            raw_credentials = source.read(4097)
        if not raw_credentials or len(raw_credentials) > 4096:
            raise HostedAdapterError("invalid_access_credentials_file")
        credentials = json.loads(
            raw_credentials.decode("ascii"),
            object_pairs_hook=_unique_json_object,
            parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
        )
    except HostedAdapterError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise HostedAdapterError("invalid_access_credentials_file") from None
    if (
        not isinstance(credentials, dict)
        or set(credentials) != {"clientId", "clientSecret"}
        or not isinstance(credentials["clientId"], str)
        or not isinstance(credentials["clientSecret"], str)
    ):
        raise HostedAdapterError("invalid_access_credentials_file")
    return credentials["clientId"], credentials["clientSecret"]


def _parse_origins(environment: Mapping[str, str]) -> frozenset[str]:
    raw = _required_value(
        environment,
        "AUDIO_PROCESSOR_ALLOWED_TRANSFER_ORIGINS_JSON",
    )
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        raise HostedAdapterError("invalid_transfer_origin_allowlist") from None
    if (
        not isinstance(value, list)
        or not value
        or len(value) > 16
        or any(not isinstance(origin, str) for origin in value)
        or len(set(value)) != len(value)
    ):
        raise HostedAdapterError("invalid_transfer_origin_allowlist")
    return frozenset(value)


def load_hosted_entrypoint_config(
    environment: Mapping[str, str],
) -> HostedAdapterConfig:
    if "AUDIO_PROCESSOR_TOKEN" in environment:
        raise HostedAdapterError("processor_token_environment_forbidden")
    if (
        "AUDIO_PROCESSOR_ACCESS_CLIENT_ID" in environment
        or "AUDIO_PROCESSOR_ACCESS_CLIENT_SECRET" in environment
    ):
        raise HostedAdapterError("access_credentials_environment_forbidden")
    unknown = {
        name
        for name in environment
        if name.startswith(_PREFIX) and name not in _ALLOWED_ENVIRONMENT
    }
    if unknown:
        raise HostedAdapterError("unknown_hosted_configuration")

    temporary_root = Path(_required_value(
        environment,
        "AUDIO_PROCESSOR_TEMPORARY_ROOT",
    ))
    if not temporary_root.is_absolute():
        raise HostedAdapterError("invalid_temporary_root")

    access_client_id, access_client_secret = _read_access_credentials(environment)
    values: dict[str, object] = {
        "worker_base_url": _required_value(
            environment,
            "AUDIO_PROCESSOR_WORKER_ORIGIN",
        ),
        "processor_token": _read_processor_token(environment),
        "access_client_id": access_client_id,
        "access_client_secret": access_client_secret,
        "allowed_transfer_origins": _parse_origins(environment),
        "temporary_root": temporary_root,
    }
    optional_values = {
        "request_timeout_seconds": _parse_number(
            environment,
            "AUDIO_PROCESSOR_REQUEST_TIMEOUT_SECONDS",
        ),
        "retry_attempts": _parse_integer(
            environment,
            "AUDIO_PROCESSOR_RETRY_ATTEMPTS",
        ),
        "retry_delay_seconds": _parse_number(
            environment,
            "AUDIO_PROCESSOR_RETRY_DELAY_SECONDS",
        ),
        "max_source_bytes": _parse_integer(
            environment,
            "AUDIO_PROCESSOR_MAX_SOURCE_BYTES",
        ),
        "max_derivative_bytes": _parse_integer(
            environment,
            "AUDIO_PROCESSOR_MAX_DERIVATIVE_BYTES",
        ),
        "max_generated_output_bytes": _parse_integer(
            environment,
            "AUDIO_PROCESSOR_MAX_GENERATED_OUTPUT_BYTES",
        ),
        "processing_deadline_seconds": _parse_number(
            environment,
            "AUDIO_PROCESSOR_SOFT_DEADLINE_SECONDS",
        ),
        "minimum_lease_remaining_seconds": _parse_number(
            environment,
            "AUDIO_PROCESSOR_MINIMUM_LEASE_REMAINING_SECONDS",
        ),
    }
    values.update({
        name: value
        for name, value in optional_values.items()
        if value is not None
    })
    return HostedAdapterConfig(**values)  # type: ignore[arg-type]


def _safe_code(code: str) -> str:
    return code if _SAFE_CODE.fullmatch(code) else "audio_processor_failed"


def _elapsed_milliseconds(started_at: float, monotonic: Callable[[], float]) -> int:
    try:
        elapsed = float(monotonic()) - started_at
    except Exception:
        return 0
    if elapsed < 0 or elapsed != elapsed or elapsed == float("inf"):
        return 0
    return round(elapsed * 1000)


def _write_outcome(
    output: TextIO,
    *,
    outcome: str,
    elapsed_milliseconds: int,
    playback_kind: str | None = None,
    error_code: str | None = None,
) -> None:
    record: dict[str, object] = {
        "elapsedMilliseconds": elapsed_milliseconds,
        "outcome": outcome,
        "policyId": ProcessingPolicy().policy_id,
    }
    if playback_kind is not None:
        record["playbackKind"] = playback_kind
    if error_code is not None:
        record["errorCode"] = _safe_code(error_code)
    output.write(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n")
    output.flush()


def main(
    *,
    environment: Mapping[str, str] | None = None,
    output: TextIO = sys.stdout,
    monotonic: Callable[[], float] = time.monotonic,
    run_once: Callable[[HostedAdapterConfig], HostedRunOutcome] | None = None,
) -> int:
    try:
        started_at = float(monotonic())
    except Exception:
        started_at = 0.0
    try:
        config = load_hosted_entrypoint_config(
            environment if environment is not None else os.environ
        )
        outcome = (
            run_once(config)
            if run_once is not None
            else run_hosted_job_once(config, monotonic=monotonic)
        )
    except HostedAdapterError as error:
        elapsed = _elapsed_milliseconds(started_at, monotonic)
        if error.code == "claim_delivery_failed" or error.code.endswith("_ambiguous"):
            _write_outcome(
                output,
                outcome="reconciliation_required",
                elapsed_milliseconds=elapsed,
            )
            return EXIT_RECONCILIATION_REQUIRED
        _write_outcome(
            output,
            outcome="failed",
            elapsed_milliseconds=elapsed,
            error_code=error.code,
        )
        return EXIT_FAILED
    except Exception:
        _write_outcome(
            output,
            outcome="failed",
            elapsed_milliseconds=_elapsed_milliseconds(started_at, monotonic),
            error_code="audio_processor_internal_error",
        )
        return EXIT_FAILED

    elapsed = _elapsed_milliseconds(started_at, monotonic)
    if outcome.status == "no_work":
        _write_outcome(output, outcome="no_work", elapsed_milliseconds=elapsed)
        return EXIT_OK
    if outcome.status == "succeeded" and outcome.playback_kind in {"original", "derivative"}:
        _write_outcome(
            output,
            outcome="succeeded",
            elapsed_milliseconds=elapsed,
            playback_kind=outcome.playback_kind,
        )
        return EXIT_OK
    if outcome.status == "failed" and outcome.failure_reported and outcome.error_code:
        _write_outcome(
            output,
            outcome="failed",
            elapsed_milliseconds=elapsed,
            error_code=outcome.error_code,
        )
        return EXIT_FAILED
    _write_outcome(
        output,
        outcome="reconciliation_required",
        elapsed_milliseconds=elapsed,
    )
    return EXIT_RECONCILIATION_REQUIRED


def cli() -> None:
    raise SystemExit(main())


if __name__ == "__main__":
    cli()
