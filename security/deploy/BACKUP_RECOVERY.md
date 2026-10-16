# Control-data backup and recovery

Implemented and locally tested October 15, 2026. This protects the archive index and control state; **original footage requires its separate, independently verified archive**. No off-site backup account, recurring schedule or recovery service has been commissioned.

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

Use an encrypted local volume and a dedicated mode-0700 staging directory. Allow space for the SQLite snapshot, readback copy and restic buffers; inspect capacity before each supervised run. The worker disk guard does not reserve space for a backup process. A successful run cleans up plaintext staging. Process termination or power loss can leave private `farber-backup-*` directories: an administrator must first establish that the backup process has stopped, preserve any needed diagnostic state, then remove only that run's temporary files. Filesystem deletion is not a secure-erasure claim. Scheduling and backup-specific capacity/alert monitoring remain commissioning work.

## Back up and verify

Run as the dedicated service account, using the private config and a **new** checkpoint path:

```sh
node security/backup.cjs backup /private/path/backup.json /private/path/checkpoint-unique.json
```

The command stages a consistent database, uploads only the allowlisted control files, then restores that exact full snapshot ID into a disposable directory. It checks every restored file against the original manifest hash, database integrity, audit chain and signing key before writing the checkpoint. A restic partial-success/nonzero exit fails the operation. Provider output and credential values are not printed. Existing checkpoints and restore directories are never overwritten. Failed verification may leave an unclaimed encrypted snapshot in the repository; it is not reported as a successful backup and is not automatically deleted.

The checkpoint records the exact snapshot ID, manifest SHA256 and audit head. Preserve it through a separately controlled channel outside the worker, and compare successive audit heads/counts. Keeping it only beside the database cannot detect loss, rollback or replacement of both. The output deliberately keeps `independentLocationVerified: false`: a successful local readback cannot attest to provider independence, external checkpoint custody or restore availability after a site outage.

Before unattended operation, agree and commission backup frequency/recovery objectives, external missing-backup alerts, encryption-key recovery and periodic recovery drills. Also schedule restic repository checks with actual data readback; ordinary metadata-only checks do not read all stored packs. The wrapper's per-backup readback verifies that snapshot, not every older snapshot. [restic repository checks](https://restic.readthedocs.io/en/stable/045_working_with_repos.html).

## Restore to quarantine

Obtain the exact checkpoint from its trusted independent custody. Never substitute `latest` or take an unverified replacement checkpoint from the damaged host. On a clean recovery host, configure the protected password and read permissions, then select a new directory:

```sh
node security/backup.cjs restore /private/path/backup.json /private/path/trusted-checkpoint.json /private/path/new-recovery
```

Only the known control files are requested. Restic restores with overwrite disabled, then the application verifies the manifest hash, inventory, private file permissions, exact hashes, database integrity, audit history and evidence signatures. An invalid restore is discarded; existing source and target data are never overwritten. [restic restore behavior](https://restic.readthedocs.io/en/stable/050_restore.html).

The restored directory contains `RECOVERY_REQUIRED`. The application store rejects it **before opening the database**, including worker, dashboard and provisioning CLI. There is no automatic activation command. Do not remove the marker as a shortcut. Recovery commissioning must first:

1. Reconcile the restored snapshot and external checkpoint with the newest trustworthy records; recover changes since the snapshot or explicitly identify the loss interval. A valid older snapshot is not proof that it is the newest.
2. Re-read every original from independent storage by pinned version and checksum; reconstruct missing receipts and distinguish missing originals from missing derivatives. Local-only footage is not recovered by this backup.
3. Revalidate identities, revoke old sessions and inspector grants, re-review pending evidence/deletion requests and source-policy decisions, and reconcile all holds, including holds created after the snapshot.
4. Recover/reconcile job leases and source timestamps, rebuild derivatives, replace invalid credentials through their separate recovery process, and observe worker health and actual alert receipt before controlled activation.

The restore preserves the historical database unchanged for review. The activation/migration workflow is still required; this feature does not claim unattended host-loss failover, a complete footage recovery or OCM compliance.

## Reproducible verification

`npm test` includes consistent-WAL copying during concurrent writes; missing/wrong signing key and signature/audit corruption rejection; trusted-checkpoint, inventory/hash and symlink rejection; fresh pre-key backup; refusal to start restored workers/CLI; private config/credential isolation; and partial restic failure cleanup without secret output.

Run the separate actual encryption/recovery drill with a verified binary:

```sh
FARBER_TEST_RESTIC=/absolute/path/to/restic node --test test/security/backup-restic.drill.cjs
```

The drill uses only temporary synthetic records and a randomly generated local password. It creates an encrypted repository, backs up and reads back, runs `check --read-data`, removes the synthetic source database/key to simulate host loss, restores exact records/key/signatures, rejects a wrong password and an altered repository pack, and confirms the recovered database cannot start a worker. It contacts no provider and removes its disposable data. This is a local software recovery test, not a Southampton or off-site commissioning result.
