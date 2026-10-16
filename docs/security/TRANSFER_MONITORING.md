# Transfer backlog and source-window monitoring

Implemented and tested October 15, 2026. These are observations of the transfer ledger, separate from camera capture health and from proof of 60/90-day retention. No unattended Ring export permission, camera storage setting, independent archive or notification recipient was invented by this change.

## What is measured

Every worker heartbeat evaluates each configured Ring camera against the completed historical windows. The evaluated archive target is the preceding 90 days, bounded by the configured recording start, plus older active investigation-hold intervals within that configured recording period. Released holds do not extend that range. Footage required outside the configured recording period needs separate investigation review.

Coverage uses actual verified segment start/end times and a recorded readback timestamp that is present and not in the future. Job completion, snapshots, events and camera online status cannot fill a gap. Coverage is separated into:

- **Originals not yet preserved:** intervals with no verified preserved original, whether local or independent.
- **Not independently archived:** intervals with no verified independent archive receipt. A local copy does not satisfy this measure.
- **Pending transfer jobs:** all outstanding media jobs, including blocked/failed jobs; this is a count of work, not a footage-duration measurement. The API also separates original-preservation and playback job counts. Failed playback work has its own fault and does not revoke verified original coverage.

The display reports total missing duration, oldest missing original, job counts, evaluation endpoint and the basis for the source-window estimate. A 33 ms hole remains a hole even when its job is complete. Preserving an original locally removes its upstream-retrieval risk, while the independent-archive backlog remains visible. These statements rely on the last verified receipt; the monitor does not perform a full remote readback every 30 seconds. Scheduled reconciliation can revoke invalid coverage. Its interval, provider bandwidth budget and sustained-volume performance still require commissioning.

Observations older than 90 seconds or timestamped in the future display **Monitoring unconfirmed**. Camera-scoped users receive only their cameras' operational observations. Inspector sessions receive none of these operational records; their request-specific playback and evidence permissions remain separate.

## Source limits and warnings

Ring's current support page describes **up to 14 days** of continuous history and a separately configurable 24/7 Video Storage Time. That is an advertised upper bound, not proof that this account retains every interval for 14 days. Network/power problems, recording modes, user deletion and shorter settings can reduce availability. The official historical-download endpoint retrieves existing recordings and does not start recording. [Ring 24/7 recording](https://ring.com/support/articles/wtr7r/24-7-recording-security-cams), [official API](https://developer.amazon.com/docs/ring/api-documentation.html).

Until the camera's actual setting is recorded, the dashboard labels its 14-day estimate **advertised maximum only**, raises a setting-unconfirmed fault, and cannot report fully current monitoring. No expiration instant is asserted as guaranteed. A configured camera can supply `continuousHistoryDays` (integer 1–14) and a non-empty `continuousHistoryEvidence` reference through the existing private `configure-ring` file. The setting is operational evidence, not vendor approval or a retention guarantee. Do not change the camera's `enabledAt` merely to remove an old gap.

Missing originals or independent archive coverage whose oldest gap is at least 15 minutes old raise backlog faults. This is an engineering transfer target, not an OCM rule or camera-failure detection deadline. Missing original footage raises a source-window warning when the oldest gap is within two days of the estimated boundary, or within one-quarter of the configured history for shorter settings. Crossing that boundary raises an exceeded-window fault. These faults neither delete records nor assert that all historical footage is irretrievable; a reviewer may still investigate official retrieval options and preserved copies.

Unapproved export policy, disabled previously scheduled cameras, changed recording-start configuration, failed jobs, failed observations and scheduler errors remain explicit faults. Cameras never configured for unattended exports show monitoring not configured, rather than a false healthy source.

## Durable scheduling

The scheduler now saves a cursor per camera. A transaction inserts each batch's jobs and advances its cursor together; interruption cannot advance past missing jobs. Windows stay anchored to the configured recording start, use 299-second steps with one second of lookback, and wait at least five minutes after the requested end. Existing payloads and job IDs are never retimestamped by retry.

Each scheduling call admits at most 120 windows per camera. The worker schedules on its periodic heartbeat and between completed jobs, so a long catch-up queue does not prevent new windows being admitted. Disk pressure pauses new admission while observations continue. The scheduler no longer rebuilds a moving 13-day window on each pass.

