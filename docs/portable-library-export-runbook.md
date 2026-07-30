# Portable preservation export operator runbook

Status: implementation and protected-staging rollout are complete. A real
authenticated plan, private kit download, bounded content/range reads,
revocation, and cleanup passed. A later real kit exposed and received a
history-only representation correction. The corrected complete local archive
passed build-integrated and independent verification, and its plan was revoked
and purged. A later source-provenance deployment regression is corrected and
verified in protected staging.

This runbook is for the admin-only portable export defined in
[portable-library-export.md](portable-library-export.md). It does not authorize
production changes, catalog/media writes, R2 writes or deletion, Access-policy
changes, or a cloud import.

## Protected-staging status

Migrations through `0024_scan_readability_v2_keys.sql` are applied with none
pending. Worker `b95a572b-e8fe-4372-852d-ee6a0a72ae32` serves exact source
`5fad783833739facffe4cd1aeb3cc1da07ad90a2` with client/service-worker build
`f7237f7d3987` at 100%. Read-only version inspection confirms the exact
`SOURCE_COMMIT` plus the reviewed Access, D1, R2, Images, cron, audio, and
secret boundaries. Access still returns the expected unauthenticated redirect,
all migrations are complete, and the enforced processor snapshot has zero
critical or warning alerts.

The authenticated regression check received `201` and a ready schema-0023 plan
from that exact source. It reported 7,377 logical records, 2,115 payload items,
and 7,940,702,512 planned bytes. The plan was revoked without downloading a
kit, reading a payload, or building an archive. Creator recovery now returns no
active plan. Its 134 record chunks and 34 item chunks remain derived,
unavailable detail until the existing bounded scheduled cleanup becomes
eligible; retained audit state is one expired, three failed, and five revoked
sessions.

Aggregate postflight remains 644 Songs / 641 active, 335 lyric rows,
590 Scans / 588 active, 835 Recordings / 833 active, 1,624 media rows, and zero
foreign-key errors. The deployment itself wrote no D1 row; only the separately
authorized Prepare and revoke changed export-derived state.

Worker `39a615da-a23b-4931-b0fc-d0d7612fc39c` is the historical final accepted
archive checkpoint. It served exact source
`95e771537bbcc7cbf5036228ab25fba0ec8cbff5` and client/service-worker build
`a21da884e66a`; the later archive acceptance evidence below remains valid.

Portable source schema `0023` is deployed over database migrations through
`0024`. The guarded Scan reconciliation and later O-1 work are already accepted
and outside this repair. The schema-0022 figures in this runbook remain
historical evidence for the earlier accepted archive; do not use them as
expected counts for a future plan.

The owner's two earlier authenticated create requests rolled back cleanly and
retained bounded aggregate-only failure stubs. The second failure was not the
previously inferred D1 transaction execution boundary. An exact read-only
reproduction showed D1 rejecting the final six-term compound query with `too
many terms in compound SELECT`. That query computed the `unassignedMedia`
summary after all snapshot writes. The accepted implementation uses two
independent three-term sets and preserves the same coherent, all-or-nothing
snapshot.

Migration `0022` also stores 2,925 logical media-plan items in 46 chunks of at
most 64 while retaining 8,532 logical source records in 148 metadata chunks.
The accepted plan reported exactly those logical counts and
7,955,140,423 payload bytes. The private kit downloaded successfully, one
16,674-byte payload and one 64-byte range were read, and the plan was revoked.
All 148 record chunks and 46 item chunks were then purged, leaving its
aggregate audit stub. The temporary admin-only range probe was removed before
the final Worker deployment. No complete archive was built from that earlier
smoke plan.

The owner's next kit first reached the Python builder but failed before downloading
media with `export_item_representation_mismatch`. History-only durable media
had a correct plan item/path but no embedded catalog representation. The
deployed correction embeds those exact representations and adds a
browser-to-Python history-only round trip.

That owner-created plan survived deployment and the Account page recovered it
across refresh/tabs. A newly downloaded kit fixed the representation mismatch.
After moving the output/work paths outside the Git repository, the complete
7,972,873,832-byte archive passed build-integrated verification, independent
`verify`, and privacy-safe `inspect`. All three reconciled 2,925 objects /
7,955,140,423 payload bytes and the same archive digest. The plan is now
revoked, its 148 record chunks and 46 item chunks are purged, and only its
aggregate audit stub remains.

## Reviewed deployment source provenance

Use only `npm run deploy` for a reviewed Worker rollout. The repository-owned
deployment driver:

- requires execution from the project root with a completely clean Git
  worktree;
- resolves and validates the full 40-character lowercase `HEAD` commit before
  building;
- runs the full production/client/service-worker build;
- rechecks that the worktree is still clean and `HEAD` is unchanged;
- invokes Wrangler without a shell, with `--keep-vars`, the exact
  `SOURCE_COMMIT:<full HEAD>` binding, and a source-bearing version message; and
- stops before Wrangler on missing/malformed Git provenance, dirty or changing
  source, or a failed build.

`SOURCE_COMMIT` is deliberately not a static value in `wrangler.jsonc`, where
it would become stale. Do not replace the driver with raw `wrangler deploy` or
append manual deployment flags to the npm command. The driver rejects CLI
arguments so resource names, environments, bindings, and routes cannot be
silently overridden.

After deployment and before any Prepare action, inspect the new Worker version
read-only. Prove that `SOURCE_COMMIT` equals the deployed full Git commit and
that the binding inventory still includes the reviewed Access variables and
secrets, APAC D1, private R2, Images, audio settings, and scheduled handler.
Also confirm the expected unauthenticated Access redirect and run an
aggregate-only D1 check showing no unexpected export session/detail change.

