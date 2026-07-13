from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


MIB = 1024 * 1024


class DecisionKind(str, Enum):
    USE_ORIGINAL = "use_original"
    REQUIRE_DERIVATIVE = "require_derivative"
    TRY_OVERSIZED_MP3_DERIVATIVE = "try_oversized_mp3_derivative"


@dataclass(frozen=True)
class ProcessingPolicy:
    policy_id: str = "mp3-v1-libmp3lame-q2"
    mp3_quality: int = 2
    oversized_mp3_min_bytes: int = 25 * MIB
    oversized_mp3_min_bit_rate: int = 256_000
    oversized_mp3_min_saving_fraction: float = 0.20
    minimum_sample_rate: int = 16_000
    safe_sample_rates: tuple[int, ...] = (
        16_000,
        22_050,
        24_000,
        32_000,
        44_100,
        48_000,
    )


@dataclass(frozen=True)
class AudioInfo:
    container_names: tuple[str, ...]
    codec_name: str
    duration_seconds: float
    byte_size: int
    bit_rate: int | None
    sample_rate: int
    channels: int
    stream_index: int
    had_decode_warnings: bool = False

    @property
    def is_canonical_mp3(self) -> bool:
        return self.codec_name.casefold() == "mp3" and "mp3" in {
            name.casefold() for name in self.container_names
        }

    @property
    def effective_bit_rate(self) -> int:
        if self.bit_rate is not None and self.bit_rate > 0:
            return self.bit_rate
        if self.duration_seconds <= 0 or self.byte_size <= 0:
            return 0
        return round((self.byte_size * 8) / self.duration_seconds)


@dataclass(frozen=True)
class Decision:
    kind: DecisionKind
    reason: str


@dataclass(frozen=True)
class DerivativeValidation:
    accepted: bool
    reason: str
    saving_fraction: float | None = None


@dataclass(frozen=True)
class DecodeResult:
    duration_seconds: float
    had_recoverable_errors: bool
