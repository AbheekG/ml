from __future__ import annotations

import io
import json
import shutil
import tempfile
import unittest
import wave
from contextlib import redirect_stdout
from pathlib import Path

from scripts import verify_runtime_fixture


class RuntimeFixtureTests(unittest.TestCase):
    def test_synthetic_source_is_bounded_valid_pcm_wave(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "fixture.wav"
            byte_size = verify_runtime_fixture._write_silent_wave(source, 1_048_576)

            self.assertLessEqual(byte_size, 1_048_576)
            self.assertGreater(byte_size, 1_048_500)
            with wave.open(str(source), "rb") as audio:
                self.assertEqual(audio.getnchannels(), 2)
                self.assertEqual(audio.getsampwidth(), 2)
                self.assertEqual(audio.getframerate(), 48_000)
                self.assertGreater(audio.getnframes(), 0)

    @unittest.skipUnless(
        shutil.which("ffmpeg") and shutil.which("ffprobe"),
        "FFmpeg runtime fixture dependencies are unavailable",
    )
    def test_small_runtime_fixture_reports_only_aggregate_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = io.StringIO()
            with redirect_stdout(output):
                exit_code = verify_runtime_fixture.main([
                    "--temporary-root",
                    directory,
                    "--source-bytes",
                    "1048576",
                    "--storage-side-bytes",
                    "1048576",
                    "--deadline-seconds",
                    "120",
                ])

            record = json.loads(output.getvalue())
            self.assertEqual(exit_code, 0)
            self.assertEqual(record["outcome"], "succeeded")
            self.assertTrue(record["cleanupComplete"])
            self.assertTrue(record["withinLimits"])
            self.assertGreater(record["derivativeBytes"], 0)
            self.assertEqual(record["storageFixtureBytes"], 2_097_152)
            self.assertGreaterEqual(record["peakTemporaryBytes"], 2_097_152)
            self.assertLessEqual(
                record["peakMemoryBytesConservative"],
                record["memoryLimitBytes"],
            )
            serialized = output.getvalue().casefold()
            for forbidden in ("path", "hash", "token", "url", "recording", "job"):
                self.assertNotIn(forbidden, serialized)


if __name__ == "__main__":
    unittest.main()
