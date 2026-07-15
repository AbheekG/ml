from __future__ import annotations

import json
import math
import shutil
import subprocess
import time
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from .models import AudioInfo, DecodeResult, ProcessingPolicy
from .policy import expected_output_channels, output_sample_rate


class MediaToolError(RuntimeError):
    def __init__(self, code: str, operation: str):
        super().__init__(f"{operation} failed ({code})")
        self.code = code
        self.operation = operation


CommandRunner = Callable[
    [Sequence[str]],
    subprocess.CompletedProcess[str],
]


def _run_subprocess(
    command: Sequence[str],
    *,
    operation: str,
    deadline: float | None,
    monotonic: Callable[[], float],
    output: Path | None = None,
    max_output_bytes: int | None = None,
) -> subprocess.CompletedProcess[str]:
    if deadline is None and output is None:
        return subprocess.run(
            list(command),
            check=False,
            capture_output=True,
            text=True,
        )

    process = subprocess.Popen(
        list(command),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    def stop(code: str) -> None:
        process.kill()
        process.communicate()
        raise MediaToolError(code, operation)

    while True:
        if (
            output is not None
            and max_output_bytes is not None
            and output.exists()
            and output.stat().st_size > max_output_bytes
        ):
            stop("generated_output_too_large")
        remaining = None if deadline is None else deadline - monotonic()
        if remaining is not None and remaining <= 0:
            stop("processing_deadline_exceeded")
        wait_seconds = 0.05 if remaining is None else min(0.05, remaining)
        try:
            stdout, stderr = process.communicate(timeout=wait_seconds)
        except subprocess.TimeoutExpired:
            continue
        if (
            output is not None
            and max_output_bytes is not None
            and output.exists()
            and output.stat().st_size > max_output_bytes
        ):
            raise MediaToolError("generated_output_too_large", operation)
        if deadline is not None and monotonic() >= deadline:
            raise MediaToolError("processing_deadline_exceeded", operation)
        return subprocess.CompletedProcess(
            list(command),
            process.returncode,
            stdout,
            stderr,
        )


def _positive_int(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _positive_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _decoded_duration_seconds(progress_output: str) -> float | None:
    values = []
    for line in progress_output.splitlines():
        key, separator, raw_value = line.partition("=")
        if separator and key == "out_time_us":
            parsed = _positive_int(raw_value)
            if parsed is not None:
                values.append(parsed / 1_000_000)
    return values[-1] if values else None


class FFmpegTools:
    def __init__(
        self,
        *,
        ffmpeg: str = "ffmpeg",
        ffprobe: str = "ffprobe",
        runner: CommandRunner | None = None,
        policy: ProcessingPolicy = ProcessingPolicy(),
        deadline: float | None = None,
        max_generated_output_bytes: int | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
        self.runner = runner
        self.policy = policy
        if deadline is not None and (
            not isinstance(deadline, (int, float))
            or isinstance(deadline, bool)
            or not math.isfinite(deadline)
        ):
            raise ValueError("invalid processing deadline")
        if max_generated_output_bytes is not None and (
            not isinstance(max_generated_output_bytes, int)
            or isinstance(max_generated_output_bytes, bool)
            or max_generated_output_bytes < 1
        ):
            raise ValueError("invalid generated output limit")
        self.deadline = float(deadline) if deadline is not None else None
        self.max_generated_output_bytes = max_generated_output_bytes
        self.monotonic = monotonic

    def _check_bounds(self, operation: str, output: Path | None = None) -> None:
        if (
            output is not None
            and self.max_generated_output_bytes is not None
            and output.exists()
            and output.stat().st_size > self.max_generated_output_bytes
        ):
            raise MediaToolError("generated_output_too_large", operation)
        if self.deadline is not None and self.monotonic() >= self.deadline:
            raise MediaToolError("processing_deadline_exceeded", operation)

    def _run(
        self,
        command: Sequence[str],
        *,
        operation: str,
        output: Path | None = None,
    ) -> subprocess.CompletedProcess[str]:
        self._check_bounds(operation, output)
        if self.runner is None:
            return _run_subprocess(
                command,
                operation=operation,
                deadline=self.deadline,
                monotonic=self.monotonic,
                output=output,
                max_output_bytes=self.max_generated_output_bytes,
            )
        result = self.runner(command)
        self._check_bounds(operation, output)
        return result

    def require_available(self) -> None:
        for executable, code in (
            (self.ffmpeg, "ffmpeg_not_found"),
            (self.ffprobe, "ffprobe_not_found"),
        ):
            if Path(executable).is_absolute():
                available = Path(executable).is_file()
            else:
                available = shutil.which(executable) is not None
            if not available:
                raise MediaToolError(code, "dependency check")

    def probe(self, source: Path) -> AudioInfo:
        command = [
            self.ffprobe,
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-select_streams",
            "a",
            "-show_entries",
            (
                "format=format_name,duration,bit_rate:"
                "stream=index,codec_type,codec_name,sample_rate,channels,"
                "duration,bit_rate"
            ),
            "-of",
            "json",
            str(source),
        ]
        result = self._run(command, operation="audio inspection")
        if result.returncode != 0:
            raise MediaToolError("probe_failed", "audio inspection")

        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise MediaToolError("invalid_probe_output", "audio inspection") from error

        streams = payload.get("streams")
        if not isinstance(streams, list):
            raise MediaToolError("missing_audio_stream", "audio inspection")
        audio_streams = [
            stream
            for stream in streams
            if isinstance(stream, dict) and stream.get("codec_type") == "audio"
        ]
        if not audio_streams:
            raise MediaToolError("missing_audio_stream", "audio inspection")
        audio_stream = min(
            audio_streams,
            key=lambda stream: int(stream.get("index", 0)),
        )

        format_info = payload.get("format")
        if not isinstance(format_info, dict):
            format_info = {}

        duration = _positive_float(format_info.get("duration"))
        if duration is None:
            duration = _positive_float(audio_stream.get("duration"))
        bit_rate = _positive_int(format_info.get("bit_rate"))
        if bit_rate is None:
            bit_rate = _positive_int(audio_stream.get("bit_rate"))
        sample_rate = _positive_int(audio_stream.get("sample_rate"))
        channels = _positive_int(audio_stream.get("channels"))
        stream_index = _positive_int(audio_stream.get("index"))
        if audio_stream.get("index") == 0:
            stream_index = 0

        if duration is None or sample_rate is None or channels is None:
            raise MediaToolError("incomplete_audio_metadata", "audio inspection")
        if stream_index is None:
            raise MediaToolError("invalid_audio_stream_index", "audio inspection")

        raw_format_names = str(format_info.get("format_name", ""))
        container_names = tuple(
            sorted(
                {
                    name.strip().casefold()
                    for name in raw_format_names.split(",")
                    if name.strip()
                }
            )
        )
        codec_name = str(audio_stream.get("codec_name", "")).strip().casefold()
        if not container_names or not codec_name:
            raise MediaToolError("incomplete_audio_metadata", "audio inspection")

        try:
            byte_size = source.stat().st_size
        except OSError as error:
            raise MediaToolError("source_unreadable", "audio inspection") from error

        return AudioInfo(
            container_names=container_names,
            codec_name=codec_name,
            duration_seconds=duration,
            byte_size=byte_size,
            bit_rate=bit_rate,
            sample_rate=sample_rate,
            channels=channels,
            stream_index=stream_index,
        )

    def decode_check(
        self,
        source: Path,
        stream_index: int,
        *,
        strict: bool,
    ) -> DecodeResult:
        command = [
            self.ffmpeg,
            "-hide_banner",
            "-nostdin",
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
        ]
        if strict:
            command.append("-xerror")
        command.extend([
            "-progress",
            "pipe:1",
            "-nostats",
            "-i",
            str(source),
            "-map",
            f"0:{stream_index}",
            "-f",
            "null",
            "-",
        ])
        result = self._run(command, operation="complete decode check")
        if result.returncode != 0:
            raise MediaToolError("decode_failed", "complete decode check")
        duration = _decoded_duration_seconds(result.stdout)
        if duration is None:
            raise MediaToolError("decode_duration_missing", "complete decode check")
        return DecodeResult(
            duration_seconds=duration,
            had_recoverable_errors=bool(result.stderr.strip()),
        )

    def conversion_command(
        self,
        source: Path,
        output: Path,
        source_info: AudioInfo,
    ) -> list[str]:
        command = [
            self.ffmpeg,
            "-hide_banner",
            "-nostdin",
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
            str(source),
            "-map",
            f"0:{source_info.stream_index}",
            "-vn",
            "-sn",
            "-dn",
            "-map_metadata",
            "-1",
            "-c:a",
            "libmp3lame",
            "-q:a",
            str(self.policy.mp3_quality),
            "-ar",
            str(output_sample_rate(source_info.sample_rate, self.policy)),
            "-ac",
            str(expected_output_channels(source_info.channels)),
            "-write_xing",
            "1",
            "-id3v2_version",
            "3",
            "-write_id3v1",
            "0",
            "-y",
            str(output),
        ]
        return command

    def transcode(
        self,
        source: Path,
        output: Path,
        source_info: AudioInfo,
    ) -> None:
        result = self._run(
            self.conversion_command(source, output, source_info),
            operation="MP3 conversion",
            output=output,
        )
        if result.returncode != 0:
            raise MediaToolError("conversion_failed", "MP3 conversion")
        if not output.is_file() or output.stat().st_size <= 0:
            raise MediaToolError("missing_conversion_output", "MP3 conversion")
