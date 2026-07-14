from __future__ import annotations

import hashlib
import json
import os
import stat
import tempfile
import unittest
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.message import Message
from io import BytesIO
from pathlib import Path
from urllib.error import HTTPError
from unittest.mock import patch

from audio_converter.hosted_adapter import (
    HostedAdapterConfig,
    HostedAdapterError,
    HostedTransportError,
    HttpRequestBody,
    HttpResponse,
    UrllibHttpClient,
    run_hosted_job_once,
)
from audio_converter.models import (
    AudioInfo,
    DecodeResult,
    Decision,
    DecisionKind,
    DerivativeValidation,
)
from audio_converter.service import FileSummary, PreparationResult
from audio_converter.tools import MediaToolError


WORKER_ORIGIN = "https://worker.invalid"
OTHER_ORIGIN = "https://other.invalid"
PROCESSOR_TOKEN = "processor-secret-with-at-least-32-characters"
JOB_ID = "job_opaque-123"
SOURCE_URL = f"{WORKER_ORIGIN}/api/processing/jobs/{JOB_ID}/source?token=source-capability"
DERIVATIVE_URL = (
    f"{WORKER_ORIGIN}/api/processing/jobs/{JOB_ID}/derivative?token=derivative-capability"
)
RESULT_URL = f"{WORKER_ORIGIN}/api/processing/jobs/{JOB_ID}/result?token=result-capability"
FAILURE_URL = f"{WORKER_ORIGIN}/api/processing/jobs/{JOB_ID}/failure?token=failure-capability"
SOURCE = b"original"


@dataclass(frozen=True)
class ResponseSpec:
    status: int
    body: bytes = b""
    headers: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class RequestRecord:
    method: str
    url: str
    headers: dict[str, str]
    body: bytes | None = field(repr=False)


class FakeHttpClient:
    def __init__(self, responses: list[ResponseSpec | Exception]) -> None:
        self.responses = list(responses)
        self.requests: list[RequestRecord] = []

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str],
        body: HttpRequestBody,
        timeout_seconds: float,
    ) -> HttpResponse:
        if isinstance(body, Path):
            recorded_body = body.read_bytes()
        else:
            recorded_body = body
        self.requests.append(
            RequestRecord(method, url, dict(headers), recorded_body)
        )
        if not self.responses:
            raise AssertionError("unexpected_http_request")
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return HttpResponse(
            status=response.status,
            headers=response.headers,
            body=BytesIO(response.body),
        )


class FakeOpenerResponse(BytesIO):
    def __init__(self, status: int, body: bytes = b"") -> None:
        super().__init__(body)
        self.status = status
        self.headers = Message()


class CapturingOpener:
    def __init__(self, response: FakeOpenerResponse | Exception) -> None:
        self.response = response
        self.request_body: bytes | None = None

    def open(self, request: object, *, timeout: float) -> FakeOpenerResponse:
        request_body = getattr(request, "data")
        if hasattr(request_body, "read"):
            self.request_body = request_body.read()
        else:
            self.request_body = request_body
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


class FakeTools:
    def __init__(
        self,
        *,
        source_codec: str,
        derivative_bytes: bytes = b"dddd",
        transcode_error: MediaToolError | None = None,
    ) -> None:
        self.source_codec = source_codec
        self.derivative_bytes = derivative_bytes
        self.transcode_error = transcode_error
        self.transcodes = 0
        self.source_mode: int | None = None
        self.directory_mode: int | None = None

    def probe(self, source: Path) -> AudioInfo:
        is_source = source.name == "source.bin"
        if is_source:
            self.source_mode = stat.S_IMODE(source.stat().st_mode)
            self.directory_mode = stat.S_IMODE(source.parent.stat().st_mode)
        codec = self.source_codec if is_source else "mp3"
        containers = ("mp3",) if codec == "mp3" else ("mp4",)
        return AudioInfo(
            container_names=containers,
            codec_name=codec,
            duration_seconds=10.0,
            byte_size=source.stat().st_size,
            bit_rate=128_000,
            sample_rate=44_100,
            channels=2,
            stream_index=0,
        )

    def decode_check(
        self,
        source: Path,
        stream_index: int,
        *,
        strict: bool,
    ) -> DecodeResult:
        return DecodeResult(duration_seconds=10.0, had_recoverable_errors=False)

    def transcode(
        self,
        source: Path,
        output: Path,
        source_info: AudioInfo,
    ) -> None:
        self.transcodes += 1
        if self.transcode_error is not None:
            raise self.transcode_error
        output.write_bytes(self.derivative_bytes)


