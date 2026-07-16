# Staging audio-processing operator runbook

Status: protected-staging rollout completed and re-audited 2026-07-16. Commands
below are reference procedures, not standing authorization. Production remains
out of scope and requires fresh explicit approval.

Protected staging has the digest-pinned bounded Job, fixed-version runtime
secrets, dedicated Cloudflare Service Auth policy, and enabled 15-minute OAuth
Scheduler. Live no-work, real-processing, natural Scheduler, and keyless direct
dispatch checks have passed. Immediate Worker invocation uses Cloudflare Access
JWT-to-Google Workload Identity Federation; Cloudflare stores no Google JSON
key. Only the Scheduler identity and WIF provider principal set have Job-level
Invoker. The former trigger identity is disabled and its user-managed key is
deleted. The runtime identities have no project-wide role, and the default
Compute identity no longer has project Editor.

Use this together with [audio-processing.md](audio-processing.md),
[audio-processing-invocation.md](audio-processing-invocation.md), and
[recording-upload.md](recording-upload.md). Never copy command output containing
an account identity, billing identifier, secret value, signed URL, catalog ID,
object key, hash, filename, or private media path into tracked notes or logs.

## Hard gates

Stop before cloud creation unless all of these are true:

1. Git is clean at an owner-reviewed commit, all local suites and both fresh and
   existing-catalog migration chains pass, and any remote migration application
   has its separately approved and recorded D1 reconciliation. Protected staging
   completed that reconciliation through migration `0008` on 2026-07-15.
2. The pinned Linux `runtime` and `verification` image targets have actually
   built and run. The checks below and in the converter README must prove UID/GID
   `10001:10001`, libmp3lame availability, mounted dummy-secret readability,
   bounded tmpfs writes, cleanup, and a 2 GiB cgroup pass. Both pinned
   `linux/amd64` targets and the full local fixture passed on 2026-07-15; the
   exact hardened commit image subsequently matched its independently resolved
   registry digest and passed the reviewed automatic-scan/reachability gate;
   every future digest requires a new review. The first failed Cloud Run smoke
   proved the existing processor-token file is readable; the next approved
   no-work execution must also prove readability of the new root-owned Access
   credential file.
3. The owner has rechecked current pricing, the existing billing budget alerts,
   shared billing-account allowance use, and whether to approve the paid image
   vulnerability scan described below.
4. The protected Worker origin is exact HTTPS with no path or trailing slash.
   The processor token exists only in an ignored `0600` file during setup, a
   version-pinned Google secret, and the Cloudflare Worker secret.
   The hostname's Access application additionally requires a dedicated Service
   Auth token and policy. The processor must send the standard two Access
   headers on claim and every capability request while retaining its separate
   Worker bearer header. Never substitute a persistent Bypass policy.
5. The remote migration list and zero-job inventory match the expected state.
   Never use a staging catalog record as a disposable processing fixture.

Cloud Run Jobs always use the second-generation execution environment. Its
secret volume is root-owned, so each new non-root file mount needs a read smoke;
do not switch the processor to root to make the test pass. The bounded in-memory
mount must also be writable by the non-root process during the first approved
real Recording pass. A permissions failure is a stop condition, not permission
to fall back to a plain secret environment variable or unbounded filesystem.

## Reviewed names and local variables

Run future commands from the repository root in the isolated Google CLI
configuration. Replace the protected origin placeholder locally; do not commit
the replacement or a secret.

```sh
export CLOUDSDK_ACTIVE_CONFIG_NAME=music-library-audio-staging
export PROJECT_ID=music-library-audio-staging
export REGION=asia-south1
export RUNTIME_SERVICE_ACCOUNT=music-audio-runtime
export SCHEDULER_SERVICE_ACCOUNT=music-audio-scheduler
export REPOSITORY=music-audio
export IMAGE=processor
export RUN_JOB=music-audio-processor
export SCHEDULER_JOB=music-audio-processor-quarter-hour
export SECRET=music-audio-processor-token
export ACCESS_SECRET=music-audio-access-service-credentials
export WORKER_ORIGIN=https://replace-with-protected-staging-origin.example

export PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
export RUNTIME_SERVICE_ACCOUNT_EMAIL="${RUNTIME_SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
export SCHEDULER_SERVICE_ACCOUNT_EMAIL="${SCHEDULER_SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
export IMAGE_BASE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE}"
export SOURCE_REVISION="$(git rev-parse --short=12 HEAD)"
export IMAGE_TAG_URI="${IMAGE_BASE}:staging-${SOURCE_REVISION}"
```

