# Development verification — October 15, 2026

**Result: local development flow passes; production commissioning remains blocked on external services and source-policy decisions.** This report is separate from the [October 13 Ring pilot](PILOT_REPORT.md), whose sample-level pass and full-qualification limitations remain unchanged.

Story: an authorized viewer selects a room/camera and historical window; the API returns verified intervals from a durable ledger, serves a separate playback copy, and discloses gaps. Authorized evidence requests enter a durable queue, are reauthorized and read back by the worker, then expose a signed handling manifest and individually authenticated originals.

| Boundary | Actual result |
|---|---|
| Inventory and room grouping | Browser shows 1/3 in FLOWERING and 2 in FRONT DOOR; mappings persisted and fresh-import defaults saved |
| Actual pilot preservation | Eight real originals, 270,672,986 bytes, eight completed durable jobs; startup reconciliation completed; local audit chain valid |
| Browser → API → playback | Camera 1's 60.133008-second playback derivative reached readyState 4, currentTime advanced from 0.290912 to 4.383451 seconds, paused=false and no media error |
| Timestamp coverage | UI window 18:08:00.000–18:31:59.232 UTC shows 1,439.199 / 1,439.232 seconds covered and the first 0.033 seconds unverified. Its end is the last actual returned frame boundary, distinct from the pilot report's fixed 18:31:59 target |
| Missing footage | Camera 2 returns zero covered seconds for that window; video and previous-camera caption are hidden; full unverified interval is visible |
| Read-only review | Evidence, hold, deletion and commissioning writes visibly disabled; HTTP tests independently confirm server-side denial |
| Browser health | No captured warning/error console entries during reviewed flows; screenshots saved privately under `.security/review/` |
| Full automated suite | `npm test`: **123 passed, 0 failed, 0 skipped**, including Mac staging preparation, disk safeguards, backup/recovery, backlog/source-window monitoring, cache/playback recovery, original-preservation priority and scheduled archive readback. A separate real-restic integration drill also passed with the new queue indexes. Includes existing Growlink, monitoring and Ring tests |
| API authorization | Anonymous API/media denied; cross-site and CSRF writes denied; camera scope, owner MFA, inspector bounds/expiry/revocation, original-export request binding and current worker-time permissions tested |
| Storage and evidence | Local tamper/readback rejection, exact byte ranges, signed manifest verification/tamper rejection, S3 version/retention/hold/delete command contract and corrupt/unversioned response rejection tested |
| Durability | Stable job IDs, expired lease reclaim, renewal, stale completion rejection, deferred export processing and synthetic real-FFmpeg transfer/derivative recovery from preserved original tested |
| Holds/deletion | Late-arrival holds, two owners, retention floor, execution-time hold checks, deletion-intent reconciliation and shared-object protection tested |
| Monitoring | Missing heartbeat, repeated unknown health, retry after dispatch failure and provider-acceptance-versus-recipient-receipt distinction tested with fixtures |
| Site records | Inspection due dates, five-year records and elapsed measured power-test rules tested with fixtures; no actual site commissioning record was invented |

The final browser check found that an empty camera search retained the previous clip's caption. The empty-state path now hides both the player and caption; the corrected result was verified in the browser. No live view was started during these checks.

S3 tests use SDK-response fixtures, HTTP identity tests use explicit test-factory principals, and transfer tests use disposable generated media. These are not live S3/OIDC/notification or site-power tests. The only real Ring footage is the earlier pilot, copied locally without new Ring requests in this application phase. No notifications, purchases, physical evidence deletions or production promotions were performed.

## Concrete remaining gates

See [deployment/access instructions](../../security/README.md). Required: dedicated worker and independent watchdog hosts; private versioned archive and IAM role; named OIDC client/users; approved dedicated Ring worker access; written vendor/source-policy decisions; configured recipients and measured five-minute receipt; capture-time/native-evidence validation; camera 2/3 qualification; site coverage, backup-power and inspection commissioning; independent backup destination/checkpoint custody, scheduling/alerts and recovery activation; sustained-load and source-expiry/backlog validation. Commercial-recorder drivers remain explicitly unverified pending supported vendor access.

The prototype does not establish complete 60/90-day retention or OCM compliance. Production acceptance must not be inferred from passing software tests.

## Southampton staging preparation

