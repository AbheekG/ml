# Hosted audio-processing invocation

Status: proposed local design for owner review, 2026-07-14. Nothing in this
document authorizes cloud creation, configuration, deployment, or staging
changes.

## Scope

This document chooses how the existing one-job hosted adapter should eventually
run. It does not change the processing contract in
[audio-processing.md](audio-processing.md), create a server, add a container, or
provision credentials or infrastructure.

The boundary must preserve these invariants:

- uploaded originals remain private and unchanged;
- the processor receives only one opaque, expiring job capability at a time;
- no public media URL or broad R2 credential reaches Google Cloud;
- a browser Play request never starts conversion;
- editing and upload remain online-only; and
- a duplicate trigger, crash, timeout, or lost response cannot process two jobs
  concurrently or publish unverified playback media.

## Decision

Use a **single-task Google Cloud Run Job**, invoked periodically by **Cloud
Scheduler through the authenticated Google `jobs.run` API**. Do not wrap the
adapter in a Cloud Run Service or add an HTTP framework.

The container entrypoint will load bounded configuration, call
`run_hosted_job_once()` exactly once, emit one aggregate outcome, and exit. A
15-minute UTC schedule is the initial balance between upload-to-processing
latency and idle invocation cost. This interval is configuration, not a product
or schema invariant.

A Cloud Run Service is not the initial choice because a direct Scheduler HTTP
target has a shorter request deadline than the Worker's one-hour lease, and a
timed-out service request can continue executing after the caller disconnects.
A Job also matches the existing run-once adapter without creating another
application endpoint.

## Ownership and authentication

The responsibilities remain deliberately separate:

- Cloud Scheduler owns only the periodic trigger. A dedicated scheduler service
  account receives Cloud Run Invoker on this one Job, not project-wide editor
  access. Scheduler calls the Google API with OAuth; it never knows the audio
  processor token.
- The Cloud Run Job runtime uses a separate service account. Its only initial
  Google API permission is Secret Manager Secret Accessor on the one processor
  token secret. It has no D1, R2, Cloud Storage, or catalog credential.
- The high-entropy processor token is stored as a version-pinned Secret Manager
  file and read at process startup. The matching value remains a Cloudflare
  Worker secret. It is never a command-line argument, ordinary environment
  variable, image layer, tracked file, or log field.
- The Worker origin and identical transfer-origin allowlist are non-secret
  configuration. All actual media access still uses the existing short-lived,
  operation-bound Worker capabilities.
- Deployment credentials remain owner/operator credentials and are not attached
  to the runtime or Scheduler identities.

Token rotation is a quiescent operation: pause the schedule, wait until no
unexpired processing lease exists, update both secret stores and the pinned Job
secret version, verify configuration, then resume. Rotating either side while a
job is running would invalidate its callbacks.

Cloud Run Job secret volumes are root-owned even when the container process is
non-root. The container smoke test and first approved no-work execution must
prove that the pinned file's mode is readable by the intended non-root runtime
user without making the processor itself root. Fail startup closed if it is not;
do not silently fall back to a plain environment value.

## One-job concurrency

Cloud Run settings alone are insufficient. One task and parallelism one limit a
single Job execution, but a later scheduled API call or rare duplicate trigger
can create another execution while the first is still active.

Before deployment, the Worker/D1 claim path must therefore enforce the global
invariant that at most one audio-processing job is `running`:

1. add a partial unique database index covering the single `running` status;
2. keep the pending-to-running update atomic and add an explicit `NOT EXISTS`
   check for another unexpired running lease so overlap returns `204` instead of
   relying on a constraint error; and
3. test simultaneous claims, duplicate scheduled executions, expired-lease
   recovery, and a pre-existing running job.

D1 serializes statements for one database and executes `batch()` as a
rollback-safe transaction, so the database invariant is the authoritative gate.
The proposed Cloud Run Job still uses one task, parallelism one, and zero task
retries as defense in depth.

## Deadlines and recovery

The current Worker grants a 60-minute lease. The hosted implementation must use
three nested limits:

| Limit | Initial value | Purpose |
| --- | ---: | --- |
| Processor soft budget | 45 minutes | Stop transfer/FFmpeg work and retain time for cleanup plus a failure callback. |
| Cloud Run task timeout | 50 minutes | Terminate a stuck process before the Worker can recycle its lease. |
| Worker lease | 60 minutes from claim | Keep every capability stale before a later claim can reuse the job. |

The entrypoint records a monotonic process deadline. Before deployment, the
adapter and FFmpeg runner must enforce that deadline across streamed transfer,
probe, complete decode, conversion, verification, upload, and callback phases.
The adapter must also require at least 55 minutes of lease remaining when it
accepts a claim. A processing soft-timeout should attempt a bounded
`processing_deadline_exceeded` failure callback; it must not wait for the
platform to kill the task.

If the process is killed or connectivity prevents that callback, the job remains
`running` only until its capability expires. A scheduled execution during that
period gets no work. The first schedule after expiry recovers the job, no later
than one schedule interval after the lease expires. Because the platform timeout
precedes the lease by at least ten minutes, the old process cannot still be
valid when recovery occurs.

Automatic lease-loss recovery must also be bounded before deployment. The
initial rule is at most three total expired processing attempts for a job; the
third expiry records the privacy-safe `processing_lease_expired` failure on the
job and Recording instead of creating an endless hourly cost loop. An editor can
then make the existing explicit retry decision. Normal reported processing
failures remain terminal until that editor retry.

## Retry and reconciliation rules

- Scheduler retry count is zero. The next scheduled execution is the retry for a
  failed or ambiguous `jobs.run` call.
