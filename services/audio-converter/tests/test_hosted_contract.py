from __future__ import annotations

import unittest

from audio_converter.hosted_contract import (
    HostedContractError,
    build_hosted_processing_result,
    parse_hosted_processing_request,
)
from audio_converter.models import Decision, DecisionKind, DerivativeValidation
from audio_converter.service import FileSummary, PreparationResult


SOURCE_HASH = "a" * 64
DERIVATIVE_HASH = "b" * 64


def request_payload() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "jobId": "job_opaque-123",
        "policyId": "mp3-v1-libmp3lame-q2",
        "sourceSha256": SOURCE_HASH,
        "sourceByteSize": 100,
        "sourceDownloadUrl": "https://transfer.invalid/source?token=short-lived",
        "derivativeUploadUrl": "https://transfer.invalid/derivative?token=short-lived",
    }


def summary(sha256: str, byte_size: int, codec: str = "mp3") -> FileSummary:
    return FileSummary(
        sha256=sha256,
        byte_size=byte_size,
        codec=codec,
        containers=(codec,),
        duration_seconds=10.0,
        bit_rate=128_000,
        sample_rate=44_100,
        channels=2,
        had_decode_warnings=False,
    )


class HostedContractTests(unittest.TestCase):
    def test_parses_strict_versioned_job_scoped_request(self) -> None:
        parsed = parse_hosted_processing_request(request_payload())

        self.assertEqual(parsed.job_id, "job_opaque-123")
        self.assertEqual(parsed.source_sha256, SOURCE_HASH)
        self.assertEqual(parsed.source_byte_size, 100)

    def test_rejects_unknown_fields_and_non_https_transfer_urls(self) -> None:
        extra = request_payload()
        extra["recordingTitle"] = "private"
        with self.assertRaisesRegex(HostedContractError, "invalid_processing_request_fields"):
            parse_hosted_processing_request(extra)

        insecure = request_payload()
        insecure["sourceDownloadUrl"] = "http://transfer.invalid/source"
        with self.assertRaisesRegex(HostedContractError, "invalid_source_download_url"):
            parse_hosted_processing_request(insecure)

    def test_rejects_stale_policy_and_invalid_expected_source(self) -> None:
        stale = request_payload()
        stale["policyId"] = "mp3-v0"
        with self.assertRaisesRegex(HostedContractError, "unsupported_processing_policy"):
            parse_hosted_processing_request(stale)

        invalid_hash = request_payload()
        invalid_hash["sourceSha256"] = "A" * 64
        with self.assertRaisesRegex(HostedContractError, "invalid_source_sha256"):
            parse_hosted_processing_request(invalid_hash)

    def test_builds_verified_derivative_result_without_transfer_urls(self) -> None:
        request = parse_hosted_processing_request(request_payload())
        result = build_hosted_processing_result(
            request,
            PreparationResult(
                status="created_derivative",
                decision=Decision(DecisionKind.REQUIRE_DERIVATIVE, "non_mp3_source"),
                original=summary(SOURCE_HASH, 100, "aac"),
                derivative=summary(DERIVATIVE_HASH, 60),
                validation=DerivativeValidation(True, "accepted"),
            ),
        )

        self.assertEqual(result["playbackKind"], "derivative")
        self.assertNotIn("sourceDownloadUrl", result)
        self.assertNotIn("derivativeUploadUrl", result)

    def test_builds_direct_original_result(self) -> None:
        request = parse_hosted_processing_request(request_payload())
        result = build_hosted_processing_result(
            request,
            PreparationResult(
                status="original_is_playback",
                decision=Decision(DecisionKind.USE_ORIGINAL, "canonical_mp3"),
                original=summary(SOURCE_HASH, 100),
            ),
        )

        self.assertEqual(result["playbackKind"], "original")
        self.assertIsNone(result["derivative"])

    def test_rejects_source_mismatch_and_unverified_derivative(self) -> None:
        request = parse_hosted_processing_request(request_payload())
        mismatched = PreparationResult(
            status="original_is_playback",
            decision=Decision(DecisionKind.USE_ORIGINAL, "canonical_mp3"),
            original=summary("c" * 64, 100),
        )
        with self.assertRaisesRegex(HostedContractError, "processed_source_hash_mismatch"):
            build_hosted_processing_result(request, mismatched)

        unverified = PreparationResult(
            status="created_derivative",
            decision=Decision(DecisionKind.REQUIRE_DERIVATIVE, "non_mp3_source"),
            original=summary(SOURCE_HASH, 100, "aac"),
            derivative=summary(DERIVATIVE_HASH, 60),
            validation=DerivativeValidation(False, "duration_mismatch"),
        )
        with self.assertRaisesRegex(HostedContractError, "unverified_processing_derivative"):
            build_hosted_processing_result(request, unverified)


if __name__ == "__main__":
    unittest.main()
