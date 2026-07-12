# Music Library workspace guidance

## Purpose and current phase

This workspace is for a small, private song library used by roughly 3–4 trusted people on iPhone, iPad, Android, and the web. The product and implementation direction is approved for iterative development. Keep production deployment, DNS changes, destructive migration, and other irreversible external actions behind explicit owner approval.

The intended product behavior is:

- song metadata and typed lyrics are searchable and available offline;
- scans, images, and audio may require a network connection;
- the app is installable as a PWA, without App Store distribution;
- the interface is mobile-first and remains usable on tablets and desktop browsers;
- maintenance, cost, and operational work stay very low.

## Legacy projects and source of truth

- `appsheet/` is the newest attempt and the migration source of truth. Its `data.xlsx` workbook contains the current relational data; `scans/` and `recordings/` contain the referenced media.
- `woodchime/` is an older Flask/SQLite prototype. Treat it as a source of product ideas only, especially its phonetic/transliteration search. Do not use its schema or authentication design as the base of a new app.
- Both legacy folders are intentionally gitignored and contain private/user-owned data. Never rename, normalize, delete, convert, or edit anything in them in place.
- Put private investigation notes in `notes/private/`, which is also intentionally gitignored. Do not include song titles, lyrics, personal names, email addresses, or media in tracked fixtures or logs.

## Data and migration safety

- Preserve all AppSheet IDs during migration so relationships and file references remain stable.
- Migration/import tools must be idempotent, support dry runs, and report counts, duplicate keys, orphaned references, missing files, and unreferenced files.
- Copy data into a new system; never make the legacy folders the writable runtime store.
- Do not delete the AppSheet/Google Drive version at cutover. Keep it as a read-only fallback until the new app has been accepted and separately backed up.
- Treat uploaded media as private. Do not create public buckets or permanent unauthenticated media URLs.
- Model typed lyric versions as strict Song children with explicit language, script, and representation. Import each existing combined block intact as a legacy lyric record; never auto-split it.
- Never cascade-delete a Song. Block Song deletion while any lyric text, scan, or recording record exists, including trashed children. Child and empty-Song deletions must be recoverable before later administrative cleanup.

## Product and engineering constraints

- Prefer a local-first read model: cache the app shell, metadata, lookup data, and typed lyrics on each device; do not precache the full media collection.
- Search should eventually run locally and return results immediately. It must cover Latin/native titles and typed lyrics, with typo-tolerant transliteration behavior tested against owner-provided examples. Defer advanced phonetic ranking until data display, online editing, authentication, offline reads, and media behavior are working; start later from the legacy woodchime/AppSheet algorithms and improve them with acceptance examples.
- The first release must disable editing and uploads while offline, with a clear offline indicator. Offline reading/search is the hard requirement. Do not add an offline mutation queue or conflict-resolution system unless the owner later changes this requirement.
- Use individual accounts/allowlisted identities, not a shared application password. Sessions should persist on trusted devices so normal use does not repeatedly prompt for login.
- Support one primary editor initially. Keep authorization role-based so one or two additional editors can be enabled later, and record created/updated timestamps and user identity for mutations.
- Normalize newly uploaded audio to one browser-safe playback format while retaining the original when appropriate.
- Build the smallest complete vertical slice first: sign in, sync/cache catalog, basic local search/filtering, song detail, lyrics, scan viewing, and audio playback. Add editing/upload and administration after that slice is accepted. Defer advanced phonetic/transliteration ranking to a later phase.
- Add automated tests for schema constraints, authorization, import reconciliation, offline startup, local search, and media access. Test on real Safari/iOS and Chrome/Android before cutover.

## Working practices

- Keep architecture and migration decisions in concise Markdown records outside private notes when they no longer contain private data.
- Keep secrets out of the repository. Supply `.env.example` files with placeholder names only.
- Before changing schema or migration behavior, re-run inventory checks and state the expected row/file count changes.
- Preserve unrelated user changes in this workspace and ask before any destructive or externally visible operation.