def processing_request(
    source: bytes = SOURCE,
    **overrides: object,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "schemaVersion": 1,
        "jobId": JOB_ID,
        "policyId": "mp3-v1-libmp3lame-q2",
        "sourceSha256": hashlib.sha256(source).hexdigest(),
        "sourceByteSize": len(source),
        "sourceDownloadUrl": SOURCE_URL,
        "derivativeUploadUrl": DERIVATIVE_URL,
    }
    payload.update(overrides)
    return payload


def claim_payload(
    source: bytes = SOURCE,
    **processing_overrides: object,
) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "leaseExpiresAt": "2099-01-01T00:00:00.000Z",
        "processingRequest": processing_request(source, **processing_overrides),
        "resultUrl": RESULT_URL,
        "failureUrl": FAILURE_URL,
    }


def claim_response(
    source: bytes = SOURCE,
    **processing_overrides: object,
) -> ResponseSpec:
    body = json.dumps(
        claim_payload(source, **processing_overrides),
        separators=(",", ":"),
    ).encode()
    return ResponseSpec(
        200,
        body,
        {
            "Content-Type": "application/json; charset=UTF-8",
            "Content-Length": str(len(body)),
        },
    )


def source_response(
    body: bytes = SOURCE,
    *,
    content_length: int | None = None,
) -> ResponseSpec:
    length = len(body) if content_length is None else content_length
    return ResponseSpec(
        200,
        body,
        {
            "Content-Type": "application/octet-stream",
            "Content-Length": str(length),
        },
    )


def config(root: Path, **overrides: object) -> HostedAdapterConfig:
    values: dict[str, object] = {
        "worker_base_url": WORKER_ORIGIN,
        "processor_token": PROCESSOR_TOKEN,
        "allowed_transfer_origins": frozenset({WORKER_ORIGIN}),
        "temporary_root": root,
        "retry_delay_seconds": 0,
    }
    values.update(overrides)
    return HostedAdapterConfig(**values)  # type: ignore[arg-type]


def fixed_clock() -> datetime:
    return datetime(2026, 7, 14, tzinfo=timezone.utc)


def failure_code(request: RequestRecord) -> str:
    assert request.body is not None
    return str(json.loads(request.body)["errorCode"])