Before every mutation, inspect rather than assume the active project and source:

```sh
test -z "$(git status --porcelain)"
git show --no-patch --oneline HEAD
gcloud config get-value project
gcloud config get-value run/region
gcloud services list --enabled --project "${PROJECT_ID}" --format='value(config.name)'
```

The operator must visually confirm the exact staging project and region. Do not
print the active account or billing-account ID into a captured transcript.

## Phase 1 — local image proof

These commands mutate only the local container runtime. They must pass before
enabling APIs or creating a repository:

```sh
cd services/audio-converter

docker build \
  --platform linux/amd64 \
  --target verification \
  --tag music-library-audio-converter:verify .
docker run --rm \
  --read-only \
  --cpus 1 \
  --memory 2g \
  --tmpfs /var/lib/music-audio:rw,noexec,nosuid,nodev,size=1207959552,uid=10001,gid=10001,mode=0700 \
  music-library-audio-converter:verify

docker build \
  --platform linux/amd64 \
  --target runtime \
  --tag music-library-audio-converter:local .
docker image inspect \
  --format '{{.Config.User}} {{.Architecture}} {{.Size}}' \
  music-library-audio-converter:local
docker run --rm \
  --entrypoint sh \
  music-library-audio-converter:local \
  -c 'test "$(id -u):$(id -g)" = "10001:10001" && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libmp3lame && ffprobe -version >/dev/null'
```

Test the entrypoint configuration loader with a generated dummy file. This does
not contact the Worker and must print only `{"configuration":"valid"}`:

```sh
umask 077
DUMMY_TOKEN_FILE="$(mktemp)"
DUMMY_ACCESS_FILE="$(mktemp)"
openssl rand -base64 48 | tr -d '\n' > "${DUMMY_TOKEN_FILE}"
DUMMY_ACCESS_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
printf '{"clientId":"dummy-service-token.access","clientSecret":"%s"}' \
  "${DUMMY_ACCESS_SECRET}" > "${DUMMY_ACCESS_FILE}"
unset DUMMY_ACCESS_SECRET
chmod 0444 "${DUMMY_TOKEN_FILE}"
chmod 0444 "${DUMMY_ACCESS_FILE}"
docker run --rm \
  --read-only \
  --mount "type=bind,source=${DUMMY_TOKEN_FILE},target=/var/run/secrets/audio-processor-token,readonly" \
  --mount "type=bind,source=${DUMMY_ACCESS_FILE},target=/var/run/secrets/audio-access-credentials,readonly" \
  --env AUDIO_PROCESSOR_WORKER_ORIGIN=https://worker.example.invalid \
  --env 'AUDIO_PROCESSOR_ALLOWED_TRANSFER_ORIGINS_JSON=["https://worker.example.invalid"]' \
  --env AUDIO_PROCESSOR_TOKEN_FILE=/var/run/secrets/audio-processor-token \
  --env AUDIO_PROCESSOR_ACCESS_CREDENTIALS_FILE=/var/run/secrets/audio-access-credentials \
  --env AUDIO_PROCESSOR_TEMPORARY_ROOT=/var/lib/music-audio \
  --entrypoint python \
  music-library-audio-converter:local \
  -c 'import json,os; from audio_converter.hosted_entrypoint import load_hosted_entrypoint_config; load_hosted_entrypoint_config(os.environ); print(json.dumps({"configuration":"valid"},separators=(",",":")))'
rm -f "${DUMMY_TOKEN_FILE}" "${DUMMY_ACCESS_FILE}"
unset DUMMY_TOKEN_FILE
unset DUMMY_ACCESS_FILE

cd ../..
```

Record only the aggregate fixture metrics, image byte size, FFmpeg version, and
pass/fail facts in the ignored handoff. Do not push an image yet.

## Phase 2 — D1 and Worker staging prerequisite

This phase is a Cloudflare mutation and needs separate approval. First inspect
the remote migration list. At the separately approved protected-staging
application on 2026-07-15, it showed exactly `0005` through `0008`; all four
migrations applied, their aggregate reconciliation passed, and the reviewed
Worker was deployed as version `dc349f79-e1b6-4d5a-979f-208795fe820d`. The
pre/post Time Travel bookmarks and counts are retained in the ignored handoff.
The commands below remain the procedure for a fresh environment or reviewed
recovery, not authorization to rerun the completed staging phase. Stop on any
divergence.

