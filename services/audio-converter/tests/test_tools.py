from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from collections.abc import Sequence

from audio_converter.models import AudioInfo
from audio_converter.tools import FFmpegTools, MediaToolError


class RecordingRunner:
    def __init__(self, results: list[subprocess.CompletedProcess[str]]) -> None:
        self.results = results
        self.commands: list[list[str]] = []

    def __call__(
        self,
        command: Sequence[str],
    ) -> subprocess.CompletedProcess[str]:
        self.commands.append(list(command))
        return self.results.pop(0)


class FFmpegToolsTests(unittest.TestCase):
    def test_probe_selects_first_audio_stream_and_uses_file_size(self) -> None:
        payload = {
            "streams": [
                {
                    "index": 0,
                    "codec_type": "video",
                    "codec_name": "mjpeg",
                },
                {
                    "index": 2,
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "sample_rate": "48000",
                    "channels": 2,
                },
                {
                    "index": 1,
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "sample_rate": "44100",
                    "channels": 1,
                },
            ],
            "format": {
                "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
                "duration": "12.5",
                "bit_rate": "128000",
            },
        }
        runner = RecordingRunner(
            [subprocess.CompletedProcess([], 0, json.dumps(payload), "")]
        )
        tools = FFmpegTools(runner=runner)

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "fixture.bin"
            source.write_bytes(b"fixture-bytes")
            result = tools.probe(source)

        self.assertEqual(result.stream_index, 1)
        self.assertEqual(result.codec_name, "aac")
        self.assertEqual(result.sample_rate, 44_100)
        self.assertEqual(result.channels, 1)
        self.assertEqual(result.byte_size, len(b"fixture-bytes"))
        self.assertIn("mp4", result.container_names)

    def test_probe_rejects_input_without_audio(self) -> None:
        payload = {
            "streams": [{"index": 0, "codec_type": "video"}],
            "format": {"format_name": "mp4", "duration": "5"},
        }
        runner = RecordingRunner(
            [subprocess.CompletedProcess([], 0, json.dumps(payload), "")]
        )
        tools = FFmpegTools(runner=runner)

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "fixture.bin"
            source.write_bytes(b"fixture")
            with self.assertRaisesRegex(MediaToolError, "missing_audio_stream"):
                tools.probe(source)

    def test_decode_check_maps_only_selected_audio_stream(self) -> None:
        runner = RecordingRunner(
            [
                subprocess.CompletedProcess(
                    [],
                    0,
                    "out_time_us=12500000\nprogress=end\n",
                    "",
                )
            ]
        )
        tools = FFmpegTools(runner=runner)

        result = tools.decode_check(Path("fixture.bin"), 3, strict=True)

        command = runner.commands[0]
        self.assertEqual(command[command.index("-map") + 1], "0:3")
        self.assertIn("-xerror", command)
        self.assertEqual(command[-2:], ["null", "-"])
        self.assertEqual(result.duration_seconds, 12.5)
        self.assertFalse(result.had_recoverable_errors)

    def test_lenient_decode_reports_recoverable_errors(self) -> None:
        runner = RecordingRunner(
            [
                subprocess.CompletedProcess(
                    [],
                    0,
                    "out_time_us=1000000\nprogress=end\n",
                    "recoverable decode error",
                )
            ]
        )
        tools = FFmpegTools(runner=runner)

        result = tools.decode_check(Path("fixture.bin"), 0, strict=False)

        self.assertNotIn("-xerror", runner.commands[0])
        self.assertTrue(result.had_recoverable_errors)

    def test_conversion_command_uses_accepted_quality_and_clean_output(self) -> None:
        tools = FFmpegTools()
        source_info = AudioInfo(
            container_names=("3gp",),
            codec_name="amr_nb",
            duration_seconds=30,
            byte_size=1000,
            bit_rate=12_800,
            sample_rate=8_000,
            channels=1,
            stream_index=2,
        )

        command = tools.conversion_command(
            Path("input.bin"),
            Path("output.mp3"),
            source_info,
        )

        self.assertEqual(command[command.index("-q:a") + 1], "2")
        self.assertEqual(command[command.index("-ar") + 1], "16000")
        self.assertEqual(command[command.index("-ac") + 1], "1")
        self.assertEqual(command[command.index("-map") + 1], "0:2")
        self.assertEqual(command[command.index("-map_metadata") + 1], "-1")
        self.assertEqual(command[command.index("-write_xing") + 1], "1")
        self.assertIn("-vn", command)
        self.assertIn("-sn", command)
        self.assertIn("-dn", command)


if __name__ == "__main__":
    unittest.main()
