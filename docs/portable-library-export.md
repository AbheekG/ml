# Portable library export and tested recovery

Status: profile 1.0.0, the frozen admin API, private browser kit,
standard-library Python builder/verifier/inspector/local restore, and
synthetic/adversarial/round-trip coverage are implemented. Migrations through
`0022`, the Worker/client, a real authenticated plan, private kit download,
bounded media/range verification, revocation, and derived-detail cleanup are
accepted in protected staging; only the full local archive remains manual
acceptance. This record does
not authorize a production/DNS change, a catalog or media mutation, an R2 write
or deletion, a legacy change, or a full-cloud import feature.

This decision defines an admin-only export that produces a complete, private,
human-readable preservation archive of the durable library. The archive is
portable enough to reuse outside this application and precise enough to
reconstruct the current catalog, relationships, Trash state, retained media,
replacement history, and provenance.

The archive is built on the administrator's computer. Cloudflare produces a
small frozen export kit and streams the kit's declared private objects through
the existing authenticated Worker. Cloudflare never assembles or temporarily
stores the multi-gigabyte final ZIP.

The companion recovery work deliberately stops at verification and a tested
local reference restore. There is no normal in-app or one-click cloud import.

See [the normative archive profile](portable-library-archive-profile.md) for
the exact package structure, metadata contract, naming rules, and validation
requirements. See
[the operator runbook](portable-library-export-runbook.md) for the concise
build, verification, inspection, restore, privacy, and current provider-limit
instructions.

## Decision summary

The selected workflow is:

```text
Admin browser
    |
    | Access identity + active application admin role
    v
Prepare a frozen metadata/media plan in D1
    |
    | download a small private export kit
    v
Local Python builder
    |
    | cloudflared end-user Access token
    | four bounded, resumable authenticated downloads
    v
Verified local object cache
    |
    | deterministic BagIt + RO-Crate packaging
    v
ZIP64 preservation archive
    |
    +--> verify / inspect
    |
    +--> tested local reference restore
```

The major choices are:

- use a versioned application profile layered on RO-Crate, BagIt, and ZIP64;
- keep a friendly folder for every Song and friendly files for typed lyrics,
  Scan representations, and Recording representations;
- keep one consolidated nested catalog metadata file as the authoritative
  portable model;
- preserve stable IDs, relations, Trash, audit attribution, original upload
  provenance, replacement history, media fingerprints, and derivative
  provenance;
- include every durable `media_objects` object and every registered Scan
  readability derivative, even when a durable media row is not currently
  attached to a Song;
- do not include abandoned multipart-upload bytes or other unregistered R2
  objects merely because they remain in the bucket;
- never duplicate a Recording's bytes merely to label one relationship
  “original” and another “playback”;
- perform downloads and archive assembly locally using a fixed, reviewed Python
  program included in the kit;
- keep all network requests behind the existing Cloudflare Access application;
- rely on many short-lived invocations of the same deployed Worker program, not
  many separately deployed Workers;
- do not store the final archive in R2;
- make the UI say clearly that a kit is not a backup until the local builder
  finishes and reports a fully verified archive; and
- build a verifier and local reference restore for round-trip tests, while
  deferring a cloud import adapter and import UI until a real recovery need.

## Product boundary

### What “the whole library” means

The export contains the durable information needed to understand and reconstruct
the library:

- every active and trashed Song;
- all Languages, Tags, Notebooks, People, Aliases, credits, and ordering
  relationships;
- every active and trashed typed-lyrics block, with its exact UTF-8 content and
  stable order;
- every active and trashed Scan, its metadata, display orientation, original
  bytes, registered readability derivative when present, and replacement
  history;
- every active and trashed Recording, its metadata and credits, original bytes,
  playback relationship, playback derivative when present, and replacement
  history;
- every durable media row, including original filename provenance, MIME type,
  size, SHA-256, kind, state, timestamps, and actor attribution;
- immutable audio and Scan derivative provenance;
- the information required to preserve known historical equal-content Scan
  records without silently merging them;
- immutable Scan/Recording parent-move history;
- stable IDs, revisions, timestamps, actor identifiers, hidden legacy metadata,
  and other application fields required for a faithful Music Library restore;
  and
- a historical actor directory sufficient to interpret attribution.

Archived actors are data, not credentials. A future restore must not
automatically reactivate archived accounts or recreate Access policy. It must
bootstrap a destination administrator separately and require an explicit
identity/role review.

### Deliberate exclusions

This is a durable-library export, not a raw D1 dump or an R2 bucket clone. It
does not contain:

- Cloudflare Access cookies or tokens;
- passwords, one-time codes, API tokens, Worker secrets, Google credentials, or
  Cloudflare account credentials;
- Access application/policy configuration, DNS, account settings, billing
  settings, or deployment credentials;