New scheduling is limited to candidates near Ring's advertised 14-day maximum. When a cursor or initial setup precedes that window, the skipped scheduling interval is recorded in the audit history. Its missing coverage remains visible in monitoring; the cursor is not evidence that those recordings were exported. Existing jobs and evidence are preserved. Changing the configured recording start after a cursor exists requires reviewed migration; the scheduler does not silently reset its obligation. Shorter actual storage settings affect risk warnings but do not turn the maximum scheduling window into a verified availability claim.

## Preservation priority and separate playback jobs

The worker now completes an original-transfer job only after the verified receipt, segment record and a separate background playback job are committed together. A failed database transaction cannot mark the original job complete without its durable follow-up. Retrying an already preserved original verifies its receipt and restores the playback job without asking Ring for a new download. Existing job identities and original bytes are preserved.

Queue selection considers all due jobs, across cameras, in this order:

1. Missing Ring originals still within their **estimated** source window, earliest estimated boundary first. A confirmed camera setting is used when recorded; otherwise the rank explicitly uses the unconfirmed advertised maximum.
2. Other original preservation, including already queued Ring requests beyond that estimate and local imports. Being beyond an estimate does not delete a job or declare footage irretrievable.
3. Requested playback/evidence work and follow-up on originals already preserved.
4. Scheduled full-byte archive verification.
5. Automatic background playback creation.

The selection is recalculated from current metadata on each claim and saved in `job-dispatch`. Retry deadlines, active leases, same-segment serialization, permission checks and request timestamps are unchanged. Disabling camera exports now blocks an already queued Ring download before any provider request. A claimed operation is not preempted; this ordering does not guarantee deadline completion, user-response latency or unlimited throughput.

Background playback uses a hash-verified managed staging copy where available and otherwise reads the preserved archive. It rechecks the segment and deletion intent before publication. Encoding failures leave the original complete and raise a separate playback fault. New original transfers can run before the next background encoding job. Requested playback still requires current named-user authorization; automatic initial playback creation does not grant anyone access.

When optional cache cleanup is enabled and independently commissioned, a merely queued background playback job does not pin old verified duplicates on a full disk: that job can rebuild from the preserved archive. A running encoder, active holds, recent access and the other safety checks still block eviction. This avoids a capacity deadlock between queued background work and cleanup. Source originals in the archive are unchanged.

Startup admits due archive-verification jobs instead of synchronously rereading the whole archive. Hold checks still run before dispatch; those checks, source download/media verification and any operation already running consume time. Sustained catch-up throughput on the Mini, the recurring verification budget, short-history settings and external notification delivery remain commissioning work. A partial completed export remains a visible gap; priority ordering alone does not discover additional vendor footage or repair that gap.

## Scheduled archive reconciliation

The worker admits due checks at startup and on its heartbeat. `SECURITY_ARCHIVE_VERIFY_HOURS` defaults to **168 hours (seven days)**, configurable to an integer from 1–720. This is an engineering default for commissioning, not a regulatory interval. A heartbeat admits at most 20 due segments. Each segment has one stable `archive-verify` job; queued/running work is reused, and completed work becomes due again after its last successful readback. Missing/future receipt timestamps are due immediately. This avoids a complete archive scan over the network on every worker restart.

Each check reads the recorded object version, compares the complete byte count and SHA256, and has a two-minute timeout. It makes no source-camera request, writes no footage and can run while disk pressure pauses media-writing work; database/audit writes still require usable local disk. Existing job leases, renewal, retry backoff, same-segment serialization and expired-lease recovery apply. After a failed check exhausts its immediate retries, it becomes eligible for another retry cycle one hour after the last check. Original-transfer job identity and completion are unchanged.

The ledger distinguishes **missing** (local ENOENT or provider HTTP 404), **mismatch** (size/hash differs), and **unavailable** (denied, timed out or another read failure). An unavailability finding is not proof that footage was deleted. All three conservatively remove verified coverage and deny playback until an unchanged expected original passes a fresh readback. Previous timestamps, checksums, receipts and bytes are preserved. This process does not overwrite, delete or automatically request replacement Ring footage. Repair from another preserved copy remains a reviewed operation. Concurrent approved deletion, changed receipt or lost lease prevents stale results from publishing.

