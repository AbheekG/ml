#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import platform
import resource
import stat
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from audio_converter.models import MIB
from audio_converter.service import PreparationError, manifest_path, prepare
from audio_converter.tools import FFmpegTools, MediaToolError


DEFAULT_SOURCE_BYTES = 512 * MIB
DEFAULT_GENERATED_OUTPUT_BYTES = 512 * MIB
DEFAULT_TEMPORARY_BYTES = 1_152 * MIB
DEFAULT_MEMORY_BYTES = 2 * 1024 * MIB
DEFAULT_DEADLINE_SECONDS = 45 * 60
SAMPLE_RATE = 48_000
CHANNELS = 2
SAMPLE_WIDTH = 2
WAVE_HEADER_BYTES = 44


class TemporaryUsageMonitor:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.peak_bytes = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join()
        self._sample()

    def _sample(self) -> None:
        total = 0
        try:
            candidates = tuple(self.root.iterdir())
        except OSError:
            candidates = ()
        for candidate in candidates:
            try:
                if candidate.is_file():
                    total += candidate.stat().st_size
            except OSError:
                continue
        self.peak_bytes = max(self.peak_bytes, total)

    def _run(self) -> None:
        while not self._stop.wait(0.05):
            self._sample()


def _positive_integer(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("must be an integer") from None
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def _write_silent_wave(path: Path, target_bytes: int) -> int:
    frame_bytes = CHANNELS * SAMPLE_WIDTH
    frame_count = (target_bytes - WAVE_HEADER_BYTES) // frame_bytes
    if frame_count < 1:
        raise ValueError("source byte target is too small")

    chunk_frames = 256 * 1024
    full_chunk = bytes(chunk_frames * frame_bytes)
    remaining = frame_count
    with wave.open(str(path), "wb") as output:
        output.setnchannels(CHANNELS)
        output.setsampwidth(SAMPLE_WIDTH)
        output.setframerate(SAMPLE_RATE)
        while remaining:
            frames = min(remaining, chunk_frames)
            output.writeframesraw(full_chunk[: frames * frame_bytes])
            remaining -= frames
    return path.stat().st_size


def _write_dense_file(path: Path, byte_size: int) -> None:
    chunk = bytes(MIB)
    remaining = byte_size
    with path.open("xb") as output:
        while remaining:
            written = min(remaining, len(chunk))
            output.write(chunk[:written])
            remaining -= written


def _rss_bytes(usage: resource.struct_rusage) -> int:
    multiplier = 1 if platform.system() == "Darwin" else 1024
    return int(usage.ru_maxrss) * multiplier


def _write_record(record: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run an aggregate-only synthetic FFmpeg resource fixture.",
    )
    parser.add_argument(
        "--temporary-root",
        type=Path,
        default=Path("/var/lib/music-audio"),
    )
    parser.add_argument(
        "--source-bytes",
        type=_positive_integer,
        default=DEFAULT_SOURCE_BYTES,
    )
    parser.add_argument(
        "--generated-output-limit-bytes",
        type=_positive_integer,
        default=DEFAULT_GENERATED_OUTPUT_BYTES,
    )
    parser.add_argument(
        "--storage-side-bytes",
        type=_positive_integer,
        default=DEFAULT_GENERATED_OUTPUT_BYTES,
    )
    parser.add_argument(
        "--temporary-limit-bytes",
        type=_positive_integer,
        default=DEFAULT_TEMPORARY_BYTES,
    )
    parser.add_argument(
        "--memory-limit-bytes",
        type=_positive_integer,
        default=DEFAULT_MEMORY_BYTES,
    )
    parser.add_argument(
        "--deadline-seconds",
        type=_positive_integer,
        default=DEFAULT_DEADLINE_SECONDS,
    )
    return parser


def main(arguments: list[str] | None = None) -> int:
    args = _parser().parse_args(arguments)
    started_at = time.monotonic()
    fixture_root: Path | None = None
    monitor: TemporaryUsageMonitor | None = None
    metrics: dict[str, object] = {}
    error_code: str | None = None

    try:
        temporary_root = args.temporary_root.resolve(strict=True)
        if not temporary_root.is_dir():
            raise ValueError("invalid temporary root")
        if args.source_bytes > DEFAULT_SOURCE_BYTES:
            raise ValueError("source byte target exceeds hosted limit")
        if args.storage_side_bytes > DEFAULT_GENERATED_OUTPUT_BYTES:
            raise ValueError("storage byte target exceeds hosted limit")

        with tempfile.TemporaryDirectory(
            prefix="audio-runtime-fixture-",
            dir=temporary_root,
        ) as directory:
            fixture_root = Path(directory)
            mode = stat.S_IMODE(fixture_root.stat().st_mode)
            if mode != 0o700:
                raise ValueError("fixture directory is not private")
            monitor = TemporaryUsageMonitor(fixture_root)
            monitor.start()

            storage_source = fixture_root / "storage-source.fixture"
            storage_output = fixture_root / "storage-output.fixture"
            _write_dense_file(storage_source, args.storage_side_bytes)
            _write_dense_file(storage_output, args.storage_side_bytes)
            monitor._sample()
            storage_fixture_bytes = (
                storage_source.stat().st_size + storage_output.stat().st_size
            )
            storage_source.unlink()
            storage_output.unlink()

            source = fixture_root / "source.wav"
            output = fixture_root / "playback.mp3"
            source_bytes = _write_silent_wave(source, args.source_bytes)
            tools = FFmpegTools(
                deadline=started_at + args.deadline_seconds,
                max_generated_output_bytes=args.generated_output_limit_bytes,
            )
            tools.require_available()
            result = prepare(
                tools,
                source,
                output=output,
                execute=True,
                checkpoint=lambda: tools._check_bounds("resource fixture"),
                max_generated_output_bytes=args.generated_output_limit_bytes,
            )
            if result.status != "created_derivative" or result.derivative is None:
                raise ValueError("fixture did not create a derivative")
            if not output.is_file() or not manifest_path(output).is_file():
                raise ValueError("fixture output is incomplete")

            monitor.stop()
            metrics = {
                "derivativeBytes": result.derivative.byte_size,
                "peakTemporaryBytes": monitor.peak_bytes,
                "sourceBytes": source_bytes,
                "storageFixtureBytes": storage_fixture_bytes,
            }
            monitor = None
    except (PreparationError, MediaToolError) as error:
        error_code = error.code
    except Exception:
        error_code = "runtime_fixture_failed"
    finally:
        if monitor is not None:
            monitor.stop()

    cleanup_complete = fixture_root is not None and not fixture_root.exists()
    peak_rss_bytes = _rss_bytes(resource.getrusage(resource.RUSAGE_SELF)) + _rss_bytes(
        resource.getrusage(resource.RUSAGE_CHILDREN)
    )
    peak_temporary_bytes = int(
        metrics.get("peakTemporaryBytes", args.temporary_limit_bytes + 1)
    )
    peak_memory_bytes = peak_rss_bytes + peak_temporary_bytes
    elapsed_milliseconds = round((time.monotonic() - started_at) * 1000)
    within_limits = (
        error_code is None
        and cleanup_complete
        and peak_temporary_bytes <= args.temporary_limit_bytes
        and peak_memory_bytes <= args.memory_limit_bytes
    )

    record: dict[str, object] = {
        "cleanupComplete": cleanup_complete,
        "elapsedMilliseconds": elapsed_milliseconds,
        "memoryLimitBytes": args.memory_limit_bytes,
        "outcome": "succeeded" if within_limits else "failed",
        "peakMemoryBytesConservative": peak_memory_bytes,
        "peakRssBytesConservative": peak_rss_bytes,
        "temporaryLimitBytes": args.temporary_limit_bytes,
        "withinLimits": within_limits,
        **metrics,
    }
    if error_code is not None:
        record["errorCode"] = error_code
    _write_record(record)
    return 0 if within_limits else 1


if __name__ == "__main__":
    raise SystemExit(main())
