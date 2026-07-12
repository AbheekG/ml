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

The local React/TypeScript PWA and Cloudflare Worker scaffold is operational. It includes responsive Songs/Account shells, online/offline status, a JSON health endpoint, type checking, API tests, and production builds. Migration schema and importer work is next.

Cloud resources will be created from documented configuration only after local validation.

## Local development

Requirements: Node.js 24 LTS and npm.

```bash
npm install
npm run dev
```

The local Vite/Worker server prints its URL, normally `http://127.0.0.1:5173`. Useful checks:

```bash
npm run typecheck
npm test
npm run build
```

The Worker health endpoint is `/api/health`. Generated dependencies, build output, Wrangler state, secrets, and local databases are ignored by Git.
