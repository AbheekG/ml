# Music Library portable archive profile 1.0

Status: normative profile implemented as version 1.0.0. The TypeScript exporter
and standard-library Python builder/verifier/local restore share the bundled
machine-readable contracts and synthetic cross-language round-trip gates. A
future implementation change must either conform to this profile or document
and obtain owner approval for a deliberate revision before deployment.

Profile identifier:

```text
urn:music-library:portable-archive-profile:1
```

Profile version:

```text
1.0.0
```

The identifier is intentionally non-resolving. Every export includes this
profile and its machine-readable schemas, so interpretation does not depend on
the continued availability of this application, repository host, or a private
website.

This profile uses:

- BagIt 1.0 as specified by
  [RFC 8493](https://www.rfc-editor.org/info/rfc8493/);
- an attached
  [RO-Crate 1.3](https://www.researchobject.org/ro-crate/specification/1.3/)
  inside the BagIt payload;
- UTF-8 JSON and text;
- SHA-256 for payload and tag fixity; and
- ZIP64 for the transport archive.

RO-Crate describes the dataset and portable relationships. BagIt supplies a
complete payload inventory and fixity. ZIP64 supplies convenient single-file
transport beyond the classic 4 GiB ZIP boundary. None replaces the
application-profile validation rules below.

## Normative terms

`MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, and `MAY` have their usual RFC 2119
meanings.

The **kit** is the small private metadata/tool ZIP downloaded from the
application. The **archive** is the final ZIP64 BagIt package produced locally.
The **payload** is the BagIt `data/` directory and is also the attached RO-Crate
root.

Friendly paths are for people. Stable IDs and relationships in
`metadata/catalog.json` are authoritative. An importer MUST NOT infer identity,
status, or relationships from a filename or directory name.

## Archive root

The archive MUST contain exactly one top-level directory:

```text
music-library-preservation-<snapshot-date>-<short-export-id>/
```

Inside it:

```text
bagit.txt
bag-info.txt
manifest-sha256.txt
tagmanifest-sha256.txt
data/
  README.html
  ro-crate-metadata.json
  ro-crate-preview.html
  metadata/
    catalog.json
    export-report.json
    profile.json
    schemas/
      catalog.schema.json
      export-report.schema.json
      profile.schema.json
  songs/
    active/
      <friendly Song folder>/
    trashed/
      <friendly Song folder>/
  unassigned-media/
  tools/
    music_library_archive.py
```

Empty structural directories MAY be omitted. Every regular file below `data/`
MUST be listed exactly once in `manifest-sha256.txt`. Every BagIt tag file MUST
be covered as required by the tag manifest. There MUST be no symlinks, hardlink
entries, devices, FIFOs, absolute paths, or entries outside the top-level
directory.

All ZIP members MUST use stored compression. ZIP64 structures MUST be permitted
and used when required. Entry order MUST be deterministic by UTF-8 payload path.
The builder MUST use deterministic safe permissions and fixed ZIP timestamps;
the meaningful source/export timestamps live in metadata.

## BagIt files

`bagit.txt` is:

```text
BagIt-Version: 1.0
Tag-File-Character-Encoding: UTF-8
```

`bag-info.txt` MUST include:

- `Bagging-Date`;
- `External-Identifier` using the export UUID;
- `Bag-Software-Agent` with exporter/tool versions;
- `Payload-Oxum`;
- `Bag-Size`;
- `Source-Organization: Music Library`;
- `Music-Library-Profile`;
- `Music-Library-Snapshot-Time`;
- `Music-Library-Source-Schema`;
- `Music-Library-Source-Commit`; and
- aggregate Song/media counts.

It MUST NOT include an administrator email, local username/path, Access token,
R2 key, or secret.

Manifest paths use `/`, are relative to the bag root, and use UTF-8 exactly.
Manifest lines are sorted by path. SHA-256 is lowercase hexadecimal.

## RO-Crate

`data/` is the attached RO-Crate root. Its
`ro-crate-metadata.json` MUST:

- use the RO-Crate 1.3 context by reference;
- describe itself as the metadata descriptor;
- describe `./` as the root `Dataset`;
- declare conformance to RO-Crate 1.3 and this included portable profile;
- identify the snapshot/export UUID and creation time;
- identify the fixed exporter/tool version and source commit;
- include `metadata/catalog.json`, the profile, schemas, report, friendly Song
  directories, and every payload media/text file as data entities or reachable
  parts;
- use the archive-relative payload path as the file entity `@id`;
- include encoding format, content size, and SHA-256 for each file; and
- express Song, lyric, Scan, Recording, Person, vocabulary, media,
  current/history, Trash, and provenance edges at a useful portable level.

The RO-Crate graph is a general discovery/interchange layer. The consolidated
catalog remains the complete, lossless profile representation. A consumer MUST
not assume every Music Library extension field has a Schema.org equivalent.

`ro-crate-preview.html` MUST be static, useful without JavaScript, and contain
no network-loaded resources. It summarizes the collection, snapshot, counts,
privacy warning, profile, verification instructions, and links to the
consolidated metadata and friendly Song folders. It MUST safely escape all
private strings.

`README.html` is a short start page for a person opening the payload. It MUST
explain:

- this is a private preservation archive;
- how active, Trash, and history folders are organized;
- why original and optimized files may or may not both exist;
- that filenames are descriptive but metadata IDs/relations are authoritative;
- how to run `verify` and `inspect`;
- that archived actor roles are not credentials; and
- that application deployment/secrets are separate.

## Consolidated catalog

`metadata/catalog.json` is one UTF-8, pretty-printed JSON document. It MUST
conform to the bundled schema and contain these top-level fields:

```text
profile
export
source
collection
actors[]
languages[]
tags[]
notebooks[]
people[]
songs[]
unassignedMedia[]
relationshipHistory[]
extensions
```

Arrays MUST be deterministically ordered:

- stable UI/domain order first where one exists;
- stable ID as the final tie-breaker; and
- immutable history by event time then stable ID.

Every entity has:

- `id`;
- `type`;
- its exact portable fields;
- `createdAt`/`createdBy` and `updatedAt`/`updatedBy` when the source model has
  them;
- Trash state/timestamps/actor where applicable; and
- `extensions.musicLibrary` for lossless application fields that are not part
  of the general core.

Unknown extension keys MUST be ignored by a forward-compatible reader while
preserved when possible. An unknown required profile major version MUST be
rejected. Unknown source application fields MUST NOT silently overwrite known
profile fields.

### Export/source

The document records:

- export UUID and snapshot time;
- profile/RO-Crate/BagIt versions;
- kit, exporter, and builder versions;
- source Git commit;
- source application schema/migration level;
- source environment label without account IDs or secrets;
- plan digest;
- counts and bytes; and
- explicit inclusion/exclusion declarations.

It does not record a live API token or an R2 key.

### Actors

Actors contain:

- stable source identity;
- display name if present;
- observed application role;
- observed active/inactive state; and
- timestamps.

Because actor identities may be email addresses, the whole archive is private.
Roles are historical observations only. The catalog has
`restoreAsActive: false` for every actor. A generic consumer may treat actors as
People/Agents; a Music Library restorer must require explicit destination
account mapping.

System actors such as the audio processor are represented as bounded named
agents, not application accounts.

### Vocabularies and People

Languages preserve ID, display name, normalized name, BCP-47 tag, and sort
order. Tags and Notebooks preserve ID, display/normalized name, and sort order.
People preserve stable ID, full/normalized name, and audit timestamps.

Normalized values are included for lossless restoration, but a generic consumer
should use display values. A restorer MUST validate that normalized keys agree
with the declared profile/source rules rather than trusting them as new display
text.

### Songs

Each Song object contains:

- stable ID;
- Latin and optional native titles;
- normalized title;
- optional status and notes;
- revision and latest mutation identifier;
- creation/update/Trash attribution;
- `folderPath`;
- ordered Language and Tag IDs;
- ordered Alias objects with their stable IDs and normalized forms;
- ordered Song credit objects with stable IDs, Person ID, role, notes, and
  order;
- ordered typed-lyrics children;
- ordered Scan children;
- ordered Recording children; and
- relation/history references.

A trashed Song remains in `songs[]` and has a folder under `songs/trashed/`.
An active Song is under `songs/active/`.

### Typed lyrics

Each typed-lyrics child contains:

- stable ID and parent Song ID;
- stable sort order;
- revision;
- origin (`user` or `legacy_import`);
- creation/update/Trash attribution;
- optional lossless legacy/application extension fields when present;
- exact UTF-8 payload path;
- exact byte size; and
- SHA-256 of the text file.

The `.txt` bytes are the exact UTF-8 encoding of database content. The builder
MUST NOT trim, normalize line endings, add a final newline, split combined
legacy blocks, or classify language/script/representation.

An active Song's active lyrics are under `Lyrics/`; its trashed lyrics are under
`Trash/Lyrics/`. A trashed Song's lyrics remain in its trashed Song folder, with
status explicit in metadata.

### Scans

Each Scan contains:

- stable ID and current parent Song ID;
- revision and stable list order;
- Notebook ID and Page metadata;
- display rotation quarter turns;
- creation/update/Trash attribution;
- hidden legacy Source/Version/Date/ScanText/Notes fields;
- current original representation;
- optional registered optimized/readability representation;
- readability fallback state;
- ordered replacement history; and
- relevant parent-move history references.

Each representation contains:

- stable durable media/source identity;
- semantic role;
- payload path;
- MIME type;
- original filename provenance when it comes from `media_objects`;
- exact byte size and SHA-256;
- media state and attribution;
- and, for an optimized Scan, exact source media/hash/size, policy, dimensions,
  created time, and actor.

Saved display rotation does not change either file's hash.

### Recordings

Each Recording contains:

- stable ID and current parent Song ID;
- required description and normalized description;
- optional canonical `YYYY-MM-DD` recorded date;
- processing state and bounded error code;
- revision;
- creation/update/Trash attribution;
- hidden legacy version/notes;
- ordered Recording credit objects;
- original representation;
- playback selection;
- optional optimized playback representation;
- ordered replacement history; and
- relevant parent-move history references.

`playback` is one of:

```text
original
optimized
unavailable
```

For `original`, `playbackPath` equals `original.path`, and no duplicate optimized
file exists. This covers both an explicit same-media relationship and the
application convention where a canonical MP3 original is selected with no
separate playback media ID.

For `optimized`, the derivative contains exact source/output hashes and sizes,
policy ID, and stable media IDs. The path is distinct.

For `unavailable`, metadata preserves processing state/error, but no invented
file or placeholder is created.

### Media history and duplicate preservation

Scan and Recording replacement events preserve:

- stable history ID;
- owning child ID;
- replaced-at time/actor;
- revision at replacement; and
- exact original/playback representation links.

If a historical and current relationship refer to one durable media row, both
edges use the same payload path. If two durable media rows have equal SHA-256,
they retain separate media identities and history entries. The profile records
known Scan fingerprint canonical/member/historical-duplicate information so a
restorer does not silently merge them.

`relationshipHistory[]` contains immutable Scan/Recording parent moves with
stable event ID, child kind/ID, old/new Song IDs, time, and actor.

### Unassigned durable media

Every `media_objects` row and every registered Scan readability derivative MUST
be reachable from exactly one canonical payload-object entry. A durable object
with no current/history owner is represented in `unassignedMedia[]` and placed
under `unassigned-media/`.

An unassigned record retains its stable ID, kind, state, original filename,
MIME, size, hash, and attribution. Its presence is a preservation warning, not
permission to attach, merge, or delete it.

Unregistered R2 objects do not appear here.

## Friendly path rules

### General algorithm

All friendly components are derived from semantic display metadata, then made
portable. For each component:

1. replace malformed source Unicode with U+FFFD;
2. normalize to NFC;
3. replace `/` and `\` with a visible safe separator;
4. remove C0/C1 controls and NUL;
5. collapse Unicode whitespace to one ordinary space;
6. trim leading/trailing spaces and dots;
7. prevent `.` and `..`;
8. prevent Windows reserved device basenames, case-insensitively;
9. preserve readable Unicode;
10. truncate only at complete Unicode code-point and UTF-8 boundaries;
11. keep the semantic extension separately; and
12. add a deterministic stable-ID suffix when truncation or a collision requires
    disambiguation.

The collision key is NFC plus Unicode case-folding, with trailing Windows
space/dot equivalence. Collision checks cover every sibling directory and the
complete archive path. Maximum component and full-path UTF-8 lengths are fixed
in the JSON schema/implementation constants and must be tested on common macOS,
Windows, Linux, and ZIP tools.

Friendly names MUST never contain R2 keys, internal upload IDs, hashes as the
primary label, Access identities, or opaque storage paths. A short stable-ID
suffix is allowed only for deterministic disambiguation.

### Song folders

The ordinary folder is the Song's Latin title after safe-component processing.
Native title is retained in metadata/preview rather than producing a filesystem
alias. Duplicate/case/Unicode-equivalent or truncated titles gain a short stable
ID suffix:

```text
Title
Title [a1b2c3d4]
```

The full stable ID remains in metadata.

### Lyrics

```text
Lyrics/01 — Typed lyrics.txt
Trash/Lyrics/01 — Typed lyrics.txt
```

Order uses the stable lyric order, with stable-ID tie-breaking.

### Scans

The semantic base is:

```text
<two-digit position> — <Notebook and/or Page label, or Scanned page>
```

Files are:

```text
Scans/<base> — original.<source extension>
Scans/<base> — optimized.jpg
Trash/Scans/<base> — original.<source extension>
History/Scans/<base> — <replacement marker> — original.<extension>
```

The source extension is derived from verified MIME/signature metadata, not
blindly copied from the original filename. Original filename is retained in
catalog metadata.

### Recordings

Files are:

```text
Recordings/<description> — original.<source extension>
Recordings/<description> — optimized.mp3
Trash/Recordings/<description> — original.<source extension>
History/Recordings/<description> — <replacement marker> — original.<extension>
```

When playback uses original, only the original file exists. History adds
deterministic time/revision/ID disambiguation when necessary.

### Canonical payload ownership

A durable stored representation has one canonical payload path. Current
relationships outrank historical relationships; owned relationships outrank
unassigned placement; otherwise use deterministic stable IDs. Other edges point
to the same path. A verifier rejects two payload copies that claim the same
durable representation identity.

## Export kit

The metadata-only kit is a private ZIP, not a BagIt archive and not a complete
backup:

```text
README.html
KIT-MANIFEST.sha256
export-plan.json
metadata/catalog.json
metadata/profile.json
metadata/schemas/*.json
tools/music_library_archive.py
```

It contains:

- exact app origin;
- export ID, creator binding indicator, snapshot/expiry times;
- plan/profile/tool versions;
- frozen portable metadata;
- one item per distinct server-side stored representation;
- opaque item ID and authenticated content URL/path template;
- planned payload path, MIME, size, and SHA-256;
- no R2 key and no Access token; and
- SHA-256 for every kit file except the manifest itself.

The kit plan and catalog relationship graph MUST agree exactly. The builder
validates both before authentication or downloads.

## Export report

`metadata/export-report.json` is created locally after final verification and
contains:

- export/snapshot/profile/tool identifiers;
- final archive filename and total bytes;
- aggregate domain/Trash/history/media counts;
- distinct objects and deduplicated edges;
- download attempts/resumes and total transferred bytes;
- manifest entry counts;
- verification start/end timestamps;
- all gate statuses;
- final `verified: true`; and
- a reconciliation digest over the canonical metadata and manifest.

It MUST NOT include private titles, lyrics, names, identities, original
filenames, local absolute paths, host/user names, Access tokens, or R2 keys.
Failures are reported outside a final archive; an archive with
`verified: false` cannot receive the ordinary final filename.

## Validation

A conforming verifier performs these layers in order:

1. **Container safety**
   - ZIP/ZIP64 structure, one root, stored entries, safe paths, no duplicates or
     Unicode/case collisions, no symlinks/special files, bounded declarations.
2. **BagIt**
   - required tags, allowed algorithms, exact payload inventory, SHA-256,
     Payload-Oxum, and tag manifest.
3. **RO-Crate**
   - required attached structure, 1.3 context/conformance, root/descriptor, and
     reachable described payload.
4. **Profile JSON**
   - schemas, versions, types, enums, sizes, dates, stable IDs, deterministic
     order, and extension rules.
5. **Relations**
   - every foreign ID resolves with the allowed type, every child has one
     current parent, every current/history/media edge is valid, no forbidden
     orphan exists.
6. **Representations**
   - every declared path exists exactly once, size/hash/MIME/role agree,
     derivative provenance matches its source, and original-as-playback shares
     one path.
7. **Reconciliation**
   - aggregate counts/bytes/digests agree across BagIt, RO-Crate, catalog, and
     report.

Validation is offline and makes no network request. RO-Crate context/profile
copies required for structural checking are bundled or implemented in the
trusted verifier; verification must not depend on resolving external URLs.

## Local reference restoration

A conforming `restore-local` creates:

```text
restored-library/
  library.sqlite3
  media/
  reconciliation.json
```

The SQLite reference model has foreign keys and constraints for every portable
entity, relation, state, history event, actor attribution, and representation.
It preserves every stable ID. It is not an executable deployment and contains
no active Access configuration.

The operation:

- runs full validation first;
- supports `--dry-run`;
- refuses unsafe/broad destinations;
- writes through a temporary sibling then atomically promotes;
- is idempotent when an existing destination is byte-for-byte/canonically
  identical;
- rejects non-identical stable-ID conflicts;
- copies verified payloads without transformation;
- does not infer from friendly names;
- marks all archived actors non-active;
- reports exact reconciliation; and
- never contacts Cloudflare, Google, Oracle, the source app, or `legacy/`.

The round-trip acceptance invariant is:

```text
canonical synthetic source
  == canonical export metadata + verified payload hashes
  == canonical local restored model + verified payload hashes
```

## Privacy

The kit and archive are fully private. They may contain lyrics, personal names,
account identities, notes, original filenames, and all media. They must not be:

- committed to Git;
- placed under tracked fixtures;
- uploaded to a public bucket or file-sharing service implicitly;
- logged by title/name/path;
- written into browser persistent storage beyond the explicit download; or
- retained by the application server as a complete archive.

Tracked tests use synthetic neutral values only.

## Versioning

Backward-compatible additions increment the profile minor version. A change
that removes/reinterprets a field, changes identity/path semantics, or weakens
validation increments the major version.

Every verifier supports an explicit set of major versions and rejects an
unknown major version. It may preserve unknown optional extension fields.

The profile version is independent of:

- the application package version;
- the D1 migration number;
- the RO-Crate version; and
- the Python tool version.

All four are recorded.