Camera archive status exposes these counts to scoped operational users; inspectors receive no operational readback records. Failed checks and overdue checks enter the existing independent-watchdog fault path. Overdue means past the configured interval plus a grace period of one quarter of that interval, bounded to one hour–one day. A busy original-transfer queue can delay checks and will produce an overdue finding. Hold reconciliation can also block dispatch if its provider operation fails.

**This interval cannot demonstrate detection of archive corruption within five minutes.** The fault is reported once a check observes it; actual recipient receipt remains untested. A provider availability/health signal and separately measured failure/notification scenarios are still required for the five-minute requirement. Full readbacks also consume download bandwidth and may incur egress fees. Qualify interval, timeout, priority starvation, throughput and cost on the actual provider and Mini before enabling unattended operation. Readback checks bytes, not current object-lock protection, capture-time authenticity or complete camera recording.

Eleven added tests cover classification and timeout, exact-version SDK requests, durable cadence/deduplication, same-byte recovery, unchanged original jobs, lease recovery, deletion/receipt races, priority, read-only verification under simulated disk pressure, watchdog dispatch and camera/inspector HTTP scope. A real disposable worker detected a missing original while disk admission was paused. The HTTP test initially expected 409; the existing unverified-media route correctly returns 404, and the assertion was corrected. All media and provider responses in these checks are synthetic. The complete repository suite passes 123 tests.

## Independent notification path

The worker sends only allowlisted fault codes with its existing authenticated heartbeat. Footage, camera provider IDs and credentials are not included. The independent watchdog evaluates every 30 seconds, detects heartbeat silence after 90 seconds and retries an unaccepted notification every 30 seconds. A new fault code during an open incident creates a persisted notification revision with a new idempotency key; retries of that revision retain the key across restart. A prior accepted notification therefore cannot suppress a newly observed source-window risk. Incident openings, escalations, resolutions and notification outcomes are audited.

The five-minute objective concerns **actual recipient delivery**. Polling/retry timings and fixture acceptance do not demonstrate that objective. The new tests observe dispatch/retry promptly after a simulated fault, while recipient receipt remains unconfirmed. The five-minute historical readiness delay and 15-minute transfer target also do not establish camera-failure detection within five minutes. A qualified capture-health signal, external watchdog host, real recipients and measured receipt for each required failure scenario remain necessary.

## Verification and remaining work

Nine additional tests cover saved scheduling across process/database reopen; transactional rollback and policy/configuration changes; visible old gaps outside the scheduling window; partial completed jobs; local-only versus independent preservation; missing/future readback timestamps; shorter/unconfirmed history settings; queue counts beyond the UI's 100-job display; 90-day targets with older holds; watchdog escalation/retry identity across restart; real worker fault observations without Ring access; and API camera/inspector scoping.

Browser verification used synthetic data only: an old 33 ms gap remained at risk despite a completed job; a local-only original showed an independent-archive backlog with no source-expiry risk; new coverage observations cleared those transfer faults; two-minute-old observations became unconfirmed. No warning/error console entries were captured. The first fixture omitted an existing required `requested` field; completing that synthetic record corrected the preview without changing application behavior.

Twelve further tests cover cross-camera priority, changed/unconfirmed storage estimates, retry deadlines and lease recovery, receipt validity, selection beyond the UI's 100-job view, atomic original/follow-up publication, independent playback faults, disabled-camera rejection, safe staging reuse, cache admission and old/new backup schema verification. Selection over 5,002 queued synthetic jobs took 19.5 ms in one full-suite run on the development host; this is not a sustained Mini benchmark. An actual synthetic worker was killed during controlled playback encoding after its original transfer completed. Restart with the import source removed and its persisted lease moved to the reclaim boundary rebuilt the derivative from the archive; the original transfer remained at one attempt. No real camera footage or production worker was involved. That phase passed 112 tests, and the real local restic recovery drill passed with the new indexes.

No real notifications or new Ring requests were made. Camera 1's actual history setting remains unconfirmed until supplied by the owner. The Southampton host is still unavailable. Live provider qualification, policy decisions, archive-readback commissioning, sustained source-priority catch-up, cache commissioning, off-site backup operation, native recorder access and actual notification receipt remain deployment gates. The implementation is not a site commissioning or OCM-compliance declaration.