```sh
npx wrangler d1 migrations list music-library-staging-apac --remote
```

With the known zero upload/job inventory, migrations `0005`–`0008` are expected
to add processing/upload schema, triggers, and the single-running partial index
without changing a catalog row or media file. After fresh owner approval:

```sh
npx wrangler d1 migrations apply music-library-staging-apac --remote
```

Re-list migrations, then run only aggregate reconciliation. Expected job,
session, and foreign-key counts are all zero; both named `0008` guards must be
present exactly once:

```sh
npx wrangler d1 migrations list music-library-staging-apac --remote
npx wrangler d1 execute music-library-staging-apac --remote --command \
  "SELECT (SELECT COUNT(*) FROM recording_upload_sessions) AS upload_sessions, (SELECT COUNT(*) FROM audio_processing_jobs) AS jobs, (SELECT COUNT(*) FROM audio_processing_jobs WHERE status = 'running') AS running_jobs, (SELECT COUNT(*) FROM pragma_foreign_key_check) AS foreign_key_errors; SELECT COUNT(*) AS single_running_indexes FROM sqlite_master WHERE type = 'index' AND name = 'audio_processing_jobs_single_running_idx'; SELECT COUNT(*) AS expired_recovery_triggers FROM sqlite_master WHERE type = 'trigger' AND name = 'validate_audio_processing_job_expired_recovery';"
```

Deploy the reviewed Worker commit only after those counts pass. Protected
staging completed this deployment with no processor settings; the processor
routes therefore remain fail-closed. Do not redeploy from this runbook without
fresh authorization:

```sh
npm run build
npm run deploy
```

Do not combine migration application, deployment, or secret changes into an
unreviewed shell script. Capture the resulting Worker version in the ignored
handoff, not private response bodies.

## Phase 3 — Google APIs, identities, and repository

This entire phase needs owner approval. The four normal runtime APIs are:

```sh
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com \
  --project "${PROJECT_ID}"
```

Artifact Analysis scanning is a separate paid security decision. As checked on
2026-07-15, automatic scanning costs USD 0.26 for each new image digest. The
security-first proposed command is below, but it must not run without explicit
approval of that per-image cost:

```sh
gcloud services enable containerscanning.googleapis.com --project "${PROJECT_ID}"
```

If the owner declines scanning, create the repository with
`--disable-vulnerability-scanning` and do not deploy until an explicitly accepted
equivalent image review exists. Cost alone is not permission to omit all image
security review.

Create two keyless service accounts. Do not grant either a project-wide role:

```sh
gcloud iam service-accounts create "${RUNTIME_SERVICE_ACCOUNT}" \
  --display-name='Music audio runtime' \
  --description='Runs the one-task staging audio processor only' \
  --project "${PROJECT_ID}"
gcloud iam service-accounts create "${SCHEDULER_SERVICE_ACCOUNT}" \
  --display-name='Music audio scheduler' \
  --description='Invokes only the staging audio processor Job' \
  --project "${PROJECT_ID}"
```

Create one regional Docker repository. The Job is immutable because it is pinned
to the independently resolved digest; tags remain removable so reviewed old
images can be bounded without disabling a repository-wide immutability setting. Use
`--allow-vulnerability-scanning` only after approving and enabling the paid scan;
otherwise use the guarded alternative above:

```sh
gcloud artifacts repositories create "${REPOSITORY}" \
  --repository-format docker \
  --location "${REGION}" \
  --description='Pinned staging audio processor images' \
  --allow-vulnerability-scanning \
  --project "${PROJECT_ID}"
```

The runtime service account does not receive Artifact Registry Writer. Same-project
Cloud Run infrastructure pulls the image; add no extra repository grant unless a
documented pull failure proves one is required. The future operator needs Writer
only for the push and Service Account User only to attach the runtime identity.

## Phase 4 — real processor and Access secrets

Quiesce processing first: no Scheduler exists or it is paused, no Cloud Run
execution is active, and the aggregate D1 query reports zero running leases.
Generate the token into an ignored private file with no newline. Never export it
as an environment variable or pass it as an argument:

