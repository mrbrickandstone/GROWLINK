# Control-data backup and recovery

Implemented and locally tested October 15–16, 2026. This protects the archive index and control state; **original footage requires its separate, independently verified archive**. No off-site backup account, recurring schedule or recovery service has been commissioned.

## What is preserved

The backup uses the SQLite online-backup API, including committed WAL data while other connections continue writing. It verifies database integrity, the audit chain and completed evidence signatures, then preserves:

- `command.sqlite`: camera mapping, archive receipts, transfer jobs, users, request grants, holds, deletion records, inspections, power records, sessions, evidence manifests and audit history.
- `evidence-signing.pem`, when present. An installation with completed evidence exports cannot pass backup without the matching Ed25519 key. A fresh installation without exports can pass before a key is created. Key rotation is not implemented; a different key cannot silently replace the existing signing identity.
- A manifest with exact file hashes, counts, signing-key fingerprint and audit head, plus a recovery-quarantine marker.

Node **22.16+** is required for the backup API; the host screener also checks that the API exists. The package uses restic for repository encryption and authenticated retrieval. **restic 0.19.1** was tested using its official macOS arm64 release, with downloaded archive SHA256 `7be0a144ccc377880f294204aa271d76e4b79554b42a751151d425ce6ebac143` verified against the official release checksum list. No global installation was performed. [Node backup API](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html), [restic release](https://github.com/restic/restic/releases/tag/v0.19.1).

Originals, playback derivatives, Ring tokens, OIDC/provider credentials, application code and the restic repository password are excluded. Maintain secret recovery separately with controlled access. Losing the repository password prevents recovery. Restored old session/grant/deletion records remain historical data until a separate revalidation; they are never automatically activated.

## Prepare a destination

An administrator must provision and initialize an approved, private restic repository. The wrapper accepts a local absolute repository path for a drill or an explicit `s3:https://.../bucket/prefix` destination. It never initializes a remote repository, purchases services, disables TLS verification, runs a shell, or prunes backup history. SFTP and other restic backends are not enabled by this wrapper.

Use a separate backup repository and narrowly scoped storage credentials. Do not apply footage lifecycle rules or immutable object-lock settings to a restic repository without validating restic's own lock/update operations. Do not assume B2 qualification of the footage adapter also qualifies backups. Test the exact backup endpoint and permissions independently. Keep repository administration/deletion authority separate from the worker. [restic repositories and password files](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html).

Copy [backup.example.json](backup.example.json) outside the checkout, replace placeholders privately and set mode 0600. Its fields are `dataDir`, `stagingParent`, `resticBinary`, `repository`, `passwordFile`, and optional scoped AWS S3 credential fields under `credentials`. The executable must be an administrator-verified absolute path, owned by root or the executing account and not group/world writable. The config, password and source data must have private permissions; symlinked config/password files are rejected. The child receives only the backup credential allowlist, not Ring/OIDC secrets or the invoking shell environment.

Use an encrypted local volume and a dedicated mode-0700 staging directory. Allow space for the SQLite snapshot, readback copy and restic buffers. The archive-worker disk guard does not reserve space for backups; the scheduler below applies its own admission and running checks. The direct one-shot command remains a supervised operation. A successful run cleans up plaintext staging. Process termination or power loss can leave private `farber-backup-*` directories: an administrator must first establish that all backup processes have stopped, preserve any needed diagnostic state, then remove only that run's temporary files. Filesystem deletion is not a secure-erasure claim.

## Back up and verify

Run as the dedicated service account, using the private config and a **new** checkpoint path:

```sh
node security/backup.cjs backup /private/path/backup.json /private/path/checkpoint-unique.json
```

The command stages a consistent database, uploads only the allowlisted control files, then restores that exact full snapshot ID into a disposable directory. It checks every restored file against the original manifest hash, database integrity, audit chain and signing key before writing the checkpoint. A restic partial-success/nonzero exit fails the operation. Provider output and credential values are not printed. Existing checkpoints and restore directories are never overwritten. Failed verification may leave an unclaimed encrypted snapshot in the repository; it is not reported as a successful backup and is not automatically deleted.

The checkpoint records the exact snapshot ID, manifest SHA256 and audit head. Preserve it through a separately controlled channel outside the worker, and compare successive audit heads/counts. Keeping it only beside the database cannot detect loss, rollback or replacement of both. The output deliberately keeps `independentLocationVerified: false`: a successful local readback cannot attest to provider independence, external checkpoint custody or restore availability after a site outage.

Before unattended operation, agree and commission backup frequency/recovery objectives, external missing-backup alerts, encryption-key recovery and periodic recovery drills. Also schedule restic repository checks with actual data readback; ordinary metadata-only checks do not read all stored packs. The wrapper's per-backup readback verifies that snapshot, not every older snapshot. [restic repository checks](https://restic.readthedocs.io/en/stable/045_working_with_repos.html).

## Scheduled backups and failure reporting

The scheduler is implemented and locally tested; no OS schedule or external backup destination has been installed. Copy [backup-schedule.example.json](backup-schedule.example.json) to a private mode-0600 configuration file outside the checkout. Set `backupConfigFile` to the separately protected backup config above and create a service-account-owned mode-0700 `stateDir`. On the Mini, the example uses `/Library/Application Support/Farber/backup-state`. Keep backup staging and state outside the original-footage directory and on measured persistent encrypted storage.

The example checks every minute through the host scheduler, runs a backup when its previous snapshot reaches 60 minutes, reserves 20 GB on each data/staging/state filesystem, and limits each run to 15 minutes. These are proposed operational recovery objectives, not OCM requirements or commissioned capacity. Admission additionally requires four times the current database-plus-WAL size and 512 MiB of headroom. Checks run during SQLite copying, between phases and every two seconds while a child runs; restic temporary files use the configured staging parent. Low or unknown space fails closed, and a running child is stopped before cleanup. Checks provide a margin, not an exclusive disk reservation; synchronous validation, unrelated writers and target-host performance still need measurement.

Run a first supervised test with approved synthetic control data and the approved destination:

```sh
node security/backup-schedule.cjs run /private/path/backup-schedule.json
```

An exclusive on-disk run directory prevents overlap. Only an exact persisted checkpoint from a successful upload and restore verification records success. Private status/run records survive restart; failures retry after 5, 10, 20, 40 and then 60 minutes, retaining the fault until success. The original snapshot time determines freshness, not when upload or readback finished. A changed source/repository/tool/password-file configuration invalidates the previous schedule's freshness and preserves its history. A verified checkpoint does not establish off-site custody.

After this test and host configuration review, install [com.farber.security.backup.plist](com.farber.security.backup.plist) alongside the web and worker launch daemons. It runs as `_farber`, checks at startup and every 60 seconds, and has no embedded credentials. Verify the Node path, private configs, service permissions, restic binary and log rotation before bootstrapping:

```sh
sudo launchctl bootstrap system /Library/LaunchDaemons/com.farber.security.backup.plist
```

For a Linux host, [farber-backup.service](farber-backup.service) and [farber-backup.timer](farber-backup.timer) provide the equivalent separate service. Set Linux paths in the private configs, use the `farber` service account, keep writable data/staging/state under `/var/lib/farber`, and align the service timeout with any changed run limit. Enable the timer only after the same destination and recovery checks. Neither template has been installed by development tests.

Configure the archive worker's private `SECURITY_BACKUP_STATE_DIR` to the same state directory and `SECURITY_BACKUP_MAX_AGE_MINUTES` to the agreed limit (example: 120). The worker only observes status; it does not execute backups. The dashboard shows snapshot/readback times separately from footage protection. An unset state directory is explicitly unconfigured and does not create backup incidents; configure it before commissioning. Missing or altered checkpoints, failed runs, uncertain interrupted runs and stale snapshots become allowlisted watchdog faults. No scheduler observation for more than three minutes also faults unless a bounded active run is present. A stale worker heartbeat cannot keep the dashboard's backup status green.

The existing external watchdog receives these faults through worker heartbeats; worker/host silence has its separate timeout. Test actual failure-to-recipient delivery within five minutes for each actionable fault, including the scheduler stopping. The 120-minute snapshot-age threshold is a control-data recovery threshold, not a claim that backup or camera failures take two hours to report. Recipient delivery, off-site storage, independent checkpoint custody, encryption-key recovery and target-host timing remain uncommissioned.

## Reconcile an interrupted scheduled run

An existing active-run directory is never automatically removed because its process or deadline disappeared. Stop the host schedule and establish that the recorded scheduler, child and any unrecorded restic child have stopped. A crash between child creation and PID persistence can leave an unrecorded child; checking only a PID file is insufficient. A reused live PID conservatively blocks reconciliation. Preserve private staging, partial checkpoints and repository diagnostics while reviewing the interruption.

After that administrator review, run:

```sh
node security/backup-schedule.cjs reconcile /private/path/backup-schedule.json --processes-confirmed-stopped INCIDENT-REFERENCE
```

Use a nonsecret case reference. The command refuses recorded live processes or a changed destination configuration. It archives the uncertain run directory and records the review. A complete valid checkpoint can recover success without repeating provider work; otherwise the run is marked interrupted and the next scheduler invocation can retry. No incomplete checkpoint counts as success. This command does not unlock/prune restic, delete remote snapshots or remove abandoned staging. Review and resolve any repository lock separately, preserve needed diagnostics, and restart the schedule only after the actual process/destination state is understood.

## Restore to quarantine

Obtain the exact checkpoint from its trusted independent custody. Never substitute `latest` or take an unverified replacement checkpoint from the damaged host. On a clean recovery host, configure the protected password and read permissions, then select a new directory:

```sh
node security/backup.cjs restore /private/path/backup.json /private/path/trusted-checkpoint.json /private/path/new-recovery
```

Only the known control files are requested. Restic restores with overwrite disabled, then the application verifies the manifest hash, inventory, private file permissions, exact hashes, database integrity, audit history and evidence signatures. An invalid restore is discarded; existing source and target data are never overwritten. [restic restore behavior](https://restic.readthedocs.io/en/stable/050_restore.html).

The restored directory contains `RECOVERY_REQUIRED`. The application store rejects it **before opening the database**, including worker, dashboard and provisioning CLI. Do not remove that marker as a shortcut. Use the preparation command below to create a separate copy for controlled review. Returning to normal operation still requires:

1. Reconcile the restored snapshot and external checkpoint with the newest trustworthy records; recover changes since the snapshot or explicitly identify the loss interval. A valid older snapshot is not proof that it is the newest.
2. Re-read every original from independent storage by pinned version and checksum; reconstruct missing receipts and distinguish missing originals from missing derivatives. Local-only footage is not recovered by this backup.
3. Revalidate identities, revoke old sessions and inspector grants, re-review pending evidence/deletion requests and source-policy decisions, and reconcile all holds, including holds created after the snapshot.
4. Recover/reconcile job leases and source timestamps, rebuild derivatives, replace invalid credentials through their separate recovery process, and observe worker health and actual alert receipt before controlled activation.

The restore preserves the historical database unchanged. The preparation migration and reviewed activation workflow below are implemented; the independent records and site commissioning needed to use them remain outstanding. This feature does not claim unattended host-loss failover, complete footage recovery or OCM compliance.

## Prepare a separate recovery review copy

On a clean host, with the verified restored directory and its independently held checkpoint:

```sh
node security/recovery.cjs prepare /private/path/new-recovery /private/path/trusted-checkpoint.json /private/path/new-review-data RECOVERY-CASE-REFERENCE
```

The nonsecret reference identifies the recovery case; it is not a claim that the review has passed. The command accepts a new absolute destination outside the restored directory. It verifies the checkpoint's manifest hash, creation time and audit head/count, copies only the known control files, verifies the copied bytes, and migrates the copy in one SQLite transaction. It rechecks the original snapshot unchanged. Existing targets are never overwritten, including interrupted attempts.

The migration:

- Revokes every session, disables all restored users, revokes inspector grants, suspends evidence requests and invalidates pending deletion approvals. Old signatures remain preserved and verified; suspended export records cannot authorize original downloads.
- Preserves historical audit entries, holds, original hashes/version receipts, request timestamps and scheduling cursors. Prior values of changed records and unfinished jobs remain in private recovery history. Old session secrets are removed from the candidate rather than copied to that history.
- Disables camera exports and Ring policy flags, pauses unfinished jobs and clears their old leases. It removes stale health/access/check observations. All surviving segments lose verification credit and derivative pointers until fresh archive readback; old retention-protection assertions are also cleared.
- Installs a persistent recovery guard, appends an audit entry and writes a private report. A database/key/signature check and file/directory flush precede removal of the candidate's startup marker. A crash before publication leaves the candidate quarantined. The original restored snapshot keeps its marker permanently.

Point a **private review instance** at the new review-data directory. Existing named accounts cannot log in until a local administrator separately revalidates and provisions them. Loopback `--review` remains read-only. The dashboard shows a recovery warning. Normal camera transfers, derivative generation, evidence releases, inspector grants, hold release, cache removal and deletion remain blocked even if their environment/configuration switches are enabled. New investigation holds and inspection records can be recorded by freshly provisioned authorized users; adding a hold is not proof of source/archive protection.

An explicitly configured worker can perform the existing durable archive-readback jobs in recovery mode. Use only the approved archive endpoint and scoped read credentials; the migration itself makes no network request and obtains no credentials. Reads can consume provider bandwidth. Successful byte checks restore only verified footage coverage. They do not restore retention-proof flags, permissions, policy approval or normal operation. Missing objects remain visible and do not trigger a new Ring export. The worker reports `RECOVERY_REVIEW_REQUIRED` through its fault path; actual alert delivery is still uncommissioned.

The report keeps `newestSnapshotVerified`, `postSnapshotChangesReconciled` and `productionReady` false. The software cannot infer holds or other decisions made after the backup. Do not edit the database or remove guard records to bypass it. Use the named-owner review below after reconciliation. A later backup of a released recovery can be prepared again: the previous activation is preserved in recovery history and linked by ID, all access is disarmed again, and previously retired requests stay retired. Preparing a snapshot still in recovery review remains rejected.

## Reviewed return to service

This is a supervised owner decision, not unattended failover or a claim of complete recovery. An operator must first recover the newest trustworthy control records, reconstruct the complete active hold register from independent records, revalidate named users and source configuration, and exercise the actual host, archive, backup and notification path. If post-backup holds remain unknown, keep the guard in place. A known control-data loss interval may be documented, but does not waive hold reconciliation.

1. Keep the review instance private. Provision the revalidated named owner through the existing local administration procedure, then sign in with MFA. The owner must have scope over every configured camera. Original restored users remain disabled until separately revalidated.
2. Run the archive-readback worker against the approved destination. **Stop the worker before preparing the activation review.** Reconfigure only approved recording sources while the guard still blocks transfers. References and retained policy flags do not supply credentials; recover those separately.
3. Open **Recovery review** in the dashboard. Inspect the backup time, unfinished jobs, holds and every original-copy exception. Each surviving original needs verified readback after recovery preparation and within the preceding 24 hours, plus an independent destination; otherwise the exact segment/window remains an exception requiring an incident reference and explicit acknowledgment. This freshness limit is an operational review rule, not an OCM retention rule. Acknowledgment does not add verified coverage, protect storage or erase the finding.
4. Enter references for the newest checkpoint/custody check, post-backup changes and complete hold register, identities/credentials, source/retention/access decisions, host/archive/backup tests, and actual notification receipt. Attest that the reviewed state is reconciled. Optionally record a known control-data loss interval and incident reference. These are **owner attestations**, stored separately from the still-false software-verification claims.
5. Prepare and inspect the review. It expires after ten minutes and is bound to the control records and complete queue. Changes to holds, users, configuration, receipts, records or jobs invalidate it. Active jobs and unreviewed non-verification jobs prevent review. Freshness is checked again at activation. Type `ACTIVATE RECOVERY` to activate using the same currently authorized owner.
6. Restart the worker using the reviewed private configuration and observe actual capture, archive, retention, access and recipient notifications. Activation resumes eligible reconfigured Ring transfers and verified background playback builds without resetting original IDs, payload timestamps or attempts. Old evidence and user playback requests are retired and require new requests; other source jobs stay paused and remain visible as unresolved work. No Ring subscription, footage export, storage operation or notification is performed by the activation request itself.

The server exposes `GET /api/recovery`, `POST /api/recovery/review` and `POST /api/recovery/activate`. Writes require the normal same-origin CSRF check, valid audit chain, current enabled named owner, MFA and all-camera scope. Review, activation, exceptions, references and job dispositions are durable and audited. The guard release and job changes commit in one SQLite transaction; an identical retry after an uncertain response returns the recorded outcome without repeating changes. A failure before commit leaves the guard and queue unchanged.

Old sessions, inspector grants, suspended evidence exports and deletion approvals never reactivate. Active holds remain in place; provider protection is re-applied by the worker only under the separately approved storage/source policy. Retention proof is not restored by activation. New grants, exports and deletion requests remain subject to their normal authorization, source-policy, verification and retention checks. Local-only/missing originals, remaining paused jobs and policy gaps remain unresolved after activation. Actual target-host recovery and external approval/notification evidence have not been commissioned.

## Reproducible verification

`npm test` includes consistent-WAL copying during concurrent writes; missing/wrong signing key and signature/audit corruption rejection; trusted-checkpoint, inventory/hash and symlink rejection; fresh pre-key backup; refusal to start restored workers/CLI; private config/credential isolation; and partial restic failure cleanup without secret output. Eight recovery-preparation scenarios add command output/privacy, disarmed-state migration, unchanged source/signature/history checks, guarded operations, fresh readback, a real recovery worker, actual SIGKILL after migration, unsafe-input rejection and HTTP enforcement. Nine activation scenarios add current-owner/MFA/scope checks, exact-state and expiry rejection, explicit original-copy/control-data exceptions, unchanged original requests, stale-access protection, atomic rollback, actual SIGKILL before commit, repeat recovery and authenticated HTTP flow.

Eleven scheduler scenarios add private-config validation, persisted cadence, target changes, overlap prevention, capacity admission, retry timing, missing/altered checkpoints, stale/silent scheduler faults, worker-to-watchdog reporting, actual SIGKILL before/after checkpoint publication, explicit stopped-process reconciliation, child cancellation and capacity loss during a running child. Failure cases do not publish successful checkpoints. Browser verification exercised the real status observer and dashboard API with synthetic state: removing a checkpoint displayed attention; restoring it cleared the fault. No real notification was sent.

Run the separate actual encryption/recovery drill with a verified binary:

```sh
FARBER_TEST_RESTIC=/absolute/path/to/restic node --test test/security/backup-restic.drill.cjs
```

The drill uses only temporary synthetic records and a randomly generated local password. It creates an encrypted repository, performs backup/readback through the scheduler, verifies the next invocation is not due, runs `check --read-data`, removes the synthetic source database/key to simulate host loss, restores exact records/key/signatures, rejects a wrong password and an altered repository pack, and confirms the raw restored database cannot start a worker. It then prepares a separate recovery copy and verifies disabled users, revoked sessions, suspended exports and valid audit history. It contacts no provider and removes its disposable data. This is a local software recovery test, not a Southampton or off-site commissioning result.
