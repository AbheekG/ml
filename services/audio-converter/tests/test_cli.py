from __future__ import annotations

import unittest
from pathlib import Path

from audio_converter.cli import PROJECT_ROOT, _validate_output
from audio_converter.service import PreparationError


class CliSafetyTests(unittest.TestCase):
    def test_output_inside_appsheet_is_rejected(self) -> None:
        output = PROJECT_ROOT / "appsheet" / "recordings" / "output.mp3"
        with self.assertRaisesRegex(
            PreparationError,
            "output_inside_protected_legacy_root",
        ):
            _validate_output(output)

    def test_output_inside_woodchime_is_rejected(self) -> None:
        output = PROJECT_ROOT / "woodchime" / "output.mp3"
        with self.assertRaisesRegex(
            PreparationError,
            "output_inside_protected_legacy_root",
        ):
            _validate_output(output)

    def test_output_requires_mp3_extension(self) -> None:
        with self.assertRaisesRegex(
            PreparationError,
            "output_must_have_mp3_extension",
        ):
            _validate_output(Path("/tmp/output.wav"))

    def test_separate_mp3_output_is_allowed(self) -> None:
        _validate_output(Path("/tmp/output.mp3"))


if __name__ == "__main__":
    unittest.main()