```sh
umask 077
export TOKEN_FILE=notes/private/audio-processor-token.pending
test ! -e "${TOKEN_FILE}"
openssl rand -base64 48 | tr -d '\n' > "${TOKEN_FILE}"
test "$(wc -c < "${TOKEN_FILE}" | tr -d ' ')" -ge 32
chmod 0600 "${TOKEN_FILE}"
```

Create the automatically replicated Google secret and version 1 directly from
that file, then grant only that secret to the runtime identity:

```sh
gcloud secrets create "${SECRET}" \
  --replication-policy automatic \
  --data-file "${TOKEN_FILE}" \
  --project "${PROJECT_ID}"
export SECRET_VERSION=1
gcloud secrets add-iam-policy-binding "${SECRET}" \
  --member "serviceAccount:${RUNTIME_SERVICE_ACCOUNT_EMAIL}" \
  --role roles/secretmanager.secretAccessor \
  --project "${PROJECT_ID}"
```

Configure the matching Cloudflare token and exact transfer origin as Worker
secrets. These are external Worker mutations and need their own approval:

```sh
npx wrangler secret put AUDIO_PROCESSOR_TOKEN < "${TOKEN_FILE}"
printf '%s' "${WORKER_ORIGIN}" | npx wrangler secret put AUDIO_PROCESSOR_TRANSFER_ORIGIN
```

After both stores report success, remove the transient file and clear its path:

```sh
rm -f "${TOKEN_FILE}"
unset TOKEN_FILE
```

Never use `latest` in the Job secret mount. Retain the prior disabled version
during future rotations until the new no-work and real-job checks pass.

Before retrying the Job, create a dedicated Cloudflare Access service token and
admit only that token through a Service Auth policy on the existing Access
application. Cloudflare displays the client secret only once. Under a separate
owner-approved operation, capture the ID and secret directly into one ignored
`0600` JSON file with exactly `clientId` and `clientSecret`; never print either
value, export either value, or place either in a command argument. Create the
automatically replicated `${ACCESS_SECRET}` from that file, pin its enabled
version, grant only its secret-level accessor role to the runtime identity, and
remove the transient file. Do not use a Bypass policy, Access single-header
mode, or ordinary environment-secret configuration. Before the Job command,
set `ACCESS_SECRET_VERSION` to that exact numeric enabled version; never use
`latest`.

This credential phase completed under separate owner approval on 2026-07-15.
A request carrying only the Access headers reached the processor route and
received the expected Worker `401` for its deliberately absent processor bearer,
proving Access admission without claiming work. Google stored an exact
byte-matched version 1 with automatic replication and only the existing runtime
identity as secret-level accessor. The transient local JSON was removed. The
runtime remains keyless with zero project-wide roles; the Job, Scheduler, D1,
R2, catalog, and registry remained unchanged.

## Phase 5 — push a reviewed digest and create a dormant Job

Return to the converter directory, retag the already-tested local runtime image,
authenticate Docker, push one unique source-revision tag, and resolve its
digest independently:

```sh
cd services/audio-converter
docker tag music-library-audio-converter:local "${IMAGE_TAG_URI}"
gcloud auth configure-docker "${REGION}-docker.pkg.dev"
docker push "${IMAGE_TAG_URI}"
export IMAGE_DIGEST="$(gcloud artifacts docker images describe "${IMAGE_TAG_URI}" --format='value(image_summary.digest)' --project "${PROJECT_ID}")"
test -n "${IMAGE_DIGEST}"
export IMAGE_DIGEST_URI="${IMAGE_BASE}@${IMAGE_DIGEST}"
cd ../..
```

Record the digest and compressed registry size in ignored operational notes.
Create the Job by digest, never tag, and do not use `--execute-now`. The alternate
dictionary delimiter keeps the JSON origin allowlist intact:

```sh
gcloud run jobs create "${RUN_JOB}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --image "${IMAGE_DIGEST_URI}" \
  --service-account "${RUNTIME_SERVICE_ACCOUNT_EMAIL}" \
  --tasks 1 \
  --parallelism 1 \
  --max-retries 0 \
  --task-timeout 50m \
  --cpu 1 \
  --memory 2Gi \
  --add-volume 'type=in-memory,mount-path=/var/lib/music-audio,size-limit=1152Mi' \
  --set-secrets "/var/run/secrets/audio-processor-token=${SECRET}:${SECRET_VERSION},/var/run/secrets/audio-access-credentials=${ACCESS_SECRET}:${ACCESS_SECRET_VERSION}" \
  --set-env-vars "^@^AUDIO_PROCESSOR_WORKER_ORIGIN=${WORKER_ORIGIN}@AUDIO_PROCESSOR_ALLOWED_TRANSFER_ORIGINS_JSON=[\"${WORKER_ORIGIN}\"]@AUDIO_PROCESSOR_TOKEN_FILE=/var/run/secrets/audio-processor-token@AUDIO_PROCESSOR_ACCESS_CREDENTIALS_FILE=/var/run/secrets/audio-access-credentials@AUDIO_PROCESSOR_TEMPORARY_ROOT=/var/lib/music-audio@AUDIO_PROCESSOR_REQUEST_TIMEOUT_SECONDS=60@AUDIO_PROCESSOR_RETRY_ATTEMPTS=3@AUDIO_PROCESSOR_RETRY_DELAY_SECONDS=0.25@AUDIO_PROCESSOR_MAX_SOURCE_BYTES=536870912@AUDIO_PROCESSOR_MAX_DERIVATIVE_BYTES=536870912@AUDIO_PROCESSOR_MAX_GENERATED_OUTPUT_BYTES=536870912@AUDIO_PROCESSOR_SOFT_DEADLINE_SECONDS=2700@AUDIO_PROCESSOR_MINIMUM_LEASE_REMAINING_SECONDS=3300" \
  --labels environment=staging,component=audio-processor
```

Describe and compare every material field with the command above. The export
contains configuration and secret names, never the secret value; keep it under
ignored private notes if retained:

```sh
gcloud run jobs describe "${RUN_JOB}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format export
```

Required facts are one task, parallelism one, retries zero, 50-minute timeout,
1 vCPU, 2 GiB, 1,152 MiB in-memory mount, fixed secret version, exact image
digest, runtime service account, and only the allowlisted `AUDIO_PROCESSOR_`
settings. Stop if any field differs.

## Phase 6 — manual staging verification

First query aggregate D1 state and require zero pending/running jobs. Execute the
Job once manually and wait:

```sh
npx wrangler d1 execute music-library-staging-apac --remote --command \
  "SELECT COUNT(*) AS total_jobs, COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_jobs, COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) AS running_jobs FROM audio_processing_jobs;"
gcloud run jobs execute "${RUN_JOB}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --wait
gcloud run jobs executions describe-latest \
  --job "${RUN_JOB}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}"
gcloud run jobs logs read "${RUN_JOB}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --limit 20
```

The application record must be exactly one aggregate `no_work` outcome with exit
zero. Its successful startup proves that the non-root process can read the
root-owned mounted secret file. Reject logs containing any catalog identifier,
URL, hash, path, token, response body, or exception representation.

Next use one owner-intended new Recording—not a disposable existing catalog row—
after the local browser creation/upload UI has been reviewed, deployed to protected
staging, and manually accepted for this test. Verify, in order:

1. upload/edit controls disable offline and no offline write queue appears;
2. original bytes remain private, immutable, fingerprinted, and non-playable
   while the Recording is processing;
3. one manual Job execution claims exactly one row and overlapping invocation
   returns no work;
4. temporary volume writes succeed as UID/GID 10001, FFmpeg output stays bounded,
   and the private directory is cleaned;
5. the Worker independently verifies source and playback bytes, records immutable
   provenance, and changes the Recording to ready exactly once;
6. authenticated browser playback uses only the stored verified source selected
   by the policy; Play never starts conversion;
7. a second Job execution reports no work; D1 has zero running jobs and zero
   foreign-key errors; and
8. aggregate execution logs and current cost/usage views contain no private data
   and remain inside the reviewed estimate.

Do not create the recurring trigger until both the no-work and real Recording
passes are accepted.

## Phase 7 — create paused-first scheduling

Cloud Scheduler's current create command has no atomic `--paused` flag. To avoid
a race, create it with the leap-day schedule below (the next occurrence after
this 2026 review is 2028), pause it immediately, then update it to the real
quarter-hour schedule while it remains paused. Recheck this safe-future premise
if the runbook is used after 2027.

First grant only Job-level invoker to the dedicated Scheduler identity:

```sh
gcloud run jobs add-iam-policy-binding "${RUN_JOB}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --member "serviceAccount:${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" \
  --role roles/run.invoker
```

Then create, pause, and update. The Google `run` API requires OAuth, not OIDC;
retry count is explicitly zero and the request body is `{}`:

