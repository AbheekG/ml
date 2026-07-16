# Architectural Decision Record: Legacy Projects Consolidation

## Context

Historically, the codebase was developed with path dependencies pointing directly to two private legacy folders located at the root of the workspace:
* `appsheet/`: Contains the primary relational source database (`data.xlsx`), scans, and audio recordings.
* `woodchime/`: An older SQLite/Flask prototype used for reference.

Adding a third older legacy folder (containing original high-quality scan sources) directly in the root would increase root-level folder clutter.

## Decision

We decided to group all private, untracked legacy folders under a unified `legacy/` subdirectory in the workspace root:
1. `appsheet/` was moved to `legacy/appsheet/`.
2. `woodchime/` was moved to `legacy/woodchime/`.
3. The `.gitignore` was modified to ignore the entire `legacy/` directory rather than naming subfolders individually. Any additional legacy folders dropped into this location will be ignored automatically.

## Updates Made

All internal tools, configuration objects, test scripts, and documentation referencing legacy paths were updated:
* **Scripts**: `appsheet-import.ts`, `audio-integration-executor.ts`, `plan-audio-integration.ts`, `plan-scan-fingerprint-backfill.ts`, `scan-fingerprint-backfill-executor.ts`, and `upload-r2.ts`.
* **TypeScript Tests**: `plan-audio-integration.test.ts`, `plan-scan-fingerprint-backfill.test.ts`, and `scan-fingerprint-backfill-executor.test.ts`.
* **Python Safety Module & Tests**: `services/audio-converter/audio_converter/safety.py` and `services/audio-converter/tests/test_cli.py`.
* **Docs**: `AGENTS.md`, `README.md`, `audio-processing.md`, and `implementation-plan.md`.

## Implications for Future Agents

* Any script expecting legacy inputs/outputs must check and resolve paths under `legacy/` (e.g., `legacy/appsheet/data.xlsx` or `legacy/appsheet/scans`).
* Do not put untracked folders directly in the workspace root; place them under `legacy/` to keep the workspace clean and ensure they are automatically ignored by Git.
* Safety checks block operations writing to folders in `legacy/` to protect legacy data from accidental mutations.