## Prepare and download the private kit

1. Sign in to the protected application as an active administrator while
   online. Reload **Account** once; an existing unexpired plan is recovered
   automatically.
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
uses an aggregate-only resumable work directory next to the requested archive.
After a successful `VERIFIED` build it removes the downloaded-object cache and
checkpoint automatically.

Keep the extracted kit, output ZIP, and resumable work folder on a private disk
outside any Git/source-code repository, the kit itself, the home-directory
root, and any legacy folder. This prevents private export data from entering
source control. Change into the extracted `export-kit` directory, then run:

```bash
python3 tools/music_library_archive.py build \
  --kit . \
  --output ../music-library-preservation.zip

python3 tools/music_library_archive.py verify \
  ../music-library-preservation.zip

python3 tools/music_library_archive.py inspect \
  ../music-library-preservation.zip
```

If the kit remains inside a Git repository temporarily, use an explicit output
path outside that repository; the automatic resumable work folder is created
beside the output:

```bash
python3 export-kit/tools/music_library_archive.py build \
  --kit export-kit \
  --output /path/to/private-disk/music-library-preservation.zip
```

`cloudflared` may open the ordinary Access login in a browser. If it cannot open
one, follow the URL it prints. Do not copy the token into a shell variable, log,
or file; the builder obtains it with `cloudflared access login` and
`cloudflared access token -app=...`.

At startup the builder prints whether it created or reused the hidden automatic
work folder beside the output archive. If the build fails or is interrupted,
keep that named folder to resume, or delete it to discard the cached downloads.
With a custom `--work` directory, delete only its builder-owned `objects/`
directory and `checkpoint.json`; do not remove unrelated files.

The output is not accepted until `build` reports `VERIFIED` and the independent
`verify` command returns `"status": "VERIFIED"`. `inspect` prints aggregate
counts only. Add `--show-paths` only when deliberately inspecting private
friendly paths on the trusted computer.

An interrupted or failed build can be rerun with the same kit, output, and
default work location. Do not delete the work directory if resumption is wanted;
a successful build cleans it automatically. If the 24-hour plan expires or is
revoked before every object is verified, prepare a new kit.

## Inspect and exercise the local reference restore

Inspect representative active, Trash, history, typed-lyric, original-only
playback, distinct optimized, and unassigned-media cases. Then test the
constrained local reference restore:

```bash
python3 tools/music_library_archive.py restore-local \
  ../music-library-preservation.zip \
  --destination ../restored-library \
  --dry-run

python3 tools/music_library_archive.py restore-local \
  ../music-library-preservation.zip \
  --destination ../restored-library
```

The restore writes only to a new explicit destination, verifies first, restores
historical actors inactive, and is idempotent for an identical rerun. It is not
a deployed application or a cloud import adapter.

For an archive received from elsewhere, use the separately trusted repository
copy of `tools/music_library_archive.py` for `verify`, `inspect`, and
`restore-local`, rather than trusting the script inside the archive.

## Privacy and revocation

- Keep kits, archives, in-progress work directories, and restored databases out
  of Git and public file-sharing services.
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
  uses 26 statements in one transactional `batch()`. Metadata and payload-plan
  items are stored in chunks of at most 64 logical rows and expanded on read.
- R2 Standard includes 10 million Class B reads/month and has no Internet
  egress charge. A full build normally uses one Class B `GetObject` per object;
  Range resumption or retry adds reads. At 50% catalog growth, budget at least
  1.5 times the current object/read count plus retry headroom.

These are capacity boundaries, not a claim that a particular build costs zero.
Record the actual snapshot D1 `rows_read`/`rows_written`, Worker request/CPU
metrics available, and R2 Class B operations after protected-staging
acceptance.

Rollout measurements and estimates:

- migration `0022` completed 41 D1 commands in 39.61 ms. It touched only
  portable-export tables, triggers, indexes, and migration bookkeeping;
- the first item-chunk deployment still rolled back because of the compound
  query limit. Its observable D1 rows-written delta was 451, with no detail
  surviving. A bounded item insert proved 46 chunks / 2,925 logical items /
  7,955,140,423 bytes and was purged;
- the visible 24-hour D1 rows-written counter moved from 72,903 before this
  correction window to 75,059 at final reconciliation: +2,156, leaving 24,941
  under the daily 100,000 allowance at that observation. The window containing
  the successful snapshot and its postflight moved from 74,468 to 75,059:
  +591. Cloudflare metrics are asynchronous, so these are bounded observed
  deltas rather than a claim of per-statement billing attribution;
- after complete verification, export-only revocation/cleanup reported exactly
  198 D1 rows written and removed 148 + 46 chunks. The final rolling view
  showed 13,518 read queries, 176 write queries, 2,003,670 rows read, and
  75,839 rows written; the counter can decrease as its 24-hour window advances.
  The database returned from 10.3 MB with active detail to 5.14 MB, and
  foreign-key errors remain zero;
- the earlier bounded smoke acceptance used exactly two known R2 content reads: one complete
  16,674-byte object and one 64-byte range. It performed no R2 write, delete, or
  copy. The metadata kit itself reads only D1;
- the accepted complete build verified all 2,925 objects /
  7,955,140,423 payload bytes in a 7,972,873,832-byte archive. A clean run
  normally uses 2,925 Worker requests / R2 Class B reads; the aggregate bucket
  view does not attribute retries to one build. The 50% scenario is
  approximately 4,388 requests/reads and 11.93 GB; and
- final R2 reconciliation remains 2,933 objects / 8.1 GB, proving no object
  write, delete, or copy.

Official references:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 transactional batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare Access CLI flow](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/)