The owner selected an existing separate `MARCOS-MAC-MINI` for evaluation instead of provisioning an AWS worker. Added two launchd service templates, a role-scoped private JSON configuration loader, read-only host screening, a committed-source release packager and an idempotent `init-site` command. Tests reject exposed/symlinked/malformed service configs, unexpected environment keys, unsafe host conditions and private files in the release allowlist. Fresh initialization preserves the owner room mapping without enabling exports or overwriting existing cameras. Both plists pass `plutil -lint`.

The host-screening command ran on the **development Mac only** and correctly failed: approximately 37.1 GB free, automatic sleep set to one minute and power-restart setting unavailable. These results do not describe the Southampton Mac. No system settings were changed. The Southampton host is not exposed in this task's connection inventory, so its preflight, installation, cold-boot behavior and workload capacity remain untested. See the [Mac handoff](../../security/deploy/MAC_MINI.md) for the B2/DigitalOcean candidate setup and costs. No remote resources, paid accounts, credentials or production settings were changed.

## Disk-capacity safeguards

Seven additional automated tests demonstrate: low/unknown capacity pauses admission; a recovery margin persists across restart; interrupted download and local-copy streams publish no partial originals and preserve existing bytes; capacity deferral keeps job identity and prior source-retry counts while rejecting stale lease owners; a real worker subprocess leaves the queued job untouched under simulated pressure, then another process completes the same synthetic media job after recovery; a controlled slow encoder process is stopped on pressure and only its unfinished derivative is removed; and failed worker status enters the watchdog incident path without falsely asserting recipient receipt.

The dashboard was checked using a separate local synthetic fixture, not the Southampton host or real camera footage. The browser showed “Transfers paused,” 5.0 GB free / 20.0 GB reserve and the retry explanation; a two-minute-old heartbeat became “Worker status unconfirmed”; a fresh recovery observation became “Worker reporting” with 50.0 GB free. No warning/error console entries were captured. Existing retention and source-qualification limitations remain visible. No live Ring request, notification, completed-original deletion, paid service or remote installation was performed. These tests simulate pressure; they do not claim a physical full-disk, site power or notification-delivery commissioning pass.


## Encrypted control-state backup and restore

Seven additional automated tests cover a consistent SQLite online backup while another connection writes WAL data; holds, jobs, sessions and matching signing-key preservation; rejection of missing/wrong keys, altered evidence signatures and broken audit history; fresh installation before key creation; trusted manifest/hash/inventory checks; symlink and unsafe-config rejection; startup quarantine; and cleanup/no secret output after partial restic failure.

A separate integration drill ran with the official checksum-verified restic 0.19.1 macOS arm64 binary. It created a local encrypted repository using only synthetic data and a random temporary password, completed the backup's automatic restore/readback, and passed `restic check --read-data`. The drill then removed its disposable source database/key, restored the exact hold/user/job records and key, verified the existing evidence signature, and demonstrated that an incorrect password and a deliberately corrupted repository pack both fail. The restored database refused application activation. The final drill passed after adding permission adjustment to the corruption fixture because restic stores its packs read-only; no real backup pack was altered.

The tooling backs up control metadata and signing keys, not footage or account credentials. It writes a checkpoint only after restoring and validating that exact snapshot. Restores require the full snapshot ID plus trusted manifest SHA256, target a new directory and remain quarantined to prevent stale permissions, holds or deletion decisions taking effect. Node's SQLite backup API raises the security service minimum to 22.16+, with actual API presence checked during host screening.

Only local software recovery is demonstrated. Off-site storage, independent checkpoint custody, backup cadence/alerts, backup-specific capacity protection and a reviewed activation/reconciliation workflow remain uncommissioned. No production state, Ring token, real footage or cloud account was used in the drill. No remote storage or scheduler was created. See [backup recovery instructions](../../security/deploy/BACKUP_RECOVERY.md).


## Transfer backlog and source-window monitoring

Nine added tests cover transactional saved scheduling, restart/rollback, policy/configuration gates, old unretrieved intervals, actual partial coverage despite complete jobs, verified local versus independent copies, missing/future readback timestamps, short/unconfirmed history settings, more than 100 pending jobs, 90-day targets with older holds, persisted watchdog escalation/retry, a real worker subprocess and camera/inspector API scope. All use synthetic state; no new Ring request or real notification occurred.

