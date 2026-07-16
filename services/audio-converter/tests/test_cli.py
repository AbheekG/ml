from __future__ import annotations

import unittest
from pathlib import Path

from audio_converter.safety import PROJECT_ROOT, validate_output_path
from audio_converter.service import PreparationError


class CliSafetyTests(unittest.TestCase):
    def test_output_inside_appsheet_is_rejected(self) -> None:
        output = PROJECT_ROOT / "legacy" / "appsheet" / "recordings" / "output.mp3"
        with self.assertRaisesRegex(
            PreparationError,
            "output_inside_protected_legacy_root",
        ):
            validate_output_path(output)

    def test_output_inside_woodchime_is_rejected(self) -> None:
        output = PROJECT_ROOT / "legacy" / "woodchime" / "output.mp3"
        with self.assertRaisesRegex(
            PreparationError,
            "output_inside_protected_legacy_root",
        ):
            validate_output_path(output)

    def test_output_requires_mp3_extension(self) -> None:
        with self.assertRaisesRegex(
            PreparationError,
            "output_must_have_mp3_extension",
        ):
            validate_output_path(Path("/tmp/output.wav"))

    def test_separate_mp3_output_is_allowed(self) -> None:
        validate_output_path(Path("/tmp/output.mp3"))


if __name__ == "__main__":
    unittest.main()
