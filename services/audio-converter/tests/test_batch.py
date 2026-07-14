from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from audio_converter.batch import (
    BatchManifestError,
    find_unexpected_output_files,
    load_batch_manifest,
    run_batch,
)
from audio_converter.batch_cli import validate_detail_report_path
from audio_converter.models import Decision, DecisionKind
from audio_converter.service import (
    FileSummary,
    PreparationError,
    PreparationResult,
)


def write_manifest(
    root: Path,
    jobs: list[dict[str, str]],
) -> Path:
    path = root / "batch.json"
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "outputRoot": "outputs",
                "jobs": jobs,
            }
        ),
        encoding="utf-8",
    )
    return path


def file_summary(
    *,
    sha256: str,
    codec: str,
    byte_size: int,
    warnings: bool = False,
) -> FileSummary:
    return FileSummary(
        sha256=sha256,
        byte_size=byte_size,
        codec=codec,
        containers=(codec,),
        duration_seconds=10,
        bit_rate=128_000,
        sample_rate=44_100,
        channels=1,
        had_decode_warnings=warnings,
    )


class BatchManifestTests(unittest.TestCase):
    def test_relative_paths_are_resolved_from_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "inputs" / "source.bin"
            source.parent.mkdir()
            source.write_bytes(b"source")
            manifest_path = write_manifest(
                root,
                [
                    {
                        "label": "media-1",
                        "input": "inputs/source.bin",
                        "output": "outputs/media-1.mp3",
                    }
                ],
            )

            manifest = load_batch_manifest(manifest_path)

            self.assertEqual(manifest.jobs[0].source, source.resolve())
            self.assertEqual(
                manifest.jobs[0].output,
                (root / "outputs" / "media-1.mp3").resolve(),
            )

    def test_duplicate_labels_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = write_manifest(
                root,
                [
                    {
                        "label": "media-1",
                        "input": "input-1.bin",
                        "output": "outputs/media-1.mp3",
                    },
                    {
                        "label": "media-1",
                        "input": "input-2.bin",
                        "output": "outputs/media-2.mp3",
                    },
                ],
            )

            with self.assertRaisesRegex(
                BatchManifestError,
                "duplicate_batch_label",
            ):
                load_batch_manifest(manifest_path)

    def test_output_outside_declared_root_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = write_manifest(
                root,
                [
                    {
                        "label": "media-1",
                        "input": "input.bin",
                        "output": "elsewhere/media-1.mp3",
                    }
                ],
            )

            with self.assertRaisesRegex(
                BatchManifestError,
                "batch_output_outside_output_root",
            ):
                load_batch_manifest(manifest_path)

    def test_unexpected_output_file_is_reported(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output_root = root / "outputs"
            output_root.mkdir()
            (output_root / "unexpected.mp3").write_bytes(b"unexpected")
            manifest_path = write_manifest(
                root,
                [
                    {
                        "label": "media-1",
                        "input": "input.bin",
                        "output": "outputs/media-1.mp3",
                    }
                ],
            )
            manifest = load_batch_manifest(manifest_path)

            unexpected = find_unexpected_output_files(manifest)

            self.assertEqual(len(unexpected), 1)


class BatchRunTests(unittest.TestCase):
    def test_batch_aggregates_results_errors_warnings_and_duplicates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = write_manifest(
                root,
                [
                    {
                        "label": "media-1",
                        "input": "input-1.bin",
                        "output": "outputs/media-1.mp3",
                    },
                    {
                        "label": "media-2",
                        "input": "input-2.bin",
                        "output": "outputs/media-2.mp3",
                    },
                    {
                        "label": "media-3",
                        "input": "input-3.bin",
                        "output": "outputs/media-3.mp3",
                    },
                ],
            )
            manifest = load_batch_manifest(manifest_path)

            def fake_prepare(
                tools,
                source: Path,
                *,
                output: Path,
                execute: bool,
            ) -> PreparationResult:
                if source.name == "input-3.bin":
                    raise PreparationError("fixture_failure")
                if source.name == "input-1.bin":
                    return PreparationResult(
                        status="original_is_playback",
                        decision=Decision(
                            DecisionKind.USE_ORIGINAL,
                            "canonical_mp3",
                        ),
                        original=file_summary(
                            sha256="a" * 64,
                            codec="mp3",
                            byte_size=100,
                            warnings=True,
                        ),
                    )
                return PreparationResult(
                    status="would_create_derivative",
                    decision=Decision(
                        DecisionKind.REQUIRE_DERIVATIVE,
                        "noncanonical_audio_requires_mp3",
                    ),
                    original=file_summary(
                        sha256="a" * 64,
                        codec="aac",
                        byte_size=200,
                    ),
                )

            batch = run_batch(
                object(),
                manifest,
                execute=False,
                workers=2,
                prepare_one=fake_prepare,
            )
            aggregate = batch.aggregate()

            self.assertEqual(aggregate["jobs"], 3)
            self.assertEqual(aggregate["successful"], 2)
            self.assertEqual(aggregate["failed"], 1)
            self.assertEqual(
                aggregate["sourceFilesWithRecoverableDecodeErrors"],
                1,
            )
            self.assertEqual(aggregate["sourceBytes"], 300)
            self.assertEqual(aggregate["duplicateContentGroups"], 1)
            self.assertEqual(aggregate["duplicateContentFiles"], 2)
            self.assertEqual(
                aggregate["errorCounts"],
                {"fixture_failure": 1},
            )
            self.assertNotIn("input-1.bin", json.dumps(aggregate))

    def test_run_stops_before_processing_unexpected_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output_root = root / "outputs"
            output_root.mkdir()
            (output_root / "unexpected.mp3").write_bytes(b"unexpected")
            manifest_path = write_manifest(
                root,
                [
                    {
                        "label": "media-1",
                        "input": "input.bin",
                        "output": "outputs/media-1.mp3",
                    }
                ],
            )
            manifest = load_batch_manifest(manifest_path)

            with self.assertRaisesRegex(
                BatchManifestError,
                "unexpected_batch_output_files",
            ):
                run_batch(
                    object(),
                    manifest,
                    execute=False,
                    workers=1,
                )


class BatchReportSafetyTests(unittest.TestCase):
    def test_detail_report_cannot_replace_manifest_input_or_enter_output_root(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.bin"
            source.write_bytes(b"source")
            manifest_path = write_manifest(
                root,
                [
                    {
                        "label": "media-1",
                        "input": "input.bin",
                        "output": "outputs/media-1.mp3",
                    }
                ],
            )
            manifest = load_batch_manifest(manifest_path)

            cases = (
                (manifest_path, "report_replaces_batch_manifest"),
                (source, "report_replaces_batch_input"),
                (
                    root / "outputs" / "details.json",
                    "report_inside_batch_output_root",
                ),
            )
            for report_path, error_code in cases:
                with self.subTest(error_code=error_code):
                    with self.assertRaisesRegex(
                        BatchManifestError,
                        error_code,
                    ):
                        validate_detail_report_path(
                            report_path,
                            batch_manifest_path=manifest_path,
                            manifest=manifest,
                        )


if __name__ == "__main__":
    unittest.main()
