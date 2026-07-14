from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from audio_converter.models import MIB, AudioInfo, DecodeResult
from audio_converter.service import PreparationError, manifest_path, prepare


class FakeTools:
    def __init__(
        self,
        source: Path,
        source_info: AudioInfo,
        derivative_info: AudioInfo,
    ) -> None:
        self.source = source.resolve()
        self.source_info = source_info
        self.derivative_info = derivative_info
        self.decode_checks: list[Path] = []
        self.transcodes = 0

    def probe(self, source: Path) -> AudioInfo:
        if source.resolve() == self.source:
            return self.source_info
        return AudioInfo(
            container_names=self.derivative_info.container_names,
            codec_name=self.derivative_info.codec_name,
            duration_seconds=self.derivative_info.duration_seconds,
            byte_size=source.stat().st_size,
            bit_rate=self.derivative_info.bit_rate,
            sample_rate=self.derivative_info.sample_rate,
            channels=self.derivative_info.channels,
            stream_index=self.derivative_info.stream_index,
        )

    def decode_check(
        self,
        source: Path,
        stream_index: int,
        *,
        strict: bool,
    ) -> DecodeResult:
        self.decode_checks.append(source)
        if source.resolve() == self.source:
            duration = self.source_info.duration_seconds
        else:
            duration = self.derivative_info.duration_seconds
        return DecodeResult(duration, False)

    def transcode(
        self,
        source: Path,
        output: Path,
        source_info: AudioInfo,
    ) -> None:
        self.transcodes += 1
        output.write_bytes(b"d" * self.derivative_info.byte_size)


def info(
    *,
    codec: str,
    containers: tuple[str, ...],
    byte_size: int,
    bit_rate: int,
    duration: float = 120,
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


class PreparationTests(unittest.TestCase):
    def test_dry_run_inspects_and_hashes_without_creating_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.bin"
            output = root / "output.mp3"
            source.write_bytes(b"original")
            source_info = info(
                codec="aac",
                containers=("mp4",),
                byte_size=8,
                bit_rate=128_000,
            )
            derivative_info = info(
                codec="mp3",
                containers=("mp3",),
                byte_size=4,
                bit_rate=192_000,
            )
            tools = FakeTools(source, source_info, derivative_info)

            result = prepare(tools, source, output=output, execute=False)

            self.assertEqual(result.status, "would_create_derivative")
            self.assertFalse(output.exists())
            self.assertEqual(tools.transcodes, 0)
            self.assertEqual(len(result.original.sha256), 64)

    def test_valid_mp3_never_creates_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp3"
            output = root / "output.mp3"
            source.write_bytes(b"original")
            source_info = info(
                codec="mp3",
                containers=("mp3",),
                byte_size=8,
                bit_rate=192_000,
            )
            tools = FakeTools(source, source_info, source_info)

            result = prepare(tools, source, output=output, execute=True)

            self.assertEqual(result.status, "original_is_playback")
            self.assertFalse(output.exists())
            self.assertEqual(tools.transcodes, 0)

    def test_unneeded_existing_output_for_valid_mp3_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp3"
            output = root / "output.mp3"
            source.write_bytes(b"original")
            output.write_bytes(b"stale")
            source_info = info(
                codec="mp3",
                containers=("mp3",),
                byte_size=8,
                bit_rate=192_000,
            )
            tools = FakeTools(source, source_info, source_info)

            with self.assertRaisesRegex(
                PreparationError,
                "unneeded_output_for_original",
            ):
                prepare(tools, source, output=output, execute=False)

    def test_execute_atomically_publishes_verified_derivative(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.bin"
            output = root / "nested" / "output.mp3"
            source.write_bytes(b"original")
            source_info = info(
                codec="aac",
                containers=("mp4",),
                byte_size=8,
                bit_rate=128_000,
            )
            derivative_info = info(
                codec="mp3",
                containers=("mp3",),
                byte_size=4,
                bit_rate=192_000,
            )
            tools = FakeTools(source, source_info, derivative_info)

            result = prepare(tools, source, output=output, execute=True)

            self.assertEqual(result.status, "created_derivative")
            self.assertEqual(output.read_bytes(), b"dddd")
            self.assertTrue(manifest_path(output).is_file())
            self.assertEqual(tools.transcodes, 1)
            self.assertEqual(list(output.parent.glob("*.temporary.mp3")), [])

    def test_oversized_candidate_is_discarded_without_material_saving(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp3"
            output = root / "output.mp3"
            source.write_bytes(b"original")
            source_info = info(
                codec="mp3",
                containers=("mp3",),
                byte_size=30 * MIB,
                bit_rate=320_000,
            )
            derivative_info = info(
                codec="mp3",
                containers=("mp3",),
                byte_size=25 * MIB,
                bit_rate=200_000,
            )
            tools = FakeTools(source, source_info, derivative_info)

            result = prepare(tools, source, output=output, execute=True)

            self.assertEqual(
                result.status,
                "candidate_discarded_original_is_playback",
            )
            self.assertFalse(output.exists())
            self.assertEqual(tools.transcodes, 1)

    def test_existing_verified_derivative_is_reused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.bin"
            output = root / "output.mp3"
            source.write_bytes(b"original")
            output.write_bytes(b"dddd")
            source_info = info(
                codec="aac",
                containers=("mp4",),
                byte_size=8,
                bit_rate=128_000,
            )
            derivative_info = info(
                codec="mp3",
                containers=("mp3",),
                byte_size=4,
                bit_rate=192_000,
            )
            tools = FakeTools(source, source_info, derivative_info)

            initial_output = root / "initial.mp3"
            initial = prepare(
                tools,
                source,
                output=initial_output,
                execute=True,
            )
            self.assertEqual(initial.status, "created_derivative")
            output.write_bytes(initial_output.read_bytes())
            manifest_path(output).write_bytes(
                manifest_path(initial_output).read_bytes()
            )
            tools.transcodes = 0

            result = prepare(tools, source, output=output, execute=True)

            self.assertEqual(result.status, "verified_existing_derivative")
            self.assertEqual(tools.transcodes, 0)

    def test_existing_derivative_without_manifest_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.bin"
            output = root / "output.mp3"
            source.write_bytes(b"original")
            output.write_bytes(b"dddd")
            source_info = info(
                codec="aac",
                containers=("mp4",),
                byte_size=8,
                bit_rate=128_000,
            )
            derivative_info = info(
                codec="mp3",
                containers=("mp3",),
                byte_size=4,
                bit_rate=192_000,
            )
            tools = FakeTools(source, source_info, derivative_info)

            with self.assertRaisesRegex(
                PreparationError,
                "existing_output_missing_manifest",
            ):
                prepare(tools, source, output=output, execute=True)

    def test_source_cannot_be_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.bin"
            source.write_bytes(b"original")
            source_info = info(
                codec="aac",
                containers=("mp4",),
                byte_size=8,
                bit_rate=128_000,
            )
            derivative_info = info(
                codec="mp3",
                containers=("mp3",),
                byte_size=4,
                bit_rate=192_000,
            )
            tools = FakeTools(source, source_info, derivative_info)

            with self.assertRaisesRegex(
                PreparationError,
                "output_must_not_replace_original",
            ):
                prepare(tools, source, output=source, execute=True)


if __name__ == "__main__":
    unittest.main()
