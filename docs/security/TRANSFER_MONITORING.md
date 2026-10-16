# Transfer backlog and source-window monitoring

Implemented and tested October 15, 2026. These are observations of the transfer ledger, separate from camera capture health and from proof of 60/90-day retention. No unattended Ring export permission, camera storage setting, independent archive or notification recipient was invented by this change.

## What is measured

Every worker heartbeat evaluates each configured Ring camera against the completed historical windows. The evaluated archive target is the preceding 90 days, bounded by the configured recording start, plus older active investigation-hold intervals within that configured recording period. Released holds do not extend that range. Footage required outside the configured recording period needs separate investigation review.

Coverage uses actual verified segment start/end times and a recorded readback timestamp that is present and not in the future. Job completion, snapshots, events and camera online status cannot fill a gap. Coverage is separated into:

- **Originals not yet preserved:** intervals with no verified preserved original, whether local or independent.
- **Not independently archived:** intervals with no verified independent archive receipt. A local copy does not satisfy this measure.
- **Pending transfer jobs:** all outstanding media-transfer jobs, including blocked/failed jobs; this is a count of work, not a footage-duration measurement. Failed playback work is identified separately when its original has been preserved.

The display reports total missing duration, oldest missing original, job counts, evaluation endpoint and the basis for the source-window estimate. A 33 ms hole remains a hole even when its job is complete. Preserving an original locally removes its upstream-retrieval risk, while the independent-archive backlog remains visible. These statements rely on the last verified receipt; the monitor does not perform a full remote readback every 30 seconds. Startup reconciliation can revoke invalid coverage. Recurring readback cadence and sustained-volume performance still require commissioning.

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

## Independent notification path

The worker sends only allowlisted fault codes with its existing authenticated heartbeat. Footage, camera provider IDs and credentials are not included. The independent watchdog evaluates every 30 seconds, detects heartbeat silence after 90 seconds and retries an unaccepted notification every 30 seconds. A new fault code during an open incident creates a persisted notification revision with a new idempotency key; retries of that revision retain the key across restart. A prior accepted notification therefore cannot suppress a newly observed source-window risk. Incident openings, escalations, resolutions and notification outcomes are audited.

The five-minute objective concerns **actual recipient delivery**. Polling/retry timings and fixture acceptance do not demonstrate that objective. The new tests observe dispatch/retry promptly after a simulated fault, while recipient receipt remains unconfirmed. The five-minute historical readiness delay and 15-minute transfer target also do not establish camera-failure detection within five minutes. A qualified capture-health signal, external watchdog host, real recipients and measured receipt for each required failure scenario remain necessary.

## Verification and remaining work

Nine additional tests cover saved scheduling across process/database reopen; transactional rollback and policy/configuration changes; visible old gaps outside the scheduling window; partial completed jobs; local-only versus independent preservation; missing/future readback timestamps; shorter/unconfirmed history settings; queue counts beyond the UI's 100-job display; 90-day targets with older holds; watchdog escalation/retry identity across restart; real worker fault observations without Ring access; and API camera/inspector scoping.

Browser verification used synthetic data only: an old 33 ms gap remained at risk despite a completed job; a local-only original showed an independent-archive backlog with no source-expiry risk; new coverage observations cleared those transfer faults; two-minute-old observations became unconfirmed. No warning/error console entries were captured. The first fixture omitted an existing required `requested` field; completing that synthetic record corrected the preview without changing application behavior.

No real notifications or new Ring requests were made. Camera 1's actual history setting remains unconfirmed until supplied by the owner. The Southampton host is still unavailable. Live provider qualification, policy decisions, recurring archive readback, source-priority catch-up under sustained load, verified cache eviction, off-site backup operation, native recorder access and actual notification receipt remain deployment gates. The implementation is not a site commissioning or OCM-compliance declaration.