- R2 object keys in any downloaded kit or final archive;
- R2 multipart upload IDs, part ETags, processor lease-token hashes, or similar
  operational capabilities;
- browser IndexedDB/cache data, service-worker caches, analytics, or provider
  logs;
- migration bookkeeping or a SQL dump;
- active or terminal upload sessions, upload parts, processor queues, dispatch
  attempts, retry leases, and maintenance-failure scheduling as restorable
  library records;
- unregistered/abandoned upload bytes that exist in R2 but have no durable media
  or derivative registration; or
- application source, cloud infrastructure, or secrets needed to deploy the
  application itself.

The archive records the exporter source commit, source schema migration level,
profile version, and aggregate excluded-operational-object count when it can be
calculated safely. It must not expose excluded storage keys or private details
in routine logs.

The source repository, migrations, infrastructure records, and newly supplied
credentials remain separate disaster-recovery inputs.

### Source-table mapping

The initial profile maps the current schema as follows. This table is a coverage
check, not permission to expose raw SQL rows or internal storage identifiers:

| Current source | Portable treatment |
| --- | --- |
| `app_users` | archived actors; observed role/state only, never restored active automatically |
| `languages`, `tags`, `notebooks`, `people` | top-level controlled records with stable IDs/order/audit fields |
| `songs`, `song_aliases`, `song_languages`, `song_tags`, `song_credits` | nested Song metadata and ordered relationships |
| `lyric_texts` | nested child metadata plus exact UTF-8 `.txt` payload |
| `scans`, `recordings`, `recording_credits` | nested children, Trash/state/audit fields, and representation relationships |
| `media_objects` | one durable representation record and one verified payload object per durable stored identity |
| `audio_derivatives` | immutable optimized-audio provenance and source/output relationship |
| `scan_readability_derivatives` | immutable optimized-Scan provenance and source/output relationship |
| `scan_media_history`, `recording_media_history` | immutable replacement history |
| `scan_fingerprints`, `scan_fingerprint_members` | portable canonical/member/historical-duplicate annotations; derived index structure need not be copied literally |
| `media_parent_moves` | immutable relationship history |
| `recording_upload_sessions`, `recording_upload_intents`, `recording_upload_parts`, `recording_upload_credits` | excluded operational workflow state |
| `audio_processing_jobs`, `audio_processing_dispatch_attempts` | excluded operational workflow/audit state; durable output provenance remains in Recording/media/derivative records |
| `scan_maintenance_failures`, `scan_maintenance_leases` | excluded retry/lease state |
| migration/runtime/export tables | excluded implementation state; source migration level is recorded |

Any later migration that adds a table or column must force a profile coverage
test to fail until that source is explicitly included, mapped into an extension,
or deliberately excluded with a documented reason. Silent omission after a
schema change is not allowed.

## Administrator experience

### UI location and authorization

The Account page gains a `Portable backup` section that is rendered only for an
authenticated `admin`. It is not an editor feature. All backing routes use
`requireRole("admin")`; hiding the UI is not the authorization boundary.

The action is available only online. The section explains:

- the export contains private catalog text, personal attribution, lyrics, and
  media;
- the downloaded kit initially contains metadata but not all media;
- Python 3 and `cloudflared` are required on the machine that will build the
  archive;
- current planned media bytes, object count, estimated final archive size, and
  conservative free-disk requirement;
- the media plan expiry time;
- that the browser may be opened once by `cloudflared` to authenticate the
  administrator;
- that the build can resume after interruption; and
- that only a final `VERIFIED` result is a usable backup.

The primary action is `Prepare export kit`. Creating the kit never changes a
Song, child, relationship, media row, or R2 object.

After preparation the UI shows:

- snapshot/export ID in abbreviated form;
- snapshot time;
- active/Trash/history counts;
- planned media-object count and total bytes;
- expiry time;
- `Download export kit`;
- `Revoke this kit`; and
- concise local commands.

Revocation affects only the derived export plan. It does not delete catalog
data, media, a previously built local archive, or the already downloaded kit.

### Status language

Use distinct terms:

- **Plan prepared** — metadata and an immutable media list were snapshotted.
- **Kit downloaded** — the small private metadata/tool package is local.
- **Media incomplete** — the builder has not verified every declared object.
- **Archive built** — the final ZIP was assembled but still requires its final
  full read-back.
- **Verified** — all BagIt/tag manifests, paths, metadata relations, sizes, and
  SHA-256 values passed.

Never label a prepared plan or downloaded kit “backup complete.”

## Frozen snapshot and D1 design

### Required consistency

Metadata and the media plan must describe one coherent logical point in time.
Fetching current tables independently over many later requests is not
acceptable: a Song edit, Trash action, replacement, or relationship change
could otherwise create an internally inconsistent archive.

Migration `0021` should introduce export-only tables with names and exact
columns selected during implementation, following this logical model:

```text
portable_export_sessions
  id
  profile_version
  state: preparing | ready | revoked | expired | failed
  source_schema_version
  source_commit
  snapshot_at
  created_at
  created_by
  expires_at
  aggregate counts and planned bytes
  metadata/plan digest
  completed/revoked/failure timestamps and bounded codes

portable_export_records
  export_id
  record_kind
  bounded storage-chunk key and order key
  frozen versioned JSON array containing stable record keys,
    deterministic order keys, and source fragments

portable_export_items
  export_id
  opaque item id
  source representation and stable source id
  private object key (server side only)
  planned payload path
  MIME type
  exact byte size
  exact SHA-256
```

The export tables are derived staging state. They must not be included inside
their own export.

One D1 `batch()` transaction creates the session, copies every included source
row into versioned snapshot records, and copies every declared media
representation into the item plan. The record copy groups at most 64 ordered
source rows into each internal JSON storage chunk. This keeps the same atomic
database boundary while avoiding thousands of redundant primary/page-index
writes. Each chunk remains subject to the migration's 1 MiB JSON limit; an
oversized or malformed chunk aborts the whole transaction. The session exposes
the logical source-record count from its frozen summary, while the migration
guard validates the internal chunk count against the physical rows.

D1 documents `batch()` as a transaction whose statements run sequentially and
non-concurrently, with the entire sequence rolled back on failure. This gives
the snapshot one database boundary without a global application write lock:

<https://developers.cloudflare.com/d1/worker-api/d1-database/#batch>

The initial request should receive only identifiers and aggregate results. The
browser fetches one frozen storage chunk at a time; the Worker validates and
expands it into at most 64 logical records before returning the deterministic
page. The browser then constructs the metadata-only kit locally. This avoids
serializing the whole database in the 10 ms Worker CPU budget in one response.

The implementation must remain below the Workers Free limit of 50 D1 queries
per invocation. Group snapshot statements where needed, and test the complete
current schema rather than assuming the query count.

### Snapshot immutability

Once a session is `ready`:

- its record and item rows are immutable;
- each route resolves only the frozen rows;
- later catalog edits cannot change its plan;
- a later newly created derivative is not silently added;
- a replacement cannot remove planned historical media, because existing
  preservation rules retain replaced originals and derivatives;
- failure to finish snapshot creation leaves no usable `ready` session;
- a digest mismatch makes the session unusable; and
- exact retries of creation with the same client mutation ID return the same
  ready session or its bounded failed state rather than creating ambiguous
  plans.

The create request must be replay-safe. A random client mutation ID is bound to
the authenticated administrator, as in the existing mutation patterns.

### Expiry and cleanup

There is no multi-gigabyte server archive to delete. Only a few megabytes of
derived D1 snapshot rows are retained.

The initial policy is:

- a ready plan is usable for 24 hours from snapshot creation;
- the UI can revoke it immediately;
- expired/revoked plans reject metadata and media requests;
- the existing bounded scheduled-maintenance entry point purges record/item
  detail after expiry plus a short retry grace period;
- the small session audit stub, aggregate counts, digest, creator, timestamps,
  and terminal state may remain; and
- cleanup is restricted to the new derived export tables.

The exact grace period should be recorded in the implementation commit and
covered by tests. Automatic cleanup must never target catalog tables,
`media_objects`, derivative provenance, R2, or `legacy/`.

Twenty-four hours is intentionally longer than the earlier one-hour
server-archive idea. Here the retained state is only metadata, while a future
roughly 12 GB download may take several hours on a slower upstream connection.

### Snapshot preconditions

Plan creation fails safely, before becoming ready, if:

- an included durable media or derivative row lacks a valid lowercase SHA-256;
- an included size is invalid;
- one stable record relationship cannot be resolved;
- two distinct payload entries collide after the cross-platform naming rules;
- the profile generator cannot represent a source enum/state;
- a source row exceeds a documented profile bound; or
- the snapshot transaction or digest finalization is ambiguous.

R2 byte existence and full content hashes are verified during local download,
not by thousands of synchronous preflight reads in the browser action. The kit
therefore remains a plan until the builder completes.

## Export API

Exact URL names may follow local conventions, but the API must provide the
following operations:

```text
POST /api/admin/portable-exports
GET  /api/admin/portable-exports/:exportId
GET  /api/admin/portable-exports/:exportId/records
GET  /api/admin/portable-exports/:exportId/items
GET  /api/admin/portable-exports/:exportId/items/:itemId/content
POST /api/admin/portable-exports/:exportId/revoke
```

All routes:

- remain inside the existing Access-protected `/api/*` boundary;
- require a currently active application account;
- require the current `admin` role;
- require the current identity to match the plan creator;
- use exact IDs selected by the server, not R2 keys supplied by the client;
- return `private, no-store`;
- have `nosniff`, no-referrer, same-origin resource policy, and the application's
  other private API headers;