Browser verification showed an old 33 ms hole as a source-window risk with zero pending jobs, while a fully preserved local original showed 54.8 minutes awaiting independent archive and no source-expiry risk. Synthetic recovery moved both cameras within the transfer target; observations aged two minutes changed to Monitoring unconfirmed. The preview fixture's missing requested-window metadata was corrected before verification. No warning/error console entries were captured in the final flows. A synthetic preview screenshot is saved privately under `.security/review/pipeline-risk.png`.

The worker now admits bounded stable windows during catch-up and reports allowlisted fault codes. The watchdog gives newly observed faults a separate persisted notification revision, so earlier provider acceptance cannot suppress later source-window risk. Actual delivery within five minutes remains uncommissioned; transfer readiness/backlog timing is not camera-failure detection. See [transfer monitoring](TRANSFER_MONITORING.md) for thresholds, the unconfirmed camera history setting and remaining source/capacity gates.

## Verified cache cleanup and on-demand playback

Fourteen added tests bring the full suite to 100 passing checks. They cover fail-closed duplicate removal, exact-version retention/readback, holds and access arriving during cleanup, unsafe/changed local paths, prepared-eviction restart reconciliation, durable playback rebuilding, expiry/revocation and HTTP authorization. Synthetic FFmpeg media rebuilt successfully from preserved original bytes after lease recovery. No real footage was cleared, no Ring request was made, and cleanup remains off by default.

The browser's separate synthetic fixture moved from **Prepare playback** through a queued worker job to **Playback copy ready**. The generated two-second clip reached readyState 4, advanced from 0.162309 seconds to 2.000 seconds, ended normally and reported no media error. No warning/error console entries were captured. Screenshot: `.security/review/playback-rebuild.png`. Details and explicit limitations are in [cache and playback](CACHE_AND_PLAYBACK.md); actual independent storage, target-host capacity and notification delivery remain uncommissioned.

## Original-preservation priority

Twelve additional checks cover the queue's preservation-first ordering across cameras, changed and unconfirmed storage estimates, retry timing, durable leases, atomic archival/follow-up completion, separate playback failure status, disabled-camera checks, verified staging reuse, safe cache eligibility and backward-compatible backup validation. A 5,002-job synthetic queue selected the due original in 19.5 ms in a full-suite run on this development Mac; sustained target-host capacity is not established.

The worker was actually killed during a controlled encoder subprocess after the original was verified and its transfer job completed. After removing the disposable import source and advancing the saved lease to the reclaim boundary, a new worker rebuilt playback from the archived bytes; the original job still had one attempt and its checksum was unchanged. The first crash fixture also intercepted the original's decode check; it was corrected to stall only derivative encoding. Regression also caught the backup schema validator rejecting the new indexes; it now accepts the exact known indexes and older snapshots while rejecting unexpected/altered schema objects. The final suite passes all 112 tests, and the real local encrypted-restic drill passes again.

No UI or production deployment changed in this recovery phase. No Ring request, real notification, actual-footage deletion or remote installation was performed. Partial footage gaps, sustained target-host load, source-policy approval, independent storage and the other commissioning gates remain unresolved.

## Scheduled archive readback

Eleven additional tests verify recurring durable checks of the exact archived version, complete size/SHA256 comparison, bounded reads, safe classification of missing/altered/temporarily inaccessible copies, restart/lease recovery, deletion and receipt races, preservation-first ordering and unchanged original-transfer jobs. A real synthetic worker continues readback under simulated low-disk admission pause. HTTP tests demonstrate that failed readback removes timeline coverage and blocks media delivery, while scoped camera status exposes the finding and inspectors receive no operational check records. Restoring the unchanged expected fixture bytes and rechecking restores verified coverage. The full suite passes 123 tests.

The implementation admits bounded verification jobs instead of synchronously rereading the full archive at startup. The default seven-day interval is not a five-minute corruption-detection guarantee or a regulatory requirement. Provider health monitoring, notification receipt, the readback bandwidth/cost budget and sustained Mini performance remain uncommissioned. No live Ring requests, real notifications, footage deletions or production changes occurred. See [scheduled archive reconciliation](TRANSFER_MONITORING.md#scheduled-archive-reconciliation).
