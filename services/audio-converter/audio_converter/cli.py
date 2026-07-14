from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .safety import is_opaque_label, validate_output_path
from .service import PreparationError, prepare
from .tools import FFmpegTools, MediaToolError


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
    if not is_opaque_label(options.label):
        parser.error("--label must be an opaque identifier using letters, digits, ._- only")

    tools = FFmpegTools(ffmpeg=options.ffmpeg, ffprobe=options.ffprobe)
    try:
        validate_output_path(options.output)
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