```sh
gcloud scheduler jobs create http "${SCHEDULER_JOB}" \
  --project "${PROJECT_ID}" \
  --location "${REGION}" \
  --schedule '0 0 29 2 *' \
  --time-zone Etc/UTC \
  --uri "https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/${RUN_JOB}:run" \
  --http-method POST \
  --headers 'Content-Type=application/json' \
  --message-body '{}' \
  --oauth-service-account-email "${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" \
  --oauth-token-scope https://www.googleapis.com/auth/cloud-platform \
  --attempt-deadline 30s \
  --max-retry-attempts 0
gcloud scheduler jobs pause "${SCHEDULER_JOB}" \
  --project "${PROJECT_ID}" \
  --location "${REGION}"
gcloud scheduler jobs update http "${SCHEDULER_JOB}" \
  --project "${PROJECT_ID}" \
  --location "${REGION}" \
  --schedule '*/15 * * * *' \
  --time-zone Etc/UTC \
  --attempt-deadline 30s \
  --max-retry-attempts 0
gcloud scheduler jobs describe "${SCHEDULER_JOB}" \
  --project "${PROJECT_ID}" \
  --location "${REGION}"
```

The describe output must still say `PAUSED`, use the dedicated identity and
OAuth scope, target only this Job's `:run` URI, and have zero retries. Resume is
a final separate recurring-cost action, only after owner review:

```sh
gcloud scheduler jobs resume "${SCHEDULER_JOB}" \
  --project "${PROJECT_ID}" \
  --location "${REGION}"
```

After resume, inspect the first two scheduled executions and aggregate D1 state.
Pause immediately on repeated nonzero results, unexpected overlap, cost drift,
private logging, or any permission/configuration anomaly.

## Processor ops snapshot

Use the repository's read-only snapshot tool to collect one machine-readable
view of processor operations without hand-assembling multiple CLI commands:

```sh
npm run ops:processor-snapshot
```

For policy gates, use enforce mode:

```sh
npm run ops:processor-snapshot -- --enforce
```

For concise operator checkpoints and automation, use summary mode:

```sh
npm run ops:processor-snapshot -- --summary
```

`--summary` can be combined with `--enforce`; enforce still exits non-zero only
when any `critical` alert is present.

Warning-level log alerts are lookback-based by default (24 hours) so historical
accepted failures remain visible but do not appear as active warnings forever.
To tune this window:

```sh
npm run ops:processor-snapshot -- --alert-lookback-hours 6
```

Current severity policy in this command is:

- `critical`: foreign-key errors or non-aggregate stdout payload shapes;
- `warning`: pending/running D1 jobs, a stale direct-dispatch attempt,
  pre-intent upload sessions, missing Scan hashes/derivatives, Scan maintenance
  failures/expired leases, failed processor outcomes, or non-zero container exit
  lines inside the configured lookback window;
- `info`: Scheduler paused (unexpected while the reliability fallback is meant
  to be active, but not itself a data-integrity failure).

Historical failures/non-zero exits outside the lookback window are emitted as
`info` (`*_historical`) to preserve context without inflating active warnings.

The command only reads Cloud Run, Scheduler, Cloud Logging, and D1 aggregate
state. It must not be used as authorization to resume Scheduler, execute Jobs,
or mutate data.

Its parser now tolerates benign leading/trailing non-JSON CLI text and still
extracts the machine-readable payload, which reduces false failures from tool
prefaces while preserving strict alert semantics.

## Cost expectation checked 2026-07-15

These are allowances, not guarantees, and are shared by billing account:

- Cloud Run Jobs bill the entire instance lifetime with a one-minute minimum.
  At 96 triggers/day for 31 days, 2,976 idle executions consume at least 178,560
  vCPU-seconds and 357,120 GiB-seconds at 1 vCPU/2 GiB. Current monthly Job
  allowances are 240,000 vCPU-seconds and 450,000 GiB-seconds, leaving 61,440
  vCPU-seconds and 92,880 GiB-seconds before other billing-account use.
- Memory is the tighter idle headroom. Roughly 17 additional 45-minute,
  2-GiB worst-budget executions fit that remainder; actual conversions should be
  rare and shorter. Duplicate triggers, manual tests, and other projects reduce
  it. Pause rather than weaken processing if usage approaches the limit.
- One Scheduler job fits within the current three-free-jobs allowance. A paused
  job still counts; extra jobs are USD 0.10 per 31 days each.
