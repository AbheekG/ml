# Recording upload object cleanup

Status: the read-only inventory and dry-run planner is implemented locally. It
has no deletion mode. No R2 object or D1 row is authorized for deletion by this
record alone.

## Scope and boundary

Completed multipart objects can remain private and unreferenced when an editor
discards a stored/duplicate upload or when storage verification fails. Their D1
upload-session, intent, part, and credit records remain immutable audit history.
Incomplete multipart uploads remain under the separate R2 lifecycle rule and
are outside this planner.

The planner reads every upload session and D1 foreign-key state, then streams
only terminal `failed` or `aborted` object keys from private staging R2 to count
and hash their bytes. It never lists filenames, identities, session IDs, object
keys, hashes, or multipart facts on stdout. Detailed facts may be written only
to an ignored private path with mode `0600`.

There is deliberately no `--delete`, `--write`, R2 deletion call, D1 mutation,
schema migration, Worker route, scheduled trigger, or production target in this
slice. Unknown arguments fail closed.

## Automatic eligibility policy

Policy `recording-upload-object-cleanup-v1` uses a 30-day grace period by
default and rejects any configured grace period shorter than seven days. An R2
object is merely *eligible for a future separately approved deletion plan* only
when every condition below holds:

- the immutable session is terminal `failed` with exact error
  `user_discarded`;
- the session has a completed multipart upload ID and a valid expected SHA-256;
- exactly one immutable create/replace intent exists;
- no Recording ID, duplicate-media ID, or `media_objects.object_key` reference
  exists;
- the terminal `updated_at` is at or before the grace cutoff;
- D1 has zero foreign-key errors; and
- a fresh streamed R2 read exactly matches the session byte size and SHA-256.

An already-missing unreferenced object is reported as `already_absent`, not as
eligible. Aborted sessions, pre-intent sessions, non-`user_discarded` failures,
referenced objects, young sessions, missing hashes/upload IDs, or R2 size/hash
mismatches are `manual_review`. Recoverable `stored`/`duplicate` sessions and
successful `finalized` sessions are never probed or considered.

## Read-only use

Run the aggregate-only staging inventory:

```bash
npm run ops:plan-upload-cleanup
```

To save the detailed digest-bound plan under the default ignored private path:

```bash
npm run ops:plan-upload-cleanup -- --write-report
```

`--grace-days N` may increase or reduce the 30-day default within the enforced
7–3,650-day range. `--report-path` is accepted only together with
`--write-report` and only under `notes/private/` or `data/import-output/`.

The JSON stdout contains only aggregate counts, eligible bytes, reason counts,
and whether a private report was written. The private report binds the capture
time, cutoff, fixed staging resources, policy, D1 facts, streamed R2
observations, decisions, and complete ordered items to `planSha256`.

## First protected-staging inventory

The read-only run on 2026-07-17 inspected all 11 upload sessions and streamed
the seven terminal objects. All seven objects were present. Zero objects and
zero bytes were eligible; all seven require manual review because the 30-day
grace period has not elapsed, and six also have no immutable upload intent.
There were zero foreign-key errors. The detailed ignored mode-`0600` report is
bound by plan SHA-256
`f509bbf8bb0a0ac1d1651919f79152b7236d2f547d4597d564ecde72f2347f03`.
No object or database row was changed.

The owner accepted deferring another review until roughly 30 days have elapsed.
Do not treat the current report as deletion authorization. Generate a fresh
read-only report no earlier than 2026-08-16; the six pre-intent cases will still
require explicit private owner evidence even after their grace period.

## Future deletion gate

A future deletion executor is not implied or authorized. Its separate design
must require a freshly generated reviewed plan, exact plan-digest confirmation,
explicit owner approval, and an immediate repeat of all D1/reference and R2
size/hash checks. It must delete only the exact eligible R2 object, retain every
D1 upload/audit row, use a small bounded batch, stop on any drift, and verify
post-delete absence. Pre-intent/manual-review cases require an additional
private owner-bound allowlist or other explicit evidence; they must never become
eligible by inference or elimination.
