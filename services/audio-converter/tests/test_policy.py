from __future__ import annotations

import unittest

from audio_converter.models import (
    MIB,
    AudioInfo,
    DecisionKind,
    ProcessingPolicy,
)
from audio_converter.policy import (
    decide,
    duration_tolerance_seconds,
    output_sample_rate,
    validate_derivative,
)


def audio_info(
    *,
    codec: str = "mp3",
    containers: tuple[str, ...] = ("mp3",),
    byte_size: int = 5 * MIB,
    bit_rate: int | None = 192_000,
    duration: float = 240.0,
    sample_rate: int = 48_000,
    channels: int = 2,
) -> AudioInfo:
    return AudioInfo(
        container_names=containers,
        codec_name=codec,
        duration_seconds=duration,
        byte_size=byte_size,
        bit_rate=bit_rate,
        sample_rate=sample_rate,
        channels=channels,
        stream_index=0,
    )


class DecisionTests(unittest.TestCase):
    def test_reasonable_mp3_uses_original(self) -> None:
        result = decide(audio_info())
        self.assertEqual(result.kind, DecisionKind.USE_ORIGINAL)

    def test_large_low_bit_rate_mp3_uses_original(self) -> None:
        result = decide(audio_info(byte_size=30 * MIB, bit_rate=128_000))
        self.assertEqual(result.kind, DecisionKind.USE_ORIGINAL)

    def test_small_high_bit_rate_mp3_uses_original(self) -> None:
        result = decide(audio_info(byte_size=20 * MIB, bit_rate=320_000))
        self.assertEqual(result.kind, DecisionKind.USE_ORIGINAL)

    def test_large_high_bit_rate_mp3_gets_candidate(self) -> None:
        result = decide(audio_info(byte_size=25 * MIB, bit_rate=256_000))
        self.assertEqual(
            result.kind,
            DecisionKind.TRY_OVERSIZED_MP3_DERIVATIVE,
        )

    def test_non_mp3_requires_derivative(self) -> None:
        result = decide(
            audio_info(codec="aac", containers=("mov", "mp4", "m4a"))
        )
        self.assertEqual(result.kind, DecisionKind.REQUIRE_DERIVATIVE)

    def test_mp3_codec_in_non_mp3_container_requires_derivative(self) -> None:
        result = decide(audio_info(containers=("mov", "mp4")))
        self.assertEqual(result.kind, DecisionKind.REQUIRE_DERIVATIVE)

    def test_duration_derived_bit_rate_is_used_when_probe_has_none(self) -> None:
        source = audio_info(
            byte_size=30 * MIB,
            bit_rate=None,
            duration=600.0,
        )
        self.assertGreaterEqual(source.effective_bit_rate, 256_000)
        self.assertEqual(
            decide(source).kind,
            DecisionKind.TRY_OVERSIZED_MP3_DERIVATIVE,
        )


class DerivativeValidationTests(unittest.TestCase):
    def test_required_derivative_accepts_matching_mp3(self) -> None:
        source = audio_info(codec="aac", containers=("mov", "mp4"))
        decision = decide(source)
        derivative = audio_info(byte_size=4 * MIB)

        result = validate_derivative(source, derivative, decision)

        self.assertTrue(result.accepted)
        self.assertEqual(result.reason, "verified")

    def test_oversized_candidate_requires_twenty_percent_saving(self) -> None:
        policy = ProcessingPolicy()
        source = audio_info(byte_size=30 * MIB, bit_rate=320_000)
        decision = decide(source, policy)
        accepted = audio_info(byte_size=24 * MIB)
        rejected = audio_info(byte_size=24 * MIB + 1)

        accepted_result = validate_derivative(
            source,
            accepted,
            decision,
            policy,
        )
        rejected_result = validate_derivative(
            source,
            rejected,
            decision,
            policy,
        )

        self.assertTrue(accepted_result.accepted)
        self.assertFalse(rejected_result.accepted)
        self.assertEqual(
            rejected_result.reason,
            "oversized_mp3_saving_not_material",
        )

    def test_duration_mismatch_is_rejected(self) -> None:
        source = audio_info(codec="aac", containers=("mp4",))
        derivative = audio_info(duration=source.duration_seconds + 2)

        result = validate_derivative(source, derivative, decide(source))

        self.assertFalse(result.accepted)
        self.assertEqual(result.reason, "derivative_duration_mismatch")

    def test_channel_mismatch_is_rejected(self) -> None:
        source = audio_info(codec="aac", containers=("mp4",), channels=1)
        derivative = audio_info(channels=2)

        result = validate_derivative(source, derivative, decide(source))

        self.assertFalse(result.accepted)
        self.assertEqual(result.reason, "derivative_channel_mismatch")

    def test_unusual_low_sample_rate_becomes_sixteen_khz(self) -> None:
        self.assertEqual(output_sample_rate(8_000), 16_000)
        self.assertEqual(output_sample_rate(16_000), 16_000)
        self.assertEqual(output_sample_rate(44_100), 44_100)

    def test_duration_tolerance_is_bounded_for_short_audio(self) -> None:
        self.assertEqual(duration_tolerance_seconds(10), 0.25)
        self.assertEqual(duration_tolerance_seconds(1_000), 1.0)


if __name__ == "__main__":
    unittest.main()
