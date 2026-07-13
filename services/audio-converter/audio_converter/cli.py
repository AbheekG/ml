from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from .service import PreparationError, prepare
from .tools import FFmpegTools, MediaToolError


PROJECT_ROOT = Path(__file__).resolve().parents[3]
PROTECTED_OUTPUT_ROOTS = (
    PROJECT_ROOT / "appsheet",
    PROJECT_ROOT / "woodchime",
)
OPAQUE_LABEL_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _validate_output(output: Path | None) -> None:
    if output is None:
        return
    resolved = output.resolve(strict=False)
    if resolved.suffix.casefold() != ".mp3":
        raise PreparationError("output_must_have_mp3_extension")
    if any(_is_within(resolved, root.resolve()) for root in PROTECTED_OUTPUT_ROOTS):
        raise PreparationError("output_inside_protected_legacy_root")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Inspect audio and prepare a verified MP3 playback derivative.",
    )
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--label", default="media")
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Create a derivative. Without this flag the command is read-only.",
    )
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    return parser


def main(arguments: list[str] | None = None) -> int:
    parser = build_parser()
    options = parser.parse_args(arguments)
    if not OPAQUE_LABEL_PATTERN.fullmatch(options.label):
        parser.error("--label must be an opaque identifier using letters, digits, ._- only")

    tools = FFmpegTools(ffmpeg=options.ffmpeg, ffprobe=options.ffprobe)
    try:
        _validate_output(options.output)
        tools.require_available()
        result = prepare(
            tools,
            options.input,
            output=options.output,
            execute=options.execute,
        )
    except (MediaToolError, PreparationError, OSError) as error:
        code = getattr(error, "code", "filesystem_error")
        print(
            json.dumps(
                {
                    "label": options.label,
                    "status": "error",
                    "error": code,
                },
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 2

    print(json.dumps(result.to_dict(options.label), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
