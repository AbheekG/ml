# Portable preservation export operator runbook

Status: implementation and protected-staging rollout are complete, including
the compact atomic-snapshot correction after the first authenticated plan
exceeded D1's practical execution boundary. The owner's post-fix authenticated
plan/sample and full local archive acceptance remain manual.

This runbook is for the admin-only portable export defined in
[portable-library-export.md](portable-library-export.md). It does not authorize
production changes, catalog/media writes, R2 writes or deletion, Access-policy
changes, or a cloud import.

## Protected-staging status

Migration `0021_portable_exports.sql` is applied with no migration pending.
Worker `0bc3591d-a7f7-4c90-9491-b7612e65049e` serves implementation commit
`cfcc926` and client/service-worker build `a2c8581e769d` at 100%. Pre/post
catalog and media reconciliation is unchanged, Access still returns the
expected unauthenticated redirect, and R2 remains 2,933 objects / 8.1 GB.

The owner's first authenticated create request against the preceding Worker
rolled back cleanly and retained one bounded failed audit stub. Aggregate D1
evidence showed that the original per-source-row representation executed
40,231 indexed row writes before the single transaction exceeded its execution
boundary. Every source/plan precondition was valid, and a separately bounded
export-table-only diagnostic proved the migration's ready guard. That
diagnostic was revoked and its detail purged.

The corrected Worker preserves the same one-transaction snapshot but stores
8,532 logical source records in 148 bounded metadata chunks. It still stores
all 2,925 media plan items individually. The largest measured chunk from the
widest current source table is 101,158 bytes against the 1 MiB database guard,
and the index-aware transaction estimate is now about 15,100 row writes.

This execution environment still has no usable authenticated browser backend
and no installed `cloudflared`, so it did not perform a post-fix authenticated
create, kit download, R2 payload read, or full archive build. The export tables
currently contain no detail rows: only the failed owner audit stub and the
revoked/purged diagnostic audit stub remain. Do not interpret the deployment as
an authenticated smoke pass. Preparing/revoking one post-fix plan, checking one
bounded original/derivative/range sample, recording request CPU and exact
snapshot D1 metrics, and building the full archive are the manual acceptance
below.

## Prepare and download the private kit

1. Sign in to the protected application as an active administrator while
   online. Reload **Account** once if it is still showing the pre-fix failure.
2. Open **Account → Portable backup**.
3. Select **Prepare export kit** and review the snapshot time, 24-hour expiry,
   active/Trash/history counts, planned object count, bytes, and disk estimate.
4. Select **Download export kit**. Store the ZIP on a private local disk and
   extract it into a new directory.

The kit contains private metadata, but no media, Access token, R2 object key, or
storage credential. It is not a completed backup.

## Build and verify

Use Python 3.11 or newer and the official `cloudflared` CLI. The builder uses
four bounded downloads by default, keeps the Access token only in memory, and
retains an aggregate-only resumable work directory next to the requested
archive.

From the directory containing the extracted `export-kit`:

```bash
python3 export-kit/tools/music_library_archive.py build \
  --kit export-kit \
  --output music-library-preservation.zip

python3 export-kit/tools/music_library_archive.py verify \
  music-library-preservation.zip

python3 export-kit/tools/music_library_archive.py inspect \
  music-library-preservation.zip
```

`cloudflared` may open the ordinary Access login in a browser. If it cannot open
one, follow the URL it prints. Do not copy the token into a shell variable, log,
or file; the builder obtains it with `cloudflared access login` and
`cloudflared access token -app=...`.

The output is not accepted until `build` reports `VERIFIED` and the independent
`verify` command returns `"status": "VERIFIED"`. `inspect` prints aggregate
counts only. Add `--show-paths` only when deliberately inspecting private
friendly paths on the trusted computer.

An interrupted build can be rerun with the same kit, output, and default work
location. Do not delete the work directory if resumption is wanted. If the
24-hour plan expires or is revoked before every object is verified, prepare a
new kit.

## Inspect and exercise the local reference restore

Inspect representative active, Trash, history, typed-lyric, original-only
playback, distinct optimized, and unassigned-media cases. Then test the
constrained local reference restore:

```bash
python3 export-kit/tools/music_library_archive.py restore-local \
  music-library-preservation.zip \
  --destination restored-library \
  --dry-run

python3 export-kit/tools/music_library_archive.py restore-local \
  music-library-preservation.zip \
  --destination restored-library
```

The restore writes only to a new explicit destination, verifies first, restores
historical actors inactive, and is idempotent for an identical rerun. It is not
a deployed application or a cloud import adapter.

For an archive received from elsewhere, use the separately trusted repository
copy of `tools/music_library_archive.py` for `verify`, `inspect`, and
`restore-local`, rather than trusting the script inside the archive.

## Privacy and revocation

- Keep kits, archives, work directories, and restored databases out of Git and
  public file-sharing services.
- Normal progress and checkpoints are aggregate-only. Do not paste
  `--show-paths` output into routine tickets or logs.
- **Revoke this kit** disables its remaining server reads but cannot recall an
  already downloaded kit or local archive.
- The server retains only an export audit stub after bounded detail cleanup. It
  never assembles or stores the final archive.

## Current Cloudflare operating boundary

Official limits and prices were rechecked on 2026-07-24:

- Workers Free permits 100,000 requests/day, 10 ms CPU per HTTP invocation,
  128 MB memory, and 50 subrequests per invocation. Export media is streamed
  through one R2 read per request rather than buffered.
- D1 Free permits 50 queries per Worker invocation, 5 million rows read/day,
  100,000 rows written/day, and a 500 MB database. Snapshot creation currently
  uses 26 statements in one transactional `batch()`. Metadata is stored in
  chunks of at most 64 logical rows and returned one chunk per API page.
- R2 Standard includes 10 million Class B reads/month and has no Internet
  egress charge. A full build normally uses one Class B `GetObject` per object;
  Range resumption or retry adds reads. At 50% catalog growth, budget at least
  1.5 times the current object/read count plus retry headroom.

These are capacity boundaries, not a claim that a particular build costs zero.
Record the actual snapshot D1 `rows_read`/`rows_written`, Worker request/CPU
metrics available, and R2 Class B operations after protected-staging
acceptance.

Rollout measurements and estimates:

- the migration completed 17 D1 commands in 2.89 ms; across the bounded
  migration/deployment window the 24-hour counters moved from 508 to 528 read
  queries, 1 to 10 write queries, 189,038 to 222,219 rows read, and 5 to 32
  rows written. Every explicit pre/post aggregate query reported
  `changed_db=false` and zero rows written;
- deployment reported 17 ms Worker startup time. Per-request export CPU is not
  available because no authenticated export request ran;
- the first authenticated snapshot attempt measured 40,231 rolled-back D1 row
  writes with the original one-storage-row-per-record representation. The
  corrected current snapshot source has the same 8,532 logical records and
  2,925 payload items but only 148 internal record chunks. Its index-aware
  structural estimate is about 15,100 D1 row writes; capture the actual D1
  billing metric during the post-fix manual plan rather than treating that
  estimate as measured usage;
- a current full build is approximately 2,925 Worker content requests, 2,925
  R2 Class B reads, and 7,955,140,423 payload bytes before retries. The 50%
  scenario is approximately 4,388 requests/reads and 11.93 GB; and
- this rollout performed zero authenticated export requests and zero R2 payload
  reads. The bucket-information control query did not read an object.

Official references:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 transactional batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare Access CLI flow](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/)
