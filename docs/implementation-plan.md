# Music Library implementation plan

Status: approved direction; execute iteratively and validate each phase on real data and devices.

## Technical shape

Use one TypeScript Cloudflare Worker project that serves both the PWA static assets and the authenticated API from one origin. Bind the Worker to:

- D1 for relational catalog data and audit history;
- private R2 for scans, original audio, and playback derivatives;
- Cloudflare Access for allowlisted identity at the deployed boundary.

Proposed application tooling:

- React + TypeScript + Vite for the interface;
- a small Worker API, preferably Hono or similarly minimal routing;
- IndexedDB for the offline catalog;
- a service worker for install/offline startup;
- SQL migration files as the authoritative D1 schema;
- runtime input validation;
- Vitest for unit/import tests and Playwright for key browser flows.

Keep dependencies modest and pin an LTS Node.js version. Develop locally before creating production cloud resources.

## Environments

- **Local:** local D1/R2 emulation and a sanitized or private local import; no cloud dependency for routine development.
- **Staging:** real Cloudflare bindings, private access, and a copy of data for device testing.
- **Production:** separate D1 database and R2 bucket, created only after staging acceptance.

Never point development code at production data by default.

## Phase 1 — foundation and importer

1. Scaffold the TypeScript application, formatting, linting, tests, and local Worker configuration.
2. Define a maintainable schema using clear domain names rather than copying spreadsheet column names mechanically.
3. Build a read-only workbook/media importer with dry-run mode.
4. Preserve legacy IDs and lyric blocks while normalizing known case-only reference errors.
5. Produce reconciliation output for every table, relationship, and media object.
6. Add tests for duplicate keys, orphan prevention, lyric migration, and delete guards.

Deliverable: repeatable local database creation from `appsheet/data.xlsx` with no legacy modification.

## Phase 2 — read-only PWA

1. Build the catalog list, basic local search, filters, and sorting.
2. Build song detail with lyric variants, scans, recordings, credits, tags, languages, and notes.
3. Add IndexedDB catalog storage and atomic background refresh.
4. Add installable/offline app shell and explicit offline UI.
5. Add private scan viewing and audio streaming/playback.
6. Validate layout and behavior on iPhone/iPad and Android.

Deliverable: a useful staging application that can read the real catalog offline and consume media online.

## Phase 3 — online editing and safety

1. Add viewer/editor/admin authorization.
2. Add Song and Lyric text create/edit/trash/restore workflows.
3. Add Scan and Recording metadata/upload/replace/trash/restore workflows.
4. Add actor/timestamp audit metadata.
5. Enforce no-orphan foreign keys and no-cascade Song deletion.
6. Refuse Song deletion while any Lyric text, Scan, or Recording exists and link the editor to those dependencies.
7. Retain replaced/deleted media long enough for recovery and add deliberate later cleanup.
8. Add copy/share for one lyric representation using the device share sheet with clipboard fallback.

Deliverable: safe online maintenance by the primary editor.

## Phase 4 — beta and cutover

1. Run staging with the primary editor and at least one viewer.
2. Collect feedback from normal tasks instead of attempting exhaustive up-front design.
3. Fix usability and playback issues, test restore/recovery, and verify usage alerts/quotas.
4. Freeze AppSheet writes briefly, run final reconciliation/import, and deploy production.
5. Retain AppSheet/Google Drive read-only as a migration fallback and independent backup.

## Phase 5 — later improvements

- advanced phonetic/transliteration ranking from tested real queries;
- optional script suggestions for new lyric text;
- selected scan/audio sharing with explicit privacy semantics;
- favorites, playlists, set lists, or recently viewed only if actual use calls for them;
- automated transcription/OCR only after the core library is trusted.

## Feedback loop

Each phase follows the same small loop:

1. implement the narrow workflow;
2. test automatically;
3. use it with real catalog data;
4. test on actual mobile devices;
5. collect concrete friction/requests;
6. adjust before expanding scope.

The product plan is a strong starting hypothesis, not a frozen screen specification.

## Owner actions before first staging deployment

1. Create or identify a Cloudflare Free account.
2. Enable two-factor authentication and save recovery codes securely.
3. Do not share the password, recovery codes, global API key, or long-lived API tokens with Codex.
4. Do not change `abheekghosh.com` nameservers or DNS yet. Initial staging uses a Cloudflare-provided URL.
5. When requested, authorize Wrangler through its browser login on this Mac; this grants scoped CLI access without placing account credentials in the repository.
6. Later provide the allowlisted email addresses and desired viewer/editor roles through a private local configuration—not chat or tracked files if privacy is preferred.
7. Test the staging PWA on at least one Apple mobile device and one Android device when a URL is ready.

Cloud resources (D1, R2, Access policy, and deployment) should be created from checked-in configuration/commands after the local vertical slice exists, rather than manually creating loosely documented resources in advance.