- do not put secrets or storage identifiers in URLs, JSON, response filenames,
  or logs; and
- use bounded, privacy-safe errors.

The create/revoke operations retain exact-origin and JSON content-type checks.
The local builder performs only GET requests, so it does not require a browser
Origin header.

### Item content route

The content route:

1. validates Access and the active admin role through the ordinary middleware;
2. loads the ready, unexpired, same-creator session and exact item using indexed
   IDs;
3. retrieves the server-held object key from the frozen item;
4. performs one private R2 read, optionally using a validated single byte range;
5. requires the R2 object size to match the frozen plan;
6. streams bytes without buffering the object in the isolate; and
7. returns exact length/range headers and an opaque private representation
   marker.

Only one RFC-compatible byte range is accepted. Invalid or multi-range requests
are rejected. `If-Range` and caching are unnecessary; the immutable item
identity, size, and final local SHA-256 provide the resume boundary.

The response filename can be a generic `payload.bin`; the authoritative
human-readable archive name comes from the plan. This prevents a response header
from becoming a second naming implementation.

The Worker verifies size before/while streaming. The Python builder verifies the
complete SHA-256 after all ranges are assembled. A partial range is never
considered a verified object.

## Authentication from Python

### Selected Access flow

The local builder uses Cloudflare's documented end-user CLI flow:

```text
cloudflared access login https://app.musiclibrary.workers.dev
cloudflared access token -app=https://app.musiclibrary.workers.dev
```

The token command returns an application-scoped, user-identity Access token. The
builder keeps it only in process memory and sends it in the documented
`cf-access-token` request header. At the edge, Access validates the token and
supplies the normal `Cf-Access-Jwt-Assertion` to the Worker. The existing Worker
then validates that JWT and rechecks `app_users` on every request.

Cloudflare documents this flow specifically for an end user accessing an
Access-protected API:

<https://developers.cloudflare.com/cloudflare-one/tutorials/cli/>

This replaces the tentative custom export-capability design. Consequently:

- no export bearer token is generated by the application;
- no token is put in the kit;
- no raw token is stored in D1;
- no Access bypass or public path is added;
- no R2 S3 credential or parent R2 API credential is needed;
- no long-lived service token is distributed;
- a removed/deactivated account or removed admin role fails the next Worker
  request; and
- the Access session duration, plus the plan's 24-hour expiry, bounds use.

If the token is missing or expired, the builder may invoke `cloudflared` again
after explicit progress output. It must not print the token, place it on a
command line, write it to its checkpoint, include it in an exception, or copy it
into the final archive. It retries authentication at most once per failure
episode; a persistent 403 is treated as revoked/insufficient access, not an
infinite login loop.

The builder must distinguish:

- an Access redirect/authentication failure;
- an inactive application account;
- insufficient/currently removed admin role;
- a plan belonging to another administrator;
- an expired/revoked plan; and
- a missing/corrupt media item.

### Local development

Tests never require a real Access token. They use the existing local auth mode
and controlled mocked/subprocess boundaries. No real token, email address, or
private catalog value enters tracked fixtures or test output.

## Local builder

### Distribution and trust

The repository owns one fixed, reviewed Python program. The export endpoint does
not generate Python source dynamically. The browser places that exact versioned
program, its SHA-256, schemas, profile files, and the frozen private plan into the
kit.

The kit is a normal ZIP containing private metadata. After extracting it, the
main command is intentionally ordinary:

```bash
python3 export-kit/tools/music_library_archive.py build \
  --kit export-kit \
  --output music-library-preservation.zip
```

The program should use the Python standard library unless a dependency is
clearly justified and pinned. Python 3.11 or newer is the initial supported
floor. `cloudflared` is the only external runtime helper for remote
authentication.

The tool also provides:

```bash
python3 export-kit/tools/music_library_archive.py verify \
  music-library-preservation.zip

python3 export-kit/tools/music_library_archive.py inspect \
  music-library-preservation.zip

python3 export-kit/tools/music_library_archive.py restore-local \
  music-library-preservation.zip --destination restored-library
```

The repository-trusted copy, not a script taken from an untrusted archive, must
be used when verifying or restoring an archive of unknown origin.

### Preflight

Before network or filesystem mutation, the builder:

- validates the kit ZIP safely;
- verifies the kit SHA-256 manifest;
- validates supported profile/exporter versions;
- validates every record and relation;
- validates all logical paths and cross-platform collision keys;
- confirms the origin is HTTPS and matches the kit's exact allowed origin;
- confirms every item has an opaque ID, allowed representation, valid size,
  lowercase SHA-256, MIME type, and unique payload path;
- calculates planned bytes, object count, estimated archive bytes, and disk
  requirements;
- checks the output and work directories are not the kit, repository, `/`, home
  directory, or another unsafe broad target;
