from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from types import TracebackType
from typing import BinaryIO, Protocol, TypeAlias
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlparse
from urllib.request import (
    HTTPRedirectHandler,
    OpenerDirector,
    ProxyHandler,
    Request,
    build_opener,
)

from .hosted_contract import (
    HostedContractError,
    HostedJobClaim,
    build_hosted_processing_result,
    parse_hosted_job_claim,
)
from .safety import PROTECTED_OUTPUT_ROOTS, is_within, validate_output_path
from .service import (
    AudioTools,
    PreparationError,
    PreparationResult,
    prepare,
    sha256_file,
)
from .tools import FFmpegTools, MediaToolError


MAX_HOSTED_AUDIO_BYTES = 512 * 1024 * 1024
MAX_HOSTED_JSON_BYTES = 64 * 1024
PROCESSOR_SOFT_DEADLINE_SECONDS = 45 * 60
MINIMUM_LEASE_REMAINING_SECONDS = 55 * 60
SAFE_FAILURE_CODE = re.compile(r"^[a-z][a-z0-9_]{0,99}$")
_RETRYABLE_HTTP_STATUSES = {408, 425, 429}
_TRANSFER_CHUNK_BYTES = 1024 * 1024
_CAPABILITY_HEADER = "X-Music-Library-Capability"


class HostedAdapterError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class HostedTransportError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("http_transport_failed")


@dataclass(frozen=True)
class HostedAdapterConfig:
    worker_base_url: str
    processor_token: str = field(repr=False)
    access_client_id: str = field(repr=False)
    access_client_secret: str = field(repr=False)
    allowed_transfer_origins: frozenset[str]
    temporary_root: Path = field(repr=False)
    request_timeout_seconds: float = 60.0
    max_claim_body_bytes: int = MAX_HOSTED_JSON_BYTES
    max_callback_body_bytes: int = MAX_HOSTED_JSON_BYTES
    max_source_bytes: int = MAX_HOSTED_AUDIO_BYTES
    max_derivative_bytes: int = MAX_HOSTED_AUDIO_BYTES
    max_generated_output_bytes: int = MAX_HOSTED_AUDIO_BYTES
    retry_attempts: int = 3
    retry_delay_seconds: float = 0.25
    processing_deadline_seconds: float = PROCESSOR_SOFT_DEADLINE_SECONDS
    minimum_lease_remaining_seconds: float = MINIMUM_LEASE_REMAINING_SECONDS

    def __post_init__(self) -> None:
        worker_origin = _validate_https_origin(
            self.worker_base_url,
            "invalid_worker_base_url",
        )
        object.__setattr__(self, "worker_base_url", worker_origin)

        token = self.processor_token
        if (
            not isinstance(token, str)
            or not 32 <= len(token) <= 512
            or any(not 33 <= ord(character) <= 126 for character in token)
        ):
            raise HostedAdapterError("invalid_processor_token")

        access_client_id = self.access_client_id
        if (
            not isinstance(access_client_id, str)
            or not 1 <= len(access_client_id) <= 512
            or any(
                not 33 <= ord(character) <= 126
                for character in access_client_id
            )
        ):
            raise HostedAdapterError("invalid_access_client_id")

        access_client_secret = self.access_client_secret
        if (
            not isinstance(access_client_secret, str)
            or not 32 <= len(access_client_secret) <= 512
            or any(
                not 33 <= ord(character) <= 126
                for character in access_client_secret
            )
        ):
            raise HostedAdapterError("invalid_access_client_secret")

        try:
            raw_origins = frozenset(self.allowed_transfer_origins)
        except TypeError:
            raise HostedAdapterError("invalid_transfer_origin_allowlist") from None
        if not raw_origins or len(raw_origins) > 16:
            raise HostedAdapterError("invalid_transfer_origin_allowlist")
        origins = frozenset(
            _validate_https_origin(origin, "invalid_transfer_origin_allowlist")
            for origin in raw_origins
        )
        if worker_origin not in origins:
            raise HostedAdapterError("worker_origin_not_allowlisted")
        if origins != frozenset({worker_origin}):
            raise HostedAdapterError("access_origin_mismatch")
        object.__setattr__(self, "allowed_transfer_origins", origins)

        try:
            temporary_root = Path(self.temporary_root).resolve(strict=True)
        except (OSError, TypeError, ValueError):
            raise HostedAdapterError("invalid_temporary_root") from None
        if not temporary_root.is_dir() or any(
            is_within(temporary_root, protected.resolve())
            for protected in PROTECTED_OUTPUT_ROOTS
        ):
            raise HostedAdapterError("invalid_temporary_root")
        object.__setattr__(self, "temporary_root", temporary_root)

        if not _bounded_number(self.request_timeout_seconds, 1.0, 300.0):
            raise HostedAdapterError("invalid_request_timeout")
        if not _bounded_integer(self.max_claim_body_bytes, 1, MAX_HOSTED_JSON_BYTES):
            raise HostedAdapterError("invalid_claim_body_limit")
        if not _bounded_integer(
            self.max_callback_body_bytes,
            1,
            MAX_HOSTED_JSON_BYTES,
        ):
            raise HostedAdapterError("invalid_callback_body_limit")
        if not _bounded_integer(self.max_source_bytes, 1, MAX_HOSTED_AUDIO_BYTES):
            raise HostedAdapterError("invalid_source_size_limit")
        if not _bounded_integer(
            self.max_derivative_bytes,
            1,
            MAX_HOSTED_AUDIO_BYTES,
        ):
            raise HostedAdapterError("invalid_derivative_size_limit")
        if not _bounded_integer(
            self.max_generated_output_bytes,
            1,
            MAX_HOSTED_AUDIO_BYTES,
        ):
            raise HostedAdapterError("invalid_generated_output_limit")
        if not _bounded_integer(self.retry_attempts, 1, 5):
            raise HostedAdapterError("invalid_retry_attempts")
        if not _bounded_number(self.retry_delay_seconds, 0.0, 5.0):
            raise HostedAdapterError("invalid_retry_delay")
        if not _bounded_number(
            self.processing_deadline_seconds,
            60.0,
            PROCESSOR_SOFT_DEADLINE_SECONDS,
        ):
            raise HostedAdapterError("invalid_processing_deadline")
        if not _bounded_number(
            self.minimum_lease_remaining_seconds,
            MINIMUM_LEASE_REMAINING_SECONDS,
            60 * 60,
        ):
            raise HostedAdapterError("invalid_minimum_lease_remaining")

    @property
    def claim_url(self) -> str:
        return f"{self.worker_base_url}/api/processing/jobs/claim"


