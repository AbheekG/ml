from __future__ import annotations

import unittest

from audio_converter.hosted_contract import (
    HostedContractError,
    build_hosted_processing_result,
    parse_hosted_job_claim,
    parse_hosted_processing_request,
)
from audio_converter.models import Decision, DecisionKind, DerivativeValidation
from audio_converter.service import FileSummary, PreparationResult


SOURCE_HASH = "a" * 64
DERIVATIVE_HASH = "b" * 64
TRANSFER_ORIGINS = frozenset({"https://transfer.invalid"})
SOURCE_CAPABILITY = f"{'A' * 43}.{'a' * 64}"
DERIVATIVE_CAPABILITY = f"{'A' * 43}.{'b' * 64}"
RESULT_CAPABILITY = f"{'A' * 43}.{'c' * 64}"
FAILURE_CAPABILITY = f"{'A' * 43}.{'d' * 64}"


def request_payload() -> dict[str, object]:
    return {
        "schemaVersion": 2,
        "jobId": "job_opaque-123",
        "policyId": "mp3-v1-libmp3lame-q2",
        "sourceSha256": SOURCE_HASH,
        "sourceByteSize": 100,
        "sourceDownloadUrl": "https://transfer.invalid/source",
        "sourceCapability": SOURCE_CAPABILITY,
        "derivativeUploadUrl": "https://transfer.invalid/derivative",
        "derivativeCapability": DERIVATIVE_CAPABILITY,
    }