- checks available disk independently when the work and output directories are
  on different volumes; and
- explains that the final archive is private.

The ordinary two-stage mode requires approximately:

- verified object cache: one copy of every distinct planned object;
- final ZIP: approximately one further copy because media is stored without
  recompression; and
- one conservative fixed/metadata margin.

At the 2026-07-23 staging inventory this is roughly 16–18 GB. At the agreed 50%
growth scenario it is roughly 25–30 GB. The builder uses exact kit totals for its
actual preflight instead of hard-coding those estimates.

### Download and resume

The builder uses:

```text
Worker/R2
    -> four bounded parallel response streams
    -> .work/objects/<sha256>.partial
    -> exact length + SHA-256 verification
    -> atomic rename to .work/objects/<sha256>
```

Requirements:

- default concurrency is four and has a small bounded override;
- each response is streamed to disk in bounded chunks;
- interrupted partial files resume with a single `Range` request;
- a server response that ignores a nonzero Range causes a safe restart, not an
  append;
- retry uses bounded exponential backoff with jitter for network failures,
  429, and selected 5xx responses;
- authentication refresh is separate from transport retry;
- full size and SHA-256 are verified before atomic promotion;
- a same-size cache file is still hashed before reuse;
- a corrupt partial or cache file is quarantined/replaced only inside the
  export work directory;
- checkpoints contain only export/item IDs, byte counts, hashes, and status;
- checkpoints never contain Access tokens, R2 keys, titles, lyrics, original
  filenames, or person identities;
- progress output is aggregate by default; and
- Ctrl-C leaves resumable work and no apparently final archive.

Cache identity is the planned durable object identity plus SHA-256, not merely a
friendly path. The same object referenced by multiple semantic relationships is
downloaded once.

### Assembly

After all objects are verified, the builder:

1. materializes exact typed-lyric UTF-8 files and the final portable metadata
   from the kit;
2. creates all BagIt payload-manifest entries in deterministic path order;
3. writes an attached RO-Crate inside the BagIt `data/` payload;
4. writes a ZIP64 archive to an explicit `.partial` file;
5. uses `ZIP_STORED` for all entries because audio/images are already compressed
   and avoiding recompression is faster, deterministic, and space-neutral for
   this collection;
6. uses deterministic entry order, safe permissions, and fixed ZIP metadata;
7. closes and syncs the archive;
8. reads the entire ZIP back, validates its central directory, validates every
   BagIt payload and tag checksum, revalidates metadata and relationships, and
   confirms there are no extra/missing entries; and
9. atomically renames the file to the requested final name only after all checks
   pass.

The builder never adds its work directory, checkpoints, local Access state,
token, source kit path, shell history, or host username to the archive.

There is no `--skip-verification` path that can produce a normally named final
archive. A diagnostic option may stop after download/assembly, but its output
must retain an unmistakable `.partial` or `.unverified` name.

## Duplicate and representation behavior

### Recording original and playback

The metadata explicitly distinguishes:

- original bytes;
- playback uses original;
- playback uses a distinct optimized derivative; and
- playback is unavailable because processing is incomplete/failed.

When the original is the playable representation, the archive contains one
file, named as the original. Both semantic relationships point to that same
payload path. There is no second “optimized” copy or empty placeholder.

When a registered derivative is distinct, the archive contains:

- `<Recording description> — original.<source extension>`; and
- `<Recording description> — optimized.mp3`.

The derivative metadata names the original source, source/output hashes and
sizes, and conversion policy. An importer must reconstruct the relationship from
metadata, never infer it from the word `optimized`.

### Scans

A Scan original is always included. A registered readability JPEG is included
once as `optimized` and linked to its exact source and policy. If a Scan has no
registered readability derivative, no optimized placeholder is created; the
metadata says the readable representation falls back to the original.

Browser-only quarter-turn display state is metadata. The builder does not rotate
or re-encode either representation.

### Other repeated relationships

The final archive contains one payload entry per durable stored representation,
not one copy per relationship edge. When a historical/current relation refers to
the same media row, the metadata edges share one path. Distinct media rows with
equal hashes remain distinct historical records unless the profile explicitly
records that they are the same durable object; equal bytes alone do not merge
user history.

## Trashed, historical, and unassigned material

Trash is preservation state, not deletion:

- trashed Songs receive folders under `songs/trashed/`;
- trashed children of active Songs are under that Song's `Trash/` subfolders;
- a trashed Song's children remain inside its trashed Song folder;
- media state and all Trash timestamps/actors remain explicit in metadata;
- restoration dependencies and stable parent IDs remain explicit; and
- nothing is omitted because it is trashed.

Replacement history is under the owning Song's `History/` area when the durable
representation has a unique human location. Metadata remains authoritative when
one object participates in current and historical relationships and is therefore
written only once.

