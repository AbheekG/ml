from __future__ import annotations

from .models import (
    AudioInfo,
    Decision,
    DecisionKind,
    DerivativeValidation,
    ProcessingPolicy,
)


class InvalidAudioInfo(ValueError):
    pass


def validate_audio_info(info: AudioInfo) -> None:
    if info.byte_size <= 0:
        raise InvalidAudioInfo("audio byte size must be positive")
    if info.duration_seconds <= 0:
        raise InvalidAudioInfo("audio duration must be positive")
    if info.sample_rate <= 0:
        raise InvalidAudioInfo("audio sample rate must be positive")
    if info.channels <= 0:
        raise InvalidAudioInfo("audio channel count must be positive")
    if info.stream_index < 0:
        raise InvalidAudioInfo("audio stream index must not be negative")


def decide(
    info: AudioInfo,
    policy: ProcessingPolicy = ProcessingPolicy(),
) -> Decision:
    validate_audio_info(info)

    if not info.is_canonical_mp3:
        return Decision(
            DecisionKind.REQUIRE_DERIVATIVE,
            "noncanonical_audio_requires_mp3",
        )

    if (
        info.byte_size >= policy.oversized_mp3_min_bytes
        and info.effective_bit_rate >= policy.oversized_mp3_min_bit_rate
    ):
        return Decision(
            DecisionKind.TRY_OVERSIZED_MP3_DERIVATIVE,
            "oversized_high_bit_rate_mp3",
        )

    return Decision(DecisionKind.USE_ORIGINAL, "canonical_mp3")


def output_sample_rate(
    source_sample_rate: int,
    policy: ProcessingPolicy = ProcessingPolicy(),
) -> int:
    if source_sample_rate in policy.safe_sample_rates:
        return source_sample_rate
    if source_sample_rate <= policy.minimum_sample_rate:
        return policy.minimum_sample_rate
    return min(
        policy.safe_sample_rates,
        key=lambda candidate: (abs(candidate - source_sample_rate), candidate),
    )


def expected_output_channels(source_channels: int) -> int:
    return min(source_channels, 2)


def duration_tolerance_seconds(source_duration_seconds: float) -> float:
    return max(0.25, source_duration_seconds * 0.001)


def validate_derivative(
    source: AudioInfo,
    derivative: AudioInfo,
    decision: Decision,
    policy: ProcessingPolicy = ProcessingPolicy(),
) -> DerivativeValidation:
    validate_audio_info(source)
    validate_audio_info(derivative)

    if not derivative.is_canonical_mp3:
        return DerivativeValidation(False, "derivative_is_not_mp3")

    if derivative.channels != expected_output_channels(source.channels):
        return DerivativeValidation(False, "derivative_channel_mismatch")

    if derivative.sample_rate != output_sample_rate(source.sample_rate, policy):
        return DerivativeValidation(False, "derivative_sample_rate_mismatch")

    duration_difference = abs(
        derivative.duration_seconds - source.duration_seconds
    )
    if duration_difference > duration_tolerance_seconds(source.duration_seconds):
        return DerivativeValidation(False, "derivative_duration_mismatch")

    saving_fraction = 1 - (derivative.byte_size / source.byte_size)
    if decision.kind is DecisionKind.TRY_OVERSIZED_MP3_DERIVATIVE:
        maximum_derivative_bytes = source.byte_size * (
            1 - policy.oversized_mp3_min_saving_fraction
        )
        if derivative.byte_size > maximum_derivative_bytes:
            return DerivativeValidation(
                False,
                "oversized_mp3_saving_not_material",
                saving_fraction,
            )

    return DerivativeValidation(True, "verified", saving_fraction)
