# Music Library

A private, installable song-library PWA for a small group using iPhone, iPad, Android, and desktop browsers.

The application is being rebuilt from two private legacy attempts. The AppSheet workbook and media are the migration source; the older woodchime Flask project is reference material only. Neither legacy directory is tracked by Git.

## Product direction

- catalog and typed lyrics available offline after an initial authenticated sync;
- scans and recordings private and available online;
- online-only editing with clear offline state;
- one primary editor initially, with viewer/editor/admin roles and audit history;
- strict Song children for lyric texts, scans, and recordings;
- no cascading Song deletion;
- installable PWA without App Store distribution;
- Cloudflare Worker + D1 + private R2 + Access deployment, validated in staging before production;
- advanced phonetic/transliteration search after the core catalog works.

See [the product plan](docs/product-plan.md) and [the implementation plan](docs/implementation-plan.md).

## Repository privacy

The following local directories are intentionally ignored:

- `appsheet/` — private workbook, scans, recordings, and legacy scripts;
- `woodchime/` — old private prototype;
- `notes/private/` — private assessments and captures.

Do not commit song titles, lyrics, names, email addresses, media, credentials, generated imports, or local Cloudflare state.

## Current status

The private staging application is operational:

- the normalized D1 schema and guarded relationships are implemented;
- the AppSheet importer validates and loads all 454 songs plus related lyrics and media metadata into local D1;
- the responsive catalog reads real local data, searches titles, aliases, typed lyrics, and relevant metadata, and composes offline Language/Tag/Person-role/Notebook/status/media filters with six local sort choices;
- song detail displays metadata, typed lyrics, scan records, and recording records;
- the complete catalog, metadata, and typed lyrics are atomically cached in IndexedDB, while the production app shell and hashed assets are precached by a service worker;
- private scans open in an in-app zoom/pan viewer and recordings stream with seeking;
- type checks, importer/schema/API tests, production builds, and local end-to-end API smoke tests pass.

- a reconciled forward migration enforces normalized active Song titles, statuses, controlled lookup keys, simplified typed lyrics, Recording descriptions, and Trash safety;
- all imported row and media-reference counts remain unchanged, with legacy Scan/Recording metadata retained privately;
- authenticated identities must map to an active `app_users` record, with reusable viewer/editor/admin authorization guards;
- the authenticated session exposes the current viewer/editor/admin role without exposing the identity;
- editors/admins can create and update Song titles, status, Languages, Tags, Aliases, and Notes only while online;
- editors/admins can independently assign existing People to Song-level Lyrics and Music credits;
- the API normalizes title case, validates controlled references, records actor/timestamps, and updates all Song relationships atomically;
- revisions and per-request mutation identifiers reject stale concurrent edits without allowing their related Language/Tag/Alias changes to leak through;
- editors/admins can create, edit, move to Trash, and restore typed-lyric blocks;
- editors/admins can move an active-child-free Song to recoverable Trash and restore it; Songs with active typed lyrics, Scans, or Recordings are blocked with dependency guidance;
- editors/admins can edit Scan Notebook/Page metadata and move existing Scans and their private media to recoverable Trash or restore them;
- editors/admins can edit existing Recording descriptions, dates, and Vocals credits, and move Recordings and unshared private media to recoverable Trash or restore them;
- editors/admins can add and rename controlled Languages, Tags, Notebooks, and People from a compact searchable screen; normalized duplicates are blocked, likely similar names require confirmation, and deletion is intentionally unavailable;
- editors/admins can choose an existing image or request mobile rear-camera capture for a new private JPEG, PNG, or WebP Scan; file signatures, size, and SHA-256 are checked, exact-content duplicates identify the existing Song/Notebook/Page, and failed database finalization removes the uncommitted R2 object;
- Scan replacement, image derivatives/compression, Recording upload/replace, and broader Recording contribution roles remain later incremental slices.

The private staging catalog is loaded into an APAC-primary D1 database for the application's users in India. All 1,325 workbook-linked media files are stored in private APAC R2 and delivered only through the authenticated API. Two unassigned legacy recordings and two unlinked scans remain local for later identification.

Staging URL: `https://app.musiclibrary.workers.dev`. The Cloudflare Worker is named `app`; the project, service identifier, browser database, and D1 database retain their descriptive `music-library` names.

Staging is protected by Cloudflare Access using an exact-email allowlist and email one-time PIN. The Worker also validates Access JWT signatures, issuer, and audience on every API request. Access audience/JWKS identifiers are deployment configuration, not secret credentials; local development overrides `AUTH_MODE` through ignored `.dev.vars`.

## Local development

Requirements: Node.js 24 LTS and npm.

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

The local Vite/Worker server prints its URL, normally `http://127.0.0.1:5173`. Useful checks:

```bash
npm run typecheck
npm test
npm run build
```

The Worker endpoints include health/session, catalog/offline-library, Song detail/editor options and writes, and authenticated private media delivery. Generated dependencies, build output, Wrangler state, secrets, and local databases are ignored by Git.

## Legacy import validation

Run the importer without writing output:

```bash
npm run import:appsheet
```

To generate a normalized private catalog and validate it against the local relational schema:

```bash
npm run import:appsheet -- --write
npm run db:load-local
```

Generated files stay under ignored `data/import-output/` and `data/local/` directories. The source workbook and media are read-only inputs and are never modified.

Database migrations live in `migrations/`. See [the data model](docs/data-model.md) for the main relationships and safety rules.

## Private media upload

Preview the resumable upload without changing R2:

```bash
npm run media:upload
```

Upload only workbook-linked media to the private staging bucket:

```bash
npm run media:upload -- --write
```

Progress is stored under ignored `data/import-output/`; private filenames are not printed. Unlinked files are preserved locally and excluded from upload.