Every durable media row is included. A media row that cannot be assigned to a
current or historical Song relationship is placed under
`unassigned-media/` with a stable non-sensitive name and a clear metadata
explanation. This is different from an R2 object that has no durable media or
derivative row; the latter is excluded operational residue.

The create response and final verification report include aggregate counts for:

- active and trashed domain records;
- current and historical media relationships;
- registered but unassigned durable media;
- distinct planned stored objects;
- deduplicated relationship references; and
- excluded unregistered R2 objects if a bounded aggregate inventory was
  performed.

## Why local assembly is selected

### Versus a resumable server-side Worker ZIP

A server-side ZIP can be made to work, but resumable ZIP central-directory
state, per-entry CRC state, object ordering, failures across ephemeral
invocations, and temporary archive storage create a substantially larger
state-machine and verification surface. Parallel ZIP parts also require
precomputed checksums or a separate combination design.

Local assembly instead uses ordinary files, Python's mature ZIP64 support, local
disk checkpoints, and a final sequential read-back. The Worker only authenticates,
looks up a frozen item, and streams R2 bytes.

Workers remain ephemeral in the selected design: approximately one invocation
serves each object or resumed range. Waiting while an R2/body stream moves does
not count as active CPU, and no invocation needs a VM-like filesystem.

### Versus Cloud Run or Oracle compute

A separate Cloud Run Job or maintained Oracle VM could assemble the archive
with simpler single-machine code, but would add another privileged runtime,
cross-cloud data flow, credentials, patching/availability concerns, and an
archive-upload lifecycle. Google outbound transfer from R2/Cloud Run paths may
also be billable. The existing least-privilege audio job must not be expanded
into a backup service.

An Oracle Always Free VM could make compute/storage inexpensive, but idle
capacity can be reclaimed and capacity availability is not a backup guarantee.
It is not selected for a rare administrator action that naturally ends on the
administrator's computer.

### Versus downloading the whole R2 bucket

The bucket contains operational/unregistered objects as well as durable
catalog media. A raw bucket download loses relationships and may include
abandoned upload bytes. The frozen plan downloads exactly the registered durable
representations and records the semantic relationships required for recovery.

## Cost and scale boundary

The read-only inventory used for this design on 2026-07-23 found:

- 2,925 registered export payload objects;
- 7,955,140,423 bytes of registered payload;
- 2,933 total R2 objects and approximately 8.1 GB in the staging bucket;
- 1,979 `media_objects` rows, with no missing media SHA-256;
- a largest registered payload object of 57,813,164 bytes; and
- an approximately 5.06 MB D1 database.

The agreed 50% growth model is approximately:

- 4,388 registered payload objects; and
- 11.93 GB of export payload.

One complete build therefore uses roughly 2,925 current or 4,388 future Worker
requests, plus a small number of metadata/range retries. This is approximately
2.9% or 4.4% of the current Workers Free 100,000-request daily allowance.

The expected cost shape is:

- **Workers:** short authentication/D1 lookup/streaming CPU per request; waiting
  on I/O is not CPU. The current Free limit is 10 ms CPU per HTTP request and
  128 MB memory. The implementation must measure real staging request CPU and
  fail the rollout gate if it consistently exceeds the Free boundary.
- **R2:** one Class B read per object/range in the ordinary case, far below the
  10 million monthly free allowance; direct R2/Workers-API egress is free.
- **D1 reads:** indexed export-session/item checks and bounded snapshot-page
  reads, far below the 5 million daily free allowance.
- **D1 writes:** one temporary snapshot and its later derived-row cleanup. The
  implementation must report exact rows written and keep one build comfortably
  below the 100,000 daily Free limit.
- **R2 storage:** no temporary server archive and therefore no extra archive
  GB-month.
- **Local:** approximately twice payload size in free disk and one payload-sized
  Internet download.

Current official references:

- <https://developers.cloudflare.com/workers/platform/limits/>
- <https://developers.cloudflare.com/workers/platform/pricing/>
- <https://developers.cloudflare.com/d1/platform/limits/>
- <https://developers.cloudflare.com/d1/platform/pricing/>
- <https://developers.cloudflare.com/r2/pricing/>

Free allowances can change. Recheck them before deployment and record the date
and measured staging request/row counts.

## Local reference restore, not a cloud import feature

The trusted tool implements `verify`, `inspect`, and `restore-local`. It does not
upload into D1/R2 or add an import page.

`restore-local`:

- verifies the entire archive before creating destination state;
- supports a no-write dry run;
- writes into a new explicit destination directory;
- creates a constrained reference SQLite database representing every portable
  record and relationship;
- copies/links verified payloads into a private local media directory;
- preserves stable IDs, ordering, Trash, provenance, history, and actor
  attribution;
- is idempotent for an identical rerun;
- fails on a conflicting non-identical stable ID;
- reports counts, duplicates, missing/orphan relations, media hashes, and
  reconciliation results; and