@dataclass(frozen=True)
class HostedRunOutcome:
    status: str
    playback_kind: str | None = None
    error_code: str | None = None
    failure_reported: bool = False


HttpRequestBody: TypeAlias = bytes | Path | None


@dataclass
class HttpResponse:
    status: int
    headers: Mapping[str, str]
    body: BinaryIO

    def close(self) -> None:
        self.body.close()

    def __enter__(self) -> HttpResponse:
        return self

    def __exit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()


class HttpClient(Protocol):
    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: HttpRequestBody,
        timeout_seconds: float,
    ) -> HttpResponse: ...


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(
        self,
        request: Request,
        file_pointer: BinaryIO,
        code: int,
        message: str,
        headers: Mapping[str, str],
        new_url: str,
    ) -> None:
        return None


class UrllibHttpClient:
    def __init__(self, *, opener: OpenerDirector | None = None) -> None:
        self._opener = opener or build_opener(
            ProxyHandler({}),
            _RejectRedirects(),
        )

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: HttpRequestBody,
        timeout_seconds: float,
    ) -> HttpResponse:
        body_stream: BinaryIO | None = None
        try:
            request_body: object = body
            if isinstance(body, Path):
                body_stream = body.open("rb")
                request_body = body_stream
            request = Request(
                url,
                data=request_body,
                headers=dict(headers),
                method=method,
            )
            try:
                response = self._opener.open(request, timeout=timeout_seconds)
            except HTTPError as error:
                response = error
            return HttpResponse(
                status=int(response.status),
                headers=dict(response.headers.items()),
                body=response,
            )
        except (OSError, TimeoutError, URLError, ValueError):
            raise HostedTransportError() from None
        finally:
            if body_stream is not None:
                body_stream.close()


