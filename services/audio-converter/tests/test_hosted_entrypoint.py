from __future__ import annotations

import json
import tempfile
import unittest
from io import StringIO
from pathlib import Path

from audio_converter.hosted_adapter import (
    HostedAdapterConfig,
    HostedAdapterError,
    HostedRunOutcome,
)
from audio_converter.hosted_entrypoint import (
    EXIT_FAILED,
    EXIT_OK,
    EXIT_RECONCILIATION_REQUIRED,
    load_hosted_entrypoint_config,
    main,
)


WORKER_ORIGIN = "https://worker.invalid"
TOKEN = "entrypoint-secret-with-at-least-32-characters"


def environment(root: Path, **overrides: str) -> dict[str, str]:
    token_file = root / "processor-token"
    token_file.write_text(TOKEN, encoding="ascii")
    values = {
        "AUDIO_PROCESSOR_WORKER_ORIGIN": WORKER_ORIGIN,
        "AUDIO_PROCESSOR_ALLOWED_TRANSFER_ORIGINS_JSON": json.dumps([
            WORKER_ORIGIN,
        ]),
        "AUDIO_PROCESSOR_TOKEN_FILE": str(token_file),
        "AUDIO_PROCESSOR_TEMPORARY_ROOT": str(root),
    }
    values.update(overrides)
    return values


def records(output: StringIO) -> list[dict[str, object]]:
    return [json.loads(line) for line in output.getvalue().splitlines()]