- Cloud Run task retry count is zero. A platform retry would obscure whether the
  first task claimed a lease.
- Claim remains a single attempt inside one container execution. A lost claim
  response is reconciled only by lease expiry.
- Source transfer and create-only derivative upload retain their existing
  bounded integrity checks. A replayed derivative PUT can only confirm the same
  immutable attempt object.
- Result and failure callbacks retain bounded idempotent retries. An ambiguous
  result callback never becomes a contradictory failure callback.
- A duplicate Scheduler request or overlapping Job execution is harmless: one
  claim wins and every other execution exits successfully with `no_work`.
- `no_work` and verified success exit zero. A durably reported processing
  failure, an ambiguous callback, invalid configuration, authentication failure,
  or exhausted transport exits nonzero. Neither platform is configured to retry
  that same execution automatically.

The Worker/D1 state remains the source of truth. Cloud Run execution state is
operational evidence only and never makes a Recording ready or failed by itself.

## Temporary storage and resource bounds

The configured source and derivative ceilings are each 512 MiB. Merely checking
the derivative before upload is too late: an unusually long, low-bit-rate source
could create a larger temporary output or run until the task timeout.

Before deployment, hosted conversion must therefore enforce both the 45-minute
soft budget and a hard generated-output byte ceiling while FFmpeg is writing.
Exceeding either limit reports a bounded failure and removes the temporary
directory. A size-limited in-memory volume prevents filesystem growth beyond the
declared budget even if the process misbehaves.

Initial Job sizing is:

- 1 vCPU and 2 GiB memory;
- a 1,152 MiB in-memory volume mounted as the explicit temporary root;
- one task, parallelism one, zero retries, and a 50-minute task timeout; and
- `asia-south1` (Mumbai), subject to owner confirmation during approved setup,
  because it is a Tier 1 Cloud Run region close to the APAC data placement.

The volume can hold the bounded source and derivative together with limited
headroom. Its bytes count against container memory, so a worst-case local
fixture must verify successful processing and cleanup within 2 GiB before cloud
creation. Increase memory only from measured evidence. Do not depend on the
Preview ephemeral-disk feature for the initial deployment.

## Aggregate-only observability

The entrypoint may emit one structured outcome containing only:

- outcome: `no_work`, `succeeded`, `failed`, or
  `reconciliation_required`;
- playback kind when succeeded;
- an allowlisted error code when failed;
- elapsed milliseconds and coarse phase timings; and
- non-sensitive process metadata such as policy version.

It must never emit a job, Song, Recording, or media ID; title; filename;
filesystem path; source or derivative hash; source/derivative/callback URL;
capability; token; request or response body; or exception representation that
could contain one. Cloud Run's platform execution identifier is acceptable
because it is not a catalog identifier.

Initial alerts should use aggregate failed execution counts, repeated nonzero
outcomes, and billing thresholds. Investigation that joins an execution to a
private job belongs only under ignored private notes.

## Cost boundary

Cloud Run Jobs currently have a one-minute minimum billable lifetime. A
15-minute schedule normally creates 96 idle executions per day, before any rare
duplicate trigger. At 1 vCPU and 2 GiB, the idle minimum alone fits within the
currently published monthly Cloud Run free CPU and memory allowances, but those
allowances are shared by billing
account and actual processing adds usage. Outbound transfer from Google Cloud to
the Worker, Artifact Registry storage/builds, Secret Manager, logs, and any usage
above free allowances can still be billed.

Before enabling the schedule, the owner must review a current pricing-calculator
estimate, configure a small billing budget/alert, and approve the recurring
external action. The schedule is created paused and is resumed only after a
manual no-work execution and one private end-to-end staging job pass.

## Local implementation gates

The smallest safe sequence after this design is accepted is:

1. implement and test the database-backed single-running-job invariant plus
   bounded expired-lease recovery; do not apply the migration remotely;
2. add the processor soft deadline, streaming/generated-output bounds, and
   deadline tests without adding a server or container;
3. add a minimal run-once entrypoint with strict configuration loading,
   aggregate logging, and exit-code tests;
4. add and locally test a pinned, non-root FFmpeg container and resource fixture;
5. separately review exact cloud commands, identities, costs, secret rotation,
   rollback, and staging verification; and
6. only with explicit owner approval, create/configure cloud resources and
   deploy to staging.

Each local step is independently reviewable. Production remains out of scope.

## Platform facts checked for this decision

Platform behavior was rechecked against official documentation on 2026-07-14:

- [Cloud Run Job creation, task count, retries, and timeouts](https://docs.cloud.google.com/run/docs/create-jobs)
- [Cloud Run Job task timeout](https://docs.cloud.google.com/run/docs/configuring/task-timeout)
- [Scheduling a Cloud Run Job with OAuth](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule)
- [Cloud Scheduler duplicate/idempotency behavior](https://docs.cloud.google.com/scheduler/docs/creating)
- [Cloud Scheduler retry behavior](https://docs.cloud.google.com/scheduler/docs/configuring/retry-jobs)
- [Cloud Run Job secrets](https://docs.cloud.google.com/run/docs/configuring/jobs/secrets)
- [Cloud Run Job memory](https://docs.cloud.google.com/run/docs/configuring/jobs/memory-limits)
- [Cloud Run Job in-memory volumes](https://docs.cloud.google.com/run/docs/configuring/jobs/in-memory-volume-mounts)
- [Cloud Run pricing and minimum Job billing](https://cloud.google.com/run/pricing)
- [Cloud Scheduler pricing](https://cloud.google.com/scheduler/pricing)
- [D1 transaction and batch behavior](https://developers.cloudflare.com/d1/worker-api/d1-database/)