class HostedAdapterTests(unittest.TestCase):
    def test_processes_direct_original_and_cleans_private_temporary_files(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            client = FakeHttpClient([
                claim_response(),
                source_response(),
                ResponseSpec(200),
            ])
            tools = FakeTools(source_codec="mp3")

            outcome = run_hosted_job_once(
                config(root),
                client=client,
                tools_factory=lambda: tools,
                clock=fixed_clock,
            )

            self.assertEqual(outcome.status, "succeeded")
            self.assertEqual(outcome.playback_kind, "original")
            self.assertEqual(tools.transcodes, 0)
            self.assertEqual(tools.source_mode, 0o600)
            self.assertEqual(tools.directory_mode, 0o700)
            self.assertEqual([request.method for request in client.requests], ["POST", "GET", "POST"])
            self.assertEqual(client.requests[0].url, f"{WORKER_ORIGIN}/api/processing/jobs/claim")
            self.assertEqual(client.requests[0].headers["Authorization"], f"Bearer {PROCESSOR_TOKEN}")
            self.assertNotIn("Authorization", client.requests[1].headers)
            self.assertEqual(client.requests[2].headers["Authorization"], f"Bearer {PROCESSOR_TOKEN}")
            result = json.loads(client.requests[2].body or b"")
            self.assertEqual(result["playbackKind"], "original")
            self.assertNotIn("sourceDownloadUrl", result)
            self.assertEqual(list(root.iterdir()), [])
            self.assertEqual(client.responses, [])

    def test_uploads_only_verified_derivative_with_exact_length(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            client = FakeHttpClient([
                claim_response(),
                source_response(),
                ResponseSpec(201),
                ResponseSpec(200),
            ])
            tools = FakeTools(source_codec="aac", derivative_bytes=b"verified-mp3")

            outcome = run_hosted_job_once(
                config(root),
                client=client,
                tools_factory=lambda: tools,
                clock=fixed_clock,
            )

            self.assertEqual(outcome.playback_kind, "derivative")
            self.assertEqual([request.method for request in client.requests], ["POST", "GET", "PUT", "POST"])
            upload = client.requests[2]
            self.assertEqual(upload.body, b"verified-mp3")
            self.assertEqual(upload.headers["Content-Length"], str(len(b"verified-mp3")))
            self.assertEqual(upload.headers["Content-Type"], "audio/mpeg")
            self.assertNotIn("Authorization", upload.headers)
            result = json.loads(client.requests[3].body or b"")
            self.assertEqual(result["derivative"]["sha256"], hashlib.sha256(b"verified-mp3").hexdigest())
            self.assertEqual(list(root.iterdir()), [])

    def test_accepts_create_only_derivative_replay(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            client = FakeHttpClient([
                claim_response(),
                source_response(),
                ResponseSpec(204),
                ResponseSpec(200),
            ])

            outcome = run_hosted_job_once(
                config(Path(raw_root)),
                client=client,
                tools_factory=lambda: FakeTools(source_codec="aac"),
                clock=fixed_clock,
            )

            self.assertEqual(outcome.status, "succeeded")
            self.assertEqual(outcome.playback_kind, "derivative")

    def test_reports_discarded_oversized_candidate_as_direct_original(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            client = FakeHttpClient([
                claim_response(),
                source_response(),
                ResponseSpec(200),
            ])
            preparation = PreparationResult(
                status="candidate_discarded_original_is_playback",
                decision=Decision(
                    DecisionKind.TRY_OVERSIZED_MP3_DERIVATIVE,
                    "oversized_high_bitrate_mp3",
                ),
                original=FileSummary(
                    sha256=hashlib.sha256(SOURCE).hexdigest(),
                    byte_size=len(SOURCE),
                    codec="mp3",
                    containers=("mp3",),
                    duration_seconds=10.0,
                    bit_rate=320_000,
                    sample_rate=44_100,
                    channels=2,
                    had_decode_warnings=False,
                ),
                validation=DerivativeValidation(
                    False,
                    "oversized_mp3_saving_not_material",
                    0.1,
                ),
            )

            with patch(
                "audio_converter.hosted_adapter.prepare",
                return_value=preparation,
            ):
                outcome = run_hosted_job_once(
                    config(Path(raw_root)),
                    client=client,
                    tools_factory=lambda: FakeTools(source_codec="mp3"),
                    clock=fixed_clock,
                )

            self.assertEqual(outcome.playback_kind, "original")
            self.assertNotIn("PUT", [request.method for request in client.requests])
            result = json.loads(client.requests[-1].body or b"")
            self.assertEqual(
                result["status"],
                "candidate_discarded_original_is_playback",
            )

    def test_claim_204_is_successful_no_work(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            client = FakeHttpClient([ResponseSpec(204)])

            outcome = run_hosted_job_once(
                config(Path(raw_root)),
                client=client,
                clock=fixed_clock,
            )

            self.assertEqual(outcome.status, "no_work")
            self.assertEqual(len(client.requests), 1)

    def test_rejects_weak_auth_and_unallowlisted_transfer_before_fetch(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            with self.assertRaisesRegex(HostedAdapterError, "invalid_processor_token"):
                config(Path(raw_root), processor_token="too-short")

            untrusted_claim = claim_response(
                sourceDownloadUrl=(
                    f"{OTHER_ORIGIN}/api/processing/jobs/{JOB_ID}/source?token=capability"
                )
            )
            client = FakeHttpClient([untrusted_claim])
            with self.assertRaisesRegex(HostedAdapterError, "untrusted_source_download_url"):
                run_hosted_job_once(
                    config(Path(raw_root)),
                    client=client,
                    clock=fixed_clock,
                )
            self.assertEqual(len(client.requests), 1)

    def test_rejects_unbounded_or_mistyped_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            invalid_cases = (
                ("request_timeout_seconds", 0),
                ("request_timeout_seconds", "60"),
                ("max_claim_body_bytes", True),
                ("max_source_bytes", 512 * 1024 * 1024 + 1),
                ("retry_attempts", 6),
                ("retry_delay_seconds", float("inf")),
            )
            for field_name, value in invalid_cases:
                with self.subTest(field_name=field_name, value=value):
                    with self.assertRaises(HostedAdapterError):
                        config(root, **{field_name: value})

            with self.assertRaisesRegex(HostedAdapterError, "invalid_temporary_root"):
                config(root / "missing")

    def test_claim_is_not_retried_after_transport_failure(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            client = FakeHttpClient([
                HostedTransportError(),
                claim_response(),
            ])

            with self.assertRaisesRegex(HostedAdapterError, "claim_delivery_failed"):
                run_hosted_job_once(
                    config(Path(raw_root)),
                    client=client,
                    clock=fixed_clock,
                )

            self.assertEqual(len(client.requests), 1)
            self.assertEqual(len(client.responses), 1)

    def test_rejects_redirects_for_every_operation(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)

            claim_client = FakeHttpClient([ResponseSpec(302)])
            with self.assertRaisesRegex(HostedAdapterError, "claim_redirect_rejected"):
                run_hosted_job_once(config(root), client=claim_client, clock=fixed_clock)

            source_client = FakeHttpClient([
                claim_response(),
                ResponseSpec(302),
                ResponseSpec(200),
            ])
            source_outcome = run_hosted_job_once(
                config(root),
                client=source_client,
                tools_factory=lambda: FakeTools(source_codec="mp3"),
                clock=fixed_clock,
            )
            self.assertEqual(source_outcome.error_code, "source_redirect_rejected")

            derivative_client = FakeHttpClient([
                claim_response(),
                source_response(),
                ResponseSpec(307),
                ResponseSpec(200),
            ])
            derivative_outcome = run_hosted_job_once(
                config(root),
                client=derivative_client,
                tools_factory=lambda: FakeTools(source_codec="aac"),
                clock=fixed_clock,
            )
            self.assertEqual(derivative_outcome.error_code, "derivative_redirect_rejected")

            result_client = FakeHttpClient([
                claim_response(),
                source_response(),
                ResponseSpec(308),
            ])
            with self.assertRaisesRegex(HostedAdapterError, "result_redirect_rejected"):
                run_hosted_job_once(
                    config(root),
                    client=result_client,
                    tools_factory=lambda: FakeTools(source_codec="mp3"),
                    clock=fixed_clock,
                )
            self.assertEqual([request.method for request in result_client.requests], ["POST", "GET", "POST"])

            failure_client = FakeHttpClient([
                claim_response(sourceSha256="0" * 64),
                source_response(),
                ResponseSpec(301),
            ])
            with self.assertRaisesRegex(HostedAdapterError, "failure_redirect_rejected"):
                run_hosted_job_once(
                    config(root),
                    client=failure_client,
                    tools_factory=lambda: FakeTools(source_codec="mp3"),
                    clock=fixed_clock,
                )

    def test_default_http_client_installs_redirect_rejection(self) -> None:
        with patch.dict(
            os.environ,
            {
                "HTTPS_PROXY": "http://proxy.invalid:8080",
                "https_proxy": "http://proxy.invalid:8080",
            },
        ):
            client = UrllibHttpClient()
        handler_names = {type(handler).__name__ for handler in client._opener.handlers}
        self.assertIn("_RejectRedirects", handler_names)
        self.assertNotIn("ProxyHandler", handler_names)

    def test_default_http_client_streams_file_and_surfaces_redirect_status(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            body_path = Path(raw_root) / "body.mp3"
            body_path.write_bytes(b"streamed")
            opener = CapturingOpener(FakeOpenerResponse(201))
            client = UrllibHttpClient(opener=opener)  # type: ignore[arg-type]

            with client.request(
                "PUT",
                DERIVATIVE_URL,
                headers={"Content-Length": "8"},
                body=body_path,
                timeout_seconds=10,
            ) as response:
                self.assertEqual(response.status, 201)
            self.assertEqual(opener.request_body, b"streamed")

            redirect = HTTPError(
                DERIVATIVE_URL,
                302,
                "Found",
                Message(),
                BytesIO(),
            )
            redirect_client = UrllibHttpClient(
                opener=CapturingOpener(redirect),  # type: ignore[arg-type]
            )
            with redirect_client.request(
                "PUT",
                DERIVATIVE_URL,
                headers={"Content-Length": "8"},
                body=body_path,
                timeout_seconds=10,
            ) as response:
                self.assertEqual(response.status, 302)

    def test_reports_truncation_overflow_and_hash_mismatch_safely(self) -> None:
        cases = (
            (
                claim_response(SOURCE + b"!"),
                source_response(SOURCE, content_length=len(SOURCE) + 1),
                "source_size_truncated",
            ),
            (
                claim_response(),
                source_response(SOURCE + b"!", content_length=len(SOURCE)),
                "source_size_overflow",
            ),
            (
                claim_response(sourceSha256="0" * 64),
                source_response(),
                "source_hash_mismatch",
            ),
        )
        for claim, source, expected_code in cases:
            with self.subTest(expected_code=expected_code):
                with tempfile.TemporaryDirectory() as raw_root:
                    root = Path(raw_root)
                    client = FakeHttpClient([claim, source, ResponseSpec(200)])

                    outcome = run_hosted_job_once(
                        config(root),
                        client=client,
                        tools_factory=lambda: FakeTools(source_codec="mp3"),
                        clock=fixed_clock,
                    )

                    self.assertEqual(outcome.status, "failed")
                    self.assertEqual(outcome.error_code, expected_code)
                    self.assertTrue(outcome.failure_reported)
                    self.assertEqual(failure_code(client.requests[-1]), expected_code)
                    self.assertEqual(list(root.iterdir()), [])

    def test_rejects_missing_source_length_and_oversized_claim_body(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            missing_length_client = FakeHttpClient([
                claim_response(),
                ResponseSpec(200, SOURCE, {"Content-Type": "application/octet-stream"}),
                ResponseSpec(200),
            ])

            outcome = run_hosted_job_once(
                config(root),
                client=missing_length_client,
                tools_factory=lambda: FakeTools(source_codec="mp3"),
                clock=fixed_clock,
            )
            self.assertEqual(outcome.error_code, "source_size_mismatch")

            oversized = claim_response()
            oversized_client = FakeHttpClient([oversized])
            with self.assertRaisesRegex(HostedAdapterError, "claim_response_too_large"):
                run_hosted_job_once(
                    config(root, max_claim_body_bytes=len(oversized.body) - 1),
                    client=oversized_client,
                    clock=fixed_clock,
                )

    def test_retries_create_only_upload_and_callbacks_only_within_bounds(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            client = FakeHttpClient([
                claim_response(),
                source_response(),
                HostedTransportError(),
                ResponseSpec(204),
                ResponseSpec(409),
                ResponseSpec(200),
            ])

            outcome = run_hosted_job_once(
                config(root),
                client=client,
                tools_factory=lambda: FakeTools(source_codec="aac"),
                clock=fixed_clock,
            )

            self.assertEqual(outcome.status, "succeeded")
            self.assertEqual([request.method for request in client.requests], ["POST", "GET", "PUT", "PUT", "POST", "POST"])
            self.assertEqual(client.requests[2].body, client.requests[3].body)
            self.assertEqual(client.requests[4].body, client.requests[5].body)

    def test_upload_exhaustion_posts_one_safe_failure(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            client = FakeHttpClient([
                claim_response(),
                source_response(),
                ResponseSpec(503),
                ResponseSpec(503),
                ResponseSpec(503),
                ResponseSpec(200),
            ])

            outcome = run_hosted_job_once(
                config(Path(raw_root)),
                client=client,
                tools_factory=lambda: FakeTools(source_codec="aac"),
                clock=fixed_clock,
            )

            self.assertEqual(outcome.error_code, "derivative_upload_failed")
            self.assertEqual([request.method for request in client.requests].count("PUT"), 3)
            self.assertEqual([request.url for request in client.requests].count(FAILURE_URL), 1)

    def test_result_delivery_exhaustion_is_ambiguous_and_never_posts_failure(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            client = FakeHttpClient([
                claim_response(),
                source_response(),
                ResponseSpec(503),
                ResponseSpec(503),
                ResponseSpec(503),
            ])

            with self.assertRaisesRegex(HostedAdapterError, "result_delivery_ambiguous"):
                run_hosted_job_once(
                    config(root),
                    client=client,
                    tools_factory=lambda: FakeTools(source_codec="mp3"),
                    clock=fixed_clock,
                )

            self.assertEqual([request.url for request in client.requests].count(RESULT_URL), 3)
            self.assertNotIn(FAILURE_URL, [request.url for request in client.requests])
            self.assertEqual(list(root.iterdir()), [])

    def test_failure_delivery_retries_and_reports_tool_code(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            client = FakeHttpClient([
                claim_response(),
                source_response(),
                ResponseSpec(503),
                ResponseSpec(200),
            ])
            tools = FakeTools(
                source_codec="aac",
                transcode_error=MediaToolError("conversion_failed", "conversion"),
            )

            outcome = run_hosted_job_once(
                config(root),
                client=client,
                tools_factory=lambda: tools,
                clock=fixed_clock,
            )

            self.assertEqual(outcome.error_code, "conversion_failed")
            self.assertEqual([request.url for request in client.requests].count(FAILURE_URL), 2)
            self.assertEqual(failure_code(client.requests[-1]), "conversion_failed")
            self.assertEqual(list(root.iterdir()), [])

    def test_failure_delivery_exhaustion_is_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            client = FakeHttpClient([
                claim_response(sourceSha256="0" * 64),
                source_response(),
                ResponseSpec(503),
                ResponseSpec(503),
                ResponseSpec(503),
            ])

            with self.assertRaisesRegex(HostedAdapterError, "failure_delivery_ambiguous"):
                run_hosted_job_once(
                    config(Path(raw_root)),
                    client=client,
                    tools_factory=lambda: FakeTools(source_codec="mp3"),
                    clock=fixed_clock,
                )

            self.assertEqual([request.url for request in client.requests].count(FAILURE_URL), 3)

    def test_rejects_expired_lease_without_using_capabilities(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            payload = claim_payload()
            payload["leaseExpiresAt"] = "2026-07-13T00:00:00.000Z"
            body = json.dumps(payload, separators=(",", ":")).encode()
            client = FakeHttpClient([
                ResponseSpec(
                    200,
                    body,
                    {"Content-Type": "application/json", "Content-Length": str(len(body))},
                )
            ])

            with self.assertRaisesRegex(HostedAdapterError, "job_claim_lease_too_short"):
                run_hosted_job_once(
                    config(Path(raw_root)),
                    client=client,
                    clock=fixed_clock,
                )
            self.assertEqual(len(client.requests), 1)

    def test_routine_objects_and_bodies_do_not_expose_secrets_or_paths(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            adapter_config = config(root)
            client = FakeHttpClient([
                claim_response(),
                source_response(),
                ResponseSpec(200),
            ])

            outcome = run_hosted_job_once(
                adapter_config,
                client=client,
                tools_factory=lambda: FakeTools(source_codec="mp3"),
                clock=fixed_clock,
            )

            routine_text = f"{adapter_config!r} {outcome!r}"
            for private_value in (
                PROCESSOR_TOKEN,
                "source-capability",
                "derivative-capability",
                "result-capability",
                "failure-capability",
                str(root),
            ):
                self.assertNotIn(private_value, routine_text)
                self.assertNotIn(private_value, (client.requests[-1].body or b"").decode())
            self.assertEqual(
                client.requests[-1].headers["Content-Length"],
                str(len(client.requests[-1].body or b"")),
            )


if __name__ == "__main__":
    unittest.main()
