# Portable preservation export operator runbook

Status: implementation complete locally; protected-staging rollout and the
owner's authenticated archive acceptance are recorded separately.

This runbook is for the admin-only portable export defined in
[portable-library-export.md](portable-library-export.md). It does not authorize
production changes, catalog/media writes, R2 writes or deletion, Access-policy
changes, or a cloud import.

## Prepare and download the private kit

1. Sign in to the protected application as an active administrator while
   online.
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
  uses 26 statements in one transactional `batch()`.
- R2 Standard includes 10 million Class B reads/month and has no Internet
  egress charge. A full build normally uses one Class B `GetObject` per object;
  Range resumption or retry adds reads. At 50% catalog growth, budget at least
  1.5 times the current object/read count plus retry headroom.

These are capacity boundaries, not a claim that a particular build costs zero.
Record the actual snapshot D1 `rows_read`/`rows_written`, Worker request/CPU
metrics available, and R2 Class B operations after protected-staging
acceptance.

Official references:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 transactional batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare Access CLI flow](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/)