- never modifies `legacy/`, Cloudflare, or the source archive.

The reference SQLite schema is the portable profile's reconstruction model, not
a promise that it is a raw copy of the current D1 schema. This avoids coupling a
long-lived preservation format to runtime triggers and operational queues while
still proving that all durable data and relationships can be reconstructed.

A future real disaster recovery would:

1. recover the Git repository and deploy the application/migrations into new,
   empty private resources;
2. bootstrap one administrator and Access separately;
3. run the already-tested archive parser and verifier;
4. implement or enable a destination adapter that maps the portable restored
   model into that fresh schema and private object store;
5. preserve stable IDs or record an explicit deterministic mapping;
6. reconcile all rows, relationships, hashes, Trash/history, and counts; and
7. enable the library only after reconciliation.

Import into a nonempty live library, overwrite/merge behavior, automatic account
reactivation, and cleanup remain out of scope.

## Implementation sequence and commit boundaries

Use small green commits:

1. **Archive profile and fixtures**
   - add versioned TypeScript/Python contracts, JSON schemas, safe-path logic,
     and fully synthetic fixtures;
   - add profile conformance, naming, collision, Trash/history, and
     original/playback deduplication tests.
2. **Frozen server export**
   - add migration `0021`, snapshot builder, admin routes, paging, item-range
     streaming, expiry/revocation, and derived-row cleanup;
   - add authorization, replay, transactional snapshot, privacy, range, R2
     mismatch, and cleanup tests.
3. **Administrator UI and export kit**
   - add the admin-only Account section, preparation/status UI, local ZIP kit
     construction, clear disk/privacy/expiry guidance, and accessibility tests.
4. **Local builder, verifier, and restore**
   - implement bounded Access-token subprocess handling, resume/cache,
     deterministic BagIt/RO-Crate ZIP64 assembly, adversarial verification, and
     idempotent local reference restore;
   - add complete Python tests and TypeScript-to-Python contract fixtures.
5. **End-to-end and operational documentation**
   - run synthetic export → build → verify → local restore → canonical compare;
   - add the operator/manual runbook, quota measurements, and final gates.
6. **Protected-staging rollout checkpoint**
   - apply only the reviewed export migration;
   - deploy the Worker/client;
   - prepare one real metadata plan and exercise a bounded item/range sample;
   - reconcile catalog/media counts and prove zero catalog/media and R2 writes;
   - leave the owner's full 8–12 GB manual build for the separate acceptance
     step.

Do not combine all code into one final commit. Do not commit a private export
kit, archive, catalog value, token, email, media file, or generated local
restore.

## Required automated verification

At minimum, cover:

### Profile and metadata

- every included source field and relationship;
- stable IDs and deterministic ordering;
- active/trashed Songs and active/trashed children;
- hidden legacy fields without tracked private examples;
- archived actors without credential semantics;
- original filename provenance;
- current and replacement-history media;
- parent moves and known Scan duplicate history;
- distinct derivative provenance;
- original-as-playback using one path and one payload;
- missing-derivative fallback without a placeholder;
- registered unassigned media;
- excluded operational tables and secret/storage identifier fields;
- deterministic counts and digests; and
- schema/profile version rejection and forward-compatible extension handling.

### Paths and ZIP safety

