from __future__ import annotations

import re
from pathlib import Path

from .service import PreparationError


PROJECT_ROOT = Path(__file__).resolve().parents[3]
PROTECTED_OUTPUT_ROOTS = (
    PROJECT_ROOT / "appsheet",
    PROJECT_ROOT / "woodchime",
)
OPAQUE_LABEL_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def is_opaque_label(label: str) -> bool:
    return OPAQUE_LABEL_PATTERN.fullmatch(label) is not None


def is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def validate_output_path(output: Path | None) -> None:
    if output is None:
        return
    resolved = output.resolve(strict=False)
    if resolved.suffix.casefold() != ".mp3":
        raise PreparationError("output_must_have_mp3_extension")
    if any(
        is_within(resolved, root.resolve())
        for root in PROTECTED_OUTPUT_ROOTS
    ):
        raise PreparationError("output_inside_protected_legacy_root")