- One active Secret Manager version and about 2,976 scheduled accesses fit the
  current shared allowances of six active versions and 10,000 accesses/month.
  Disabled old versions still count as active; destroy them only after rollback
  is no longer needed and with explicit approval.
- Artifact Registry includes 0.5 GiB-month of storage. Measure the pushed digest
  and keep only the deployed and one reviewed rollback digest if their combined
  compressed storage remains below it. Do not automate destructive cleanup.
- Automatic vulnerability scanning is not free: USD 0.26 per new digest. It is
  a small per-release security cost requiring explicit approval, not a recurring
  idle charge.
- Source download into Google is ingress. Derivative upload to the Worker is
  Premium Tier internet transfer. Current Premium pricing gives the first 1 GiB
  per billing account/month free for many destinations including ordinary Asia,
  then USD 0.12/GiB through 1 TiB; destination classification matters. A maximum
  512 MiB derivative can consume half that allowance. Verify the billing SKU
  after the private pass rather than assuming Cloudflare anycast classification.

Official facts and commands were rechecked against
[Cloud Run Job creation](https://docs.cloud.google.com/sdk/gcloud/reference/run/jobs/create),
[Cloud Run pricing](https://cloud.google.com/run/pricing),
[Job secret ownership](https://docs.cloud.google.com/run/docs/configuring/jobs/secrets),
[in-memory Job volumes](https://docs.cloud.google.com/run/docs/configuring/jobs/in-memory-volume-mounts),
[scheduled Job execution](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule),
[Scheduler pricing](https://cloud.google.com/scheduler/pricing),
[Secret Manager pricing](https://cloud.google.com/secret-manager/pricing),
[Artifact Registry pricing](https://cloud.google.com/artifact-registry/pricing),
[Artifact Analysis pricing](https://cloud.google.com/artifact-analysis/pricing),
[Premium network pricing](https://cloud.google.com/vpc/pricing),
[Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/),
and [Cloudflare Access Service Auth policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/).

## Rotation

Rotation is always quiescent:

1. Pause Scheduler and prove no Cloud Run execution and no unexpired D1 running
   lease remains. Wait for lease expiry rather than force-resetting a job.
2. Generate a new ignored `0600` token file. Add a new Google secret version and
   capture its numeric version; never use `latest`.
3. Update the dormant Cloud Run Job mount to the new numeric version.
4. Replace the Cloudflare processor-token secret from the same file.
5. Delete the local token file, run the manual no-work test, then process one
   owner-intended Recording or wait for the next approved real job.
6. Resume only after success. Retain the prior Google version disabled for the
   short rollback window, then separately approve destruction.

If either side changes while a job is running, callbacks can be invalidated. Do
not overlap versions or accept two tokens in application code.

## Rollback and stop procedures

The first response to uncertainty is to pause Scheduler:

```sh
gcloud scheduler jobs pause "${SCHEDULER_JOB}" \
  --project "${PROJECT_ID}" \
  --location "${REGION}"
```

Then inspect active executions and aggregate D1 state. A cancelled or killed
execution may leave a valid running lease; do not manually recycle it. The next
claim may recover it only after expiry and the database-enforced three-attempt
bound remains authoritative.

For an image regression, retain the previous digest and update without executing:

```sh
export PREVIOUS_IMAGE_DIGEST_URI="${IMAGE_BASE}@sha256:replace-with-reviewed-previous-digest"
gcloud run jobs update "${RUN_JOB}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --image "${PREVIOUS_IMAGE_DIGEST_URI}"
```

For a token regression while quiescent, pin the prior Google secret version and
re-enter the same prior value into the Cloudflare Worker secret, then rerun the
no-work check. Never print or recover a secret through logs.

Migration `0008` is additive and safe with zero jobs; the default rollback is to
leave its concurrency protections in place while the processor is paused. Do not
drop its index or trigger while any processor code/resource or job row exists.
A schema downgrade would also require deliberate migration-ledger reconciliation
and is a separate owner-reviewed operation, not an emergency one-liner.

If staging is rejected, keep the schedule paused, then separately approve removal
in dependency order: Scheduler job, its Job-level IAM binding, Cloud Run Job,
secret IAM binding and versions, service accounts, unreferenced image digests,
repository, and only then now-unused APIs. Deletion is irreversible and never
part of routine rollback. Preserve private R2 originals, playback objects, D1
catalog rows, and the AppSheet fallback.