@dataclass(frozen=True)
class _PreparedCallback:
    body: bytes = field(repr=False)
    playback_kind: str


class _JobFailure(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class _ProcessingBudget:
    deadline: float
    monotonic: Callable[[], float] = field(repr=False)

    @classmethod
    def start(
        cls,
        duration_seconds: float,
        monotonic: Callable[[], float],
    ) -> _ProcessingBudget:
        try:
            started_at = float(monotonic())
        except Exception:
            raise HostedAdapterError("invalid_monotonic_clock") from None
        if not started_at == started_at or started_at in {float("inf"), float("-inf")}:
            raise HostedAdapterError("invalid_monotonic_clock")
        return cls(started_at + duration_seconds, monotonic)

    def remaining_seconds(self) -> float:
        try:
            remaining = self.deadline - float(self.monotonic())
        except Exception:
            raise _JobFailure("processing_deadline_exceeded") from None
        if not remaining == remaining:
            raise _JobFailure("processing_deadline_exceeded")
        return remaining

    def ensure_remaining(self) -> None:
        if self.remaining_seconds() <= 0:
            raise _JobFailure("processing_deadline_exceeded")

    def request_timeout(self, configured_timeout: float) -> float:
        remaining = self.remaining_seconds()
        if remaining <= 0:
            raise _JobFailure("processing_deadline_exceeded")
        return min(configured_timeout, max(0.001, remaining))


def _bounded_integer(value: object, minimum: int, maximum: int) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and minimum <= value <= maximum
    )


def _bounded_number(value: object, minimum: float, maximum: float) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and minimum <= value <= maximum
    )


