from __future__ import annotations

import re
import unittest
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = SERVICE_ROOT / "Dockerfile"


class ContainerConfigurationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.contents = DOCKERFILE.read_text(encoding="utf-8")

    def test_base_image_uses_an_immutable_digest(self) -> None:
        self.assertRegex(
            self.contents,
            re.compile(
                r"^FROM python:3\.13\.14-slim-bookworm@"
                r"sha256:[0-9a-f]{64} AS runtime-base$",
                re.MULTILINE,
            ),
        )
        self.assertNotIn(":latest", self.contents)

    def test_ffmpeg_package_is_version_pinned(self) -> None:
        self.assertIn("ffmpeg=7:5.1.9-0+deb12u1", self.contents)
        self.assertNotRegex(self.contents, r"\bapt-get upgrade\b")

    def test_runtime_is_non_root_and_has_private_work_directory(self) -> None:
        self.assertIn("--uid 10001", self.contents)
        self.assertIn("--gid 10001", self.contents)
        self.assertIn("--mode 0700", self.contents)
        self.assertIn("USER 10001:10001", self.contents)
        self.assertNotIn("USER root", self.contents)

    def test_runtime_entrypoint_is_the_run_once_module(self) -> None:
        self.assertRegex(
            self.contents,
            re.compile(
                r'^FROM runtime-base AS runtime\n\n'
                r'ENTRYPOINT \["python", "-m", '
                r'"audio_converter\.hosted_entrypoint"\]$',
                re.MULTILINE,
            ),
        )

    def test_image_does_not_define_or_copy_a_processor_secret(self) -> None:
        self.assertNotRegex(self.contents, r"(?m)^(?:ARG|ENV) .*TOKEN")
        self.assertNotIn("AUDIO_PROCESSOR_TOKEN", self.contents)
        dockerignore = (SERVICE_ROOT / ".dockerignore").read_text(encoding="utf-8")
        self.assertEqual(
            [line for line in dockerignore.splitlines() if line.startswith("!")],
            [
                "!Dockerfile",
                "!audio_converter/",
                "!audio_converter/**",
                "!scripts/",
                "!scripts/verify_runtime_fixture.py",
            ],
        )

    def test_verification_target_uses_the_same_runtime_base(self) -> None:
        self.assertIn("FROM runtime-base AS verification", self.contents)
        self.assertIn(
            'ENTRYPOINT ["python", "/opt/music-audio/verify_runtime_fixture.py"]',
            self.contents,
        )


if __name__ == "__main__":
    unittest.main()
