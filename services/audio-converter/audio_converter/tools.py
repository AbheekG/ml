from __future__ import annotations

import json
import shutil
import subprocess
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


def _run_subprocess(command: Sequence[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(command),
        check=False,
        capture_output=True,
        text=True,
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
        runner: CommandRunner = _run_subprocess,
        policy: ProcessingPolicy = ProcessingPolicy(),
    ) -> None:
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
        self.runner = runner
        self.policy = policy

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
        result = self.runner(command)
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
        result = self.runner(command)
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
        result = self.runner(self.conversion_command(source, output, source_info))
        if result.returncode != 0:
            raise MediaToolError("conversion_failed", "MP3 conversion")
        if not output.is_file() or output.stat().st_size <= 0:
            raise MediaToolError("missing_conversion_output", "MP3 conversion")