def _validate_https_origin(value: object, error_code: str) -> str:
    if not isinstance(value, str) or len(value) > 2048:
        raise HostedAdapterError(error_code)
    parsed = urlparse(value)
    if (
        parsed.scheme.casefold() != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise HostedAdapterError(error_code)
    try:
        port = parsed.port
    except ValueError:
        raise HostedAdapterError(error_code) from None
    hostname = parsed.hostname
    if not hostname:
        raise HostedAdapterError(error_code)
    if ":" in hostname:
        hostname = f"[{hostname.casefold()}]"
    else:
        hostname = hostname.casefold()
    if port is not None and port < 1:
        raise HostedAdapterError(error_code)
    normalized_port = "" if port in {None, 443} else f":{port}"
    return f"https://{hostname}{normalized_port}"


def _safe_request(
    client: HttpClient,
    method: str,
    url: str,
    *,
    headers: Mapping[str, str],
    body: HttpRequestBody,
    timeout_seconds: float,
) -> HttpResponse:
    try:
        return client.request(
            method,
            url,
            headers=headers,
            body=body,
            timeout_seconds=timeout_seconds,
        )
    except HostedTransportError:
        raise
    except Exception:
        raise HostedTransportError() from None


def _access_headers(config: HostedAdapterConfig) -> dict[str, str]:
    return {
        "CF-Access-Client-Id": config.access_client_id,
        "CF-Access-Client-Secret": config.access_client_secret,
    }


def _capability_headers(capability: str | None) -> dict[str, str]:
    return {_CAPABILITY_HEADER: capability} if capability is not None else {}


def _header(headers: Mapping[str, str], name: str) -> str | None:
    expected = name.casefold()
    for key, value in headers.items():
        if key.casefold() == expected:
            return value
    return None


def _content_length(headers: Mapping[str, str]) -> int | None:
    value = _header(headers, "Content-Length")
    if value is None:
        return None
    if not value.isascii() or not value.isdecimal():
        raise ValueError("invalid_content_length")
    parsed = int(value)
    if parsed < 0:
        raise ValueError("invalid_content_length")
    return parsed


def _read_bounded(response: HttpResponse, maximum_bytes: int) -> bytes:
    try:
        declared_size = _content_length(response.headers)
    except ValueError:
        raise HostedAdapterError("invalid_claim_response") from None
    if declared_size is not None and declared_size > maximum_bytes:
        raise HostedAdapterError("claim_response_too_large")
    try:
        body = response.body.read(maximum_bytes + 1)
    except Exception:
        raise HostedAdapterError("claim_response_unreadable") from None
    if len(body) > maximum_bytes:
        raise HostedAdapterError("claim_response_too_large")
    if declared_size is not None and len(body) != declared_size:
        raise HostedAdapterError("invalid_claim_response")
    return body


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


def _parse_claim_body(body: bytes) -> object:
    try:
        return json.loads(
            body.decode("utf-8"),
            object_pairs_hook=_unique_json_object,
            parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise HostedAdapterError("invalid_claim_response") from None


def _claim_one_job(
    config: HostedAdapterConfig,
    client: HttpClient,
    budget: _ProcessingBudget,
) -> HostedJobClaim | None:
    # Claim has a leasing side effect. A lost response must not cause this
    # invocation to claim a second job, so this request deliberately has no retry.
    headers = {
        **_access_headers(config),
        "Accept": "application/json",
        "Accept-Encoding": "identity",
        "Authorization": f"Bearer {config.processor_token}",
        "Cache-Control": "no-store",
        "Content-Length": "0",
        "User-Agent": "music-library-audio-processor/1",
    }
    try:
        response = _safe_request(
            client,
            "POST",
            config.claim_url,
            headers=headers,
            body=b"",
            timeout_seconds=budget.request_timeout(config.request_timeout_seconds),
        )
        budget.ensure_remaining()
    except _JobFailure as error:
        raise HostedAdapterError(error.code) from None
    except HostedTransportError:
        raise HostedAdapterError("claim_delivery_failed") from None

    with response:
        if response.status == 204:
            return None
        if 300 <= response.status < 400:
            raise HostedAdapterError("claim_redirect_rejected")
        if response.status != 200:
            raise HostedAdapterError("claim_rejected")
        content_type = _header(response.headers, "Content-Type")
        if content_type is None or content_type.partition(";")[0].strip().casefold() != "application/json":
            raise HostedAdapterError("invalid_claim_response")
        body = _read_bounded(response, config.max_claim_body_bytes)
        try:
            budget.ensure_remaining()
        except _JobFailure as error:
            raise HostedAdapterError(error.code) from None

    try:
        claim = parse_hosted_job_claim(
            _parse_claim_body(body),
            allowed_transfer_origins=config.allowed_transfer_origins,
            expected_callback_origin=config.worker_base_url,
        )
    except HostedContractError as error:
        raise HostedAdapterError(error.code) from None
    _validate_worker_capability_routes(claim)
    return claim


def _validate_worker_capability_routes(claim: HostedJobClaim) -> None:
    request = claim.processing_request
    routes = (
        (request.source_download_url, "source"),
        (request.derivative_upload_url, "derivative"),
        (claim.result_url, "result"),
        (claim.failure_url, "failure"),
    )
    for url, operation in routes:
        parsed = urlparse(url)
        expected_path = f"/api/processing/jobs/{request.job_id}/{operation}"
        try:
            query = parse_qsl(
                parsed.query,
                keep_blank_values=True,
                strict_parsing=True,
            )
        except ValueError:
            raise HostedAdapterError("invalid_job_capability_route") from None
        if parsed.path != expected_path:
            raise HostedAdapterError("invalid_job_capability_route")
        if claim.schema_version == 1:
            if len(query) != 1 or query[0][0] != "token" or not query[0][1]:
                raise HostedAdapterError("invalid_job_capability_route")
        elif query:
            raise HostedAdapterError("invalid_job_capability_route")


def _clock_now(clock: Callable[[], datetime]) -> datetime:
    try:
        now = clock()
    except Exception:
        raise HostedAdapterError("invalid_adapter_clock") from None
    if not isinstance(now, datetime) or now.utcoffset() is None:
        raise HostedAdapterError("invalid_adapter_clock")
    return now.astimezone(timezone.utc)


def _download_source(
    config: HostedAdapterConfig,
    client: HttpClient,
    claim: HostedJobClaim,
    destination: Path,
    budget: _ProcessingBudget,
) -> None:
    budget.ensure_remaining()
    expected_size = claim.processing_request.source_byte_size
    if expected_size > config.max_source_bytes:
        raise _JobFailure("source_too_large")
    try:
        response = _safe_request(
            client,
            "GET",
            claim.processing_request.source_download_url,
            headers={
                **_access_headers(config),
                **_capability_headers(claim.processing_request.source_capability),
                "Accept": "application/octet-stream",
                "Accept-Encoding": "identity",
                "Cache-Control": "no-store",
                "User-Agent": "music-library-audio-processor/1",
            },
            body=None,
            timeout_seconds=budget.request_timeout(config.request_timeout_seconds),
        )
    except HostedTransportError:
        budget.ensure_remaining()
        raise _JobFailure("source_download_failed") from None

    with response:
        if 300 <= response.status < 400:
            raise _JobFailure("source_redirect_rejected")
        if response.status != 200:
            raise _JobFailure("source_download_failed")
        content_encoding = _header(response.headers, "Content-Encoding")
        if content_encoding is not None and content_encoding.casefold() != "identity":
            raise _JobFailure("source_content_encoding_rejected")
        try:
            declared_size = _content_length(response.headers)
        except ValueError:
            raise _JobFailure("invalid_source_content_length") from None
        if declared_size != expected_size:
            raise _JobFailure("source_size_mismatch")

        digest = hashlib.sha256()
        received = 0
        try:
            with destination.open("xb") as output:
                os.chmod(destination, 0o600)
                while True:
                    budget.ensure_remaining()
                    chunk = response.body.read(_TRANSFER_CHUNK_BYTES)
                    if not chunk:
                        break
                    received += len(chunk)
                    if received > expected_size:
                        raise _JobFailure("source_size_overflow")
                    output.write(chunk)
                    digest.update(chunk)
                output.flush()
                os.fsync(output.fileno())
                budget.ensure_remaining()
        except _JobFailure:
            raise
        except Exception:
            raise _JobFailure("source_download_failed") from None

    if received != expected_size:
        raise _JobFailure("source_size_truncated")
    if digest.hexdigest() != claim.processing_request.source_sha256:
        raise _JobFailure("source_hash_mismatch")


def _retryable_status(status: int, *, include_conflict: bool) -> bool:
    return (
        status in _RETRYABLE_HTTP_STATUSES
        or (include_conflict and status == 409)
        or 500 <= status <= 599
    )


def _pause_before_retry(
    config: HostedAdapterConfig,
    sleeper: Callable[[float], None],
    budget: _ProcessingBudget | None = None,
) -> None:
    if config.retry_delay_seconds:
        if budget is not None:
            budget.ensure_remaining()
            if config.retry_delay_seconds >= budget.remaining_seconds():
                raise _JobFailure("processing_deadline_exceeded")
        try:
            sleeper(config.retry_delay_seconds)
        except Exception:
            raise HostedAdapterError("retry_pause_failed") from None
        if budget is not None:
            budget.ensure_remaining()


def _upload_derivative(
    config: HostedAdapterConfig,
    client: HttpClient,
    claim: HostedJobClaim,
    path: Path,
    preparation: PreparationResult,
    sleeper: Callable[[float], None],
    budget: _ProcessingBudget,
) -> None:
    budget.ensure_remaining()
    derivative = preparation.derivative
    if derivative is None or not path.is_file():
        raise _JobFailure("verified_derivative_missing")
    try:
        actual_size = path.stat().st_size
        actual_hash = sha256_file(path, checkpoint=budget.ensure_remaining)
    except OSError:
        raise _JobFailure("verified_derivative_unreadable") from None
    if actual_size != derivative.byte_size or actual_hash != derivative.sha256:
        raise _JobFailure("verified_derivative_changed")
    if actual_size < 1 or actual_size > config.max_derivative_bytes:
        raise _JobFailure("derivative_too_large")

    headers = {
        **_access_headers(config),
        **_capability_headers(claim.processing_request.derivative_capability),
        "Accept": "application/json",
        "Accept-Encoding": "identity",
        "Cache-Control": "no-store",
        "Content-Length": str(actual_size),
        "Content-Type": "audio/mpeg",
        "User-Agent": "music-library-audio-processor/1",
    }
    for attempt in range(config.retry_attempts):
        try:
            response = _safe_request(
                client,
                "PUT",
                claim.processing_request.derivative_upload_url,
                headers=headers,
                body=path,
                timeout_seconds=budget.request_timeout(config.request_timeout_seconds),
            )
        except HostedTransportError:
            budget.ensure_remaining()
            if attempt + 1 < config.retry_attempts:
                _pause_before_retry(config, sleeper, budget)
                continue
            raise _JobFailure("derivative_upload_failed") from None
        with response:
            if response.status in {201, 204}:
                return
            if 300 <= response.status < 400:
                raise _JobFailure("derivative_redirect_rejected")
            if (
                attempt + 1 < config.retry_attempts
                and _retryable_status(response.status, include_conflict=False)
            ):
                _pause_before_retry(config, sleeper, budget)
                continue
            raise _JobFailure("derivative_upload_failed")


def _safe_processing_error_code(error: Exception) -> str:
    if isinstance(error, (PreparationError, MediaToolError)):
        code = error.code
        if SAFE_FAILURE_CODE.fullmatch(code):
            return code
    if isinstance(error, HostedContractError):
        return "invalid_processing_result"
    if isinstance(error, OSError):
        return "audio_processing_io_failed"
    return "audio_preparation_failed"


def _default_tools_factory(
    config: HostedAdapterConfig,
    budget: _ProcessingBudget,
) -> AudioTools:
    tools = FFmpegTools(
        deadline=budget.deadline,
        max_generated_output_bytes=config.max_generated_output_bytes,
        monotonic=budget.monotonic,
    )
    tools.require_available()
    return tools


def _prepare_callback(
    config: HostedAdapterConfig,
    client: HttpClient,
    claim: HostedJobClaim,
    directory: Path,
    tools_factory: Callable[[], AudioTools] | None,
    sleeper: Callable[[float], None],
    budget: _ProcessingBudget,
) -> _PreparedCallback:
    source_path = directory / "source.bin"
    derivative_path = directory / "playback.mp3"
    _download_source(config, client, claim, source_path, budget)

    try:
        validate_output_path(derivative_path)
        budget.ensure_remaining()
        tools = (
            tools_factory()
            if tools_factory is not None
            else _default_tools_factory(config, budget)
        )
        preparation = prepare(
            tools,
            source_path,
            output=derivative_path,
            execute=True,
            checkpoint=budget.ensure_remaining,
            max_generated_output_bytes=config.max_generated_output_bytes,
        )
        result = build_hosted_processing_result(
            claim.processing_request,
            preparation,
        )
        if result.get("playbackKind") == "derivative":
            _upload_derivative(
                config,
                client,
                claim,
                derivative_path,
                preparation,
                sleeper,
                budget,
            )
        elif result.get("playbackKind") != "original":
            raise HostedContractError("invalid_processing_playback_kind")
        body = json.dumps(
            result,
            ensure_ascii=True,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
    except _JobFailure:
        raise
    except Exception as error:
        raise _JobFailure(_safe_processing_error_code(error)) from None

    if not body or len(body) > config.max_callback_body_bytes:
        raise _JobFailure("processing_result_too_large")
    return _PreparedCallback(body=body, playback_kind=str(result["playbackKind"]))


def _deliver_callback(
    config: HostedAdapterConfig,
    client: HttpClient,
    *,
    url: str,
    capability: str | None,
    body: bytes,
    operation: str,
    include_conflict: bool,
    sleeper: Callable[[float], None],
    budget: _ProcessingBudget | None = None,
) -> None:
    headers = {
        **_access_headers(config),
        **_capability_headers(capability),
        "Accept": "application/json",
        "Accept-Encoding": "identity",
        "Authorization": f"Bearer {config.processor_token}",
        "Cache-Control": "no-store",
        "Content-Length": str(len(body)),
        "Content-Type": "application/json",
        "User-Agent": "music-library-audio-processor/1",
    }
    for attempt in range(config.retry_attempts):
        try:
            if budget is not None:
                budget.ensure_remaining()
            response = _safe_request(
                client,
                "POST",
                url,
                headers=headers,
                body=body,
                timeout_seconds=(
                    budget.request_timeout(config.request_timeout_seconds)
                    if budget is not None
                    else config.request_timeout_seconds
                ),
            )
        except _JobFailure:
            raise HostedAdapterError(f"{operation}_delivery_ambiguous") from None
        except HostedTransportError:
            if budget is not None:
                try:
                    budget.ensure_remaining()
                except _JobFailure:
                    raise HostedAdapterError(
                        f"{operation}_delivery_ambiguous"
                    ) from None
            if attempt + 1 < config.retry_attempts:
                try:
                    _pause_before_retry(config, sleeper, budget)
                except _JobFailure:
                    raise HostedAdapterError(
                        f"{operation}_delivery_ambiguous"
                    ) from None
                continue
            raise HostedAdapterError(f"{operation}_delivery_ambiguous") from None
        with response:
            if response.status == 200:
                return
            if 300 <= response.status < 400:
                raise HostedAdapterError(f"{operation}_redirect_rejected")
            if (
                attempt + 1 < config.retry_attempts
                and _retryable_status(
                    response.status,
                    include_conflict=include_conflict,
                )
            ):
                try:
                    _pause_before_retry(config, sleeper, budget)
                except _JobFailure:
                    raise HostedAdapterError(
                        f"{operation}_delivery_ambiguous"
                    ) from None
                continue
            if _retryable_status(
                response.status,
                include_conflict=include_conflict,
            ):
                raise HostedAdapterError(f"{operation}_delivery_ambiguous")
            raise HostedAdapterError(f"{operation}_delivery_rejected")


def _report_failure(
    config: HostedAdapterConfig,
    client: HttpClient,
    claim: HostedJobClaim,
    code: str,
    sleeper: Callable[[float], None],
) -> HostedRunOutcome:
    if not SAFE_FAILURE_CODE.fullmatch(code):
        code = "audio_processing_failed"
    body = json.dumps(
        {"errorCode": code},
        ensure_ascii=True,
        separators=(",", ":"),
    ).encode("utf-8")
    if len(body) > config.max_callback_body_bytes:
        raise HostedAdapterError("failure_body_too_large")
    _deliver_callback(
        config,
        client,
        url=claim.failure_url,
        capability=claim.failure_capability,
        body=body,
        operation="failure",
        include_conflict=False,
        sleeper=sleeper,
    )
    return HostedRunOutcome(
        status="failed",
        error_code=code,
        failure_reported=True,
    )


def run_hosted_job_once(
    config: HostedAdapterConfig,
    *,
    client: HttpClient | None = None,
    tools_factory: Callable[[], AudioTools] | None = None,
    clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    monotonic: Callable[[], float] = time.monotonic,
    sleeper: Callable[[float], None] = time.sleep,
) -> HostedRunOutcome:
    http_client = client or UrllibHttpClient()
    budget = _ProcessingBudget.start(config.processing_deadline_seconds, monotonic)
    claim = _claim_one_job(config, http_client, budget)
    if claim is None:
        return HostedRunOutcome(status="no_work")

    remaining_lease = (
        claim.lease_expires_at.astimezone(timezone.utc) - _clock_now(clock)
    ).total_seconds()
    if remaining_lease < config.minimum_lease_remaining_seconds:
        raise HostedAdapterError("job_claim_lease_too_short")

    try:
        with tempfile.TemporaryDirectory(
            prefix="music-audio-job-",
            dir=config.temporary_root,
        ) as raw_directory:
            directory = Path(raw_directory)
            os.chmod(directory, 0o700)
            callback = _prepare_callback(
                config,
                http_client,
                claim,
                directory,
                tools_factory,
                sleeper,
                budget,
            )
    except _JobFailure as error:
        return _report_failure(
            config,
            http_client,
            claim,
            error.code,
            sleeper,
        )
    except Exception:
        return _report_failure(
            config,
            http_client,
            claim,
            "temporary_storage_failed",
            sleeper,
        )

    try:
        budget.ensure_remaining()
    except _JobFailure as error:
        return _report_failure(
            config,
            http_client,
            claim,
            error.code,
            sleeper,
        )

    # Result delivery is outside the processing-failure handler. A lost callback
    # response may mean success already committed, so never follow it with failure.
    _deliver_callback(
        config,
        http_client,
        url=claim.result_url,
        capability=claim.result_capability,
        body=callback.body,
        operation="result",
        include_conflict=True,
        sleeper=sleeper,
        budget=budget,
    )
    return HostedRunOutcome(
        status="succeeded",
        playback_kind=callback.playback_kind,
    )