class HostedEntrypointTests(unittest.TestCase):
    def test_loads_only_strict_file_secret_and_bounded_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            values = environment(
                root,
                AUDIO_PROCESSOR_REQUEST_TIMEOUT_SECONDS="45",
                AUDIO_PROCESSOR_RETRY_ATTEMPTS="2",
                AUDIO_PROCESSOR_RETRY_DELAY_SECONDS="0.5",
                AUDIO_PROCESSOR_MAX_SOURCE_BYTES="1024",
                AUDIO_PROCESSOR_MAX_DERIVATIVE_BYTES="900",
                AUDIO_PROCESSOR_MAX_GENERATED_OUTPUT_BYTES="800",
                AUDIO_PROCESSOR_SOFT_DEADLINE_SECONDS="2700",
                AUDIO_PROCESSOR_MINIMUM_LEASE_REMAINING_SECONDS="3300",
            )

            config = load_hosted_entrypoint_config(values)

            self.assertEqual(config.worker_base_url, WORKER_ORIGIN)
            self.assertEqual(config.processor_token, TOKEN)
            self.assertEqual(config.allowed_transfer_origins, {WORKER_ORIGIN})
            self.assertEqual(config.request_timeout_seconds, 45)
            self.assertEqual(config.retry_attempts, 2)
            self.assertEqual(config.retry_delay_seconds, 0.5)
            self.assertEqual(config.max_source_bytes, 1024)
            self.assertEqual(config.max_derivative_bytes, 900)
            self.assertEqual(config.max_generated_output_bytes, 800)
            self.assertEqual(config.processing_deadline_seconds, 2700)
            self.assertEqual(config.minimum_lease_remaining_seconds, 3300)

    def test_rejects_environment_secret_unknown_keys_and_malformed_values(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            cases = (
                {"AUDIO_PROCESSOR_TOKEN": TOKEN},
                {"AUDIO_PROCESSOR_TYPO": "value"},
                {"AUDIO_PROCESSOR_RETRY_ATTEMPTS": "2.0"},
                {"AUDIO_PROCESSOR_REQUEST_TIMEOUT_SECONDS": "nan"},
                {"AUDIO_PROCESSOR_ALLOWED_TRANSFER_ORIGINS_JSON": "[]"},
                {"AUDIO_PROCESSOR_TEMPORARY_ROOT": "relative"},
            )
            for overrides in cases:
                with self.subTest(overrides=tuple(overrides)):
                    with self.assertRaises(HostedAdapterError):
                        load_hosted_entrypoint_config(environment(root, **overrides))

    def test_rejects_missing_or_non_printable_secret_file(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            values = environment(root)
            Path(values["AUDIO_PROCESSOR_TOKEN_FILE"]).write_text(
                TOKEN + "\n",
                encoding="ascii",
            )
            with self.assertRaisesRegex(HostedAdapterError, "invalid_processor_token_file"):
                load_hosted_entrypoint_config(values)

            values["AUDIO_PROCESSOR_TOKEN_FILE"] = str(root / "missing")
            with self.assertRaisesRegex(HostedAdapterError, "invalid_processor_token_file"):
                load_hosted_entrypoint_config(values)

    def test_no_work_and_success_emit_one_aggregate_record_and_exit_zero(self) -> None:
        cases = (
            (HostedRunOutcome(status="no_work"), "no_work", None),
            (
                HostedRunOutcome(status="succeeded", playback_kind="derivative"),
                "succeeded",
                "derivative",
            ),
        )
        for outcome, expected_status, playback_kind in cases:
            with self.subTest(outcome=expected_status):
                with tempfile.TemporaryDirectory() as raw_root:
                    output = StringIO()
                    calls = 0

                    def run_once(config: HostedAdapterConfig) -> HostedRunOutcome:
                        nonlocal calls
                        calls += 1
                        self.assertEqual(config.processor_token, TOKEN)
                        return outcome

                    timestamps = iter((10.0, 10.125))
                    exit_code = main(
                        environment=environment(Path(raw_root)),
                        output=output,
                        monotonic=lambda: next(timestamps),
                        run_once=run_once,
                    )

                    self.assertEqual(exit_code, EXIT_OK)
                    self.assertEqual(calls, 1)
                    self.assertEqual(len(records(output)), 1)
                    self.assertEqual(records(output)[0]["outcome"], expected_status)
                    self.assertEqual(records(output)[0]["elapsedMilliseconds"], 125)
                    self.assertEqual(records(output)[0].get("playbackKind"), playback_kind)
                    self.assertNotIn(TOKEN, output.getvalue())
                    self.assertNotIn(str(raw_root), output.getvalue())

    def test_durably_reported_failure_is_aggregate_and_nonzero(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            output = StringIO()
            exit_code = main(
                environment=environment(Path(raw_root)),
                output=output,
                run_once=lambda config: HostedRunOutcome(
                    status="failed",
                    error_code="source_decode_failed",
                    failure_reported=True,
                ),
            )

            self.assertEqual(exit_code, EXIT_FAILED)
            self.assertEqual(records(output)[0]["outcome"], "failed")
            self.assertEqual(records(output)[0]["errorCode"], "source_decode_failed")

    def test_ambiguous_delivery_requires_reconciliation_without_error_detail(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            output = StringIO()

            def ambiguous(config: HostedAdapterConfig) -> HostedRunOutcome:
                raise HostedAdapterError("result_delivery_ambiguous")

            exit_code = main(
                environment=environment(Path(raw_root)),
                output=output,
                run_once=ambiguous,
            )

            self.assertEqual(exit_code, EXIT_RECONCILIATION_REQUIRED)
            self.assertEqual(records(output)[0]["outcome"], "reconciliation_required")
            self.assertNotIn("errorCode", records(output)[0])

    def test_invalid_configuration_and_unexpected_errors_never_log_private_values(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            invalid_output = StringIO()
            invalid_values = environment(root)
            invalid_values["AUDIO_PROCESSOR_TOKEN"] = TOKEN
            self.assertEqual(
                main(environment=invalid_values, output=invalid_output),
                EXIT_FAILED,
            )
            self.assertEqual(len(records(invalid_output)), 1)
            self.assertEqual(
                records(invalid_output)[0]["errorCode"],
                "processor_token_environment_forbidden",
            )

            private_value = "private-job-capability-and-path"
            unexpected_output = StringIO()

            def unexpected(config: HostedAdapterConfig) -> HostedRunOutcome:
                raise RuntimeError(private_value)

            self.assertEqual(
                main(
                    environment=environment(root),
                    output=unexpected_output,
                    run_once=unexpected,
                ),
                EXIT_FAILED,
            )
            self.assertEqual(
                records(unexpected_output)[0]["errorCode"],
                "audio_processor_internal_error",
            )
            combined = invalid_output.getvalue() + unexpected_output.getvalue()
            self.assertNotIn(TOKEN, combined)
            self.assertNotIn(private_value, combined)
            self.assertNotIn(str(root), combined)

    def test_incomplete_outcome_is_reconciliation_required(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            output = StringIO()
            exit_code = main(
                environment=environment(Path(raw_root)),
                output=output,
                run_once=lambda config: HostedRunOutcome(status="failed"),
            )
            self.assertEqual(exit_code, EXIT_RECONCILIATION_REQUIRED)
            self.assertEqual(records(output)[0]["outcome"], "reconciliation_required")


if __name__ == "__main__":
    unittest.main()