def claim_payload() -> dict[str, object]:
    return {
        "schemaVersion": 2,
        "leaseExpiresAt": "2099-01-01T00:00:00.000Z",
        "processingRequest": request_payload(),
        "resultUrl": "https://transfer.invalid/result",
        "resultCapability": RESULT_CAPABILITY,
        "failureUrl": "https://transfer.invalid/failure",
        "failureCapability": FAILURE_CAPABILITY,
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
        parsed = parse_hosted_processing_request(
            request_payload(), allowed_transfer_origins=TRANSFER_ORIGINS
        )

        self.assertEqual(parsed.job_id, "job_opaque-123")
        self.assertEqual(parsed.source_sha256, SOURCE_HASH)
        self.assertEqual(parsed.source_byte_size, 100)
        self.assertNotIn(SOURCE_CAPABILITY, repr(parsed))

    def test_parses_strict_claim_without_exposing_capabilities(self) -> None:
        claim = parse_hosted_job_claim(
            claim_payload(),
            allowed_transfer_origins=TRANSFER_ORIGINS,
            expected_callback_origin="https://transfer.invalid",
        )

        self.assertEqual(claim.processing_request.job_id, "job_opaque-123")
        self.assertEqual(claim.lease_expires_at.year, 2099)
        self.assertNotIn(RESULT_CAPABILITY, repr(claim))

    def test_parses_legacy_query_capabilities_for_safe_converter_first_rollout(self) -> None:
        request = request_payload()
        request["schemaVersion"] = 1
        request["sourceDownloadUrl"] = "https://transfer.invalid/source?token=legacy"
        request["derivativeUploadUrl"] = "https://transfer.invalid/derivative?token=legacy"
        request.pop("sourceCapability")
        request.pop("derivativeCapability")
        payload = claim_payload()
        payload["schemaVersion"] = 1
        payload["processingRequest"] = request
        payload["resultUrl"] = "https://transfer.invalid/result?token=legacy"
        payload["failureUrl"] = "https://transfer.invalid/failure?token=legacy"
        payload.pop("resultCapability")
        payload.pop("failureCapability")

        parsed = parse_hosted_job_claim(
            payload,
            allowed_transfer_origins=TRANSFER_ORIGINS,
            expected_callback_origin="https://transfer.invalid",
        )
        self.assertEqual(parsed.schema_version, 1)
        self.assertIsNone(parsed.processing_request.source_capability)

    def test_rejects_invalid_claim_callback_and_overlapping_resource(self) -> None:
        unexpected_origin = claim_payload()
        unexpected_origin["resultUrl"] = "https://other.invalid/result"
        with self.assertRaisesRegex(HostedContractError, "unexpected_callback_origin"):
            parse_hosted_job_claim(
                unexpected_origin,
                allowed_transfer_origins=frozenset(
                    {*TRANSFER_ORIGINS, "https://other.invalid"}
                ),
                expected_callback_origin="https://transfer.invalid",
            )

        overlapping = claim_payload()
        overlapping["failureUrl"] = "https://transfer.invalid/result"
        with self.assertRaisesRegex(HostedContractError, "job_claim_urls_must_differ"):
            parse_hosted_job_claim(
                overlapping,
                allowed_transfer_origins=TRANSFER_ORIGINS,
                expected_callback_origin="https://transfer.invalid",
            )

        invalid_expiry = claim_payload()
        invalid_expiry["leaseExpiresAt"] = "tomorrow"
        with self.assertRaisesRegex(HostedContractError, "invalid_lease_expires_at"):
            parse_hosted_job_claim(
                invalid_expiry,
                allowed_transfer_origins=TRANSFER_ORIGINS,
                expected_callback_origin="https://transfer.invalid",
            )

    def test_rejects_unknown_fields_and_non_https_transfer_urls(self) -> None:
        extra = request_payload()
        extra["recordingTitle"] = "private"
        with self.assertRaisesRegex(HostedContractError, "invalid_processing_request_fields"):
            parse_hosted_processing_request(extra, allowed_transfer_origins=TRANSFER_ORIGINS)

        insecure = request_payload()
        insecure["sourceDownloadUrl"] = "http://transfer.invalid/source"
        with self.assertRaisesRegex(HostedContractError, "invalid_source_download_url"):
            parse_hosted_processing_request(insecure, allowed_transfer_origins=TRANSFER_ORIGINS)

        untrusted = request_payload()
        untrusted["sourceDownloadUrl"] = "https://attacker.invalid/source"
        with self.assertRaisesRegex(HostedContractError, "untrusted_source_download_url"):
            parse_hosted_processing_request(untrusted, allowed_transfer_origins=TRANSFER_ORIGINS)

        query_capability = request_payload()
        query_capability["sourceDownloadUrl"] = (
            "https://transfer.invalid/source?token=must-not-be-logged"
        )
        with self.assertRaisesRegex(
            HostedContractError, "processing_transfer_url_query_rejected"
        ):
            parse_hosted_processing_request(
                query_capability, allowed_transfer_origins=TRANSFER_ORIGINS
            )

        same_resource = request_payload()
        same_resource["derivativeUploadUrl"] = "https://transfer.invalid/source"
        with self.assertRaisesRegex(
            HostedContractError, "processing_transfer_urls_must_differ"
        ):
            parse_hosted_processing_request(
                same_resource, allowed_transfer_origins=TRANSFER_ORIGINS
            )

    def test_rejects_stale_policy_and_invalid_expected_source(self) -> None:
        stale = request_payload()
        stale["policyId"] = "mp3-v0"
        with self.assertRaisesRegex(HostedContractError, "unsupported_processing_policy"):
            parse_hosted_processing_request(stale, allowed_transfer_origins=TRANSFER_ORIGINS)

        invalid_hash = request_payload()
        invalid_hash["sourceSha256"] = "A" * 64
        with self.assertRaisesRegex(HostedContractError, "invalid_source_sha256"):
            parse_hosted_processing_request(invalid_hash, allowed_transfer_origins=TRANSFER_ORIGINS)

    def test_builds_verified_derivative_result_without_transfer_urls(self) -> None:
        request = parse_hosted_processing_request(
            request_payload(), allowed_transfer_origins=TRANSFER_ORIGINS
        )
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
        request = parse_hosted_processing_request(
            request_payload(), allowed_transfer_origins=TRANSFER_ORIGINS
        )
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

    def test_builds_rejected_oversized_candidate_as_direct_original(self) -> None:
        request = parse_hosted_processing_request(
            request_payload(), allowed_transfer_origins=TRANSFER_ORIGINS
        )
        result = build_hosted_processing_result(
            request,
            PreparationResult(
                status="candidate_discarded_original_is_playback",
                decision=Decision(
                    DecisionKind.TRY_OVERSIZED_MP3_DERIVATIVE,
                    "oversized_high_bitrate_mp3",
                ),
                original=summary(SOURCE_HASH, 100),
                validation=DerivativeValidation(
                    False, "oversized_mp3_saving_not_material", 0.1
                ),
            ),
        )

        self.assertEqual(result["playbackKind"], "original")
        self.assertFalse(result["validation"]["accepted"])

    def test_rejects_source_mismatch_and_unverified_derivative(self) -> None:
        request = parse_hosted_processing_request(
            request_payload(), allowed_transfer_origins=TRANSFER_ORIGINS
        )
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