- NFC/case-fold collisions;
- astral Unicode and malformed source text normalization;
- `/`, `\`, control characters, dot components, leading/trailing whitespace and
  dots;
- Windows reserved basenames and case-insensitive filesystems;
- bounded UTF-8 path components and full paths;
- repeated titles/descriptions/Notebook/Page metadata;
- deterministic disambiguation using stable IDs;
- absolute paths, `..`, symlinks, duplicate ZIP entries, alternate separator
  tricks, and Unicode-equivalent collisions;
- unexpected compression, declared-size abuse, and ZIP bombs;
- ZIP64 without constructing a multi-gigabyte tracked fixture; and
- no extra or unmanifested entries.

### Server

- viewer/editor rejection and admin acceptance;
- inactive/removed admin rejection on every later request;
- exact plan-creator binding;
- Access/local auth behavior without bypass;
- same-origin/content-type protection for mutations;
- replay-safe creation;
- all-or-nothing snapshot creation;
- frozen results across later source edits;
- pagination stability;
- expiry/revocation and cleanup limited to export tables;
- item ID cannot select another R2 key;
- exact size, ordinary and suffix/open ranges, 206/416 behavior, and
  multi-range rejection;
- private/no-store/security response headers;
- R2 missing/size mismatch and stream failure;
- bounded errors/logs with no filenames, lyrics, people, object keys, tokens, or
  hashes unnecessarily emitted; and
- no catalog/media/R2 writes.

### Builder

- safe kit extraction and kit-manifest verification;
- subprocess token capture without logging or checkpointing it;
- authentication renewal and bounded denial behavior;
- exact origin restriction and redirect rejection;
- four-way bounded parallelism;
- interrupted range resume, ignored Range restart, retry/backoff, and Ctrl-C;
- corrupt partial/cache files;
- insufficient disk and unsafe output/work targets;
- one download for a multiply referenced durable object;
- exact lyric bytes and no automatic splitting;
- deterministic stored ZIP entries and ZIP64;
- atomic `.partial` → final rename only after full verification; and
- aggregate privacy-safe progress/reports.

### Verifier and local restore

- BagIt payload and tag manifests;
- RO-Crate structure and profile declaration;
- all JSON contracts and referential integrity;
- all payload size/SHA-256 values;
- no missing/orphan/extra relationships or files;
- dry run;
- empty destination, exact idempotent rerun, and conflicting stable-ID failure;
- actor records remain historical/inactive;
- no cloud/legacy calls;
- synthetic source/export/restore canonical equality; and
- mutations of every significant field or payload cause a deterministic test
  failure.

## Deployment and acceptance gates

### Protected-staging rollout, 2026-07-24

The original migration `0021` created the export-only tables. Corrective
migration `0022_portable_export_item_chunks.sql` preserves the audit/detail
history, adds bounded item chunks, and leaves ten export guards. Worker
`0707aac7-ad77-4866-a5b6-63e25d5d2f64` serves final source commit `07beba0` at
100% with client/service-worker build `77af32a4d6e3`; no migration is pending.

Two failed owner attempts rolled back every detail row. Exact D1 diagnostics
showed that the second failure was not the previously inferred transaction
execution boundary: the final summary query contained six compound `UNION`
terms, and D1 rejected it with `too many terms in compound SELECT`. Splitting
the six inputs into two independent three-term sets preserves the same
all-or-nothing snapshot while respecting the runtime limit. Migration `0022`
also reduces the 2,925 logical payload items to 46 bounded physical chunks;
the 8,532 logical records remain 148 physical chunks.

Aggregate postflight matched preflight: 581 Songs, 335 lyric rows, 499 Scans,
835 Recordings, 1,979 media objects, 946 Scan derivatives, 196 audio
derivatives, 2,925 registered payload objects / 7,955,140,423 bytes, and 2,933
R2 objects / 8.1 GB at final aggregate reconciliation. Invalid registered hashes
and foreign-key errors are zero. Access returns the expected
unauthenticated 302, and the enforced processor/Scheduler snapshot has zero
critical or warning alerts. No catalog/media row or R2 object changed.

One authenticated plan passed with exactly 8,532 logical records, 2,925 items,
and 7,955,140,423 bytes. The browser downloaded its private metadata kit. One
16,674-byte private payload and a 64-byte range were read successfully; the
temporary aggregate-only range probe was removed before the final deployment.
The plan was revoked and all 148 record chunks and 46 item chunks were purged,
leaving only its aggregate audit stub. The complete multi-gigabyte archive was
deliberately not built and remains the owner's manual acceptance.

Before protected-staging deployment:

- all Vitest files pass;
- all Python archive tests pass;
- all existing audio-converter tests remain unchanged and pass;
- all three TypeScript projects pass;
- a fresh SQLite replay of all migrations passes;
- production and service-worker builds pass;
- whitespace/privacy checks pass;
- the end-to-end synthetic round trip passes;
- exact package/dependency changes are reviewed;
- current official Cloudflare allowances are rechecked; and
- the source tree contains no private generated output.

Protected-staging rollout may change only:

- the reviewed export schema;
- the Worker/client build;
- temporary rows in the new export-only tables; and
- bounded R2 read counters from verification.

Postflight must prove:

- Access still redirects unauthenticated requests;
- viewer/editor/admin authorization behaves as designed;
- the real plan has expected aggregate counts/bytes and no missing planned
  hashes;
- one or more bounded original/derivative/range samples hash correctly;
- the plan can be revoked/expire safely;
- no migration is pending;
- all pre/post Song, lyrics, Scan, Recording, media, and foreign-key counts are
  unchanged;
- query changes/writes are limited to the new export tables;
- R2 object count and bytes are unchanged;
- converter image, Cloud Run Job, Scheduler, Access policy, production/DNS, and
  legacy state are unchanged; and
- measured request CPU, D1 rows read/written, and R2 operations remain within
  the documented cost boundary.

The owner then performs the separate full manual acceptance:

1. sign in as admin;
2. prepare and download a kit;
3. run the Python builder on the intended local disk;
4. allow `cloudflared` browser authentication if requested;
5. wait for `VERIFIED`;
6. inspect representative active, Trash, history, original/optimized, and lyric
   paths;
7. run `verify` independently; and
8. retain the resulting private archive in an owner-chosen secure location.

No automatic upload, cloud retention, deletion, backup rotation, or production
cutover follows from that acceptance.
